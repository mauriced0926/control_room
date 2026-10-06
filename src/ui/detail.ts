// Truck detail (UI.md screen 2): the words for one truck, its command timeline and its buttons. Pure:
// plain data in, plain data out; the browser only draws it, the service computes who held a truck.
//
// A command is shown as what happened to it, step by step: requested, sent, acknowledged, effect seen,
// each with its time; "retry 2 of 3"; "can't verify" when the truck's data cannot show the effect; or
// failed with the reason in words. "Accepted" is never "done" (CONTEXT.md finding 3).
import type { FleetSnapshot, TruckView } from '../fleet.ts';
import type { CommandRecord } from '../registry.ts';
import type { TruckNote } from '../trucknotes.ts';
import { age, dataState, faultWords } from '../words.ts';
import { socView } from './overview.ts';

// ---- who held a truck (L7.9) ----

export interface LeaseEnd { vehicleId: string; operatorId: string | null; event: string; reason: string | null; by: string | null; atServerMs: number }

export interface HeldBy {
  by: string | null;   // operator id, "system:<rule>", or null: not by this control room as far as it knows
  how: string;         // "HOLD", "handed back after driving", ...
  atServerMs: number | null;
}

const HOLDS: Record<string, string> = {
  HOLD: 'held it (HOLD)',
  RELEASE_CONTROL: 'handed it back after driving',
  TAKE_CONTROL: 'took control; the controls ended and it held',
  EXIT_ZONE: 'sent it out of a zone (EXIT_ZONE); it holds outside',
  CLEAR_ESTOP: 'cleared its e-stop; it holds',
};

// For a truck reporting HOLDING: whose action left it there, from the latest of our confirmed
// commands and the site's lease events. Null when it is not holding.
export function heldBy(truck: TruckView | undefined, records: readonly CommandRecord[], leaseEnd: LeaseEnd | undefined): HeldBy | null {
  if (truck?.state?.value !== 'HOLDING') return null;
  let best: HeldBy = { by: null, how: 'held before this service saw it, or by another control-room client', atServerMs: null };
  for (const r of records) {
    if (r.vehicleId !== truck.vehicleId || r.status !== 'confirmed' || !(r.action in HOLDS)) continue;
    const at = r.effect?.serverMs ?? r.closedServerMs ?? r.createdServerMs;
    if (best.atServerMs === null || at > best.atServerMs) best = { by: actorId(r), how: HOLDS[r.action]!, atServerMs: at };
  }
  if (leaseEnd && leaseEnd.vehicleId === truck.vehicleId && leaseEnd.operatorId && (best.atServerMs === null || leaseEnd.atServerMs > best.atServerMs)) {
    const how = leaseEnd.event === 'EXPIRED' ? 'drove it; control expired with no drive input'
      : leaseEnd.event === 'RELEASED' ? 'handed it back after driving' : `lost control (${leaseEnd.reason ?? leaseEnd.event})`;
    best = { by: leaseEnd.operatorId, how, atServerMs: leaseEnd.atServerMs };
  }
  return best;
}

export function actorId(r: Pick<CommandRecord, 'actor'>): string {
  return r.actor.kind === 'operator' ? r.actor.operatorId : `system:${r.actor.rule}`;
}

// ---- the command timeline ----

export type Outcome = 'done' | 'waiting' | 'retrying' | 'queued' | 'under way' | "can't verify" | 'failed' | 'refused' | 'not sent' | 'expired' | 'cancelled' | 'replaced';

export interface Step { atServerMs: number | null; words: string; kind: 'request' | 'send' | 'ack' | 'refusal' | 'progress' | 'effect' | 'end' }

export interface TimelineEntry {
  id: string;
  action: string;
  by: string;
  why: string | null;
  outcome: Outcome;
  headline: string;      // the one line: "HOLD by priya: done", "RESUME by dave: retry 2 of 3"
  detail: string;        // the registry's summary, or the failure in words
  steps: Step[];
  open: boolean;
}

const OPEN = new Set(['pending', 'sent', 'acknowledged']);

