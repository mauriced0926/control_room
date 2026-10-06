// Path prediction (BLAST.md "Inputs and timing"; TESTING.md L2.7, L2.8, L2.56, L2.57): where a truck
// will be, and when, if nobody commands it. Shared by the blast engine's B2 (leaving on its own, and
// its last safe moment), B6 (hold before entry) and the safety gate.
//
// From the truck's last believable report, forward along the loop on its autonomous duty cycle,
// stopping at each duty stop on the way: a load at the end of a 'load' segment when empty, a dump at
// the end of a 'dump' segment when loaded, a charge at the end of a 'bay' segment when below the
// charge threshold. Stops are found from segment kinds in hello, never by name (invariant 7). A truck
// carrying out EXIT_ZONE or RETURN_TO_BAY moves the way it reports to its target and stops there. A
// truck holding, idle, faulted, e-stopped or driven by hand is not predicted to move.
//
// Two bounds, because the same prediction is used both ways round:
//   'early' (for "when could it get there"): the report describes the truck up to the latency
//     allowance before it arrived, and a charge of unknown length may end at once;
//   'late' (for "when will it be out"): the report is taken at its arrival time, a charge never ends,
//     and a loaded reverse runs at the planning speed.
import { forwardDistance, normalise, timeToClearMs, zoneExit } from './geometry.ts';
import { PARAMS } from './params.ts';
import type { Direction, Task, VehicleState } from './protocol.ts';
import type { Site } from './site.ts';

export type Bound = 'early' | 'late';

export interface PathStart {
  atMs: number;                 // server time the position was received
  positionM: number;
  state: VehicleState | null;
  task: Task | null;
  direction: Direction | null;
  loaded: boolean | null;
  socPct: number | null;        // null when unknown or doubted (fractional)
  stateSinceMs: number | null;  // server time the current state was first seen
}

export type StopKind = 'LOADING' | 'DUMPING' | 'CHARGING' | 'STOPPED';

export interface Piece {
  kind: 'move' | 'stop';
  t0: number;
  t1: number;                   // Infinity for a stop that does not end by itself
  fromM: number;
  dir: 1 | -1;
  lengthM: number;              // 0 for a stop
  speedMps: number;
  loaded: boolean;
  stop: StopKind | null;
}

export interface Visit { zoneId: string; tIn: number; tOut: number }

const EPS = 1e-6;

export function workDurationMs(kind: 'LOADING' | 'DUMPING'): number {
  return kind === 'LOADING' ? PARAMS.loadTime.value : PARAMS.dumpTime.value;
}

// The duty stops on the route: positions just short of each segment end, by kind.
export function dutyStops(site: Site): Array<{ positionM: number; kind: 'LOADING' | 'DUMPING' | 'CHARGING'; segmentEndM: number }> {
  const out: Array<{ positionM: number; kind: 'LOADING' | 'DUMPING' | 'CHARGING'; segmentEndM: number }> = [];
  for (const s of site.segments) {
    const kind = s.kind === 'load' ? 'LOADING' : s.kind === 'dump' ? 'DUMPING' : s.kind === 'bay' ? 'CHARGING' : null;
    if (!kind) continue;
    const end = normalise(site.loopLengthM, s.startM + s.lengthM);
    out.push({ positionM: normalise(site.loopLengthM, end - PARAMS.dutyStopBeforeEnd.value), kind, segmentEndM: end });
  }
  return out;
}

export function autoSpeed(loaded: boolean): number {
  return loaded ? PARAMS.autoSpeedLoaded.value : PARAMS.autoSpeedEmpty.value;
}

// EXIT_ZONE and RETURN_TO_BAY speeds: forward at autonomous speed, reverse as measured, a loaded
// reverse at the planning speed for the late bound.
export function taskSpeed(loaded: boolean, dir: 1 | -1, bound: Bound): number {
  if (dir > 0) return autoSpeed(loaded);
  if (!loaded) return PARAMS.reverseSpeedEmpty.value;
  return bound === 'late' ? Math.min(PARAMS.reverseSpeedLoaded.value, PARAMS.reverseSpeedLoadedPlanning.value) : PARAMS.reverseSpeedLoaded.value;
}

// Time left on loading or dumping, from when we first saw it start.
export function workRemainingMs(start: PathStart, nowMs: number): number | null {
  if (start.state !== 'LOADING' && start.state !== 'DUMPING') return null;
  const full = workDurationMs(start.state);
  if (start.stateSinceMs === null) return full;
  return Math.max(0, full - Math.max(0, nowMs - start.stateSinceMs));
}

