// TESTING.md L2.40-L2.44 (the gateway link), the link-drop row of L5, L6.1 (replay half), L6.4 and
// L7.8, against the in-process fake gateway on a manual clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../src/params.ts';
import { GatewayLink, linkConfigFromEnv, type Dialer } from '../src/link.ts';
import { FleetState } from '../src/fleet.ts';
import { ManualClock } from '../src/clock.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { linkRig } from './helpers/link-rig.ts';
import { PRIYA, MARTA } from './helpers/registry-rig.ts';
import { T0 } from './helpers/rig.ts';

const V = 'HT-03';
const truck = (r: { fleet: FleetState }, id: string) => r.fleet.snapshot().trucks.find((t) => t.vehicleId === id)!;

test('connects, logs in from the configured email, and hands hello to fleet state', () => {
  const r = linkRig();
  try {
    r.link.start();
    assert.equal(r.link.status().state, 'up');
    assert.deepEqual(JSON.parse(r.dialer.sentLines[0]!), { type: 'auth', email: 'service@example.com' });
    r.advance(1_000);
    const snap = r.fleet.snapshot();
    assert.equal(snap.siteId, DLH1.site_id);
    assert.equal(snap.trucks.length, DLH1.vehicles.length);
    assert.ok(snap.trucks.every((t) => t.confidence === 'live'), 'every truck reporting');
    assert.equal(snap.link.up, true);
  } finally { r.cleanup(); }
});

test('L6.4 one connection per service, however often it is started and however many listen', () => {
  const r = linkRig();
  try {
    for (let i = 0; i < 5; i++) { r.link.start(); r.link.subscribe(() => {}); }
    r.advance(10_000);
    assert.equal(r.dialer.dials, 1);
    assert.equal(r.dialer.openConnections, 1);
  } finally { r.cleanup(); }
});

test('L2.40 no heartbeat for 5 s: link down, and the connection is redialled', () => {
  const r = linkRig();
  try {
    r.link.start();
    r.advance(3_000);
    r.dialer.mode = 'blackhole';
    const lastHb = r.link.status().lastHeartbeatMs!;
    r.until(() => !r.link.isUp(), 10_000, 10);
    const s = r.link.status();
    assert.equal(s.state, 'down');
    assert.equal(s.sinceMs - lastHb, PARAMS.linkDownAfter.value, 'down exactly when the threshold passes');
    assert.match(s.reason, /no heartbeat for 5 s/);
    assert.equal(r.fleet.snapshot().link.up, false);
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), 10_000, 10);
    assert.equal(r.dialer.dials, 2);
    assert.equal(r.dialer.openConnections, 1, 'the dead connection was closed, not left open');
  } finally { r.cleanup(); }
});

test('L2.41 login accepted then closed before hello is an outage: retried with backoff, doubling to a cap', () => {
  const r = linkRig({}, { random: () => 1 }); // jitter at its top: each delay is the full step
  try {
    r.link.start();
    r.dialer.mode = 'outage';
    r.dialer.dropAll();
    const dropAt = r.clock.now();
    r.advance(30_000, 10);
    const s = r.link.status();
    assert.equal(s.state, 'down');
    assert.match(s.reason, /login accepted, then closed before hello/);
    const t = r.dialer.dialTimes.slice(1);
    const steps = t.map((x, i) => x - (i === 0 ? dropAt : t[i - 1]!));
    assert.deepEqual(steps.slice(0, 7), [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
    assert.ok(Math.max(...steps) <= PARAMS.linkBackoffMax.value, 'capped');
    // The site comes back: one more attempt, then up, and the backoff starts again from the base.
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), PARAMS.linkBackoffMax.value + 100, 10);
    assert.equal(r.link.status().failures, 0);
  } finally { r.cleanup(); }
});

test('L2.41 the jitter never makes a retry instant: at its bottom it is half the step', () => {
  const r = linkRig({}, { random: () => 0 });
  try {
    r.link.start();
    r.dialer.mode = 'outage';
    r.dialer.dropAll();
    const dropAt = r.clock.now();
    r.advance(12_000, 10);
    const t = r.dialer.dialTimes.slice(1);
    const steps = t.map((x, i) => x - (i === 0 ? dropAt : t[i - 1]!));
    assert.deepEqual(steps.slice(0, 5), [250, 500, 1_000, 2_000, 2_500]);
  } finally { r.cleanup(); }
});

