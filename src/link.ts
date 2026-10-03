// The gateway link: one connection to the site per service, that recovers on its own and never
// lets an old picture pass for a current one (TESTING.md L2.40-L2.44, L6.1, L6.2, L6.4).
//
// - TLS to GATEWAY_HOST:GATEWAY_PORT, logging in with GATEWAY_EMAIL. Credentials come from the
//   environment only, and are never logged.
// - Reconnects with capped, jittered exponential backoff. A login accepted and then closed before
//   hello is a site-link outage (PROTOCOL.md §1.1), handled the same way.
// - Down after PARAMS.linkDownAfter with no heartbeat: the connection is dropped and redialled, and
//   fleet state is told, so nothing is shown as live meanwhile.
// - Every line goes to fleet state; then to subscribers (the command registry). On hello the
//   registry replays its in-flight commands.
// - Time and randomness are injected: backoff and watchdogs run on the Clock.
import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { Clock, TimerHandle } from './clock.ts';
import type { FleetState } from './fleet.ts';
import { parseLine } from './ingest.ts';
import { PARAMS } from './params.ts';
import { AUTH_ERRORS, type AuthErrorReason, type ClientMessage, type CommandMessage, type Hello } from './protocol.ts';
import type { CommandRegistry, CommandTransport } from './registry.ts';

// ---- transport ----

export interface LinkSocket {
  write(line: string): void; // one NDJSON line, without the newline
  close(): void;             // no onClose follows a close we asked for
}

export interface DialHandlers {
  onLine(line: string): void;
  onClose(reason: string): void;
}

export type Dialer = (h: DialHandlers) => LinkSocket;

// PROTOCOL.md §1: the gateway closes a connection that sends a line over 64 KiB. We refuse to send
// one, and treat a peer that sends a far longer one as broken.
export const MAX_LINE_BYTES = 64 * 1024;
const MAX_BUFFER_CHARS = 16 * MAX_LINE_BYTES;

export interface TlsTarget {
  host: string;
  port: number;
  ca?: string | Buffer; // tests only: the fake's throwaway certificate. Production uses the system's trust store
}

export function tlsDialer(t: TlsTarget): Dialer {
  return (h) => {
    const sock = tlsConnect({ host: t.host, port: t.port, ...(isIP(t.host) ? {} : { servername: t.host }), ...(t.ca ? { ca: t.ca } : {}) });
    sock.setNoDelay(true);
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let done = false;
    let why: string | null = null;
    const finish = (reason: string) => {
      if (done) return;
      done = true;
      h.onClose(reason);
    };
    sock.on('data', (chunk: Buffer) => {
      buf += decoder.write(chunk);
      let start = 0;
      for (let i = buf.indexOf('\n'); i >= 0 && !done; i = buf.indexOf('\n', start)) {
        const end = i > start && buf.charCodeAt(i - 1) === 13 ? i - 1 : i;
        h.onLine(buf.slice(start, end));
        start = i + 1;
      }
      buf = start === 0 ? buf : buf.slice(start);
      if (buf.length > MAX_BUFFER_CHARS && !done) {
        sock.destroy();
        finish(`the gateway sent a line over ${MAX_BUFFER_CHARS} characters`);
      }
    });
    sock.on('error', (e: Error) => { why = e.message; });
    sock.on('close', () => finish(why ? `connection failed: ${why}` : 'connection closed by the gateway'));
    return {
      write: (line) => { if (!done) sock.write(line + '\n'); },
      close: () => { done = true; sock.destroy(); },
    };
  };
}

export interface LinkConfig { host: string; port: number; email: string }

