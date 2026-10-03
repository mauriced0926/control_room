// Milestone 2's fault injectors (TESTING.md L0.F): which ones are on, which truck, when, and the truth
// log that records what was really wrong, so a test can ask "what was wrong at time t".
//
// Each injector is switched on in FakeConfig.faults. `true` uses the measured rates and ranges in
// fake/behaviour.ts and picks the truck and time from the seed; an object pins the truck or time.
// LIVE_DAY switches on what the live site does every day: one truck per fault class, at random.
//
// Where they act:
//   telemetry faults (frozen, silent, seq reset, fractional SoC, malformed, clock skew): the model's
//     telemetry step, through TelemetryFaults below; the truth keeps moving underneath;
//   radio faults (loss, duplicates, reordering, truncation) and acks (latency, loss): fake/radio.ts,
//     once for the whole site, so every client sees the same stream (guessed: the live site's loss
//     could be per client; one client cannot tell);
//   accepted-then-ignored and queued commands dropped: where the model accepts or applies a command;
//   link drops and the slow reader: the gateway's connections;
//   two zones, cancelled blasts, BAY closing: the blast schedule's probabilities.
import type { Telemetry } from '../src/protocol.ts';
import type { Behaviour } from './behaviour.ts';
import { Rng } from './rng.ts';

export type FaultClass =
  | 'link_drop' | 'lost_ack' | 'accepted_ignored' | 'queued_dropped'
  | 'frozen_moving' | 'frozen_stationary' | 'silent' | 'seq_reset' | 'truncated' | 'fractional_soc'
  | 'malformed' | 'clock_skew' | 'duplicate' | 'late' | 'lost'
  | 'weak_pack' | 'fault' | 'two_zones' | 'cancelled_blast' | 'bay_closing' | 'slow_reader' | 'link_stall';

// One thing that was really wrong. `untilMs` is null while it lasts (to the end of the day, for a
// frozen truck); a one-off event has untilMs equal to atMs.
export interface TruthEntry {
  atMs: number;
  untilMs: number | null;
  vehicle: string | null;
  fault: FaultClass;
  detail: Record<string, unknown>;
}

export class TruthLog {
  readonly #entries: TruthEntry[] = [];

  add(e: TruthEntry): TruthEntry {
    this.#entries.push(e);
    return e;
  }

  event(atMs: number, vehicle: string | null, fault: FaultClass, detail: Record<string, unknown> = {}): void {
    this.add({ atMs, untilMs: atMs, vehicle, fault, detail });
  }

  start(atMs: number, vehicle: string | null, fault: FaultClass, detail: Record<string, unknown> = {}): TruthEntry {
    return this.add({ atMs, untilMs: null, vehicle, fault, detail });
  }

  // Copies: a test cannot rewrite the truth.
  entries(filter: { vehicle?: string; fault?: FaultClass } = {}): TruthEntry[] {
    return this.#entries
      .filter((e) => (filter.vehicle === undefined || e.vehicle === filter.vehicle) && (filter.fault === undefined || e.fault === filter.fault))
      .map((e) => structuredClone(e));
  }

  // What was wrong at time t: every interval covering t, and every one-off event at exactly t.
  activeAt(t: number, filter: { vehicle?: string; fault?: FaultClass } = {}): TruthEntry[] {
    return this.entries(filter).filter((e) => e.atMs <= t && (e.untilMs === null || t <= e.untilMs));
  }
}

// A per-truck injector's target. Either part left out is drawn from the seed and the measured range.
// `forMs` pins the length of the first silence (silent truck only).
export interface TruckTarget { vehicle?: string; atMs?: number; forMs?: number }

// Which commands a command fault applies to: by order received (n from 1), id, vehicle or action.
export type CommandMatch = (c: { n: number; command_id: string; vehicle_id: string; action: string }) => boolean;

export interface Faults {
  loss?: boolean;
  duplicates?: boolean;
  reordering?: boolean;
  truncation?: boolean;
  ackLatency?: boolean;
  lostAcks?: boolean | CommandMatch;
  ignoredCommands?: boolean | CommandMatch;
  queuedDrops?: boolean;       // a command queued behind LOADING / DUMPING / CHARGING never runs (re-probe Q1)
  linkDrops?: boolean | Array<{ atMs: number; durationMs: number }>;
  // The connection stays open but nothing arrives, heartbeats included. Not seen live: it was built
  // from a misreading of loaded-reverse-into-silence, which was a link drop (the fixture had left out
  // the connection events). Kept as a transport failure worth testing. Explicit times only.
  linkStalls?: Array<{ atMs: number; durationMs: number }>;
  frozenMoving?: boolean | TruckTarget;
  frozenStationary?: boolean | TruckTarget; // the undetectable case (L4.R2c); not part of a live day
  silent?: boolean | TruckTarget;
  seqReset?: boolean | TruckTarget;
  fractionalSoc?: boolean | TruckTarget;
  malformed?: boolean | TruckTarget;
  clockSkew?: boolean | TruckTarget;
  weakPack?: boolean | TruckTarget;
  hydPressureLow?: boolean | TruckTarget;
  batteryDepleted?: boolean | TruckTarget; // on its own; on a live day it comes from the weak pack
  bayClosing?: boolean;                    // open question 5: BAY can be blasted
}

