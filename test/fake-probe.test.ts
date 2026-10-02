// TESTING.md L0.C2: research/probe.py, pointed at the fake over TLS, gets the same ack sequence and
// reasons as the live probe did for S1 and S3-S8. Also the TLS transport itself.
//
// The probe runs in real time (it sleeps and waits on the wall clock), so this test takes a couple
// of minutes. It is interrupted when S9 starts: S9 waits up to 240 s for a frozen truck, which the
// fake has no injector for until milestone 2, and S9 is outside L0.C2. SIGINT runs the probe's own
// cleanup. The probe's environment is built here from scratch, so it can only reach 127.0.0.1.
//
// The comparison reads the probe's raw output file, never its printout (AI_LOG.md entry 1), and
// pairs each ack with the latest send of its command_id before it in the file, never by counting.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { SystemClock } from '../src/clock.ts';
import type { CommandAck, GatewayMessage, Hello, LeaseEvent, Telemetry } from '../src/protocol.ts';
import { buildSite } from '../src/site.ts';
import { FakeGateway } from '../fake/gateway.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { listenTls } from '../fake/tls.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const has = (cmd: string, arg: string) => !spawnSync(cmd, [arg], { stdio: 'ignore' }).error;
const HAVE_OPENSSL = has('openssl', 'version');
const HAVE_PYTHON = has('python3', '--version');

// A throwaway key and certificate for 127.0.0.1, made at test time and deleted after.
function makeCert(t: TestContext): { dir: string; key: Buffer; cert: Buffer; certPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'pipe' });
  assert.equal(r.status, 0, `openssl failed: ${r.stderr}`);
  return { dir, key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')), certPath: join(dir, 'cert.pem') };
}

test('TLS transport: auth, hello, a command and its ack as NDJSON; an over-long line closes the connection', { skip: !HAVE_OPENSSL }, async (t) => {
  const { key, cert } = makeCert(t);
  const gw = new FakeGateway(new SystemClock(), { seed: 3, site: DLH1, blasts: 'none' });
  gw.start();
  const server = await listenTls(gw, { key, cert });
  t.after(async () => { gw.stop(); await server.close(); });

  const sock = connect({ host: '127.0.0.1', port: server.port, ca: cert });
  const lines: string[] = [];
  let buf = '';
  sock.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  const closed = new Promise<void>((resolve) => sock.on('close', () => resolve()));
  const waitFor = async (pred: (m: GatewayMessage) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const found = lines.map((l) => JSON.parse(l) as GatewayMessage).find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out');
  };
  await new Promise<void>((resolve) => sock.once('secureConnect', () => resolve()));
  sock.write(JSON.stringify({ type: 'auth', email: 'tls@example.com' }) + '\n');
  const hello = await waitFor((m) => m.type === 'hello') as Hello;
  assert.equal(hello.site_id, DLH1.site_id);
  sock.write(JSON.stringify({ type: 'command', command_id: 'tls-1', vehicle_id: DLH1.vehicles[0], action: 'HOLD', operator_id: 'op' }) + '\n');
  const ack = await waitFor((m) => m.type === 'command_ack') as CommandAck;
  assert.equal(ack.command_id, 'tls-1');
  assert.equal(ack.status, 'ACCEPTED');
  await waitFor((m) => m.type === 'telemetry');
  sock.write('x'.repeat(70 * 1024) + '\n');
  await closed;
});

// ---- the probe ----

type Rec = { kind: string; rx_ms: number; name?: string; raw?: string; m?: GatewayMessage };

// What the live probe got (research/README.md "Verified", fixtures accepted-then-ignored-resume and
// reverse-exit-zone), and what the spec says where the live run lost the ack or left no record.
// Each entry: [action, 'ACCEPTED' or the rejection reason].
const EXPECTED: Record<string, Array<[string, string]>> = {
  // live: the first HOLD's ack was lost on the radio; the fake has no loss in milestone 1, so the
  // spec's ACCEPTED. Resend: original ACCEPTED (verified). Reuse: COMMAND_ID_REUSED (verified).
  S1: [['HOLD', 'ACCEPTED'], ['HOLD', 'ACCEPTED'], ['RESUME', 'COMMAND_ID_REUSED'], ['RESUME', 'ACCEPTED']],
  S3: [['EXIT_ZONE', 'ACCEPTED'], ['RESUME', 'ACCEPTED']], // live: probe-119b43-5 and -6, both ACCEPTED
  // live: TAKE_CONTROL ACCEPTED with lease details, HOLD LEASE_HELD (holder probe), RESUME ACCEPTED
  // (and then ignored for 70 s: an ACCEPTED-then-ignored fault, milestone 2)
  S4: [['TAKE_CONTROL', 'ACCEPTED'], ['HOLD', 'LEASE_HELD'], ['RESUME', 'ACCEPTED']],
  // S5-S8: no raw live record in the repository (the full probe log was not committed); these are
  // the spec's answers, which the README's account of the live run does not contradict.
  S5: [['TAKE_CONTROL', 'ACCEPTED'], ['RELEASE_CONTROL', 'NOT_LEASE_HOLDER'], ['RELEASE_CONTROL', 'ACCEPTED'], ['RESUME', 'ACCEPTED']],
  S6: [['ESTOP', 'ACCEPTED'], ['HOLD', 'ESTOP_ACTIVE'], ['CLEAR_ESTOP', 'ACCEPTED'], ['RESUME', 'ACCEPTED']],
  S7: [['HOLD', 'UNKNOWN_VEHICLE'], ['HOLD', 'MISSING_OPERATOR'], ['DANCE', 'UNSUPPORTED_ACTION'], ['HOLD', 'BAD_COMMAND_ID'], ['<unparseable>', 'BAD_JSON']],
  S8: [['HOLD', 'INTERLOCK_ACTIVE']],
};