test('L2.42 on hello zones, leases and vehicles replace local state; an in-flight command is replayed and its lost ack recovered', () => {
  const r = linkRig({ blasts: [{ zoneId: 'DECLINE', atMs: 4_000, closedForMs: 60_000 }] });
  try {
    r.link.start();
    r.advance(2_000);
    // The ack is lost: the gateway carries out the HOLD, but nothing reaches us.
    r.dialer.mode = 'blackhole';
    const rec = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    // While we are deaf, another client takes a lease and a blast notice goes out.
    const other = r.gw.connect();
    other.send({ type: 'auth', email: 'service@example.com' });
    other.send({ type: 'command', command_id: 'x-1', vehicle_id: 'HT-07', action: 'TAKE_CONTROL', operator_id: 'jsmith' });
    r.until(() => !r.link.isUp(), 10_000, 10);
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), 10_000, 10);
    const hello = r.linkEvents.filter((e) => e.type === 'up').at(-1)!;
    assert.ok(hello.type === 'up');

    const after = r.registry.get(rec.id)!;
    assert.equal(after.attempts.length, 1, 'replayed, not retried');
    assert.equal(after.attempts[0]!.sends.length, 2);
    assert.equal(after.attempts[0]!.sends[1]!.replay, true);
    assert.equal(after.attempts[0]!.ack?.status, 'ACCEPTED', 'the replay recovered the ack');
    assert.equal(after.attempts[0]!.ack?.sendIndex, 1, 'matched to the replay, the latest send');
    const replayed = r.dialer.sentLines.map((l) => JSON.parse(l)).filter((m) => m.type === 'command' && m.vehicle_id === V);
    assert.equal(replayed.length, 2);
    assert.equal(replayed[1].command_id, replayed[0].command_id);
    r.until(() => r.registry.get(rec.id)!.status === 'confirmed', 5_000);
    assert.equal(r.registry.get(rec.id)!.status, 'confirmed');
    assert.equal(r.gw.truth(V).state, 'HOLDING');

    assert.equal(r.registry.lease('HT-07')?.operatorId, 'jsmith', 'leases from hello');
    const z = r.fleet.snapshot().zones.find((x) => x.zoneId === 'DECLINE')!;
    assert.equal(z.status, 'CLOSING', 'zones from hello');
    assert.deepEqual(r.fleet.snapshot().trucks.map((t) => t.vehicleId), hello.hello.vehicles);
  } finally { r.cleanup(); }
});

test('L2.43 during an outage every truck ages; nothing is shown as live', () => {
  const r = linkRig();
  try {
    r.link.start();
    r.advance(2_000);
    assert.ok(r.fleet.snapshot().trucks.every((t) => t.confidence === 'live'));
    r.dialer.mode = 'outage';
    r.dialer.dropAll();
    let everLive = false;
    for (let i = 0; i < 100; i++) {
      r.advance(100);
      if (r.fleet.snapshot().trucks.some((t) => t.confidence === 'live')) everLive = true;
    }
    assert.equal(everLive, false);
    const snap = r.fleet.snapshot();
    assert.ok(snap.trucks.every((t) => t.confidence === 'silent'), snap.trucks.map((t) => t.confidence).join(','));
    assert.equal(snap.link.up, false);
    assert.equal(snap.heartbeat.stale, true);
  } finally { r.cleanup(); }
});

test('L2.44 an auth_error that retrying cannot fix stops the link and alarms, naming the reason', () => {
  const r = linkRig({}, { email: 'not-an-email' });
  try {
    r.link.start();
    r.advance(60_000, 500);
    const s = r.link.status();
    assert.equal(s.state, 'stopped');
    assert.equal(s.authError, 'BAD_EMAIL');
    assert.match(s.reason, /BAD_EMAIL/);
    assert.equal(r.dialer.dials, 1, 'not retried');
    assert.ok(r.linkEvents.some((e) => e.type === 'alarm' && /BAD_EMAIL/.test(e.message)));
    assert.equal(r.fleet.snapshot().link.up, false);
  } finally { r.cleanup(); }
});

test('L2.44 TOO_MANY_CONNECTIONS backs off, slower than an outage, and connects once there is room', () => {
  const r = linkRig({}, { random: () => 1 });
  try {
    const others = Array.from({ length: r.gw.behaviour.maxConnections }, () => {
      const c = r.gw.connect();
      c.send({ type: 'auth', email: 'service@example.com' });
      return c;
    });
    r.link.start();
    assert.equal(r.link.status().authError, 'TOO_MANY_CONNECTIONS');
    assert.equal(r.link.status().state, 'down');
    assert.equal(r.link.status().nextAttemptAtMs! - r.clock.now(), PARAMS.linkBackoffBusyBase.value);
    r.advance(PARAMS.linkBackoffBusyBase.value + 100);
    assert.equal(r.dialer.dials, 2);
    others[0]!.close();
    r.until(() => r.link.isUp(), PARAMS.linkBackoffBusyMax.value + 1_000, 100);
    assert.equal(r.link.status().state, 'up');
  } finally { r.cleanup(); }
});