// The live catalogue (research/README.md, CONTEXT.md "What the live site showed"): every day, one
// truck each with a frozen message, silences, a seq reset, fractional SoC, malformed fields, a
// skewed clock, a weak pack and a hydraulic fault; the radio's loss, duplicates, reordering and
// truncation; slow and lost acks, ignored commands and dropped queued ones; link drops; and the
// blast schedule's cancellations and second
// zones (on by default in the schedule).
export const LIVE_DAY: Readonly<Faults> = Object.freeze({
  loss: true, duplicates: true, reordering: true, truncation: true,
  ackLatency: true, lostAcks: true, ignoredCommands: true, queuedDrops: true, linkDrops: true,
  frozenMoving: true, silent: true, seqReset: true, fractionalSoc: true, malformed: true, clockSkew: true,
  weakPack: true, hydPressureLow: true,
});

// The per-truck classes in the order trucks are dealt to them. Distinct trucks while there are
// enough, as on every live day; on a smaller site some trucks carry two.
// Fractional SoC is dealt last of the live classes: on a site with fewer trucks than classes it is
// the one that shares a truck, and it combines harmlessly with any other. The two classes that are
// not part of a live day come after it.
const TRUCK_CLASSES = [
  'frozenMoving', 'silent', 'seqReset', 'malformed', 'clockSkew', 'weakPack', 'hydPressureLow', 'fractionalSoc',
  'frozenStationary', 'batteryDepleted',
] as const;
export type TruckClass = (typeof TRUCK_CLASSES)[number];

export interface TruckPlan { vehicle: string; atMs: number; forMs?: number }

// Resolve which truck and when, for every per-truck injector that is on. Its own random stream, so
// switching one injector on never moves another's truck or time.
export function planTrucks(faults: Faults, vehicles: readonly string[], b: Behaviour, seed: number): Partial<Record<TruckClass, TruckPlan>> {
  const rng = new Rng(seed).fork('fault-trucks');
  const order = [...vehicles];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const range: Record<TruckClass, [number, number]> = {
    frozenMoving: [b.frozenFromMinMs, b.frozenFromMaxMs], frozenStationary: [b.frozenFromMinMs, b.frozenFromMaxMs],
    silent: [b.silentFirstMinMs, b.silentFirstMaxMs], seqReset: [b.seqResetMinMs, b.seqResetMaxMs],
    fractionalSoc: [0, 0], malformed: [0, 0], clockSkew: [0, 0], weakPack: [0, 0],
    hydPressureLow: [b.hydFaultMinMs, b.hydFaultMaxMs], batteryDepleted: [b.depletedMinMs, b.depletedMaxMs],
  };
  const pinned = new Set(TRUCK_CLASSES.map((c) => faults[c]).filter((f): f is TruckTarget => typeof f === 'object' && !!f.vehicle).map((f) => f.vehicle!));
  const free = order.filter((v) => !pinned.has(v));
  let next = 0;
  const plan: Partial<Record<TruckClass, TruckPlan>> = {};
  for (const c of TRUCK_CLASSES) {
    const f = faults[c];
    const draw = rng.uniform(range[c][0], range[c][1]); // drawn whether on or not: streams stay aligned
    const deal = free.length > 0 ? free[next++ % free.length]! : order[next++ % order.length]!;
    if (!f) continue;
    const target = typeof f === 'object' ? f : {};
    if (target.vehicle !== undefined && !vehicles.includes(target.vehicle)) throw new Error(`fault ${c}: no truck ${target.vehicle}`);
    plan[c] = { vehicle: target.vehicle ?? deal, atMs: target.atMs ?? Math.round(draw), ...(target.forMs !== undefined ? { forMs: target.forMs } : {}) };
  }
  return plan;
}

// ---- telemetry faults, applied by the model to each message it sends ----

export interface TelemetryTruth { speedMps: number; state: string; positionM: number }

const MALFORMED_KINDS = ['lowercase_state', 'speed_null', 'soc_missing', 'offset_string'] as const;

// Per-truck telemetry faults. The model asks before each message whether the truck is silent (then
// it sends nothing and its seq does not advance, as live), and passes each message through shape().
export class TelemetryFaults {
  readonly #b: Behaviour;
  readonly #log: TruthLog;
  readonly #rng: Rng;
  readonly #startMs: number;
  readonly #plan: Partial<Record<TruckClass, TruckPlan>>;
  #frozen = new Map<string, { body: Record<string, unknown>; entry: TruthEntry }>();
  #silence: { vehicle: string; from: number; until: number; entry: TruthEntry | null } | null = null;
  #seqResetDone = false;
  #fracLogged = false;
  #malformedLogged = false;

