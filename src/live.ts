// The live connection to each operator's browser (task 6b scopes 3-5).
//
// Out: a frame (the fleet snapshot, zones, link status, open commands, leases, alarms, who's on) on
// change, at most every PARAMS.livePushMinInterval, and at least every PARAMS.liveFrameMaxInterval
// even when nothing arrived, so ages keep counting on screen and the browser can tell the service
// has gone (L9.3). Every browser gets the same picture; only "you" and the notices addressed to you
// differ. A browser that can't keep up skips frames; it is never sent a backlog of old pictures.
//
// In: commands. A message names an action and a truck; who sent it comes from the server's session,
// never from the message (L8.3). Anything malformed, hostile or too frequent is refused with a
// reason and logged, and never reaches the registry (L6.5). Drive messages are refused: the driving
// task adds the relay. Nothing here talks to the gateway; the registry does.
//
// Time is the injected clock.
import type { AlarmRaise } from './alarms.ts';
import type { BlastEngine, ZoneClearanceView } from './blast.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { FleetSnapshot, FleetState } from './fleet.ts';
import type { GatewayLink, LinkStatus } from './link.ts';
import { PARAMS } from './params.ts';
import { ACTIONS, type Action } from './protocol.ts';
import { summarise, type Actor, type CommandRecord, type CommandRegistry, type RegistryEvent } from './registry.ts';
import type { Session, Sessions } from './sessions.ts';
import { siteData } from './ui/track.ts';
import type { User } from './users.ts';

// What the service needs from a WebSocket (ws's WebSocket fits; tests use a fake).
export interface LiveSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

export interface CommandView {
  id: string;
  vehicleId: string;
  action: Action;
  by: string;              // operator id, or "system:<rule>"
  status: CommandRecord['status'];
  summary: string;
  createdServerMs: number;
  attempts: number;
  maxAttempts: number;
  open: boolean;
  waitingForLink: boolean; // pending, not sent: the site link is down (L7.8)
  needsReconfirm: boolean; // waited too long: confirm again or cancel
  failure: string | null;
}

export interface Alarm { id: number; atServerMs: number; kind: string; vehicleId: string | null; message: string }
export interface Notice { id: number; atServerMs: number; vehicleId: string | null; message: string }
export interface WhoView { id: string; name: string; role: User['role']; screens: number }

export interface LiveState {
  link: { state: LinkStatus['state']; reason: string; forMs: number; failures: number; nextAttemptInMs: number | null; authError: string | null };
  blastSafety: { active: boolean; note: string };
  clearance: ZoneClearanceView[]; // the engine's verdict per zone not open, with the last call made with the link up (B11, B13)
  blastAlarms: AlarmRaise[];      // the engine's open can't-clear and link-down alarms (src/alarms.ts shape)
  who: WhoView[];
  leases: Array<{ vehicleId: string; operatorId: string; sinceServerMs: number }>;
  commands: CommandView[];
  alarms: Alarm[];
}

export const BLAST_SAFETY_OFF = 'Blast safety is NOT active in this build: nothing stops a truck being sent into a closing zone, and no truck is evacuated automatically.';
export const BLAST_SAFETY_ON = 'Blast safety is active: the blast engine evacuates and holds trucks for closing zones, and checks every command.';

export const MAX_SCREENS_PER_SESSION = 8;
const MAX_ALARMS = 50;
const MAX_NOTICES = 20;
const MAX_TEXT = 4_096;          // a browser message, in bytes (ws refuses larger frames itself)
const REFUSALS_BEFORE_CLOSE = 50;
const LOGGED_REFUSALS = 20;      // per socket; after that, every 100th
const SETTLE_CLOSED = new Set(['confirmed', 'failed', 'refused', 'expired', 'cancelled', 'superseded']);

type Incoming = Record<string, unknown>;

interface Client {
  sock: LiveSocket;
  session: Session;
  tokens: number;
  tokensAt: number;
  refusals: number;
  overLimit: number;
  closed: boolean;
}