test('L2.44 SERVER_FULL backs off too (scripted: the fake does not produce it)', () => {
  const clock = new ManualClock(T0);
  const fleet = new FleetState(clock);
  let dials = 0;
  const dial: Dialer = (h) => {
    dials++;
    return { write: () => { h.onLine(JSON.stringify({ type: 'auth_error', reason: 'SERVER_FULL' })); h.onClose('closed'); }, close: () => {} };
  };
  const link = new GatewayLink({ clock, fleet, dial, email: 'a@b.co', random: () => 1 });
  link.start();
  assert.equal(link.status().state, 'down');
  assert.match(link.status().reason, /full/);
  clock.advance(PARAMS.linkBackoffBusyBase.value);
  assert.equal(dials, 2);
  link.stop();
});

test('L5 link drop, steady: the link recovers on its own and the picture is live again', () => {
  const r = linkRig();
  try {
    r.link.start();
    r.advance(2_000);
    r.dialer.dropAll();
    assert.equal(r.link.status().state, 'down');
    assert.equal(r.link.status().reason, 'connection closed by the gateway');
    assert.ok(r.linkEvents.some((e) => e.type === 'down'));
    r.until(() => r.link.isUp(), 2_000, 10);
    r.advance(1_000);
    assert.ok(r.fleet.snapshot().trucks.every((t) => t.confidence === 'live'));
    assert.equal(r.fleet.snapshot().dataQuality.connection.unparseable ?? 0, 0);
  } finally { r.cleanup(); }
});

test('L5 link drop, during reconnect: dropped again straight after hello, it recovers again', () => {
  const r = linkRig();
  try {
    r.link.start();
    r.dialer.dropAll();
    r.until(() => r.link.isUp(), 2_000, 10);
    r.dialer.dropAll();
    r.dialer.mode = 'outage';
    r.advance(3_000, 10);
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), PARAMS.linkBackoffMax.value + 100, 10);
    assert.equal(r.link.status().state, 'up');
    assert.equal(r.dialer.openConnections, 1);
  } finally { r.cleanup(); }
});

test('L5 link drop, during manual driving: nothing is sent while down, the deadman stops the truck, and hello says the lease is gone', () => {
  const r = linkRig({ trucks: [{ vehicle_id: V, positionM: 400, state: 'HOLDING' }] });
  try {
    r.link.start();
    r.advance(500);
    r.registry.submit({ vehicleId: V, action: 'TAKE_CONTROL' }, PRIYA);
    const lease = r.registry.lease(V)!;
    assert.ok(lease.leaseId);
    for (let seq = 1; seq <= 10; seq++) {
      assert.equal(r.link.sendDrive({ type: 'drive', vehicle_id: V, lease_id: lease.leaseId!, seq, throttle: 0.5 }), true);
      r.advance(100);
    }
    assert.ok(r.gw.truth(V).speedMps > 0);
    r.dialer.mode = 'outage';
    r.dialer.dropAll();
    assert.equal(r.link.sendDrive({ type: 'drive', vehicle_id: V, lease_id: lease.leaseId!, seq: 11, throttle: 0.5 }), false, 'dropped, never queued');
    r.advance(PARAMS.deadman.value + 100);
    assert.equal(r.gw.truth(V).speedMps, 0, 'stopped on its deadman');
    r.advance(PARAMS.leaseIdleTimeout.value);
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), PARAMS.linkBackoffMax.value + 100, 10);
    assert.equal(r.registry.lease(V), undefined, 'the lease expired while we were away; hello says so');
    assert.equal(r.dialer.sentLines.filter((l) => l.includes('"drive"')).length, 10);
  } finally { r.cleanup(); }
});

test('L5 link drop, during CLOSING (fixture link-drop-in-notice): on reconnect the zone is still closing, with the time left recalculated', () => {
  const r = linkRig({ blasts: [{ zoneId: 'DRAW_12', atMs: 5_000, closedForMs: 60_000 }] });
  try {
    r.link.start();
    r.advance(6_000);
    const z0 = r.fleet.snapshot().zones.find((z) => z.zoneId === 'DRAW_12')!;
    assert.equal(z0.status, 'CLOSING');
    r.dialer.mode = 'outage';
    r.dialer.dropAll();
    r.advance(45_000, 100);
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), PARAMS.linkBackoffMax.value + 100, 10);
    const z = r.fleet.snapshot().zones.find((x) => x.zoneId === 'DRAW_12')!;
    assert.equal(z.status, 'CLOSING');
    assert.equal(z.effectiveAtMs, z0.effectiveAtMs);
    assert.ok(Math.abs(z.msUntilEffective! - (z0.effectiveAtMs! - r.clock.now())) <= 100, `${z.msUntilEffective}`);
    assert.ok(z.msUntilEffective! < z0.msUntilEffective! - 44_000);
  } finally { r.cleanup(); }
});

