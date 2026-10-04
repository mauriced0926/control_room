// The control-room service: `npm start`. Reads its configuration from the environment
// (src/config.ts), connects to the site gateway over TLS, and serves the operators' screens.
// Never prints a credential: not the gateway email, not a password, not a session id.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isoTime, SystemClock } from './clock.ts';
import { serviceConfigFromEnv } from './config.ts';
import { tlsDialer } from './link.ts';
import { startService } from './service.ts';
import { UserBook } from './users.ts';

const clock = new SystemClock();
const log = (line: string) => console.log(`${isoTime(clock.now())} ${line}`);

let cfg;
let users;
try {
  cfg = serviceConfigFromEnv(process.env);
  users = UserBook.fromFile(cfg.usersFile);
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
} catch (e) {
  console.error(`cannot start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

log(`starting: gateway ${cfg.link.host}:${cfg.link.port}, ${users.size} users from ${cfg.usersFile}, data in ${cfg.dataDir}`);
if (cfg.demoUsers) log('USING DEMO USERS: their passwords are published in README.md. Set USERS_FILE to your own users file before real use.');

const svc = await startService({
  clock,
  dial: tlsDialer({ host: cfg.link.host, port: cfg.link.port }),
  email: cfg.link.email,
  dbPath: join(cfg.dataDir, 'control-room.db'),
  users,
  http: cfg.http,
  log,
});
log(`listening on ${svc.url} (allowed origins: ${svc.origins.join(', ')})`);

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  void svc.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
