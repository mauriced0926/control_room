// Fleet state: the gateway's unreliable stream turned into a picture that never shows a guess as a
// fact (TESTING.md L2.10-L2.28, L3). What each truck last reported, how sure we are, and where it
// could be. The blast engine, the UI and alerting read snapshot() and the event stream.
//
// Time (CLAUDE.md invariant 1; CONTEXT.md assumption 3): "now" is the injected clock. Ages are time
// elapsed on that clock since receipt. Timestamps shown to others are mapped onto the gateway's
// server time with an offset learned from server_time_ms. t_device_ms is used only to order a
// controller restart and to show per-truck skew, never for age.
import type { Clock, TimerHandle } from './clock.ts';
import { assess, DrainTracker, fleetMedianExcluding, median, type BatteryWarning, type Reach } from './battery.ts';
import { forwardDistance, reachableRange, zonesOverlapping } from './geometry.ts';
import { classify, parseLine, serverTimeOf, validateTelemetry, validateZone, type ControlFields, type PositionFields, type TelemetryFields } from './ingest.ts';
import { PARAMS } from './params.ts';
import type { Direction, Hello, Task, VehicleState, ZoneStatus } from './protocol.ts';
import { buildSite, SiteError, type Range, type Site } from './site.ts';

// ---- public, plain-data views ----

export type Confidence = 'live' | 'old' | 'silent' | 'contradicted' | 'unknown';

export interface Known<T> {
  value: T;
  atServerMs: number; // when it was last reported validly, on the server's timeline
  ageMs: number;
}

export interface BatteryView {
  drain: { emptyPctPerKm: number | null; loadedPctPerKm: number | null; emptyEvidenceM: number; loadedEvidenceM: number };
  ratioToFleet: { empty: number | null; loaded: number | null };
  drainHigh: boolean;
  reach: Reach;
  warning: BatteryWarning | null;
  message: string | null;
}

export interface TruckView {
  vehicleId: string;
  onRoster: boolean | null; // null before any hello
  confidence: Confidence;
  confidenceReason: string;
  lastMessageServerMs: number | null;
  ageMs: number | null; // since the last accepted message
  state: Known<VehicleState> | null;
  task: Known<Task | null> | null;
  socPct: Known<number> | null; // as the pack reported it, never scaled
  socFractional: boolean;
  speedMps: Known<number> | null;
  direction: Known<Direction> | null;
  payloadKg: Known<number> | null;
  loaded: boolean | null;
  faults: Known<string[]> | null;
  control: Known<ControlFields> | null;
  position: Known<PositionFields> | null; // the last valid report, with its age
  anchor: { loopM: number; atServerMs: number } | null; // last believable position, where the range grows from
  range: Range | null; // everywhere it could be now; null: anywhere (no site yet)
  mightBeIn: string[]; // zones the range touches, in route order
  frozenEpisodes: number;
  skewMs: number | null; // t_device_ms minus server time at receipt
  skewFlagged: boolean;
  run: { index: number; restarts: number; seq: number | null };
  radio: { applied: number; duplicates: number; older: number };
  dataQuality: Record<string, number>;
  battery: BatteryView;
}

export interface ZoneView {
  zoneId: string;
  status: ZoneStatus | null; // null: unknown, which is never to be read as open
  reason: string | null;
  effectiveAtMs: number | null;
  msUntilEffective: number | null;
  updatedServerMs: number | null;
  trucksMightBeIn: string[];
}

export interface FleetSnapshot {
  atServerMs: number;
  siteId: string | null;
  loopLengthM: number | null;
  heartbeat: { lastServerMs: number | null; ageMs: number | null; stale: boolean };
  zones: ZoneView[];
  trucks: TruckView[];
  fleetDrain: { emptyPctPerKm: number | null; loadedPctPerKm: number | null };
  dataQuality: { total: Record<string, number>; connection: Record<string, number> };
}

