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
import { Alerting, ENDS_ON_ACK } from './alerting.ts';
import { AlarmStore, type AlarmItem, type Person, type StoreEvent } from './attention.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { FleetSnapshot, FleetState } from './fleet.ts';
import type { GatewayLink, LinkStatus } from './link.ts';
import { PARAMS } from './params.ts';
import { ACTIONS, type Action } from './protocol.ts';
import { summarise, type Actor, type CommandRecord, type CommandRegistry, type RegistryEvent } from './registry.ts';
import type { Session, Sessions } from './sessions.ts';
import type { Store } from './store.ts';
import { TruckNotes, type TruckNote } from './trucknotes.ts';
import { auditLines, type AuditLine } from './ui/audit.ts';
import { heldBy, type HeldBy, type LeaseEnd } from './ui/detail.ts';
import { CallMemory, clearanceRows, siteLink, type ClearanceRow, type VerdictFn } from './ui/overview.ts';
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

export interface Notice { id: number; atServerMs: number; vehicleId: string | null; message: string }
export interface WhoView { id: string; name: string; role: User['role']; screens: number }

export interface LiveState {
  link: { state: LinkStatus['state']; reason: string; forMs: number; failures: number; nextAttemptInMs: number | null; authError: string | null };
  blastSafety: { active: false; note: string };
  who: WhoView[];
  leases: Array<{ vehicleId: string; operatorId: string; sinceServerMs: number }>;
  commands: CommandView[];
  attention: AlarmItem[];                 // the attention tray (src/attention.ts)
  clearance: ClearanceRow[];              // the zone clearance panel, UNSURE while the site link is down
  held: Record<string, HeldBy>;           // who left each holding truck there (L7.9)
  restarts: Record<string, number>;       // each truck's latest controller restart, server ms
}

// What one screen gets for the truck it has open (UI.md screen 2).
export interface TruckDetail { vehicleId: string; commands: CommandRecord[]; note: TruckNote }

export const BLAST_SAFETY_OFF = 'Blast safety is NOT active in this build: nothing stops a truck being sent into a closing zone, and no truck is evacuated automatically.';

export const MAX_SCREENS_PER_SESSION = 8;
const DETAIL_COMMANDS = 20;
const HISTORY_MAX_WINDOW = 6 * 3_600_000;
const HISTORY_MAX_ROWS = 200;
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
  watch: string | null; // the truck whose detail this screen has open
}

export interface LiveOptions {
  clock: Clock;
  fleet: FleetState;
  link: Pick<GatewayLink, 'status' | 'subscribe'>;
  registry: CommandRegistry;
  sessions: Sessions;
  log: (line: string) => void;
  store?: Store;                        // the audit log: alarm acknowledgements go in it, and the audit view reads it
  provisionalBlast?: () => boolean;     // the provisional can't-clear alarm; false once the blast engine raises its own
  verdict?: VerdictFn;                  // the clearance verdict; the blast engine's once it is wired in
}

