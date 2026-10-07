// The Overview's words and order (UI.md screen 1): the zone clearance panel, the fleet table sorted
// by attention, and the link indicators. Pure: a fleet snapshot in, plain data out. The browser only
// draws it.
import { HOLD_THE_SHOT, zoneClearance, type Clearance, type Verdict } from '../clearance.ts';
import type { FleetSnapshot, TruckView, ZoneView } from '../fleet.ts';
import { PARAMS } from '../params.ts';
import { age, countdown, dataState, elapsed, faultWords } from '../words.ts';

// ---- zone clearance panel ----

export interface ClearanceRow {
  zoneId: string;
  status: string; // CLOSING, CLOSED, or status unknown
  verdict: Verdict;
  verdictWords: 'CLEAR' | 'NOT CLEAR' | 'UNSURE';
  when: string; // "closes in 1:23", "closed 0:40 ago"
  action: string | null;
  reasons: string[]; // "<truck>: data frozen ..."
  linkDown: boolean; // the site link is down: the verdict is UNSURE whatever the data said
  was: { verdictWords: ClearanceRow['verdictWords']; agoMs: number } | null; // the last call made with the link up
}

// The verdict for one zone. The blast engine (task 5) will supply its own; until then, the
// provisional rule in src/clearance.ts.
export type VerdictFn = (zone: ZoneView, trucks: readonly TruckView[]) => Clearance;

const VERDICT_WORDS: Record<Verdict, ClearanceRow['verdictWords']> = { CLEAR: 'CLEAR', NOT_CLEAR: 'NOT CLEAR', UNSURE: 'UNSURE' };

export function zoneWhen(z: ZoneView): string {
  const left = z.msUntilEffective;
  if (z.status === 'CLOSING') {
    if (left === null) return 'closing, time not given';
    return left >= 0 ? `closes in ${countdown(left)}` : `was due to close ${elapsed(-left)} ago: treat as closed`;
  }
  if (z.status === 'CLOSED') return left !== null && left <= 0 ? `closed ${elapsed(-left)} ago` : 'closed';
  if (z.status === null) return 'status unknown: treat as closed';
  return 'open';
}

// Every zone that is closing, closed, or of unknown status, in route order: rows stay where they are
// while verdicts change, so the operator finds a zone by its name and place.
//
// While the site link is down (BLAST.md B13; UI.md), every such zone is UNSURE in full colour, with
// the last call made while the link was up beneath it and its age: "was CLEAR, 12 s ago". Nothing on
// screen can say a zone is clear when no data is arriving. `memory` keeps those last calls; without
// it there is no "was" line.
export function clearanceRows(snap: FleetSnapshot, o: { linkDown?: boolean; memory?: CallMemory; verdict?: VerdictFn } = {}): ClearanceRow[] {
  const verdictOf = o.verdict ?? zoneClearance;
  const linkDown = o.linkDown ?? false;
  o.memory?.forgetOpen(snap);
  return snap.zones.filter((z) => z.status !== 'OPEN').map((z) => {
    const c = verdictOf(z, snap.trucks);
    const last = o.memory?.call(z.zoneId, linkDown ? null : c.verdict, snap.atServerMs) ?? null;
    const verdict: Verdict = linkDown ? 'UNSURE' : c.verdict;
    const reasons = c.reasons.map((r) => (r.vehicleIds.length ? `${r.vehicleIds.join(', ')}: ${r.why}` : r.why));
    return {
      zoneId: z.zoneId,
      status: z.status ?? 'status unknown',
      verdict,
      verdictWords: VERDICT_WORDS[verdict],
      when: zoneWhen(z),
      action: verdict === 'CLEAR' ? null : (c.action ?? HOLD_THE_SHOT),
      reasons: linkDown ? ['Site link down: no data is arriving, so nobody can see whether a truck has gone in.', ...reasons] : reasons,
      linkDown,
      was: linkDown && last ? { verdictWords: VERDICT_WORDS[last.verdict], agoMs: Math.max(0, snap.atServerMs - last.atServerMs) } : null,
    };
  });
}

// The last verdict per zone made while the site link was up. Forgotten when the zone reopens, so a
// call from an earlier blast is never shown as this one's.
export class CallMemory {
  readonly #calls = new Map<string, { verdict: Verdict; atServerMs: number }>();