  constructor(plan: Partial<Record<TruckClass, TruckPlan>>, b: Behaviour, log: TruthLog, seed: number, startMs: number) {
    this.#plan = plan;
    this.#b = b;
    this.#log = log;
    this.#rng = new Rng(seed).fork('telemetry-faults');
    this.#startMs = startMs;
    const s = plan.silent;
    if (s) this.#silence = { vehicle: s.vehicle, from: startMs + s.atMs, until: startMs + s.atMs + (s.forMs ?? this.#silentFor()), entry: null };
  }

  #silentFor(): number { return Math.round(this.#rng.uniform(this.#b.silentMinMs, this.#b.silentMaxMs)); }

  // True while the truck sends nothing. Silences repeat: talk, then silent again, all day.
  silent(vehicle: string, now: number): boolean {
    const s = this.#silence;
    if (!s || s.vehicle !== vehicle) return false;
    if (now >= s.until) {
      if (s.entry) s.entry.untilMs = s.until;
      s.entry = null;
      s.from = s.until + Math.round(this.#rng.uniform(this.#b.talkMinMs, this.#b.talkMaxMs));
      s.until = s.from + this.#silentFor();
    }
    if (now < s.from) return false;
    if (!s.entry) s.entry = this.#log.start(s.from, vehicle, 'silent', { plannedUntilMs: s.until });
    return true;
  }

  // The message as sent. `seq` and `t_device_ms` are already set by the model; a seq reset returns 1.
  shape(m: Telemetry, truth: TelemetryTruth, now: number): Record<string, unknown> {
    const v = m.vehicle_id;
    const p = this.#plan;
    let out: Record<string, unknown> = m as unknown as Record<string, unknown>;

    if (p.seqReset?.vehicle === v && !this.#seqResetDone && now >= this.#startMs + p.seqReset.atMs) {
      this.#seqResetDone = true;
      this.#log.event(now, v, 'seq_reset', { fromSeq: m.seq - 1 });
      out = { ...out, seq: 1 };
    }

    for (const cls of ['frozenMoving', 'frozenStationary'] as const) {
      const f = p[cls];
      if (f?.vehicle !== v) continue;
      const fz = this.#frozen.get(cls);
      if (fz) {
        // The whole body repeats; only seq and the device clock advance (fixture frozen-truck).
        out = { ...fz.body, seq: out.seq, t_device_ms: out.t_device_ms };
        continue;
      }
      if (now < this.#startMs + f.atMs) continue;
      const moving = truth.speedMps > 0.5 && (truth.state === 'TRAMMING' || truth.state === 'MANUAL');
      const still = truth.speedMps === 0 && ['LOADING', 'DUMPING', 'HOLDING', 'IDLE', 'CHARGING'].includes(truth.state);
      if (cls === 'frozenMoving' ? moving : still) {
        const entry = this.#log.start(now, v, cls === 'frozenMoving' ? 'frozen_moving' : 'frozen_stationary', {
          reported: { state: m.state, speed_mps: m.speed_mps, segment_id: m.segment_id, offset_m: m.offset_m }, truePositionM: truth.positionM,
        });
        const { seq: _s, t_device_ms: _t, ...body } = out;
        this.#frozen.set(cls, { body, entry });
      }
    }

    if (p.fractionalSoc?.vehicle === v && typeof out.soc_pct === 'number') {
      if (!this.#fracLogged) { this.#fracLogged = true; this.#log.start(now, v, 'fractional_soc'); }
      const k = 10 ** this.#b.fractionDigits;
      out = { ...out, soc_pct: Math.round((out.soc_pct as number) / 100 * k) / k };
    }

    if (p.malformed?.vehicle === v) {
      if (!this.#malformedLogged) { this.#malformedLogged = true; this.#log.start(now, v, 'malformed'); }
      const hits = MALFORMED_KINDS.filter(() => this.#rng.chance(this.#b.malformedProbability));
      if (hits.length > 0) {
        out = { ...out };
        // Shapes as seen live: 'tramming', null, absent, '59.95' (fixture accepted-then-ignored-resume, run captures)
        if (hits.includes('lowercase_state') && typeof out.state === 'string') out.state = (out.state as string).toLowerCase();
        if (hits.includes('speed_null')) out.speed_mps = null;
        if (hits.includes('soc_missing')) delete out.soc_pct;
        if (hits.includes('offset_string') && typeof out.offset_m === 'number') out.offset_m = pyFloat(out.offset_m as number);
        this.#log.event(now, v, 'malformed', { seq: out.seq, kinds: hits });
      }
    }
    return out;
  }
}

// A float as Python's str() writes it: 59.95, 20.5, 59.0.
export function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}