export interface LiveOptions {
  clock: Clock;
  fleet: FleetState;
  link: Pick<GatewayLink, 'status' | 'subscribe'>;
  registry: CommandRegistry;
  sessions: Sessions;
  log: (line: string) => void;
  blast?: Pick<BlastEngine, 'clearances' | 'openAlarms' | 'subscribe'>;
  blastSafetyActive?: boolean; // true only when the registry's safety gate is the blast engine's
}

export class LiveHub {
  readonly #o: LiveOptions;
  readonly #clients = new Set<Client>();
  readonly #alarms: Alarm[] = [];
  readonly #notices = new Map<string, Notice[]>();
  #nextId = 1;
  #seq = 0;
  #dirty = true;
  #lastSent = Number.NEGATIVE_INFINITY;
  #timer: TimerHandle | null = null;
  readonly #unsub: Array<() => void> = [];

  constructor(o: LiveOptions) {
    this.#o = o;
    const dirty = () => { this.#dirty = true; };
    this.#unsub.push(o.fleet.subscribe(dirty));
    this.#unsub.push(o.link.subscribe((e) => {
      this.#dirty = true;
      if (e.type === 'alarm') this.#alarm('site_link', null, e.message);
    }));
    this.#unsub.push(o.registry.subscribe((e) => this.#registryEvent(e)));
    if (o.blast) {
      this.#unsub.push(o.blast.subscribe((e) => {
        this.#dirty = true;
        if (e.type === 'raise') this.#alarm(e.kind, e.vehicleId, `${e.message} ${e.action ?? ''}`.trim());
        else if (e.type === 'notify') this.#registryEvent({ type: 'notify', to: e.to, vehicleId: e.vehicleId, recordId: null, message: e.message });
      }));
    }
    this.#unsub.push(o.sessions.onEnd((s) => this.closeSession(s.id, 'session ended')));
  }

  start(): void {
    this.stop();
    const loop = () => { this.tick(); this.#timer = this.#o.clock.setTimeout(loop, PARAMS.livePushMinInterval.value); };
    this.#timer = this.#o.clock.setTimeout(loop, PARAMS.livePushMinInterval.value);
  }

  stop(): void {
    if (this.#timer) this.#o.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  shutdown(): void {
    this.stop();
    for (const c of [...this.#clients]) this.#drop(c, 1001, 'service stopping');
    for (const u of this.#unsub) u();
  }

  get clientCount(): number { return this.#clients.size; }

  // Screens open on one session. The HTTP layer refuses more than MAX_SCREENS_PER_SESSION, so one
  // login can't open thousands of sockets.
  screensOf(sessionId: string): number {
    let n = 0;
    for (const c of this.#clients) if (c.session.id === sessionId) n++;
    return n;
  }

  // A browser has connected with a session the HTTP layer has already checked.
  connect(sock: LiveSocket, session: Session): { receive(data: unknown, isBinary: boolean): void; closed(): void } {
    const c: Client = { sock, session, tokens: this.#burst(), tokensAt: this.#o.clock.now(), refusals: 0, overLimit: 0, closed: false };
    this.#clients.add(c);
    this.#o.log(`browser connected: ${session.user.id} (${session.user.role}); ${this.#clients.size} open`);
    this.#push(c, this.#sharedFrame(false)); // its first picture at once
    this.#dirty = true;                       // and everyone else's who's-on changed
    return {
      receive: (data, isBinary) => this.#receive(c, data, isBinary),
      closed: () => {
        if (!this.#clients.delete(c)) return;
        c.closed = true;
        this.#dirty = true;
        this.#o.log(`browser disconnected: ${session.user.id}; ${this.#clients.size} open`);
      },
    };
  }

  // Logout or expiry: that session's screens are closed at once.
  closeSession(sessionId: string, reason: string): void {
    for (const c of [...this.#clients]) if (c.session.id === sessionId) this.#drop(c, 4401, reason);
  }

  // Runs on the timer; by hand in tests.
  tick(): void {
    const now = this.#o.clock.now();
    for (const c of [...this.#clients]) {
      // An open screen keeps its session alive; an ended session closes its screens.
      if (!this.#o.sessions.get(c.session.id)) { this.#drop(c, 4401, 'session ended'); continue; }
      this.#o.sessions.touch(c.session.id);
    }
    if (!this.#dirty && now - this.#lastSent < PARAMS.liveFrameMaxInterval.value) return;
    const shared = this.#sharedFrame(true);
    for (const c of this.#clients) this.#push(c, shared);
  }

  state(snap?: FleetSnapshot): LiveState {
    const now = this.#o.clock.now();
    const active = this.#o.blastSafetyActive === true;
    const st = this.#o.link.status();
    const reg = this.#o.registry;
    return {
      link: {
        state: st.state, reason: st.reason, forMs: now - st.sinceMs, failures: st.failures,
        nextAttemptInMs: st.nextAttemptAtMs === null ? null : Math.max(0, st.nextAttemptAtMs - now), authError: st.authError,
      },
      blastSafety: { active, note: active ? BLAST_SAFETY_ON : BLAST_SAFETY_OFF },
      clearance: this.#o.blast ? this.#o.blast.clearances(snap ?? this.#o.fleet.snapshot()) : [],
      blastAlarms: this.#o.blast ? this.#o.blast.openAlarms() : [],
      who: this.#who(),
      leases: reg.leases().map((l) => ({ vehicleId: l.vehicleId, operatorId: l.operatorId, sinceServerMs: l.sinceServerMs })),
      commands: this.#commands(now),
      alarms: [...this.#alarms],
    };
  }

  // ---- out ----

  #sharedFrame(forAll: boolean): string {
    if (forAll) {
      this.#dirty = false;
      this.#lastSent = this.#o.clock.now();
    }
    const site = this.#o.fleet.site;
    const snapshot = this.#o.fleet.snapshot();
    const frame = { site: site ? siteData(site) : null, snapshot, live: this.state(snapshot) };
    return JSON.stringify({ seq: ++this.#seq, sentServerMs: this.#o.fleet.serverNow(), frame });
  }

  #push(c: Client, shared: string): void {
    if (c.closed) return;
    if (c.sock.bufferedAmount > PARAMS.liveMaxBufferedBytes.value) return; // behind: skip, never queue old pictures
    const you = c.session.user;
    const notices = this.#notices.get(you.id) ?? [];
    this.#send(c, `{"type":"frame","you":${JSON.stringify({ id: you.id, name: you.name, role: you.role })},"notices":${JSON.stringify(notices)},"body":${shared}}`);
  }

  #send(c: Client, text: string): void {
    try { c.sock.send(text); } catch (e) { this.#o.log(`send to ${c.session.user.id} failed: ${e instanceof Error ? e.message : String(e)}`); this.#drop(c, 1011, 'send failed'); }
  }

  #reply(c: Client, ref: string | null, body: Record<string, unknown>): void {
    this.#send(c, JSON.stringify({ type: 'result', ref, ...body }));
  }

  #who(): WhoView[] {
    const by = new Map<string, WhoView>();
    for (const c of this.#clients) {
      const u = c.session.user;
      const w = by.get(u.id) ?? { id: u.id, name: u.name, role: u.role, screens: 0 };
      w.screens++;
      by.set(u.id, w);
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Open commands, plus the latest on each truck whatever its state, newest first.
  #commands(now: number): CommandView[] {
    const all = this.#o.registry.list();
    const latest = new Map<string, CommandRecord>();
    for (const r of all) {
      const prev = latest.get(r.vehicleId);
      if (!prev || r.createdMs >= prev.createdMs) latest.set(r.vehicleId, r);
    }
    const keep = all.filter((r) => !SETTLE_CLOSED.has(r.status) || latest.get(r.vehicleId) === r);
    return keep.sort((a, b) => b.createdMs - a.createdMs).map((r) => view(r, now));
  }

  #registryEvent(e: RegistryEvent): void {
    this.#dirty = true;
    if (e.type === 'alarm') this.#alarm(e.kind, e.vehicleId, e.message);
    else if (e.type === 'notify') {
      for (const to of e.to) {
        const list = this.#notices.get(to) ?? [];
        list.unshift({ id: this.#nextId++, atServerMs: this.#o.fleet.serverNow(), vehicleId: e.vehicleId, message: e.message });
        this.#notices.set(to, list.slice(0, MAX_NOTICES));
      }
    }
  }

  #alarm(kind: string, vehicleId: string | null, message: string): void {
    this.#alarms.unshift({ id: this.#nextId++, atServerMs: this.#o.fleet.serverNow(), kind, vehicleId, message });
    this.#alarms.length = Math.min(this.#alarms.length, MAX_ALARMS);
    this.#dirty = true;
  }

  // ---- in ----

  #receive(c: Client, data: unknown, isBinary: boolean): void {
    if (c.closed) return;
    try {
      this.#o.sessions.touch(c.session.id);
      if (!this.#o.sessions.get(c.session.id)) { this.#drop(c, 4401, 'session ended'); return; }
      if (!this.#take(c)) {
        // A flood: refused, and the socket closed if it keeps on.
        if (++c.overLimit >= REFUSALS_BEFORE_CLOSE) { this.#o.log(`closing ${c.session.user.id}'s connection: ${c.overLimit} messages over the limit`); this.#drop(c, 1008, 'too many messages'); return; }
        this.#refuse(c, null, 'too many messages: slow down');
        return;
      }
      if (isBinary) { this.#refuse(c, null, 'binary messages are not accepted'); return; }
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;
      if (text === null || Buffer.byteLength(text, 'utf8') > MAX_TEXT) { this.#refuse(c, null, 'message too large or not text'); return; }
      let m: unknown;
      try { m = JSON.parse(text); } catch { this.#refuse(c, null, 'not JSON'); return; }
      if (m === null || typeof m !== 'object' || Array.isArray(m)) { this.#refuse(c, null, 'not a JSON object'); return; }
      const msg = m as Incoming;
      const ref = typeof msg.ref === 'string' && /^[\w-]{1,64}$/.test(msg.ref) ? msg.ref : null;
      switch (msg.type) {
        case 'command': this.#command(c, ref, msg); break;
        case 'cancel': case 'reconfirm': this.#pending(c, ref, msg); break;
        case 'drive':
          // No drive path yet (L6.3's drive half waits for the driving task). Refused, and nothing is
          // sent to the gateway: the truck's deadman stops it.
          this.#refuse(c, ref, 'Driving from the browser is not available in this build yet. Nothing was sent to the truck.');
          break;
        default: this.#refuse(c, ref, `unknown message type ${JSON.stringify(String(msg.type)).slice(0, 40)}`);
      }
    } catch (e) {
      // Never let one browser's message take the service down.
      this.#o.log(`error handling a message from ${c.session.user.id}: ${e instanceof Error ? e.message : String(e)}`);
      this.#reply(c, null, { ok: false, error: 'The service could not handle that message.' });
    }
  }

  #command(c: Client, ref: string | null, m: Incoming): void {
    const action = m.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) { this.#refuse(c, ref, 'unknown action'); return; }
    const vehicleId = m.vehicleId;
    if (typeof vehicleId !== 'string' || vehicleId.length > 64) { this.#refuse(c, ref, 'vehicleId must be a truck id'); return; }
    const roster = this.#o.fleet.snapshot().trucks.filter((t) => t.onRoster === true).map((t) => t.vehicleId);
    if (roster.length === 0) { this.#refuse(c, ref, 'No site description yet (no hello from the gateway), so no truck can be commanded.'); return; }
    if (!roster.includes(vehicleId)) { this.#refuse(c, ref, `${vehicleId} is not a truck on this site`); return; }
    if (m.force !== undefined && typeof m.force !== 'boolean') { this.#refuse(c, ref, 'force must be true or false'); return; }
    if (m.force === true && action !== 'TAKE_CONTROL') { this.#refuse(c, ref, 'force applies only to TAKE_CONTROL'); return; }
    if (m.why !== undefined && (typeof m.why !== 'string' || m.why.length > 200)) { this.#refuse(c, ref, 'why must be text, up to 200 characters'); return; }
    // L8.3: the operator is the session's. Anything in the message that claims otherwise is ignored,
    // and noted, because a browser that sends it is either out of date or trying something.
    const claimed = ['operator_id', 'operatorId', 'operator', 'actor', 'role', 'user'].filter((k) => k in m);
    if (claimed.length) this.#o.log(`ignored ${claimed.join(', ')} in a command from ${c.session.user.id}: the operator comes from the session`);
    const rec = this.#o.registry.submit(
      { vehicleId, action: action as Action, ...(m.force === true ? { force: true } : {}), ...(typeof m.why === 'string' && m.why.trim() ? { why: m.why.trim() } : {}) },
      this.#actor(c.session),
    );
    this.#dirty = true;
    this.#reply(c, ref, { ok: rec.status !== 'refused', command: view(rec, this.#o.clock.now()) });
  }

  // Cancel or confirm again a command waiting for the site link (L7.8). Cancelling an e-stop takes
  // away a stop someone asked for, so only whoever pressed it, or a supervisor, may.
  #pending(c: Client, ref: string | null, m: Incoming): void {
    const id = m.recordId;
    if (typeof id !== 'string' || id.length > 100) { this.#refuse(c, ref, 'recordId must be a command id'); return; }
    const rec = this.#o.registry.get(id);
    if (!rec) { this.#refuse(c, ref, 'no such command'); return; }
    const actor = this.#actor(c.session);
    if (m.type === 'cancel') {
      const own = rec.actor.kind === 'operator' && rec.actor.operatorId === c.session.user.id;
      if (!own && c.session.user.role !== 'supervisor') { this.#refuse(c, ref, `Only ${rec.actor.kind === 'operator' ? rec.actor.operatorId : 'the system'} or a supervisor can cancel this ${rec.action}.`); return; }
      const out = this.#o.registry.cancel(id, actor)!;
      this.#reply(c, ref, { ok: out.status === 'cancelled', command: view(out, this.#o.clock.now()) });
    } else {
      const out = this.#o.registry.reconfirm(id, actor)!;
      this.#reply(c, ref, { ok: true, command: view(out, this.#o.clock.now()) });
    }
    this.#dirty = true;
  }

  #actor(s: Session): Actor {
    return { kind: 'operator', operatorId: s.user.id, role: s.user.role };
  }

  #burst(): number { return PARAMS.browserMessagesPerSecond.value * 2; }

  #take(c: Client): boolean {
    const now = this.#o.clock.now();
    c.tokens = Math.min(this.#burst(), c.tokens + ((now - c.tokensAt) / 1000) * PARAMS.browserMessagesPerSecond.value);
    c.tokensAt = now;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  #refuse(c: Client, ref: string | null, reason: string): void {
    c.refusals++;
    if (c.refusals <= LOGGED_REFUSALS || c.refusals % 100 === 0) this.#o.log(`browser message refused (${c.session.user.id}, refusal ${c.refusals}): ${reason}`);
    this.#reply(c, ref, { ok: false, error: reason });
  }

  #drop(c: Client, code: number, reason: string): void {
    if (c.closed) return;
    c.closed = true;
    this.#clients.delete(c);
    this.#dirty = true;
    try { c.sock.close(code, reason); } catch { /* already gone */ }
    this.#o.log(`browser closed by the service: ${c.session.user.id} (${reason}); ${this.#clients.size} open`);
  }
}

function view(r: CommandRecord, now: number): CommandView {
  return {
    id: r.id, vehicleId: r.vehicleId, action: r.action,
    by: r.actor.kind === 'operator' ? r.actor.operatorId : `system:${r.actor.rule}`,
    status: r.status, summary: summarise(r, now), createdServerMs: r.createdServerMs,
    attempts: r.attempts.length, maxAttempts: r.maxAttempts, open: !SETTLE_CLOSED.has(r.status),
    waitingForLink: r.status === 'pending' && r.hold !== null, needsReconfirm: r.hold?.needsReconfirm ?? false,
    failure: r.failure?.message ?? null,
  };
}