export function timelineEntry(r: CommandRecord, truck: TruckView | undefined): TimelineEntry {
  const toServer = (localMs: number) => localMs + (r.createdServerMs - r.createdMs);
  const by = actorId(r);
  const steps: Step[] = [{ atServerMs: r.createdServerMs, kind: 'request', words: `Requested by ${by}${r.why && r.actor.kind === 'operator' ? `: "${r.why}"` : ''}` }];
  for (const a of r.attempts) {
    a.sends.forEach((s, i) => steps.push({
      atServerMs: s.serverMs, kind: 'send',
      words: s.replay ? `Sent again after reconnecting (same command, attempt ${a.n})` : a.n === 1 && i === 0 ? `Sent to the site${r.maxAttempts > 1 ? ` (attempt 1 of ${r.maxAttempts})` : ''}` : `Sent again: attempt ${a.n} of ${r.maxAttempts}`,
    }));
    if (a.ack) {
      const at = a.ack.serverMs ?? toServer(a.ack.rxMs);
      steps.push(a.ack.status === 'ACCEPTED'
        ? { atServerMs: at, kind: 'ack', words: 'Acknowledged: the site accepted it (not yet carried out)' }
        : { atServerMs: at, kind: 'refusal', words: `Refused by the site: ${a.ack.reason ?? 'no reason given'}${a.ack.holder ? ` (held by ${a.ack.holder})` : ''}` });
    } else if (a !== r.attempts.at(-1) || !OPEN.has(r.status)) {
      steps.push({ atServerMs: null, kind: 'ack', words: `No acknowledgement received for attempt ${a.n}` });
    }
  }
  if (r.queued) steps.push({ atServerMs: toServer(r.queued.sinceMs), kind: 'progress', words: `Queued at the truck behind ${r.queued.behind}${r.queued.estimateMs !== null ? ` (~${Math.round(r.queued.estimateMs / 1000)} s left)` : ''}` });
  if (r.started) steps.push({ atServerMs: toServer(r.started.atMs), kind: 'progress', words: `Under way: ${r.started.detail}` });
  if (r.effect) steps.push({ atServerMs: r.effect.serverMs, kind: 'effect', words: `Effect seen in telemetry: ${r.effect.detail}${r.effect.ackReceived ? '' : ' (no acknowledgement ever received)'}` });
  if (r.failure) steps.push({ atServerMs: r.closedServerMs, kind: 'end', words: r.failure.message });
  else if (r.status === 'superseded') steps.push({ atServerMs: r.closedServerMs, kind: 'end', words: 'Replaced by a newer command on this truck' });
  else if (r.status === 'cancelled') steps.push({ atServerMs: r.closedServerMs, kind: 'end', words: 'Cancelled before it was sent' });

  const n = r.attempts.length;
  const blind = truck && (truck.confidence === 'silent' || truck.confidence === 'contradicted' || truck.confidence === 'unknown');
  const blindWords = truck ? (truck.confidence === 'contradicted' ? 'data frozen' : truck.confidence === 'silent' ? 'data silent' : 'no position') : '';
  let outcome: Outcome;
  let detail = r.summary;
  switch (r.status) {
    case 'confirmed': outcome = 'done'; break;
    case 'pending': outcome = r.hold ? 'not sent' : 'waiting'; break;
    case 'sent': case 'acknowledged':
      if (blind) { outcome = "can't verify"; detail = `${r.summary}. Can't verify: ${blindWords}, so the effect cannot be seen until its data returns`; }
      else outcome = r.started ? 'under way' : r.queued ? 'queued' : n > 1 ? 'retrying' : 'waiting';
      break;
    case 'failed':
      // B16 (L2.59): a command to a truck whose data can't show the effect is "can't verify", not
      // failed. The registry reports it failed; the words here say what is known.
      if (blind && (r.failure?.code === 'NO_EFFECT' || r.failure?.code?.startsWith('EXIT_'))) {
        outcome = "can't verify";
        detail = `Can't verify: ${blindWords}. ${r.failure?.message ?? ''} Check its effect when the data returns.`;
      } else { outcome = 'failed'; detail = r.failure?.message ?? r.summary; }
      break;
    case 'refused': outcome = 'refused'; detail = r.failure?.message ?? r.summary; break;
    case 'expired': outcome = 'expired'; detail = r.failure?.message ?? r.summary; break;
    case 'cancelled': outcome = 'cancelled'; break;
    case 'superseded': outcome = 'replaced'; break;
  }
  const word = outcome === 'retrying' ? `retry ${n} of ${r.maxAttempts}`
    : outcome === 'waiting' ? (r.status === 'acknowledged' ? 'accepted, not done yet' : r.status === 'sent' ? 'sent, no answer yet' : 'about to send')
      : outcome === 'not sent' ? (r.hold?.needsReconfirm ? 'NOT sent: confirm again or cancel' : 'NOT sent yet: waiting for the site link')
        : outcome;
  return { id: r.id, action: r.action, by, why: r.why, outcome, headline: `${r.action} by ${by}: ${word}`, detail, steps, open: OPEN.has(r.status) };
}

