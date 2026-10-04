// End to end: the real service (`node src/main.ts`, a child process) against the fake gateway over
// TLS (fake/tls.ts) on 127.0.0.1, on the real clock. The certificate is made with openssl at test time
// in a temporary directory and deleted after; the service trusts it through NODE_EXTRA_CA_CERTS, a
// Node feature, so the product has no test-only trust code. The child's environment is built from
// scratch: nothing from the developer's shell (or a .env) leaks in, and it can never reach the real
// gateway.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SystemClock } from '../../src/clock.ts';
import { hashPassword } from '../../src/users.ts';
import { DEFAULT_BEHAVIOUR } from '../../fake/behaviour.ts';
import { DLH1 } from '../../fake/dlh1.ts';
import { LIVE_DAY, planTrucks, type Faults } from '../../fake/faults.ts';
import { FakeGateway, type Connection } from '../../fake/gateway.ts';
import { listenTls, type TlsServer } from '../../fake/tls.ts';

export const HAVE_OPENSSL = !spawnSync('openssl', ['version'], { stdio: 'ignore' }).error;
export const MAIN = new URL('../../src/main.ts', import.meta.url).pathname;
export const EMAIL = 'e2e-gateway-login@example.org';

export function tempDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeCert(dir: string): { key: Buffer; cert: Buffer; certPath: string } {
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'pipe' });
  assert.equal(r.status, 0, `openssl failed: ${r.stderr}`);
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')), certPath: join(dir, 'cert.pem') };
}

// The fake gateway over TLS, recording every line any client sends it and every login.
export class FakeSite {
  readonly gw: FakeGateway;
  readonly lines: string[] = [];   // every line received from any client, as received
  logins = 0;                      // connections that sent a valid auth line
  #server: TlsServer | null = null;
  #port = 0;
  readonly #tls: { key: Buffer; cert: Buffer };
  readonly seed: number;
  readonly faults: Faults;

  constructor(tls: { key: Buffer; cert: Buffer }, o: { seed?: number; faults?: Faults; blasts?: 'random' | 'none' } = {}) {
    this.#tls = tls;
    this.seed = o.seed ?? 11;
    this.faults = o.faults ?? LIVE_DAY;
    this.gw = new FakeGateway(new SystemClock(), { seed: this.seed, site: DLH1, blasts: o.blasts ?? 'random', faults: this.faults });
    const receive = this.gw.receive.bind(this.gw);
    this.gw.receive = (conn: Connection, line: string) => {
      this.lines.push(line);
      const wasAuthed = conn.authed;
      receive(conn, line);
      if (!wasAuthed && conn.authed) this.logins++;
    };
    this.gw.start();
  }

