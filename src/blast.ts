// The blast engine (BLAST.md; PLAN.md task 5): keeps trucks out of closed zones with nobody watching.
//
// For every zone that is CLOSING or CLOSED it decides, per truck and from belief only (FleetState,
// never the fake's truth), whether to do nothing, hold it before it enters, get it out, take it at a
// duty stop, or raise the can't-clear alarm; it resumes the trucks it held once their zone reopens.
// Every command goes through the registry, so through the safety gate, as `system:<rule>`; every
// rule id below is BLAST.md's.
//
// planTruck() is the decision, pure: one truck's view and the zones in, what it wants out. The
// BlastEngine class around it does the stateful part: when to evaluate, what is already in flight,
// which trucks it holds and for which zones (persisted, B14), alarms and their clearing (B9), and
// auto-resume (B12).
//
// Time is the injected clock; "now" is the estimated server time (fleet.serverNow()), so a link drop
// shrinks the time left (CONTEXT.md assumption 17).
import type { AlarmEvent, AlarmRaise } from './alarms.ts';
import { HOLD_THE_SHOT, zoneClearance, type Clearance, type Verdict } from './clearance.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { FleetEvent, FleetSnapshot, FleetState, TruckView } from './fleet.ts';
import { zoneExit } from './geometry.ts';
import type { LinkEvent } from './link.ts';
import { PARAMS } from './params.ts';
import { dutyStops, exitZoneTimeMs, lastSafeMoment, positionAt, predictPath, visits, workRemainingMs, type PathStart, type Piece, type Visit } from './path.ts';
import type { Action, ZoneStatus } from './protocol.ts';
import { OPEN_STATUSES, type Actor, type CommandRecord, type CommandRegistry, type RegistryEvent } from './registry.ts';
import type { Site } from './site.ts';
import type { Store } from './store.ts';
import { faultWords } from './words.ts';

export const SYSTEM_PREFIX = 'system:';
export const DRIVE_OUT_OR_HOLD = 'Drive it out or hold the shot';
const STATE_NAME = 'blast-engine';

// ---- the decision, pure ----

export interface ZoneInfo { zoneId: string; status: ZoneStatus | null; effectiveAtMs: number | null }

export interface DecideContext {
  site: Site;
  nowMs: number;                           // estimated server time
  zones: ReadonlyMap<string, ZoneInfo>;
  leaseHolder(vehicleId: string): string | null; // from the registry's lease book
  exitSentAtMs(vehicleId: string): number | null; // our EXIT_ZONE in flight, not yet under way
}

export type WantAction = 'HOLD' | 'EXIT_ZONE' | 'TAKE_CONTROL';

export interface Want {
  action: WantAction;
  rule: string;
  zoneId: string;
  why: string;
  inputs: Record<string, unknown>;
}

export interface AlarmWant {
  zoneId: string;
  rule: string;
  reason: string;
  action: string;
  notify: string | null; // a lease holder to tell as well (B5)
}

export interface TruckPlan {
  vehicleId: string;
  want: Want | null;
  alarms: AlarmWant[];
  holdFor: string[];               // zones this truck is held for if the want is carried out
  lastSafeMoment: { zoneId: string; atMs: number } | null; // B2, for display and audit
  notes: string[];                 // what the engine is waiting for, in words
}

export const isActive = (z: ZoneInfo | undefined): boolean => z?.status === 'CLOSING' || z?.status === 'CLOSED';
export const notOpen = (z: ZoneInfo | undefined): boolean => z?.status !== 'OPEN';
const UNSURE: ReadonlySet<string> = new Set(['silent', 'contradicted', 'unknown']);
const DUTY: ReadonlySet<string> = new Set(['TRAMMING', 'LOADING', 'DUMPING', 'CHARGING']);
const WORK: ReadonlySet<string> = new Set(['LOADING', 'DUMPING', 'CHARGING']);
const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
const metres = (m: number) => `${Math.round(m)} m`;

export function effectiveAt(z: ZoneInfo, nowMs: number): number {
  if (z.status === 'CLOSED' || z.effectiveAtMs === null) return Math.min(nowMs, z.effectiveAtMs ?? nowMs);
  return z.effectiveAtMs;
}

export function pathStart(t: TruckView): PathStart | null {
  if (!t.position) return null;
  return {
    atMs: t.position.atServerMs,
    positionM: t.position.value.loopM,
    state: t.state?.value ?? null,
    task: t.task?.value ?? null,
    direction: t.direction?.value ?? null,
    loaded: t.loaded,
    socPct: t.socFractional ? null : t.socPct?.value ?? null,
    stateSinceMs: t.stateSinceServerMs,
  };
}

export function holderOf(t: TruckView, ctx: Pick<DecideContext, 'leaseHolder'>): string | null {
  const c = t.control?.value;
  if (c?.operatorId) return c.operatorId;
  return ctx.leaseHolder(t.vehicleId);
}

// The zone just across the boundary EXIT_ZONE would pick from here.
export function landingZone(site: Site, positionM: number): string | null {
  const e = zoneExit(site, positionM);
  if (!e) return null;
  const across = e.direction === 'FWD' ? e.fwdBoundaryM + PARAMS.exitZoneStopOutside.value : e.revBoundaryM - PARAMS.exitZoneStopOutside.value;
  return site.zoneAt(across)?.zoneId ?? null;
}