interface Send { at: number; step: string; id: string; action: string; vehicle: string | null; rx: number; ack: CommandAck | null }

// Pair every command the probe sent with its ack, by position in the probe's file (it writes sends
// and acks under one lock, in the order it saw them). An ack belongs to the latest send of its
// command_id recorded before it. On localhost an ack can be recorded a moment before its own send
// record (the probe writes 'sent' just after the bytes leave), so when that latest send is already
// answered, the ack belongs to the next send of the id. No time window: sends of one id are 50 ms
// apart in S1, and an earlier version of this with a 50 ms window misattributed them.
// Milestone 1 loses no acks; once milestone 2 loses some, this pairing must be revisited.
function pairAcks(recs: Rec[]): Send[] {
  const sends: Send[] = [];
  let step = '';
  for (const [at, r] of recs.entries()) {
    if (r.kind === 'step') step = (r.name ?? '').split(' ')[0]!;
    if (r.kind !== 'sent' || r.raw === undefined) continue;
    let c: Record<string, unknown> | null = null;
    try { c = JSON.parse(r.raw) as Record<string, unknown>; } catch { c = null; }
    if (c && c.type !== 'command') continue; // drive messages
    sends.push({
      at,
      step,
      id: c ? (typeof c.command_id === 'string' ? c.command_id : '<missing>') : '<unparseable>',
      action: c ? String(c.action) : '<unparseable>',
      vehicle: c && typeof c.vehicle_id === 'string' ? c.vehicle_id : null,
      rx: r.rx_ms,
      ack: null,
    });
  }
  for (const [at, r] of recs.entries()) {
    if (r.kind !== 'msg' || r.m?.type !== 'command_ack') continue;
    const ack = r.m;
    const ofId = sends.filter((s) => s.id === ack.command_id);
    const before = ofId.filter((s) => s.at < at).at(-1);
    const target = before && !before.ack ? before : ofId.find((s) => s.at > at && !s.ack);
    if (target) target.ack = ack;
  }
  return sends;
}

const outcome = (a: CommandAck | null) => (a === null ? 'NO_ACK' : a.status === 'ACCEPTED' ? 'ACCEPTED' : String(a.reason));

