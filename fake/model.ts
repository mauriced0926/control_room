// The fake site's truth (TESTING.md L0.M): trucks on the loop, the duty cycle, supervisory
// commands with their delay and queuing, leases and the deadman, e-stops, faults and blasts.
//
// It knows no site. Geometry comes from SiteConfig through src/site.ts, and the places where trucks
// load, dump and charge come from segment kinds ('load', 'dump', 'bay'), as PROTOCOL.md §3 names
// them. It never reads the wall clock: one tick timer on the injected Clock drives everything, so
// a ManualClock runs a day in milliseconds and the same seed and inputs replay byte for byte.
//
// What is sent is built from this truth. Telemetry faults (fake/faults.ts) shape each message on its
// way out and radio faults (fake/radio.ts) sit between the gateway and its clients; the truth stays
// here, and everything that was really wrong goes in the truth log.
import type { Clock, TimerHandle } from '../src/clock.ts';
import type {
  Action, CommandAck, GatewayMessage, Hello, LeaseEvent, RejectReason, RouteSegment, Task, Telemetry,
  VehicleState, ZoneState,
} from '../src/protocol.ts';
import { buildSite, type Segment, type Site, type Zone } from '../src/site.ts';
import type { Behaviour } from './behaviour.ts';
import { TruthLog, type TelemetryFaults } from './faults.ts';
import { Rng } from './rng.ts';

export interface SiteConfig {
  site_id: string;
  vehicles: string[];
  route: RouteSegment[];
  loop_length_m: number;
  noticeMs: number; // CLOSING to effective_at for every blast at this site
}

export interface TruckInit {
  vehicle_id: string;
  positionM: number;
  loaded?: boolean;
  socPct?: number;
  state?: 'TRAMMING' | 'HOLDING' | 'IDLE';
  drainFactor?: number; // a weak pack drains this many times faster (5x measured live)
}

// A blast at a fixed time, relative to the model's start.
export interface BlastSpec {
  zoneId: string;
  atMs: number;
  closedForMs: number;
  cancelAfterMs?: number; // CANCELLED this long after CLOSING, instead of closing
  noticeMs?: number;      // defaults to the site's
}

export type Blasts = 'random' | 'none' | BlastSpec[];

export interface ModelOptions {
  seed: number;
  site: SiteConfig;
  behaviour: Behaviour;
  blasts: Blasts;
  trucks: TruckInit[];
  log?: TruthLog;
}

export type AckResult = Pick<CommandAck, 'status' | 'reason' | 'holder' | 'lease_id' | 'lease_idle_timeout_ms' | 'deadman_ms'>;

export interface ModelCommand {
  command_id: string;
  vehicle_id: string;
  action: Action;
  operator_id: string;
  force?: unknown;
  lease_id?: unknown;
  ignored?: boolean; // ACCEPTED-then-ignored injector: accept it, then never carry it out
}

type Supervisory = 'HOLD' | 'RESUME' | 'RETURN_TO_BAY' | 'EXIT_ZONE';

// What is true, for tests: never sent, always a copy.
export interface TruckTruth {
  vehicleId: string;
  positionM: number;
  segmentId: string;
  zoneId: string;
  offsetM: number;
  state: VehicleState;
  task: Task | null;
  mode: 'AUTO' | 'MANUAL';
  speedMps: number;
  direction: 'FWD' | 'REV';
  socPct: number;
  loaded: boolean;
  faults: string[];
  leaseId: string | null;
  operatorId: string | null;
  deadman: boolean;
  throttle: number;
  queued: Supervisory | null;   // waiting behind LOADING / DUMPING / CHARGING
  pending: Supervisory[];       // accepted, not yet in effect (the 1-6 s delay)
  drainFactor: number;
}

interface Effect { action: Supervisory; zoneId: string | null; due: number }
interface Work { kind: 'LOADING' | 'DUMPING' | 'CHARGING'; until: number | null; then: 'TRAMMING' | 'IDLE' }
interface Move { dir: 1 | -1; remaining: number; target: number }
interface Lease { id: string; operator: string; lastFresh: number }

interface Truck {
  id: string;
  pos: number;
  speed: number;
  dir: 1 | -1;
  state: VehicleState;
  task: Task | null;
  soc: number;
  loaded: boolean;
  faults: string[];
  drainFactor: number;
  work: Work | null;
  move: Move | null;
  queued: Effect | null;
  pending: Effect[];
  lease: Lease | null;
  throttle: number;
  deadman: boolean;
  lastDriveSeq: number | null;
  lastDriveSentMs: number | null;
  seq: number;
  phase: number;
  deviceOffsetMs: number; // the vehicle clock's error; 0 until milestone 2's skew injector
}

interface Blast {
  zoneId: string;
  closingAt: number;
  effectiveAt: number;
  reopenAt: number;
  cancelAt: number | null;
  stage: 'scheduled' | 'closing' | 'closed' | 'done';
}

const EPS = 1e-9;
const WORK_STATES: readonly VehicleState[] = ['LOADING', 'DUMPING', 'CHARGING'];
const isWork = (s: VehicleState) => WORK_STATES.includes(s);
const round2 = (x: number) => Math.round(x * 100) / 100;

