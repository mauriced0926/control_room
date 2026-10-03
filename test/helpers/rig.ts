// A fleet state on this site's hello with a manual clock, plus a telemetry builder. Hand-built
// messages are for single-fault cases only; real data comes from research/fixtures/.
import { ManualClock } from '../../src/clock.ts';
import { FleetState, type FleetEvent, type TruckView } from '../../src/fleet.ts';
import type { Hello } from '../../src/protocol.ts';
import { helloAt, readRecords, type FixtureRecord } from './fixtures.ts';

export const T0 = 1_790_000_000_000;

export function telemetry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'telemetry', vehicle_id: 'HT-01', seq: 1, t_device_ms: T0, state: 'TRAMMING', task: null,
    soc_pct: 60, speed_mps: 3, direction: 'FWD', segment_id: 'SEG-DEC-1', zone_id: 'DECLINE', offset_m: 10,
    payload_kg: 0, faults: [],
    control: { mode: 'AUTO', operator_id: null, deadman: false, last_drive_seq: null, last_drive_sent_ms: null },
    ...over,
  };
}

export interface Rig {
  clock: ManualClock;
  fleet: FleetState;
  events: FleetEvent[];
  send(over?: Record<string, unknown>): void;
  line(text: string): void;
  advance(ms: number): void;
  truck(id?: string): TruckView;
}

export function rig(hello: Hello | null = helloAt(T0)): Rig {
  const clock = new ManualClock(T0);
  const fleet = new FleetState(clock);
  const events: FleetEvent[] = [];
  fleet.subscribe((e) => events.push(e));
  if (hello) fleet.ingest(hello);
  return {
    clock, fleet, events,
    send: (over = {}) => fleet.ingest(telemetry(over)),
    line: (text) => fleet.ingestLine(text),
    advance: (ms) => { clock.advance(ms); fleet.tick(); },
    truck: (id = 'HT-01') => {
      const t = fleet.snapshot().trucks.find((x) => x.vehicleId === id);
      if (!t) throw new Error(`no truck ${id}`);
      return t;
    },
  };
}

// Replays fixture records in arrival order: the clock is set to each record's rx_ms, messages are
// fed as the lines they arrived as, unparseable lines as their raw text. `onRecord` runs after each.
// Records are sorted by rx_ms (stably) first, as a guard: research/trim.py once wrote multi-part
// fixtures part by part, out of arrival order. It now sorts them.
//
// Incremental, for the fixture player (player/): advanceTo() feeds every record up to a moment and
// then moves the clock to it, so the picture ages between records as it would live. Records the
// product never receives ('sent', 'closed_by_peer') only move the clock.
export class Replayer {
  readonly records: FixtureRecord[];
  readonly start: number;
  readonly end: number;
  readonly clock: ManualClock;
  readonly fleet: FleetState;
  readonly events: FleetEvent[] = [];
  readonly #onRecord: ((r: FixtureRecord, f: FleetState, c: ManualClock) => void) | undefined;
  #next = 0;

  // `hello`: the hello to start from. By default this site's, re-timed to the first record with every
  // zone open (helloAt); null for none, when the fixture carries its own.
  constructor(records: FixtureRecord[], opts: { hello?: Hello | null; onRecord?: (r: FixtureRecord, f: FleetState, c: ManualClock) => void } = {}) {
    this.records = records.filter((r) => r.kind !== 'fixture' && typeof r.rx_ms === 'number').sort((a, b) => a.rx_ms! - b.rx_ms!);
    this.start = this.records[0]!.rx_ms!;
    this.end = this.records.at(-1)!.rx_ms!;
    this.clock = new ManualClock(this.start);
    this.fleet = new FleetState(this.clock);
    this.fleet.subscribe((e) => this.events.push(e));
    this.#onRecord = opts.onRecord;
    const hello = opts.hello === undefined ? helloAt(this.start) : opts.hello;
    if (hello) this.fleet.ingest(hello);
  }

  get done(): boolean { return this.#next >= this.records.length; }

  // When the next record arrives, or null at the end.
  nextAt(): number | null { return this.records[this.#next]?.rx_ms ?? null; }

  advanceTo(t: number): void {
    for (let r = this.records[this.#next]; r && r.rx_ms! <= t; r = this.records[++this.#next]) {
      this.clock.advance(Math.max(0, r.rx_ms! - this.clock.now()));
      if (r.kind === 'msg') this.fleet.ingestLine(JSON.stringify(r.m));
      else if (r.kind === 'unparseable') this.fleet.ingestLine(String(r.raw));
      else if (r.kind === 'connected') this.fleet.newConnection();
      this.fleet.tick();
      this.#onRecord?.(r, this.fleet, this.clock);
    }
    if (t > this.clock.now()) {
      this.clock.advance(t - this.clock.now());
      this.fleet.tick();
    }
  }
}

export function replay(records: FixtureRecord[], opts: { hello?: boolean; onRecord?: (r: FixtureRecord, f: FleetState, c: ManualClock) => void } = {}) {
  const r = new Replayer(records, { hello: opts.hello === false ? null : undefined, onRecord: opts.onRecord });
  r.advanceTo(r.end);
  return { clock: r.clock, fleet: r.fleet, events: r.events, start: r.start, end: r.end };
}

export { readRecords };
