// TESTING.md L4: blast safety, property-tested. One seeded random day on the fake gateway, with the
// product (fleet, link, registry, blast engine and its gate) wired as the service wires it, and an
// oracle that reads the fake's truth: where every truck really is, what was really wrong (the truth
// log), and when. The product never sees any of it.
//
// Rules are stated against truth or belief exactly as TESTING.md L4 states them. Where the oracle
// has to decide something TESTING.md leaves open, the choice is written next to it.
import { performance } from 'node:perf_hooks';
import type { AlarmRaise } from '../../src/alarms.ts';
import { rangesOverlap } from '../../src/geometry.ts';
import { PARAMS } from '../../src/params.ts';
import { predictPath, visits } from '../../src/path.ts';
import { supervisoryDeadlineMs, type Actor, type CommandRecord } from '../../src/registry.ts';
import type { Site } from '../../src/site.ts';
import { PESSIMISTIC_VERSION, SPEC_VERSION } from '../../fake/behaviour.ts';
import { DLH1 } from '../../fake/dlh1.ts';
import { LIVE_DAY, type Faults } from '../../fake/faults.ts';
import type { SiteConfig, TruckTruth } from '../../fake/model.ts';
import { Rng } from '../../fake/rng.ts';
import { siteVariant } from '../../fake/sites.ts';
import { blastRig } from './blast-rig.ts';

export type Version = 'spec' | 'pessimistic';
export type SiteName = 'dlh1' | 'v7' | 'v20';

export interface DayOptions {
  seed: number;
  version: Version;
  site: SiteName;
  minutes?: number;           // default 15: the graders' unattended run
  frozenStationary?: boolean; // L4.R2c: the undetectable fault, run separately
  trace?: string;             // a truck to trace: the engine's log, its commands and its truth, for a failing seed
}

export interface Violation { rule: string; detail: string }

export interface DayResult {
  seed: number;
  version: Version;
  site: SiteName;
  frozenStationary: boolean;
  blasts: number;
  closed: number;
  violations: Violation[];
  r2c: number; // moments (checked every 250 ms) the undetectable fault had CLEAR shown over a truck inside
  r2cInside: string[]; // the undetectable fault's truck inside a zone while it was closed
  resumeBlocked: string[]; // R3 exclusions, with the reason
  metrics: {
    holds: number;               // (truck, zone) blast holds
    unnecessaryHolds: number;    // M1: on blasts that closed, the truck's true path would not have been inside while closed
    heldForCalledOff: number;    // holds for blasts that were called off (never closed)
    satAfterReopenMs: number[];  // M2: per resumed truck, reopen to moving
    alarms: number;              // can't-clear alarms on blasts that closed
    falseAlarms: number;         // M3: of those, for trucks never inside while closed
  };
  realMs: number;
  trace?: string[];
}

const STEP = 50;
const SAMPLE_EVERY = 5; // history and R2 checks every 250 ms
const OPERATOR: Actor = { kind: 'operator', operatorId: 'l4-operator', role: 'operator' };
const WORKING = new Set(['TRAMMING', 'LOADING', 'DUMPING', 'CHARGING']);

export function siteConfig(name: SiteName): SiteConfig {
  if (name === 'dlh1') return DLH1;
  return siteVariant({ trucks: name === 'v7' ? 7 : 20, noticeMs: 60_000 });
}

interface BlastRec {
  zoneId: string;
  closingAt: number;          // truth
  closingRx: number | null;   // when the engine first had it not open
  closedAt: number | null;
  reopenAt: number | null;
  insideAtClose: string[];
  firstInside: Map<string, number>; // truck -> first moment truly inside while CLOSED
}

interface Sample { at: number; truth: TruckTruth }

