// The fake gateway: connections, the auth flow (PROTOCOL.md §1.1), line parsing, command_id
// de-duplication (§5), and broadcast of everything to every client. The site itself is the model
// (fake/model.ts). Transports plug in through `attach`: the in-process TestClient below for tests,
// and fake/tls.ts for research/probe.py.
//
// Layers: model (truth) -> telemetry faults (fake/faults.ts, in the model's telemetry step) ->
// gateway (this file) -> the site radio (fake/radio.ts: telemetry loss, duplicates, lateness,
// truncation; ack latency and loss) -> every connection -> transport. Link drops and the slow-reader
// cut-off act on connections here. Lines are written as the live gateway writes them (fake/wire.ts).
import type { Clock, TimerHandle } from '../src/clock.ts';
import { ACTIONS, type Action, type AuthErrorReason, type CommandAck, type GatewayMessage } from '../src/protocol.ts';
import { DEFAULT_BEHAVIOUR, type Behaviour } from './behaviour.ts';
import { planTrucks, TelemetryFaults, TruthLog, type Faults, type TruthEntry } from './faults.ts';
import { SiteModel, type AckResult, type Blasts, type SiteConfig, type TruckInit, type TruckTruth } from './model.ts';
import { matches, SiteRadio } from './radio.ts';
import { Rng } from './rng.ts';
import { toWire } from './wire.ts';
import type { ZoneState } from '../src/protocol.ts';

export interface FakeConfig {
  seed: number;
  site: SiteConfig;
  blasts?: Blasts;            // default 'random'
  trucks?: TruckInit[];       // placement for some or all trucks; the rest are spread by the seed
  behaviour?: Partial<Behaviour>;
  faults?: Faults;            // default none: milestone 1's perfect site. LIVE_DAY is the live catalogue
}

export interface Sink {
  write(line: string): void; // one NDJSON line, without the newline
  close(): void;
  behindBytes?(): number;    // bytes written but not yet read by the client, if the transport knows
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_COMMAND_ID = 128;

export class Connection {
  authed = false;
  closed = false;
  email: string | null = null;
  authTimer: TimerHandle | null = null;
  readonly #gw: FakeGateway;
  readonly #sink: Sink;

  constructor(gw: FakeGateway, sink: Sink) {
    this.#gw = gw;
    this.#sink = sink;
  }

  // A line from the client, without its newline.
  receive(line: string): void {
    if (this.closed) return;
    this.#gw.receive(this, line);
  }

  // The transport says the peer has gone.
  disconnect(): void {
    this.#gw.drop(this, false);
  }

  write(line: string): void {
    if (this.closed) return;
    // §1: a client more than about 4 MB behind on reading is disconnected.
    if ((this.#sink.behindBytes?.() ?? 0) > this.#gw.behaviour.maxBehindBytes) { this.#gw.slowReader(this); return; }
    this.#sink.write(line);
  }

  closeSink(): void {
    this.#sink.close();
  }
}

export class FakeGateway {
  readonly model: SiteModel;
  readonly behaviour: Readonly<Behaviour>;
  readonly faults: Readonly<Faults>;
  readonly truthLog = new TruthLog();
  readonly #clock: Clock;
  readonly #conns: Connection[] = [];
  readonly #seen = new Map<string, { key: string; ack: CommandAck }>();
  readonly #radio: SiteRadio;
  readonly #rngCommands: Rng;
  readonly #rngLink: Rng;
  readonly #timers: TimerHandle[] = [];
  #commandCount = 0;
  #linkDown: TruthEntry | null = null;
  #stalled: TruthEntry | null = null;
  #linkDropPlanned = false; // the first random drop waits for a CLOSING; later ones follow on

  constructor(clock: Clock, config: FakeConfig) {
    const faults: Faults = { ...config.faults };
    const b: Behaviour = { ...DEFAULT_BEHAVIOUR, ...(faults.bayClosing ? { blastBay: true } : {}), ...config.behaviour };
    this.behaviour = Object.freeze(b);
    this.faults = Object.freeze(faults);
    this.#clock = clock;
    this.model = new SiteModel(clock, (m) => this.#broadcast(m), {
      seed: config.seed, site: config.site, behaviour: b, blasts: config.blasts ?? 'random', trucks: config.trucks ?? [],
      log: this.truthLog,
    });
    this.#radio = new SiteRadio(clock, b, faults, this.truthLog, config.seed, (line) => this.#fanOut(line));
    const root = new Rng(config.seed);
    this.#rngCommands = root.fork('command-faults');
    this.#rngLink = root.fork('link');
    this.#setUpTruckFaults(config.seed);
  }

  start(): void {
    this.model.start();
    const lf = this.faults.linkDrops;
    if (Array.isArray(lf)) for (const d of lf) this.#later(d.atMs, () => this.#linkDrop(d.durationMs));
    for (const st of this.faults.linkStalls ?? []) {
      this.#later(st.atMs, () => {
        this.#stalled = this.truthLog.start(this.#clock.now(), null, 'link_stall', { durationMs: st.durationMs });
        this.#later(st.durationMs, () => { if (this.#stalled) this.#stalled.untilMs = this.#clock.now(); this.#stalled = null; });
      });
    }
  }