// A duty stop at the end of a segment that is a boundary into `zoneId` (B6a), near `positionM`.
export function dutyStopInto(site: Site, positionM: number, zoneId: string): boolean {
  const L = site.loopLengthM;
  return dutyStops(site).some((d) => {
    const gap = Math.abs(((positionM - d.positionM) % L + L + L / 2) % L - L / 2);
    return gap <= 0.5 && site.zoneAt(d.segmentEndM)?.zoneId === zoneId && site.zoneAt(d.positionM)?.zoneId !== zoneId;
  });
}

function gapToZone(site: Site, range: { startM: number; lengthM: number }, zoneId: string): number {
  const L = site.loopLengthM;
  const z = site.zone(zoneId);
  if (!z) return Infinity;
  let best = Infinity;
  for (const r of z.ranges) {
    const a0 = range.startM, a1 = range.startM + range.lengthM;
    const b0 = r.startM, b1 = r.startM + r.lengthM;
    for (const shift of [-L, 0, L]) {
      const gap = Math.max(b0 + shift - a1, a0 - (b1 + shift), 0);
      best = Math.min(best, gap);
    }
  }
  return best;
}

export function planTruck(ctx: DecideContext, t: TruckView): TruckPlan {
  const plan: TruckPlan = { vehicleId: t.vehicleId, want: null, alarms: [], holdFor: [], lastSafeMoment: null, notes: [] };
  const { site, nowMs: now } = ctx;
  const active = [...ctx.zones.values()].filter(isActive).filter((z) => site.zone(z.zoneId));
  if (active.length === 0) return plan;

  const holder = holderOf(t, ctx);
  const systemLease = holder !== null && holder.startsWith(SYSTEM_PREFIX);
  const leased = holder !== null && !systemLease;
  const faults = t.faults?.value ?? [];
  const state = t.state?.value ?? null;
  const interlocked = faults.length > 0 || state === 'ESTOPPED' || state === 'FAULT';
  const margin = PARAMS.blastExitMargin.value;
  const wants: Want[] = [];
  const alarm = (zoneId: string, rule: string, reason: string, action = HOLD_THE_SHOT) =>
    plan.alarms.push({ zoneId, rule, reason, action, notify: leased ? holder : null });
  const baseInputs = (z: ZoneInfo) => ({
    zone: z.zoneId, zoneStatus: z.status, effectiveAtMs: effectiveAt(z, now), timeLeftMs: effectiveAt(z, now) - now,
    confidence: t.confidence, positionM: t.position?.value.loopM ?? null, positionAgeMs: t.position?.ageMs ?? null,
    range: t.range, state, task: t.task?.value ?? null, loaded: t.loaded,
  });

  // B1: unsure trucks are held, never sent out.
  const start = pathStart(t);
  if (UNSURE.has(t.confidence) || !start) {
    const top = Math.max(PARAMS.autoSpeedEmpty.value, PARAMS.manualSpeedEmptyFull.value);
    const lead = top * (PARAMS.supervisoryDelayMax.value + PARAMS.telemetryLatencyAllowance.value + PARAMS.blastEvalInterval.value) / 1000 + PARAMS.blastHoldMarginM.value;
    const why = t.confidence === 'contradicted' ? 'its data is frozen: it reports moving but has not moved'
      : t.confidence === 'silent' ? `it has been silent ${secs(t.ageMs ?? 0)}` : 'its position is unknown';
    const over: ZoneInfo[] = [], near: ZoneInfo[] = [];
    for (const z of active) {
      if (t.range === null || t.mightBeIn.includes(z.zoneId)) over.push(z);
      else if (gapToZone(site, t.range, z.zoneId) <= lead) near.push(z);
    }
    for (const z of over) alarm(z.zoneId, 'B1', `${t.vehicleId} might be in ${z.zoneId}: ${why}${faults.length ? `; ${faultWords(t)}` : ''}`);
    const zs = [...over, ...near];
    if (zs.length && !interlocked && !leased && !systemLease) {
      plan.want = { action: 'HOLD', rule: 'B1', zoneId: zs[0]!.zoneId, why: `held: ${why}, and it could be in or reach ${zs.map((z) => z.zoneId).join(', ')}`, inputs: baseInputs(zs[0]!) };
      plan.holdFor = zs.map((z) => z.zoneId);
    }
    return plan;
  }

  const zoneIn = site.zoneAt(start.positionM)?.zoneId ?? null;
  const horizon = now + Math.max(0, ...active.map((z) => effectiveAt(z, now) - now)) + 300_000;
  const early = predictPath(site, start, 'early', horizon);
  const late = predictPath(site, start, 'late', horizon);
  const vEarly = visits(site, early, horizon);
  const vLate = visits(site, late, horizon);
  const zinfo = (id: string) => ctx.zones.get(id);

  // Out through the far side on its own, every closing zone on the way passed before it closes, into
  // an open one (B2, B8).
  const ownExit = (vs: Visit[]): { ok: boolean; tOut: number } => {
    const first = vs[0];
    if (!first || !Number.isFinite(first.tOut)) return { ok: false, tOut: Infinity };
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i]!, z = zinfo(v.zoneId);
      if (i > 0 && !notOpen(z)) return { ok: true, tOut: first.tOut };
      if (!z || z.status !== 'CLOSING' || !Number.isFinite(v.tOut) || v.tOut > effectiveAt(z, now) - margin) return { ok: false, tOut: first.tOut };
    }
    return { ok: false, tOut: first.tOut };
  };

  for (const z of active) {
    const E = effectiveAt(z, now);
    const left = E - now;
    if (zoneIn === z.zoneId) {
      // ---- inside ----
      if (leased) {
        alarm(z.zoneId, 'B5', `${t.vehicleId} is in ${z.zoneId} and ${holder} is driving it: the system will not command it. ${left > 0 ? `${secs(left)} until it closes` : 'The zone is closed'}`);
        continue;
      }
      if (systemLease) {
        // A truck B6a took, inside a zone that is now closing: it holds when the lease expires.
        const out = now + PARAMS.leaseIdleTimeout.value + exitZoneTimeMs(site, late, z.zoneId, now, 'late');
        if (out > E - margin) alarm(z.zoneId, 'B5', `${t.vehicleId} is in ${z.zoneId}, stopped by the system at a duty stop; it can't be got out before ${z.zoneId} closes`);
        continue;
      }
      if (interlocked) {
        const what = state === 'ESTOPPED' ? 'e-stopped' : faultWords(t) ?? 'faulted';
        alarm(z.zoneId, 'B5', `${t.vehicleId} is in ${z.zoneId} and ${what}: the system can't move it${faults.length ? '. If its fault allows limp-home, drive it out under remote control' : ''}`);
        continue;
      }
      const bay = site.zone(z.zoneId)!.kinds.includes('bay');
      const own = ownExit(vLate);
      if (bay) {
        // B10: EXIT_ZONE is refused in a bay. A truck driving out on its own in time is left to it.
        if (own.ok && left > 0) { plan.notes.push(`leaving ${z.zoneId} on its own by ${secs(own.tOut - now)}`); continue; }
        alarm(z.zoneId, 'B10', `${t.vehicleId} is in ${z.zoneId}, a bay: the site refuses EXIT_ZONE there, so only a person driving it can get it out`, DRIVE_OUT_OR_HOLD);
        continue;
      }
      if (t.task?.value === 'EXIT_ZONE') {
        // Already leaving: watch that it makes it.
        const out = vLate[0]?.zoneId === z.zoneId ? vLate[0].tOut : now;
        if (out > E - margin) alarm(z.zoneId, 'B5', `${t.vehicleId} is leaving ${z.zoneId} but won't be out in time: about ${secs(out - now)} more, ${secs(left)} left`);
        continue;
      }
      if (own.ok && left > 0) {
        // B2: leaving on its own. No command until the last safe moment, fixed by the path.
        const lsm = lastSafeMoment(site, late, z.zoneId, now, E - margin);
        if (lsm === null || lsm === Infinity) { plan.notes.push(`leaving ${z.zoneId} on its own by ${secs(own.tOut - now)}`); continue; }
        plan.lastSafeMoment = { zoneId: z.zoneId, atMs: lsm };
        if (now + PARAMS.blastEvalInterval.value < lsm) { plan.notes.push(`leaving ${z.zoneId} on its own; EXIT_ZONE at its last safe moment, in ${secs(lsm - now)}, if it isn't out`); continue; }
        if (notOpen(zinfo(landingZone(site, positionAt(site, late, now).positionM) ?? ''))) { plan.notes.push(`leaving ${z.zoneId} on its own; EXIT_ZONE would land it in a zone that isn't open`); continue; }
        wants.push({ action: 'EXIT_ZONE', rule: 'B2', zoneId: z.zoneId, why: `its last safe moment to leave ${z.zoneId} has come and it isn't out`, inputs: { ...baseInputs(z), lastSafeMomentMs: lsm } });
        continue;
      }
      // Must be got out.
      const here = positionAt(site, late, now);
      const landing = landingZone(site, here.positionM);
      if (landing !== null && notOpen(zinfo(landing))) {
        // B4: never into another zone that isn't open.
        const ex = zoneExit(site, here.positionM)!;
        alarm(z.zoneId, 'B4', `${t.vehicleId} is in ${z.zoneId}; its nearest way out (${ex.direction === 'FWD' ? 'ahead' : 'behind'}, ${metres(ex.distanceM)}) leads into ${landing}, which is ${zinfo(landing)?.status?.toLowerCase() ?? 'of unknown status'}. Held. Drive it out the other way, or hold the shot`);
        if (state !== 'HOLDING') wants.push({ action: 'HOLD', rule: 'B4', zoneId: z.zoneId, why: `EXIT_ZONE would take it into ${landing}`, inputs: { ...baseInputs(z), landing } });
        plan.holdFor.push(z.zoneId);
        continue;
      }
      const ttc = exitZoneTimeMs(site, late, z.zoneId, now, 'late');
      const sent = ctx.exitSentAtMs(t.vehicleId);
      const projected = sent !== null ? Math.max(now, sent) + ttc - Math.min(PARAMS.supervisoryDelayMax.value, Math.max(0, now - sent)) : now + ttc;
      const rule = left > 0 && projected <= E - margin ? 'B3' : 'B5';
      if (rule === 'B5') {
        const ex = zoneExit(site, here.positionM)!;
        alarm(z.zoneId, 'B5', `${t.vehicleId} can't get out of ${z.zoneId} in time: ${metres(ex.distanceM)} from the nearest way out, about ${secs(projected - now)} needed, ${left > 0 ? `${secs(left)} left` : 'the zone is closed'}. Being sent out anyway`);
      }
      wants.push({ action: 'EXIT_ZONE', rule, zoneId: z.zoneId, why: rule === 'B3' ? `in ${z.zoneId}, can be got out in time` : `in ${z.zoneId}; late, but out late is better than not at all`, inputs: { ...baseInputs(z), timeToClearMs: ttc } });
      continue;
    }

    // ---- outside ----
    if (leased || systemLease || interlocked || state === null || !DUTY.has(state)) continue;
    // B6a: working at a duty stop on the boundary into the zone.
    if (WORK.has(state) && dutyStopInto(site, start.positionM, z.zoneId)) {
      const entry = vLate.find((v, i) => i > 0 && v.zoneId === z.zoneId);
      const passes = z.status === 'CLOSING' && entry !== undefined && entry.tOut <= E - margin && ownExit(vLate.slice(vLate.indexOf(entry))).ok;
      if (passes) continue;
      const remaining = state === 'CHARGING' ? 0 : workRemainingMs({ ...start, stateSinceMs: start.stateSinceMs === null ? null : start.stateSinceMs - PARAMS.telemetryLatencyAllowance.value }, now) ?? 0;
      plan.holdFor.push(z.zoneId);
      if (remaining > PARAMS.b6aTakeBeforeWorkEnds.value) { plan.notes.push(`taking control before ${state.toLowerCase()} ends, in ${secs(remaining - PARAMS.b6aTakeBeforeWorkEnds.value)}: ${z.zoneId} is next`); continue; }
      wants.push({ action: 'TAKE_CONTROL', rule: 'B6a', zoneId: z.zoneId, why: `${state.toLowerCase()} at the boundary into ${z.zoneId}, which it can't pass through in time`, inputs: { ...baseInputs(z), workRemainingMs: remaining } });
      continue;
    }
    // B6: hold before entry.
    const iE = vEarly.findIndex((v, i) => v.zoneId === z.zoneId && (i > 0 || zoneIn !== z.zoneId));
    if (iE < 0) continue;
    const tIn = vEarly[iE]!.tIn;
    const iL = vLate.findIndex((v, i) => v.zoneId === z.zoneId && (i > 0 || zoneIn !== z.zoneId));
    const passes = z.status === 'CLOSING' && iL >= 0 && ownExit(vLate.slice(iL)).ok;
    if (passes) continue;
    const speed = Math.max(0.5, firstMove(early)?.speedMps ?? PARAMS.autoSpeedEmpty.value);
    const lead = PARAMS.supervisoryDelayMax.value + PARAMS.blastEvalInterval.value + (PARAMS.blastHoldMarginM.value / speed) * 1000;
    if (tIn - now > lead) continue;
    plan.holdFor.push(z.zoneId);
    if (state === 'HOLDING') continue;
    wants.push({ action: 'HOLD', rule: 'B6', zoneId: z.zoneId, why: `would enter ${z.zoneId} in ${secs(tIn - now)} and can't pass through before it closes`, inputs: { ...baseInputs(z), entersInMs: tIn - now } });
  }

  // B8: one action per truck. Taking it (B6a) stops it at once; a B4 hold beats sending it out; an
  // EXIT_ZONE that B4 allowed lands in an open zone and stops there, so it beats a hold for another
  // zone ahead; then a hold.
  const rank = (w: Want) => (w.action === 'TAKE_CONTROL' ? 0 : w.rule === 'B4' ? 1 : w.action === 'EXIT_ZONE' ? 2 : 3);
  wants.sort((a, b) => rank(a) - rank(b));
  plan.want = wants[0] ?? null;
  if (plan.want && plan.want.action !== 'TAKE_CONTROL' && !plan.holdFor.includes(plan.want.zoneId)) plan.holdFor.push(plan.want.zoneId);
  return plan;
}

