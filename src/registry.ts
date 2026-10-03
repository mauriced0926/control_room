// The command registry: the one place that sends commands to trucks, knows what actually happened
// to each, and writes it down (TESTING.md L2.30-L2.39, L6.6, L7.8, L8.1-L8.5).
//
// Everything that commands a truck (operators, the blast engine, auto-resume) calls submit(). The
// lifecycle of a command:
//
//   pending ──> sent ──> acknowledged ──> confirmed      (the effect seen in telemetry)
//      │          │            │
//      │          └────────────┴──> retried under a new command_id when the deadline passes with
//      │                            no effect, up to a set number of attempts; then failed
//      ├──> refused     the safety gate (or a local rule) said no; never sent
//      ├──> cancelled   an operator cancelled it while it waited for the link
//      └──> expired     too old to send after an outage or a restart
//   any open command ──> superseded, when a newer command on the same truck replaces it
//   any open command ──> failed, with the site's reason in the operator's words
//
// Rules this file exists to enforce:
// - ACCEPTED is not done. Only telemetry confirms a command (CONTEXT.md finding 3).
// - Acks are matched to the latest send of their command_id by time, never by counting (matchAck;
//   AI_LOG.md entries 1 and 4). Every tool that reads acks uses matchAck / AckBook from here.
// - A command is written to the database before it is handed to the link (L6.6).
// - A refusal is never retried; a retry is never sent blind (EXIT_ZONE) and never displaces a
//   different command of ours on the same truck, because a newer command supersedes the older.
// - Time is the injected clock; nothing here reads the wall clock.
import type { Clock, TimerHandle } from './clock.ts';
import type { FleetState, TruckView } from './fleet.ts';
import { zoneExit } from './geometry.ts';
import { PARAMS } from './params.ts';
import { ACTIONS, type Action, type CommandMessage, type Hello, type VehicleState } from './protocol.ts';
import { refusal, type Refusal } from './refusals.ts';
import type { AuditEntry, Store } from './store.ts';

// ---- ack matching: the one implementation (L2.33) ----

export interface SendTime { atMs: number }

// The send an ack belongs to: the latest send of its command_id at or before the moment the ack
// was received. -1 if no send precedes it. Never "the nth ack is for the nth send": acks are lost
// on the radio, and resending an id returns the original result (PROTOCOL.md §5).
export function matchAck(sends: readonly SendTime[], ackRxMs: number): number {
  let best = -1;
  for (let i = 0; i < sends.length; i++) {
    const s = sends[i]!;
    if (s.atMs <= ackRxMs && (best < 0 || s.atMs >= sends[best]!.atMs)) best = i;
  }
  return best;
}

// Sends and acks by command_id, for the registry and for any tool that reads acks.
export class AckBook {
  readonly #sends = new Map<string, Array<{ atMs: number; acked: boolean }>>();

  sent(commandId: string, atMs: number, acked = false): number {
    const list = this.#sends.get(commandId) ?? [];
    list.push({ atMs, acked });
    this.#sends.set(commandId, list);
    return list.length - 1;
  }

  // Which send an ack is for, and whether that send already had one (a duplicate, L2.32). Null when
  // none of our sends of that id precedes it: someone else's command, or not ours at all.
  ack(commandId: string, rxMs: number): { sendIndex: number; duplicate: boolean } | null {
    const list = this.#sends.get(commandId);
    if (!list) return null;
    const i = matchAck(list, rxMs);
    if (i < 0) return null;
    const s = list[i]!;
    const duplicate = s.acked;
    s.acked = true;
    return { sendIndex: i, duplicate };
  }

  has(commandId: string): boolean {
    return this.#sends.has(commandId);
  }
}

// ---- the safety check below every caller ----

export interface GateRequest {
  record: Readonly<CommandRecord>;
  attempt: number;   // 1 for the first send; more for retries
  replay: boolean;   // the same command_id again, after a reconnect or restart
  truck: TruckView | undefined;
}

export type GateVerdict = { allow: true } | { allow: false; code: string; reason: string };

// Asked before every send, operators' and the system's alike. The blast engine implements it.
export interface SafetyGate {
  check(req: GateRequest): GateVerdict;
}

// Allows everything. A placeholder until the blast engine provides the real gate: with it, nothing
// stops an operator sending a truck into a closing zone. The name is meant to be noticed.
export const ALLOW_ALL_GATE_NO_BLAST_SAFETY: SafetyGate = Object.freeze({
  check: (): GateVerdict => ({ allow: true }),
});

// ---- records ----

export type CommandStatus = 'pending' | 'sent' | 'acknowledged' | 'confirmed' | 'failed' | 'refused' | 'expired' | 'cancelled' | 'superseded';
export const OPEN_STATUSES: ReadonlySet<CommandStatus> = new Set<CommandStatus>(['pending', 'sent', 'acknowledged']);

export type Role = 'operator' | 'supervisor';

// Who asked. Always from the server's session or the rule that fired, never from a browser payload.
export type Actor =
  | { kind: 'operator'; operatorId: string; role: Role }
  | { kind: 'system'; rule: string; inputs?: unknown };

export interface SendInfo { atMs: number; serverMs: number; replay: boolean; ackRxMs: number | null }

export interface AckInfo {
  status: 'ACCEPTED' | 'REJECTED';
  reason: string | null;
  holder: string | null;
  leaseId: string | null;
  serverMs: number | null;
  rxMs: number;
  sendIndex: number;
}

export interface Attempt {
  n: number;
  commandId: string;
  sends: SendInfo[];
  ack: AckInfo | null;
  duplicateAcks: number;
}

export type WorkState = 'LOADING' | 'DUMPING' | 'CHARGING';

export interface CommandRecord {
  id: string;
  vehicleId: string;
  action: Action;
  force: boolean;
  leaseId: string | null;
  actor: Actor;
  why: string | null;
  createdMs: number;
  createdServerMs: number;
  updatedMs: number;
  closedServerMs: number | null;
  status: CommandStatus;
  attempts: Attempt[];
  maxAttempts: number;
  // Waiting for the link before its first send (L7.8). Sent by itself only until autoSendUntilMs.
  hold: { sinceMs: number; autoSendUntilMs: number; needsReconfirm: boolean } | null;
  deadlineMs: number | null;   // when the current attempt must show its effect; null: none (behind CHARGING)
  queued: { behind: WorkState; sinceMs: number; estimateMs: number | null } | null;
  targetZone: string | null;   // EXIT_ZONE: the zone it was in when sent
  baselineState: string | null; // what the truck reported doing when the command was first sent
  started: { atMs: number; detail: string } | null; // EXIT_ZONE under way
  effect: { atMs: number; serverMs: number; detail: string; ackReceived: boolean } | null;
  pendingRefusal: { code: string; message: string; ourFault: boolean } | null; // a retry refused; waiting to see if an earlier attempt worked
  failure: { code: string; message: string; ourFault: boolean } | null;
  supersededBy: string | null;
  summary: string;
}