test('L7.8 e-stop while the link is down: pending, sent when it returns within 10 s, done only when telemetry says ESTOPPED', () => {
  const r = linkRig();
  try {
    r.link.start();
    r.advance(1_000);
    r.dialer.mode = 'outage';
    r.dialer.dropAll();
    const a = r.registry.submit({ vehicleId: V, action: 'ESTOP' }, PRIYA);
    assert.equal(a.status, 'pending');
    r.advance(8_000);
    assert.equal(r.registry.get(a.id)!.status, 'pending');
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), 2_000, 10);
    assert.ok(r.clock.now() - a.createdMs <= PARAMS.estopAutoSendWithin.value);
    assert.equal(r.gw.truth(V).state, 'ESTOPPED');
    r.until(() => r.registry.get(a.id)!.status === 'confirmed', 2_000);
    assert.equal(r.registry.get(a.id)!.status, 'confirmed');
  } finally { r.cleanup(); }
});

test('L7.8 an e-stop older than 10 s when the link returns is not sent; the operator confirms again', () => {
  const r = linkRig();
  try {
    r.link.start();
    r.dialer.mode = 'outage';
    r.dialer.dropAll();
    const a = r.registry.submit({ vehicleId: V, action: 'ESTOP' }, PRIYA);
    r.advance(15_000, 100);
    r.dialer.mode = 'normal';
    r.until(() => r.link.isUp(), PARAMS.linkBackoffMax.value + 100, 10);
    r.advance(1_000);
    assert.notEqual(r.gw.truth(V).state, 'ESTOPPED');
    assert.equal(r.registry.get(a.id)!.hold?.needsReconfirm, true);
    r.registry.reconfirm(a.id, MARTA);
    assert.equal(r.gw.truth(V).state, 'ESTOPPED');
  } finally { r.cleanup(); }
});

test('L6.1 replay half: the service is killed with a command in flight; after restart the command is replayed and confirmed', () => {
  const r = linkRig({ blasts: [{ zoneId: 'L4_SOUTH', atMs: 1_000, closedForMs: 60_000 }] });
  const cleanups = [r.cleanup];
  try {
    r.link.start();
    r.advance(2_000);
    r.dialer.mode = 'blackhole'; // the ack never reaches the old process
    const rec = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.advance(300);
    const r2 = r.restartService();
    cleanups.push(r2.cleanup);
    r.dialer.mode = 'normal';
    r2.link.start();
    assert.equal(r2.link.status().state, 'up');
    const after = r2.registry.get(rec.id)!;
    assert.equal(after.attempts[0]!.sends.length, 2, 'replayed from the log');
    // Checked against what actually went over the wire and what the database holds.
    const wire = r.dialer.sentLines.map((l) => JSON.parse(l)).filter((m) => m.type === 'command');
    assert.deepEqual(wire.map((m) => m.command_id), [after.attempts[0]!.commandId, after.attempts[0]!.commandId]);
    assert.deepEqual(r2.store.sendsOf(rec.id).map((s) => s.replay), [false, true]);
    assert.equal(after.attempts[0]!.ack?.status, 'ACCEPTED');
    r2.until(() => r2.registry.get(rec.id)!.status === 'confirmed', 8_000);
    assert.equal(r2.registry.get(rec.id)!.status, 'confirmed');
    // It acts on hello's snapshot: the zone closing, with the time left from the gateway's clock.
    const z = r2.fleet.snapshot().zones.find((x) => x.zoneId === 'L4_SOUTH')!;
    assert.equal(z.status, 'CLOSING');
    assert.ok(z.msUntilEffective! > 0 && z.msUntilEffective! < 120_000);
  } finally { for (const c of cleanups.reverse()) c(); }
});

test('the drive path leaves room for the relay: sendDrive refuses while down and never queues', () => {
  const r = linkRig();
  try {
    assert.equal(r.link.sendDrive({ type: 'drive', vehicle_id: V, lease_id: 'L', seq: 1, throttle: 0 }), false);
    assert.equal(r.dialer.sentLines.length, 0);
  } finally { r.cleanup(); }
});

test('configuration comes from GATEWAY_HOST, GATEWAY_PORT and GATEWAY_EMAIL, and errors never echo a value', () => {
  assert.deepEqual(linkConfigFromEnv({ GATEWAY_HOST: 'h', GATEWAY_PORT: '443', GATEWAY_EMAIL: 'e@x.io' }), { host: 'h', port: 443, email: 'e@x.io' });
  assert.throws(() => linkConfigFromEnv({ GATEWAY_HOST: 'h' }), /missing environment variables: GATEWAY_PORT, GATEWAY_EMAIL/);
  try { linkConfigFromEnv({ GATEWAY_HOST: 'h', GATEWAY_PORT: 'secret-ish', GATEWAY_EMAIL: 'e@x.io' }); } catch (e) {
    assert.ok(!String(e).includes('secret-ish') && !String(e).includes('e@x.io'));
  }
});