// GATEWAY_HOST, GATEWAY_PORT and GATEWAY_EMAIL (BRIEF.md). The error names what is missing and
// never echoes a value.
export function linkConfigFromEnv(env: Record<string, string | undefined>): LinkConfig {
  const missing = ['GATEWAY_HOST', 'GATEWAY_PORT', 'GATEWAY_EMAIL'].filter((k) => !env[k] || env[k]!.trim() === '');
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  const port = Number(env.GATEWAY_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('GATEWAY_PORT is not a port number');
  return { host: env.GATEWAY_HOST!.trim(), port, email: env.GATEWAY_EMAIL!.trim() };
}

// ---- the link ----

export type LinkState = 'idle' | 'connecting' | 'up' | 'down' | 'stopped';

export interface LinkStatus {
  state: LinkState;
  sinceMs: number;                  // on the injected clock
  reason: string;                   // why it is in this state, in words
  failures: number;                 // consecutive attempts since the last hello
  nextAttemptAtMs: number | null;
  dials: number;                    // connections opened, ever
  lastHeartbeatMs: number | null;
  authError: AuthErrorReason | null;
}

export type LinkEvent =
  | { type: 'status'; status: LinkStatus }
  | { type: 'up'; hello: Hello }
  | { type: 'down'; reason: string }        // only on leaving 'up'
  | { type: 'message'; msg: Record<string, unknown> & { type: string } }
  | { type: 'alarm'; message: string };

export interface LinkOptions {
  clock: Clock;
  fleet: FleetState;
  dial: Dialer;
  email: string;
  random?: () => number; // [0, 1); injected so backoff is reproducible in tests
}

const BUSY: ReadonlySet<string> = new Set<AuthErrorReason>(['TOO_MANY_CONNECTIONS', 'SERVER_FULL']);

export class GatewayLink implements CommandTransport {
  readonly #clock: Clock;
  readonly #fleet: FleetState;
  readonly #dial: Dialer;
  readonly #email: string;
  readonly #random: () => number;
  readonly #listeners = new Set<(e: LinkEvent) => void>();
  #socket: LinkSocket | null = null;
  #gen = 0;
  #status: LinkStatus;
  #retryTimer: TimerHandle | null = null;
  #helloTimer: TimerHandle | null = null;
  #watchdog: TimerHandle | null = null;
  #busy = false;

  constructor(o: LinkOptions) {
    this.#clock = o.clock;
    this.#fleet = o.fleet;
    this.#dial = o.dial;
    this.#email = o.email;
    this.#random = o.random ?? Math.random;
    this.#status = { state: 'idle', sinceMs: o.clock.now(), reason: 'not started', failures: 0, nextAttemptAtMs: null, dials: 0, lastHeartbeatMs: null, authError: null };
  }

  subscribe(fn: (e: LinkEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  status(): LinkStatus {
    return { ...this.#status };
  }

  isUp(): boolean {
    return this.#status.state === 'up';
  }

  // Starts the one connection. Calling it again while running does nothing (L6.4).
  start(): void {
    if (this.#status.state !== 'idle' && this.#status.state !== 'stopped') return;
    this.#status.authError = null;
    this.#status.failures = 0;
    this.#connect();
  }

  stop(): void {
    this.#clearTimers();
    this.#dropSocket();
    this.#set('stopped', 'stopped');
  }

  // Commands, from the registry only.
  send(msg: CommandMessage): boolean {
    return this.#write(msg);
  }

  // Drive messages, from the drive relay (a later task). Never queued, never re-sent: a message
  // that can't go now is dropped, and silence lets the deadman stop the truck.
  sendDrive(msg: Extract<ClientMessage, { type: 'drive' }>): boolean {
    return this.#write(msg);
  }

  #write(msg: ClientMessage): boolean {
    if (!this.isUp() || !this.#socket) return false;
    const line = JSON.stringify(msg);
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return false;
    this.#socket.write(line);
    return true;
  }

  // ---- connection lifecycle ----

  #connect(): void {
    this.#retryTimer = null;
    if (this.#socket) return; // one connection at a time, always
    const gen = ++this.#gen;
    this.#status.dials++;
    this.#status.nextAttemptAtMs = null;
    this.#set('connecting', `connecting (attempt ${this.#status.failures + 1})`);
    const socket = this.#dial({
      onLine: (line) => { if (gen === this.#gen) this.#line(line); },
      onClose: (reason) => { if (gen === this.#gen) this.#closed(reason); },
    });
    if (gen !== this.#gen) { socket.close(); return; } // closed while dialling
    this.#socket = socket;
    this.#helloTimer = this.#clock.setTimeout(() => {
      this.#helloTimer = null;
      if (gen === this.#gen && this.#status.state === 'connecting') this.#fail(`no hello within ${PARAMS.helloTimeout.value / 1000} s of logging in`);
    }, PARAMS.helloTimeout.value);
    socket.write(JSON.stringify({ type: 'auth', email: this.#email }));
  }

  #line(line: string): void {
    const p = parseLine(line);
    if (!p.ok) { this.#fleet.ingestLine(line); return; } // counted as data quality there
    const m = p.msg;
    if (m.type === 'auth_error') { this.#authError(m.reason); return; }
    if (m.type === 'hello') { this.#hello(m as unknown as Hello); return; }
    this.#fleet.ingest(m);
    if (m.type === 'heartbeat') this.#heartbeat();
    this.#emit({ type: 'message', msg: m });
  }

  #hello(h: Hello): void {
    if (this.#helloTimer) { this.#clock.clearTimeout(this.#helloTimer); this.#helloTimer = null; }
    this.#fleet.newConnection();
    this.#fleet.ingest(h);
    this.#status.failures = 0;
    this.#busy = false;
    this.#heartbeat();
    this.#set('up', 'connected');
    this.#fleet.setLink(true, 'connected');
    this.#emit({ type: 'up', hello: h });
  }

  #heartbeat(): void {
    this.#status.lastHeartbeatMs = this.#clock.now();
    if (this.#watchdog) this.#clock.clearTimeout(this.#watchdog);
    const gen = this.#gen;
    this.#watchdog = this.#clock.setTimeout(() => {
      this.#watchdog = null;
      if (gen === this.#gen && this.#status.state === 'up') {
        this.#fail(`no heartbeat for ${PARAMS.linkDownAfter.value / 1000} s`);
      }
    }, PARAMS.linkDownAfter.value);
  }

  #authError(reason: unknown): void {
    const r = (AUTH_ERRORS as readonly unknown[]).includes(reason) ? (reason as AuthErrorReason) : null;
    this.#status.authError = r;
    if (r !== null && BUSY.has(r)) {
      this.#busy = true;
      this.#fail(`the gateway refused the login: ${r === 'SERVER_FULL' ? 'it is full' : 'too many connections to this site'}; trying again`);
      return;
    }
    // Anything else will not fix itself by retrying: stop and say so.
    this.#clearTimers();
    this.#dropSocket();
    const message = `The gateway refused the login (${String(reason)}). The site link is stopped until someone fixes the configuration.`;
    this.#set('stopped', message);
    this.#fleet.setLink(false, message);
    this.#emit({ type: 'alarm', message });
  }

  #closed(reason: string): void {
    this.#socket = null;
    if (this.#status.state === 'connecting') {
      this.#fail(`login accepted, then closed before hello (site link outage): ${reason}`);
    } else {
      this.#fail(reason);
    }
  }

  // Lose the connection and schedule the next attempt.
  #fail(reason: string): void {
    const wasUp = this.#status.state === 'up';
    this.#clearTimers();
    this.#dropSocket();
    if (this.#status.state === 'stopped') return;
    const delay = this.#backoff(this.#status.failures);
    this.#status.failures++;
    this.#status.nextAttemptAtMs = this.#clock.now() + delay;
    this.#set('down', reason);
    this.#fleet.setLink(false, `site link down: ${reason}`);
    if (wasUp) this.#emit({ type: 'down', reason });
    this.#retryTimer = this.#clock.setTimeout(() => this.#connect(), delay);
  }

  // Exponential from the base, capped, with "equal jitter": between half and all of the step, so
  // two services never synchronise and a retry is never instant.
  #backoff(failures: number): number {
    const base = this.#busy ? PARAMS.linkBackoffBusyBase.value : PARAMS.linkBackoffBase.value;
    const cap = this.#busy ? PARAMS.linkBackoffBusyMax.value : PARAMS.linkBackoffMax.value;
    const step = Math.min(cap, base * 2 ** Math.min(failures, 20));
    return Math.round(step / 2 + this.#random() * (step / 2));
  }

  #dropSocket(): void {
    this.#gen++;
    const s = this.#socket;
    this.#socket = null;
    s?.close();
  }

  #clearTimers(): void {
    for (const t of [this.#retryTimer, this.#helloTimer, this.#watchdog]) if (t) this.#clock.clearTimeout(t);
    this.#retryTimer = this.#helloTimer = this.#watchdog = null;
  }

  #set(state: LinkState, reason: string): void {
    if (this.#status.state !== state) this.#status.sinceMs = this.#clock.now();
    this.#status.state = state;
    this.#status.reason = reason;
    this.#emit({ type: 'status', status: this.status() });
  }

  #emit(e: LinkEvent): void {
    for (const fn of this.#listeners) fn(e);
  }
}

// The registry hears everything the link hears, after fleet state has taken it in.
export function attachRegistry(link: GatewayLink, registry: CommandRegistry): () => void {
  return link.subscribe((e) => {
    if (e.type === 'up') registry.linkUp(e.hello);
    else if (e.type === 'down') registry.linkDown(e.reason);
    else if (e.type === 'message') registry.message(e.msg);
  });
}
