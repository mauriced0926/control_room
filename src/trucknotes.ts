// What truck detail shows beyond the current picture (UI.md screen 2): each fault with when and where
// it first appeared (Sam: "which fault, when, and where it is"), and each controller restart.
// Built from fleet snapshots and events as they arrive; kept in memory, so a service restart starts
// the history again (a fault still present then is marked "already present when first seen").
//
// Pure: times are server time, given by the caller.
import type { FleetSnapshot, TruckView } from './fleet.ts';

export interface FaultNote {
  code: string;
  sinceServerMs: number;          // the first report we saw with it
  alreadyPresent: boolean;        // it was there the first time we heard from the truck
  where: { zoneId: string; segmentId: string; offsetM: number; ageMs: number } | null; // last position then
  endedServerMs: number | null;   // the first report without it
}

export interface RestartNote { atServerMs: number; detail: string }

export interface TruckNote {
  faults: FaultNote[];   // newest first
  restarts: RestartNote[]; // newest first
}

const KEEP = 10;

export class TruckNotes {
  readonly #notes = new Map<string, TruckNote>();
  readonly #seen = new Map<string, number>(); // faults report time last looked at, per truck

  restart(vehicleId: string, detail: string, atServerMs: number): void {
    const n = this.#note(vehicleId);
    n.restarts.unshift({ atServerMs, detail });
    n.restarts.length = Math.min(n.restarts.length, KEEP);
  }

  // Looks at each truck's latest faults report; cheap enough to run on every frame.
  observe(snap: FleetSnapshot): void {
    for (const t of snap.trucks) this.#observe(t);
  }

  get(vehicleId: string): TruckNote {
    const n = this.#notes.get(vehicleId);
    return n ? structuredClone(n) : { faults: [], restarts: [] };
  }

  all(): Record<string, TruckNote> {
    return Object.fromEntries([...this.#notes].map(([k, v]) => [k, structuredClone(v)]));
  }

  #observe(t: TruckView): void {
    const f = t.faults;
    if (!f) return;
    const last = this.#seen.get(t.vehicleId);
    if (last === f.atServerMs) return;
    const first = last === undefined;
    this.#seen.set(t.vehicleId, f.atServerMs);
    const n = this.#note(t.vehicleId);
    const open = n.faults.filter((x) => x.endedServerMs === null);
    for (const x of open) if (!f.value.includes(x.code)) x.endedServerMs = f.atServerMs;
    for (const code of f.value) {
      if (open.some((x) => x.code === code)) continue;
      const p = t.position;
      n.faults.unshift({
        code, sinceServerMs: f.atServerMs, alreadyPresent: first, endedServerMs: null,
        where: p ? { zoneId: p.value.zoneId, segmentId: p.value.segmentId, offsetM: p.value.offsetM, ageMs: Math.max(0, f.atServerMs - p.atServerMs) } : null,
      });
    }
    n.faults.length = Math.min(n.faults.length, KEEP);
    if (n.faults.length === 0 && n.restarts.length === 0) this.#notes.delete(t.vehicleId);
  }

  #note(id: string): TruckNote {
    let n = this.#notes.get(id);
    if (!n) { n = { faults: [], restarts: [] }; this.#notes.set(id, n); }
    return n;
  }
}