export class SiteModel {
  readonly site: Site;
  readonly startMs: number;
  readonly #clock: Clock;
  readonly #emit: (m: GatewayMessage) => void;
  readonly #b: Behaviour;
  readonly #config: SiteConfig;
  readonly #trucks: Truck[];
  readonly #byId: Map<string, Truck>;
  readonly #zones: Map<string, ZoneState>;
  readonly #segments: readonly Segment[];
  readonly #points: { LOADING: number[]; DUMPING: number[]; CHARGING: number[] };
  readonly #rngCommands: Rng;
  readonly #rngBlasts: Rng;
  readonly #rngLeases: Rng;
  readonly #rngQueue: Rng;
  readonly #log: TruthLog;
  #telemetryFaults: TelemetryFaults | null = null;
  readonly #randomBlasts: boolean;
  readonly #telemetryEvery: number;
  #blasts: Blast[] = [];
  #nextRandomBlastAt = Infinity;
  #leaseCount = 0;
  #driveRejectedAt = new Map<string, number>();
  #timer: TimerHandle | null = null;
  #lastTick: number;
  #ticks = 0;
  #nextHeartbeat: number;

  constructor(clock: Clock, emit: (m: GatewayMessage) => void, opts: ModelOptions) {
    this.#clock = clock;
    this.#emit = emit;
    this.#b = opts.behaviour;
    this.#config = opts.site;
    this.startMs = clock.now();
    this.#lastTick = this.startMs;
    this.#nextHeartbeat = this.startMs + this.#b.heartbeatPeriodMs;
    this.#telemetryEvery = Math.max(1, Math.round(this.#b.telemetryPeriodMs / this.#b.tickMs));

    const { site, issues } = buildSite({ ...this.#helloShape(), zones: [], leases: [] });
    if (issues.length > 0) throw new Error(`site config does not add up: ${issues.join('; ')}`);
    this.site = site;
    this.#segments = site.segments;
    const pointsOf = (kind: string) =>
      this.#segments.filter((s) => s.kind === kind).map((s) => s.startM + s.lengthM - this.#b.workStopBeforeEndM);
    this.#points = { LOADING: pointsOf('load'), DUMPING: pointsOf('dump'), CHARGING: pointsOf('bay') };
    this.#zones = new Map(site.zones.map((z) => [z.zoneId, { zone_id: z.zoneId, status: 'OPEN', effective_at_ms: null, reason: null }]));

    const root = new Rng(opts.seed);
    const rngInit = root.fork('init');
    this.#rngCommands = root.fork('commands');
    this.#rngBlasts = root.fork('blasts');
    this.#rngLeases = root.fork('leases');
    this.#rngQueue = new Rng(opts.seed).fork('queue-drops'); // its own root: the forks above keep their streams
    this.#log = opts.log ?? new TruthLog();

    const given = new Map(opts.trucks.map((t) => [t.vehicle_id, t]));
    for (const id of given.keys()) if (!site.vehicles.includes(id)) throw new Error(`truck ${id} is not on the site's roster`);
    const n = site.vehicles.length;
    this.#trucks = site.vehicles.map((id, i) => {
      // Default placement: spread round the loop with jitter, loaded between the load and dump points.
      const jitter = rngInit.uniform(-0.2, 0.2);
      const socDefault = rngInit.uniform(35, 95);
      const init = given.get(id);
      const pos = this.#mod(init ? init.positionM : (i + 0.5 + jitter) * (site.loopLengthM / n));
      return {
        id, pos, speed: 0, dir: 1, state: init?.state ?? 'TRAMMING', task: null,
        soc: init?.socPct ?? socDefault, loaded: init?.loaded ?? this.#loadedAt(pos), faults: [],
        drainFactor: init?.drainFactor ?? 1, work: null, move: null, queued: null, pending: [],
        lease: null, throttle: 0, deadman: false, lastDriveSeq: null, lastDriveSentMs: null,
        seq: 0, phase: i % this.#telemetryEvery, deviceOffsetMs: 0,
      } satisfies Truck;
    });
    this.#byId = new Map(this.#trucks.map((t) => [t.id, t]));

    this.#randomBlasts = opts.blasts === 'random';
    if (opts.blasts === 'random') {
      this.#nextRandomBlastAt = this.startMs + this.#onTick(this.#rngBlasts.uniform(this.#b.firstBlastMinMs, this.#b.firstBlastMaxMs));
    } else if (Array.isArray(opts.blasts)) {
      for (const s of opts.blasts) {
        if (!this.#zones.has(s.zoneId)) throw new Error(`blast zone ${s.zoneId} is not on the site`);
        const closingAt = this.startMs + s.atMs;
        const effectiveAt = closingAt + (s.noticeMs ?? this.#config.noticeMs);
        this.#logBlast(s.zoneId, closingAt, s.cancelAfterMs !== undefined);
        this.#blasts.push({
          zoneId: s.zoneId, closingAt, effectiveAt, reopenAt: effectiveAt + s.closedForMs,
          cancelAt: s.cancelAfterMs === undefined ? null : closingAt + s.cancelAfterMs, stage: 'scheduled',
        });
      }
    }
  }