export type FleetEvent =
  | { type: 'confidence'; vehicleId: string; from: Confidence; to: Confidence; reason: string; atServerMs: number }
  | { type: 'controller_restart'; vehicleId: string; detail: string; atServerMs: number }
  | { type: 'data_quality'; vehicleId: string | null; kind: string; detail: string; atServerMs: number }
  | { type: 'zone'; zoneId: string; status: ZoneStatus | null; reason: string | null; effectiveAtMs: number | null; atServerMs: number }
  | { type: 'battery'; vehicleId: string; warning: BatteryWarning | null; drainHigh: boolean; message: string | null; atServerMs: number }
  | { type: 'site'; siteId: string; issues: string[]; atServerMs: number };

// ---- internals ----

interface Stored<T> { value: T; atLocal: number }

interface Run {
  index: number;
  startTDev: number | undefined;
  maxSeq: number;
  tDevAtMax: number | undefined;
  seen: Map<number, string>;
}

interface Still {
  pos: number;
  firstAt: number;
  lastStationaryAt: number | null;
  movingSince: number | null;
  repeats: number; // messages at this position, reporting motion, after movingSince
}

interface DrainPoint { loopM: number; soc: number; loaded: boolean; atLocal: number; runIndex: number }

class Truck {
  onRoster: boolean | null = null;
  run: Run | null = null;
  restarts = 0;
  lastAccepted: number | null = null;
  state?: Stored<VehicleState>;
  task?: Stored<Task | null>;
  soc?: Stored<number>;
  socFractional = false;
  speed?: Stored<number>;
  direction?: Stored<Direction>;
  payload?: Stored<number>;
  faults?: Stored<string[]>;
  control?: Stored<ControlFields>;
  position?: Stored<PositionFields>;
  still: Still | null = null;
  frozenEpisodes = 0;
  skewMs: number | null = null;
  skewFlagged = false;
  radio = { applied: 0, duplicates: 0, older: 0 };
  dq: Record<string, number> = {};
  drain = new DrainTracker();
  drainPrev: DrainPoint | null = null;
  lastConfidence: Confidence = 'unknown';
  lastBattery = '';
  readonly vehicleId: string;
  constructor(vehicleId: string) { this.vehicleId = vehicleId; }
}

interface ZoneRecord {
  zoneId: string;
  status: ZoneStatus | null;
  reason: string | null;
  effectiveAtMs: number | null;
  updatedServerMs: number | null;
}

const MOVING_STATES: ReadonlySet<string> = new Set<VehicleState>(['TRAMMING', 'MANUAL']);

export class FleetState {
  readonly #clock: Clock;
  #site: Site | undefined;
  #routeKey = '';
  #roster: string[] = [];
  #trucks = new Map<string, Truck>();
  #zones = new Map<string, ZoneRecord>();
  #offsets: number[] = [];
  #lastHeartbeat: { serverMs: number; atLocal: number } | null = null;
  #dqTotal: Record<string, number> = {};
  #dqConnection: Record<string, number> = {};
  #listeners = new Set<(e: FleetEvent) => void>();
  #timer: TimerHandle | null = null;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get site(): Site | undefined { return this.#site; }