export class LiveHub {
  readonly #o: LiveOptions;
  readonly #clients = new Set<Client>();
  readonly attention = new AlarmStore();
  readonly notes = new TruckNotes();
  readonly #alerting: Alerting;
  readonly #calls = new CallMemory();
  readonly #leaseEnds = new Map<string, LeaseEnd>();
  #clearance: ClearanceRow[] | null = null;
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
      if (e.type === 'message' && e.msg.type === 'lease_event') this.#leaseEvent(e.msg);
    }));
    this.#alerting = new Alerting({ fleet: o.fleet, link: o.link, registry: o.registry, store: this.attention, notes: this.notes, provisionalBlast: o.provisionalBlast ?? (() => true) });
    this.#unsub.push(() => this.#alerting.stop());
    this.#unsub.push(this.attention.subscribe((e) => this.#attentionEvent(e)));
    this.#unsub.push(o.registry.subscribe((e) => this.#registryEvent(e)));
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
    const c: Client = { sock, session, tokens: this.#burst(), tokensAt: this.#o.clock.now(), refusals: 0, overLimit: 0, closed: false, watch: null };
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
    this.#evaluate();
    if (!this.#dirty && now - this.#lastSent < PARAMS.liveFrameMaxInterval.value) return;
    const shared = this.#sharedFrame(true);
    const details = new Map<string, string>();
    for (const c of this.#clients) this.#push(c, shared, details);
  }

  // Alerting runs on every tick whether or not a screen is open (CONTEXT.md assumption 1): the
  // picture's alarms, re-alerts and escalation, and the clearance panel's last calls.
  #evaluate(): void {
    const snap = this.#o.fleet.snapshot();
    this.#alerting.evaluate(snap);
    this.attention.tick(snap.atServerMs, this.#present());
    this.#clearance = this.#clearanceOf(snap);
  }

  #clearanceOf(snap: FleetSnapshot): ClearanceRow[] {
    return clearanceRows(snap, { linkDown: siteLink(snap).state === 'down', memory: this.#calls, ...(this.#o.verdict ? { verdict: this.#o.verdict } : {}) });
  }

  #present(): Person[] {
    return this.#who().map((w) => ({ id: w.id, name: w.name, role: w.role }));
  }

  state(): LiveState {
    const now = this.#o.clock.now();
    const st = this.#o.link.status();
    const reg = this.#o.registry;
    return {
      link: {
        state: st.state, reason: st.reason, forMs: now - st.sinceMs, failures: st.failures,
        nextAttemptInMs: st.nextAttemptAtMs === null ? null : Math.max(0, st.nextAttemptAtMs - now), authError: st.authError,
      },
      blastSafety: { active: false, note: BLAST_SAFETY_OFF },
      who: this.#who(),
      leases: reg.leases().map((l) => ({ vehicleId: l.vehicleId, operatorId: l.operatorId, sinceServerMs: l.sinceServerMs })),
      commands: this.#commands(now),
      attention: this.attention.list(),
      clearance: this.#clearance ?? this.#clearanceOf(this.#o.fleet.snapshot()),
      held: this.#held(),
      restarts: Object.fromEntries(Object.entries(this.notes.all()).flatMap(([v, n]) => (n.restarts[0] ? [[v, n.restarts[0].atServerMs]] : []))),
    };
  }

  // ---- out ----

  #sharedFrame(forAll: boolean): string {
    if (forAll) {
      this.#dirty = false;
      this.#lastSent = this.#o.clock.now();
    }
    const site = this.#o.fleet.site;
    const frame = { site: site ? siteData(site) : null, snapshot: this.#o.fleet.snapshot(), live: this.state() };
    return JSON.stringify({ seq: ++this.#seq, sentServerMs: this.#o.fleet.serverNow(), frame });
  }

  #push(c: Client, shared: string, details = new Map<string, string>()): void {
    if (c.closed) return;
    if (c.sock.bufferedAmount > PARAMS.liveMaxBufferedBytes.value) return; // behind: skip, never queue old pictures
    const you = c.session.user;
    const notices = this.#notices.get(you.id) ?? [];
    let detail = 'null';
    if (c.watch) {
      detail = details.get(c.watch) ?? JSON.stringify(this.detail(c.watch));
      details.set(c.watch, detail);
    }
    this.#send(c, `{"type":"frame","you":${JSON.stringify({ id: you.id, name: you.name, role: you.role })},"notices":${JSON.stringify(notices)},"detail":${detail},"body":${shared}}`);
  }

  detail(vehicleId: string): TruckDetail {
    const commands = this.#o.registry.list({ vehicleId }).sort((a, b) => b.createdMs - a.createdMs).slice(0, DETAIL_COMMANDS);
    return { vehicleId, commands, note: this.notes.get(vehicleId) };
  }

  #held(): Record<string, HeldBy> {
    const out: Record<string, HeldBy> = {};
    const records = this.#o.registry.list();
    for (const t of this.#o.fleet.snapshot().trucks) {
      const h = heldBy(t, records, this.#leaseEnds.get(t.vehicleId));
      if (h) out[t.vehicleId] = h;
    }
    return out;
  }

  #leaseEvent(m: Record<string, unknown>): void {
    const v = typeof m.vehicle_id === 'string' ? m.vehicle_id : null;
    if (!v || !['RELEASED', 'EXPIRED', 'REVOKED'].includes(String(m.event))) return;
    const str = (x: unknown) => (typeof x === 'string' ? x : null);
    this.#leaseEnds.set(v, { vehicleId: v, operatorId: str(m.operator_id), event: String(m.event), reason: str(m.reason), by: str(m.by_operator), atServerMs: typeof m.server_time_ms === 'number' ? m.server_time_ms : this.#o.fleet.serverNow() });
  }

  // Interrupts, their acknowledgements and escalations go in the audit log beside the commands
  // (L8.5). Silent items come and go with the data and are not logged.
  #attentionEvent(e: StoreEvent): void {
    this.#dirty = true;
    const st = this.#o.store;
    const i = e.item;
    if (!st || !i.interrupt) return;
    const base = { atMs: this.#o.clock.now(), serverMs: this.#o.fleet.serverNow(), vehicleId: i.vehicleId, recordId: null, commandId: null, inputs: undefined };
    const sys = { ...base, actorKind: 'system' as const, actor: 'system', rule: i.rule.slice(0, 200) };
    try {
      if (e.type === 'alert' && (e.alert.why === 'raised' || e.alert.why === 'upgraded')) st.audit({ ...sys, event: 'alarm_raised', what: i.message, why: i.action });
      else if (e.type === 'escalated') st.audit({ ...sys, event: 'alarm_escalated', what: i.message, why: i.escalation?.words ?? null });
      else if (e.type === 'acknowledged' && i.ack) st.audit({ ...base, actorKind: 'operator', actor: i.ack.by, rule: null, event: 'alarm_acknowledged', what: `${i.ack.name} acknowledged: ${i.message}`, why: null });
      else if (e.type === 'cleared') st.audit({ ...sys, event: 'alarm_cleared', what: i.message, why: i.cleared?.reason ?? null });
    } catch (err) { this.#o.log(`could not write an alarm to the audit log: ${err instanceof Error ? err.message : String(err)}`); }
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
    if (e.type === 'notify') {
      for (const to of e.to) {
        const list = this.#notices.get(to) ?? [];
        list.unshift({ id: this.#nextId++, atServerMs: this.#o.fleet.serverNow(), vehicleId: e.vehicleId, message: e.message });
        this.#notices.set(to, list.slice(0, MAX_NOTICES));
      }
    }
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
        case 'ack': this.#ack(c, ref, msg); break;
        case 'watch': this.#watch(c, ref, msg); break;
        case 'history': this.#history(c, ref, msg); break;
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

  // An acknowledgement is the session's operator's, never the message's.
  #ack(c: Client, ref: string | null, m: Incoming): void {
    const key = m.key;
    if (typeof key !== 'string' || key.length > 200) { this.#refuse(c, ref, 'key must be an alarm key'); return; }
    const u = c.session.user;
    const out = this.attention.acknowledge(key, { id: u.id, name: u.name, role: u.role }, this.#o.fleet.serverNow());
    if (!out.ok) { this.#reply(c, ref, { ok: false, error: out.error }); return; }
    if (ENDS_ON_ACK.has(out.item.kind)) this.attention.clear(key, `acknowledged by ${u.name}`, this.#o.fleet.serverNow());
    this.#dirty = true;
    this.#reply(c, ref, { ok: true, key });
  }

  #watch(c: Client, ref: string | null, m: Incoming): void {
    const v = m.vehicleId;
    if (v !== null && (typeof v !== 'string' || !this.#o.fleet.snapshot().trucks.some((t) => t.vehicleId === v))) { this.#refuse(c, ref, 'vehicleId must be a truck id, or null'); return; }
    c.watch = v as string | null;
    this.#reply(c, ref, { ok: true, vehicleId: v });
    if (v) this.#push(c, this.#sharedFrame(false));
  }

  // The audit view (L8.4): every command on a truck open within the window around a moment.
  #history(c: Client, ref: string | null, m: Incoming): void {
    const v = m.vehicleId, at = m.atServerMs, w = m.windowMs ?? PARAMS.auditWindowDefault.value;
    if (typeof v !== 'string' || v.length > 64) { this.#refuse(c, ref, 'vehicleId must be a truck id'); return; }
    if (typeof at !== 'number' || !Number.isFinite(at)) { this.#refuse(c, ref, 'atServerMs must be a time'); return; }
    if (typeof w !== 'number' || !(w > 0) || w > HISTORY_MAX_WINDOW) { this.#refuse(c, ref, 'windowMs must be between 0 and 6 hours'); return; }
    if (!this.#o.store) { this.#refuse(c, ref, 'No command log in this service.'); return; }
    const rows = this.#o.store.history(v, at - w, at + w);
    const lines: AuditLine[] = auditLines(rows.slice(-HISTORY_MAX_ROWS), at);
    this.#reply(c, ref, { ok: true, history: { vehicleId: v, atServerMs: at, windowMs: w, lines, truncated: rows.length > HISTORY_MAX_ROWS } });
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
