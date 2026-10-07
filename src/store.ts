// The command log and the audit log, in SQLite through node:sqlite (TESTING.md L6.6, L8.4, L8.5).
//
// - `commands`: one row per command, with its whole record as JSON, rewritten as it changes. This
//   is what a restart replays from.
// - `sends`, `acks`, `audit`: append-only. Triggers refuse UPDATE and DELETE, so the history that
//   reaches the inspector is the history that happened.
//
// Writes are synchronous: when a write returns, the row is in the database file. The registry
// writes a send before handing it to the link, so a kill between the two still leaves it to replay.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { CommandRecord } from './registry.ts';

export interface SendRow {
  commandId: string;   // the gateway's command_id for this attempt
  recordId: string;
  attempt: number;
  replay: boolean;
  line: string;        // exactly what was handed to the link
  atMs: number;
  serverMs: number;
}

export interface AckRow {
  commandId: string;
  recordId: string | null;
  status: string;
  reason: string | null;
  holder: string | null;
  leaseId: string | null;
  serverMs: number | null;
  rxMs: number;
  sendIndex: number | null; // which send of that command_id it belongs to (matchAck)
  duplicate: boolean;
}

export type ActorKind = 'operator' | 'system';

export interface AuditEntry {
  atMs: number;
  serverMs: number;
  actorKind: ActorKind;
  actor: string;            // operator id, or "system"
  rule: string | null;      // for the system: the rule that acted
  event: string;            // submitted, sent, ack, confirmed, retried, failed, ...
  vehicleId: string | null;
  recordId: string | null;
  commandId: string | null;
  what: string;             // in words
  why: string | null;
  inputs: unknown;          // for the system: what the rule saw
}

export interface AuditRow extends AuditEntry { seq: number }

// One row per command for "who moved this truck then?" (L8.4): the actor, rule and inputs, every
// send, every ack and the outcome, from a single query.
export interface HistoryRow {
  recordId: string;
  vehicleId: string;
  action: string;
  actorKind: ActorKind;
  actor: string;
  rule: string | null;
  why: string | null;
  inputs: unknown;
  createdServerMs: number;
  status: string;
  sends: Array<{ commandId: string; attempt: number; replay: boolean; serverMs: number }>;
  acks: Array<{ commandId: string; status: string; reason: string | null; serverMs: number | null; duplicate: boolean }>;
  effect: unknown;
  failure: unknown;
}

const OPEN_STATUSES = ['pending', 'sent', 'acknowledged', 'unverified'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  rule TEXT,
  why TEXT,
  inputs_json TEXT,
  created_ms INTEGER NOT NULL,
  created_server_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_vehicle ON commands (vehicle_id, created_server_ms);
CREATE INDEX IF NOT EXISTS commands_status ON commands (status);

CREATE TABLE IF NOT EXISTS sends (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  replay INTEGER NOT NULL,
  line TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  server_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sends_record ON sends (record_id);

CREATE TABLE IF NOT EXISTS acks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL,
  record_id TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  holder TEXT,
  lease_id TEXT,
  server_ms INTEGER,
  rx_ms INTEGER NOT NULL,
  send_index INTEGER,
  duplicate INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS acks_record ON acks (record_id);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  server_ms INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'system')),
  actor TEXT NOT NULL,
  rule TEXT,
  event TEXT NOT NULL,
  vehicle_id TEXT,
  record_id TEXT,
  command_id TEXT,
  what TEXT NOT NULL,
  why TEXT,
  inputs_json TEXT
);
CREATE INDEX IF NOT EXISTS audit_vehicle ON audit (vehicle_id, server_ms);