  subscribe(fn: (e: FleetEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // Server time now: the injected clock plus the learned offset. The offset is the largest of the
  // recent samples, because delay in transit only ever makes a sample too small.
  serverNow(): number {
    return this.#clock.now() + this.#offset();
  }

  // A new connection to the gateway: per-connection counts start again.
  newConnection(): void {
    this.#dqConnection = {};
  }

  ingestLine(line: string): void {
    const p = parseLine(line);
    if (!p.ok) { this.#linkDq(p.reason, line); return; }
    this.#dispatch(p.msg);
  }

  ingest(message: unknown): void {
    const p = classify(message);
    if (!p.ok) { this.#linkDq(p.reason, String(message)); return; }
    this.#dispatch(p.msg);
  }

  // Re-evaluates everything that changes with time alone (old, silent, contradicted, battery) and
  // emits what changed. Snapshots are always correct without it; events need it.
  tick(): void {
    for (const t of this.#trucks.values()) this.#evaluate(t);
  }

  start(intervalMs: number = PARAMS.heartbeatInterval.value / 8): void {
    this.stop();
    const loop = () => { this.tick(); this.#timer = this.#clock.setTimeout(loop, intervalMs); };
    this.#timer = this.#clock.setTimeout(loop, intervalMs);
  }

  stop(): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  snapshot(): FleetSnapshot {
    const now = this.#clock.now();
    const site = this.#site;
    const fleet = this.#fleetDrain();
    const trucks = this.#orderedTrucks().map((t) => this.#view(t, now, fleet));
    const zoneIds = [...(site?.zones.map((z) => z.zoneId) ?? []), ...[...this.#zones.keys()].filter((id) => !site?.zone(id))];
    const zones = [...new Set(zoneIds)].map((id): ZoneView => {
      const z = this.#zones.get(id);
      const eff = z?.effectiveAtMs ?? null;
      return {
        zoneId: id,
        status: z?.status ?? null,
        reason: z?.reason ?? null,
        effectiveAtMs: eff,
        msUntilEffective: eff === null ? null : eff - this.serverNow(),
        updatedServerMs: z?.updatedServerMs ?? null,
        trucksMightBeIn: trucks.filter((t) => t.range === null || t.mightBeIn.includes(id)).map((t) => t.vehicleId),
      };
    });
    const hb = this.#lastHeartbeat;
    const hbAge = hb ? now - hb.atLocal : null;
    return {
      atServerMs: this.serverNow(),
      siteId: site?.siteId ?? null,
      loopLengthM: site?.loopLengthM ?? null,
      heartbeat: { lastServerMs: hb?.serverMs ?? null, ageMs: hbAge, stale: hbAge === null || hbAge >= PARAMS.linkDownAfter.value },
      zones,
      trucks,
      fleetDrain: { emptyPctPerKm: perKm(fleet.emptyPctPerM), loadedPctPerKm: perKm(fleet.loadedPctPerM) },
      dataQuality: { total: { ...this.#dqTotal }, connection: { ...this.#dqConnection } },
    };
  }

  // ---- dispatch ----

  #dispatch(m: Record<string, unknown> & { type: string }): void {
    const st = serverTimeOf(m);
    if (st !== undefined) this.#sample(st);
    switch (m.type) {
      case 'telemetry': this.#telemetry(m); break;
      case 'heartbeat':
        if (st === undefined) this.#linkDq('bad_message', 'heartbeat without server_time_ms');
        else this.#lastHeartbeat = { serverMs: st, atLocal: this.#clock.now() };
        break;
      case 'hello': this.#hello(m as unknown as Hello); break;
      case 'zone_event': this.#zoneEvent(m, st); break;
      // Commands, leases and drive refusals belong to the command registry and the gateway link;
      // here they only contribute server time.
      case 'command_ack': case 'lease_event': case 'drive_rejected': case 'auth_error': break;
      default: this.#linkDq('unknown_type', m.type);
    }
  }

  #hello(h: Hello): void {
    let built: { site: Site; issues: string[] };
    try {
      built = buildSite(h);
    } catch (e) {
      this.#linkDq('hello:invalid', e instanceof SiteError ? e.message : String(e));
      return;
    }
    const routeKey = JSON.stringify([h.loop_length_m, h.route]);
    if (this.#site && routeKey !== this.#routeKey) {
      // A different route: positions recorded against the old one mean nothing now.
      for (const t of this.#trucks.values()) { delete t.position; t.still = null; t.drainPrev = null; }
    }
    this.#site = built.site;
    this.#routeKey = routeKey;
    for (const i of built.issues) this.#linkDq('hello:route_issue', i);
    this.#emit({ type: 'site', siteId: built.site.siteId, issues: built.issues, atServerMs: this.serverNow() });

    this.#roster = Array.isArray(h.vehicles) ? h.vehicles.filter((v): v is string => typeof v === 'string') : [];
    for (const id of this.#roster) if (!this.#trucks.has(id)) this.#trucks.set(id, new Truck(id));
    for (const t of this.#trucks.values()) t.onRoster = this.#roster.includes(t.vehicleId);

    // The snapshot replaces what we knew. A route zone missing from it is unknown, not open.
    const at = serverTimeOf(h as unknown as Record<string, unknown>) ?? this.serverNow();
    const listed = new Set<string>();
    for (const raw of Array.isArray(h.zones) ? h.zones : []) {
      const { zone, issues } = validateZone(raw);
      for (const i of issues) this.#linkDq(i, JSON.stringify(raw));
      if (!zone) continue;
      listed.add(zone.zoneId);
      this.#setZone({ ...zone, updatedServerMs: at });
    }
    for (const z of built.site.zones) {
      if (!listed.has(z.zoneId)) this.#setZone({ zoneId: z.zoneId, status: null, reason: null, effectiveAtMs: null, updatedServerMs: at });
    }
    this.tick();
  }

  #zoneEvent(m: Record<string, unknown>, st: number | undefined): void {
    const { zone, issues } = validateZone(m);
    for (const i of issues) this.#linkDq(i, JSON.stringify(m));
    if (!zone) return;
    const prev = this.#zones.get(zone.zoneId);
    if (st !== undefined && prev?.updatedServerMs != null && st < prev.updatedServerMs) {
      this.#linkDq('zone_event:stale', `${zone.zoneId} ${zone.status} at ${st}, after ${prev.updatedServerMs}`);
      return;
    }
    this.#setZone({ ...zone, updatedServerMs: st ?? this.serverNow() });
  }

  #setZone(z: ZoneRecord): void {
    const prev = this.#zones.get(z.zoneId);
    this.#zones.set(z.zoneId, z);
    if (!prev || prev.status !== z.status || prev.effectiveAtMs !== z.effectiveAtMs || prev.reason !== z.reason) {
      this.#emit({ type: 'zone', zoneId: z.zoneId, status: z.status, reason: z.reason, effectiveAtMs: z.effectiveAtMs, atServerMs: this.serverNow() });
    }
  }

  // ---- telemetry ----

  #telemetry(m: Record<string, unknown>): void {
    const v = validateTelemetry(m, this.#site);
    if (!v.fields) { this.#linkDq('bad_message', `telemetry: ${v.issues.map((i) => i.detail).join('; ')}`); return; }
    const f = v.fields;
    const t = this.#truckFor(f.vehicleId);
    if (f.seq === undefined) {
      this.#truckDq(t, 'seq:invalid', v.issues.find((i) => i.field === 'seq')?.detail ?? 'seq unusable');
      return;
    }
    if (f.tDeviceMs === undefined) {
      const i = v.issues.find((x) => x.field === 't_device_ms');
      if (i) this.#truckDq(t, i.kind, i.detail);
    }
    const body = JSON.stringify(m);
    const verdict = this.#order(t, f.seq, f.tDeviceMs, body);
    if (verdict === 'duplicate') { t.radio.duplicates++; return; }
    if (verdict === 'older') { t.radio.older++; return; }
    if (verdict === 'conflict') { this.#truckDq(t, 'seq:conflict', `seq ${f.seq} arrived twice with different contents`); return; }
    for (const i of v.issues) if (i.field !== 't_device_ms') this.#truckDq(t, i.kind, i.detail);
    this.#apply(t, f);
    this.#evaluate(t);
  }

  // Order by seq within a controller run (CONTEXT.md assumption 3).
  #order(t: Truck, seq: number, tDev: number | undefined, body: string): 'apply' | 'duplicate' | 'older' | 'conflict' {
    const window = PARAMS.reorderWindow.value;
    const run = t.run;
    const begin = (index: number) => {
      t.run = { index, startTDev: tDev, maxSeq: seq, tDevAtMax: tDev, seen: new Map([[seq, body]]) };
    };
    if (!run) { begin(0); return 'apply'; }
    const seen = run.seen.get(seq);
    if (seen !== undefined) return seen === body ? 'duplicate' : 'conflict';
    if (seq > run.maxSeq) {
      // A late message from the previous run can carry a higher seq than the new run has reached;
      // its device time gives it away.
      if (t.restarts > 0 && tDev !== undefined && run.startTDev !== undefined && tDev < run.startTDev) return 'older';
      run.seen.set(seq, body);
      run.maxSeq = seq;
      run.tDevAtMax = tDev;
      for (const s of run.seen.keys()) if (s < seq - 4 * window) run.seen.delete(s);
      return 'apply';
    }
    const forward = tDev !== undefined && run.tDevAtMax !== undefined && tDev > run.tDevAtMax;
    if (forward && (run.maxSeq - seq > window || seq <= window)) {
      const from = run.maxSeq;
      t.restarts++;
      begin(run.index + 1);
      t.drainPrev = null;
      t.dq.controller_restart = (t.dq.controller_restart ?? 0) + 1;
      this.#emit({ type: 'controller_restart', vehicleId: t.vehicleId, detail: `seq went from ${from} to ${seq} while its clock moved forward: controller restarted`, atServerMs: this.serverNow() });
      return 'apply';
    }
    run.seen.set(seq, body);
    return 'older';
  }

  #apply(t: Truck, f: TelemetryFields): void {
    const at = this.#clock.now();
    t.lastAccepted = at;
    t.radio.applied++;
    const set = <K extends 'state' | 'task' | 'speed' | 'direction' | 'payload' | 'faults' | 'control' | 'position'>(k: K, v: Truck[K] extends Stored<infer T> | undefined ? T | undefined : never) => {
      if (v !== undefined) (t as unknown as Record<string, unknown>)[k] = { value: v, atLocal: at };
    };
    set('state', f.state);
    set('task', f.task);
    set('speed', f.speedMps);
    set('direction', f.direction);
    set('payload', f.payloadKg);
    set('faults', f.faults);
    set('control', f.control);

    if (f.socPct !== undefined) {
      const frac = this.#isFractional(t, f.socPct);
      if (frac && !t.socFractional) this.#truckDq(t, 'soc_pct:fractional', `soc_pct ${f.socPct} looks like a fraction of 1, not a percentage; shown as reported`);
      t.socFractional = frac;
      t.soc = { value: f.socPct, atLocal: at };
    }

    if (f.tDeviceMs !== undefined) {
      t.skewMs = f.tDeviceMs - this.serverNow();
      const flagged = Math.abs(t.skewMs) > PARAMS.deviceSkewFlagAbove.value;
      if (flagged && !t.skewFlagged) this.#truckDq(t, 'clock_skew', `device clock is ${(t.skewMs / 60_000).toFixed(1)} min off server time`);
      t.skewFlagged = flagged;
    }

    if (f.position) {
      t.position = { value: f.position, atLocal: at };
      this.#trackStill(t, f.position.loopM, at);
    }
    this.#trackDrain(t, at);
  }

  // A value in 0..1 is a fraction unless the pack has been draining smoothly down into it.
  #isFractional(t: Truck, soc: number): boolean {
    if (soc > 1) return false;
    const prev = t.soc?.value;
    if (prev === undefined || t.socFractional) return true;
    return prev - soc > PARAMS.fractionalSocJump.value;
  }

  #trackStill(t: Truck, pos: number, at: number): void {
    const speed = t.speed?.value;
    const moving = t.state !== undefined && MOVING_STATES.has(t.state.value) && speed !== undefined && speed >= PARAMS.frozenMinReportedSpeed.value;
    const s = t.still;
    if (!s || this.#gap(pos, s.pos) >= PARAMS.frozenMaxMovement.value) {
      t.still = { pos, firstAt: at, lastStationaryAt: moving ? null : at, movingSince: moving ? at : null, repeats: 0 };
    } else if (moving) {
      if (s.movingSince === null) { s.movingSince = at; s.repeats = 0; } else s.repeats++;
    } else {
      s.lastStationaryAt = at;
      s.movingSince = null;
      s.repeats = 0;
    }
  }

  #gap(a: number, b: number): number {
    const L = this.#site?.loopLengthM;
    if (!L) return Math.abs(a - b);
    const d = forwardDistance(L, a, b);
    return Math.min(d, L - d);
  }

  #isContradicted(t: Truck, now: number): boolean {
    const s = t.still;
    return !!s && s.movingSince !== null && s.repeats >= 1 && now - s.movingSince >= PARAMS.frozenAfter.value;
  }

  #trackDrain(t: Truck, at: number): void {
    const site = this.#site;
    const pos = t.position, soc = t.soc, payload = t.payload;
    // Only an interval whose ends were both reported in this message pair counts.
    if (!site || !pos || pos.atLocal !== at || !soc || soc.atLocal !== at || !payload || t.socFractional) return;
    const cur: DrainPoint = { loopM: pos.value.loopM, soc: soc.value, loaded: payload.value > 0, atLocal: at, runIndex: t.run?.index ?? 0 };
    const prev = t.drainPrev;
    t.drainPrev = cur;
    if (!prev || prev.runIndex !== cur.runIndex || prev.loaded !== cur.loaded || at - prev.atLocal > PARAMS.drainMaxGap.value) return;
    if (t.state?.value === 'CHARGING' || this.#isContradicted(t, at)) return;
    const drop = prev.soc - cur.soc;
    if (drop < 0) return;
    const L = site.loopLengthM;
    const dist = t.direction?.value === 'REV' ? forwardDistance(L, cur.loopM, prev.loopM) : forwardDistance(L, prev.loopM, cur.loopM);
    const plausible = (PARAMS.manualSpeedEmptyFull.value * (at - prev.atLocal)) / 1000 + PARAMS.frozenMaxMovement.value;
    if (dist > plausible) return;
    t.drain.add(cur.loaded, drop, dist);
  }

  // ---- evaluation ----

  #confidence(t: Truck, now: number): { c: Confidence; reason: string } {
    if (t.lastAccepted === null) return { c: 'unknown', reason: 'no data received yet' };
    if (this.#isContradicted(t, now)) {
      const s = t.still!;
      return { c: 'contradicted', reason: `reports ${t.state?.value ?? '?'} at ${t.speed?.value ?? '?'} m/s but has not moved for ${secs(now - s.movingSince!)}` };
    }
    if (!t.position) return { c: 'unknown', reason: 'no valid position reported yet' };
    const msgAge = now - t.lastAccepted;
    const posAge = now - t.position.atLocal;
    const silent = PARAMS.truckSilentAfter.value, old = PARAMS.truckOldAfter.value;
    if (posAge >= silent) {
      return { c: 'silent', reason: msgAge >= silent ? `no message for ${secs(msgAge)}` : `no valid position for ${secs(posAge)}; messages still arriving` };
    }
    if (posAge >= old) return { c: 'old', reason: `last position ${secs(posAge)} ago` };
    return { c: 'live', reason: 'reporting normally' };
  }

  #rangeOf(t: Truck, now: number, c: Confidence): { anchor: { loopM: number; atLocal: number } | null; range: Range | null } {
    const site = this.#site;
    if (!site) return { anchor: null, range: null };
    if (!t.position) return { anchor: null, range: { startM: 0, lengthM: site.loopLengthM } };
    const s = t.still;
    const anchor = c === 'contradicted' && s
      ? { loopM: s.pos, atLocal: s.lastStationaryAt ?? s.firstAt }
      : { loopM: t.position.value.loopM, atLocal: t.position.atLocal };
    const manual = t.control?.value.mode === 'MANUAL' || t.state?.value === 'MANUAL' || (t.control?.value.operatorId ?? null) !== null;
    const top = Math.max(t.speed?.value ?? 0, manual ? PARAMS.manualSpeedEmptyFull.value : PARAMS.autoSpeedEmpty.value);
    // Blunter when stale (CONTEXT.md finding 4): a silent or contradicted truck may be going either way.
    const canReverse = c === 'silent' || c === 'contradicted' || manual || (t.task?.value ?? null) !== null ||
      t.direction?.value !== 'FWD' || t.state === undefined;
    const elapsed = now - anchor.atLocal + PARAMS.telemetryLatencyAllowance.value;
    return { anchor, range: reachableRange(site.loopLengthM, anchor.loopM, elapsed, top, canReverse ? top : 0) };
  }

  #battery(t: Truck, fleet: { emptyPctPerM: number | null; loadedPctPerM: number | null }, rates: Rates): BatteryView {
    const ownEmpty = t.drain.empty.rate(), ownLoaded = t.drain.loaded.rate();
    const fleetEmpty = fleetMedianExcluding(rates.empty, t.vehicleId);
    const fleetLoaded = fleetMedianExcluding(rates.loaded, t.vehicleId);
    const ratio = { empty: ownEmpty !== null && fleetEmpty ? ownEmpty / fleetEmpty : null, loaded: ownLoaded !== null && fleetLoaded ? ownLoaded / fleetLoaded : null };
    const flag = PARAMS.drainRatioFlag.value;
    const a = assess({
      site: this.#site, socPct: t.soc?.value, socFractional: t.socFractional, positionM: t.position?.value.loopM,
      loaded: t.payload ? t.payload.value > 0 : undefined, state: t.state?.value, task: t.task?.value, faults: t.faults?.value,
      ownEmpty, ownLoaded, fleet,
    });
    return {
      drain: { emptyPctPerKm: perKm(ownEmpty), loadedPctPerKm: perKm(ownLoaded), emptyEvidenceM: t.drain.empty.evidenceM, loadedEvidenceM: t.drain.loaded.evidenceM },
      ratioToFleet: ratio,
      drainHigh: (ratio.empty ?? 0) >= flag || (ratio.loaded ?? 0) >= flag,
      reach: a.reach, warning: a.warning, message: a.message,
    };
  }

  #rates(): Rates {
    const all = [...this.#trucks.values()];
    return {
      empty: all.map((t) => ({ id: t.vehicleId, rate: t.drain.empty.rate() })),
      loaded: all.map((t) => ({ id: t.vehicleId, rate: t.drain.loaded.rate() })),
    };
  }

  #fleetDrain(): { emptyPctPerM: number | null; loadedPctPerM: number | null; rates: Rates } {
    const rates = this.#rates();
    const med = (xs: Array<{ rate: number | null }>) => {
      const known = xs.filter((x) => x.rate !== null).map((x) => x.rate!);
      return known.length >= PARAMS.fleetMinTrucks.value ? median(known) : null;
    };
    return { emptyPctPerM: med(rates.empty), loadedPctPerM: med(rates.loaded), rates };
  }

  #evaluate(t: Truck): void {
    const now = this.#clock.now();
    const { c, reason } = this.#confidence(t, now);
    if (c !== t.lastConfidence) {
      if (c === 'contradicted') t.frozenEpisodes++;
      this.#emit({ type: 'confidence', vehicleId: t.vehicleId, from: t.lastConfidence, to: c, reason, atServerMs: this.serverNow() });
      t.lastConfidence = c;
    }
    const fleet = this.#fleetDrain();
    const b = this.#battery(t, fleet, fleet.rates);
    const key = `${b.warning}|${b.drainHigh}`;
    if (key !== t.lastBattery) {
      if (t.lastBattery !== '' || b.warning !== null || b.drainHigh) {
        this.#emit({ type: 'battery', vehicleId: t.vehicleId, warning: b.warning, drainHigh: b.drainHigh, message: b.message, atServerMs: this.serverNow() });
      }
      t.lastBattery = key;
    }
  }