  // ---- lifecycle ----

  start(): void {
    if (this.#timer) return;
    this.#timer = this.#clock.setTimeout(this.#tick, this.#b.tickMs);
  }

  stop(): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  // ---- what a client sees on connecting ----

  hello(email: string): Hello {
    return {
      ...this.#helloShape(),
      zones: [...this.#zones.values()].map((z) => ({ ...z })),
      leases: this.#trucks.filter((t) => t.lease).map((t) => ({ vehicle_id: t.id, operator_id: t.lease!.operator })),
      site: { name: email },
    };
  }

  #helloShape(): Omit<Hello, 'zones' | 'leases' | 'site'> {
    const c = this.#config;
    return {
      type: 'hello', protocol: '3.0', site_id: c.site_id, server_time_ms: this.#clock.now(), vehicles: [...c.vehicles],
      route: c.route.map((r) => ({ ...r })), loop_length_m: c.loop_length_m,
    };
  }

  // ---- truth, for tests ----

  hasVehicle(id: string): boolean {
    return this.#byId.has(id);
  }

  truth(id: string): TruckTruth {
    const t = this.#byId.get(id);
    if (!t) throw new Error(`no truck ${id}`);
    const { seg, offset } = this.#locate(t.pos);
    return {
      vehicleId: t.id, positionM: t.pos, segmentId: seg.segmentId, zoneId: seg.zoneId, offsetM: offset,
      state: t.state, task: t.task, mode: t.lease ? 'MANUAL' : 'AUTO', speedMps: t.speed, direction: this.#direction(t),
      socPct: t.soc, loaded: t.loaded, faults: [...t.faults], leaseId: t.lease?.id ?? null,
      operatorId: t.lease?.operator ?? null, deadman: t.deadman, throttle: t.throttle,
      queued: t.queued?.action ?? null, pending: t.pending.map((e) => e.action), drainFactor: t.drainFactor,
    };
  }

  truthAll(): TruckTruth[] {
    return this.#trucks.map((t) => this.truth(t.id));
  }

  zone(id: string): ZoneState {
    const z = this.#zones.get(id);
    if (!z) throw new Error(`no zone ${id}`);
    return { ...z };
  }

  // ---- faults (the model's side; which truck and when is milestone 2's injector) ----

  injectFault(id: string, code: string): void {
    const t = this.#byId.get(id);
    if (!t) throw new Error(`no truck ${id}`);
    this.#fault(t, code, this.#clock.now());
  }

  #fault(t: Truck, code: string, now: number): void {
    if (!t.faults.includes(code)) {
      t.faults.push(code);
      this.#log.event(now, t.id, 'fault', { code, positionM: t.pos, zoneId: this.site.zoneAt(t.pos)?.zoneId ?? null, state: t.state });
    }
    if (t.state === 'ESTOPPED') return;
    if (t.lease) {
      if (this.#limpOk(t)) return; // §6.6: keeps driving, reports MANUAL with its faults
      this.#emitLease(t, 'REVOKED', t.lease, now, { reason: 'FAULT' });
      this.#endLease(t);
    }
    this.#stopAll(t);
    t.state = 'FAULT';
  }

  // BATTERY_DEPLETED on its own: the pack is empty, the truck stops where it is.
  deplete(id: string): void {
    const t = this.#byId.get(id);
    if (!t) throw new Error(`no truck ${id}`);
    t.soc = 0;
    this.#fault(t, this.#b.depletedFault, this.#clock.now());
  }

  // ---- milestone 2's hooks for the fault injectors ----

  setTelemetryFaults(f: TelemetryFaults): void {
    this.#telemetryFaults = f;
  }

  // The vehicle controller's clock error (clock skew injector; small offsets for every truck).
  setDeviceOffset(id: string, ms: number): void {
    const t = this.#byId.get(id);
    if (!t) throw new Error(`no truck ${id}`);
    t.deviceOffsetMs = ms;
  }

  // A weak pack: drains `factor` times faster, and starts with just enough charge to die loaded,
  // `fraction` of the way from the load point to the dump point, as both live weak packs did (in the
  // incline). Charging is ignored in the sum; a pack this weak is still above the charge threshold
  // when it passes the bay. Returns where it should die.
  weakPack(id: string, factor: number, fraction: number): { socPct: number; diesAtM: number } {
    const t = this.#byId.get(id);
    if (!t) throw new Error(`no truck ${id}`);
    const load = this.#points.LOADING[0], dump = this.#points.DUMPING[0];
    t.drainFactor = factor;
    if (load === undefined || dump === undefined) return { socPct: t.soc, diesAtM: NaN };
    const stretch = this.#mod(dump - load);
    const target = this.#mod(load + fraction * stretch);
    const empty = (m: number) => m * (this.#b.drainEmptyPctPerKm / 1000) * factor;
    const loaded = (m: number) => m * (this.#b.drainLoadedPctPerKm / 1000) * factor;
    const toLoad = this.#mod(load - t.pos), toTarget = this.#mod(target - t.pos), toDump = this.#mod(dump - t.pos);
    let need: number;
    if (!t.loaded) need = empty(toLoad) + loaded(fraction * stretch);
    else if (toTarget <= toDump) need = loaded(toTarget);
    else need = loaded(toDump) + empty(this.#mod(load - dump)) + loaded(fraction * stretch);
    t.soc = Math.min(100, need);
    this.#log.start(this.startMs, id, 'weak_pack', { factor, startSocPct: t.soc, diesAtM: target });
    return { socPct: t.soc, diesAtM: target };
  }

  #limpOk(t: Truck): boolean {
    return t.faults.every((f) => this.#b.limpHomeFaults.includes(f));
  }

  // ---- commands (already validated by the gateway: id, operator, vehicle, action) ----

  command(c: ModelCommand): AckResult {
    const t = this.#byId.get(c.vehicle_id);
    if (!t) return reject('UNKNOWN_VEHICLE');
    const now = this.#clock.now();

    if (c.action === 'ESTOP') {
      this.#estop(t, c.operator_id, now);
      return ACCEPTED;
    }
    if (t.state === 'ESTOPPED') {
      if (c.action !== 'CLEAR_ESTOP') return reject('ESTOP_ACTIVE');
      t.state = t.faults.length > 0 ? 'FAULT' : 'HOLDING';
      return ACCEPTED;
    }
    if (t.faults.length > 0 && !(this.#limpOk(t) && (c.action === 'TAKE_CONTROL' || c.action === 'RELEASE_CONTROL'))) {
      return reject('INTERLOCK_ACTIVE');
    }
    switch (c.action) {
      case 'CLEAR_ESTOP': return reject('INVALID_STATE');
      case 'TAKE_CONTROL': return this.#takeControl(t, c.operator_id, c.force === true, now);
      case 'RELEASE_CONTROL': return this.#release(t, c.lease_id, now);
      default: break;
    }
    if (t.lease) return reject('LEASE_HELD', { holder: t.lease.operator });
    return this.#supervisory(t, c.action, now, c.ignored === true ? c.command_id : null);
  }

  // `ignoredId` set: the ACCEPTED-then-ignored injector. The command is accepted exactly as it would
  // be, and then nothing happens (fixture accepted-then-ignored-resume).
  #supervisory(t: Truck, action: Supervisory, now: number, ignoredId: string | null): AckResult {
    const ignore = (): AckResult => {
      this.#log.event(now, t.id, 'accepted_ignored', { command_id: ignoredId, action, state: t.state });
      return ACCEPTED;
    };
    if (action === 'RESUME') {
      // §5: RESUME cancels a queued command instead, at once (the controller has it in its queue).
      if (t.queued) { if (ignoredId !== null) return ignore(); t.queued = null; return ACCEPTED; }
      if (t.state === 'HOLDING' || t.state === 'IDLE') {
        if (ignoredId !== null) return ignore();
        this.#schedule(t, { action, zoneId: null }, now);
        return ACCEPTED;
      }
      return reject('INVALID_STATE');
    }
    let zoneId: string | null = null;
    if (action === 'EXIT_ZONE') {
      const z = this.site.zoneAt(t.pos);
      if (!z || z.kinds.includes('bay')) return reject('INVALID_STATE');
      zoneId = z.zoneId; // §5: the zone it was in when the command was accepted
    }
    if (action === 'RETURN_TO_BAY' && this.#points.CHARGING.length === 0) return reject('INVALID_STATE');
    if (ignoredId !== null) return ignore();
    if (isWork(t.state)) {
      t.queued = { action, zoneId, due: now }; // one at a time: a newer one replaces the older
      return ACCEPTED;
    }
    this.#schedule(t, { action, zoneId }, now);
    return ACCEPTED;
  }

  // Supervisory commands take effect 1-6 s after acceptance, in the order they were accepted.
  #schedule(t: Truck, e: Omit<Effect, 'due'>, now: number): void {
    const delay = Math.round(this.#rngCommands.uniform(this.#b.commandDelayMinMs, this.#b.commandDelayMaxMs));
    const due = Math.max(now + delay, t.pending.at(-1)?.due ?? 0);
    t.pending.push({ ...e, due });
  }

  #apply(t: Truck, e: Effect, now: number): void {
    if (t.state === 'MANUAL' || t.state === 'ESTOPPED' || t.state === 'FAULT') return;
    if (isWork(t.state)) {
      if (e.action !== 'RESUME') t.queued = e;
      return;
    }
    switch (e.action) {
      case 'HOLD':
        this.#hold(t);
        return;
      case 'RESUME':
        if (t.state === 'HOLDING' || t.state === 'IDLE') { t.state = 'TRAMMING'; t.task = null; t.move = null; }
        return;
      case 'EXIT_ZONE': {
        const z = this.site.zoneAt(t.pos);
        if (!z || z.zoneId !== e.zoneId) { this.#hold(t); return; } // already left: just hold
        t.state = 'TRAMMING';
        t.task = 'EXIT_ZONE';
        t.move = this.#exitMove(t.pos, z);
        return;
      }
      case 'RETURN_TO_BAY':
        t.state = 'TRAMMING';
        t.task = 'RETURN_TO_BAY';
        t.move = this.#bayMove(t.pos);
        if (t.move.remaining <= EPS) this.#arrive(t);
        return;
    }
  }

  #hold(t: Truck): void {
    t.state = 'HOLDING';
    t.task = null;
    t.move = null;
    t.speed = 0;
    t.dir = 1;
  }

  // Nearest boundary of the zone, forward or reverse, to stop a little outside it.
  #exitMove(pos: number, z: Zone): Move {
    const stop = this.#b.exitStopOutsideM;
    for (const r of z.ranges) {
      const back = this.#mod(pos - r.startM);
      if (back >= r.lengthM) continue;
      const fwd = r.lengthM - back;
      return fwd <= back
        ? { dir: 1, remaining: fwd + stop, target: this.#mod(pos + fwd + stop) }
        : { dir: -1, remaining: back + stop, target: this.#mod(pos - back - stop) };
    }
    return { dir: 1, remaining: 0, target: pos };
  }

  // To the charging point at the end of the nearest bay segment, by the shorter direction.
  #bayMove(pos: number): Move {
    let best: Move | null = null;
    for (const p of this.#points.CHARGING) {
      const fwd = this.#mod(p - pos), rev = this.#mod(pos - p);
      const m: Move = rev < fwd ? { dir: -1, remaining: rev, target: p } : { dir: 1, remaining: fwd, target: p };
      if (!best || m.remaining < best.remaining) best = m;
    }
    return best!;
  }

  // ---- leases (§6) ----

  #takeControl(t: Truck, operator: string, force: boolean, now: number): AckResult {
    if (t.lease) {
      if (t.lease.operator === operator) return this.#leaseAck(t.lease); // §6.5: the existing lease
      if (!force) return reject('LEASE_HELD', { holder: t.lease.operator });
      this.#emitLease(t, 'REVOKED', t.lease, now, { reason: 'FORCED_TAKEOVER', by_operator: operator });
      t.lease = null;
    }
    const lease: Lease = { id: `L-${String(++this.#leaseCount).padStart(5, '0')}-${this.#rngLeases.hex(4)}`, operator, lastFresh: now };
    this.#stopAll(t); // interrupts loading, dumping or charging, and drops queued and pending commands
    t.lease = lease;
    t.state = 'MANUAL';
    t.throttle = 0;
    t.deadman = false;
    t.lastDriveSeq = 0; // as seen live: 0 after the grant, before any drive message
    t.lastDriveSentMs = null;
    this.#emitLease(t, 'GRANTED', lease, now, { forced: force });
    return this.#leaseAck(lease);
  }

  #leaseAck(lease: Lease): AckResult {
    return { status: 'ACCEPTED', lease_id: lease.id, lease_idle_timeout_ms: this.#b.leaseIdleTimeoutMs, deadman_ms: this.#b.deadmanMs };
  }

  #release(t: Truck, leaseId: unknown, now: number): AckResult {
    if (!t.lease || leaseId !== t.lease.id) return reject('NOT_LEASE_HOLDER');
    this.#emitLease(t, 'RELEASED', t.lease, now, {});
    this.#endLease(t);
    return ACCEPTED;
  }

  #endLease(t: Truck): void {
    t.lease = null;
    t.throttle = 0;
    t.deadman = false;
    t.lastDriveSeq = null;
    t.lastDriveSentMs = null;
    t.speed = 0;
    t.dir = 1;
    t.state = t.faults.length > 0 ? 'FAULT' : 'HOLDING'; // §6.4, §6.6: holds, or back to FAULT
  }

  #estop(t: Truck, operator: string, now: number): void {
    if (t.lease) {
      this.#emitLease(t, 'REVOKED', t.lease, now, { reason: 'ESTOP', by_operator: operator });
      this.#endLease(t);
    }
    this.#stopAll(t);
    t.state = 'ESTOPPED';
  }