  stop(): void {
    this.model.stop();
    for (const t of this.#timers) this.#clock.clearTimeout(t);
    this.#timers.length = 0;
  }

  #later(ms: number, fn: () => void): void {
    this.#timers.push(this.#clock.setTimeout(fn, ms));
  }

  // Truth and fault access for tests.
  truth(id: string): TruckTruth { return this.model.truth(id); }
  truthAll(): TruckTruth[] { return this.model.truthAll(); }
  zone(id: string): ZoneState { return this.model.zone(id); }
  injectFault(id: string, code: string): void { this.model.injectFault(id, code); }
  get linkUp(): boolean { return this.#linkDown === null; }

  // Per-truck injectors: which truck and when come from the seed (fake/faults.ts planTrucks).
  #setUpTruckFaults(seed: number): void {
    const f = this.faults, b = this.behaviour, m = this.model, log = this.truthLog;
    const plan = planTrucks(f, m.site.vehicles, b, seed);
    const rng = new Rng(seed).fork('truck-faults');
    m.setQueuedDrops(f.queuedDrops === true);
    if (plan.clockSkew) {
      // Every controller's clock is a little off; one is about an hour ahead.
      for (const v of m.site.vehicles) m.setDeviceOffset(v, Math.round(rng.uniform(-b.clockJitterMs, b.clockJitterMs)));
      const skew = Math.round(rng.uniform(b.skewMinMs, b.skewMaxMs));
      m.setDeviceOffset(plan.clockSkew.vehicle, skew);
      log.start(m.startMs, plan.clockSkew.vehicle, 'clock_skew', { offsetMs: skew });
    }
    if (plan.weakPack) {
      // Both live weak packs were empty trucks on their way to load, and died on the climb after it.
      // Unless the truck is pinned, take an empty one that no motion or silence fault is on (a loaded
      // truck already past the load point would die within seconds); the dealt truck if there is none.
      let v = plan.weakPack.vehicle;
      if (typeof f.weakPack !== 'object' || f.weakPack.vehicle === undefined) {
        const busy = new Set([plan.frozenMoving, plan.frozenStationary, plan.silent, plan.hydPressureLow, plan.batteryDepleted].map((p) => p?.vehicle));
        const empty = m.site.vehicles.filter((x) => !busy.has(x) && !m.truth(x).loaded);
        if (empty.length > 0 && !empty.includes(v)) v = rng.pick(empty);
        plan.weakPack.vehicle = v;
      }
      m.weakPack(v, rng.uniform(b.weakFactorMin, b.weakFactorMax), rng.uniform(b.weakDiesMinFraction, b.weakDiesMaxFraction));
    }
    const hyd = plan.hydPressureLow, dep = plan.batteryDepleted;
    if (hyd) this.#later(hyd.atMs, () => m.injectFault(hyd.vehicle, 'HYD_PRESSURE_LOW'));
    if (dep) this.#later(dep.atMs, () => m.deplete(dep.vehicle));
    if (plan.frozenMoving || plan.frozenStationary || plan.silent || plan.seqReset || plan.fractionalSoc || plan.malformed) {
      m.setTelemetryFaults(new TelemetryFaults(plan, b, log, seed, m.startMs));
    }
  }

  // ---- link drops (§1: the whole site link; logins are accepted, then closed before hello) ----