export interface SubmitRequest {
  vehicleId: string;
  action: Action;
  force?: boolean;       // TAKE_CONTROL only; supervisors only (L8.2)
  leaseId?: string;      // RELEASE_CONTROL; filled from the lease book when omitted
  why?: string;          // the operator's or the rule's reason, for the log
}

export interface LeaseInfo { vehicleId: string; operatorId: string; leaseId: string | null; sinceServerMs: number }

export type RegistryEvent =
  | { type: 'command'; record: CommandRecord }
  | { type: 'notify'; to: string[]; vehicleId: string; recordId: string | null; message: string }
  | { type: 'alarm'; kind: 'command_failed' | 'estop_undelivered'; vehicleId: string; recordId: string; message: string }
  | { type: 'lease'; vehicleId: string; lease: LeaseInfo | null; message: string };

// What the registry needs from the link: is it up, and send one command. The link writes it.
export interface CommandTransport {
  isUp(): boolean;
  send(msg: CommandMessage): boolean; // false: not sent (the link is down)
}

export interface RegistryOptions {
  clock: Clock;
  fleet: FleetState;
  store: Store;
  transport: CommandTransport;
  gate: SafetyGate;
  newId?: () => string;                                      // record ids
  commandIdFor?: (recordId: string, attempt: number) => string; // the gateway's command_id per attempt
  systemOperatorId?: string;                                 // operator_id the gateway sees for the system
  keepClosed?: number;                                       // closed records kept in memory
}

// ---- action classes ----

const SUPERVISORY: ReadonlySet<Action> = new Set<Action>(['HOLD', 'RESUME', 'RETURN_TO_BAY', 'EXIT_ZONE']);
const QUEUEABLE: ReadonlySet<Action> = new Set<Action>(['HOLD', 'RETURN_TO_BAY', 'EXIT_ZONE']); // PROTOCOL.md §5 Queuing
const IMMEDIATE: ReadonlySet<Action> = new Set<Action>(['ESTOP', 'TAKE_CONTROL', 'RELEASE_CONTROL']);  // §5: on receipt
const WORK: ReadonlySet<string> = new Set<WorkState>(['LOADING', 'DUMPING', 'CHARGING']);
const DUTY_CYCLE: ReadonlySet<string> = new Set<VehicleState>(['TRAMMING', 'LOADING', 'DUMPING', 'CHARGING']);
// Refusals the registry gives itself, not the site.
const LOCAL = { forceNeedsSupervisor: 'FORCE_NEEDS_SUPERVISOR', unknownAction: 'UNSUPPORTED_ACTION_LOCAL' } as const;

