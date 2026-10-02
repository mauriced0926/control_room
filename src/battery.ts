// Battery (TESTING.md L2.27-L2.28; CONTEXT.md assumption 13). The pack's own SoC is always shown as
// reported. Beside it: the truck's drain per metre against the fleet, and whether it can reach the
// bay on what it has, at its own rate. Warnings name the action; acting stays with the operator.
import { forwardDistance, normalise } from './geometry.ts';
import { PARAMS } from './params.ts';
import type { Direction, Task, VehicleState } from './protocol.ts';
import type { Site } from './site.ts';

// PROTOCOL.md §6.6: the fault a truck cannot limp home from.
export const DEPLETED_FAULT = 'BATTERY_DEPLETED';

interface Sample { dropPct: number; distM: number }

// The last PARAMS.drainWindow metres of travel in one load state.
class DrainWindow {
  #samples: Sample[] = [];
  #drop = 0;
  #dist = 0;

  add(dropPct: number, distM: number): void {
    this.#samples.push({ dropPct, distM });
    this.#drop += dropPct;
    this.#dist += distM;
    while (this.#samples.length > 1 && this.#dist - this.#samples[0]!.distM >= PARAMS.drainWindow.value) {
      const s = this.#samples.shift()!;
      this.#drop -= s.dropPct;
      this.#dist -= s.distM;
    }
  }

  get evidenceM(): number { return this.#dist; }

  // %/m, or null without enough evidence.
  rate(): number | null {
    return this.#dist >= PARAMS.drainMinEvidence.value ? Math.max(0, this.#drop) / this.#dist : null;
  }
}

export class DrainTracker {
  readonly empty = new DrainWindow();
  readonly loaded = new DrainWindow();

