// The fake gateway: connections, the auth flow (PROTOCOL.md §1.1), line parsing, command_id
// de-duplication (§5), and broadcast of everything to every client. The site itself is the model
// (fake/model.ts). Transports plug in through `attach`: the in-process TestClient below for tests,
// and fake/tls.ts for research/probe.py.
//
// Layers, so milestone 2 adds rather than rewrites: model (truth) -> telemetry built from it ->
// gateway (this file) -> Radio (one per client) -> transport. Radio faults (loss, duplicates,
// reordering, truncation, lost acks, link outages) replace PERFECT_RADIO; telemetry faults sit in
// the model's telemetry step; ACCEPTED-then-ignored sits where the model applies an effect.
import type { Clock, TimerHandle } from '../src/clock.ts';
import { ACTIONS, type Action, type AuthErrorReason, type CommandAck, type GatewayMessage } from '../src/protocol.ts';
import { DEFAULT_BEHAVIOUR, type Behaviour } from './behaviour.ts';
import { SiteModel, type AckResult, type Blasts, type SiteConfig, type TruckInit, type TruckTruth } from './model.ts';
import type { ZoneState } from '../src/protocol.ts';

export interface FakeConfig {
  seed: number;
  site: SiteConfig;
  blasts?: Blasts;            // default 'random'
  trucks?: TruckInit[];       // placement for some or all trucks; the rest are spread by the seed
  behaviour?: Partial<Behaviour>;
}

export interface Sink {
  write(line: string): void; // one NDJSON line, without the newline
  close(): void;
}

// Delivery of one line to one client. Milestone 1 delivers everything, at once, in order.
export interface Radio {
  deliver(conn: Connection, line: string): void;
}
export const PERFECT_RADIO: Radio = { deliver: (conn, line) => conn.write(line) };

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
    if (!this.closed) this.#sink.write(line);
  }

  closeSink(): void {
    this.#sink.close();
  }
}

export class FakeGateway {
  readonly model: SiteModel;
  readonly behaviour: Readonly<Behaviour>;
  readonly #clock: Clock;
  readonly #conns: Connection[] = [];
  readonly #seen = new Map<string, { key: string; ack: CommandAck }>();
  #radio: Radio = PERFECT_RADIO;

  constructor(clock: Clock, config: FakeConfig) {
    const b: Behaviour = { ...DEFAULT_BEHAVIOUR, ...config.behaviour };
    if (b.queueing !== 'spec') {
      throw new Error(`queueing '${String(b.queueing)}' is not modelled yet: only the spec version exists (TESTING.md L0.P, milestone 2)`);
    }
    this.behaviour = Object.freeze(b);
    this.#clock = clock;
    this.model = new SiteModel(clock, (m) => this.#broadcast(m), {
      seed: config.seed, site: config.site, behaviour: b, blasts: config.blasts ?? 'random', trucks: config.trucks ?? [],
    });
  }

  start(): void { this.model.start(); }
  stop(): void { this.model.stop(); }

  // For milestone 2's radio faults.
  setRadio(radio: Radio): void { this.#radio = radio; }

  // Truth and fault access for tests.
  truth(id: string): TruckTruth { return this.model.truth(id); }
  truthAll(): TruckTruth[] { return this.model.truthAll(); }
  zone(id: string): ZoneState { return this.model.zone(id); }
  injectFault(id: string, code: string): void { this.model.injectFault(id, code); }

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
    if (!isObject(m)) { this.#broadcast(this.#ack('<unparseable>', null, { status: 'REJECTED', reason: 'BAD_JSON' })); return; }
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
    conn.authed = true;
    conn.email = m.email;
    conn.write(JSON.stringify(this.model.hello(m.email)));
  }

  #authError(conn: Connection, reason: AuthErrorReason): void {
    conn.write(JSON.stringify({ type: 'auth_error', reason }));
    this.drop(conn, true);
  }

  #command(m: Record<string, unknown>): void {
    const vehicle = typeof m.vehicle_id === 'string' ? m.vehicle_id : null;
    const id = m.command_id;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_COMMAND_ID) {
      const echo = typeof id === 'string' && id.length > 0 ? id : '<missing>';
      this.#broadcast(this.#ack(echo, vehicle, { status: 'REJECTED', reason: 'BAD_COMMAND_ID' }));
      return;
    }
    const key = canonical(m);
    const prev = this.#seen.get(id);
    if (prev) {
      // §5: same payload returns the original result and does not execute again
      if (prev.key === key) this.#broadcast({ ...prev.ack, server_time_ms: this.#clock.now() });
      else this.#broadcast(this.#ack(id, vehicle, { status: 'REJECTED', reason: 'COMMAND_ID_REUSED' }));
      return;
    }
    let result: AckResult;
    if (typeof m.operator_id !== 'string' || m.operator_id.length === 0) result = { status: 'REJECTED', reason: 'MISSING_OPERATOR' };
    else if (vehicle === null || !this.model.hasVehicle(vehicle)) result = { status: 'REJECTED', reason: 'UNKNOWN_VEHICLE' };
    else if (!(ACTIONS as readonly unknown[]).includes(m.action)) result = { status: 'REJECTED', reason: 'UNSUPPORTED_ACTION' };
    else {
      result = this.model.command({
        command_id: id, vehicle_id: vehicle, action: m.action as Action, operator_id: m.operator_id, force: m.force, lease_id: m.lease_id,
      });
    }
    const ack = this.#ack(id, vehicle, result);
    this.#seen.set(id, { key, ack });
    this.#broadcast(ack);
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
    const line = JSON.stringify(m);
    for (const c of [...this.#conns]) if (c.authed && !c.closed) this.#radio.deliver(c, line);
  }
}

// An in-process client: what a transport would deliver, as lines and parsed messages.
export class TestClient {
  readonly lines: string[] = [];
  closed = false;
  readonly #parsed: GatewayMessage[] = [];
  readonly #listeners: Array<(m: GatewayMessage) => void> = [];
  readonly #conn: Connection;

  constructor(gw: FakeGateway) {
    this.#conn = gw.attach({
      write: (line) => {
        this.lines.push(line);
        let m: GatewayMessage;
        try { m = JSON.parse(line) as GatewayMessage; } catch { return; } // milestone 2 truncates lines
        this.#parsed.push(m);
        for (const fn of this.#listeners) fn(m);
      },
      close: () => { this.closed = true; },
    });
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