export function predictPath(site: Site, start: PathStart, bound: Bound, horizonEndMs: number): Piece[] {
  const L = site.loopLengthM;
  const t0 = bound === 'early' ? start.atMs - PARAMS.telemetryLatencyAllowance.value : start.atMs;
  const pos = normalise(L, start.positionM);
  const loaded = start.loaded ?? false;
  const stay = (t: number, p: number, ld: boolean, stop: StopKind = 'STOPPED'): Piece =>
    ({ kind: 'stop', t0: t, t1: Infinity, fromM: p, dir: 1, lengthM: 0, speedMps: 0, loaded: ld, stop });

  const s = start.state;
  if (s === null || s === 'HOLDING' || s === 'IDLE' || s === 'MANUAL' || s === 'ESTOPPED' || s === 'FAULT') return [stay(t0, pos, loaded)];

  if (start.task === 'EXIT_ZONE' || start.task === 'RETURN_TO_BAY') {
    const dir: 1 | -1 = start.direction === 'REV' ? -1 : 1;
    let target: number | null = null;
    if (start.task === 'EXIT_ZONE') {
      const e = zoneExit(site, pos);
      if (e) target = (dir > 0 ? e.fwdM : e.revM) + PARAMS.exitZoneStopOutside.value;
    } else {
      const bays = dutyStops(site).filter((d) => d.kind === 'CHARGING').map((d) => (dir > 0 ? forwardDistance(L, pos, d.positionM) : forwardDistance(L, d.positionM, pos)));
      if (bays.length) target = Math.min(...bays);
    }
    if (s === 'CHARGING' || target === null) return [stay(t0, pos, loaded, s === 'CHARGING' ? 'CHARGING' : 'STOPPED')];
    const v = taskSpeed(loaded, dir, bound);
    const t1 = t0 + (target / v) * 1000;
    return [
      { kind: 'move', t0, t1, fromM: pos, dir, lengthM: target, speedMps: v, loaded, stop: null },
      stay(t1, normalise(L, pos + dir * target), loaded),
    ];
  }
  if (start.direction === 'REV') return [stay(t0, pos, loaded)]; // reversing with no task: not predicted

  const pieces: Piece[] = [];
  let t = t0, p = pos, ld = loaded;
  let soc = start.socPct;
  if (s === 'LOADING' || s === 'DUMPING') {
    const r = workRemainingMs(start, start.atMs) ?? workDurationMs(s);
    pieces.push({ kind: 'stop', t0: t, t1: t + r, fromM: p, dir: 1, lengthM: 0, speedMps: 0, loaded: ld, stop: s });
    t += r;
    ld = s === 'LOADING';
  } else if (s === 'CHARGING') {
    if (bound === 'late') { pieces.push(stay(t, p, ld, 'CHARGING')); return pieces; }
    soc = PARAMS.chargeTo.value; // early: the charge may end at once
  }
  const stops = dutyStops(site);
  for (let guard = 0; guard < 64 && t < horizonEndMs; guard++) {
    const wants = (k: string) => (k === 'LOADING' && !ld) || (k === 'DUMPING' && ld) ||
      (k === 'CHARGING' && (soc === null ? bound === 'late' : soc < PARAMS.chargeBelow.value));
    let next: { d: number; kind: 'LOADING' | 'DUMPING' | 'CHARGING' } | null = null;
    for (const d of stops) {
      if (!wants(d.kind)) continue;
      const dist = forwardDistance(L, p, d.positionM);
      if (dist <= EPS) continue; // at the point already: it does not stop there again
      if (!next || dist < next.d) next = { d: dist, kind: d.kind };
    }
    const v = autoSpeed(ld);
    if (!next) { pieces.push({ kind: 'move', t0: t, t1: Infinity, fromM: p, dir: 1, lengthM: Infinity, speedMps: v, loaded: ld, stop: null }); break; }
    const t1 = t + (next.d / v) * 1000;
    pieces.push({ kind: 'move', t0: t, t1, fromM: p, dir: 1, lengthM: next.d, speedMps: v, loaded: ld, stop: null });
    p = normalise(L, p + next.d);
    t = t1;
    if (next.kind === 'CHARGING') {
      if (bound === 'late') { pieces.push(stay(t, p, ld, 'CHARGING')); break; }
      soc = PARAMS.chargeTo.value;
      continue;
    }
    const w = workDurationMs(next.kind);
    pieces.push({ kind: 'stop', t0: t, t1: t + w, fromM: p, dir: 1, lengthM: 0, speedMps: 0, loaded: ld, stop: next.kind });
    t += w;
    ld = next.kind === 'LOADING';
  }
  return pieces;
}

// Where the path is at time t: position, load, and the stop it is in, if any.
export function positionAt(site: Site, pieces: readonly Piece[], t: number): { positionM: number; loaded: boolean; piece: Piece } {
  let piece = pieces[0]!;
  for (const pc of pieces) { if (pc.t0 <= t) piece = pc; else break; }
  if (piece.kind === 'stop') return { positionM: piece.fromM, loaded: piece.loaded, piece };
  const d = Math.min(piece.lengthM, Math.max(0, ((t - piece.t0) / 1000) * piece.speedMps));
  return { positionM: normalise(site.loopLengthM, piece.fromM + piece.dir * d), loaded: piece.loaded, piece };
}