  add(loaded: boolean, dropPct: number, distM: number): void {
    (loaded ? this.loaded : this.empty).add(dropPct, distM);
  }
}

export interface FleetDrain {
  emptyPctPerM: number | null;
  loadedPctPerM: number | null;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// The median of other trucks' rates, if there are enough of them.
export function fleetMedianExcluding(rates: Array<{ id: string; rate: number | null }>, self: string): number | null {
  const others = rates.filter((r) => r.id !== self && r.rate !== null).map((r) => r.rate!);
  return others.length >= PARAMS.fleetMinTrucks.value ? median(others) : null;
}

export interface PathLegs { distanceM: number; emptyM: number; loadedM: number }

// Shorter way to the nearest bay: forward to a bay's start or back to its end. Zero inside one.
export function shorterWayToBay(site: Site, positionM: number): { direction: Direction; distanceM: number } | null {
  const L = site.loopLengthM;
  const bays = site.bayZones().flatMap((z) => z.ranges);
  if (bays.length === 0) return null;
  const p = normalise(L, positionM);
  let fwd = Infinity, rev = Infinity;
  for (const r of bays) {
    if (forwardDistance(L, r.startM, p) < r.lengthM) return { direction: 'FWD', distanceM: 0 };
    fwd = Math.min(fwd, forwardDistance(L, p, r.startM));
    rev = Math.min(rev, forwardDistance(L, normalise(L, r.startM + r.lengthM), p));
  }
  return fwd <= rev ? { direction: 'FWD', distanceM: fwd } : { direction: 'REV', distanceM: rev };
}

// The autonomous duty cycle forward from `positionM` to the next arrival at a bay: a truck becomes
// loaded at the end of a load segment and empty at the end of a dump segment (PROTOCOL.md §3; kinds
// come from hello). A truck starting inside a bay first leaves it.
export function dutyCycleToBay(site: Site, positionM: number, loaded: boolean): PathLegs | null {
  const L = site.loopLengthM;
  const segs = site.segments;
  if (segs.length === 0 || !segs.some((s) => s.kind === 'bay')) return null;
  const p = normalise(L, positionM);
  let i = segs.findIndex((s) => forwardDistance(L, s.startM, p) < s.lengthM);
  if (i < 0) return null;
  let left = segs[i]!.lengthM - forwardDistance(L, segs[i]!.startM, p);
  let leftBay = segs[i]!.kind !== 'bay';
  let state = loaded;
  const legs: PathLegs = { distanceM: 0, emptyM: 0, loadedM: 0 };
  for (let steps = 0; steps <= 2 * segs.length + 1; steps++) {
    const s = segs[i]!;
    legs.distanceM += left;
    if (state) legs.loadedM += left; else legs.emptyM += left;
    if (s.kind === 'load' && !state) state = true;
    else if (s.kind === 'dump' && state) state = false;
    i = (i + 1) % segs.length;
    const next = segs[i]!;
    if (next.kind !== 'bay') leftBay = true;
    else if (leftBay) return legs;
    left = next.lengthM;
  }
  return null;
}

export type BatteryWarning = 'DEPLETED' | 'CANNOT_REACH_BAY' | 'WONT_FINISH_LAP';

export interface Reach {
  toBay: { direction: Direction; distanceM: number; needPct: number } | null;
  onRoute: { distanceM: number; needPct: number } | null;
  rateSource: 'own' | 'own, loaded estimated' | 'fleet' | null;
}

export interface Assessment {
  reach: Reach;
  warning: BatteryWarning | null;
  message: string | null;
}

export interface BatteryInput {
  site: Site | undefined;
  socPct: number | undefined;
  socFractional: boolean;
  positionM: number | undefined;
  loaded: boolean | undefined;
  state: VehicleState | undefined;
  task: Task | null | undefined;
  faults: string[] | undefined;
  ownEmpty: number | null; // %/m
  ownLoaded: number | null;
  fleet: FleetDrain;
}

const NO_REACH: Reach = { toBay: null, onRoute: null, rateSource: null };

export function assess(b: BatteryInput): Assessment {
  if (b.faults?.includes(DEPLETED_FAULT)) {
    return { reach: NO_REACH, warning: 'DEPLETED', message: 'Battery depleted: needs a tow; cannot be driven' };
  }
  if (!b.site || b.socPct === undefined || b.socFractional || b.positionM === undefined || b.loaded === undefined) {
    return { reach: NO_REACH, warning: null, message: null };
  }
  const rates = rateFor(b);
  if (!rates) return { reach: NO_REACH, warning: null, message: null };
  const need = (empty: number, loadedM: number) => empty * rates.empty + loadedM * rates.loaded;

  const way = shorterWayToBay(b.site, b.positionM);
  const toBay = way && { ...way, needPct: b.loaded ? need(0, way.distanceM) : need(way.distanceM, 0) };
  const legs = b.task === 'RETURN_TO_BAY' ? null : dutyCycleToBay(b.site, b.positionM, b.loaded);
  const onRoute = legs && { distanceM: legs.distanceM, needPct: need(legs.emptyM, legs.loadedM) };
  const reach: Reach = { toBay, onRoute, rateSource: rates.source };

  if (b.state === 'CHARGING') return { reach, warning: null, message: null };
  const reserve = PARAMS.batteryReserveFactor.value;
  const soc = b.socPct;
  const pct = (x: number) => `${x.toFixed(1)} %`;
  if (toBay && soc < toBay.needPct * reserve) {
    return {
      reach, warning: 'CANNOT_REACH_BAY',
      message: `May not reach the bay: needs about ${pct(toBay.needPct)} going ${toBay.direction === 'FWD' ? 'forward' : 'back'}, has ${pct(soc)}. Return to bay now and plan for a tow`,
    };
  }
  const inBay = toBay?.distanceM === 0;
  const willCharge = inBay && soc < PARAMS.chargeBelow.value;
  if (onRoute && !willCharge && soc < onRoute.needPct * reserve) {
    return {
      reach, warning: 'WONT_FINISH_LAP',
      message: `Will not finish its lap on this charge: needs about ${pct(onRoute.needPct)}, has ${pct(soc)}. Return to bay now, while it still can`,
    };
  }
  return { reach, warning: null, message: null };
}

// The truck's own rates where known; a missing load state is estimated from the other one by the
// fleet's loaded/empty ratio (or the measured factor); with no own data, the fleet's median.
function rateFor(b: BatteryInput): { empty: number; loaded: number; source: Reach['rateSource'] } | null {
  const fleetRatio = b.fleet.emptyPctPerM && b.fleet.loadedPctPerM ? b.fleet.loadedPctPerM / b.fleet.emptyPctPerM : PARAMS.loadedDrainFactor.value;
  if (b.ownEmpty !== null && b.ownLoaded !== null) return { empty: b.ownEmpty, loaded: b.ownLoaded, source: 'own' };
  if (b.ownEmpty !== null) return { empty: b.ownEmpty, loaded: b.ownEmpty * fleetRatio, source: 'own, loaded estimated' };
  if (b.ownLoaded !== null) return { empty: b.ownLoaded / fleetRatio, loaded: b.ownLoaded, source: 'own, loaded estimated' };
  if (b.fleet.emptyPctPerM !== null && b.fleet.loadedPctPerM !== null) return { empty: b.fleet.emptyPctPerM, loaded: b.fleet.loadedPctPerM, source: 'fleet' };
  return null;
}
