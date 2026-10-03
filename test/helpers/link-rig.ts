// The gateway link and the command registry, wired together as the service will wire them, against
// the in-process fake gateway on a manual clock.
//
// The fake's milestone 1 has no link faults, so this dialer plays them at the transport, the way
// the live site shows them (research/fixtures/link-drop-in-notice):
//   - 'outage': a login is accepted and the connection closed before hello;
//   - 'blackhole': the connection stays open but nothing arrives (no heartbeats);
//   - dropAll(): the gateway closes every open connection.
// Milestone 2 of the fake adds outages of its own; these stay as the transport-level version.
import { ManualClock } from '../../src/clock.ts';
import { FleetState } from '../../src/fleet.ts';
import { attachRegistry, GatewayLink, type Dialer, type LinkEvent } from '../../src/link.ts';
import { ALLOW_ALL_GATE_NO_BLAST_SAFETY, CommandRegistry, type RegistryEvent, type SafetyGate } from '../../src/registry.ts';
import { Store } from '../../src/store.ts';
import { FakeGateway, type Connection, type FakeConfig } from '../../fake/gateway.ts';
import { DLH1 } from '../../fake/dlh1.ts';
import { T0 } from './rig.ts';
import { tempDir } from './registry-rig.ts';

export type DialMode = 'normal' | 'outage' | 'blackhole';

export class FakeDialer {
  mode: DialMode = 'normal';
  readonly dialTimes: number[] = [];
  readonly sentLines: string[] = [];
  readonly #gw: FakeGateway;
  readonly #clock: ManualClock;
  readonly #open = new Set<{ conn: Connection; close(): void }>();

  constructor(gw: FakeGateway, clock: ManualClock) {
    this.#gw = gw;
    this.#clock = clock;
  }

  get dials(): number { return this.dialTimes.length; }
  get openConnections(): number { return this.#open.size; }

  dial: Dialer = (h) => {
    this.dialTimes.push(this.#clock.now());
    if (this.mode === 'outage') {
      let closed = false;
      return {
        write: (line) => { this.sentLines.push(line); if (!closed) { closed = true; h.onClose('closed by the gateway'); } },
        close: () => { closed = true; },
      };
    }
    let closed = false;
    const conn = this.#gw.attach({
      write: (line) => { if (!closed && this.mode !== 'blackhole') h.onLine(line); },
      close: () => { if (!closed) { closed = true; this.#open.delete(entry); h.onClose('connection closed by the gateway'); } },
    });
    const entry = { conn, close: () => { closed = true; this.#open.delete(entry); conn.disconnect(); } };
    this.#open.add(entry);
    return {
      write: (line) => { this.sentLines.push(line); if (!closed) conn.receive(line); },
      close: () => entry.close(),
    };
  };

  // The gateway drops everyone.
  dropAll(): void {
    for (const e of [...this.#open]) this.#gw.drop(e.conn, true);
  }
}

export interface LinkRig {
  clock: ManualClock;
  gw: FakeGateway;
  dialer: FakeDialer;
  fleet: FleetState;
  store: Store;
  registry: CommandRegistry;
  link: GatewayLink;
  linkEvents: LinkEvent[];
  events: RegistryEvent[];
  dbPath: string;
  advance(ms: number, stepMs?: number): void;
  until(pred: () => boolean, maxMs: number, stepMs?: number): number; // elapsed ms, or -1
  restartService(): LinkRig; // a new process on the same database, the same gateway and clock
  cleanup(): void;
}

export function linkRig(config: Partial<FakeConfig> = {}, o: { gate?: SafetyGate; random?: () => number; email?: string; shared?: { clock: ManualClock; gw: FakeGateway; dialer: FakeDialer; dbPath: string } } = {}): LinkRig {
  const tmp = o.shared ? null : tempDir();
  const clock = o.shared?.clock ?? new ManualClock(T0);
  const gw = o.shared?.gw ?? new FakeGateway(clock, { seed: 7, site: DLH1, blasts: 'none', ...config });
  if (!o.shared) gw.start();
  const dialer = o.shared?.dialer ?? new FakeDialer(gw, clock);
  const dbPath = o.shared?.dbPath ?? tmp!.dbPath;
  const fleet = new FleetState(clock);
  const store = new Store(dbPath);
  const link = new GatewayLink({ clock, fleet, dial: dialer.dial, email: o.email ?? 'service@example.com', random: o.random ?? (() => 0.5) });
  let n = 0;
  const registry = new CommandRegistry({ clock, fleet, store, transport: link, gate: o.gate ?? ALLOW_ALL_GATE_NO_BLAST_SAFETY, newId: () => `r${clock.now() - T0}-${++n}-${Math.floor(clock.now() % 997)}` });
  attachRegistry(link, registry);
  const linkEvents: LinkEvent[] = [];
  const events: RegistryEvent[] = [];
  link.subscribe((e) => linkEvents.push(e));
  registry.subscribe((e) => events.push(e));
  fleet.start();
  registry.start();
  const rig: LinkRig = {
    clock, gw, dialer, fleet, store, registry, link, linkEvents, events, dbPath,
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
      link.stop();
      registry.stop();
      fleet.stop();
      store.close();
      return linkRig(config, { ...o, shared: { clock, gw, dialer, dbPath } });
    },
    cleanup() {
      link.stop();
      registry.stop();
      fleet.stop();
      try { store.close(); } catch { /* closed already */ }
      if (!o.shared) { gw.stop(); tmp?.cleanup(); }
    },
  };
  return rig;
}