// Zone boundaries: the loop positions where the zone changes.
function boundaries(site: Site): number[] {
  const out: number[] = [];
  const segs = site.segments;
  for (let i = 0; i < segs.length; i++) {
    const prev = segs[(i - 1 + segs.length) % segs.length]!;
    if (prev.zoneId !== segs[i]!.zoneId) out.push(normalise(site.loopLengthM, segs[i]!.startM));
  }
  return out;
}

// The zones a move passes through, as distances along it.
function walk(site: Site, fromM: number, dir: 1 | -1, lengthM: number): Array<{ zoneId: string; d0: number; d1: number }> {
  const L = site.loopLengthM;
  const len = Math.min(lengthM, 4 * L);
  const cuts: number[] = [];
  for (const b of boundaries(site)) {
    let d = dir > 0 ? forwardDistance(L, fromM, b) : forwardDistance(L, b, fromM);
    if (dir > 0 && d <= EPS) d += L; // leaving a boundary forward is not crossing it
    for (; d < len; d += L) cuts.push(d);
  }
  cuts.sort((a, b) => a - b);
  const pts = [0, ...cuts, len];
  const out: Array<{ zoneId: string; d0: number; d1: number }> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const d0 = pts[i]!, d1 = pts[i + 1]!;
    if (d1 - d0 <= EPS) continue;
    const z = site.zoneAt(normalise(L, fromM + dir * ((d0 + d1) / 2)));
    if (!z) continue;
    const last = out.at(-1);
    if (last && last.zoneId === z.zoneId) last.d1 = d1;
    else out.push({ zoneId: z.zoneId, d0, d1 });
  }
  return out;
}

// The zones the path is in, in order, with when it enters and leaves each. Consecutive stays in one
// zone are merged; Infinity means it does not leave.
export function visits(site: Site, pieces: readonly Piece[], untilMs = Infinity): Visit[] {
  const out: Visit[] = [];
  const push = (zoneId: string, tIn: number, tOut: number) => {
    const last = out.at(-1);
    if (last && last.zoneId === zoneId) last.tOut = Math.max(last.tOut, tOut);
    else out.push({ zoneId, tIn, tOut });
  };
  for (const pc of pieces) {
    if (pc.t0 > untilMs) break;
    if (pc.kind === 'stop') {
      const z = site.zoneAt(pc.fromM);
      if (z) push(z.zoneId, pc.t0, pc.t1);
      continue;
    }
    // An endless move is walked only as far as the horizon allows.
    const span = Number.isFinite(pc.lengthM) ? pc.lengthM : Math.max(0, ((Math.min(untilMs, pc.t0 + 3_600_000) - pc.t0) / 1000) * pc.speedMps) + 1;
    for (const w of walk(site, pc.fromM, pc.dir, span)) {
      push(w.zoneId, pc.t0 + (w.d0 / pc.speedMps) * 1000, pc.t0 + (w.d1 / pc.speedMps) * 1000);
    }
  }
  return out;
}

// EXIT_ZONE from a point on the path: work it is queued behind, the command delay, then the distance
// to the nearer boundary at the speed for that direction and load.
export function exitZoneTimeMs(site: Site, at: { positionM: number; loaded: boolean; piece: Piece }, t: number, bound: Bound): number {
  const e = zoneExit(site, at.positionM);
  if (!e) return 0;
  const queued = at.piece.kind === 'stop' && at.piece.stop !== 'STOPPED' ? Math.max(0, at.piece.t1 - t) : 0;
  const dir: 1 | -1 = e.direction === 'FWD' ? 1 : -1;
  return queued + timeToClearMs(e.distanceM, { loaded: at.loaded, direction: e.direction, speedMps: taskSpeed(at.loaded, dir, bound) });
}

// BLAST.md B2: the latest moment at which EXIT_ZONE, from where the path will then be, still gets the
// truck out of `zoneId` by `deadlineMs`. Null if not even now. Sampled at `stepMs`; the condition only
// gets harder as time passes on any one path (moving away from the near boundary costs as much time
// as it uses; a stop uses time and gains nothing), so the first failure ends the search. Infinity
// if the path is out of the zone before EXIT_ZONE would ever be needed.
export function lastSafeMoment(site: Site, pieces: readonly Piece[], zoneId: string, nowMs: number, deadlineMs: number, stepMs = 250): number | null {
  let best: number | null = null;
  for (let t = nowMs; t <= deadlineMs; t += stepMs) {
    const at = positionAt(site, pieces, t);
    if (site.zoneAt(at.positionM)?.zoneId !== zoneId) return Infinity; // out on its own first
    if (t + exitZoneTimeMs(site, at, t, 'late') > deadlineMs) return best;
    best = t;
  }
  return best;
}
