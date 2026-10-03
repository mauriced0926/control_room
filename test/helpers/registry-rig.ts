// A command registry on a manual clock, with fleet state on this site's hello, a store in a temp
// directory, and a scripted transport that records what was sent. Hand-built messages are for
// single-case tests; the fixture tests replay research/fixtures/ instead.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../src/clock.ts';
import { FleetState } from '../../src/fleet.ts';
import type { CommandMessage } from '../../src/protocol.ts';
import { ALLOW_ALL_GATE_NO_BLAST_SAFETY, CommandRegistry, type Actor, type RegistryEvent, type SafetyGate } from '../../src/registry.ts';
import { Store } from '../../src/store.ts';
import { helloAt } from './fixtures.ts';
import { T0, telemetry } from './rig.ts';

export const PRIYA: Actor = { kind: 'operator', operatorId: 'priya', role: 'operator' };
export const DAVE: Actor = { kind: 'operator', operatorId: 'dave', role: 'operator' };
export const MARTA: Actor = { kind: 'operator', operatorId: 'marta', role: 'supervisor' };
export const BLAST: Actor = { kind: 'system', rule: 'blast-evacuation', inputs: { zone: 'Z', effectiveAtMs: 0 } };

export function tempDir(): { dir: string; dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'cr-registry-'));
  return { dir, dbPath: join(dir, 'control-room.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface RegRig {
  clock: ManualClock;
  fleet: FleetState;
  store: Store;
  registry: CommandRegistry;
  sent: CommandMessage[];
  events: RegistryEvent[];
  dbPath: string;
  setUp(up: boolean): void;
  feed(msg: Record<string, unknown>): void;
  tel(vehicle: string, over?: Record<string, unknown>): void;
  ack(commandId: string, status: 'ACCEPTED' | 'REJECTED', extra?: Record<string, unknown>): void;
  advance(ms: number, stepMs?: number): void;
  restart(opts?: { gate?: SafetyGate }): RegRig;
  cleanup(): void;
}

export interface RigOptions {
  gate?: SafetyGate;
  onSend?: (m: CommandMessage, rig: RegRig) => void;
  dbPath?: string;
  clock?: ManualClock;
  hello?: boolean;
}

export function regRig(o: RigOptions = {}): RegRig {
  const tmp = o.dbPath ? null : tempDir();
  const dbPath = o.dbPath ?? tmp!.dbPath;
  const clock = o.clock ?? new ManualClock(T0);
  const fleet = new FleetState(clock);
  if (o.hello !== false) fleet.ingest(helloAt(clock.now()));
  const store = new Store(dbPath);
  const sent: CommandMessage[] = [];
  const events: RegistryEvent[] = [];
  let up = true;
  const seq = new Map<string, number>();
  let n = 0;
  // eslint-disable-next-line prefer-const
  let rig: RegRig;
  const registry = new CommandRegistry({
    clock, fleet, store, gate: o.gate ?? ALLOW_ALL_GATE_NO_BLAST_SAFETY,
    newId: () => `r${clock.now() - T0}-${++n}`,
    transport: { isUp: () => up, send: (m) => { if (!up) return false; sent.push(m); o.onSend?.(m, rig); return true; } },
  });
  registry.subscribe((e) => events.push(e));
  const feed = (msg: Record<string, unknown>) => { fleet.ingest(msg); registry.message(msg); };
  rig = {
    clock, fleet, store, registry, sent, events, dbPath,
    setUp(v) { up = v; fleet.setLink(v, v ? 'connected' : 'down'); if (!v) registry.linkDown('test'); },
    feed,
    tel(vehicle, over = {}) {
      const s = (seq.get(vehicle) ?? 0) + 1;
      seq.set(vehicle, s);
      feed(telemetry({ vehicle_id: vehicle, seq: s, t_device_ms: clock.now(), ...over }));
    },
    ack(commandId, status, extra = {}) {
      const vehicle = sent.find((m) => m.command_id === commandId)?.vehicle_id ?? null;
      feed({ type: 'command_ack', command_id: commandId, vehicle_id: vehicle, status, server_time_ms: fleet.serverNow(), ...extra });
    },
    advance(ms, stepMs = 100) {
      for (let left = ms; left > 0; left -= stepMs) {
        clock.advance(Math.min(stepMs, left));
        fleet.tick();
        registry.tick();
      }
    },
    restart(r = {}) {
      store.close();
      return regRig({ dbPath, clock, gate: r.gate ?? o.gate, onSend: o.onSend, hello: o.hello });
    },
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      tmp?.cleanup();
    },
  };
  return rig;
}
