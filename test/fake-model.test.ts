// TESTING.md L0.M: the fake gateway's model of the site, commands, leases and blasts.
// Positions and names here are DLH-1's (the fake's default site config, fake/dlh1.ts): BAY 0-80,
// DECLINE 80-580, L4_NORTH 580-780, DRAW_12 780-840 (load), L4_SOUTH 840-1040, INCLINE 1040-1540,
// TIP 1540-1600 (dump). The last test runs a different site through the same model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import type { LeaseEvent, ZoneEvent } from '../src/protocol.ts';
import { FakeGateway } from '../fake/gateway.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { harness, T0 } from './fake-helpers.ts';

const near = (actual: number, expected: number, tol: number, what = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what} expected ${expected} ±${tol}, got ${actual}`);

const AUTH = (email = 'tester@example.com') => ({ type: 'auth', email });

// ---- connection, hello, auth ----

test('hello comes first and describes the configured site: all zones open, no leases, site.name is the email', () => {
  const h = harness();
  const first = h.client.messages()[0]!;
  assert.equal(first.type, 'hello');
  const hello = h.messages('hello')[0]!;
  assert.equal(hello.protocol, '3.0');
  assert.equal(hello.site_id, DLH1.site_id);
  assert.equal(hello.server_time_ms, T0);
  assert.deepEqual(hello.vehicles, DLH1.vehicles);
  assert.deepEqual(hello.route, DLH1.route);
  assert.equal(hello.loop_length_m, DLH1.loop_length_m);
  assert.deepEqual(hello.zones.map((z) => z.zone_id), ['BAY', 'DECLINE', 'L4_NORTH', 'DRAW_12', 'L4_SOUTH', 'INCLINE', 'TIP']);
  for (const z of hello.zones) assert.deepEqual(z, { zone_id: z.zone_id, status: 'OPEN', effective_at_ms: null, reason: null });
  assert.deepEqual(hello.leases, []);
  assert.deepEqual(hello.site, { name: 'tester@example.com' });
});

test('auth: each failure gets its reason once and the connection is closed (§1.1)', () => {
  const clock = new ManualClock(T0);
  const gw = new FakeGateway(clock, { seed: 1, site: DLH1, blasts: 'none' });
  gw.start();
  const cases: Array<[string, string]> = [
    ['not json at all', 'BAD_AUTH'],
    [JSON.stringify({ type: 'command', command_id: 'x' }), 'AUTH_REQUIRED'],
    [JSON.stringify({ type: 'auth', email: 'not-an-email' }), 'BAD_EMAIL'],
    [JSON.stringify({ type: 'auth' }), 'BAD_EMAIL'],
  ];
  for (const [line, reason] of cases) {
    const c = gw.connect();
    c.send(line);
    assert.deepEqual(c.messages(), [{ type: 'auth_error', reason }], line);
    assert.ok(c.closed, `${reason} closes`);
  }

  const slow = gw.connect();
  clock.advance(9_950);
  assert.ok(!slow.closed);
  clock.advance(50);
  assert.deepEqual(slow.messages(), [{ type: 'auth_error', reason: 'AUTH_TIMEOUT' }]);
  assert.ok(slow.closed);

  const sixteen = Array.from({ length: 16 }, () => { const c = gw.connect(); c.send(AUTH()); return c; });
  for (const c of sixteen) assert.equal(c.messages()[0]?.type, 'hello');
  const extra = gw.connect();
  extra.send(AUTH());
  assert.deepEqual(extra.messages(), [{ type: 'auth_error', reason: 'TOO_MANY_CONNECTIONS' }]);
  assert.ok(extra.closed);
  sixteen[0]!.close();
  const again = gw.connect();
  again.send(AUTH());
  assert.equal(again.messages()[0]?.type, 'hello');
});

test('a line over 64 KiB closes the connection; an unknown type is ignored', () => {
  const h = harness();
  const before = h.client.lines.length;
  h.client.send({ type: 'wave', hello: 'there' });
  assert.equal(h.client.lines.length, before);
  assert.ok(!h.client.closed);
  h.client.send('{"type":"command","pad":"' + 'x'.repeat(70_000) + '"}');
  assert.ok(h.client.closed);
});

test('telemetry at 5 Hz per truck with seq rising by one, heartbeats every 2 s, the same stream to every client', () => {
  const h = harness();
  const other = h.gw.connect();
  other.send(AUTH('other@example.com'));
  h.advance(10_000);
  for (const v of DLH1.vehicles) {
    const ts = h.telemetry(v);
    assert.equal(ts.length, 50, v);
    for (let i = 1; i < ts.length; i++) {
      assert.equal(ts[i]!.seq, ts[i - 1]!.seq + 1);
      assert.equal(ts[i]!.t_device_ms - ts[i - 1]!.t_device_ms, 200);
    }
  }
  const hb = h.messages('heartbeat');
  assert.deepEqual(hb.map((m) => m.server_time_ms - T0), [2_000, 4_000, 6_000, 8_000, 10_000]);
  // everything after hello is broadcast: both clients got the same lines
  assert.deepEqual(other.lines.slice(1), h.client.lines.slice(1));

  const t = h.latest('HT-01');
  assert.deepEqual(Object.keys(t), ['type', 'vehicle_id', 'seq', 't_device_ms', 'state', 'task', 'soc_pct', 'speed_mps',
    'direction', 'segment_id', 'zone_id', 'offset_m', 'payload_kg', 'faults', 'control']);
  assert.deepEqual(Object.keys(t.control), ['mode', 'operator_id', 'deadman', 'last_drive_seq', 'last_drive_sent_ms']);
});

// ---- autonomous motion, duty cycle, energy ----

test('autonomous: empty 3.0 m/s, loaded 2.0 m/s, forward, wrapping from the end of the loop to 0', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 80 },
    { vehicle_id: 'HT-02', positionM: 900, loaded: true, socPct: 80 },
    { vehicle_id: 'HT-03', positionM: 1590, loaded: false, socPct: 80 },
  ] });
  h.advance(10_000);
  near(h.gw.truth('HT-01').positionM, 130, 0.01, 'HT-01');
  near(h.gw.truth('HT-02').positionM, 920, 0.01, 'HT-02');
  near(h.gw.truth('HT-03').positionM, 20, 0.01, 'HT-03 wrapped');
  const a = h.latest('HT-01');
  assert.equal(a.state, 'TRAMMING');
  assert.equal(a.speed_mps, 3);
  assert.equal(a.direction, 'FWD');
  assert.equal(a.payload_kg, 0);
  assert.equal(h.latest('HT-02').speed_mps, 2);
  assert.equal(h.latest('HT-02').payload_kg, 42_000);
  assert.equal(h.latest('HT-03').segment_id, 'SEG-BAY');
  assert.equal(h.latest('HT-03').zone_id, 'BAY');
});

test('duty cycle: an empty truck loads ~20 s at the end of the load segment, a loaded one dumps ~12 s at the end of the dump segment', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-01', positionM: 830, loaded: false, socPct: 80 },
    { vehicle_id: 'HT-02', positionM: 1590, loaded: true, socPct: 80 },
  ] });
  h.advance(60_000);
  const spans = (v: string, state: string) => {
    const ts = h.telemetry(v).filter((t) => t.state === state);
    return { first: ts[0]!, last: ts.at(-1)!, ms: ts.at(-1)!.t_device_ms - ts[0]!.t_device_ms };
  };
  const load = spans('HT-01', 'LOADING');
  assert.equal(load.first.segment_id, 'SEG-DRAW-12');
  assert.equal(load.first.offset_m, 59.95);
  assert.equal(load.first.speed_mps, 0);
  assert.equal(load.first.payload_kg, 0);
  near(load.ms, 20_000, 250, 'load time');
  const after = h.telemetry('HT-01').find((t) => t.t_device_ms > load.last.t_device_ms)!;
  assert.equal(after.state, 'TRAMMING');
  assert.equal(after.payload_kg, 42_000);

  const dump = spans('HT-02', 'DUMPING');
  assert.equal(dump.first.segment_id, 'SEG-TIP-1');
  assert.equal(dump.first.offset_m, 59.95);
  assert.equal(dump.first.payload_kg, 42_000);
  near(dump.ms, 12_000, 250, 'dump time');
  assert.equal(h.latest('HT-02').payload_kg, 0);
  assert.equal(h.latest('HT-02').speed_mps, 3);
});

test('a truck below 25 % charges at the end of the bay to 90 %, then carries on; one above 25 % drives through', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-01', positionM: 70, loaded: false, socPct: 20 },
    { vehicle_id: 'HT-02', positionM: 70, loaded: false, socPct: 30 },
  ] });
  assert.ok(h.until('HT-01', (t) => t.state === 'CHARGING', 5_000) >= 0);
  assert.equal(h.latest('HT-01').segment_id, 'SEG-BAY');
  assert.equal(h.latest('HT-01').offset_m, 79.95);
  assert.ok(h.until('HT-01', (t) => t.state === 'TRAMMING', 1_000_000) >= 0);
  assert.equal(h.latest('HT-01').soc_pct, 90);
  // HT-02 passes the end of the bay within 4 s; later it loads, which is not the point here
  assert.ok(h.telemetry('HT-02').filter((t) => t.t_device_ms < T0 + 10_000).every((t) => t.state === 'TRAMMING'));
});

test('energy: 6 %/km empty, 9 %/km loaded (measured), nothing while stopped, scaled by a weak pack\'s drain factor', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 80 },
    { vehicle_id: 'HT-02', positionM: 860, loaded: true, socPct: 80 },
    { vehicle_id: 'HT-03', positionM: 100, loaded: false, socPct: 80, drainFactor: 5 },
    { vehicle_id: 'HT-04', positionM: 300, loaded: false, socPct: 50, state: 'HOLDING' },
  ] });
  h.advance(100_000);
  near(h.gw.truth('HT-01').socPct, 80 - 0.3 * 6, 0.01, 'empty, 300 m');
  near(h.gw.truth('HT-02').socPct, 80 - 0.2 * 9, 0.01, 'loaded, 200 m');
  near(h.gw.truth('HT-03').socPct, 80 - 0.3 * 6 * 5, 0.01, 'weak pack, 300 m');
  assert.equal(h.gw.truth('HT-04').socPct, 50);
});

test('a pack that reaches 0 % stops with BATTERY_DEPLETED, and cannot be driven home', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 0.5 }] });
  assert.ok(h.until('HT-01', (t) => t.state === 'FAULT', 60_000) >= 0);
  const t = h.latest('HT-01');
  assert.deepEqual(t.faults, ['BATTERY_DEPLETED']);
  assert.equal(t.soc_pct, 0);
  assert.equal(t.speed_mps, 0);
  near(h.gw.truth('HT-01').positionM, 100 + 500 / 6, 0.2, 'stopped where the charge ran out');
  for (const action of ['TAKE_CONTROL', 'HOLD', 'RESUME', 'RETURN_TO_BAY', 'EXIT_ZONE']) {
    assert.equal(h.command('HT-01', action).reason, 'INTERLOCK_ACTIVE', action);
  }
  assert.equal(h.command('HT-01', 'ESTOP').status, 'ACCEPTED');
});

// ---- supervisory commands ----

test('HOLD takes effect 1 to 6 s after acceptance, never at once; RESUME restarts it; RESUME on a moving truck is INVALID_STATE', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 80 },
    { vehicle_id: 'HT-02', positionM: 300, loaded: false, socPct: 80 },
  ] });
  h.advance(1_000);
  const ack = h.command('HT-01', 'HOLD');
  assert.deepEqual(ack, { type: 'command_ack', command_id: ack.command_id, vehicle_id: 'HT-01', status: 'ACCEPTED', server_time_ms: T0 + 1_000 });
  h.advance(950);
  assert.equal(h.gw.truth('HT-01').state, 'TRAMMING', 'not yet: effect is at least 1 s after acceptance');
  const dt = h.until('HT-01', (t) => t.state === 'HOLDING', 6_000);
  assert.ok(dt >= 0, 'held within 6 s');
  assert.equal(h.latest('HT-01').speed_mps, 0);
  assert.equal(h.latest('HT-01').task, null);

  const r = h.command('HT-02', 'RESUME');
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reason, 'INVALID_STATE');

  assert.equal(h.command('HT-01', 'RESUME').status, 'ACCEPTED');
  assert.ok(h.until('HT-01', (t) => t.state === 'TRAMMING' && t.speed_mps === 3, 6_100) >= 0);
});

test('supervisory delays are spread over 1-6 s, from the seed', () => {
  const h = harness();
  h.advance(1_000);
  const start = h.clock.now();
  for (const v of DLH1.vehicles) h.command(v, 'HOLD');
  const heldAt = new Map<string, number>();
  while (h.clock.now() - start <= 7_000) {
    h.advance(50);
    for (const v of DLH1.vehicles) {
      if (!heldAt.has(v) && h.gw.truth(v).state === 'HOLDING') heldAt.set(v, h.clock.now() - start);
    }
  }
  const delays = [...heldAt.values()];
  // trucks that were LOADING/DUMPING/CHARGING queue the hold instead; the rest are timed
  assert.ok(delays.length >= 8, `${delays.length} trucks held`);
  for (const d of delays) assert.ok(d >= 1_000 && d <= 6_050, `delay ${d}`);
  assert.ok(new Set(delays).size >= 4, `delays vary: ${delays}`);
});

test('same command_id and payload returns the original result without executing again; a different payload is COMMAND_ID_REUSED', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 80 }] });
  const body = { command_id: 'dup-1', vehicle_id: 'HT-01', action: 'HOLD', operator_id: 'op1' };
  const first = h.sendCommand(body)!;
  assert.equal(first.status, 'ACCEPTED');
  assert.ok(h.until('HT-01', (t) => t.state === 'HOLDING', 6_100) >= 0);
  h.command('HT-01', 'RESUME');
  assert.ok(h.until('HT-01', (t) => t.state === 'TRAMMING', 6_100) >= 0);

  h.advance(1_000);
  // same fields in another order are the same payload
  const resent = h.sendCommand({ operator_id: 'op1', action: 'HOLD', vehicle_id: 'HT-01', command_id: 'dup-1' })!;
  assert.deepEqual({ ...resent, server_time_ms: 0 }, { ...first, server_time_ms: 0 });
  h.advance(8_000);
  assert.equal(h.gw.truth('HT-01').state, 'TRAMMING', 'the resend did not hold the truck again');

  const reused = h.sendCommand({ ...body, action: 'RESUME' })!;
  assert.equal(reused.status, 'REJECTED');
  assert.equal(reused.reason, 'COMMAND_ID_REUSED');

  const bad = { command_id: 'dup-2', vehicle_id: 'HT-99', action: 'HOLD', operator_id: 'op1' };
  assert.equal(h.sendCommand(bad)!.reason, 'UNKNOWN_VEHICLE');
  assert.equal(h.sendCommand(bad)!.reason, 'UNKNOWN_VEHICLE', 'a rejection is the original result too');
});

test('malformed commands: BAD_JSON, BAD_COMMAND_ID, MISSING_OPERATOR, UNKNOWN_VEHICLE, UNSUPPORTED_ACTION (probe S7)', () => {
  const h = harness();
  const count = () => h.messages('command_ack').length;
  let n = count();
  h.client.send('{"type":"command", this is not json');
  assert.equal(count(), n + 1);
  assert.deepEqual(h.messages('command_ack').at(-1), { type: 'command_ack', command_id: '<unparseable>', vehicle_id: null, status: 'REJECTED', server_time_ms: T0, reason: 'BAD_JSON' });

  n = count();
  h.client.send({ type: 'command', vehicle_id: 'HT-01', action: 'HOLD', operator_id: 'op1' });
  assert.equal(count(), n + 1);
  const missing = h.messages('command_ack').at(-1)!;
  assert.equal(missing.command_id, '<missing>');
  assert.equal(missing.reason, 'BAD_COMMAND_ID');

  assert.equal(h.sendCommand({ command_id: 'x'.repeat(129), vehicle_id: 'HT-01', action: 'HOLD', operator_id: 'op1' })?.reason, 'BAD_COMMAND_ID');
  assert.equal(h.sendCommand({ command_id: 'no-op', vehicle_id: 'HT-01', action: 'HOLD' })!.reason, 'MISSING_OPERATOR');
  assert.equal(h.command('HT-99', 'HOLD').reason, 'UNKNOWN_VEHICLE');
  assert.equal(h.command('HT-01', 'DANCE').reason, 'UNSUPPORTED_ACTION');
});

test('INVALID_STATE: EXIT_ZONE in the bay, CLEAR_ESTOP when not e-stopped, RESUME while loading with nothing queued', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-01', positionM: 40, loaded: false, socPct: 80 },
    { vehicle_id: 'HT-02', positionM: 835, loaded: false, socPct: 80 },
  ] });
  assert.equal(h.command('HT-01', 'EXIT_ZONE').reason, 'INVALID_STATE');
  assert.equal(h.command('HT-01', 'CLEAR_ESTOP').reason, 'INVALID_STATE');
  assert.ok(h.until('HT-02', (t) => t.state === 'LOADING', 5_000) >= 0);
  assert.equal(h.command('HT-02', 'RESUME').reason, 'INVALID_STATE');
});

// ---- queuing (L0.P spec version) ----

test('queuing: a HOLD sent while LOADING waits for the load to finish, then holds', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 835, loaded: false, socPct: 80 }] });
  assert.ok(h.until('HT-01', (t) => t.state === 'LOADING', 5_000) >= 0);
  assert.equal(h.command('HT-01', 'HOLD').status, 'ACCEPTED');
  assert.deepEqual(h.gw.truth('HT-01').pending, ['HOLD'], 'on its way: the 1-6 s delay first');
  h.advance(6_000);
  assert.equal(h.gw.truth('HT-01').queued, 'HOLD', 'then queued behind the load');
  h.advance(4_000);
  assert.equal(h.latest('HT-01').state, 'LOADING');
  assert.ok(h.until('HT-01', (t) => t.state !== 'LOADING', 15_000) >= 0);
  const t = h.latest('HT-01');
  assert.equal(t.state, 'HOLDING');
  assert.equal(t.payload_kg, 42_000, 'the load finished first');
  assert.equal(t.offset_m, 59.95);
  assert.equal(h.gw.truth('HT-01').queued, null);
});

test('queuing: RESUME while a command is queued cancels it, and the truck carries on after loading', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 835, loaded: false, socPct: 80 }] });
  assert.ok(h.until('HT-01', (t) => t.state === 'LOADING', 5_000) >= 0);
  h.command('HT-01', 'HOLD');
  h.advance(6_000);
  assert.equal(h.gw.truth('HT-01').queued, 'HOLD');
  assert.equal(h.command('HT-01', 'RESUME').status, 'ACCEPTED');
  assert.equal(h.gw.truth('HT-01').queued, null);
  assert.ok(h.until('HT-01', (t) => t.state === 'TRAMMING', 20_000) >= 0);
  h.advance(10_000);
  assert.ok(h.telemetry('HT-01').every((t) => t.state !== 'HOLDING'));
});

test('queuing: a newer queued command replaces the older one', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 835, loaded: false, socPct: 80 }] });
  assert.ok(h.until('HT-01', (t) => t.state === 'LOADING', 5_000) >= 0);
  h.command('HT-01', 'HOLD');
  h.command('HT-01', 'RETURN_TO_BAY');
  h.advance(6_000);
  assert.equal(h.gw.truth('HT-01').queued, 'RETURN_TO_BAY');
  assert.ok(h.until('HT-01', (t) => t.state !== 'LOADING', 25_000) >= 0);
  h.advance(2_000);
  assert.equal(h.latest('HT-01').task, 'RETURN_TO_BAY');
  assert.ok(h.telemetry('HT-01').every((t) => t.state !== 'HOLDING'), 'the HOLD never ran');
});

test('a command still within its 1-6 s delay cannot be called back: RESUME is INVALID_STATE, the HOLD still lands (re-probe Q3)', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-08', positionM: 500, loaded: false, socPct: 80 }] });
  h.command('HT-08', 'HOLD');
  const r = h.command('HT-08', 'RESUME');
  assert.deepEqual([r.status, r.reason], ['REJECTED', 'INVALID_STATE']);
  assert.ok(h.until('HT-08', (t) => t.state === 'HOLDING', 6_100) >= 0);
  h.advance(5_000);
  assert.equal(h.latest('HT-08').state, 'HOLDING');
});

test('a HOLD sent in the last second of loading takes effect after its delay, not when loading ends (re-probe Q3)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const h = harness({ seed, trucks: [{ vehicle_id: 'HT-08', positionM: 835, loaded: false, socPct: 80 }] });
    assert.ok(h.until('HT-08', (t) => t.state === 'LOADING', 5_000) >= 0);
    h.advance(19_200);
    const sent = h.clock.now();
    h.command('HT-08', 'HOLD');
    assert.ok(h.until('HT-08', (t) => t.state === 'HOLDING', 7_000) >= 0);
    const after = h.clock.now() - sent;
    const due = h.gw.truth('HT-08');
    assert.ok(after >= 1_000 && after <= 6_250, `seed ${seed}: held ${after} ms after sending`);
    assert.equal(due.queued, null);
  }
});

// ---- EXIT_ZONE and RETURN_TO_BAY ----

test('EXIT_ZONE: an empty truck nearer the start of its zone reverses at 3.0 m/s and holds 2 m outside (probe S3)', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-05', positionM: 225, loaded: false, socPct: 60 }] });
  assert.equal(h.command('HT-05', 'EXIT_ZONE').status, 'ACCEPTED');
  assert.ok(h.until('HT-05', (t) => t.task === 'EXIT_ZONE', 6_100) >= 0);
  const moving = h.latest('HT-05');
  assert.equal(moving.state, 'TRAMMING');
  assert.equal(moving.direction, 'REV');
  assert.equal(moving.speed_mps, 3);
  assert.ok(h.until('HT-05', (t) => t.state === 'HOLDING', 60_000) >= 0);
  const held = h.latest('HT-05');
  assert.equal(held.segment_id, 'SEG-BAY');
  assert.equal(held.offset_m, 78);
  assert.equal(held.task, null);
  assert.equal(held.direction, 'FWD');
  assert.equal(held.speed_mps, 0);
  h.advance(5_000);
  near(h.gw.truth('HT-05').positionM, 78, 0.001, 'stays held');
});

test('EXIT_ZONE: forward when the far boundary is nearer; loaded trucks go at 2.0 m/s either way', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-02', positionM: 1500, loaded: true, socPct: 60 },
    { vehicle_id: 'HT-03', positionM: 900, loaded: true, socPct: 60 },
  ] });
  h.command('HT-02', 'EXIT_ZONE');
  h.command('HT-03', 'EXIT_ZONE');
  assert.ok(h.until('HT-02', (t) => t.task === 'EXIT_ZONE', 6_100) >= 0);
  assert.ok(h.until('HT-03', (t) => t.task === 'EXIT_ZONE', 6_100) >= 0);
  h.advance(400);
  assert.equal(h.latest('HT-02').direction, 'FWD');
  assert.equal(h.latest('HT-02').speed_mps, 2);
  assert.equal(h.latest('HT-03').direction, 'REV');
  assert.equal(h.latest('HT-03').speed_mps, 2);
  h.advance(60_000);
  assert.equal(h.latest('HT-02').state, 'HOLDING');
  assert.equal(h.latest('HT-02').segment_id, 'SEG-TIP-1');
  assert.equal(h.latest('HT-02').offset_m, 2);
  assert.equal(h.latest('HT-02').payload_kg, 42_000, 'no dumping on the way out');
  assert.equal(h.latest('HT-03').state, 'HOLDING');
  assert.equal(h.latest('HT-03').segment_id, 'SEG-DRAW-12');
  assert.equal(h.latest('HT-03').offset_m, 58);
});

test('EXIT_ZONE: a truck that has already left the zone when the command takes effect simply holds', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 578, loaded: false, socPct: 60 }] });
  h.command('HT-01', 'EXIT_ZONE');
  assert.ok(h.until('HT-01', (t) => t.state === 'HOLDING', 6_100) >= 0);
  assert.equal(h.latest('HT-01').zone_id, 'L4_NORTH');
  assert.ok(h.telemetry('HT-01').every((t) => t.direction === 'FWD'), 'never reversed');
});

test('reverse speed when loaded is a parameter (L0.P pessimistic version)', () => {
  const h = harness({ behaviour: { reverseSpeedLoaded: 1.5 }, trucks: [{ vehicle_id: 'HT-03', positionM: 900, loaded: true, socPct: 60 }] });
  h.command('HT-03', 'EXIT_ZONE');
  assert.ok(h.until('HT-03', (t) => t.task === 'EXIT_ZONE', 6_100) >= 0);
  assert.equal(h.latest('HT-03').speed_mps, 1.5);
});

test('RETURN_TO_BAY takes the shorter direction, charges to 90 %, then parks IDLE; RESUME starts it again', () => {
  const h = harness({ trucks: [
    { vehicle_id: 'HT-01', positionM: 300, loaded: false, socPct: 60 },
    { vehicle_id: 'HT-02', positionM: 1500, loaded: true, socPct: 60 },
  ] });
  h.command('HT-01', 'RETURN_TO_BAY');
  h.command('HT-02', 'RETURN_TO_BAY');
  assert.ok(h.until('HT-01', (t) => t.task === 'RETURN_TO_BAY', 6_100) >= 0);
  assert.ok(h.until('HT-02', (t) => t.task === 'RETURN_TO_BAY', 6_100) >= 0);
  h.advance(400);
  assert.equal(h.latest('HT-01').direction, 'REV');
  assert.equal(h.latest('HT-01').speed_mps, 3);
  assert.equal(h.latest('HT-02').direction, 'FWD');
  assert.ok(h.until('HT-01', (t) => t.state === 'CHARGING', 120_000) >= 0);
  assert.equal(h.latest('HT-01').offset_m, 79.95);
  assert.equal(h.latest('HT-01').task, 'RETURN_TO_BAY');
  assert.ok(h.until('HT-01', (t) => t.state === 'IDLE', 1_000_000) >= 0);
  assert.equal(h.latest('HT-01').soc_pct, 90);
  assert.equal(h.latest('HT-01').task, null);
  assert.ok(h.until('HT-02', (t) => t.state === 'IDLE', 1_000_000) >= 0);
  assert.equal(h.latest('HT-02').payload_kg, 42_000, 'drove past the tip without dumping');
  assert.equal(h.command('HT-01', 'RESUME').status, 'ACCEPTED');
  assert.ok(h.until('HT-01', (t) => t.state === 'TRAMMING' && t.speed_mps > 0, 6_100) >= 0);
});

test('RETURN_TO_BAY while CHARGING: finishes charging, then parks IDLE', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 75, loaded: false, socPct: 20 }] });
  assert.ok(h.until('HT-01', (t) => t.state === 'CHARGING', 5_000) >= 0);
  assert.equal(h.command('HT-01', 'RETURN_TO_BAY').status, 'ACCEPTED');
  assert.ok(h.until('HT-01', (t) => t.state !== 'CHARGING', 1_000_000) >= 0);
  assert.equal(h.latest('HT-01').state, 'IDLE');
  assert.equal(h.latest('HT-01').soc_pct, 90);
  assert.equal(h.latest('HT-01').offset_m, 79.95);
});

// ---- leases and manual driving (§6) ----

function leaseEvents(h: ReturnType<typeof harness>, v: string): LeaseEvent[] {
  return h.messages('lease_event').filter((e) => e.vehicle_id === v);
}

test('TAKE_CONTROL: MANUAL and stopped at once, GRANTED before the ack, lease details in the ack; deadman after 500 ms without input', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 60 }] });
  h.advance(1_000);
  const ack = h.command('HT-01', 'TAKE_CONTROL');
  assert.equal(ack.status, 'ACCEPTED');
  assert.match(ack.lease_id!, /^L-\d{5}-[0-9a-f]{4}$/);
  assert.equal(ack.lease_idle_timeout_ms, 10_000);
  assert.equal(ack.deadman_ms, 500);
  const all = h.client.messages();
  const gi = all.findIndex((m) => m.type === 'lease_event' && m.event === 'GRANTED');
  const ai = all.findIndex((m) => m.type === 'command_ack' && m.command_id === ack.command_id);
  assert.ok(gi >= 0 && gi < ai, 'GRANTED, then the ack (as seen live)');
  assert.deepEqual(leaseEvents(h, 'HT-01')[0], { type: 'lease_event', vehicle_id: 'HT-01', event: 'GRANTED', lease_id: ack.lease_id, operator_id: 'op1', server_time_ms: T0 + 1_000, forced: false });
  const truth = h.gw.truth('HT-01');
  assert.equal(truth.state, 'MANUAL');
  assert.equal(truth.speedMps, 0);
  h.advance(200);
  assert.deepEqual(h.latest('HT-01').control, { mode: 'MANUAL', operator_id: 'op1', deadman: false, last_drive_seq: 0, last_drive_sent_ms: null });
  h.advance(250);
  assert.equal(h.gw.truth('HT-01').deadman, false, 'not before 500 ms');
  h.advance(100);
  assert.equal(h.gw.truth('HT-01').deadman, true, 'by 550 ms');
});

test('driving: |throttle| x manual speed while input is fresh; stops on the deadman when input stops; stale seq is discarded', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 60 }] });
  const lease = h.command('HT-01', 'TAKE_CONTROL').lease_id!;
  let seq = 0;
  for (let i = 0; i < 30; i++) { h.drive('HT-01', lease, ++seq, 0.5, 5_000 + i); h.advance(100); }
  let t = h.latest('HT-01');
  assert.equal(t.speed_mps, 2, '0.5 x 4.0 m/s empty');
  assert.equal(t.direction, 'FWD');
  assert.equal(t.control.deadman, false);
  assert.ok(t.control.last_drive_seq! >= 28);
  assert.ok(t.control.last_drive_sent_ms! >= 5_027);

  h.drive('HT-01', lease, 5, 1.0);
  h.advance(100);
  assert.equal(h.gw.truth('HT-01').speedMps, 2, 'a lower seq is discarded');
  assert.equal(h.messages('drive_rejected').length, 0, 'silently');

  // input stops: the truck stops within the deadman and does not creep afterwards
  h.advance(500);
  assert.equal(h.gw.truth('HT-01').deadman, true);
  assert.equal(h.gw.truth('HT-01').speedMps, 0);
  const stoppedAt = h.gw.truth('HT-01').positionM;
  h.advance(5_000);
  assert.equal(h.gw.truth('HT-01').positionM, stoppedAt);

  for (let i = 0; i < 10; i++) { h.drive('HT-01', lease, ++seq, -0.25); h.advance(100); }
  t = h.latest('HT-01');
  assert.equal(t.direction, 'REV');
  assert.equal(t.speed_mps, 1);
  assert.equal(t.state, 'MANUAL');
});

test('drive rejections: NO_ACTIVE_LEASE, BAD_THROTTLE, BAD_SEQ, UNKNOWN_VEHICLE; at most one per vehicle per reason per second', () => {
  const h = harness();
  const rej = () => h.messages('drive_rejected');
  for (let i = 0; i < 5; i++) { h.drive('HT-01', 'L-none', i + 1, 0.2); h.advance(100); }
  assert.equal(rej().length, 1);
  assert.deepEqual(rej()[0], { type: 'drive_rejected', vehicle_id: 'HT-01', lease_id: 'L-none', reason: 'NO_ACTIVE_LEASE', server_time_ms: T0 });
  h.advance(600);
  h.drive('HT-01', 'L-none', 9, 0.2);
  assert.equal(rej().length, 2, 'a second one after a second');

  const lease = h.command('HT-01', 'TAKE_CONTROL').lease_id!;
  h.drive('HT-01', lease, 1, 1.5);
  h.drive('HT-01', lease, 0, 0.2);
  h.drive('HT-01', lease, 1.5, 0.2);
  h.drive('HT-99', lease, 1, 0.2);
  h.advance(1_000); // NO_ACTIVE_LEASE was last sent for HT-01 under a second ago
  h.drive('HT-01', 'L-wrong', 1, 0.2);
  assert.deepEqual(rej().slice(2).map((r) => r.reason), ['BAD_THROTTLE', 'BAD_SEQ', 'UNKNOWN_VEHICLE', 'NO_ACTIVE_LEASE']);
});

test('lease idle timeout: no fresh input for 10 s gives EXPIRED (NO_DRIVE_INPUT) and HOLDING; it does not resume by itself', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 60 }] });
  const lease = h.command('HT-01', 'TAKE_CONTROL').lease_id!;
  h.advance(9_900);
  assert.equal(leaseEvents(h, 'HT-01').length, 1);
  h.advance(200);
  const ev = leaseEvents(h, 'HT-01').at(-1)!;
  assert.equal(ev.event, 'EXPIRED');
  assert.equal(ev.reason, 'NO_DRIVE_INPUT');
  assert.equal(ev.lease_id, lease);
  near(ev.server_time_ms - T0, 10_000, 50, 'expiry time');
  h.advance(200);
  const t = h.latest('HT-01');
  assert.equal(t.state, 'HOLDING');
  assert.deepEqual(t.control, { mode: 'AUTO', operator_id: null, deadman: false, last_drive_seq: null, last_drive_sent_ms: null });
  h.advance(30_000);
  assert.equal(h.latest('HT-01').state, 'HOLDING');
});

test('RELEASE_CONTROL: a wrong lease_id is NOT_LEASE_HOLDER; the right one releases and the truck holds', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 60 }] });
  const lease = h.command('HT-01', 'TAKE_CONTROL').lease_id!;
  assert.equal(h.command('HT-01', 'RELEASE_CONTROL', { lease_id: 'L-wrong' }).reason, 'NOT_LEASE_HOLDER');
  assert.equal(h.command('HT-01', 'RELEASE_CONTROL', { lease_id: lease }).status, 'ACCEPTED');
  assert.equal(leaseEvents(h, 'HT-01').at(-1)!.event, 'RELEASED');
  assert.equal(h.gw.truth('HT-01').state, 'HOLDING');
  assert.equal(h.gw.truth('HT-01').mode, 'AUTO');
  assert.equal(h.command('HT-01', 'RELEASE_CONTROL', { lease_id: lease }).reason, 'NOT_LEASE_HOLDER', 'no lease any more');
});

test('one lease at a time: the holder gets the same lease back, others get LEASE_HELD naming the holder, force revokes it', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 60 }] });
  const l1 = h.command('HT-01', 'TAKE_CONTROL', {}, 'op1').lease_id!;
  assert.equal(h.command('HT-01', 'TAKE_CONTROL', {}, 'op1').lease_id, l1);
  assert.equal(leaseEvents(h, 'HT-01').length, 1, 'no second GRANTED');
  const held = h.command('HT-01', 'TAKE_CONTROL', {}, 'op2');
  assert.equal(held.reason, 'LEASE_HELD');
  assert.equal(held.holder, 'op1');
  assert.equal(h.command('HT-01', 'TAKE_CONTROL', { force: 'true' }, 'op2').reason, 'LEASE_HELD', 'force must be JSON true');

  const forced = h.command('HT-01', 'TAKE_CONTROL', { force: true }, 'op2');
  assert.equal(forced.status, 'ACCEPTED');
  assert.notEqual(forced.lease_id, l1);
  const [revoked, granted] = leaseEvents(h, 'HT-01').slice(-2);
  assert.deepEqual({ ...revoked, server_time_ms: 0 }, { type: 'lease_event', vehicle_id: 'HT-01', event: 'REVOKED', lease_id: l1, operator_id: 'op1', reason: 'FORCED_TAKEOVER', by_operator: 'op2', server_time_ms: 0 });
  assert.equal(granted!.event, 'GRANTED');
  assert.equal(granted!.forced, true);
  assert.equal(granted!.operator_id, 'op2');

  h.drive('HT-01', l1, 1, 0.5);
  assert.equal(h.messages('drive_rejected').at(-1)!.reason, 'NO_ACTIVE_LEASE', 'the old lease is dead');

  for (const op of ['op1', 'op2']) {
    for (const action of ['HOLD', 'RESUME', 'RETURN_TO_BAY', 'EXIT_ZONE']) {
      const a = h.command('HT-01', action, {}, op);
      assert.equal(a.reason, 'LEASE_HELD', `${action} from ${op}`);
      assert.equal(a.holder, 'op2');
    }
  }
});

test('TAKE_CONTROL interrupts loading', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 835, loaded: false, socPct: 80 }] });
  assert.ok(h.until('HT-01', (t) => t.state === 'LOADING', 5_000) >= 0);
  const lease = h.command('HT-01', 'TAKE_CONTROL').lease_id!;
  assert.equal(h.gw.truth('HT-01').state, 'MANUAL');
  h.command('HT-01', 'RELEASE_CONTROL', { lease_id: lease });
  h.advance(30_000);
  assert.equal(h.latest('HT-01').state, 'HOLDING');
  assert.equal(h.latest('HT-01').payload_kg, 0, 'the interrupted load never completed');
});

// ---- e-stop and faults ----

test('ESTOP: immediate, accepted while another operator drives, revokes the lease; then only ESTOP and CLEAR_ESTOP; CLEAR_ESTOP holds', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 60 }] });
  const lease = h.command('HT-01', 'TAKE_CONTROL', {}, 'op1').lease_id!;
  for (let i = 1; i <= 10; i++) { h.drive('HT-01', lease, i, 0.5); h.advance(100); }
  assert.equal(h.command('HT-01', 'ESTOP', {}, 'op2').status, 'ACCEPTED');
  const truth = h.gw.truth('HT-01');
  assert.equal(truth.state, 'ESTOPPED');
  assert.equal(truth.speedMps, 0);
  const ev = leaseEvents(h, 'HT-01').at(-1)!;
  assert.equal(ev.event, 'REVOKED');
  assert.equal(ev.reason, 'ESTOP');
  assert.equal(ev.by_operator, 'op2');
  for (const action of ['HOLD', 'RESUME', 'RETURN_TO_BAY', 'EXIT_ZONE', 'TAKE_CONTROL']) {
    assert.equal(h.command('HT-01', action).reason, 'ESTOP_ACTIVE', action);
  }
  assert.equal(h.command('HT-01', 'ESTOP').status, 'ACCEPTED');
  h.advance(200);
  assert.equal(h.latest('HT-01').state, 'ESTOPPED');
  assert.equal(h.command('HT-01', 'CLEAR_ESTOP').status, 'ACCEPTED');
  assert.equal(h.gw.truth('HT-01').state, 'HOLDING');
  assert.equal(h.command('HT-01', 'RESUME').status, 'ACCEPTED');
});

test('HYD_PRESSURE_LOW: supervisory commands INTERLOCK_ACTIVE, limp-home at 1.0 m/s under a lease, back to FAULT afterwards', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 300, loaded: false, socPct: 60 }] });
  h.gw.injectFault('HT-01', 'HYD_PRESSURE_LOW');
  h.advance(200);
  let t = h.latest('HT-01');
  assert.equal(t.state, 'FAULT');
  assert.deepEqual(t.faults, ['HYD_PRESSURE_LOW']);
  assert.equal(t.speed_mps, 0);
  for (const action of ['HOLD', 'RESUME', 'RETURN_TO_BAY', 'EXIT_ZONE', 'CLEAR_ESTOP']) {
    assert.equal(h.command('HT-01', action).reason, 'INTERLOCK_ACTIVE', action);
  }
  const lease = h.command('HT-01', 'TAKE_CONTROL').lease_id!;
  for (let i = 1; i <= 10; i++) { h.drive('HT-01', lease, i, -1.0); h.advance(100); }
  t = h.latest('HT-01');
  assert.equal(t.state, 'MANUAL');
  assert.deepEqual(t.faults, ['HYD_PRESSURE_LOW']);
  assert.equal(t.speed_mps, 1, 'limp-home speed at full throttle');
  assert.equal(t.direction, 'REV');
  assert.equal(h.command('HT-01', 'HOLD').reason, 'INTERLOCK_ACTIVE', 'still interlocked while driven');
  h.command('HT-01', 'RELEASE_CONTROL', { lease_id: lease });
  assert.equal(h.gw.truth('HT-01').state, 'FAULT');
  h.command('HT-01', 'ESTOP');
  assert.equal(h.gw.truth('HT-01').state, 'ESTOPPED');
  assert.equal(h.command('HT-01', 'CLEAR_ESTOP').status, 'ACCEPTED');
  assert.equal(h.gw.truth('HT-01').state, 'FAULT');
});

test('a fault on a leased truck: a limp-home fault keeps the lease; any other revokes it (FAULT)', () => {
  const h = harness();
  const l1 = h.command('HT-01', 'TAKE_CONTROL').lease_id!;
  h.gw.injectFault('HT-01', 'HYD_PRESSURE_LOW');
  assert.equal(h.gw.truth('HT-01').leaseId, l1);
  assert.equal(h.gw.truth('HT-01').state, 'MANUAL');
  h.command('HT-02', 'TAKE_CONTROL');
  h.gw.injectFault('HT-02', 'BATTERY_DEPLETED');
  const ev = leaseEvents(h, 'HT-02').at(-1)!;
  assert.equal(ev.event, 'REVOKED');
  assert.equal(ev.reason, 'FAULT');
  assert.equal(h.gw.truth('HT-02').state, 'FAULT');
});

// ---- blasts ----

function zoneEvents(h: ReturnType<typeof harness>, zone: string): ZoneEvent[] {
  return h.messages('zone_event').filter((e) => e.zone_id === zone);
}

test('blast: CLOSING with the configured notice, CLOSED at effective_at, OPEN (CLEARED) after the closure; a hello mid-blast carries it', () => {
  const h = harness({ blasts: [{ zoneId: 'L4_SOUTH', atMs: 10_000, closedForMs: 90_000 }] });
  h.advance(10_000);
  assert.deepEqual(zoneEvents(h, 'L4_SOUTH'), [{ type: 'zone_event', zone_id: 'L4_SOUTH', status: 'CLOSING', reason: 'BLAST_WINDOW', effective_at_ms: T0 + 130_000, server_time_ms: T0 + 10_000 }]);
  const late = h.gw.connect();
  late.send(AUTH('late@example.com'));
  const hello = late.messages()[0]!;
  assert.equal(hello.type, 'hello');
  if (hello.type === 'hello') {
    assert.deepEqual(hello.zones.find((z) => z.zone_id === 'L4_SOUTH'), { zone_id: 'L4_SOUTH', status: 'CLOSING', effective_at_ms: T0 + 130_000, reason: 'BLAST_WINDOW' });
  }
  h.advance(119_950);
  assert.equal(zoneEvents(h, 'L4_SOUTH').length, 1);
  h.advance(50);
  assert.deepEqual(zoneEvents(h, 'L4_SOUTH')[1], { type: 'zone_event', zone_id: 'L4_SOUTH', status: 'CLOSED', reason: 'BLAST_WINDOW', effective_at_ms: T0 + 130_000, server_time_ms: T0 + 130_000 });
  h.advance(90_000);
  assert.deepEqual(zoneEvents(h, 'L4_SOUTH')[2], { type: 'zone_event', zone_id: 'L4_SOUTH', status: 'OPEN', reason: 'CLEARED', effective_at_ms: T0 + 220_000, server_time_ms: T0 + 220_000 });
  assert.equal(h.gw.zone('L4_SOUTH').status, 'OPEN');
});

test('a cancelled blast goes from CLOSING straight back to OPEN (CANCELLED)', () => {
  const h = harness({ blasts: [{ zoneId: 'DECLINE', atMs: 5_000, closedForMs: 90_000, cancelAfterMs: 40_000 }] });
  h.advance(200_000);
  assert.deepEqual(zoneEvents(h, 'DECLINE').map((e) => [e.status, e.reason, e.server_time_ms - T0]), [
    ['CLOSING', 'BLAST_WINDOW', 5_000],
    ['OPEN', 'CANCELLED', 45_000],
  ]);
});

test('the random blast schedule: configured notice, measured closure lengths and spacing, cancellations, two zones at once, never the bay', () => {
  let cancelled = 0, overlapping = 0, closures = 0;
  for (const seed of [1, 2, 3]) {
    const h = harness({ seed, blasts: 'random' });
    h.advance(3_600_000);
    const events = h.messages('zone_event');
    const closing = events.filter((e) => e.status === 'CLOSING');
    assert.ok(closing.length >= 8, `seed ${seed}: ${closing.length} blasts in an hour`);
    for (const e of closing) {
      assert.equal(e.effective_at_ms! - e.server_time_ms, DLH1.noticeMs);
      assert.notEqual(e.zone_id, 'BAY');
    }
    for (const c of events.filter((e) => e.status === 'CLOSED')) {
      const open = events.find((e) => e.zone_id === c.zone_id && e.status === 'OPEN' && e.server_time_ms > c.server_time_ms);
      if (!open) continue;
      closures++;
      const ms = open.server_time_ms - c.server_time_ms;
      assert.ok(ms >= 66_000 && ms <= 111_050, `closed for ${ms}`);
    }
    cancelled += events.filter((e) => e.reason === 'CANCELLED').length;
    for (let i = 1; i < closing.length; i++) {
      if (closing[i]!.server_time_ms < closing[i - 1]!.effective_at_ms!) overlapping++;
    }
  }
  assert.ok(closures > 10);
  assert.ok(cancelled > 0, 'some blasts are cancelled');
  assert.ok(overlapping > 0, 'sometimes two zones are closing at once');
});

// ---- truth ----

test('truth is readable separately from what is sent, and is a copy', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 835, loaded: false, socPct: 80 }] });
  assert.ok(h.until('HT-01', (t) => t.state === 'LOADING', 5_000) >= 0);
  h.command('HT-01', 'EXIT_ZONE');
  h.advance(6_000);
  const t = h.gw.truth('HT-01');
  assert.equal(t.vehicleId, 'HT-01');
  assert.equal(t.zoneId, 'DRAW_12');
  assert.equal(t.segmentId, 'SEG-DRAW-12');
  assert.equal(t.queued, 'EXIT_ZONE');
  assert.equal(t.loaded, false);
  t.positionM = 0;
  t.faults.push('MADE_UP');
  assert.notEqual(h.gw.truth('HT-01').positionM, 0);
  assert.deepEqual(h.gw.truth('HT-01').faults, []);
  assert.equal(h.gw.truthAll().length, DLH1.vehicles.length);
});

// ---- a different site (the model knows no site) ----

test('a different site just works: route, zone names, loop length, vehicles and notice all come from config', () => {
  const site = {
    site_id: 'TEST-2', vehicles: ['T1', 'T2', 'T3'], loop_length_m: 900, noticeMs: 60_000,
    route: [
      { segment_id: 'P', zone_id: 'PARK', length_m: 50, kind: 'bay', start_m: 0 },
      { segment_id: 'R1', zone_id: 'RAMP', length_m: 300, kind: 'transit', start_m: 50 },
      { segment_id: 'F', zone_id: 'FACE', length_m: 50, kind: 'load', start_m: 350 },
      { segment_id: 'R2', zone_id: 'HAUL', length_m: 400, kind: 'transit', start_m: 400 },
      { segment_id: 'C', zone_id: 'CRUSHER', length_m: 100, kind: 'dump', start_m: 800 },
    ],
  };
  const h = harness({ site, blasts: [{ zoneId: 'HAUL', atMs: 5_000, closedForMs: 30_000 }], trucks: [
    { vehicle_id: 'T1', positionM: 340, loaded: false, socPct: 80 },
    { vehicle_id: 'T2', positionM: 100, loaded: false, socPct: 80 },
    { vehicle_id: 'T3', positionM: 890, loaded: false, socPct: 80 },
  ] });
  const hello = h.messages('hello')[0]!;
  assert.deepEqual(hello.vehicles, ['T1', 'T2', 'T3']);
  assert.equal(hello.loop_length_m, 900);
  assert.deepEqual(hello.zones.map((z) => z.zone_id), ['PARK', 'RAMP', 'FACE', 'HAUL', 'CRUSHER']);
  h.advance(5_000);
  assert.equal(h.latest('T3').zone_id, 'PARK', 'wrapped at 900 m');
  h.command('T2', 'EXIT_ZONE');
  assert.ok(h.until('T1', (t) => t.state === 'LOADING', 30_000) >= 0);
  assert.equal(h.latest('T1').segment_id, 'F');
  assert.equal(h.latest('T1').offset_m, 49.95);
  assert.ok(h.until('T2', (t) => t.state === 'HOLDING', 60_000) >= 0);
  assert.equal(h.latest('T2').segment_id, 'P');
  assert.equal(h.latest('T2').offset_m, 48);
  const closing = zoneEvents(h, 'HAUL')[0]!;
  assert.equal(closing.effective_at_ms! - closing.server_time_ms, 60_000);
});