function firstMove(pieces: readonly Piece[]): Piece | undefined {
  return pieces.find((p) => p.kind === 'move');
}

// ---- the engine ----

export interface BlastHold {
  vehicleId: string;
  zones: string[];
  rules: string[];
  sinceServerMs: number;
  priorState: string | null; // what it was doing when the system first held it
}

interface Persisted { holds: BlastHold[]; operatorInCharge: string[] }

export interface ZoneClearanceView extends Clearance {
  status: ZoneStatus | null;
  effectiveAtMs: number | null;
  lastWhileUp: { verdict: Verdict; atServerMs: number } | null; // the last call made with the link up (B13)
}

export type BlastEvent = AlarmEvent | { type: 'notify'; to: string[]; vehicleId: string; message: string };

export interface BlastLink {
  isUp(): boolean;
  subscribe(fn: (e: LinkEvent) => void): () => void;
}

export interface BlastOptions {
  clock: Clock;
  fleet: FleetState;
  registry: CommandRegistry;
  store: Store;
  link: BlastLink;
  log?: (line: string) => void;
}

export class BlastEngine {
  readonly #o: BlastOptions;
  readonly #zones = new Map<string, ZoneInfo>();
  readonly #holds = new Map<string, BlastHold>();
  readonly #operatorInCharge = new Set<string>();
  readonly #alarms = new Map<string, AlarmRaise>();
  readonly #lsm = new Map<string, number>();
  readonly #closedAt = new Map<string, { action: Action; atMs: number }>();
  readonly #lastVerdict = new Map<string, { verdict: Verdict; atServerMs: number }>();
  readonly #listeners = new Set<(e: BlastEvent) => void>();
  readonly #plans = new Map<string, TruckPlan>();
  readonly #open = new Map<string, Map<string, CommandRecord>>(); // open commands per truck, from registry events
  readonly #lastSent = new Map<string, number>(); // when the engine last submitted anything to each truck
  readonly #dirty = new Set<string>();
  readonly #unsub: Array<() => void> = [];
  #all = false;
  #soonTimer: TimerHandle | null = null;
  #timer: TimerHandle | null = null;
  #busy = false;

