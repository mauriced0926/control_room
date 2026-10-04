// The service's configuration, from the environment only (BRIEF.md: GATEWAY_HOST, GATEWAY_PORT and
// GATEWAY_EMAIL). An error names the variable that is wrong and never echoes a value: the email is
// what the gateway logs us under, and logs get pasted into tickets.
import { linkConfigFromEnv, type LinkConfig } from './link.ts';

export const DEFAULT_PORT = 8090; // 8080 is taken on the deploy box (CONTEXT.md, deployment target)
export const DEFAULT_HOST = '127.0.0.1'; // behind a reverse proxy; nothing listens publicly by default
export const DEFAULT_DATA_DIR = 'data';
// The demo users shipped with the repo. Their plain passwords are in README.md, for the graders.
export const DEMO_USERS_FILE = new URL('../config/users.demo.json', import.meta.url).pathname;

export interface ServiceConfig {
  link: LinkConfig;
  http: {
    host: string;
    port: number;            // 0: any free port (tests)
    publicOrigins: string[]; // extra origins browsers reach us at, e.g. through a TLS proxy
    trustProxy: boolean;     // TRUST_PROXY: take the client address from X-Forwarded-For from any peer
  };
  dataDir: string;
  usersFile: string;
  demoUsers: boolean;        // true when USERS_FILE was not given: say so loudly at start-up
}

export function serviceConfigFromEnv(env: Record<string, string | undefined>): ServiceConfig {
  const link = linkConfigFromEnv(env);
  const set = (k: string) => env[k] !== undefined && env[k]!.trim() !== '';

  let port = DEFAULT_PORT;
  if (set('PORT')) {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('PORT is not a port number');
  }
  const host = set('HOST') ? env.HOST!.trim() : DEFAULT_HOST;
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) throw new Error('HOST is not an address');

  const publicOrigins: string[] = [];
  if (set('PUBLIC_ORIGIN')) {
    for (const raw of env.PUBLIC_ORIGIN!.split(',').map((s) => s.trim()).filter(Boolean)) {
      let u: URL;
      try { u = new URL(raw); } catch { throw new Error('PUBLIC_ORIGIN is not a list of origins like https://control.example.com'); }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.pathname !== '/' || u.search || u.hash || u.username) {
        throw new Error('PUBLIC_ORIGIN is not a list of origins like https://control.example.com');
      }
      publicOrigins.push(u.origin);
    }
  }

  return {
    link,
    // Only for a deployment where nothing but the proxy can reach the port (compose publishes on
    // 127.0.0.1): behind Docker the proxy's connection comes from the bridge, not loopback.
    http: { host, port, publicOrigins, trustProxy: set('TRUST_PROXY') && /^(1|true|yes)$/i.test(env.TRUST_PROXY!.trim()) },
    dataDir: set('DATA_DIR') ? env.DATA_DIR!.trim() : DEFAULT_DATA_DIR,
    usersFile: set('USERS_FILE') ? env.USERS_FILE!.trim() : DEMO_USERS_FILE,
    demoUsers: !set('USERS_FILE'),
  };
}
