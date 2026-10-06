// The blast engine wired as the service wires it (fleet, link, registry, engine, one store) against the
// in-process fake gateway on a manual clock. Scenario tests place trucks and schedule blasts; the L4
// property run uses the same rig on seeded random days.
import { BlastEngine, type BlastEvent } from '../../src/blast.ts';
import { ManualClock } from '../../src/clock.ts';
import { FleetState } from '../../src/fleet.ts';
import { attachRegistry, GatewayLink } from '../../src/link.ts';
import { ALLOW_ALL_GATE_NO_BLAST_SAFETY, CommandRegistry, type RegistryEvent, type SafetyGate } from '../../src/registry.ts';
import { Store } from '../../src/store.ts';
import { DLH1 } from '../../fake/dlh1.ts';
import { FakeGateway, type FakeConfig } from '../../fake/gateway.ts';
import { FakeDialer } from './link-rig.ts';
import { tempDir } from './registry-rig.ts';
import { T0 } from './rig.ts';

export interface BlastRig {
  clock: ManualClock;
  gw: FakeGateway;
  dialer: FakeDialer;
  fleet: FleetState;
  store: Store;
  registry: CommandRegistry;
  link: GatewayLink;
  engine: BlastEngine;
  events: BlastEvent[];
  regEvents: RegistryEvent[];
  log: string[];
  dbPath: string;
  advance(ms: number, stepMs?: number): void;
  until(pred: () => boolean, maxMs: number, stepMs?: number): number;
  restartService(): BlastRig;
  cleanup(): void;
}

export interface BlastRigOptions {
  gate?: (fleet: FleetState, engine: () => BlastEngine) => SafetyGate; // default: allow all
  shared?: { clock: ManualClock; gw: FakeGateway; dialer: FakeDialer; dbPath: string; cleanupDir?: () => void };
  dbPath?: string; // ':memory:' for the L4 run
}

export function blastRig(config: Partial<FakeConfig> = {}, o: BlastRigOptions = {}): BlastRig {
  const tmp = o.shared || o.dbPath ? null : tempDir();
  const clock = o.shared?.clock ?? new ManualClock(T0);
  const gw = o.shared?.gw ?? new FakeGateway(clock, { seed: 7, site: DLH1, blasts: 'none', ...config });
  if (!o.shared) gw.start();
  const dialer = o.shared?.dialer ?? new FakeDialer(gw, clock);
  const dbPath = o.shared?.dbPath ?? o.dbPath ?? tmp!.dbPath;
  const fleet = new FleetState(clock);
  const store = new Store(dbPath);
  const link = new GatewayLink({ clock, fleet, dial: dialer.dial, email: 'service@example.com', random: () => 0.5 });
  let n = 0;
  // eslint-disable-next-line prefer-const
  let engine: BlastEngine;
  const gate: SafetyGate = o.gate ? o.gate(fleet, () => engine) : ALLOW_ALL_GATE_NO_BLAST_SAFETY;
  const registry = new CommandRegistry({ clock, fleet, store, transport: link, gate, newId: () => `b${clock.now() - T0}-${++n}` });
  attachRegistry(link, registry);
  const log: string[] = [];
  engine = new BlastEngine({ clock, fleet, registry, store, link, log: (l) => log.push(l) });
  const events: BlastEvent[] = [];
  const regEvents: RegistryEvent[] = [];
  engine.subscribe((e) => events.push(e));
  registry.subscribe((e) => regEvents.push(e));
  fleet.start();
  registry.start();
  engine.start();
  link.start();
  const rig: BlastRig = {
    clock, gw, dialer, fleet, store, registry, link, engine, events, regEvents, log, dbPath,
    advance(ms, stepMs = 50) {
      for (let left = ms; left > 0; left -= stepMs) clock.advance(Math.min(stepMs, left));
    },
    until(pred, maxMs, stepMs = 50) {
      const start = clock.now();
      while (clock.now() - start <= maxMs) {
        if (pred()) return clock.now() - start;
        clock.advance(stepMs);
      }
      return -1;
    },
    restartService() {
      engine.shutdown();
      link.stop();
      registry.stop();
      fleet.stop();
      store.close();
      return blastRig(config, { ...o, shared: { clock, gw, dialer, dbPath, cleanupDir: o.shared?.cleanupDir ?? tmp?.cleanup } });
    },
    cleanup() {
      engine.shutdown();
      link.stop();
      registry.stop();
      fleet.stop();
      try { store.close(); } catch { /* closed already */ }
      gw.stop();
      tmp?.cleanup();
      o.shared?.cleanupDir?.();
    },
  };
  return rig;
}
