// TESTING.md L6.2: the service keeps up with 12 trucks at 5 Hz plus bursts, and is never more than
// 4 MB behind. Measured, not assumed. Slow (about 30 s of real time): runs in `npm run test:slow`.
//
// Two measurements:
// 1. Cost per line of the whole read path (link -> fleet state -> registry), in-process, on lines
//    built from a live fixture: how many lines a second one core can take.
// 2. Over real TLS on loopback: a test server plays the gateway and streams telemetry at the live
//    rate, at 20x the live rate, and in 1 MB bursts. It records its own unsent backlog (what the
//    gateway's 4 MB rule is about) and the age of each line when the link has finished with it.
//
// The certificate is made at test time and deleted after; nothing here touches the real gateway.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';
import { ManualClock, SystemClock } from '../src/clock.ts';
import { FleetState } from '../src/fleet.ts';
import { attachRegistry, GatewayLink, tlsDialer, type Dialer } from '../src/link.ts';
import { ALLOW_ALL_GATE_NO_BLAST_SAFETY, CommandRegistry } from '../src/registry.ts';
import { Store } from '../src/store.ts';
import { fixture, helloAt } from './helpers/fixtures.ts';

const GATEWAY_LIMIT_BYTES = 4 * 1024 * 1024; // PROTOCOL.md §1
const TRUCKS = 12;
const HZ = 5;
const HAVE_OPENSSL = !spawnSync('openssl', ['version'], { stdio: 'ignore' }).error;

// Telemetry lines in the live shape, from the weak-pack fixture's messages, re-sequenced per truck
// so none is dropped as a duplicate, and stamped with the send time so the reader can age them.
function lineMaker(): (sentAtMs: number) => string {
  const templates = fixture('weak-pack').filter((r) => r.kind === 'msg' && r.m?.type === 'telemetry').map((r) => r.m!);
  assert.ok(templates.length > 100);
  const seq = new Map<string, number>();
  let i = 0;
  return (sentAtMs) => {
    const t = templates[i++ % templates.length]!;
    const id = `HT-${String((i % TRUCKS) + 1).padStart(2, '0')}`;
    const s = (seq.get(id) ?? 0) + 1;
    seq.set(id, s);
    return JSON.stringify({ ...t, vehicle_id: id, seq: s, t_device_ms: sentAtMs });
  };
}