  get port(): number { return this.#port; }

  async listen(): Promise<void> {
    this.#server = await listenTls(this.gw, { ...this.#tls, port: this.#port });
    this.#port = this.#server.port;
  }

  // The site link drops: every connection closed, nothing listening, until listen() again.
  async down(): Promise<void> {
    await this.#server?.close();
    this.#server = null;
  }

  sent(): Array<Record<string, any>> {
    return this.lines.map((l) => { try { return JSON.parse(l); } catch { return { unparseable: l }; } });
  }

  commands(): Array<Record<string, any>> { return this.sent().filter((m) => m.type === 'command'); }

  // Trucks the fake's live day leaves alone (no telemetry fault planned), so their telemetry can
  // confirm a command.
  cleanTrucks(): string[] {
    const plan = planTrucks(this.faults, DLH1.vehicles, DEFAULT_BEHAVIOUR, this.seed);
    const busy = new Set(Object.values(plan).map((p) => p?.vehicle));
    return DLH1.vehicles.filter((v) => !busy.has(v));
  }

  async stop(): Promise<void> {
    this.gw.stop();
    await this.#server?.close();
  }
}

// Users for most end-to-end tests, at a cheap scrypt cost so logins are quick. The demo file, at the
// real cost, is used by the L13.1 test.
export const PASSWORDS = { priya: 'priya-e2e-pass', dave: 'dave-e2e-pass', marta: 'marta-e2e-pass' } as const;

export async function writeUsers(dir: string): Promise<string> {
  const cheap = { N: 2 ** 10, r: 8, p: 1 };
  const users = [
    { id: 'priya', name: 'Priya', role: 'operator', passwordHash: await hashPassword(PASSWORDS.priya, cheap) },
    { id: 'dave', name: 'Dave', role: 'operator', passwordHash: await hashPassword(PASSWORDS.dave, cheap) },
    { id: 'marta', name: 'Marta', role: 'supervisor', passwordHash: await hashPassword(PASSWORDS.marta, cheap) },
  ];
  const path = join(dir, 'users.json');
  writeFileSync(path, JSON.stringify({ users }));
  return path;
}

export interface RunningService {
  child: ChildProcess;
  url: string;
  port: number;
  origin: string;
  output(): string;
  exited: Promise<number | null>;
  stop(): Promise<number | null>;
}

// Starts `node src/main.ts` with exactly this environment (plus PATH), and waits for "listening on".
export async function startServiceProcess(env: Record<string, string>, o: { cwd?: string; timeoutMs?: number } = {}): Promise<RunningService> {
  const child = spawn(process.execPath, [MAIN], { cwd: o.cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => { out += c; });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { out += c; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const url = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`service did not start:\n${out}`)), o.timeoutMs ?? 20_000);
    const check = () => {
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) { clearTimeout(deadline); resolve(m[1]!); }
    };
    child.stdout!.on('data', check);
    void exited.then((code) => { clearTimeout(deadline); reject(new Error(`service exited with ${code} before listening:\n${out}`)); });
  });
  const port = Number(new URL(url).port);
  return {
    child, url, port, origin: `http://127.0.0.1:${port}`, output: () => out, exited,
    stop: async () => { if (child.exitCode === null) child.kill('SIGTERM'); return exited; },
  };
}

export interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

export function http(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

export async function login(s: RunningService, user: string, password: string): Promise<string> {
  const res = await http(s.port, 'POST', '/login', {
    headers: { origin: s.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user, password }).toString(),
  });
  const set = (res.headers['set-cookie'] as string[] | undefined)?.[0];
  assert.ok(set, `login as ${user} failed: ${res.status} ${String(res.headers.location)}`);
  return set.split(';')[0]!;
}

// A browser's live connection: every message it got, and a way to wait for one.
export class LiveClient {
  readonly messages: Array<Record<string, any>> = [];
  closeCode: number | null = null;
  readonly ws: WebSocket;
  readonly opened: Promise<void>;

  constructor(s: RunningService, cookie: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/live`, { headers: { origin: s.origin, cookie } });
    this.ws.on('message', (d) => { try { this.messages.push(JSON.parse(String(d))); } catch { /* not ours */ } });
    this.ws.on('close', (code) => { this.closeCode = code; });
    this.ws.on('error', () => { /* close follows */ });
    this.opened = new Promise((resolve, reject) => { this.ws.once('open', () => resolve()); this.ws.once('unexpected-response', (_q, r) => reject(new Error(`upgrade refused: ${r.statusCode}`))); });
  }

  frames(): Array<Record<string, any>> { return this.messages.filter((m) => m.type === 'frame'); }
  lastFrame(): Record<string, any> | undefined { return this.frames().at(-1); }
  results(): Array<Record<string, any>> { return this.messages.filter((m) => m.type === 'result'); }

  send(m: unknown): void { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }

  // Sends a message with a ref and waits for its result.
  async ask(m: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, any>> {
    const ref = `t${Math.random().toString(36).slice(2, 10)}`;
    this.send({ ...m, ref });
    return waitFor(() => this.results().find((r) => r.ref === ref), timeoutMs, `result for ${JSON.stringify(m)}`);
  }

  close(): void { this.ws.close(); }
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