  // Records `verdict` (null: the link is down, nothing to record) and returns the last call.
  call(zoneId: string, verdict: Verdict | null, atServerMs: number): { verdict: Verdict; atServerMs: number } | null {
    if (verdict !== null) this.#calls.set(zoneId, { verdict, atServerMs });
    return this.#calls.get(zoneId) ?? null;
  }

  forgetOpen(snap: FleetSnapshot): void {
    for (const z of snap.zones) if (z.status === 'OPEN') this.#calls.delete(z.zoneId);
  }
}

// ---- fleet table ----

export interface FleetRow {
  vehicleId: string;
  tier: number; // lower needs attention sooner
  attention: string | null; // why it sits where it does, in words
  dataKind: TruckView['confidence'];
  data: string;
  restarted: string | null; // a controller restart in the last minute, for the data column's marker
  state: string;
  fault: string | null; // the fault codes as the truck reports them
  zone: string;
  zoneAlert: string | null; // a closing or closed zone it is, or might be, in
  soc: string;
  socFlags: string[];
  control: string;
  lastCommand: string;
}

// Attention tiers, most urgent first. A truck that might be in a closing or closed zone outranks
// everything, whatever its data state; then a truck that can't move or will die where it is; then
// doubt about where it is, from most to least; then doubt about its battery; then trucks under a
// person's control; then the rest.
export const TIERS = [
  'might be in a closing or closed zone',
  'faulted or stopped',
  'battery may not get it home',
  'data contradicted',
  'silent',
  'old',
  'no position',
  'battery figure doubted',
  'under manual control or held',
  'normal',
] as const;

function tierOf(t: TruckView, closing: Map<string, ZoneView>): { tier: number; why: string | null } {
  const zs = t.range === null ? [...closing.keys()] : t.mightBeIn.filter((z) => closing.has(z));
  if (zs.length) {
    const reported = (t.confidence === 'live' || t.confidence === 'old') ? t.position?.value.zoneId : undefined;
    const named = (id: string) => `${id} (${closing.get(id)!.status ?? 'status unknown'})`;
    if (reported && zs.includes(reported)) {
      const others = zs.filter((z) => z !== reported);
      return { tier: 0, why: `in ${named(reported)}${others.length ? `; might be in ${others.map(named).join(', ')}` : ''}` };
    }
    return { tier: 0, why: `might be in ${zs.map(named).join(', ')}` };
  }
  const faults = faultWords(t);
  const s = t.state?.value;
  if (faults || s === 'FAULT' || s === 'ESTOPPED') return { tier: 1, why: faults ?? (s === 'ESTOPPED' ? 'e-stopped' : 'faulted') };
  if (t.battery.warning) return { tier: 2, why: t.battery.message };
  if (t.confidence === 'contradicted') return { tier: 3, why: 'data frozen: position unknown' };
  if (t.confidence === 'silent') return { tier: 4, why: null };
  if (t.confidence === 'old') return { tier: 5, why: null };
  if (t.confidence === 'unknown') return { tier: 6, why: null };
  if (t.socFractional || t.battery.drainHigh) return { tier: 7, why: null };
  const c = t.control?.value;
  if (c?.mode === 'MANUAL' || c?.operatorId || s === 'MANUAL' || s === 'HOLDING') return { tier: 8, why: null };
  return { tier: 9, why: null };
}

export function socView(t: TruckView): { text: string; flags: string[] } {
  const flags: string[] = [];
  const v = t.socPct?.value;
  let text = '—';
  if (v !== undefined) {
    text = t.socFractional ? `${v} (as sent)` : `${v.toFixed(1)} %`;
    if (t.socFractional) flags.push(`looks like a fraction, not a percentage; shown as sent, not scaled`);
  }
  const b = t.battery;
  if (b.drainHigh) {
    const r = Math.max(b.ratioToFleet.empty ?? 0, b.ratioToFleet.loaded ?? 0);
    flags.push(`draining ${r.toFixed(1)}× faster than the fleet`);
  }
  if (b.warning === 'DEPLETED') flags.push('depleted: needs a tow');
  else if (b.warning === 'CANNOT_REACH_BAY') flags.push('may not reach the bay on this charge');
  else if (b.warning === 'WONT_FINISH_LAP') flags.push("won't finish its lap: return to bay now");
  return { text, flags };
}

function zoneCell(t: TruckView): string {
  const z = t.position?.value.zoneId;
  if (t.confidence === 'live' || t.confidence === 'old') return z ?? '—';
  if (t.range === null || (t.confidence === 'unknown' && !z)) return 'anywhere';
  const could = t.mightBeIn.join(', ');
  return z ? `last seen ${z}; could be in ${could}` : `could be in ${could}`;
}