export function runDay(o: DayOptions): DayResult {
  const started = performance.now();
  const cfg = siteConfig(o.site);
  const faults: Faults = { ...LIVE_DAY, ...(o.frozenStationary ? { frozenStationary: true } : {}) };
  const behaviour = o.version === 'spec' ? SPEC_VERSION : PESSIMISTIC_VERSION;
  const r = blastRig({ seed: o.seed, site: cfg, blasts: 'random', faults, behaviour }, { dbPath: ':memory:' });
  const gw = r.gw, clock = r.clock;
  const site: Site = gw.model.site;
  const start = clock.now();
  const end = start + (o.minutes ?? 15) * 60_000;
  const violations: Violation[] = [];
  const v = (rule: string, detail: string) => violations.push({ rule, detail });
  const t = (ms: number) => `${((ms - start) / 1000).toFixed(1)} s`;
  const truthLog = gw.truthLog;
  const zoneRanges = new Map(site.zones.map((z) => [z.zoneId, z.ranges]));

  // ---- truth history, every 250 ms ----
  const history = new Map<string, Sample[]>();
  const sampleAt = (vid: string, at: number): TruckTruth | undefined => {
    const h = history.get(vid) ?? [];
    let best: Sample | undefined;
    for (const s of h) { if (s.at <= at) best = s; else break; }
    return (best ?? h[0])?.truth;
  };
  const enteredAfter = (vid: string, zoneId: string, at: number): number | null => {
    for (const s of history.get(vid) ?? []) if (s.at > at && s.truth.zoneId === zoneId) return s.at;
    return null;
  };
  const stateSinceAt = (vid: string, at: number): number => {
    const h = (history.get(vid) ?? []).filter((s) => s.at <= at);
    const last = h.at(-1);
    if (!last) return at;
    let since = last.at;
    for (let i = h.length - 1; i >= 0 && h[i]!.truth.state === last.truth.state; i--) since = h[i]!.at;
    return since;
  };

  // ---- what the product did, timed on the clock ----
  const alarms: Array<{ a: AlarmRaise; at: number; clearedAt: number | null }> = [];
  r.engine.subscribe((e) => {
    if (e.type === 'raise') alarms.push({ a: e, at: clock.now(), clearedAt: null });
    else if (e.type === 'clear') { const x = alarms.find((y) => y.a.key === e.key && y.clearedAt === null); if (x) x.clearedAt = clock.now(); }
  });
  const sends: Array<{ at: number; rec: CommandRecord }> = [];
  const seenSends = new Map<string, number>();
  r.registry.subscribe((e) => {
    if (e.type !== 'command') return;
    const n = e.record.attempts.reduce((s, a) => s + a.sends.length, 0);
    if (n <= (seenSends.get(e.record.id) ?? 0)) return;
    seenSends.set(e.record.id, n);
    sends.push({ at: clock.now(), rec: e.record });
    // L4.R5, from the truth at the moment of sending: never resume a truck into a zone that is not open.
    if (e.record.action === 'RESUME' && e.record.actor.kind === 'system') checkR5(e.record.vehicleId);
  });
  const linkDown: Array<{ from: number; to: number | null }> = [];

  // ---- the day's operator: one HOLD on a working truck, never resumed (L4.R4) ----
  const rng = new Rng(o.seed).fork('l4-operator');
  const opAt = start + Math.round(rng.uniform(100_000, 700_000));
  let opTruck: string | null = null;

  const blasts: BlastRec[] = [];
  const open = new Map<string, BlastRec>();
  const faultedAt = new Map<string, number>();
  const holdFirst = new Map<string, { at: number; truth: TruckTruth; prior: string | null }>(); // `${truck}|${zone}`
  let lastHolds = r.engine.holds();
  // `from`: the reopen, or the reconnect if the link was down then (nothing can be sent before it).
  const resumeWatch: Array<{ vehicleId: string; zoneId: string; reopenAt: number; from: number; movedAt: number | null; blocked: string | null; prior: string | null }> = [];
  let r2c = 0;
  const r2cInside: string[] = [];
  let step = 0;

  while (clock.now() < end) {
    r.advance(STEP, STEP);
    const now = clock.now();
    step++;
    const truths = gw.truthAll();
    for (const x of truths) {
      if ((x.faults.length > 0 || x.state === 'ESTOPPED') && !faultedAt.has(x.vehicleId)) faultedAt.set(x.vehicleId, now);
    }
    if (step % SAMPLE_EVERY === 0) {
      for (const x of truths) {
        let h = history.get(x.vehicleId);
        if (!h) history.set(x.vehicleId, (h = []));
        h.push({ at: now, truth: x });
      }
    }
    const up = r.link.isUp();
    const last = linkDown.at(-1);
    if (!up && (!last || last.to !== null)) linkDown.push({ from: now, to: null });
    if (up && last && last.to === null) last.to = now;

    if (opTruck === null && now >= opAt && up) {
      const working = truths.filter((x) => x.state === 'TRAMMING' && x.faults.length === 0);
      if (working.length) {
        opTruck = working[Math.floor(rng.next() * working.length)]!.vehicleId;
        r.registry.submit({ vehicleId: opTruck, action: 'HOLD', why: 'L4 operator hold' }, OPERATOR);
      }
    }

    for (const z of site.zones) {
      const zs = gw.zone(z.zoneId);
      let b = open.get(z.zoneId);
      if (zs.status === 'CLOSING' && !b) {
        b = { zoneId: z.zoneId, closingAt: now, closingRx: null, closedAt: null, reopenAt: null, insideAtClose: [], firstInside: new Map() };
        open.set(z.zoneId, b);
        blasts.push(b);
      }
      if (!b) continue;
      if (b.closingRx === null) { const ez = r.engine.zone(z.zoneId); if (ez && ez.status !== 'OPEN') b.closingRx = now; }
      if (zs.status === 'CLOSED') {
        if (b.closedAt === null) { b.closedAt = now; b.insideAtClose = truths.filter((x) => x.zoneId === z.zoneId).map((x) => x.vehicleId); }
        for (const x of truths) if (x.zoneId === z.zoneId && !b.firstInside.has(x.vehicleId)) b.firstInside.set(x.vehicleId, now);
      }
      if (zs.status === 'OPEN') {
        b.reopenAt = now;
        open.delete(z.zoneId);
        for (const h of lastHolds) {
          if (!h.zones.includes(z.zoneId)) continue;
          if (h.zones.some((zz) => zz !== z.zoneId && gw.zone(zz).status !== 'OPEN')) continue;
          resumeWatch.push({ vehicleId: h.vehicleId, zoneId: z.zoneId, reopenAt: now, from: now, movedAt: null, blocked: null, prior: h.priorState });
        }
      }
    }
    if (step % SAMPLE_EVERY === 0 || open.size > 0) {
      const holdsNow = r.engine.holds();
      for (const h of holdsNow) for (const z of h.zones) {
        const k = `${h.vehicleId}|${z}`;
        if (!holdFirst.has(k)) holdFirst.set(k, { at: now, truth: gw.truth(h.vehicleId), prior: h.priorState });
      }
      lastHolds = holdsNow;
    }

    for (const w of resumeWatch) {
      if (w.movedAt !== null || w.blocked !== null) continue;
      const x = gw.truth(w.vehicleId);
      if (x.state !== 'HOLDING' && x.state !== 'MANUAL') { w.movedAt = now; continue; }
      if (!up && now - w.from <= PARAMS.autoResumeWithin.value) w.from = now;
      if (now - w.from > PARAMS.autoResumeWithin.value) continue;
      if (x.faults.length) w.blocked = 'faulted';
      else if (w.vehicleId === opTruck) w.blocked = 'operator hold';
      else if (x.operatorId && !x.operatorId.startsWith('system:')) w.blocked = `leased by ${x.operatorId}`;
      else if (w.prior === null || !WORKING.has(w.prior)) w.blocked = `not working before the blast (${w.prior})`;
      else if (lastHolds.some((h) => h.vehicleId === w.vehicleId && h.zones.some((zz) => gw.zone(zz).status !== 'OPEN'))) w.blocked = 'held for another zone that is not open';
      // Its path can't be known while its data is silent or frozen: with another zone not open, the
      // gate does not resume it blind (an interpretation of B12's "path into another zone"; counted).
      else if (dataUnsure(w.vehicleId, now) && site.zones.some((zz) => gw.zone(zz.zoneId).status !== 'OPEN')) w.blocked = 'data silent or frozen while another zone is not open';
    }

    // R2a, R2b, R2c every 250 ms, while any zone is not open
    if (step % SAMPLE_EVERY === 0 && open.size > 0) {
      const snap = r.fleet.snapshot();
      for (const c of r.engine.clearances(snap)) {
        if (c.verdict !== 'CLEAR') continue;
        // R2a, belief: an independent reading of the same snapshot
        if (snap.link.up !== true) v('R2a', `${t(now)} ${c.zoneId} CLEAR with the link down`);
        for (const tv of snap.trucks) {
          if (tv.range === null || zoneRanges.get(c.zoneId)!.some((zr) => rangesOverlap(site.loopLengthM, tv.range!, zr))) {
            v('R2a', `${t(now)} ${c.zoneId} CLEAR while ${tv.vehicleId} might be inside (${tv.confidence})`);
          }
        }
        // R2b / R2c, truth
        for (const x of truths) {
          if (x.zoneId !== c.zoneId) continue;
          if (truthLog.activeAt(now, { vehicle: x.vehicleId, fault: 'frozen_stationary' }).length > 0) { r2c++; continue; }
          const fresh = truthLog.activeAt(now, { vehicle: x.vehicleId }).some((e) =>
            (e.fault === 'silent' && now - e.atMs < PARAMS.truckSilentAfter.value + PARAMS.telemetryLatencyAllowance.value) ||
            (e.fault === 'frozen_moving' && now - e.atMs < PARAMS.frozenAfter.value + PARAMS.telemetryLatencyAllowance.value));
          v('R2b', `${t(now)} ${c.zoneId} CLEAR while ${x.vehicleId} is inside at ${x.positionM.toFixed(1)} m (${x.state})${fresh ? '; its data fault was not yet past its detection threshold' : ''}`);
        }
      }
    }
  }

  function dataUnsure(vid: string, at: number): boolean {
    return truthLog.activeAt(at, { vehicle: vid }).some((e) => e.fault === 'silent' || e.fault === 'frozen_moving' || e.fault === 'frozen_stationary');
  }

  // ---- after the day ----
  const deadline = supervisoryDeadlineMs();
  const dataFaulted = (vid: string, from: number, to: number) => truthLog.entries({ vehicle: vid }).filter((e) =>
    (e.fault === 'silent' || e.fault === 'frozen_moving' || e.fault === 'frozen_stationary') && e.atMs <= to && (e.untilMs === null || e.untilMs >= from));
  const reconnectAfter = (from: number, to: number): number | null => {
    let best: number | null = null;
    for (const d of linkDown) if (d.from <= to && (d.to === null || d.to >= from)) best = Math.max(best ?? 0, d.to ?? Infinity);
    return best;
  };
  const engineDid = (vid: string, from: number, to: number) => sends.filter((s) => s.rec.vehicleId === vid && s.at >= from && s.at <= to)
    .map((s) => `${t(s.at)} ${s.rec.action} by ${s.rec.actor.kind === 'system' ? `system:${s.rec.actor.rule}` : s.rec.actor.operatorId}`).join(', ') || 'none';
  const cmdFaults = (vid: string, from: number, to: number) => truthLog.entries({ vehicle: vid }).filter((e) =>
    (e.fault === 'accepted_ignored' || e.fault === 'queued_dropped') && e.atMs >= from && e.atMs <= to);

  for (const b of blasts) {
    if (b.closedAt === null) continue;
    const E = b.closedAt;
    // L4.R0: every truck that could have been cleared or held is outside when the zone closes
    for (const vid of b.insideAtClose) {
      const why = couldHaveBeenCleared(vid, b);
      if (why === null) continue;
      const cf = cmdFaults(vid, b.closingAt, E).map((e) => `${e.fault} at ${t(e.atMs)}`).join(', ');
      v('R0', `${b.zoneId} closed at ${t(E)} with ${vid} inside; ${why}. Commands to it: ${engineDid(vid, b.closingAt, E)}${cf ? `. Command faults: ${cf}` : ''}`);
    }
    // L4.R1: a can't-clear alarm within 10 s of the data allowing it, for every truck inside while CLOSED
    for (const [vid, first] of b.firstInside) {
      // The undetectable fault (L4.R2c) is counted, not failed: its truck in a closed zone is a limit.
      if (dataFaulted(vid, b.closingAt - 60_000, first).some((e) => e.fault === 'frozen_stationary')) { r2cInside.push(`${vid} in ${b.zoneId} from ${t(first)}`); continue; }
      let ev = b.closingRx ?? b.closingAt;
      const rc = reconnectAfter(b.closingAt, first);
      if (rc !== null) ev = Math.max(ev, rc);
      if (first > E) ev = Math.max(ev, first);
      for (const e of dataFaulted(vid, b.closingAt - 60_000, first)) {
        const thr = e.fault === 'silent' ? PARAMS.truckSilentAfter.value : PARAMS.frozenAfter.value;
        ev = Math.max(ev, e.atMs + thr);
      }
      const fa = faultedAt.get(vid);
      if (fa !== undefined && fa >= b.closingAt && fa <= first) ev = Math.max(ev, fa);
      for (const e of cmdFaults(vid, b.closingAt, E)) ev = Math.max(ev, e.atMs + deadline); // a confirmation deadline missed
      const due = ev + PARAMS.cantClearAlarmWithin.value;
      const ok = alarms.some((x) => x.a.vehicleId === vid && x.a.zoneId === b.zoneId && x.at <= due && (x.clearedAt === null || x.clearedAt >= Math.min(due, first)));
      if (!ok) {
        const got = alarms.filter((x) => x.a.vehicleId === vid && x.a.zoneId === b.zoneId).map((x) => `raised ${t(x.at)}${x.clearedAt ? `, cleared ${t(x.clearedAt)}` : ''}`).join('; ') || 'never raised';
        v('R1', `${vid} inside ${b.zoneId} from ${t(first)} (closed ${t(E)}); alarm due by ${t(due)}: ${got}. Commands to it: ${engineDid(vid, b.closingAt, first)}`);
      }
    }
  }

  // L4.R3 and M2
  const sat: number[] = [];
  const resumeBlocked: string[] = [];
  for (const w of resumeWatch) {
    if (w.movedAt !== null) sat.push(w.movedAt - w.reopenAt);
    if (w.blocked !== null) { resumeBlocked.push(`${w.vehicleId} (${w.zoneId}): ${w.blocked}`); continue; }
    if (w.movedAt === null || w.movedAt - w.from > PARAMS.autoResumeWithin.value) {
      const x = gw.truth(w.vehicleId);
      v('R3', `${w.vehicleId} held for ${w.zoneId}, reopened ${t(w.reopenAt)}${w.from !== w.reopenAt ? ` (link back ${t(w.from)})` : ''}: ${w.movedAt === null ? `still ${x.state} at the end of the day` : `moving only after ${((w.movedAt - w.from) / 1000).toFixed(1)} s`}. Commands: ${engineDid(w.vehicleId, w.reopenAt - 1_000, w.reopenAt + 30_000)}`);
    }
  }
  // L4.R4
  if (opTruck !== null) {
    for (const s of sends) {
      if (s.rec.vehicleId === opTruck && s.rec.action === 'RESUME' && s.rec.actor.kind === 'system' && s.at >= opAt) {
        v('R4', `system RESUME of ${opTruck} at ${t(s.at)}, after the operator's hold at ${t(opAt)}`);
      }
    }
  }

  // M1: blast holds on trucks whose true path would never have been in the zone while it was closed
  let unnecessary = 0, calledOff = 0;
  for (const [k, h] of holdFirst) {
    const [vid, zid] = k.split('|') as [string, string];
    const b = blasts.find((x) => x.zoneId === zid && x.closingAt <= h.at && (x.reopenAt === null || x.reopenAt >= h.at));
    if (!b) continue;
    if (b.closedAt === null) { calledOff++; continue; }
    if (!wouldHaveBeenInside(vid, h.truth, h.at, b)) unnecessary++;
  }
  // M3: can't-clear alarms for trucks never inside while the zone was closed
  let falseAlarms = 0, cantClear = 0;
  for (const x of alarms) {
    if (x.a.kind !== 'cant_clear' || x.a.vehicleId === null) continue;
    const b = blasts.find((y) => y.zoneId === x.a.zoneId && y.closingAt <= x.at && (y.reopenAt === null || y.reopenAt >= x.at));
    if (!b || b.closedAt === null) continue;
    cantClear++;
    if (!b.firstInside.has(x.a.vehicleId)) falseAlarms++;
  }

  const trace = o.trace === undefined ? undefined : [
    ...r.log.filter((l) => l.includes(o.trace!)),
    ...sends.filter((x) => x.rec.vehicleId === o.trace).map((x) => `${t(x.at)} sent ${x.rec.action} ${x.rec.actor.kind === 'system' ? x.rec.actor.rule : 'operator'} -> ${x.rec.status}: ${x.rec.summary}`),
    ...truthLog.entries({ vehicle: o.trace }).filter((e) => !['lost', 'late', 'duplicate', 'truncated', 'malformed'].includes(e.fault)).map((e) => `${t(e.atMs)} truth ${e.fault} ${JSON.stringify(e.detail)}`),
    ...(history.get(o.trace) ?? []).filter((h, i, a) => i === 0 || h.truth.state !== a[i - 1]!.truth.state || h.truth.zoneId !== a[i - 1]!.truth.zoneId).map((h) => `${t(h.at)} truth ${h.truth.state} ${h.truth.zoneId} ${h.truth.positionM.toFixed(1)} task=${h.truth.task} pending=${h.truth.pending.join('+')} queued=${h.truth.queued}`),
  ];
  r.cleanup();
  return {
    trace,
    seed: o.seed, version: o.version, site: o.site, frozenStationary: !!o.frozenStationary,
    blasts: blasts.length, closed: blasts.filter((b) => b.closedAt !== null).length, violations, r2c, r2cInside, resumeBlocked,
    metrics: { holds: holdFirst.size, unnecessaryHolds: unnecessary, heldForCalledOff: calledOff, satAfterReopenMs: sat, alarms: cantClear, falseAlarms },
    realMs: performance.now() - started,
  };

  // ---- the oracle's judgements ----

  // TESTING.md L4 "could have been cleared": the data allowed the conclusion in time; time to clear
  // plus command delay fits in the time left; the truck was not interlocked. Returns why it could
  // have been, or null. Choices made here: the data does not allow it while the truck's telemetry is
  // silent or frozen (truth log); the conclusion is allowed from the CLOSING's delivery, or the
  // reconnect after a drop; a truck in a bay can't be cleared by the system (the site refuses
  // EXIT_ZONE there, B10); speeds are the fake's for this version; the command delay is the spec's
  // worst, 6 s. A truck outside then that entered later "could have been held" if it entered more
  // than 6.5 s later (2 s from a duty stop, where TAKE_CONTROL acts on receipt).
  function couldHaveBeenCleared(vid: string, b: BlastRec): string | null {
    const E = b.closedAt!;
    const fa = faultedAt.get(vid);
    if (fa !== undefined && fa <= E) return null;
    if (dataFaulted(vid, b.closingAt - 60_000, E).length) return null;
    let tData = b.closingRx ?? b.closingAt;
    const rc = reconnectAfter(b.closingAt, E);
    if (rc !== null) tData = Math.max(tData, rc);
    const x = sampleAt(vid, tData);
    if (!x) return null;
    if (x.zoneId !== b.zoneId) {
      const entered = enteredAfter(vid, b.zoneId, tData);
      if (entered === null) return null;
      const lead = entered - tData;
      const working = x.state === 'LOADING' || x.state === 'DUMPING' || x.state === 'CHARGING';
      if (lead >= (working ? 2_000 : PARAMS.supervisoryDelayMax.value + 500)) return `it could have been held: it entered at ${t(entered)}, ${(lead / 1000).toFixed(1)} s after the data allowed (${t(tData)}), from ${x.state} at ${x.positionM.toFixed(1)} m`;
      return null;
    }
    if (site.zone(b.zoneId)!.kinds.includes('bay')) return null;
    const zr = site.zone(b.zoneId)!.ranges[0]!;
    const into = ((x.positionM - zr.startM) % site.loopLengthM + site.loopLengthM) % site.loopLengthM;
    const fwd = zr.lengthM - into, rev = into;
    const dist = Math.min(fwd, rev);
    const beh = gw.behaviour;
    const speed = fwd <= rev ? (x.loaded ? beh.autoSpeedLoaded : beh.autoSpeedEmpty) : (x.loaded ? beh.reverseSpeedLoaded : beh.reverseSpeedEmpty);
    let work = 0;
    if (x.state === 'LOADING' || x.state === 'DUMPING') work = Math.max(0, (x.state === 'LOADING' ? beh.loadMs : beh.dumpMs) - (tData - stateSinceAt(vid, tData)));
    const ttc = work + beh.commandDelayMaxMs + (dist / speed) * 1000;
    if (tData + ttc <= E) return `it could have been cleared: ${x.state}${x.loaded ? ' loaded' : ''}, ${dist.toFixed(0)} m from the nearer boundary at ${t(tData)}, ${(ttc / 1000).toFixed(1)} s needed, ${((E - tData) / 1000).toFixed(1)} s left`;
    return null;
  }

  // M1's counterfactual: from the truth when the hold began, would the truck have been inside the
  // zone at any time while it was closed? Projected with the product's path prediction on the
  // truth (a metric, not a rule).
  function wouldHaveBeenInside(vid: string, x: TruckTruth, at: number, b: BlastRec): boolean {
    const until = b.reopenAt ?? end;
    if (x.zoneId === b.zoneId && x.state !== 'TRAMMING') return true;
    const pieces = predictPath(site, {
      atMs: at, positionM: x.positionM, state: x.state, task: x.task, direction: x.direction, loaded: x.loaded,
      socPct: x.socPct, stateSinceMs: stateSinceAt(vid, at),
    }, 'late', until + 1_000);
    return visits(site, pieces, until).some((vv) => vv.zoneId === b.zoneId && vv.tOut >= b.closedAt! && vv.tIn <= until);
  }

  function checkR5(vid: string): void {
    const x = gw.truth(vid);
    const notOpen = (z: string) => gw.zone(z).status !== 'OPEN';
    if (notOpen(x.zoneId)) { v('R5', `${t(clock.now())} system RESUME of ${vid} inside ${x.zoneId}, which is ${gw.zone(x.zoneId).status}`); return; }
    const speed = x.loaded ? gw.behaviour.autoSpeedLoaded : gw.behaviour.autoSpeedEmpty;
    const ahead = speed * (gw.behaviour.commandDelayMaxMs + PARAMS.supervisoryDelayMax.value) / 1000;
    for (let d = 0; d <= ahead; d += 1) {
      const z = site.zoneAt(x.positionM + d);
      if (z && notOpen(z.zoneId)) { v('R5', `${t(clock.now())} system RESUME of ${vid} ${d} m from ${z.zoneId}, which is ${gw.zone(z.zoneId).status}`); return; }
    }
  }
}