  #linkDrop(durationMs: number): void {
    if (this.#linkDown) return;
    const now = this.#clock.now();
    this.#linkDown = this.truthLog.start(now, null, 'link_drop', { durationMs });
    for (const c of [...this.#conns]) this.drop(c, true);
    this.#later(durationMs, () => {
      if (this.#linkDown) this.#linkDown.untilMs = this.#clock.now();
      this.#linkDown = null;
    });
    if (this.faults.linkDrops === true) {
      const next = Math.round(this.#rngLink.uniform(this.behaviour.linkSpacingMinMs, this.behaviour.linkSpacingMaxMs));
      const duration = this.#randomLinkDuration();
      this.#later(next, () => this.#linkDrop(duration));
    }
  }

  #randomLinkDuration(): number {
    return Math.round(this.#rngLink.uniform(this.behaviour.linkDownMinMs, this.behaviour.linkDownMaxMs));
  }

  // The first random drop lands in a blast notice, as in both complete live runs: shortly after the
  // first CLOSING once the day is under way.
  #onZoneEvent(m: GatewayMessage): void {
    if (this.faults.linkDrops !== true || this.#linkDropPlanned) return;
    if (m.type !== 'zone_event' || m.status !== 'CLOSING') return;
    if (this.#clock.now() - this.model.startMs < this.behaviour.linkFirstAfterMs) return;
    this.#linkDropPlanned = true;
    const after = Math.round(this.#rngLink.uniform(0, this.behaviour.linkInNoticeMaxMs));
    const duration = this.#randomLinkDuration();
    this.#later(after, () => this.#linkDrop(duration));
  }

  slowReader(conn: Connection): void {
    this.truthLog.event(this.#clock.now(), null, 'slow_reader', { email: conn.email });
    this.drop(conn, true);
  }

  // A new connection from a transport. It must authenticate within the timeout.
  attach(sink: Sink): Connection {
    const conn = new Connection(this, sink);
    this.#conns.push(conn);
    conn.authTimer = this.#clock.setTimeout(() => {
      if (!conn.authed && !conn.closed) this.#authError(conn, 'AUTH_TIMEOUT');
    }, this.behaviour.authTimeoutMs);
    return conn;
  }

  // An in-process client, for tests.
  connect(): TestClient {
    return new TestClient(this);
  }

  receive(conn: Connection, line: string): void {
    if (Buffer.byteLength(line, 'utf8') > this.behaviour.maxLineBytes) { this.drop(conn, true); return; } // §7
    if (!conn.authed) { this.#auth(conn, line); return; }
    let m: unknown;
    try { m = JSON.parse(line); } catch { m = undefined; }
    if (!isObject(m)) { this.#sendAck(this.#ack('<unparseable>', null, { status: 'REJECTED', reason: 'BAD_JSON' }), '<unparseable>'); return; }
    if (m.type === 'command') this.#command(m);
    else if (m.type === 'drive') this.model.drive(m);
    // §7: anything else is ignored
  }

  drop(conn: Connection, closeSink: boolean): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.authTimer) this.#clock.clearTimeout(conn.authTimer);
    const i = this.#conns.indexOf(conn);
    if (i >= 0) this.#conns.splice(i, 1);
    if (closeSink) conn.closeSink();
  }

  #auth(conn: Connection, line: string): void {
    if (conn.authTimer) this.#clock.clearTimeout(conn.authTimer);
    let m: unknown;
    try { m = JSON.parse(line); } catch { this.#authError(conn, 'BAD_AUTH'); return; }
    if (!isObject(m) || m.type !== 'auth') { this.#authError(conn, 'AUTH_REQUIRED'); return; }
    if (typeof m.email !== 'string' || !EMAIL.test(m.email)) { this.#authError(conn, 'BAD_EMAIL'); return; }
    if (this.#conns.filter((c) => c.authed).length >= this.behaviour.maxConnections) { this.#authError(conn, 'TOO_MANY_CONNECTIONS'); return; }
    if (this.#linkDown) { this.drop(conn, true); return; } // §1: accepted, then closed before hello
    conn.authed = true;
    conn.email = m.email;
    conn.write(toWire(this.model.hello(m.email)));
  }

  #authError(conn: Connection, reason: AuthErrorReason): void {
    conn.write(toWire({ type: 'auth_error', reason }));
    this.drop(conn, true);
  }

  #command(m: Record<string, unknown>): void {
    const vehicle = typeof m.vehicle_id === 'string' ? m.vehicle_id : null;
    const action = String(m.action);
    const id = m.command_id;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_COMMAND_ID) {
      const echo = typeof id === 'string' && id.length > 0 ? id : '<missing>';
      this.#sendAck(this.#ack(echo, vehicle, { status: 'REJECTED', reason: 'BAD_COMMAND_ID' }), action);
      return;
    }
    const key = canonical(m);
    const prev = this.#seen.get(id);
    if (prev) {
      // §5: same payload returns the original result and does not execute again
      if (prev.key === key) this.#sendAck({ ...prev.ack, server_time_ms: this.#clock.now() }, action);
      else this.#sendAck(this.#ack(id, vehicle, { status: 'REJECTED', reason: 'COMMAND_ID_REUSED' }), action);
      return;
    }
    const n = ++this.#commandCount;
    const ignored = matches(this.faults.ignoredCommands, this.#rngCommands.chance(this.behaviour.ignoredProbability),
      { n, command_id: id, vehicle_id: vehicle ?? '', action });
    let result: AckResult;
    if (typeof m.operator_id !== 'string' || m.operator_id.length === 0) result = { status: 'REJECTED', reason: 'MISSING_OPERATOR' };
    else if (vehicle === null || !this.model.hasVehicle(vehicle)) result = { status: 'REJECTED', reason: 'UNKNOWN_VEHICLE' };
    else if (!(ACTIONS as readonly unknown[]).includes(m.action)) result = { status: 'REJECTED', reason: 'UNSUPPORTED_ACTION' };
    else {
      result = this.model.command({
        command_id: id, vehicle_id: vehicle, action: m.action as Action, operator_id: m.operator_id, force: m.force, lease_id: m.lease_id, ignored,
      });
    }
    const ack = this.#ack(id, vehicle, result);
    this.#seen.set(id, { key, ack });
    this.#sendAck(ack, action, n);
  }

  // Acks go through the radio: late and sometimes lost, when those faults are on.
  #sendAck(ack: CommandAck, action: string, n = 0): void {
    this.#radio.ack(toWire(ack), ack, n, action);
  }

  #ack(commandId: string, vehicle: string | null, r: AckResult): CommandAck {
    return {
      type: 'command_ack', command_id: commandId, vehicle_id: vehicle, status: r.status, server_time_ms: this.#clock.now(),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.holder !== undefined ? { holder: r.holder } : {}),
      ...(r.lease_id !== undefined ? { lease_id: r.lease_id } : {}),
      ...(r.lease_idle_timeout_ms !== undefined ? { lease_idle_timeout_ms: r.lease_idle_timeout_ms } : {}),
      ...(r.deadman_ms !== undefined ? { deadman_ms: r.deadman_ms } : {}),
    };
  }

  #broadcast(m: GatewayMessage): void {
    const line = toWire(m);
    if (m.type === 'telemetry') { this.#radio.telemetry(line, String(m.vehicle_id), m.seq); return; }
    if (m.type === 'zone_event') this.#onZoneEvent(m);
    this.#fanOut(line);
  }

  // Every authenticated client gets every line. Nothing is queued for a disconnected client (§1).
  #fanOut(line: string): void {
    if (this.#stalled) return; // a stalled link delivers nothing, and nothing is kept for later
    for (const c of [...this.#conns]) if (c.authed && !c.closed) c.write(line);
  }
}

// An in-process client: what a transport would deliver, as lines and parsed messages.
export class TestClient {
  readonly lines: string[] = [];
  readonly unparseable: string[] = [];
  closed = false;
  readonly #parsed: GatewayMessage[] = [];
  readonly #listeners: Array<(m: GatewayMessage) => void> = [];
  readonly #conn: Connection;
  #paused: string[] | null = null;
  #pausedBytes = 0;

  constructor(gw: FakeGateway) {
    this.#conn = gw.attach({
      write: (line) => {
        if (this.#paused) { this.#paused.push(line); this.#pausedBytes += Buffer.byteLength(line, 'utf8') + 1; return; }
        this.#read(line);
      },
      close: () => { this.closed = true; },
      behindBytes: () => this.#pausedBytes,
    });
  }

  #read(line: string): void {
    this.lines.push(line);
    let m: GatewayMessage;
    try { m = JSON.parse(line) as GatewayMessage; } catch { this.unparseable.push(line); return; } // truncated lines
    this.#parsed.push(m);
    for (const fn of this.#listeners) fn(m);
  }

  // A slow reader: stop reading, so lines pile up unread at the gateway; resume reads them all.
  pause(): void { this.#paused ??= []; }
  resume(): void {
    const lines = this.#paused ?? [];
    this.#paused = null;
    this.#pausedBytes = 0;
    for (const l of lines) this.#read(l);
  }

  send(msg: object | string): void {
    this.#conn.receive(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  messages(): GatewayMessage[] {
    return this.#parsed;
  }

  onMessage(fn: (m: GatewayMessage) => void): void {
    this.#listeners.push(fn);
  }

  close(): void {
    this.#conn.disconnect();
    this.closed = true;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// Key order does not make a different payload.
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (isObject(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