function stateCell(t: TruckView): string {
  const parts: string[] = [];
  if (t.state) parts.push(t.state.value);
  if (t.task?.value) parts.push(t.task.value);
  if (t.direction?.value === 'REV' && (t.speedMps?.value ?? 0) > 0) parts.push('reversing');
  return parts.join(' · ') || '—';
}

function controlCell(t: TruckView): string {
  const c = t.control?.value;
  if (!c) return '—';
  const parts: string[] = [c.mode];
  if (c.operatorId) parts.push(`lease: ${c.operatorId}`);
  if (c.deadman) parts.push('deadman stop');
  return parts.join(' · ');
}

// No command on this truck yet, or (in the fixture player) no command registry at all.
export const NO_COMMAND_YET = '—';

// `lastCommands`: each truck's latest command in words ("HOLD by priya: done: ..."), from the live
// service. The fixture player has none.
// `restarts`: each truck's latest controller restart, in server time (UI.md: a small marker in the
// data column for about a minute).
export function fleetRows(snap: FleetSnapshot, lastCommands: ReadonlyMap<string, string> = new Map(), restarts: ReadonlyMap<string, number> = new Map()): FleetRow[] {
  const closing = new Map(snap.zones.filter((z) => z.status !== 'OPEN').map((z) => [z.zoneId, z]));
  const rows = snap.trucks.map((t, i) => {
    const { tier, why } = tierOf(t, closing);
    const zs = t.range === null ? [...closing.keys()] : t.mightBeIn.filter((z) => closing.has(z));
    const soc = socView(t);
    return {
      i,
      row: {
        vehicleId: t.vehicleId,
        tier,
        attention: why,
        dataKind: t.confidence,
        data: dataState(t),
        restarted: restartMarker(restarts.get(t.vehicleId), snap.atServerMs),
        state: stateCell(t),
        fault: (t.faults?.value.length ?? 0) > 0 ? t.faults!.value.join(', ') : null,
        zone: zoneCell(t),
        zoneAlert: zs.length ? zs.map((z) => `${z} ${closing.get(z)!.status ?? 'status unknown'}`).join(', ') : null,
        soc: soc.text,
        socFlags: soc.flags,
        control: controlCell(t),
        lastCommand: lastCommands.get(t.vehicleId) ?? NO_COMMAND_YET,
      } satisfies FleetRow,
    };
  });
  rows.sort((a, b) => a.row.tier - b.row.tier || a.i - b.i);
  return rows.map((r) => r.row);
}

export function restartMarker(atServerMs: number | undefined, nowServerMs: number): string | null {
  if (atServerMs === undefined) return null;
  const ago = nowServerMs - atServerMs;
  return ago >= 0 && ago < PARAMS.restartMarkerFor.value ? `controller restarted ${age(ago)} ago` : null;
}

// ---- links ----

export interface LinkView {
  state: 'up' | 'down' | 'not recorded';
  text: string;
}

// The site link, from heartbeat age (PROTOCOL.md §4.3). `recorded` is false only in the fixture
// player, for a recording that kept no heartbeats: then the link's state is not known, and saying
// "down" would grey a picture that is not stale.
// The live service also says when its connection has dropped (snap.link.up false): that is down at
// once, without waiting for the heartbeat to go stale.
export function siteLink(snap: FleetSnapshot, recorded = true): LinkView {
  if (!recorded) return { state: 'not recorded', text: 'Site link: not in this recording' };
  const hb = snap.heartbeat;
  if (hb.ageMs === null) return { state: 'down', text: 'Site link DOWN: no heartbeat yet' };
  if (hb.stale || snap.link.up === false) return { state: 'down', text: `Site link DOWN: no heartbeat for ${age(hb.ageMs)}` };
  return { state: 'up', text: `Site link up: heartbeat ${age(hb.ageMs)} ago` };
}

// `open` false: the browser knows its connection to the service has closed, so it is down at once.
export function serviceLink(sinceLastFrameMs: number | null, staleAfterMs: number, open = true): LinkView {
  if (sinceLastFrameMs === null) return { state: 'down', text: 'Service: not connected yet' };
  if (sinceLastFrameMs >= staleAfterMs || !open) return { state: 'down', text: `Service DISCONNECTED: nothing for ${age(sinceLastFrameMs)}` };
  return { state: 'up', text: 'Service connected' };
}
