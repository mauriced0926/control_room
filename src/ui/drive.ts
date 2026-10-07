// The driving view (UI.md screen 3), as words and levels. Pure: plain data in, plain data out; the
// browser draws it and streams the keys (src/ui/app.ts). Dave: "the worst part is not knowing if it's
// lagging until it's too late". So each number says what it measures:
//
// - Input age: how long since the service last relayed this operator's input to the site. While the
//   screen streams at 10 Hz it stays near 100 ms; past the deadman (500 ms) the truck stops.
// - Echo age: how long ago the service sent the newest input the truck reports having applied
//   (control.last_drive_sent_ms). A round trip, service to truck and back, plus up to 200 ms of
//   telemetry sampling and the time since that telemetry arrived. Live: 200-620 ms (research S5).
import type { DriveView, Boundary } from '../drive.ts';
import type { LeaseEnd } from './detail.ts';
import type { TruckView } from '../fleet.ts';
import { PARAMS } from '../params.ts';
import { age } from '../words.ts';

export type Level = 'ok' | 'warn' | 'bad';

export interface Meter { ms: number | null; text: string; level: Level; fraction: number }

export interface DrivePanel {
  headline: string;
  deadman: { words: string; level: Level };
  input: Meter;
  echo: Meter;
  thresholdFraction: number;          // where the deadman mark sits on both meters
  speed: string;
  limit: string | null;
  ahead: { words: string; level: Level } | null;  // the next boundary in the direction of travel
  behind: { words: string; level: Level } | null; // and the other way
  refusal: string | null;
  warning: string | null;
}

export const METER_FULL_MS = 1_000;
const ECHO_WARN_MS = PARAMS.deadman.value + 200; // the deadman plus telemetry sampling

export interface PanelInput {
  view: DriveView;
  truck: TruckView | undefined;
  sinceFrameMs: number;      // this screen's time since the frame arrived: the ages keep counting
  siteLinkDown: boolean;
  serviceDown: boolean;
  direction: 'FWD' | 'REV';  // the way the operator last drove, or the truck reports
  streaming: boolean;        // this screen is sending input
}

export function drivePanel(p: PanelInput): DrivePanel {
  const { view: v, truck: t } = p;
  const dm = PARAMS.deadman.value;
  const plus = (x: number | null) => (x === null ? null : x + p.sinceFrameMs);
  const inputMs = plus(v.inputAgeMs);
  const echoMs = plus(v.echo.ageMs);
  const meter = (ms: number | null, warn: number, bad: number, none: string, words: (ms: number) => string): Meter =>
    ms === null ? { ms, text: none, level: 'bad', fraction: 1 }
      : { ms, text: words(ms), level: ms >= bad ? 'bad' : ms >= warn ? 'warn' : 'ok', fraction: Math.min(1, ms / METER_FULL_MS) };
  const input = meter(inputMs, dm / 2, dm, 'no input relayed yet', (ms) => `${fmt(ms)} since the service last sent your input to ${v.vehicleId}`);
  const echo = meter(echoMs, ECHO_WARN_MS, METER_FULL_MS, `${v.vehicleId} has not reported applying any input yet`, (ms) => `${fmt(ms)} since the service sent the newest input ${v.vehicleId} reports applying (round trip + up to 200 ms telemetry sampling)`);

  const c = t?.control?.value;
  const blind = !t || t.confidence === 'silent' || t.confidence === 'contradicted' || t.confidence === 'unknown';
  let deadman: DrivePanel['deadman'];
  if (p.serviceDown) deadman = { words: 'Service disconnected: nothing from this screen reaches the truck. It stops on its deadman.', level: 'bad' };
  else if (p.siteLinkDown) deadman = { words: 'Site link down: the truck stops on its deadman.', level: 'bad' };
  else if (blind) deadman = { words: `No usable telemetry (${t?.confidenceReason ?? 'none'}): the deadman should have stopped it; this screen can't confirm.`, level: 'bad' };
  else if (c?.deadman) deadman = { words: `Deadman tripped: stopped, no fresh input for ${dm / 1000} s. It moves again on fresh input.`, level: 'warn' };
  else if (inputMs !== null && inputMs >= dm) deadman = { words: `Deadman due: no input for ${fmt(inputMs)}; it stops within ${dm / 1000} s of the last.`, level: 'warn' };
  else deadman = { words: 'Deadman armed: input arriving.', level: 'ok' };

  const speed = t?.speedMps ? `${t.speedMps.value.toFixed(1)} m/s ${t.speedMps.value === 0 ? '(stopped)' : t.direction?.value === 'REV' ? 'reversing' : 'forward'}${t.confidence === 'live' ? '' : `, reported ${age(t.speedMps.ageMs)} ago`}` : 'not reported';
  const faults = t?.faults?.value ?? [];
  const limit = v.limp ? `Limp-home (${faults.join(', ')}): limited to ${(v.topSpeedMps ?? PARAMS.limpHomeSpeed.value).toFixed(1)} m/s` : null;

  const there = (b: Boundary | null, label: string) => {
    if (!b) return null;
    const status = b.status ?? 'status unknown';
    const level: Level = b.status === 'OPEN' ? 'ok' : b.status === 'CLOSING' ? 'warn' : 'bad';
    return { words: `${label}: ${b.distanceM.toFixed(0)} m to ${b.zoneId}, ${status}${b.status === 'CLOSING' && b.effectiveAtMs !== null ? ' (blast notice running)' : ''}`, level };
  };
  const fwd = there(v.ahead.FWD, 'Forward'), rev = there(v.ahead.REV, 'Reverse');

  let warning: string | null = null;
  if (t?.confidence === 'contradicted') warning = 'Data frozen: position unknown. Driving refused until its data moves again.';
  else if (t?.confidence === 'silent') warning = `Silent for ${age(t.ageMs ?? 0)}: the deadman should have stopped it.`;
  else if (t?.confidence === 'old') warning = `Its data is old (${t.confidenceReason}): the lag figures are late too.`;
  else if (!p.streaming && !p.serviceDown) warning = 'Not sending: this window is not in front. The truck stops on its deadman; its control lapses after 10 s with no input.';

  const refusal = v.refusal?.current ? v.refusal.reason : v.siteRejected ? `The site refused drive input: ${v.siteRejected.reason}` : null;
  return {
    headline: `You are driving ${v.vehicleId}`,
    deadman, input, echo, thresholdFraction: dm / METER_FULL_MS, speed, limit,
    ahead: p.direction === 'FWD' ? fwd : rev, behind: p.direction === 'FWD' ? rev : fwd,
    refusal, warning,
  };
}