// ---- the truck's facts ----

export interface Fact { label: string; value: string; flag?: boolean }

export function truckFacts(t: TruckView, snap: FleetSnapshot, note: TruckNote | undefined, held: HeldBy | null, you: string | null): Fact[] {
  const out: Fact[] = [];
  const p = t.position;
  out.push({ label: 'Data', value: t.confidence === 'live' ? 'live' : `${dataState(t)}: ${t.confidenceReason}`, flag: t.confidence !== 'live' });
  out.push({ label: 'State', value: [t.state?.value, t.task?.value].filter(Boolean).join(' · ') || 'not reported' });
  out.push({ label: 'Where', value: p ? `${p.value.zoneId}, ${p.value.segmentId} at ${p.value.offsetM.toFixed(1)} m${t.confidence === 'live' ? '' : `, reported ${age(p.ageMs)} ago`}${t.confidence === 'silent' || t.confidence === 'contradicted' ? `; could be in ${t.mightBeIn.join(', ') || 'anywhere'}` : ''}` : 'no valid position' });
  if (t.speedMps) out.push({ label: 'Speed', value: `${t.speedMps.value.toFixed(1)} m/s ${t.direction?.value === 'REV' ? 'reversing' : 'forward'}${t.loaded === null ? '' : t.loaded ? ', loaded' : ', empty'}` });
  const soc = socView(t);
  out.push({ label: 'Battery', value: `${soc.text} (the pack's own figure)${soc.flags.length ? `; ${soc.flags.join('; ')}` : ''}`, flag: soc.flags.length > 0 });
  const d = t.battery.drain, r = t.battery.ratioToFleet, f = snap.fleetDrain;
  const drain = (own: number | null, fleet: number | null, ratio: number | null, kind: string) => own === null ? null : `${kind} ${own.toFixed(1)} %/km${fleet !== null ? ` against the fleet's ${fleet.toFixed(1)}` : ''}${ratio !== null ? ` (${ratio.toFixed(1)}×)` : ''}`;
  const drains = [drain(d.emptyPctPerKm, f.emptyPctPerKm, r.empty, 'empty'), drain(d.loadedPctPerKm, f.loadedPctPerKm, r.loaded, 'loaded')].filter(Boolean);
  out.push({ label: 'Drain', value: drains.length ? drains.join('; ') : 'not measured yet (needs about 60 m of travel)', flag: t.battery.drainHigh });
  if (t.battery.reach.toBay) out.push({ label: 'To the bay', value: `${t.battery.reach.toBay.distanceM.toFixed(0)} m ${t.battery.reach.toBay.direction === 'FWD' ? 'forward' : 'back'}, needs about ${t.battery.reach.toBay.needPct.toFixed(1)} %` });
  const c = t.control?.value;
  out.push({ label: 'Control', value: c ? `${c.mode}${c.operatorId ? `, driven by ${c.operatorId === you ? 'you' : c.operatorId}` : ''}${c.deadman ? ', stopped by its deadman' : ''}` : 'not reported' });
  if (held) out.push({ label: 'Held by', value: held.by ? `${held.by === you ? 'you' : held.by}: ${held.how}` : held.how });
  const faults = note?.faults ?? [];
  const now = faultWords(t);
  if (faults.length || now) {
    out.push({
      label: 'Faults', flag: true,
      value: faults.length ? faults.map((x) => `${x.code}${x.endedServerMs === null ? '' : ' (cleared)'}: ${x.alreadyPresent ? 'already present when first seen' : `from ${age(snap.atServerMs - x.sinceServerMs)} ago`}${x.where ? `, in ${x.where.zoneId} (${x.where.segmentId} at ${x.where.offsetM.toFixed(0)} m)` : ''}`).join('; ') : now!,
    });
  } else out.push({ label: 'Faults', value: 'none' });
  out.push({ label: 'Clock', value: t.skewMs === null ? 'not reported' : `device clock ${fmtSkew(t.skewMs)} server time${t.skewFlagged ? ': its own timestamps are ignored; ages use server time' : ''}`, flag: t.skewFlagged });
  const restarts = note?.restarts ?? [];
  out.push({ label: 'Controller restarts', value: restarts.length ? restarts.map((x) => `${age(snap.atServerMs - x.atServerMs)} ago`).join(', ') : t.run.restarts ? `${t.run.restarts}` : 'none seen' });
  return out;
}

