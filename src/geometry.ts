// One-dimensional geometry on the loop (TESTING.md L2.1-L2.6). Positions are metres along the
// loop; everything wraps at the loop length, which comes from hello. A Range is closed at both
// ends: a range that touches a zone's boundary counts as inside it, because "might be inside" is
// the safe reading (CLAUDE.md invariant 6).
import { PARAMS } from './params.ts';
import type { Direction } from './protocol.ts';
import type { Range, Site } from './site.ts';

export function normalise(loopM: number, p: number): number {
  if (p >= 0 && p < loopM) return p;
  const r = ((p % loopM) + loopM) % loopM;
  return r === loopM ? 0 : r;
}

// Distance travelling forward (increasing position) from `from` to `to`, in [0, loop).
export function forwardDistance(loopM: number, from: number, to: number): number {
  return normalise(loopM, to - from);
}

export interface ZoneExit {
  zoneId: string;
  fwdM: number; // distance forward to the end of the zone's stretch containing the position
  revM: number; // distance back to its start
  fwdBoundaryM: number; // loop position of each boundary
  revBoundaryM: number;
  direction: Direction; // the nearer boundary; a tie goes forward, the normal direction of travel
  distanceM: number;
}

// Where the nearest way out of the zone at `positionM` is.
export function zoneExit(site: Site, positionM: number): ZoneExit | undefined {
  const L = site.loopLengthM;
  const p = normalise(L, positionM);
  const zone = site.zoneAt(p);
  if (!zone) return undefined;
  for (const r of zone.ranges) {
    const into = forwardDistance(L, r.startM, p);
    if (into < r.lengthM || (r.lengthM >= L)) {
      const revM = into;
      const fwdM = r.lengthM - into;
      const direction: Direction = fwdM <= revM ? 'FWD' : 'REV';
      return {
        zoneId: zone.zoneId, fwdM, revM,
        fwdBoundaryM: normalise(L, r.startM + r.lengthM), revBoundaryM: normalise(L, r.startM),
        direction, distanceM: Math.min(fwdM, revM),
      };
    }
  }
  return undefined;
}

export interface ClearOptions {
  loaded: boolean;
  direction: Direction;
  speedMps?: number; // overrides the parameter, e.g. the pessimistic loaded reverse speed (L0.P)
  delayMs?: number; // overrides the supervisory command delay
}

// Time for a truck to cover `distanceM` under a supervisory command: speed by load and direction
// (autonomous forward, EXIT_ZONE reverse), plus the time the command takes to take effect.
export function timeToClearMs(distanceM: number, o: ClearOptions): number {
  const speed = o.speedMps ?? speedFor(o.loaded, o.direction);
  const delay = o.delayMs ?? PARAMS.supervisoryDelayMax.value;
  return (Math.max(0, distanceM) / speed) * 1000 + delay;
}

function speedFor(loaded: boolean, direction: Direction): number {
  if (direction === 'FWD') return loaded ? PARAMS.autoSpeedLoaded.value : PARAMS.autoSpeedEmpty.value;
  return loaded ? PARAMS.reverseSpeedLoaded.value : PARAMS.reverseSpeedEmpty.value;
}

// Everywhere a truck could be `elapsedMs` after it was at `anchorM`, moving forward at up to
// `fwdMps` or back at up to `revMps`. Never more than the whole loop.
export function reachableRange(loopM: number, anchorM: number, elapsedMs: number, fwdMps: number, revMps: number): Range {
  const t = Math.max(0, elapsedMs) / 1000;
  const back = Math.max(0, revMps) * t;
  const ahead = Math.max(0, fwdMps) * t;
  if (back + ahead >= loopM) return { startM: 0, lengthM: loopM };
  return { startM: normalise(loopM, anchorM - back), lengthM: back + ahead };
}

// Closed-interval overlap on the loop, with wrap.
export function rangesOverlap(loopM: number, a: Range, b: Range): boolean {
  if (a.lengthM >= loopM || b.lengthM >= loopM) return true;
  const a0 = normalise(loopM, a.startM), a1 = a0 + a.lengthM;
  const b0 = normalise(loopM, b.startM), b1 = b0 + b.lengthM;
  for (const shift of [-loopM, 0, loopM]) {
    if (a0 <= b1 + shift && b0 + shift <= a1) return true;
  }
  return false;
}

// Zone ids the range touches, in route order.
export function zonesOverlapping(site: Site, range: Range): string[] {
  return site.zones.filter((z) => z.ranges.some((r) => rangesOverlap(site.loopLengthM, range, r))).map((z) => z.zoneId);
}