CREATE TABLE IF NOT EXISTS engine_state (
  name TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
`;

const APPEND_ONLY = ['sends', 'acks', 'audit'];

export class Store {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  #depth = 0;

  // `path` is a file, or ':memory:' for a store that dies with the process.
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
    for (const t of APPEND_ONLY) {
      this.#db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`);
    }
    const db = this.#db;
    this.#q = {
      upsert: db.prepare(`INSERT INTO commands (id, vehicle_id, action, actor_kind, actor, rule, why, inputs_json, created_ms, created_server_ms, status, record_json, updated_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json, updated_ms = excluded.updated_ms`),
      send: db.prepare('INSERT INTO sends (command_id, record_id, attempt, replay, line, at_ms, server_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      ack: db.prepare('INSERT INTO acks (command_id, record_id, status, reason, holder, lease_id, server_ms, rx_ms, send_index, duplicate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      audit: db.prepare(`INSERT INTO audit (at_ms, server_ms, actor_kind, actor, rule, event, vehicle_id, record_id, command_id, what, why, inputs_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      open: db.prepare(`SELECT record_json FROM commands WHERE status IN (${OPEN_STATUSES.map(() => '?').join(', ')}) ORDER BY created_ms`),
      get: db.prepare('SELECT record_json FROM commands WHERE id = ?'),
      sendsOf: db.prepare('SELECT command_id, record_id, attempt, replay, line, at_ms, server_ms FROM sends WHERE record_id = ? ORDER BY seq'),
      history: db.prepare(`
        SELECT c.id AS record_id, c.vehicle_id, c.action, c.actor_kind, c.actor, c.rule, c.why, c.inputs_json,
               c.created_server_ms, c.status,
               (SELECT json_group_array(json_object('commandId', s.command_id, 'attempt', s.attempt, 'replay', s.replay, 'serverMs', s.server_ms))
                  FROM (SELECT * FROM sends WHERE record_id = c.id ORDER BY seq) s) AS sends_json,
               (SELECT json_group_array(json_object('commandId', a.command_id, 'status', a.status, 'reason', a.reason, 'serverMs', a.server_ms, 'duplicate', a.duplicate))
                  FROM (SELECT * FROM acks WHERE record_id = c.id ORDER BY seq) a) AS acks_json,
               json_extract(c.record_json, '$.effect') AS effect_json,
               json_extract(c.record_json, '$.failure') AS failure_json
          FROM commands c
         WHERE c.vehicle_id = ?
           AND c.created_server_ms <= ?
           AND (json_extract(c.record_json, '$.closedServerMs') IS NULL OR json_extract(c.record_json, '$.closedServerMs') >= ?)
         ORDER BY c.created_server_ms`),
      auditAll: db.prepare('SELECT * FROM audit ORDER BY seq'),
      putState: db.prepare(`INSERT INTO engine_state (name, json, updated_ms) VALUES (?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET json = excluded.json, updated_ms = excluded.updated_ms`),
      getState: db.prepare('SELECT json FROM engine_state WHERE name = ?'),
      auditVehicle: db.prepare('SELECT * FROM audit WHERE vehicle_id = ? ORDER BY seq'),
    };
  }

  // Runs `fn` in one transaction; nested calls join the outer one.
  tx<T>(fn: () => T): T {
    if (this.#depth > 0) { this.#depth++; try { return fn(); } finally { this.#depth--; } }
    this.#db.exec('BEGIN IMMEDIATE');
    this.#depth = 1;
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    } finally {
      this.#depth = 0;
    }
  }

  saveCommand(r: CommandRecord): void {
    const a = r.actor;
    this.#q.upsert!.run(
      r.id, r.vehicleId, r.action, a.kind, a.kind === 'operator' ? a.operatorId : 'system', a.kind === 'system' ? a.rule : null,
      r.why, a.kind === 'system' ? JSON.stringify(a.inputs ?? null) : null, r.createdMs, r.createdServerMs, r.status, JSON.stringify(r), r.updatedMs,
    );
  }

  recordSend(s: SendRow): void {
    this.#q.send!.run(s.commandId, s.recordId, s.attempt, s.replay ? 1 : 0, s.line, s.atMs, s.serverMs);
  }

  recordAck(a: AckRow): void {
    this.#q.ack!.run(a.commandId, a.recordId, a.status, a.reason, a.holder, a.leaseId, a.serverMs, a.rxMs, a.sendIndex, a.duplicate ? 1 : 0);
  }

  audit(e: AuditEntry): void {
    this.#q.audit!.run(e.atMs, e.serverMs, e.actorKind, e.actor, e.rule, e.event, e.vehicleId, e.recordId, e.commandId, e.what, e.why,
      e.inputs === undefined ? null : JSON.stringify(e.inputs));
  }

  openCommands(): CommandRecord[] {
    return this.#q.open!.all(...OPEN_STATUSES).map((row) => JSON.parse(String(row.record_json)) as CommandRecord);
  }

  command(id: string): CommandRecord | undefined {
    const row = this.#q.get!.get(id);
    return row ? (JSON.parse(String(row.record_json)) as CommandRecord) : undefined;
  }

  sendsOf(recordId: string): SendRow[] {
    return this.#q.sendsOf!.all(recordId).map((r) => ({
      commandId: String(r.command_id), recordId: String(r.record_id), attempt: Number(r.attempt), replay: Number(r.replay) === 1,
      line: String(r.line), atMs: Number(r.at_ms), serverMs: Number(r.server_ms),
    }));
  }

  // L8.4: every command on the truck that was open at any moment in [fromServerMs, toServerMs]:
  // created by the end of the window and not closed before its start.
  history(vehicleId: string, fromServerMs: number, toServerMs: number): HistoryRow[] {
    return this.#q.history!.all(vehicleId, toServerMs, fromServerMs).map((r) => ({
      recordId: String(r.record_id), vehicleId: String(r.vehicle_id), action: String(r.action),
      actorKind: String(r.actor_kind) as ActorKind, actor: String(r.actor), rule: r.rule === null ? null : String(r.rule),
      why: r.why === null ? null : String(r.why), inputs: r.inputs_json === null ? null : JSON.parse(String(r.inputs_json)),
      createdServerMs: Number(r.created_server_ms), status: String(r.status),
      sends: (JSON.parse(String(r.sends_json)) as HistoryRow['sends']).map((s) => ({ ...s, replay: Boolean(s.replay) })),
      acks: (JSON.parse(String(r.acks_json)) as HistoryRow['acks']).map((a) => ({ ...a, duplicate: Boolean(a.duplicate) })),
      effect: r.effect_json === null ? null : JSON.parse(String(r.effect_json)),
      failure: r.failure_json === null ? null : JSON.parse(String(r.failure_json)),
    }));
  }

  auditLog(vehicleId?: string): AuditRow[] {
    const rows = vehicleId === undefined ? this.#q.auditAll!.all() : this.#q.auditVehicle!.all(vehicleId);
    return rows.map((r) => ({
      seq: Number(r.seq), atMs: Number(r.at_ms), serverMs: Number(r.server_ms), actorKind: String(r.actor_kind) as ActorKind,
      actor: String(r.actor), rule: r.rule === null ? null : String(r.rule), event: String(r.event),
      vehicleId: r.vehicle_id === null ? null : String(r.vehicle_id), recordId: r.record_id === null ? null : String(r.record_id),
      commandId: r.command_id === null ? null : String(r.command_id), what: String(r.what), why: r.why === null ? null : String(r.why),
      inputs: r.inputs_json === null ? null : JSON.parse(String(r.inputs_json)),
    }));
  }

  // A rule engine's own state, kept beside the command log so a restart knows it (BLAST.md B14: which
  // trucks the blast engine held, and for which zone). Rewritten whole on each change.
  putState(name: string, value: unknown, atMs: number): void {
    this.#q.putState!.run(name, JSON.stringify(value), atMs);
  }

  getState<T>(name: string): T | undefined {
    const row = this.#q.getState!.get(name);
    return row ? (JSON.parse(String(row.json)) as T) : undefined;
  }

  // For tests that try to break the append-only rule; product code never calls this.
  rawExec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
