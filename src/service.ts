// The service: one process that holds the one gateway connection, the fleet state, the command
// registry and its log, and serves every operator's browser (task 6b). It runs whether or not any
// browser is open (CONTEXT.md assumption 1); browsers never talk to the gateway and never hold the
// only copy of anything.
//
// Everything is injected (clock, dialer, users), so tests run it in-process against the fake gateway
// on a manual clock, and src/main.ts runs it for real.
import { BlastEngine } from './blast.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { FleetState } from './fleet.ts';
import { startHttp, type AuthEvent } from './http.ts';
import { DriveRelay } from './drive.ts';
import { attachRegistry, GatewayLink, type Dialer } from './link.ts';
import { BlastGate } from './gate.ts';
import { LiveHub } from './live.ts';
import { CommandRegistry } from './registry.ts';
import { END_WORDS, LoginThrottle, Sessions } from './sessions.ts';
import { Store, type AuditEntry } from './store.ts';
import type { UserBook } from './users.ts';

export interface ServiceOptions {
  clock: Clock;
  dial: Dialer;
  email: string;            // the gateway login; never logged
  dbPath: string;           // SQLite file, or ':memory:'
  users: UserBook;
  http: { host: string; port: number; publicOrigins: string[]; trustProxy?: boolean };
  log: (line: string) => void;
  random?: () => number;
}

export interface Service {
  url: string;
  port: number;
  origins: string[];
  fleet: FleetState;
  link: GatewayLink;
  registry: CommandRegistry;
  store: Store;
  sessions: Sessions;
  hub: LiveHub;
  drive: DriveRelay;
  blast: BlastEngine;
  close(): Promise<void>;
}

const SWEEP_MS = 60_000;

export async function startService(o: ServiceOptions): Promise<Service> {
  const { clock, log } = o;
  const store = new Store(o.dbPath);
  const fleet = new FleetState(clock);
  fleet.start();
  const link = new GatewayLink({ clock, fleet, dial: o.dial, email: o.email, ...(o.random ? { random: o.random } : {}) });
  // Every command, operators' and the system's, passes the blast engine's safety check (L2.53).
  const registry = new CommandRegistry({ clock, fleet, store, transport: link, gate: new BlastGate(fleet, () => engine) });
  attachRegistry(link, registry);
  registry.start();
  // The blast engine (BLAST.md): after the registry, so on reconnect the registry has replayed its
  // commands before the engine decides on the hello snapshot.
  const engine = new BlastEngine({ clock, fleet, registry, store, link, log });
  engine.start();

  link.subscribe((e) => {
    if (e.type === 'status') log(`site link ${e.status.state}: ${e.status.reason}`);
    else if (e.type === 'alarm') log(`ALARM: ${e.message}`);
  });
  registry.subscribe((e) => { if (e.type === 'alarm') log(`ALARM (${e.kind}, ${e.vehicleId}): ${e.message}`); });

  const audit = (a: Omit<AuditEntry, 'atMs' | 'serverMs' | 'rule' | 'vehicleId' | 'recordId' | 'commandId' | 'inputs' | 'actorKind'>) => {
    store.audit({ ...a, atMs: clock.now(), serverMs: fleet.serverNow(), actorKind: 'operator', rule: null, vehicleId: null, recordId: null, commandId: null, inputs: undefined });
  };

  const sessions = new Sessions(clock);
  sessions.onEnd((s, why) => {
    audit({ actor: s.user.id, event: 'logout', what: `${s.user.name} (${s.user.role}) logged out`, why: END_WORDS[why] });
    log(`logout: ${s.user.id} (${END_WORDS[why]})`);
  });
  let sweep: TimerHandle | null = null;
  const sweepLoop = () => { sessions.sweep(); sweep = clock.setTimeout(sweepLoop, SWEEP_MS); };
  sweep = clock.setTimeout(sweepLoop, SWEEP_MS);

  const onAuth = (e: AuthEvent) => {
    if (e.event === 'login') {
      audit({ actor: e.user.id, event: 'login', what: `${e.user.name} (${e.user.role}) logged in`, why: null });
      log(`login: ${e.user.id} (${e.user.role}) from ${e.address}`);
    } else {
      // The name typed is recorded only if it is a real user: people type passwords into name fields.
      audit({ actor: e.userId ?? 'unknown', event: 'login_failed', what: e.throttled ? 'login refused: too many failed attempts' : 'login failed: wrong name or password', why: null });
      log(`login failed${e.throttled ? ' (throttled)' : ''}: ${e.userId ?? 'an unknown name'} from ${e.address}`);
    }
  };

  // Drive input from browsers, relayed only while fresh (CLAUDE.md invariant 3).
  const drive = new DriveRelay({ clock, fleet, registry, link, log, audit: (e) => store.audit(e) });
  // The blast engine raises its own can't-clear alarms and owns the verdict, so the provisional
  // alarm from the truck-detail task stands down (provisionalBlast: false).
  const hub = new LiveHub({ clock, fleet, link, registry, sessions, log, store, drive, blast: engine, blastSafetyActive: true, provisionalBlast: () => false });
  hub.start();
  const http = await startHttp({ ...o.http, users: o.users, sessions, throttle: new LoginThrottle(clock), hub, onAuth, log });
  link.start(); // the one gateway connection (L6.4): nothing a browser does opens another

  return {
    url: http.url, port: http.port, origins: http.origins, fleet, link, registry, store, sessions, hub, drive, blast: engine,
    close: async () => {
      if (sweep) clock.clearTimeout(sweep);
      await http.close();
      engine.shutdown();
      registry.stop();
      drive.stop();
      link.stop();
      fleet.stop();
      store.close();
    },
  };
}
