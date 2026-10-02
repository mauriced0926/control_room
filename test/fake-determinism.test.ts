// TESTING.md L0.C4: the fake is deterministic. The same seed and the same inputs give a
// byte-identical output stream; a 15-minute day takes well under a second on a ManualClock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ManualClock } from '../src/clock.ts';
import { FakeGateway } from '../fake/gateway.ts';
import { DLH1 } from '../fake/dlh1.ts';

const T0 = 1_790_000_000_000;
const DAY_MS = 15 * 60_000;

// A scripted day: random blasts, and a fixed set of inputs at fixed times covering every kind of
// command, a lease with driving, an e-stop and malformed lines. Returns every line one client saw.
function runDay(seed: number): { lines: string[]; cpuMs: number } {
  const clock = new ManualClock(T0);
  const gw = new FakeGateway(clock, { seed, site: DLH1, blasts: 'random' });
  gw.start();
  const c = gw.connect();
  c.send({ type: 'auth', email: 'det@example.com' });
  const cmd = (id: string, vehicle: string, action: string, extra: object = {}) =>
    c.send({ type: 'command', command_id: id, vehicle_id: vehicle, action, operator_id: 'det', ...extra });

  const started = process.cpuUsage();
  clock.advance(5_000);
  cmd('d1', 'HT-01', 'HOLD');
  cmd('d2', 'HT-02', 'EXIT_ZONE');
  cmd('d3', 'HT-03', 'RETURN_TO_BAY');
  clock.advance(10_000);
  cmd('d4', 'HT-01', 'RESUME');
  cmd('d1', 'HT-01', 'HOLD'); // resend: original result
  cmd('d1', 'HT-01', 'RESUME'); // reuse: COMMAND_ID_REUSED
  c.send('{"type":"command", broken');
  cmd('d5', 'HT-04', 'TAKE_CONTROL');
  const ack = c.messages().filter((m) => m.type === 'command_ack' && m.command_id === 'd5').at(-1);
  const lease = ack && ack.type === 'command_ack' ? ack.lease_id ?? '' : '';
  for (let i = 1; i <= 30; i++) {
    c.send({ type: 'drive', vehicle_id: 'HT-04', lease_id: lease, seq: i, throttle: 0.4, sent_ms: clock.now() });
    clock.advance(100);
  }
  cmd('d6', 'HT-04', 'RELEASE_CONTROL', { lease_id: lease });
  cmd('d7', 'HT-05', 'ESTOP');
  clock.advance(20_000);
  cmd('d8', 'HT-05', 'CLEAR_ESTOP');
  cmd('d9', 'HT-05', 'RESUME');
  gw.injectFault('HT-06', 'HYD_PRESSURE_LOW');
  clock.advance(DAY_MS - clock.now() + T0);
  const used = process.cpuUsage(started);
  gw.stop();
  return { lines: c.lines, cpuMs: (used.user + used.system) / 1000 };
}

const digest = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');

test('L0.C4 the same seed and inputs give a byte-identical stream', () => {
  const a = runDay(42);
  const b = runDay(42);
  assert.ok(a.lines.length > 50_000, `${a.lines.length} lines in a 15-minute day`);
  assert.equal(a.lines.length, b.lines.length);
  assert.equal(digest(a.lines), digest(b.lines));
  const types = new Set(a.lines.map((l) => (JSON.parse(l) as { type: string }).type));
  for (const t of ['hello', 'telemetry', 'heartbeat', 'zone_event', 'command_ack', 'lease_event']) {
    assert.ok(types.has(t), `the stream includes ${t}`);
  }
});

test('L0.C4 a different seed gives a different day', () => {
  assert.notEqual(digest(runDay(42).lines), digest(runDay(43).lines));
});

// CPU time, not wall time: the claim is that the fake never waits on the real clock, and wall time
// also counts whatever else the machine is doing (the probe test runs in parallel).
test('a 15-minute day takes well under a second of CPU', () => {
  runDay(1); // warm up the JIT
  const { cpuMs } = runDay(2);
  console.log(`15-minute day: ${cpuMs.toFixed(0)} ms of CPU`);
  assert.ok(cpuMs < 1_000, `took ${cpuMs.toFixed(0)} ms of CPU`);
});