test('L6.2a cost per line of the read path, in-process', () => {
  const clock = new ManualClock(1_790_000_000_000);
  const fleet = new FleetState(clock);
  const dir = mkdtempSync(join(tmpdir(), 'cr-l62-'));
  const store = new Store(join(dir, 'db'));
  let onLine: (l: string) => void = () => {};
  const dial: Dialer = (h) => { onLine = h.onLine; return { write: () => {}, close: () => {} }; };
  const link = new GatewayLink({ clock, fleet, dial, email: 'bench@example.com' });
  const registry = new CommandRegistry({ clock, fleet, store, transport: link, gate: ALLOW_ALL_GATE_NO_BLAST_SAFETY });
  attachRegistry(link, registry);
  link.start();
  onLine(JSON.stringify(helloAt(clock.now())));
  // Some open commands, so the registry does its per-telemetry work too.
  for (const v of ['HT-01', 'HT-02', 'HT-03']) registry.submit({ vehicleId: v, action: 'HOLD' }, { kind: 'operator', operatorId: 'bench', role: 'operator' });
  const make = lineMaker();
  const N = 60_000;
  // Twelve trucks' lines per 17 ms of the manual clock, with the gateway's heartbeat every 2 s in
  // among them: without it the link rightly declares itself down and stops reading (an early
  // version of this benchmark lost a third of its lines that way).
  const lines: string[] = [];
  let at = clock.now();
  let nextHb = at;
  for (let k = 0; k < N; k++) {
    if (k % TRUCKS === 0) at += 17;
    if (at >= nextHb) { lines.push(JSON.stringify({ type: 'heartbeat', server_time_ms: at })); nextHb += 2_000; }
    lines.push(make(at));
  }
  const bytes = lines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
  const t0 = performance.now();
  for (const line of lines) {
    if (line.includes('"heartbeat"')) clock.advance(Math.max(0, JSON.parse(line).server_time_ms - clock.now()));
    onLine(line);
  }
  const ms = performance.now() - t0;
  const perSec = lines.length / (ms / 1000);
  const liveRate = TRUCKS * HZ + 0.5; // telemetry plus a heartbeat every 2 s
  console.log(`L6.2a: ${lines.length} lines (${(bytes / 1e6).toFixed(1)} MB) in ${ms.toFixed(0)} ms: ${perSec.toFixed(0)} lines/s, ${(bytes / 1e6 / (ms / 1000)).toFixed(1)} MB/s; ` +
    `${(ms * 1000 / lines.length).toFixed(1)} µs/line; ${(perSec / liveRate).toFixed(0)}x the live rate of ${liveRate} lines/s`);
  const applied = fleet.snapshot().trucks.reduce((sum, t) => sum + t.radio.applied, 0);
  console.log(`L6.2a: fleet state applied ${applied} of ${N} telemetry messages; link ${link.status().state}, ${link.status().dials} dial(s)`);
  assert.equal(link.status().dials, 1, 'the link stayed up throughout');
  assert.equal(fleet.snapshot().trucks.filter((t) => t.radio.applied > 0).length, TRUCKS, 'every truck took telemetry');
  assert.ok(applied >= 0.99 * N, 'the measurement is of messages actually applied, not rejected early');
  assert.ok(perSec > 20 * liveRate, `only ${perSec.toFixed(0)} lines/s`);
  link.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeCert(t: TestContext): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'cr-l62-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'pipe' });
  assert.equal(r.status, 0, `openssl failed: ${r.stderr}`);
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('L6.2b over TLS: live rate, 20x the live rate and 1 MB bursts, never near 4 MB behind', { skip: !HAVE_OPENSSL }, async (t) => {
  const { key, cert } = makeCert(t);
  const make = lineMaker();
  let sock: TLSSocket | null = null;
  let maxBacklog = 0;
  let written = 0;
  const server = createServer({ key, cert }, (s) => {
    s.once('data', () => { // the auth line
      sock = s;
      s.write(JSON.stringify(helloAt(Date.now())) + '\n');
    });
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>((r) => { sock?.destroy(); server.close(() => r()); }));

  const clock = new SystemClock();
  const fleet = new FleetState(clock);
  const dir = mkdtempSync(join(tmpdir(), 'cr-l62-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'db'));
  const link = new GatewayLink({ clock, fleet, dial: tlsDialer({ host: '127.0.0.1', port, ca: cert }), email: 'bench@example.com' });
  const registry = new CommandRegistry({ clock, fleet, store, transport: link, gate: ALLOW_ALL_GATE_NO_BLAST_SAFETY });
  attachRegistry(link, registry);
  const ages: number[] = [];
  let received = 0;
  link.subscribe((e) => {
    if (e.type === 'message' && e.msg.type === 'telemetry') { received++; ages.push(Date.now() - Number(e.msg.t_device_ms)); }
  });
  t.after(() => { link.stop(); store.close(); });
  link.start();
  for (let i = 0; i < 100 && !link.isUp(); i++) await sleep(20);
  assert.ok(link.isUp(), 'connected over TLS');
  const s = sock as unknown as TLSSocket;

  const send = (n: number) => {
    let chunk = '';
    for (let k = 0; k < n; k++) chunk += make(Date.now()) + '\n';
    s.write(chunk);
    written += n;
    maxBacklog = Math.max(maxBacklog, s.writableLength);
  };
  const phase = async (name: string, linesPerSec: number, seconds: number, burstBytes = 0) => {
    const before = { written, received, ages: ages.length };
    maxBacklog = 0;
    const tick = 50;
    const perTick = (linesPerSec * tick) / 1000;
    let owed = 0;
    for (let ms = 0; ms < seconds * 1000; ms += tick) {
      owed += perTick;
      const n = Math.floor(owed);
      owed -= n;
      if (n > 0) send(n);
      if (burstBytes > 0 && ms % 1000 === 0) send(Math.round(burstBytes / 430));
      if (ms % 2000 === 0) s.write(JSON.stringify({ type: 'heartbeat', server_time_ms: Date.now() }) + '\n');
      await sleep(tick);
    }
    for (let i = 0; i < 200 && received < written; i++) await sleep(25);
    const a = ages.slice(before.ages).sort((x, y) => x - y);
    const pct = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? NaN;
    if (received - before.received < written - before.written) console.log(`L6.2b ${name}: link ${JSON.stringify(link.status())}`);
    const res = { name, lines: written - before.written, received: received - before.received, maxBacklogBytes: maxBacklog, p50: pct(0.5), p99: pct(0.99), max: a.at(-1) ?? NaN };
    console.log(`L6.2b ${name}: ${res.lines} lines sent, ${res.received} processed; gateway-side backlog max ${(res.maxBacklogBytes / 1024).toFixed(1)} KiB ` +
      `(limit ${GATEWAY_LIMIT_BYTES / 1024} KiB); line age when processed p50 ${res.p50} ms, p99 ${res.p99} ms, max ${res.max} ms`);
    return res;
  };

  const live = await phase('live rate (12 trucks x 5 Hz)', TRUCKS * HZ, 5);
  const heavy = await phase('20x live rate', 20 * TRUCKS * HZ, 5);
  const bursts = await phase('live rate plus a 1 MB burst every second', TRUCKS * HZ, 5, 1024 * 1024);
  for (const r of [live, heavy, bursts]) {
    assert.equal(r.received, r.lines, `${r.name}: every line processed`);
    assert.ok(r.maxBacklogBytes < GATEWAY_LIMIT_BYTES / 2, `${r.name}: backlog ${r.maxBacklogBytes} B`);
  }
  assert.ok(live.p99 < 250, `live p99 ${live.p99} ms`);
  assert.equal(link.status().state, 'up');
  assert.equal(link.status().dials, 1);
});
