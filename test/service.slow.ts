// Task 6b end to end: the real service process (`node src/main.ts`) against the fake gateway's live
// day over TLS on 127.0.0.1. Claims are checked against raw data: the lines the gateway received, the
// service's own output, and its SQLite file. Never the real gateway.
// Cases: L13.1 (outside Docker), L6.4, L8.3, L8.2, L8.6, L6.5, L6.3's drive half, L7.8 through the
// server, and log hygiene.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { EMAIL, FakeSite, HAVE_OPENSSL, http, LiveClient, login, makeCert, PASSWORDS, startServiceProcess, tempDir, waitFor, writeUsers, type RunningService } from './helpers/e2e.ts';

const skip = HAVE_OPENSSL ? false : 'needs openssl to make a test certificate';

// The demo passwords, from the one place they are written (README.md).
function demoPassword(id: string): string {
  const m = new RegExp(`^\\| \`${id}\` \\| \\w+ \\| \`([^\`]+)\` \\|$`, 'm').exec(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
  assert.ok(m, `README lists ${id}`);
  return m[1]!;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

interface E2E { site: FakeSite; svc: RunningService; dir: string; cleanup(): Promise<void> }

async function e2e(t: TestContext, o: { blasts?: 'random' | 'none' } = {}): Promise<E2E> {
  const tmp = tempDir('cr-e2e-');
  const tls = makeCert(tmp.dir);
  const site = new FakeSite(tls, { blasts: o.blasts ?? 'none' });
  await site.listen();
  const svc = await startServiceProcess({
    GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(site.port), GATEWAY_EMAIL: EMAIL,
    NODE_EXTRA_CA_CERTS: tls.certPath, PORT: '0', DATA_DIR: join(tmp.dir, 'data'), USERS_FILE: await writeUsers(tmp.dir),
  });
  const cleanup = async () => { await svc.stop(); await site.stop(); tmp.cleanup(); };
  t.after(cleanup);
  await waitFor(() => /site link up: connected/.test(svc.output()), 10_000, 'the site link to come up');
  return { site, svc, dir: tmp.dir, cleanup };
}

function assertNoSecrets(out: string, extra: string[] = []): void {
  for (const s of [EMAIL, ...Object.values(PASSWORDS), ...extra]) assert.ok(!out.includes(s), `the service output must not contain ${s.slice(0, 8)}…`);
}

test('L13.1 (outside Docker) starts with only the three GATEWAY_* variables and no Anthropic key: connects and serves the UI', { skip, timeout: 60_000 }, async (t) => {
  if (!(await portFree(8090))) { t.skip('port 8090 is in use on this machine'); return; }
  const tmp = tempDir('cr-l131-');
  const tls = makeCert(tmp.dir);
  const site = new FakeSite(tls, { blasts: 'none' });
  await site.listen();
  // Only the three variables, plus NODE_EXTRA_CA_CERTS so Node trusts the fake's throwaway
  // certificate (the real gateway's is publicly trusted), and PATH. No PORT, no DATA_DIR, no
  // USERS_FILE, no ANTHROPIC_API_KEY.
  const env = { GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(site.port), GATEWAY_EMAIL: EMAIL, NODE_EXTRA_CA_CERTS: tls.certPath };
  const svc = await startServiceProcess(env, { cwd: tmp.dir });
  t.after(async () => { await svc.stop(); await site.stop(); tmp.cleanup(); });

  assert.equal(svc.url, 'http://127.0.0.1:8090/', 'the default port, on loopback');
  await waitFor(() => /site link up: connected/.test(svc.output()), 10_000, 'the site link');
  assert.deepEqual(site.sent().filter((m) => m.type === 'auth'), [{ type: 'auth', email: EMAIL }], 'one login, with GATEWAY_EMAIL');
  assert.equal(site.logins, 1);
  assert.equal((await http(svc.port, 'GET', '/login')).status, 200);
  const cookie = await login(svc, 'priya', demoPassword('priya'));
  const page = await http(svc.port, 'GET', '/', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<body data-mode="live">/);
  const app = await http(svc.port, 'GET', '/src/ui/app.ts', { headers: { cookie } });
  assert.equal(app.status, 200, 'the UI modules, type-stripped (stripTypeScriptTypes is experimental in Node 24)');
  assert.ok(!/: FleetSnapshot/.test(app.body));
  const c = new LiveClient(svc, cookie);
  const f = await waitFor(() => c.frames().find((x) => x.body.frame.snapshot.trucks.some((tr: any) => tr.confidence === 'live')), 10_000, 'a frame with live trucks');
  assert.equal(f.body.frame.live.link.state, 'up');
  assert.equal(f.body.frame.site.siteId, 'DLH-1');
  c.close();

  const out = svc.output();
  assert.doesNotMatch(out, /BLAST SAFETY NOT ACTIVE/);
  assert.match(out, /USING DEMO USERS/);
  assert.ok(!/ExperimentalWarning/.test(out), 'no experimental warnings');
  assertNoSecrets(out, [demoPassword('priya'), cookie.split('=')[1]!]);
  assert.ok(existsSync(join(tmp.dir, 'data', 'control-room.db')), 'the database in ./data');
  assert.equal(await svc.stop(), 0, 'SIGTERM stops it cleanly');
});

test('L13.1 a missing GATEWAY_* variable is named, its value never printed, and the service does not start', { skip, timeout: 30_000 }, async () => {
  const tmp = tempDir('cr-l131b-');
  try {
    await assert.rejects(
      startServiceProcess({ GATEWAY_HOST: 'gateway.invalid', GATEWAY_PORT: '7443' }, { cwd: tmp.dir, timeoutMs: 10_000 }),
      (e: Error) => {
        assert.match(e.message, /exited with 2/);
        assert.match(e.message, /cannot start: missing environment variables: GATEWAY_EMAIL/);
        assert.ok(!e.message.includes('gateway.invalid'));
        return true;
      });
  } finally { tmp.cleanup(); }
});

test('end to end: one gateway connection for many browsers (L6.4); the operator is the session\'s (L8.3); only a supervisor forces a takeover (L8.2)', { skip, timeout: 90_000 }, async (t) => {
  const { site, svc, dir } = await e2e(t);
  const priya = await login(svc, 'priya', PASSWORDS.priya);
  const dave = await login(svc, 'dave', PASSWORDS.dave);
  const marta = await login(svc, 'marta', PASSWORDS.marta);
  const clients = [priya, priya, dave, marta, marta].map((c) => new LiveClient(svc, c));
  await Promise.all(clients.map((c) => c.opened));
  const [p, , d, m] = clients as [LiveClient, LiveClient, LiveClient, LiveClient, LiveClient];
  await waitFor(() => m.lastFrame()?.body.frame.live.who.reduce((n: number, w: any) => n + w.screens, 0) === 5, 5_000, 'who\'s on');
  assert.deepEqual(m.lastFrame()!.body.frame.live.who.map((w: any) => [w.id, w.role, w.screens]), [['dave', 'operator', 1], ['marta', 'supervisor', 2], ['priya', 'operator', 2]]);

  // L6.4: five browsers, three operators, one gateway connection; a browser can't ask for another.
  for (const c of clients) c.send({ type: 'connect', host: 'dlh-gateway.fly.dev', port: 443 });
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal(site.logins, 1, 'one login at the gateway');
  assert.equal(site.sent().filter((x) => x.type === 'auth').length, 1);

  // L8.3: priya claims to be mallory; the gateway sees priya.
  const trucks = site.cleanTrucks();
  const hold = await p.ask({ type: 'command', action: 'HOLD', vehicleId: trucks[0], operator_id: 'mallory', operatorId: 'marta' });
  assert.equal(hold.ok, true);
  await waitFor(() => site.commands().some((c) => c.action === 'HOLD' && c.vehicle_id === trucks[0]), 5_000, 'the HOLD at the gateway');
  const holdLines = site.commands().filter((c) => c.action === 'HOLD');
  assert.ok(holdLines.length >= 1 && holdLines.every((c) => c.operator_id === 'priya'), JSON.stringify(holdLines));
  assert.ok(!site.lines.some((l) => l.includes('mallory')), 'mallory never reaches the gateway');
  // ...and the service's own audit log, read from its database file.
  const db = new DatabaseSync(join(dir, 'data', 'control-room.db'), { readOnly: true });
  const rows = db.prepare('SELECT actor_kind, actor, event FROM audit WHERE vehicle_id = ?').all(trucks[0]!) as Array<{ actor_kind: string; actor: string; event: string }>;
  assert.ok(rows.some((r) => r.event === 'submitted') && rows.every((r) => r.actor_kind === 'operator' && r.actor === 'priya'), JSON.stringify(rows));
  const logins = db.prepare("SELECT actor FROM audit WHERE event = 'login' ORDER BY seq").all().map((r: any) => r.actor);
  assert.deepEqual(logins, ['priya', 'dave', 'marta']);
  db.close();

  // L8.2: dave's forced takeover is refused locally and never sent; marta's is sent with force.
  const refused = await d.ask({ type: 'command', action: 'TAKE_CONTROL', vehicleId: trucks[1], force: true });
  assert.equal(refused.ok, false);
  assert.match(refused.command.summary, /Only a supervisor/);
  const forced = await m.ask({ type: 'command', action: 'TAKE_CONTROL', vehicleId: trucks[1], force: true });
  assert.equal(forced.ok, true);
  await waitFor(() => site.commands().some((c) => c.action === 'TAKE_CONTROL'), 5_000, 'the TAKE_CONTROL at the gateway');
  const takes = site.commands().filter((c) => c.action === 'TAKE_CONTROL');
  assert.ok(takes.every((c) => c.operator_id === 'marta' && c.force === true), JSON.stringify(takes));
  await waitFor(() => m.lastFrame()?.body.frame.live.leases.some((l: any) => l.vehicleId === trucks[1] && l.operatorId === 'marta'), 8_000, 'marta\'s lease on every screen');

  for (const c of clients) c.close();
  assertNoSecrets(svc.output(), [priya, dave, marta].map((c) => c.split('=')[1]!));
});

test('end to end: L8.6 against the running service; hostile browsers (L6.5) and drive messages (L6.3) do no harm', { skip, timeout: 90_000 }, async (t) => {
  const { site, svc } = await e2e(t);

  // L8.6
  for (const [method, path] of [['GET', '/src/ui/app.ts'], ['GET', '/api/session'], ['POST', '/logout'], ['GET', '/anything']] as const) {
    assert.equal((await http(svc.port, method, path, { headers: { origin: svc.origin } })).status, 401, `${method} ${path}`);
  }
  assert.equal((await http(svc.port, 'GET', '/')).headers.location, '/login');
  await assert.rejects(new LiveClient(svc, 'cr_session=' + 'x'.repeat(43)).opened, /upgrade refused: 401/);

  const cookie = await login(svc, 'dave', PASSWORDS.dave);
  const hostile = new LiveClient(svc, cookie);
  await hostile.opened;
  const before = site.commands().length;
  for (const m of ['nonsense', '[]', '{"type":"command","action":"HOLD","vehicleId":{"$gt":""}}', '{"type":"command","action":"ESTOP","vehicleId":"HT-99"}',
    '{"__proto__":{"admin":true},"type":"command","action":"RESUME"}', '{"type":"drive","vehicleId":"HT-01","lease_id":"L-1","seq":1,"throttle":1}']) {
    hostile.send(m);
    await new Promise((r) => setTimeout(r, 120));
  }
  hostile.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  await waitFor(() => hostile.results().length >= 7, 5_000, 'seven refusals');
  assert.ok(hostile.results().every((r) => r.ok === false), JSON.stringify(hostile.results()));
  assert.match(hostile.results().find((r) => /Driving/.test(r.error))!.error, /not available in this build yet/);
  // A frame over the size limit: ws closes that connection (1009), and only that one.
  hostile.ws.send('{"type":"command","why":"' + 'x'.repeat(10_000) + '"}');
  await waitFor(() => hostile.closeCode !== null, 5_000, 'the oversized frame to close the socket');
  assert.equal(hostile.closeCode, 1009);

  // The service is alive: another browser gets frames and a real command works.
  const ok = new LiveClient(svc, cookie);
  await ok.opened;
  const truck = site.cleanTrucks()[0]!;
  const res = await ok.ask({ type: 'command', action: 'HOLD', vehicleId: truck });
  assert.equal(res.ok, true);
  await waitFor(() => site.commands().length > before, 5_000, 'the good command at the gateway');
  const after = site.commands().slice(before);
  assert.deepEqual(after.map((c) => [c.action, c.vehicle_id, c.operator_id]).filter((x, i, a) => a.findIndex((y) => y[0] === x[0] && y[1] === x[1]) === i), [['HOLD', truck, 'dave']], 'only the good command reached the gateway');
  assert.ok(!site.sent().some((x) => x.type === 'drive'), 'no drive message ever reached the gateway');
  assert.equal(svc.child.exitCode, null, 'still running');
  assert.match(svc.output(), /browser message refused \(dave/);
  ok.close();
});

test('end to end L7.8: an e-stop pressed while the site link is down is shown pending, then sent when the link returns within 10 s, and done only when the truck reports ESTOPPED', { skip, timeout: 90_000 }, async (t) => {
  const { site, svc } = await e2e(t);
  const cookie = await login(svc, 'priya', PASSWORDS.priya);
  const c = new LiveClient(svc, cookie);
  await c.opened;
  const truck = site.cleanTrucks()[1]!;
  await waitFor(() => c.lastFrame(), 5_000, 'a first frame');
  await site.down();
  await waitFor(() => { const st = c.lastFrame()!.body.frame.live.link.state; return st === 'down' || st === 'connecting'; }, 5_000, 'the service to see the site link down');
  const res = await c.ask({ type: 'command', action: 'ESTOP', vehicleId: truck });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.command.waitingForLink, true, JSON.stringify(res) + svc.output().slice(-2000));
  assert.match(res.command.summary, /NOT sent yet: waiting for the site link/);
  const shown = await waitFor(() => c.lastFrame()?.body.frame.live.commands.find((x: any) => x.id === res.command.id && x.waitingForLink), 3_000, 'the pending e-stop in a frame');
  assert.equal(shown.status, 'pending');
  assert.ok(!site.commands().some((x) => x.action === 'ESTOP'), 'not sent while the link is down');

  await new Promise((r) => setTimeout(r, 1_000));
  await site.listen(); // the site link returns, well within 10 s
  await waitFor(() => site.commands().some((x) => x.action === 'ESTOP' && x.vehicle_id === truck), 9_000, 'the e-stop at the gateway');
  const sent = site.commands().filter((x) => x.action === 'ESTOP');
  assert.ok(sent.every((x) => x.operator_id === 'priya' && x.vehicle_id === truck));
  const done = await waitFor(() => c.lastFrame()?.body.frame.live.commands.find((x: any) => x.id === res.command.id && x.status === 'confirmed'), 15_000, 'the e-stop confirmed');
  assert.match(done.summary, /done: .* is e-stopped/);
  const tr = c.lastFrame()!.body.frame.snapshot.trucks.find((x: any) => x.vehicleId === truck);
  assert.equal(tr.state.value, 'ESTOPPED', 'the truck itself reports ESTOPPED');
  c.close();
});

// Keep the import used when the file is type-checked on its own.
void WebSocket;