test('L0.C2 research/probe.py gets the live ack sequence from the fake for S1 and S3-S8', { skip: !HAVE_OPENSSL || !HAVE_PYTHON ? 'needs python3 and openssl' : false, timeout: 600_000 }, async (t) => {
  const { dir, key, cert, certPath } = makeCert(t);
  const faulted = DLH1.vehicles.at(-1)!; // S8 needs a truck in FAULT
  const gw = new FakeGateway(new SystemClock(), { seed: 11, site: DLH1, blasts: 'none' });
  gw.injectFault(faulted, 'HYD_PRESSURE_LOW');
  gw.start();
  const server = await listenTls(gw, { key, cert });
  t.after(async () => { gw.stop(); await server.close(); });

  const out = join(dir, 'probe-out.jsonl');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(server.port),
    GATEWAY_EMAIL: 'probe@fake.invalid',
    SSL_CERT_FILE: certPath,
    PYTHONUNBUFFERED: '1',
  };
  const child = spawn('python3', [join(ROOT, 'research/probe.py'), out, '--live'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let printout = '';
  child.stdout.on('data', (d: Buffer) => { printout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { printout += d.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  // Interrupt at S9 (see the header). Polling the probe's own file: it flushes every record.
  const poll = setInterval(() => {
    if (existsSync(out) && readFileSync(out, 'utf8').includes('"name": "S9 ')) { clearInterval(poll); child.kill('SIGINT'); }
  }, 250);
  const code = await exited;
  clearInterval(poll);
  if (process.env.PROBE_OUT) copyFileSync(out, process.env.PROBE_OUT);
  assert.ok(existsSync(out), `the probe wrote nothing; it printed:\n${printout}`);

  const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec);
  assert.ok(recs.some((r) => r.kind === 'step' && r.name?.startsWith('S9')), `the probe never reached S9 (exit ${code}); it printed:\n${printout}`);
  const sends = pairAcks(recs);

  for (const [step, expected] of Object.entries(EXPECTED)) {
    const got = sends.filter((s) => s.step === step).map((s): [string, string] => [s.action, outcome(s.ack)]);
    assert.deepEqual(got, expected, `${step}: got ${JSON.stringify(got)}`);
  }

  // Beyond the acks: what the live probe measured, checked in the same raw file.
  const tele = (v: string) => recs.filter((r) => r.kind === 'msg' && r.m?.type === 'telemetry' && r.m.vehicle_id === v)
    .map((r) => ({ rx: r.rx_ms, m: r.m as Telemetry }));
  const send = (step: string, action: string) => sends.find((s) => s.step === step && s.action === action)!;

  // S1: HOLD took effect 1-6 s after it was accepted (live: 3.2 s), on the gateway's clock (see S4),
  // plus up to 200 ms of telemetry sampling and the real clock's late timers.
  const hold = send('S1', 'HOLD');
  const held = tele(hold.vehicle!).find((x) => x.rx > hold.rx && x.m.state === 'HOLDING')!;
  const toHold = held.m.t_device_ms - hold.ack!.server_time_ms;
  assert.ok(toHold >= 1_000 && toHold <= 6_500, `S1 HOLD took effect ${toHold} ms after acceptance`);

  // S3: EXIT_ZONE at the autonomous speed for its load, stopping 2.0 m outside the zone (live: 3.0 m/s
  // empty, 2.0 m outside).
  const hello = recs.find((r) => r.m?.type === 'hello')!.m as Hello;
  const { site } = buildSite(hello);
  const exit = send('S3', 'EXIT_ZONE');
  const s3 = tele(exit.vehicle!).filter((x) => x.rx >= exit.rx - 1_000);
  const zone = site.zoneAt(site.toLoop(s3[0]!.m.segment_id, s3[0]!.m.offset_m)!)!;
  const moving = s3.filter((x) => x.m.task === 'EXIT_ZONE' && x.m.speed_mps > 0);
  assert.ok(moving.length > 0, 'S3 moved');
  const loaded = moving[0]!.m.payload_kg > 0;
  const heading = moving[0]!.m.direction;
  const expectedSpeed = loaded ? 2.0 : 3.0; // reverse and forward alike (reverse loaded is the spec-assumed value)
  assert.ok(moving.every((x) => x.m.speed_mps === expectedSpeed), `S3 speed ${expectedSpeed} (${heading}, loaded ${loaded})`);
  const stopped = s3.find((x) => x.rx > moving.at(-1)!.rx && x.m.state === 'HOLDING')!;
  const stopAt = site.toLoop(stopped.m.segment_id, stopped.m.offset_m)!;
  const r = zone.ranges[0]!;
  const outside = heading === 'REV' ? site.loopLengthM - ((stopAt - r.startM + site.loopLengthM) % site.loopLengthM) : (stopAt - (r.startM + r.lengthM) + site.loopLengthM) % site.loopLengthM;
  assert.ok(Math.abs(outside - 2.0) < 0.011, `S3 stopped ${outside} m outside ${zone.zoneId}`);
  assert.equal(stopped.m.task, null);

  // S4: deadman never before 500 ms after the grant, lease EXPIRED ~10 s after it (live 10.1 s),
  // truck HOLDING afterwards. Timed on the gateway's clock, not on the probe's receive times: under
  // load the probe has recorded GRANTED 140 ms late, making a 501 ms deadman look like 370 ms. In
  // milestone 1 t_device_ms is the gateway's clock exactly (no skew injector yet). The upper bounds
  // allow for the real clock's late timers and up to 200 ms of telemetry sampling.
  const take = send('S4', 'TAKE_CONTROL');
  const leaseEv = recs.filter((x) => x.m?.type === 'lease_event' && x.m.vehicle_id === take.vehicle).map((x) => ({ rx: x.rx_ms, m: x.m as LeaseEvent }));
  const granted = leaseEv.find((e) => e.m.event === 'GRANTED' && e.rx >= take.rx - 50)!;
  const expired = leaseEv.find((e) => e.m.event === 'EXPIRED' && e.rx > granted.rx)!;
  const deadman = tele(take.vehicle!).find((x) => x.rx > granted.rx && x.m.control.deadman)!;
  const toDeadman = deadman.m.t_device_ms - granted.m.server_time_ms;
  assert.ok(toDeadman >= 500 && toDeadman <= 1_000, `S4 deadman ${toDeadman} ms after the grant`);
  const idle = expired.m.server_time_ms - granted.m.server_time_ms;
  assert.ok(idle >= 10_000 && idle <= 10_500, `S4 lease expired after ${idle} ms`);
  assert.equal(tele(take.vehicle!).find((x) => x.rx > expired.rx + 100)!.m.state, 'HOLDING');

  // S6: ESTOPPED at once, HOLDING after CLEAR_ESTOP.
  const estop = send('S6', 'ESTOP');
  assert.ok(tele(estop.vehicle!).some((x) => x.rx > estop.rx && x.rx < estop.rx + 1_000 && x.m.state === 'ESTOPPED'));
  const clear = send('S6', 'CLEAR_ESTOP');
  assert.equal(tele(clear.vehicle!).find((x) => x.rx > clear.rx + 300)!.m.state, 'HOLDING');
});
