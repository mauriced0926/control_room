// Task 6b: the service's HTTP side, in-process: real HTTP and WebSocket on 127.0.0.1, the fake
// gateway on a manual clock behind it. Cases: L8.6 (every route and the WebSocket refuse an
// unauthenticated user), login and logout in the audit log, cookies, Origin and Host checks,
// throttling, the idle timeout, and L6.4 (one gateway connection for any number of browsers).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import WebSocket from 'ws';
import { PARAMS } from '../src/params.ts';
import { startService, type Service } from '../src/service.ts';
import { hashPassword, parseUsers, UserBook } from '../src/users.ts';
import { FakeGateway } from '../fake/gateway.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { ManualClock } from '../src/clock.ts';
import { FakeDialer } from './helpers/link-rig.ts';
import { tempDir } from './helpers/registry-rig.ts';
import { T0 } from './helpers/rig.ts';

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORDS = { priya: 'priya-password', dave: 'dave-password', marta: 'marta-password' };

async function users(): Promise<UserBook> {
  const list = [
    { id: 'priya', name: 'Priya', role: 'operator', passwordHash: await hashPassword(PASSWORDS.priya, CHEAP) },
    { id: 'dave', name: 'Dave', role: 'operator', passwordHash: await hashPassword(PASSWORDS.dave, CHEAP) },
    { id: 'marta', name: 'Marta', role: 'supervisor', passwordHash: await hashPassword(PASSWORDS.marta, CHEAP) },
  ];
  return new UserBook(parseUsers(JSON.stringify({ users: list })));
}

interface Rig {
  svc: Service;
  gw: FakeGateway;
  clock: ManualClock;
  dialer: FakeDialer;
  logs: string[];
  origin: string;
  host: string;
}