  #view(t: Truck, now: number, fleet: { emptyPctPerM: number | null; loadedPctPerM: number | null; rates: Rates }): TruckView {
    const { c, reason } = this.#confidence(t, now);
    const { anchor, range } = this.#rangeOf(t, now, c);
    const off = this.#offset();
    const known = <T>(s: Stored<T> | undefined): Known<T> | null => (s ? { value: s.value, atServerMs: s.atLocal + off, ageMs: now - s.atLocal } : null);
    const site = this.#site;
    return {
      vehicleId: t.vehicleId,
      onRoster: t.onRoster,
      confidence: c,
      confidenceReason: reason,
      lastMessageServerMs: t.lastAccepted === null ? null : t.lastAccepted + off,
      ageMs: t.lastAccepted === null ? null : now - t.lastAccepted,
      state: known(t.state),
      task: known(t.task),
      socPct: known(t.soc),
      socFractional: t.socFractional,
      speedMps: known(t.speed),
      direction: known(t.direction),
      payloadKg: known(t.payload),
      loaded: t.payload ? t.payload.value > 0 : null,
      faults: known(t.faults),
      control: known(t.control),
      position: known(t.position),
      anchor: anchor && { loopM: anchor.loopM, atServerMs: anchor.atLocal + off },
      range,
      mightBeIn: site && range ? zonesOverlapping(site, range) : [],
      frozenEpisodes: t.frozenEpisodes,
      skewMs: t.skewMs,
      skewFlagged: t.skewFlagged,
      run: { index: t.run?.index ?? 0, restarts: t.restarts, seq: t.run?.maxSeq ?? null },
      radio: { ...t.radio },
      dataQuality: { ...t.dq },
      battery: this.#battery(t, fleet, fleet.rates),
    };
  }

  // ---- bookkeeping ----

  #truckFor(id: string): Truck {
    let t = this.#trucks.get(id);
    if (!t) {
      t = new Truck(id);
      this.#trucks.set(id, t);
      if (this.#site) {
        t.onRoster = this.#roster.includes(id);
        if (!t.onRoster) this.#truckDq(t, 'unknown_vehicle', `${id} is not on the roster from hello`);
      }
    }
    return t;
  }

  #orderedTrucks(): Truck[] {
    const rostered = this.#roster.map((id) => this.#trucks.get(id)).filter((t): t is Truck => !!t);
    const others = [...this.#trucks.values()].filter((t) => !this.#roster.includes(t.vehicleId)).sort((a, b) => a.vehicleId.localeCompare(b.vehicleId));
    return [...rostered, ...others];
  }

  #truckDq(t: Truck, kind: string, detail: string): void {
    t.dq[kind] = (t.dq[kind] ?? 0) + 1;
    this.#emit({ type: 'data_quality', vehicleId: t.vehicleId, kind, detail, atServerMs: this.serverNow() });
  }

  #linkDq(kind: string, detail: string): void {
    this.#dqTotal[kind] = (this.#dqTotal[kind] ?? 0) + 1;
    this.#dqConnection[kind] = (this.#dqConnection[kind] ?? 0) + 1;
    if (kind !== 'blank') this.#emit({ type: 'data_quality', vehicleId: null, kind, detail: detail.slice(0, 200), atServerMs: this.serverNow() });
  }

  #sample(serverMs: number): void {
    this.#offsets.push(serverMs - this.#clock.now());
    while (this.#offsets.length > PARAMS.serverTimeSamples.value) this.#offsets.shift();
  }

  #offset(): number {
    return this.#offsets.length ? Math.max(...this.#offsets) : 0;
  }

  #emit(e: FleetEvent): void {
    for (const fn of this.#listeners) fn(e);
  }
}

interface Rates {
  empty: Array<{ id: string; rate: number | null }>;
  loaded: Array<{ id: string; rate: number | null }>;
}

const perKm = (x: number | null) => (x === null ? null : x * 1000);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