function fmtSkew(ms: number): string {
  const a = Math.abs(ms);
  const words = a >= 60_000 ? `${(a / 60_000).toFixed(1)} min` : `${(a / 1000).toFixed(1)} s`;
  return a < 1_000 ? 'within a second of' : `${words} ${ms > 0 ? 'ahead of' : 'behind'}`;
}

// ---- buttons ----

export interface Button {
  action: 'HOLD' | 'RESUME' | 'RETURN_TO_BAY' | 'EXIT_ZONE' | 'TAKE_CONTROL' | 'RELEASE_CONTROL';
  label: string;
  force?: true;
  primary?: boolean;
  disabled?: string;   // why it can't be pressed, in words
  note?: string;       // what pressing it will do, when that is not obvious
}

// Every button the operator may want. Most stay pressable whatever the truck is doing: the safety
// check and the site decide, and a refusal says why and what would allow it. Only what can never
// work is disabled, with the reason.
export function buttons(t: TruckView, you: { id: string; role: string } | null, held: HeldBy | null): Button[] {
  const c = t.control?.value;
  const holder = c?.mode === 'MANUAL' ? c.operatorId : null;
  const mine = holder !== null && holder === you?.id;
  const depleted = (t.faults?.value ?? []).includes('BATTERY_DEPLETED');
  const heldByYou = held?.by !== undefined && held.by === you?.id;
  const out: Button[] = [
    { action: 'HOLD', label: 'Hold' },
    { action: 'RESUME', label: heldByYou ? 'Resume (you held it)' : 'Resume', primary: heldByYou },
    { action: 'RETURN_TO_BAY', label: 'Return to bay' },
    { action: 'EXIT_ZONE', label: 'Exit zone', note: 'Leaves the zone it is in when the site accepts it, by the nearer end: it may reverse' },
  ];
  if (mine) out.push({ action: 'RELEASE_CONTROL', label: 'Release control', primary: true, note: 'Hands it back; it holds until someone resumes it' });
  else if (depleted) out.push({ action: 'TAKE_CONTROL', label: 'Take control', disabled: 'Battery depleted: it needs a tow and cannot be driven' });
  else if (holder) {
    out.push({ action: 'TAKE_CONTROL', label: 'Take control', disabled: `${holder} is driving it. Talk to them${you?.role === 'supervisor' ? ', or take over' : '; a supervisor can take over'}` });
    if (you?.role === 'supervisor') out.push({ action: 'TAKE_CONTROL', label: `Take over from ${holder}`, force: true, note: `Takes the controls from ${holder} at once; they are told who took it` });
  } else out.push({ action: 'TAKE_CONTROL', label: 'Take control', note: 'Stops it at once and waits for drive input; interrupts loading, dumping or charging' });
  return out;
}