// The effect deadline of a supervisory command, from its send: the site's 1-6 s delay, plus how
// late telemetry can describe the truck, plus the trip to the gateway.
export function supervisoryDeadlineMs(): number {
  return PARAMS.supervisoryDelayMax.value + PARAMS.telemetryLatencyAllowance.value + PARAMS.commandUplinkAllowance.value;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export class CommandRegistry {
  readonly #clock: Clock;
  readonly #fleet: FleetState;
  readonly #store: Store;
  readonly #transport: CommandTransport;
  readonly #gate: SafetyGate;
  readonly #newId: () => string;
  readonly #commandIdFor: (recordId: string, attempt: number) => string;
  readonly #systemOperatorId: string;
  readonly #keepClosed: number;
  readonly #book = new AckBook();
  readonly #records = new Map<string, CommandRecord>();
  readonly #byCommandId = new Map<string, { rec: CommandRecord; attempt: Attempt }>();
  readonly #leases = new Map<string, LeaseInfo>();
  readonly #listeners = new Set<(e: RegistryEvent) => void>();
  #timer: TimerHandle | null = null;

  constructor(o: RegistryOptions) {
    this.#clock = o.clock;
    this.#fleet = o.fleet;
    this.#store = o.store;
    this.#transport = o.transport;
    this.#gate = o.gate;
    this.#newId = o.newId ?? (() => crypto.randomUUID());
    this.#commandIdFor = o.commandIdFor ?? ((id, n) => `${id}-a${n}`);
    this.#systemOperatorId = o.systemOperatorId ?? 'system';
    this.#keepClosed = o.keepClosed ?? 500;
    this.#restore();
  }

  subscribe(fn: (e: RegistryEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  start(intervalMs = 250): void {
    this.stop();
    const loop = () => { this.tick(); this.#timer = this.#clock.setTimeout(loop, intervalMs); };
    this.#timer = this.#clock.setTimeout(loop, intervalMs);
  }

  stop(): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  get(id: string): CommandRecord | undefined {
    const r = this.#records.get(id);
    return r && structuredClone(r);
  }

  list(filter: { open?: boolean; vehicleId?: string } = {}): CommandRecord[] {
    return [...this.#records.values()]
      .filter((r) => (filter.open === undefined || OPEN_STATUSES.has(r.status) === filter.open) && (filter.vehicleId === undefined || r.vehicleId === filter.vehicleId))
      .map((r) => structuredClone(r));
  }

  lease(vehicleId: string): LeaseInfo | undefined {
    const l = this.#leases.get(vehicleId);
    return l && { ...l };
  }

  leases(): LeaseInfo[] {
    return [...this.#leases.values()].map((l) => ({ ...l }));
  }

  // ---- callers ----

  // The one way to command a truck. `actor` comes from the server's session or the rule that fired;
  // anything resembling an operator id inside `req` is ignored (L8.3).
  submit(req: SubmitRequest, actor: Actor): CommandRecord {
    const now = this.#clock.now();
    const vehicleId = String(req.vehicleId);
    const action = req.action;

    if (action === 'ESTOP') {
      const open = this.#openOn(vehicleId).find((r) => r.action === 'ESTOP');
      if (open) {
        if (open.hold?.needsReconfirm) return this.reconfirm(open.id, actor) ?? structuredClone(open);
        return structuredClone(open);
      }
    }

    const rec: CommandRecord = {
      id: this.#newId(), vehicleId, action, force: action === 'TAKE_CONTROL' && req.force === true,
      leaseId: action === 'RELEASE_CONTROL' ? (req.leaseId ?? this.#leaseIdFor(vehicleId, actor)) : null,
      actor: cloneActor(actor), why: req.why ?? (actor.kind === 'system' ? actor.rule : null),
      createdMs: now, createdServerMs: this.#fleet.serverNow(), updatedMs: now, closedServerMs: null,
      status: 'pending', attempts: [], maxAttempts: action === 'ESTOP' ? PARAMS.estopMaxAttempts.value : PARAMS.commandMaxAttempts.value,
      hold: null, deadlineMs: null, queued: null, targetZone: null, baselineState: null, started: null, effect: null,
      pendingRefusal: null, failure: null, supersededBy: null, summary: '',
    };
    this.#records.set(rec.id, rec);
    this.#audit(rec, 'submitted', `${action} ${vehicleId} requested`);

    if (!(ACTIONS as readonly string[]).includes(action)) {
      this.#close(rec, 'refused', { code: LOCAL.unknownAction, message: `"${String(action)}" is not a command the site understands.`, ourFault: true });
      return structuredClone(rec);
    }
    if (rec.force && !(actor.kind === 'operator' && actor.role === 'supervisor')) {
      this.#close(rec, 'refused', { code: LOCAL.forceNeedsSupervisor, message: `Only a supervisor can take ${vehicleId} from another operator.`, ourFault: false });
      return structuredClone(rec);
    }
    const verdict = this.#gate.check({ record: rec, attempt: 1, replay: false, truck: this.#fleet.truck(vehicleId) });
    if (!verdict.allow) {
      this.#close(rec, 'refused', { code: verdict.code, message: verdict.reason, ourFault: false });
      return structuredClone(rec);
    }

    this.#supersedeFor(rec);
    if (this.#transport.isUp()) {
      this.#sendAttempt(rec, 'first');
    } else {
      rec.hold = { sinceMs: now, autoSendUntilMs: now + PARAMS.estopAutoSendWithin.value, needsReconfirm: false };
      this.#save(rec, 'waiting', `${action} ${vehicleId} not sent: the site link is down. Sent automatically if it returns within ${secs(PARAMS.estopAutoSendWithin.value)}`);
      if (action === 'ESTOP') this.#emit({ type: 'alarm', kind: 'estop_undelivered', vehicleId, recordId: rec.id, message: `E-stop for ${vehicleId} NOT delivered: the site link is down. It will be sent if the link returns within ${secs(PARAMS.estopAutoSendWithin.value)}; you can cancel it.` });
    }
    return structuredClone(rec);
  }

  // Cancel a command still waiting for the link (L7.8).
  cancel(id: string, actor: Actor): CommandRecord | undefined {
    const rec = this.#records.get(id);
    if (!rec) return undefined;
    if (rec.status !== 'pending' || !rec.hold) return structuredClone(rec);
    this.#close(rec, 'cancelled', null, actor, `${rec.action} ${rec.vehicleId} cancelled before it was sent`);
    return structuredClone(rec);
  }

  // Confirm again a command that waited too long for the link (L7.8): the operator has now seen the
  // truck as it is.
  reconfirm(id: string, actor: Actor): CommandRecord | undefined {
    const rec = this.#records.get(id);
    if (!rec) return undefined;
    if (rec.status !== 'pending' || !rec.hold?.needsReconfirm) return structuredClone(rec);
    const now = this.#clock.now();
    this.#audit(rec, 'reconfirmed', `${rec.action} ${rec.vehicleId} confirmed again`, actor);
    if (this.#transport.isUp()) {
      rec.hold = null;
      this.#sendAttempt(rec, 'first');
    } else {
      rec.hold = { sinceMs: now, autoSendUntilMs: now + PARAMS.estopAutoSendWithin.value, needsReconfirm: false };
      this.#save(rec);
    }
    return structuredClone(rec);
  }

  // ---- from the link ----

  linkUp(hello: Hello): void {
    const at = this.#fleet.serverNow();
    this.#leases.clear();
    for (const l of Array.isArray(hello.leases) ? hello.leases : []) {
      if (l && typeof l.vehicle_id === 'string' && typeof l.operator_id === 'string') {
        this.#leases.set(l.vehicle_id, { vehicleId: l.vehicle_id, operatorId: l.operator_id, leaseId: null, sinceServerMs: at });
      }
    }
    const now = this.#clock.now();
    for (const rec of this.#openSorted()) {
      if (rec.hold) {
        if (rec.hold.needsReconfirm) continue;
        if (now <= rec.hold.autoSendUntilMs) {
          rec.hold = null;
          this.#sendAttempt(rec, rec.attempts.length === 0 ? 'first' : 'replay');
        } else {
          this.#holdTimedOut(rec);
        }
        continue;
      }
      if (rec.deadlineMs !== null && now > rec.deadlineMs) {
        this.#close(rec, 'expired', { code: 'LINK_DOWN_PAST_DEADLINE', message: `The site link was down past this command's deadline, so it was not sent again. Check ${rec.vehicleId} as it is now and send again if needed.`, ourFault: false });
        continue;
      }
      this.#sendAttempt(rec, 'replay');
    }
  }

  // Deadlines stop while the link is down: nothing can be seen or sent. On reconnect, linkUp replays
  // what is still within its deadline and expires the rest.
  linkDown(reason: string): void {
    for (const rec of this.#openSorted()) {
      if (rec.status !== 'pending') this.#audit(rec, 'link_down', `site link down while ${rec.action} ${rec.vehicleId} was ${rec.status}: ${reason}`, { kind: 'system', rule: 'gateway-link' });
    }
  }

  // Every message from the gateway, after fleet state has taken it in.
  message(m: { type?: unknown; [k: string]: unknown }): void {
    switch (m.type) {
      case 'telemetry':
        if (typeof m.vehicle_id === 'string' && this.#hasOpen(m.vehicle_id)) this.#evaluate(m.vehicle_id);
        break;
      case 'command_ack': this.#ack(m); break;
      case 'lease_event': this.#leaseEvent(m); break;
      default: break;
    }
  }

  // Deadlines and the link-down hold window. Runs on a timer (start) or by hand in tests.
  tick(): void {
    const now = this.#clock.now();
    for (const rec of this.#openSorted()) {
      if (rec.hold) {
        if (!rec.hold.needsReconfirm && now > rec.hold.autoSendUntilMs) this.#holdTimedOut(rec);
        continue;
      }
      if (this.#transport.isUp() && rec.deadlineMs !== null && now >= rec.deadlineMs) this.#onDeadline(rec);
    }
  }

  // ---- sending ----

  #sendAttempt(rec: CommandRecord, kind: 'first' | 'retry' | 'replay'): void {
    const now = this.#clock.now();
    const replay = kind === 'replay';
    let attempt = rec.attempts.at(-1);
    if (!replay || !attempt) {
      const n = rec.attempts.length + 1;
      attempt = { n, commandId: this.#commandIdFor(rec.id, n), sends: [], ack: null, duplicateAcks: 0 };
    }
    const truck = this.#fleet.truck(rec.vehicleId);
    const verdict = this.#gate.check({ record: rec, attempt: attempt.n, replay, truck });
    if (!verdict.allow) {
      this.#close(rec, 'refused', { code: verdict.code, message: verdict.reason, ourFault: false });
      return;
    }
    if (!rec.attempts.includes(attempt)) {
      rec.attempts.push(attempt);
      this.#byCommandId.set(attempt.commandId, { rec, attempt });
    }
    if (attempt.n === 1 && !replay) {
      rec.baselineState = truck?.state?.value ?? null;
      if (rec.action === 'EXIT_ZONE') rec.targetZone = truck?.position?.value.zoneId ?? null;
    }

    const msg: CommandMessage = {
      type: 'command', command_id: attempt.commandId, vehicle_id: rec.vehicleId, action: rec.action,
      operator_id: rec.actor.kind === 'operator' ? rec.actor.operatorId : this.#systemOperatorId,
      ...(rec.force ? { force: true as const } : {}),
      ...(rec.action === 'RELEASE_CONTROL' && rec.leaseId ? { lease_id: rec.leaseId } : {}),
    };
    const line = JSON.stringify(msg);
    const send: SendInfo = { atMs: now, serverMs: this.#fleet.serverNow(), replay, ackRxMs: null };
    attempt.sends.push(send);
    this.#book.sent(attempt.commandId, now);
    // A new attempt has not been acknowledged yet, whatever the last one got. A replay keeps its
    // status: it is the same command, and the gateway will answer it with the original result.
    if (rec.status === 'pending' || kind === 'retry') rec.status = 'sent';
    rec.hold = null;
    rec.pendingRefusal = null;
    if (replay) {
      rec.deadlineMs = rec.deadlineMs === null ? null : Math.max(rec.deadlineMs, now + this.#baseDeadline(rec));
    } else {
      rec.queued = null;
      rec.started = null;
      rec.deadlineMs = this.#deadline(rec, truck, now);
    }
    const what = kind === 'first' ? `${rec.action} ${rec.vehicleId} sent` : kind === 'retry'
      ? `${rec.action} ${rec.vehicleId} sent again as attempt ${attempt.n} of ${rec.maxAttempts}` : `${rec.action} ${rec.vehicleId} replayed after reconnecting`;
    // Written down before it goes (L6.6).
    this.#store.tx(() => {
      this.#store.recordSend({ commandId: attempt.commandId, recordId: rec.id, attempt: attempt.n, replay, line, atMs: now, serverMs: send.serverMs });
      this.#save(rec, kind === 'first' ? 'sent' : kind === 'retry' ? 'retried' : 'replayed', what, undefined, attempt.commandId);
    });
    this.#transport.send(msg); // false means the link dropped under us: the replay on reconnect covers it
  }

  #baseDeadline(rec: CommandRecord): number {
    return IMMEDIATE.has(rec.action) ? PARAMS.immediateEffectDeadline.value : supervisoryDeadlineMs();
  }

  // L2.36: ~8 s normally; behind LOADING or DUMPING the work left plus that; behind CHARGING none.
  #deadline(rec: CommandRecord, truck: TruckView | undefined, now: number): number | null {
    const base = this.#baseDeadline(rec);
    if (QUEUEABLE.has(rec.action) && truck?.state && WORK.has(truck.state.value)) {
      return this.#markQueued(rec, truck, now);
    }
    return now + base;
  }

  #markQueued(rec: CommandRecord, truck: TruckView, now: number): number | null {
    const behind = truck.state!.value as WorkState;
    const base = supervisoryDeadlineMs();
    if (behind === 'CHARGING') {
      const soc = truck.socPct?.value;
      const est = soc === undefined || truck.socFractional ? null : Math.max(0, ((PARAMS.chargeTo.value - soc) / PARAMS.chargeRate.value) * 1000);
      rec.queued = { behind, sinceMs: now, estimateMs: est };
      return null;
    }
    const full = behind === 'LOADING' ? PARAMS.loadTime.value : PARAMS.dumpTime.value;
    const since = truck.stateSinceServerMs;
    const elapsed = since === null ? 0 : Math.max(0, this.#fleet.serverNow() - since);
    const remaining = Math.max(0, full - elapsed);
    rec.queued = { behind, sinceMs: now, estimateMs: remaining };
    return now + remaining + base;
  }

  // ---- outcomes ----

  #evaluate(vehicleId: string): void {
    const truck = this.#fleet.truck(vehicleId);
    if (!truck) return;
    const now = this.#clock.now();
    for (const rec of this.#openOn(vehicleId)) {
      if (rec.hold || rec.attempts.length === 0) continue;
      const e = this.#effect(rec, truck);
      if (e.done) { this.#confirm(rec, e.detail); continue; }
      if (e.started && !rec.started) {
        rec.started = { atMs: now, detail: e.started };
        rec.queued = null;
        rec.deadlineMs = now + this.#exitDeadline(rec, truck);
        this.#save(rec, 'under_way', `${rec.action} ${rec.vehicleId} under way: ${e.started}`);
        continue;
      }
      if (rec.started || !QUEUEABLE.has(rec.action) || !this.#fresh(rec, truck)) continue;
      const state = truck.state!.value;
      if (!rec.queued && WORK.has(state)) {
        const d = this.#markQueued(rec, truck, now);
        rec.deadlineMs = d === null ? null : Math.max(d, rec.deadlineMs ?? 0);
        this.#save(rec, 'queued', `${rec.action} ${rec.vehicleId} queued behind ${state}`);
      } else if (rec.queued && !WORK.has(state)) {
        // The re-probe saw a queued HOLD accepted and never carried out: check the moment the work
        // ends, and retry at once if it hasn't taken effect.
        const behind = rec.queued.behind;
        rec.queued = null;
        this.#noEffect(rec, `${behind} ended and ${rec.vehicleId} is ${state}: the queued ${rec.action} was not carried out`);
      }
    }
  }

  // Telemetry must be from after the first send, and believable: a frozen or silent truck confirms
  // nothing.
  #fresh(rec: CommandRecord, truck: TruckView): boolean {
    const first = rec.attempts[0]?.sends[0];
    if (!first || !truck.state) return false;
    if (truck.confidence === 'contradicted' || truck.confidence === 'silent' || truck.confidence === 'unknown') return false;
    return truck.state.atServerMs >= first.serverMs;
  }

  #effect(rec: CommandRecord, t: TruckView): { done: boolean; detail: string; started?: string } {
    const no = { done: false, detail: '' };
    if (!this.#fresh(rec, t)) return no;
    const state = t.state!.value;
    const control = t.control?.value;
    const opId = rec.actor.kind === 'operator' ? rec.actor.operatorId : this.#systemOperatorId;
    const zone = t.position && t.position.atServerMs >= rec.attempts[0]!.sends[0]!.serverMs ? t.position.value.zoneId : null;
    switch (rec.action) {
      case 'HOLD':
        return state === 'HOLDING' ? { done: true, detail: `${rec.vehicleId} is holding` } : no;
      case 'RESUME': {
        // A truck already in its duty cycle when RESUME went out shows nothing new in telemetry: the
        // RESUME can only have cancelled a queued command, which only the ack says. Otherwise a
        // RESUME refused during another command's delay would look done (re-probe Q3).
        if (!DUTY_CYCLE.has(state) || control?.mode === 'MANUAL') return no;
        const wasMoving = rec.baselineState !== null && DUTY_CYCLE.has(rec.baselineState);
        if (wasMoving && rec.attempts.at(-1)?.ack?.status !== 'ACCEPTED') return no;
        return { done: true, detail: `${rec.vehicleId} is ${state}` };
      }
      case 'RETURN_TO_BAY': {
        if (t.task?.value === 'RETURN_TO_BAY') return { done: true, detail: `${rec.vehicleId} is returning to the bay` };
        const inBay = zone !== null && !!this.#fleet.site?.zone(zone)?.kinds.includes('bay');
        return inBay && (state === 'IDLE' || state === 'CHARGING') ? { done: true, detail: `${rec.vehicleId} is in the bay, ${state}` } : no;
      }
      case 'EXIT_ZONE':
        if (state === 'HOLDING' && zone !== null && zone !== rec.targetZone && (rec.targetZone !== null || rec.started)) {
          return { done: true, detail: `${rec.vehicleId} is holding outside ${rec.targetZone ?? 'the zone'}, in ${zone}` };
        }
        if (t.task?.value === 'EXIT_ZONE') return { done: false, detail: '', started: `leaving ${rec.targetZone ?? 'its zone'}` };
        return no;
      case 'ESTOP':
        return state === 'ESTOPPED' ? { done: true, detail: `${rec.vehicleId} is e-stopped` } : no;
      case 'CLEAR_ESTOP':
        return state !== 'ESTOPPED' ? { done: true, detail: `${rec.vehicleId} is out of e-stop, ${state}` } : no;
      case 'TAKE_CONTROL':
        return control?.mode === 'MANUAL' && control.operatorId === opId ? { done: true, detail: `${opId} has control of ${rec.vehicleId}` } : no;
      case 'RELEASE_CONTROL':
        return control && control.operatorId !== opId ? { done: true, detail: `${rec.vehicleId} handed back, ${state}` } : no;
      default:
        return no;
    }
  }

  // EXIT_ZONE once under way: the time to the nearer boundary at the slowest speed it might use,
  // doubled for the thinly measured loaded reverse, plus the command delay as slack.
  #exitDeadline(_rec: CommandRecord, t: TruckView): number {
    const site = this.#fleet.site;
    const pos = t.position?.value.loopM;
    const exit = site && pos !== undefined ? zoneExit(site, pos) : undefined;
    const distance = (exit?.distanceM ?? 0) + PARAMS.exitZoneStopOutside.value;
    const speed = Math.min(PARAMS.reverseSpeedLoaded.value, PARAMS.autoSpeedLoaded.value);
    return 2 * (distance / speed) * 1000 + PARAMS.supervisoryDelayMax.value + PARAMS.telemetryLatencyAllowance.value;
  }

  #onDeadline(rec: CommandRecord): void {
    const truck = this.#fleet.truck(rec.vehicleId);
    if (truck) {
      const e = this.#effect(rec, truck);
      if (e.done) { this.#confirm(rec, e.detail); return; }
    }
    if (rec.pendingRefusal) {
      this.#close(rec, 'failed', rec.pendingRefusal);
      return;
    }
    if (truck && QUEUEABLE.has(rec.action) && !rec.started && this.#fresh(rec, truck) && WORK.has(truck.state!.value)) {
      rec.deadlineMs = this.#markQueued(rec, truck, this.#clock.now());
      this.#save(rec, 'queued', `${rec.action} ${rec.vehicleId} still queued behind ${truck.state!.value}`);
      return;
    }
    const seen = truck?.state ? `last seen ${truck.state.value} ${secs(truck.state.ageMs)} ago` : 'no telemetry';
    const acked = rec.attempts.at(-1)?.ack?.status === 'ACCEPTED' ? 'accepted but not carried out' : 'no ack and no effect';
    this.#noEffect(rec, `${acked} within ${secs(this.#baseDeadline(rec))} (${seen})`);
  }

  // No effect when there should have been one: retry under a new command_id, or fail and alarm.
  #noEffect(rec: CommandRecord, why: string): void {
    const truck = this.#fleet.truck(rec.vehicleId);
    if (rec.action === 'EXIT_ZONE' && rec.started) {
      this.#fail(rec, 'EXIT_NOT_CONFIRMED', `${rec.vehicleId} started leaving ${rec.targetZone ?? 'its zone'} but is not confirmed outside it (${why}). Not sent again: a new EXIT_ZONE could send it out of a different zone.`);
      return;
    }
    if (rec.attempts.length >= rec.maxAttempts) {
      this.#fail(rec, 'NO_EFFECT', `${rec.action} for ${rec.vehicleId} did not take effect after ${rec.attempts.length} attempts: ${why}.`);
      return;
    }
    if (rec.action === 'EXIT_ZONE') {
      // CONTEXT.md assumption 6: re-check zone membership before EXIT_ZONE goes out again.
      const zone = truck?.position?.value.zoneId ?? null;
      if (!truck || truck.confidence !== 'live' || zone === null || zone !== rec.targetZone) {
        this.#fail(rec, 'EXIT_ZONE_UNCERTAIN', `EXIT_ZONE for ${rec.vehicleId} not confirmed (${why}), and its position is not certain enough to send it again (${truck?.confidence ?? 'no data'}, in ${zone ?? 'unknown'}).`);
        return;
      }
    }
    this.#audit(rec, 'no_effect', `${rec.action} ${rec.vehicleId}: ${why}`);
    this.#sendAttempt(rec, 'retry');
  }

  #confirm(rec: CommandRecord, detail: string): void {
    const now = this.#clock.now();
    const ackReceived = rec.attempts.some((a) => a.ack !== null);
    rec.effect = { atMs: now, serverMs: this.#fleet.serverNow(), detail, ackReceived };
    this.#close(rec, 'confirmed', null, undefined, `${rec.action} ${rec.vehicleId} confirmed: ${detail}${ackReceived ? '' : ' (no ack received)'}`);
  }

  #fail(rec: CommandRecord, code: string, message: string): void {
    this.#close(rec, 'failed', { code, message, ourFault: false });
    this.#emit({ type: 'alarm', kind: 'command_failed', vehicleId: rec.vehicleId, recordId: rec.id, message });
  }

  #holdTimedOut(rec: CommandRecord): void {
    if (rec.actor.kind === 'system') {
      this.#close(rec, 'expired', { code: 'LINK_DOWN_TOO_LONG', message: `The site link stayed down for more than ${secs(PARAMS.estopAutoSendWithin.value)}; not sent. The rule that asked for it decides again on reconnect.`, ourFault: false });
      return;
    }
    rec.hold!.needsReconfirm = true;
    const message = `${rec.action} for ${rec.vehicleId} was NOT sent: the site link was down for more than ${secs(PARAMS.estopAutoSendWithin.value)}. Look at ${rec.vehicleId} as it is now, then confirm again or cancel.`;
    this.#save(rec, 'needs_reconfirm', message);
    if (rec.action === 'ESTOP') this.#emit({ type: 'alarm', kind: 'estop_undelivered', vehicleId: rec.vehicleId, recordId: rec.id, message });
  }

  // ---- acks and leases ----

  #ack(m: Record<string, unknown>): void {
    const cid = typeof m.command_id === 'string' ? m.command_id : null;
    if (cid === null) return;
    const loc = this.#byCommandId.get(cid);
    if (!loc) return; // another client's command: acks are broadcast to everyone
    const now = this.#clock.now();
    const match = this.#book.ack(cid, now);
    if (!match) return;
    const { rec, attempt } = loc;
    const status = m.status === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED';
    const str = (x: unknown) => (typeof x === 'string' ? x : null);
    const info: AckInfo = {
      status, reason: str(m.reason), holder: str(m.holder), leaseId: str(m.lease_id),
      serverMs: typeof m.server_time_ms === 'number' ? m.server_time_ms : null, rxMs: now, sendIndex: match.sendIndex,
    };
    this.#store.recordAck({ commandId: cid, recordId: rec.id, status, reason: info.reason, holder: info.holder, leaseId: info.leaseId, serverMs: info.serverMs, rxMs: now, sendIndex: match.sendIndex, duplicate: match.duplicate });
    if (match.duplicate) { attempt.duplicateAcks++; this.#save(rec); return; } // L2.32: no state change
    attempt.sends[match.sendIndex]!.ackRxMs = now;
    attempt.ack = info;

    if (status === 'ACCEPTED' && rec.action === 'TAKE_CONTROL' && info.leaseId && rec.actor.kind === 'operator') {
      this.#setLease({ vehicleId: rec.vehicleId, operatorId: rec.actor.operatorId, leaseId: info.leaseId, sinceServerMs: this.#fleet.serverNow() });
    }
    const current = attempt === rec.attempts.at(-1);
    if (rec.status === 'confirmed' && status === 'ACCEPTED' && rec.effect && !rec.effect.ackReceived) {
      rec.effect.ackReceived = true; // the ack came after the effect (L2.30): no longer "no ack received"
    }
    if (!OPEN_STATUSES.has(rec.status) || !current) {
      this.#save(rec, 'ack', `${status}${info.reason ? ` ${info.reason}` : ''} for ${cid} after the command was ${current ? rec.status : 'sent again'}`, undefined, cid);
      return;
    }
    if (status === 'ACCEPTED') {
      if (rec.status === 'sent') rec.status = 'acknowledged';
      this.#save(rec, 'ack', `${rec.action} ${rec.vehicleId} accepted by the site (not yet carried out)`, undefined, cid);
      if (rec.action === 'RESUME') this.#cancelQueuedBy(rec);
      this.#evaluate(rec.vehicleId); // the effect may already be in (L2.30)
      return;
    }
    this.#rejected(rec, attempt, info);
  }

  #rejected(rec: CommandRecord, attempt: Attempt, info: AckInfo): void {
    const truck = this.#fleet.truck(rec.vehicleId);
    const reason = info.reason ?? 'UNKNOWN';
    const ref: Refusal = refusal(reason, {
      vehicleId: rec.vehicleId, action: rec.action, holder: info.holder, state: truck?.state?.value ?? null,
      faults: truck?.faults?.value ?? null, inFlight: this.#inFlight(rec),
    });
    if (reason === 'LEASE_HELD') {
      const sender = rec.actor.kind === 'operator' ? rec.actor.operatorId : `the system (${rec.actor.rule})`;
      const to = [info.holder, rec.actor.kind === 'operator' ? rec.actor.operatorId : null].filter((x): x is string => !!x);
      this.#emit({ type: 'notify', to: [...new Set(to)], vehicleId: rec.vehicleId, recordId: rec.id, message: `${sender} tried to ${rec.action} ${rec.vehicleId}, but ${info.holder ?? 'another operator'} holds its controls. The ${rec.action} was not carried out.` });
    }
    // A retry refused for the truck's state may only mean an earlier attempt already worked: give
    // that a moment to show before calling it failed.
    if (reason === 'INVALID_STATE' && attempt.n > 1) {
      rec.pendingRefusal = { code: reason, message: ref.message, ourFault: ref.ourFault };
      rec.deadlineMs = this.#clock.now() + PARAMS.telemetryLatencyAllowance.value + PARAMS.commandUplinkAllowance.value;
      this.#save(rec, 'ack', `${rec.action} ${rec.vehicleId} attempt ${attempt.n} refused (${reason}); checking whether an earlier attempt worked`, undefined, attempt.commandId);
      return;
    }
    this.#audit(rec, 'ack', `${rec.action} ${rec.vehicleId} refused by the site: ${reason}`, undefined, attempt.commandId);
    this.#close(rec, 'failed', { code: reason, message: ref.message, ourFault: ref.ourFault });
  }

  // Another command of ours on the truck still within its delay, for INVALID_STATE (re-probe Q3).
  #inFlight(rec: CommandRecord): { action: string; sentAgoMs: number } | null {
    const now = this.#clock.now();
    for (const r of this.#openOn(rec.vehicleId)) {
      if (r === rec || !SUPERVISORY.has(r.action) || r.queued || r.hold) continue;
      const sent = r.attempts.at(-1)?.sends.at(-1);
      if (sent && now - sent.atMs < supervisoryDeadlineMs()) return { action: r.action, sentAgoMs: now - sent.atMs };
    }
    return null;
  }

  #leaseEvent(m: Record<string, unknown>): void {
    const v = typeof m.vehicle_id === 'string' ? m.vehicle_id : null;
    const op = typeof m.operator_id === 'string' ? m.operator_id : null;
    if (!v) return;
    const at = typeof m.server_time_ms === 'number' ? m.server_time_ms : this.#fleet.serverNow();
    switch (m.event) {
      case 'GRANTED':
        if (op) this.#setLease({ vehicleId: v, operatorId: op, leaseId: typeof m.lease_id === 'string' ? m.lease_id : null, sinceServerMs: at });
        break;
      case 'RELEASED': case 'EXPIRED': case 'REVOKED': {
        this.#leases.delete(v);
        const by = typeof m.by_operator === 'string' ? m.by_operator : null;
        const message = m.event === 'RELEASED' ? `${op ?? 'The driver'} handed ${v} back; it is holding.`
          : m.event === 'EXPIRED' ? `${op ?? 'The driver'}'s control of ${v} expired: no drive input for ${secs(PARAMS.leaseIdleTimeout.value)}. It is holding and will not resume by itself.`
            : m.reason === 'FORCED_TAKEOVER' ? `${by ?? 'A supervisor'} took control of ${v} from ${op ?? 'its driver'}.`
              : m.reason === 'ESTOP' ? `${v} was e-stopped${by ? ` by ${by}` : ''}; ${op ?? 'its driver'} no longer has control.`
                : `${op ?? 'The driver'} lost control of ${v}: ${String(m.reason ?? 'revoked')}.`;
        this.#emit({ type: 'lease', vehicleId: v, lease: null, message });
        if (op) this.#emit({ type: 'notify', to: [op], vehicleId: v, recordId: null, message });
        break;
      }
      default: break;
    }
  }

  #setLease(l: LeaseInfo): void {
    const prev = this.#leases.get(l.vehicleId);
    this.#leases.set(l.vehicleId, l);
    if (!prev || prev.operatorId !== l.operatorId || prev.leaseId !== l.leaseId) {
      this.#emit({ type: 'lease', vehicleId: l.vehicleId, lease: { ...l }, message: `${l.operatorId} has control of ${l.vehicleId}.` });
    }
  }

  #leaseIdFor(vehicleId: string, actor: Actor): string | null {
    const l = this.#leases.get(vehicleId);
    return l && actor.kind === 'operator' && l.operatorId === actor.operatorId ? l.leaseId : null;
  }

  // ---- superseding (L2.38) ----

  // At most one of our supervisory commands is open on a truck, so a retry can never displace a
  // different command we queued. A newer HOLD, RETURN_TO_BAY or EXIT_ZONE replaces the older at the
  // truck anyway (one queued at a time; pending ones run in order, the newest last). An e-stop or a
  // takeover drops them at the truck. A RESUME replaces them only once accepted (#cancelQueuedBy):
  // refused, it changes nothing, because a command on its way can't be called back.
  #supersedeFor(newer: CommandRecord): void {
    const a = newer.action;
    const replaces = (older: CommandRecord): boolean => {
      if (a === 'ESTOP') return older.action !== 'ESTOP';
      if (a === 'TAKE_CONTROL') return SUPERVISORY.has(older.action);
      if (QUEUEABLE.has(a)) return SUPERVISORY.has(older.action);
      return false;
    };
    for (const older of this.#openOn(newer.vehicleId)) {
      if (older !== newer && replaces(older)) this.#supersede(older, newer, 'replaced by a newer command');
    }
  }

  #cancelQueuedBy(resume: CommandRecord): void {
    for (const older of this.#openOn(resume.vehicleId)) {
      if (older !== resume && QUEUEABLE.has(older.action) && older.queued) this.#supersede(older, resume, `cancelled by RESUME while queued behind ${older.queued.behind}`);
    }
  }

  #supersede(older: CommandRecord, newer: CommandRecord, why: string): void {
    older.supersededBy = newer.id;
    this.#close(older, 'superseded', null, newer.actor, `${older.action} ${older.vehicleId} ${why} (${newer.action})`);
  }

  // ---- restart (L6.1, L6.6) ----

  #restore(): void {
    const now = this.#clock.now();
    for (const rec of this.#store.openCommands()) {
      this.#records.set(rec.id, rec);
      for (const a of rec.attempts) {
        this.#byCommandId.set(a.commandId, { rec, attempt: a });
        for (const s of a.sends) this.#book.sent(a.commandId, s.atMs, s.ackRxMs !== null);
      }
      this.#audit(rec, 'restored', `${rec.action} ${rec.vehicleId} found ${rec.status} after a restart`, { kind: 'system', rule: 'restart-recovery' });
      if (rec.hold) {
        if (!rec.hold.needsReconfirm && now > rec.hold.autoSendUntilMs) this.#holdTimedOut(rec);
        continue;
      }
      if (rec.attempts.length === 0) {
        // Written, then killed before the first send went out: it has no deadline of its own yet.
        if (now - rec.createdMs > this.#baseDeadline(rec)) this.#close(rec, 'expired', { code: 'RESTART_PAST_DEADLINE', message: `The service restarted before this was sent, and it is now too old to send. Check ${rec.vehicleId} and send again if needed.`, ourFault: false });
        else rec.hold = { sinceMs: rec.createdMs, autoSendUntilMs: rec.createdMs + this.#baseDeadline(rec), needsReconfirm: false };
        continue;
      }
      if (rec.deadlineMs !== null && now > rec.deadlineMs) {
        this.#close(rec, 'expired', { code: 'RESTART_PAST_DEADLINE', message: `The service restarted after this was sent and it is now past its deadline, so it was not sent again. Check ${rec.vehicleId} as it is now and send again if needed.`, ourFault: false });
      }
      // The rest are replayed, under the same command_id, on the next hello.
    }
  }

  // ---- bookkeeping ----

  #close(rec: CommandRecord, status: CommandStatus, failure: CommandRecord['failure'], actor?: Actor, what?: string): void {
    rec.status = status;
    rec.failure = failure;
    rec.hold = null;
    rec.deadlineMs = null;
    rec.queued = null;
    rec.pendingRefusal = null;
    rec.closedServerMs = this.#fleet.serverNow();
    this.#save(rec, status, what ?? `${rec.action} ${rec.vehicleId} ${status}${failure ? `: ${failure.message}` : ''}`, actor);
    this.#trim();
  }

  #save(rec: CommandRecord, event?: string, what?: string, actor?: Actor, commandId?: string): void {
    rec.updatedMs = this.#clock.now();
    rec.summary = summarise(rec, this.#clock.now());
    this.#store.tx(() => {
      this.#store.saveCommand(rec);
      if (event && what) this.#store.audit(this.#entry(rec, event, what, actor, commandId));
    });
    this.#emit({ type: 'command', record: structuredClone(rec) });
  }

  #audit(rec: CommandRecord, event: string, what: string, actor?: Actor, commandId?: string): void {
    this.#store.audit(this.#entry(rec, event, what, actor, commandId));
  }

  #entry(rec: CommandRecord, event: string, what: string, actor: Actor = rec.actor, commandId?: string): AuditEntry {
    return {
      atMs: this.#clock.now(), serverMs: this.#fleet.serverNow(),
      actorKind: actor.kind, actor: actor.kind === 'operator' ? actor.operatorId : 'system', rule: actor.kind === 'system' ? actor.rule : null,
      event, vehicleId: rec.vehicleId, recordId: rec.id, commandId: commandId ?? rec.attempts.at(-1)?.commandId ?? null,
      what, why: rec.why, inputs: actor.kind === 'system' ? actor.inputs ?? null : undefined,
    };
  }

  #openOn(vehicleId: string): CommandRecord[] {
    return [...this.#records.values()].filter((r) => r.vehicleId === vehicleId && OPEN_STATUSES.has(r.status));
  }

  #hasOpen(vehicleId: string): boolean {
    for (const r of this.#records.values()) if (r.vehicleId === vehicleId && OPEN_STATUSES.has(r.status)) return true;
    return false;
  }

  #openSorted(): CommandRecord[] {
    return [...this.#records.values()].filter((r) => OPEN_STATUSES.has(r.status)).sort((a, b) => a.createdMs - b.createdMs);
  }

  #trim(): void {
    const closed = [...this.#records.values()].filter((r) => !OPEN_STATUSES.has(r.status));
    for (const r of closed.slice(0, Math.max(0, closed.length - this.#keepClosed))) {
      this.#records.delete(r.id);
      for (const a of r.attempts) this.#byCommandId.delete(a.commandId);
    }
  }

  #emit(e: RegistryEvent): void {
    for (const fn of this.#listeners) fn(e);
  }
}

function cloneActor(a: Actor): Actor {
  return a.kind === 'operator'
    ? { kind: 'operator', operatorId: String(a.operatorId), role: a.role === 'supervisor' ? 'supervisor' : 'operator' }
    : { kind: 'system', rule: String(a.rule), ...(a.inputs === undefined ? {} : { inputs: structuredClone(a.inputs) }) };
}

// One line for the operator: what is happening to this command now.
export function summarise(r: CommandRecord, nowMs: number): string {
  const n = r.attempts.length;
  const attempt = n > 1 ? ` (attempt ${n} of ${r.maxAttempts})` : '';
  switch (r.status) {
    case 'pending':
      if (r.hold?.needsReconfirm) return 'NOT sent: the site link was down too long. Check the truck, then confirm again or cancel';
      if (r.hold) return `NOT sent yet: waiting for the site link (sends by itself for ${secs(Math.max(0, r.hold.autoSendUntilMs - nowMs))} more)`;
      return 'about to send';
    case 'sent':
      if (r.queued) return `sent, queued behind ${r.queued.behind}${attempt}`;
      return `sent, no answer from the site yet${attempt}`;
    case 'acknowledged':
      if (r.started) return `under way: ${r.started.detail}${attempt}`;
      if (r.queued) {
        const est = r.queued.estimateMs === null ? '' : ` (~${Math.round(r.queued.estimateMs / 1000)} s left)`;
        return `accepted, queued until ${r.queued.behind} ends${est}${r.queued.behind === 'CHARGING' ? ': no fixed deadline' : ''}${attempt}`;
      }
      return `accepted, not carried out yet${attempt}`;
    case 'confirmed':
      return `done: ${r.effect?.detail ?? ''}${r.effect && !r.effect.ackReceived ? ' (no ack received)' : ''}${attempt}`;
    case 'failed': case 'refused': case 'expired':
      return r.failure?.message ?? r.status;
    case 'cancelled':
      return 'cancelled before it was sent';
    case 'superseded':
      return 'replaced by a newer command';
  }
}