function fmt(ms: number): string {
  return ms < 10_000 ? `${Math.round(ms)} ms` : age(ms);
}

// Keys: hold to drive, release to stop. Numbers step the throttle.
export const DRIVE_KEYS = { forward: ['ArrowUp', 'w', 'W'], reverse: ['ArrowDown', 's', 'S'], stop: [' '] } as const;
export const THROTTLE_STEPS = [0.25, 0.5, 0.75, 1] as const;

export function throttleFor(held: 'FWD' | 'REV' | null, step: number): number {
  return held === 'FWD' ? step : held === 'REV' ? -step : 0;
}

// Who has a truck that isn't yours, in words, for the driving view and truck detail.
export function holderWords(holder: string, vehicleId: string): string {
  if (holder.startsWith('system:')) {
    const rule = holder.slice('system:'.length);
    return `The system holds ${vehicleId}'s controls under blast rule ${rule}: it was working (loading, dumping or charging) at a boundary into a zone that is closing or closed, and this stopped it there. The system never drives it, so its control lapses ${PARAMS.leaseIdleTimeout.value / 1000} s after it was taken and the truck then holds. A supervisor can take over now.`;
  }
  return `${holder} is driving ${vehicleId}. Commands from anyone else are refused until they hand it back.`;
}

// How the last lease ended, for the driver who lost it (L7.3).
export function lostWords(end: LeaseEnd | undefined, you: string | null, time: (ms: number) => string): string | null {
  if (!end || !you || end.operatorId !== you) return null;
  if (end.event === 'REVOKED' && end.reason === 'FORCED_TAKEOVER') return `${end.by ?? 'A supervisor'} took control of ${end.vehicleId} from you at ${time(end.atServerMs)}. Your input is no longer sent.`;
  if (end.event === 'REVOKED' && end.reason === 'ESTOP') return `${end.vehicleId} was e-stopped${end.by ? ` by ${end.by}` : ''} at ${time(end.atServerMs)}; your control ended.`;
  if (end.event === 'EXPIRED') return `Your control of ${end.vehicleId} lapsed at ${time(end.atServerMs)}: no input for ${PARAMS.leaseIdleTimeout.value / 1000} s.`;
  return null;
}