async function rig(t: TestContext): Promise<Rig> {
  const clock = new ManualClock(T0);
  const gw = new FakeGateway(clock, { seed: 3, site: DLH1, blasts: 'none' });
  gw.start();
  const dialer = new FakeDialer(gw, clock);
  const tmp = tempDir();
  const logs: string[] = [];
  const svc = await startService({
    clock, dial: dialer.dial, email: 'secret-service-login@example.org', dbPath: tmp.dbPath, users: await users(),
    http: { host: '127.0.0.1', port: 0, publicOrigins: [] }, log: (l) => logs.push(l), random: () => 0.5,
  });
  for (let i = 0; i < 40 && !svc.link.isUp(); i++) clock.advance(50);
  assert.ok(svc.link.isUp());
  clock.advance(1_000);
  t.after(async () => { await svc.close(); gw.stop(); tmp.cleanup(); });
  return { svc, gw, clock, dialer, logs, origin: `http://127.0.0.1:${svc.port}`, host: `127.0.0.1:${svc.port}` };
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function http(r: Rig, method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: r.svc.port, method, path, agent: false, headers: { host: r.host, ...o.headers } }, (res) => {
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

const form = (u: string, p: string) => new URLSearchParams({ username: u, password: p }).toString();

async function login(r: Rig, user: keyof typeof PASSWORDS, password = PASSWORDS[user]): Promise<{ res: Res; cookie: string | null }> {
  const res = await http(r, 'POST', '/login', { headers: { origin: r.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: form(user, password) });
  const set = res.headers['set-cookie']?.[0] ?? null;
  return { res, cookie: set ? set.split(';')[0]! : null };
}

function ws(r: Rig, headers: Record<string, string>, path = '/api/live'): Promise<{ ws: WebSocket; first: Record<string, any> } | { status: number }> {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${r.svc.port}${path}`, { headers: { host: r.host, ...headers } });
    sock.once('message', (d) => resolve({ ws: sock, first: JSON.parse(String(d)) }));
    sock.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode! }); res.resume(); });
    sock.once('error', () => { /* reported through unexpected-response */ });
  });
}

test('L8.6 every route and the WebSocket refuse an unauthenticated user; only the login page and its stylesheet are open', async (t) => {
  const r = await rig(t);
  const routes: Array<[string, string]> = [
    ['GET', '/'], ['GET', '/src/ui/index.html'], ['GET', '/src/ui/app.ts'], ['GET', '/src/fleet.ts'], ['GET', '/src/users.ts'],
    ['GET', '/api/session'], ['GET', '/api/live'], ['GET', '/nonexistent'], ['GET', '/src/../package.json'], ['GET', '/config/users.demo.json'],
    ['POST', '/logout'], ['POST', '/api/session'], ['PUT', '/'], ['DELETE', '/api/session'], ['GET', '/src/ui/overview.css/../app.ts'],
  ];
  for (const [method, path] of routes) {
    const res = await http(r, method, path, { headers: { origin: r.origin } });
    if (method === 'GET' && path === '/') {
      assert.equal(res.status, 303);
      assert.equal(res.headers.location, '/login');
    } else {
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.ok(!/import |export |scrypt/.test(res.body), `${method} ${path} leaks nothing`);
  }
  assert.equal((await http(r, 'GET', '/login')).status, 200);
  assert.equal((await http(r, 'GET', '/src/ui/overview.css')).status, 200);

  const tries: Array<Record<string, string>> = [{ origin: r.origin }, { origin: r.origin, cookie: 'cr_session=' + 'A'.repeat(43) }, { origin: r.origin, cookie: 'cr_session=garbage' }];
  for (const headers of tries) {
    const res = await ws(r, headers);
    assert.deepEqual(res, { status: 401 }, JSON.stringify(headers));
  }
  assert.equal(r.svc.hub.clientCount, 0);
});

test('login: a wrong password gets no cookie; the right one gets an HttpOnly SameSite=Strict session cookie; both are audited', async (t) => {
  const r = await rig(t);
  const bad = await login(r, 'priya', 'nope-nope');
  assert.equal(bad.res.status, 303);
  assert.equal(bad.res.headers.location, '/login?failed');
  assert.equal(bad.cookie, null);
  assert.match((await http(r, 'GET', '/login?failed')).body, /Login refused/);

  const unknown = await http(r, 'POST', '/login', { headers: { origin: r.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: form('my-secret-pa55word', 'x') });
  assert.equal(unknown.headers.location, '/login?failed');

  const ok = await login(r, 'priya');
  assert.equal(ok.res.status, 303);
  assert.equal(ok.res.headers.location, '/');
  const set = (ok.res.headers['set-cookie'] as string[])[0]!;
  assert.match(set, /^cr_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
  assert.ok(!/Secure/.test(set), 'plain http on loopback: Secure would stop the cookie being sent');

  const page = await http(r, 'GET', '/', { headers: { cookie: ok.cookie! } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<body data-mode="live">/);
  const who = await http(r, 'GET', '/api/session', { headers: { cookie: ok.cookie! } });
  assert.deepEqual(JSON.parse(who.body), { user: { id: 'priya', name: 'Priya', role: 'operator' } });
  assert.equal((await http(r, 'GET', '/src/ui/app.ts', { headers: { cookie: ok.cookie! } })).status, 200);

  const audit = r.svc.store.auditLog().filter((a) => a.event.startsWith('login'));
  assert.deepEqual(audit.map((a) => [a.event, a.actor]), [['login_failed', 'priya'], ['login_failed', 'unknown'], ['login', 'priya']]);
  const everything = JSON.stringify(r.svc.store.auditLog()) + r.logs.join('\n');
  for (const secret of ['nope-nope', 'my-secret-pa55word', PASSWORDS.priya, ok.cookie!.split('=')[1]!, 'secret-service-login@example.org']) {
    assert.ok(!everything.includes(secret), `neither the audit log nor the service log contains ${secret.slice(0, 6)}…`);
  }
});

test('Origin and Host: a POST or WebSocket from another site, or with no Origin, is refused; an unknown Host is refused', async (t) => {
  const r = await rig(t);
  const { cookie } = await login(r, 'dave');
  assert.ok(cookie);
  const evil = await http(r, 'POST', '/login', { headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: form('dave', PASSWORDS.dave) });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['set-cookie'], undefined);
  const none = await http(r, 'POST', '/logout', { headers: { cookie: cookie! } });
  assert.equal(none.status, 403, 'POST without Origin');
  assert.equal((await http(r, 'GET', '/api/session', { headers: { cookie: cookie! } })).status, 200, 'and the session was not ended by it');
  assert.deepEqual(await ws(r, { origin: 'https://evil.example', cookie: cookie! }), { status: 403 });
  assert.deepEqual(await ws(r, { cookie: cookie! }), { status: 403 }, 'WebSocket without Origin');
  const rebound = await http(r, 'GET', '/', { headers: { host: 'attacker.example:80', cookie: cookie! } });
  assert.equal(rebound.status, 421);
  const ok = await ws(r, { origin: r.origin, cookie: cookie! });
  assert.ok('ws' in ok);
  ok.ws.close();
});

test('security headers on every response', async (t) => {
  const r = await rig(t);
  for (const path of ['/login', '/', '/src/ui/overview.css']) {
    const res = await http(r, 'GET', path);
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'; script-src 'self';.*frame-ancestors 'none'/, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('logout ends the session, closes its screens and is audited; the old cookie no longer works', async (t) => {
  const r = await rig(t);
  const { cookie } = await login(r, 'marta');
  const live = await ws(r, { origin: r.origin, cookie: cookie! });
  assert.ok('ws' in live);
  assert.equal(live.first.type, 'frame');
  assert.deepEqual(live.first.you, { id: 'marta', name: 'Marta', role: 'supervisor' });
  const closed = new Promise<number>((resolve) => live.ws.once('close', (code) => resolve(code)));

  const out = await http(r, 'POST', '/logout', { headers: { origin: r.origin, cookie: cookie! } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.location, '/login');
  assert.match((out.headers['set-cookie'] as string[])[0]!, /^cr_session=; .*Max-Age=0/);
  assert.equal(await closed, 4401, 'her screen was closed at once');
  assert.equal((await http(r, 'GET', '/api/session', { headers: { cookie: cookie! } })).status, 401);
  assert.deepEqual(await ws(r, { origin: r.origin, cookie: cookie! }), { status: 401 });
  const audit = r.svc.store.auditLog().filter((a) => a.event === 'login' || a.event === 'logout');
  assert.deepEqual(audit.map((a) => [a.event, a.actor, a.why]), [['login', 'marta', null], ['logout', 'marta', 'logged out']]);
});

test('the idle timeout ends a session with no screen open, and says so in the audit log', async (t) => {
  const r = await rig(t);
  const { cookie } = await login(r, 'dave');
  r.gw.stop(); // 30 minutes of simulated trucks would only slow this down
  r.clock.advance(PARAMS.sessionIdleTimeout.value);
  assert.equal((await http(r, 'GET', '/api/session', { headers: { cookie: cookie! } })).status, 401);
  const end = r.svc.store.auditLog().find((a) => a.event === 'logout');
  assert.equal(end?.actor, 'dave');
  assert.match(end!.why!, /idle for 30 min/);
});

test('throttling: after too many failures from one address even the right password is refused for a while', async (t) => {
  const r = await rig(t);
  for (let i = 0; i < PARAMS.loginMaxFailures.value; i++) assert.equal((await login(r, 'dave', `wrong-${i}`)).cookie, null);
  const blocked = await login(r, 'dave');
  assert.equal(blocked.cookie, null);
  assert.equal(blocked.res.headers.location, '/login?failed', 'the same answer as a wrong password');
  assert.ok(r.svc.store.auditLog().some((a) => a.event === 'login_failed' && /too many/.test(a.what)));
  r.gw.stop();
  r.clock.advance(PARAMS.loginFailureWindow.value);
  assert.ok((await login(r, 'dave')).cookie);
});

test('L6.4 several browsers, several operators: still one gateway connection', async (t) => {
  const r = await rig(t);
  const socks: WebSocket[] = [];
  for (const u of ['priya', 'dave', 'marta', 'priya'] as const) {
    const { cookie } = await login(r, u);
    for (let i = 0; i < 2; i++) {
      const s = await ws(r, { origin: r.origin, cookie: cookie! });
      assert.ok('ws' in s);
      socks.push(s.ws);
    }
  }
  assert.equal(r.svc.hub.clientCount, 8);
  r.clock.advance(PARAMS.livePushMinInterval.value);
  assert.equal(r.dialer.dials, 1, 'one dial');
  assert.equal(r.dialer.openConnections, 1, 'one open connection');
  const authLines = r.dialer.sentLines.filter((l) => l.includes('"type":"auth"'));
  assert.equal(authLines.length, 1);
  for (const s of socks) s.close();
});