  #emitLease(t: Truck, event: LeaseEvent['event'], lease: Lease, now: number, extra: Partial<LeaseEvent>): void {
    this.#emit({
      type: 'lease_event', vehicle_id: t.id, event, lease_id: lease.id, operator_id: lease.operator,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra.by_operator !== undefined ? { by_operator: extra.by_operator } : {}),
      server_time_ms: now,
      ...(extra.forced !== undefined ? { forced: extra.forced } : {}),
    });
  }

  drive(msg: Record<string, unknown>): void {
    const now = this.#clock.now();
    const vehicle = typeof msg.vehicle_id === 'string' ? msg.vehicle_id : String(msg.vehicle_id);
    const leaseId = typeof msg.lease_id === 'string' ? msg.lease_id : null;
    const t = this.#byId.get(vehicle);
    if (!t) return this.#driveRejected(vehicle, leaseId, 'UNKNOWN_VEHICLE', now);
    if (!t.lease || leaseId !== t.lease.id) return this.#driveRejected(vehicle, leaseId, 'NO_ACTIVE_LEASE', now);
    const throttle = msg.throttle;
    if (typeof throttle !== 'number' || !Number.isFinite(throttle) || throttle < -1 || throttle > 1) {
      return this.#driveRejected(vehicle, leaseId, 'BAD_THROTTLE', now);
    }
    const seq = msg.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return this.#driveRejected(vehicle, leaseId, 'BAD_SEQ', now);
    if (seq <= (t.lastDriveSeq ?? 0)) return; // §6.2: not higher than the last applied: discarded
    t.throttle = throttle;
    t.lastDriveSeq = seq;
    t.lastDriveSentMs = typeof msg.sent_ms === 'number' ? msg.sent_ms : null;
    t.lease.lastFresh = now;
    t.deadman = false;
  }

  #driveRejected(vehicle: string, leaseId: string | null, reason: 'NO_ACTIVE_LEASE' | 'BAD_THROTTLE' | 'BAD_SEQ' | 'UNKNOWN_VEHICLE', now: number): void {
    const key = `${vehicle}\u0000${reason}`;
    const last = this.#driveRejectedAt.get(key);
    if (last !== undefined && now - last < this.#b.driveRejectIntervalMs) return;
    this.#driveRejectedAt.set(key, now);
    this.#emit({ type: 'drive_rejected', vehicle_id: vehicle, lease_id: leaseId as string, reason, server_time_ms: now });
  }

  // ---- the tick ----

  #tick = (): void => {
    const now = this.#clock.now();
    const dt = (now - this.#lastTick) / 1000;
    this.#lastTick = now;
    this.#runBlasts(now);
    for (const t of this.#trucks) {
      this.#leaseTimers(t, now);
      while (t.pending.length > 0 && t.pending[0]!.due <= now) this.#apply(t, t.pending.shift()!, now);
      this.#advance(t, dt, now);
    }
    this.#ticks++;
    for (const t of this.#trucks) {
      if ((this.#ticks + t.phase) % this.#telemetryEvery !== 0) continue;
      const f = this.#telemetryFaults;
      if (f?.silent(t.id, now)) continue; // a silent truck sends nothing and its seq does not advance
      const m = this.#telemetry(t, now);
      if (!f) { t.seq = m.seq; this.#emit(m); continue; }
      const shaped = f.shape(m, { speedMps: t.speed, state: t.state, positionM: t.pos }, now);
      t.seq = typeof shaped.seq === 'number' ? shaped.seq : m.seq;
      this.#emit(shaped as unknown as GatewayMessage);
    }
    if (now >= this.#nextHeartbeat) {
      this.#emit({ type: 'heartbeat', server_time_ms: now });
      this.#nextHeartbeat += this.#b.heartbeatPeriodMs;
    }
    this.#timer = this.#clock.setTimeout(this.#tick, this.#b.tickMs);
  };

  #leaseTimers(t: Truck, now: number): void {
    if (!t.lease) return;
    const idle = now - t.lease.lastFresh;
    if (idle >= this.#b.leaseIdleTimeoutMs) {
      this.#emitLease(t, 'EXPIRED', t.lease, now, { reason: 'NO_DRIVE_INPUT' });
      this.#endLease(t);
    } else if (idle >= this.#b.deadmanMs) {
      t.deadman = true;
    }
  }

  #advance(t: Truck, dt: number, now: number): void {
    switch (t.state) {
      case 'LOADING':
      case 'DUMPING':
        t.speed = 0;
        if (t.work!.until !== null && now >= t.work!.until) this.#finishWork(t, now);
        return;
      case 'CHARGING':
        t.speed = 0;
        t.soc = Math.min(this.#b.chargeToPct, t.soc + this.#b.chargeRatePctPerS * dt);
        if (t.soc >= this.#b.chargeToPct) this.#finishWork(t, now);
        return;
      case 'TRAMMING':
        if (t.move) this.#moveTask(t, dt, now);
        else this.#moveDuty(t, dt, now);
        return;
      case 'MANUAL':
        this.#moveManual(t, dt, now);
        return;
      default:
        t.speed = 0;
    }
  }

  // The autonomous duty cycle: forward, stopping to load, dump or charge where the route says.
  #moveDuty(t: Truck, dt: number, now: number): void {
    t.speed = t.loaded ? this.#b.autoSpeedLoaded : this.#b.autoSpeedEmpty;
    t.dir = 1;
    const d = t.speed * dt;
    const kinds: Array<Work['kind']> = [t.loaded ? 'DUMPING' : 'LOADING'];
    if (t.soc < this.#b.chargeBelowPct) kinds.push('CHARGING');
    let s: { dist: number; point: number; kind: Work['kind'] } | null = null;
    for (const kind of kinds) {
      for (const p of this.#points[kind]) {
        const dist = this.#mod(p - t.pos);
        if (dist > EPS && dist <= d + EPS && (!s || dist < s.dist)) s = { dist, point: p, kind };
      }
    }
    if (!s) { this.#travel(t, d, now); return; }
    if (!this.#travel(t, s.dist, now)) return;
    t.pos = s.point;
    t.speed = 0;
    t.state = s.kind;
    const until = s.kind === 'LOADING' ? now + this.#b.loadMs : s.kind === 'DUMPING' ? now + this.#b.dumpMs : null;
    t.work = { kind: s.kind, until, then: 'TRAMMING' };
  }

  // EXIT_ZONE and RETURN_TO_BAY: to a target, forward or reverse, ignoring the duty cycle.
  #moveTask(t: Truck, dt: number, now: number): void {
    const m = t.move!;
    t.dir = m.dir;
    t.speed = m.dir > 0
      ? (t.loaded ? this.#b.autoSpeedLoaded : this.#b.autoSpeedEmpty)
      : (t.loaded ? this.#b.reverseSpeedLoaded : this.#b.reverseSpeedEmpty);
    const d = Math.min(t.speed * dt, m.remaining);
    if (!this.#travel(t, d * m.dir, now)) return;
    m.remaining -= d;
    if (m.remaining <= EPS) {
      t.pos = m.target;
      this.#arrive(t);
    }
  }

  #arrive(t: Truck): void {
    t.move = null;
    t.speed = 0;
    t.dir = 1;
    if (t.task === 'EXIT_ZONE') { t.state = 'HOLDING'; t.task = null; return; }
    if (t.soc < this.#b.chargeToPct) {
      t.state = 'CHARGING';
      t.work = { kind: 'CHARGING', until: null, then: 'IDLE' }; // task stays RETURN_TO_BAY until parked
    } else {
      t.state = 'IDLE';
      t.task = null;
    }
  }

  #finishWork(t: Truck, now: number): void {
    const w = t.work!;
    t.work = null;
    if (w.kind === 'LOADING') t.loaded = true;
    if (w.kind === 'DUMPING') t.loaded = false;
    if (w.then === 'IDLE') { t.state = 'IDLE'; t.task = null; } else t.state = 'TRAMMING';
    if (t.queued) {
      const q = t.queued;
      t.queued = null;
      // L0.P pessimistic version: the queued command is sometimes dropped without notice.
      if (this.#b.queueing === 'pessimistic' && this.#rngQueue.chance(this.#b.queuedDropProbability)) {
        this.#log.event(now, t.id, 'queued_dropped', { action: q.action });
        return;
      }
      this.#apply(t, q, now);
    }
  }

  // Moves only on fresh input: the deadman (set in #leaseTimers) stops it, and nothing re-applies
  // an old throttle once it has tripped.
  #moveManual(t: Truck, dt: number, now: number): void {
    if (t.deadman || t.throttle === 0) { t.speed = 0; return; }
    const max = t.faults.length > 0 ? this.#b.limpSpeed : t.loaded ? this.#b.manualSpeedLoaded : this.#b.manualSpeedEmpty;
    t.speed = Math.abs(t.throttle) * max;
    t.dir = t.throttle > 0 ? 1 : -1;
    this.#travel(t, t.speed * dt * t.dir, now);
  }

  // Moves along the loop, paying for it in charge. Returns false if the pack ran out on the way,
  // in which case the truck stops exactly where it did.
  #travel(t: Truck, signedM: number, now: number): boolean {
    const dist = Math.abs(signedM);
    if (dist === 0) return true;
    const perM = ((t.loaded ? this.#b.drainLoadedPctPerKm : this.#b.drainEmptyPctPerKm) / 1000) * t.drainFactor;
    const cost = dist * perM;
    if (cost >= t.soc) {
      t.pos = this.#mod(t.pos + Math.sign(signedM) * (t.soc / perM));
      t.soc = 0;
      this.#fault(t, this.#b.depletedFault, now);
      return false;
    }
    t.pos = this.#mod(t.pos + signedM);
    t.soc -= cost;
    return true;
  }

  #stopAll(t: Truck): void {
    t.speed = 0;
    t.dir = 1;
    t.work = null;
    t.move = null;
    t.task = null;
    t.queued = null;
    t.pending = [];
  }

  // ---- blasts ----

  #runBlasts(now: number): void {
    while (this.#randomBlasts && now >= this.#nextRandomBlastAt) {
      this.#scheduleRandomBlast(this.#nextRandomBlastAt);
      this.#nextRandomBlastAt += this.#onTick(this.#rngBlasts.uniform(this.#b.blastSpacingMinMs, this.#b.blastSpacingMaxMs));
    }
    for (const b of this.#blasts) {
      if (b.stage === 'scheduled' && now >= b.closingAt) {
        this.#setZone(b.zoneId, 'CLOSING', b.effectiveAt, 'BLAST_WINDOW', now);
        b.stage = 'closing';
      }
      if (b.stage === 'closing') {
        if (b.cancelAt !== null && now >= b.cancelAt) {
          this.#setZone(b.zoneId, 'OPEN', now, 'CANCELLED', now);
          b.stage = 'done';
        } else if (now >= b.effectiveAt) {
          this.#setZone(b.zoneId, 'CLOSED', now, 'BLAST_WINDOW', now);
          b.stage = 'closed';
        }
      }
      if (b.stage === 'closed' && now >= b.reopenAt) {
        this.#setZone(b.zoneId, 'OPEN', now, 'CLEARED', now);
        b.stage = 'done';
      }
    }
    this.#blasts = this.#blasts.filter((b) => b.stage !== 'done');
  }

  #scheduleRandomBlast(at: number): void {
    const r = this.#rngBlasts;
    const busy = new Set(this.#blasts.map((b) => b.zoneId));
    const candidates = this.site.zones
      .filter((z) => this.#b.blastBay || !z.kinds.includes('bay'))
      .map((z) => z.zoneId)
      .filter((id) => !busy.has(id));
    const add = (zoneId: string, closingAt: number) => {
      const effectiveAt = closingAt + this.#config.noticeMs;
      const cancel = r.chance(this.#b.cancelProbability);
      const cancelAt = closingAt + this.#onTick(r.uniform(0.1, 0.9) * this.#config.noticeMs);
      this.#logBlast(zoneId, closingAt, cancel);
      this.#blasts.push({
        zoneId, closingAt, effectiveAt, reopenAt: effectiveAt + this.#onTick(r.uniform(this.#b.closedMinMs, this.#b.closedMaxMs)),
        cancelAt: cancel ? cancelAt : null, stage: 'scheduled',
      });
    };
    if (candidates.length === 0) return;
    const first = r.pick(candidates);
    add(first, at);
    const rest = candidates.filter((id) => id !== first);
    if (rest.length > 0 && r.chance(this.#b.secondZoneProbability)) add(r.pick(rest), at + this.#onTick(this.#b.secondZoneOffsetMs));
  }

  // Blasts are scheduled, not faults, but the unusual ones are what L0.F switches on: record them.
  #logBlast(zoneId: string, closingAt: number, cancelled: boolean): void {
    const zone = this.site.zones.find((z) => z.zoneId === zoneId);
    if (zone?.kinds.includes('bay')) this.#log.event(closingAt, null, 'bay_closing', { zoneId });
    if (cancelled) this.#log.event(closingAt, null, 'cancelled_blast', { zoneId });
    const other = this.#blasts.find((b) => b.zoneId !== zoneId && b.stage !== 'done' && b.closingAt <= closingAt && closingAt < (b.cancelAt ?? b.reopenAt));
    if (other) this.#log.event(closingAt, null, 'two_zones', { zoneId, alsoClosing: other.zoneId });
  }

  #setZone(zoneId: string, status: ZoneState['status'], effectiveAt: number, reason: string, now: number): void {
    this.#zones.set(zoneId, { zone_id: zoneId, status, effective_at_ms: effectiveAt, reason });
    this.#emit({ type: 'zone_event', zone_id: zoneId, status, reason, effective_at_ms: effectiveAt, server_time_ms: now });
  }

  // ---- telemetry ----

  #telemetry(t: Truck, now: number): Telemetry {
    const { seg, offset } = this.#locate(t.pos);
    return {
      type: 'telemetry', vehicle_id: t.id, seq: t.seq + 1, t_device_ms: now + t.deviceOffsetMs, state: t.state, task: t.task,
      soc_pct: round2(t.soc), speed_mps: round2(t.speed), direction: this.#direction(t), segment_id: seg.segmentId,
      zone_id: seg.zoneId, offset_m: offset, payload_kg: t.loaded ? this.#b.payloadKg : 0, faults: [...t.faults],
      control: {
        mode: t.lease ? 'MANUAL' : 'AUTO', operator_id: t.lease?.operator ?? null, deadman: t.deadman,
        last_drive_seq: t.lastDriveSeq, last_drive_sent_ms: t.lastDriveSentMs,
      },
    };
  }

  #direction(t: Truck): 'FWD' | 'REV' {
    return t.speed > 0 && t.dir < 0 ? 'REV' : 'FWD';
  }

  // ---- geometry ----

  #mod(x: number): number {
    const l = this.site.loopLengthM;
    const m = ((x % l) + l) % l;
    return m >= l ? 0 : m;
  }

  // The segment holding a position, and the offset into it (rounded as the live site reports it,
  // and never rounded up onto the next segment's start).
  #locate(pos: number): { seg: Segment; offset: number } {
    const p = this.#mod(pos);
    let seg = this.#segments[0]!;
    for (const s of this.#segments) if (s.startM <= p + EPS) seg = s;
    const raw = Math.max(0, p - seg.startM);
    let offset = round2(raw);
    if (offset >= seg.lengthM) offset = Math.floor((seg.lengthM - 0.005) * 100) / 100;
    return { seg, offset };
  }

  #loadedAt(pos: number): boolean {
    const load = this.#points.LOADING[0], dump = this.#points.DUMPING[0];
    if (load === undefined || dump === undefined) return false;
    return this.#mod(pos - load) < this.#mod(dump - load);
  }

  // Round a duration to whole ticks, so scheduled events land exactly on a tick.
  #onTick(ms: number): number {
    return Math.round(ms / this.#b.tickMs) * this.#b.tickMs;
  }
}

const ACCEPTED: AckResult = Object.freeze({ status: 'ACCEPTED' }) as AckResult;

function reject(reason: RejectReason, extra: { holder?: string } = {}): AckResult {
  return { status: 'REJECTED', reason, ...extra };
}