  constructor(o: BlastOptions) {
    this.#o = o;
    for (const z of o.fleet.snapshot().zones) this.#zones.set(z.zoneId, { zoneId: z.zoneId, status: z.status, effectiveAtMs: z.effectiveAtMs });
    const saved = o.store.getState<Persisted>(STATE_NAME);
    for (const h of saved?.holds ?? []) this.#holds.set(h.vehicleId, h);
    for (const v of saved?.operatorInCharge ?? []) this.#operatorInCharge.add(v);
    this.#unsub.push(o.fleet.subscribe((e) => this.#fleetEvent(e)));
    this.#unsub.push(o.link.subscribe((e) => this.#linkEvent(e)));
    for (const r of o.registry.list({ open: true })) this.#track(r);
    this.#unsub.push(o.registry.subscribe((e) => this.#registryEvent(e)));
  }

  #track(r: CommandRecord): void {
    let m = this.#open.get(r.vehicleId);
    if (OPEN_STATUSES.has(r.status)) {
      if (!m) this.#open.set(r.vehicleId, (m = new Map()));
      m.set(r.id, r);
    } else m?.delete(r.id);
  }

  // A command that can't be verified (B16) stays open until the truck's data returns. It still counts
  // as in flight, so the engine doesn't send it again and again, until the engine has sent the truck
  // anything newer (a B12 RESUME, say): then its HOLD for the next blast is a new command.
  #stillCounts(r: CommandRecord): boolean {
    return r.status !== 'unverified' || (this.#lastSent.get(r.vehicleId) ?? -Infinity) <= r.createdMs;
  }

  #openOn(vehicleId: string): CommandRecord[] {
    return [...(this.#open.get(vehicleId)?.values() ?? [])];
  }

  subscribe(fn: (e: BlastEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  start(): void {
    this.stop();
    const loop = () => { this.evaluate(); this.#timer = this.#o.clock.setTimeout(loop, PARAMS.blastEvalInterval.value); };
    this.#timer = this.#o.clock.setTimeout(loop, PARAMS.blastEvalInterval.value);
  }

  stop(): void {
    if (this.#timer) this.#o.clock.clearTimeout(this.#timer);
    if (this.#soonTimer) this.#o.clock.clearTimeout(this.#soonTimer);
    this.#timer = this.#soonTimer = null;
  }

  shutdown(): void {
    this.stop();
    for (const u of this.#unsub) u();
  }

  // ---- what others read ----

  // Zones this truck is held for by the blast engine (the safety gate's L2.51).
  heldFor(vehicleId: string): string[] {
    return [...(this.#holds.get(vehicleId)?.zones ?? [])];
  }

  holds(): BlastHold[] {
    return [...this.#holds.values()].map((h) => structuredClone(h));
  }

  zone(zoneId: string): ZoneInfo | undefined {
    const z = this.#zones.get(zoneId);
    return z && { ...z };
  }

  openAlarms(): AlarmRaise[] {
    return [...this.#alarms.values()].map((a) => ({ ...a }));
  }

  plan(vehicleId: string): TruckPlan | undefined {
    const p = this.#plans.get(vehicleId);
    return p && structuredClone(p);
  }

  // B11 and B13: the verdict per zone that is not open, from belief, with the last call made while
  // the link was up.
  clearances(snap: FleetSnapshot = this.#o.fleet.snapshot()): ZoneClearanceView[] {
    const linkUp = snap.link.up === true;
    return snap.zones.filter((z) => z.status !== 'OPEN').map((z) => {
      const c = zoneClearance(z, snap.trucks, { linkUp });
      if (linkUp) this.#lastVerdict.set(z.zoneId, { verdict: c.verdict, atServerMs: snap.atServerMs });
      const last = this.#lastVerdict.get(z.zoneId) ?? null;
      return { ...c, status: z.status, effectiveAtMs: z.effectiveAtMs, lastWhileUp: last && { ...last } };
    });
  }

  // ---- evaluation ----

  evaluate(): void {
    this.#all = true;
    this.#run();
  }

  #soon(vehicleId?: string): void {
    if (vehicleId === undefined) this.#all = true;
    else this.#dirty.add(vehicleId);
    if (this.#soonTimer) return;
    this.#soonTimer = this.#o.clock.setTimeout(() => { this.#soonTimer = null; this.#run(); }, 0);
  }

  #anyNotOpen(): boolean {
    for (const z of this.#zones.values()) if (z.status !== 'OPEN') return true;
    return false;
  }

  #busyWith(): boolean {
    return this.#anyNotOpen() || this.#holds.size > 0 || this.#alarms.size > 0;
  }

  #run(): void {
    if (this.#busy) return;
    const all = this.#all;
    const ids = [...this.#dirty];
    this.#all = false;
    this.#dirty.clear();
    if (!this.#busyWith()) { this.#plans.clear(); return; }
    const site = this.#o.fleet.site;
    if (!site) return;
    this.#busy = true;
    try {
      // With every zone open only the trucks it holds (to resume) and has alarms for need a look.
      const zonesBusy = this.#anyNotOpen();
      const snap = all && zonesBusy ? this.#o.fleet.snapshot() : null;
      const some = all && !zonesBusy
        ? [...new Set([...this.#holds.keys(), ...[...this.#alarms.values()].map((a) => a.vehicleId).filter((x): x is string => x !== null)])]
        : ids;
      const trucks = snap ? snap.trucks : some.map((id) => this.#o.fleet.truck(id)).filter((t): t is TruckView => !!t);
      const ctx = this.#context(site);
      for (const t of trucks) this.#evaluateTruck(ctx, t);
      if (all) this.#linkAlarm();
      if (snap) this.clearances(snap);
    } finally {
      this.#busy = false;
    }
  }

  #context(site: Site): DecideContext {
    const reg = this.#o.registry;
    return {
      site, nowMs: this.#o.fleet.serverNow(), zones: this.#zones,
      leaseHolder: (v) => reg.lease(v)?.operatorId ?? null,
      exitSentAtMs: (v) => {
        const r = this.#openOn(v).find((x) => x.action === 'EXIT_ZONE' && x.actor.kind === 'system' && !x.started);
        return r?.attempts.at(-1)?.sends.at(-1)?.serverMs ?? null;
      },
    };
  }

  #evaluateTruck(ctx: DecideContext, t: TruckView): void {
    const plan = planTruck(ctx, t);
    // B2: the last safe moment never moves later once computed.
    if (plan.lastSafeMoment) {
      const key = `${t.vehicleId}|${plan.lastSafeMoment.zoneId}`;
      const prev = this.#lsm.get(key);
      if (prev !== undefined && prev < plan.lastSafeMoment.atMs) {
        plan.lastSafeMoment.atMs = prev;
        if (!plan.want && ctx.nowMs + PARAMS.blastEvalInterval.value >= prev) {
          const z = this.#zones.get(plan.lastSafeMoment.zoneId)!;
          const landing = landingZone(ctx.site, t.position!.value.loopM);
          if (!notOpen(this.#zones.get(landing ?? ''))) {
            plan.want = { action: 'EXIT_ZONE', rule: 'B2', zoneId: z.zoneId, why: `its last safe moment to leave ${z.zoneId} has come and it isn't out`, inputs: { zone: z.zoneId, lastSafeMomentMs: prev, confidence: t.confidence, positionM: t.position?.value.loopM ?? null } };
            plan.holdFor.push(z.zoneId);
          }
        }
      } else this.#lsm.set(key, plan.lastSafeMoment.atMs);
    }
    this.#plans.set(t.vehicleId, plan);
    for (const a of plan.alarms) this.#raise(t.vehicleId, a);
    if (plan.want) this.#issue(t, plan.want, plan.holdFor);
    else if (plan.holdFor.length && this.#holds.has(t.vehicleId)) this.#addHold(t, plan.holdFor, null);
    this.#maybeResume(ctx, t);
    this.#clearAlarmsFor(t);
  }

  // ---- commands ----

  #actor(rule: string, inputs: Record<string, unknown>): Actor {
    return { kind: 'system', rule, inputs };
  }

  #issue(t: TruckView, w: Want, holdFor: string[]): void {
    const v = t.vehicleId;
    const reg = this.#o.registry;
    const open = this.#openOn(v);
    const confident = t.confidence === 'live' || t.confidence === 'old';
    const inEffect =
      (w.action === 'HOLD' && confident && t.state?.value === 'HOLDING') ||
      (w.action === 'EXIT_ZONE' && t.task?.value === 'EXIT_ZONE') ||
      (w.action === 'TAKE_CONTROL' && (t.control?.value.operatorId ?? '').startsWith(SYSTEM_PREFIX));
    if (inEffect) {
      if (this.#holds.has(v)) this.#addHold(t, holdFor, null);
      return;
    }
    if (open.some((r) => r.action === w.action && this.#stillCounts(r))) return; // in flight already
    // A truck we are getting out that goes quiet is not stopped mid-way by B1: a HOLD could leave it
    // inside, and the EXIT_ZONE already sent can't be recalled anyway (B7). It stays UNSURE.
    if (w.rule === 'B1' && open.some((r) => r.action === 'EXIT_ZONE' && r.actor.kind === 'system')) return;
    // A command of ours that just failed is not repeated at once (the registry has retried it).
    const closed = this.#closedAt.get(v);
    if (closed && closed.action === w.action && this.#o.clock.now() - closed.atMs < PARAMS.blastCommandCooldown.value) return;
    if (!this.#o.link.isUp()) return; // B13: nothing can be sent; on reconnect we decide again at once
    this.#lastSent.set(v, this.#o.clock.now());
    const rec = reg.submit({ vehicleId: v, action: w.action, why: w.why }, this.#actor(w.rule, w.inputs));
    if (rec.status === 'refused') {
      this.#closedAt.set(v, { action: w.action, atMs: this.#o.clock.now() });
      this.#log(`blast ${w.rule}: ${w.action} ${v} refused by the safety gate: ${rec.failure?.message ?? ''}`);
      return;
    }
    this.#log(`blast ${w.rule}: ${w.action} ${v} (${w.zoneId}): ${w.why}`);
    this.#addHold(t, holdFor.length ? holdFor : [w.zoneId], w.rule);
  }

  #addHold(t: TruckView, zones: string[], rule: string | null): void {
    const v = t.vehicleId;
    let h = this.#holds.get(v);
    let changed = false;
    if (!h) {
      h = { vehicleId: v, zones: [], rules: [], sinceServerMs: this.#o.fleet.serverNow(), priorState: t.state?.value ?? null };
      this.#holds.set(v, h);
      changed = true;
    }
    for (const z of zones) if (!h.zones.includes(z)) { h.zones.push(z); changed = true; }
    if (rule && !h.rules.includes(rule)) { h.rules.push(rule); changed = true; }
    if (changed) this.#persist();
  }

  #dropHold(v: string, why: string): void {
    const h = this.#holds.get(v);
    if (!h) return;
    this.#holds.delete(v);
    for (const k of [...this.#lsm.keys()]) if (k.startsWith(`${v}|`)) this.#lsm.delete(k);
    this.#persist();
    this.#audit(v, 'B12', 'blast_hold_ended', `${v}: no longer held for ${h.zones.join(', ')}: ${why}`, { zones: h.zones, rules: h.rules, priorState: h.priorState });
  }

  // B12: resume what the system held, once every zone it was held for has reopened.
  #maybeResume(ctx: DecideContext, t: TruckView): void {
    const v = t.vehicleId;
    const h = this.#holds.get(v);
    if (!h) return;
    if (h.zones.some((z) => notOpen(this.#zones.get(z)))) return;
    if (this.#operatorInCharge.has(v)) { this.#dropHold(v, 'an operator has acted on it since; only they resume it'); return; }
    if (h.priorState === null || !DUTY.has(h.priorState)) { this.#dropHold(v, `it was ${h.priorState?.toLowerCase() ?? 'in an unknown state'} before the blast, not working`); return; }
    if ((t.faults?.value ?? []).length > 0 || t.state?.value === 'FAULT' || t.state?.value === 'ESTOPPED') { this.#dropHold(v, 'it is faulted or e-stopped; a person decides'); return; }
    const holder = holderOf(t, ctx);
    if (holder !== null && !holder.startsWith(SYSTEM_PREFIX)) { this.#dropHold(v, `${holder} is driving it`); return; }
    if (holder !== null) return; // our B6a lease: it expires to HOLDING by itself
    // Never into a zone that isn't open (L4.R5): if B6 would hold it again at once, it waits for that zone too.
    const start = pathStart(t);
    if (UNSURE.has(t.confidence) || !start) {
      const touched = t.range === null ? [...this.#zones.values()].filter((z) => notOpen(z)).map((z) => z.zoneId) : t.mightBeIn.filter((z) => notOpen(this.#zones.get(z)));
      if (touched.length) { this.#addHold(t, touched, null); return; }
    } else {
      const as = { ...start, state: 'TRAMMING' as const, task: null, direction: 'FWD' as const, atMs: ctx.nowMs };
      const lead = 2 * PARAMS.supervisoryDelayMax.value + PARAMS.telemetryLatencyAllowance.value + PARAMS.blastEvalInterval.value + 10_000;
      const vs = visits(ctx.site, predictPath(ctx.site, as, 'early', ctx.nowMs + lead), ctx.nowMs + lead);
      const into = vs.filter((x) => x.tIn <= ctx.nowMs + lead && notOpen(this.#zones.get(x.zoneId))).map((x) => x.zoneId);
      if (into.length) { this.#addHold(t, into, null); return; }
    }
    const state = t.state?.value ?? null;
    const inputs = { zones: h.zones, rules: h.rules, heldSinceServerMs: h.sinceServerMs, state, confidence: t.confidence };
    // An EXIT_ZONE under way is stopped with HOLD, never RESUME (B7: refused while a task runs).
    const open = this.#openOn(v).filter((r) => !(r.action === 'EXIT_ZONE' && r.started) && r.status !== 'unverified');
    if (t.task?.value === 'EXIT_ZONE' && !open.some((r) => r.action === 'HOLD')) { this.#issueResume(t, 'HOLD', 'still carrying out EXIT_ZONE: HOLD first, then RESUME (B7)', inputs); return; }
    if (open.length) return; // something of ours (or anyone's) still on its way: B7, don't race it
    if (state === 'HOLDING' || (UNSURE.has(t.confidence) && state !== 'IDLE')) { this.#issueResume(t, 'RESUME', `${h.zones.join(', ')} reopened`, inputs); return; }
    if (state !== null && DUTY.has(state) && !UNSURE.has(t.confidence)) this.#dropHold(v, `${v} is ${state.toLowerCase()}: working again`);
    else if (state === 'IDLE') this.#dropHold(v, `${v} is idle; not restarted`);
  }

  #issueResume(t: TruckView, action: 'HOLD' | 'RESUME', why: string, inputs: Record<string, unknown>): void {
    const closed = this.#closedAt.get(t.vehicleId);
    if (closed && closed.action === action && this.#o.clock.now() - closed.atMs < PARAMS.blastCommandCooldown.value) return;
    if (!this.#o.link.isUp()) return;
    this.#lastSent.set(t.vehicleId, this.#o.clock.now());
    const rec = this.#o.registry.submit({ vehicleId: t.vehicleId, action, why }, this.#actor('B12', inputs));
    if (rec.status === 'refused') this.#closedAt.set(t.vehicleId, { action, atMs: this.#o.clock.now() });
    this.#log(`blast B12: ${action} ${t.vehicleId}: ${why}${rec.status === 'refused' ? ` (refused: ${rec.failure?.message ?? ''})` : ''}`);
  }

  // ---- alarms (B9) ----

  #raise(vehicleId: string, a: AlarmWant): void {
    const key = `blast:cant_clear:${a.zoneId}:${vehicleId}`;
    if (this.#alarms.has(key)) return;
    const message = `${a.reason}.`;
    const e: AlarmRaise = {
      type: 'raise', source: 'blast', kind: 'cant_clear', key, vehicleId, zoneId: a.zoneId,
      message, action: a.action, interrupt: true, rule: a.rule, atServerMs: this.#o.fleet.serverNow(),
    };
    this.#alarms.set(key, e);
    this.#audit(vehicleId, a.rule, 'alarm', `${message} ${a.action}.`, { zone: a.zoneId });
    this.#log(`ALARM (blast ${a.rule}, ${vehicleId}, ${a.zoneId}): ${message} ${a.action}.`);
    this.#emit(e);
    if (a.notify) this.#emit({ type: 'notify', to: [a.notify], vehicleId, message: `${message} ${a.action}.` });
  }

  #clear(key: string, reason: string): void {
    const a = this.#alarms.get(key);
    if (!a) return;
    this.#alarms.delete(key);
    this.#audit(a.vehicleId, a.rule, 'alarm_cleared', `${a.vehicleId ?? 'site'} / ${a.zoneId ?? ''}: alarm cleared: ${reason}`, { zone: a.zoneId });
    this.#emit({ type: 'clear', key, reason, atServerMs: this.#o.fleet.serverNow() });
  }

  // Cleared only when the truck is confirmed outside or the zone reopens; never because time passed.
  #clearAlarmsFor(t: TruckView): void {
    for (const [key, a] of [...this.#alarms]) {
      if (a.vehicleId !== t.vehicleId || a.zoneId === null) continue;
      const z = this.#zones.get(a.zoneId);
      if (z?.status === 'OPEN') { this.#clear(key, `${a.zoneId} reopened`); continue; }
      const confident = t.confidence === 'live' || t.confidence === 'old';
      if (confident && t.range !== null && !t.mightBeIn.includes(a.zoneId)) this.#clear(key, `${t.vehicleId} confirmed outside ${a.zoneId}`);
    }
  }

  #clearZone(zoneId: string, reason: string): void {
    for (const [key, a] of [...this.#alarms]) if (a.zoneId === zoneId) this.#clear(key, reason);
  }

  // B13: link down while a zone is closing or closed interrupts.
  #linkAlarm(): void {
    const key = 'blast:link_down';
    const anyActive = [...this.#zones.values()].some(isActive);
    if (!this.#o.link.isUp() && anyActive) {
      if (this.#alarms.has(key)) return;
      const zones = [...this.#zones.values()].filter(isActive).map((z) => z.zoneId);
      const e: AlarmRaise = {
        type: 'raise', source: 'blast', kind: 'link_down_in_blast', key, vehicleId: null, zoneId: null,
        message: `Site link down while ${zones.join(', ')} ${zones.length > 1 ? 'are' : 'is'} closing or closed: no command can reach a truck and every such zone is UNSURE.`,
        action: HOLD_THE_SHOT, interrupt: true, rule: 'B13', atServerMs: this.#o.fleet.serverNow(),
      };
      this.#alarms.set(key, e);
      this.#log(`ALARM (blast B13): ${e.message}`);
      this.#emit(e);
    } else if (this.#alarms.has(key)) {
      this.#clear(key, this.#o.link.isUp() ? 'site link up again' : 'no zone is closing or closed');
    }
  }

  // ---- events in ----

  #fleetEvent(e: FleetEvent): void {
    if (e.type === 'zone') {
      const prev = this.#zones.get(e.zoneId);
      this.#zones.set(e.zoneId, { zoneId: e.zoneId, status: e.status, effectiveAtMs: e.effectiveAtMs });
      if (e.status === 'OPEN' && prev?.status !== 'OPEN') {
        this.#clearZone(e.zoneId, e.reason === 'CANCELLED' ? 'the blast was called off' : `${e.zoneId} reopened`);
        for (const k of [...this.#lsm.keys()]) if (k.endsWith(`|${e.zoneId}`)) this.#lsm.delete(k);
      }
      this.#soon();
    } else if (e.type === 'confidence') {
      this.#soon(e.vehicleId);
    }
  }

  #linkEvent(e: LinkEvent): void {
    if (e.type === 'up' || e.type === 'down') this.#soon();
    else if (e.type === 'message' && e.msg.type === 'telemetry' && typeof e.msg.vehicle_id === 'string') {
      if (this.#anyNotOpen() || this.#holds.has(e.msg.vehicle_id)) this.#soon(e.msg.vehicle_id);
    }
  }

  #registryEvent(e: RegistryEvent): void {
    if (e.type === 'lease' && e.lease && !e.lease.operatorId.startsWith(SYSTEM_PREFIX)) {
      this.#operatorTook(e.vehicleId);
      return;
    }
    if (e.type !== 'command') return;
    const r: CommandRecord = e.record;
    this.#track(r);
    if (r.actor.kind === 'operator') {
      if (r.status === 'refused' || r.status === 'cancelled') return;
      if (r.action === 'RESUME') {
        if (this.#operatorInCharge.delete(r.vehicleId)) this.#persist();
        if (this.#holds.has(r.vehicleId) && r.status === 'sent') this.#dropHold(r.vehicleId, `${r.actor.operatorId} resumed it`);
      } else if (r.status === 'sent' || r.status === 'pending') {
        this.#operatorTook(r.vehicleId);
      }
      return;
    }
    if (r.status === 'failed' || r.status === 'refused' || r.status === 'expired') {
      this.#closedAt.set(r.vehicleId, { action: r.action, atMs: this.#o.clock.now() });
    }
    if (r.status !== 'sent' && r.status !== 'pending') this.#soon(r.vehicleId);
  }

  #operatorTook(vehicleId: string): void {
    if (this.#operatorInCharge.has(vehicleId)) return;
    this.#operatorInCharge.add(vehicleId);
    this.#persist();
  }

  // ---- bookkeeping ----

  #persist(): void {
    this.#o.store.putState(STATE_NAME, { holds: [...this.#holds.values()], operatorInCharge: [...this.#operatorInCharge] } satisfies Persisted, this.#o.clock.now());
  }

  #audit(vehicleId: string | null, rule: string, event: string, what: string, inputs: unknown): void {
    this.#o.store.audit({
      atMs: this.#o.clock.now(), serverMs: this.#o.fleet.serverNow(), actorKind: 'system', actor: 'system', rule,
      event, vehicleId, recordId: null, commandId: null, what, why: null, inputs,
    });
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }

  #emit(e: BlastEvent): void {
    for (const fn of this.#listeners) fn(e);
  }
}
