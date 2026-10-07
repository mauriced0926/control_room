// Task 7: the drive relay (src/drive.ts) through the live hub, on a manual clock against the in-process
// fake gateway. Claims are checked against what the gateway received (the dialer's sent lines) and the
// fake's true truck state, not against the relay's own counters.
// Cases: L6.3 (service half), L7.1, L7.2, L7.3, L7.4, L7.6, L7.7, invariant 3, and the relay's refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaries, checkDrive, DriveRelay } from '../src/drive.ts';
import { LiveHub, type LiveSocket } from '../src/live.ts';
import { PARAMS } from '../src/params.ts';
import { Sessions } from '../src/sessions.ts';
import type { User } from '../src/users.ts';
import type { FakeConfig } from '../fake/gateway.ts';
import { linkRig, type LinkRig } from './helpers/link-rig.ts';

const PRIYA: User = { id: 'priya', name: 'Priya', role: 'operator' };
const DAVE: User = { id: 'dave', name: 'Dave', role: 'operator' };
const MARTA: User = { id: 'marta', name: 'Marta', role: 'supervisor' };

class FakeSocket implements LiveSocket {
  readonly sent: Array<Record<string, any>> = [];
  bufferedAmount = 0;
  closedWith: [number, string] | null = null;
  send(text: string): void { this.sent.push(JSON.parse(text)); }
  close(code: number, reason: string): void { this.closedWith = [code, reason]; }
  results(): Array<Record<string, any>> { return this.sent.filter((m) => m.type === 'result'); }
}

interface Screen {
  sock: FakeSocket;
  sessionId: string;
  say(m: Record<string, unknown>): Record<string, any> | undefined; // the reply, if this message got one
  drive(vehicleId: string, throttle: number): Record<string, any> | undefined;
}

function rig(config: Partial<FakeConfig> = {}) {
  const r: LinkRig = linkRig(config);
  r.link.start();
  assert.ok(r.until(() => r.link.isUp(), 5_000) >= 0, 'link up');
  r.advance(1_000);
  const sessions = new Sessions(r.clock);
  const logs: string[] = [];
  const drive = new DriveRelay({ clock: r.clock, fleet: r.fleet, registry: r.registry, link: r.link, log: (l) => logs.push(l), audit: (e) => r.store.audit(e) });
  const hub = new LiveHub({ clock: r.clock, fleet: r.fleet, link: r.link, registry: r.registry, sessions, log: (l) => logs.push(l), store: r.store, drive });
  const open = (user: User): Screen => {
    const sock = new FakeSocket();
    const session = sessions.create(user);
    const h = hub.connect(sock, session);
    let n = 0;
    const say = (m: Record<string, unknown>) => {
      const before = sock.results().length;
      h.receive(JSON.stringify(m), false);
      return sock.results().length > before ? sock.results().at(-1) : undefined;
    };
    return { sock, sessionId: session.id, say, drive: (vehicleId, throttle) => say({ type: 'drive', vehicleId, throttle, n: ++n }) };
  };
  const drives = () => r.dialer.sentLines.map((l) => JSON.parse(l)).filter((m) => m.type === 'drive');
  // Streams like the browser: one input every 100 ms for `ms`.
  const stream = (s: Screen, v: string, throttle: number, ms: number) => {
    const replies: Array<Record<string, any>> = [];
    for (let t = 0; t < ms; t += 100) { const rep = s.drive(v, throttle); if (rep) replies.push(rep); r.advance(100); }
    return replies;
  };
  const take = (s: Screen, v: string, force = false) => {
    const res = s.say({ type: 'command', action: 'TAKE_CONTROL', vehicleId: v, ...(force ? { force: true } : {}) });
    assert.equal(res?.ok, true, JSON.stringify(res));
    assert.ok(r.until(() => r.registry.lease(v)?.leaseId != null && r.fleet.truck(v)?.control?.value.mode === 'MANUAL', 5_000) >= 0, `${v} under manual control`);
  };
  const view = (v: string) => drive.views().find((d) => d.vehicleId === v);
  return { r, hub, drive, logs, open, drives, stream, take, view, done: () => { hub.shutdown(); drive.stop(); r.cleanup(); } };
}

test('invariant 3 / L7.1: one drive message per fresh input, at once; when input stops nothing more goes out and the truck reports its deadman', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-03', positionM: 300, state: 'HOLDING' }] });
  try {
    const p = h.open(PRIYA);
    h.take(p, 'HT-03');
    const start = h.r.gw.truth('HT-03').positionM;
    let inputs = 0;
    for (let i = 0; i < 20; i++) {
      const before = h.drives().length;
      assert.equal(p.drive('HT-03', 0.5), undefined, 'relayed: no reply needed');
      inputs++;
      assert.equal(h.drives().length, before + 1, 'exactly one drive message, sent as the input arrived');
      h.r.advance(100);
    }
    const sent = h.drives();
    assert.equal(sent.length, inputs);
    const lease = h.r.registry.lease('HT-03')!.leaseId;
    for (const [i, m] of sent.entries()) {
      assert.equal(m.lease_id, lease);
      assert.equal(m.throttle, 0.5);
      assert.equal(typeof m.sent_ms, 'number');
      if (i > 0) assert.ok(m.seq > sent[i - 1]!.seq, 'seq strictly increasing');
    }
    assert.ok(sent[0]!.seq >= 1);
    assert.ok(h.r.gw.truth('HT-03').positionM > start + 3, 'it drove');

    // The browser goes quiet. The service sends nothing, for as long as it stays quiet.
    const count = h.drives().length;
    h.r.advance(3_000);
    assert.equal(h.drives().length, count, 'nothing after the last fresh input');
    assert.equal(h.r.fleet.truck('HT-03')!.control!.value.deadman, true, 'the truck reports its deadman');
    assert.equal(h.r.gw.truth('HT-03').speedMps, 0);
    h.r.advance(8_000);
    assert.equal(h.drives().length, count);
    assert.equal(h.r.registry.lease('HT-03'), undefined, 'lease expired after 10 s with no input');
    assert.equal(h.r.gw.truth('HT-03').state, 'HOLDING');
  } finally { h.done(); }
});

test('L6.3 (service half): a screen that disconnects mid-drive leaves nothing streaming; the truck stops on its deadman', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-04', positionM: 300, state: 'HOLDING' }] });
  try {
    const p = h.open(PRIYA);
    h.take(p, 'HT-04');
    h.stream(p, 'HT-04', 1, 1_000);
    const count = h.drives().length;
    h.hub.closeSession(p.sessionId, 'gone');
    assert.equal(p.sock.closedWith?.[0], 4401, 'the screen is gone');
    h.r.advance(2_000);
    assert.equal(h.drives().length, count);
    assert.equal(h.r.gw.truth('HT-04').speedMps, 0);
    assert.equal(h.r.fleet.truck('HT-04')!.control!.value.deadman, true);
  } finally { h.done(); }
});

test('the relay refuses: not the lease holder, a throttle out of range, out of order, over 20 Hz; and never queues across a link drop', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-05', positionM: 300, state: 'HOLDING' }] });
  try {
    const p = h.open(PRIYA);
    const d = h.open(DAVE);
    const none = p.drive('HT-05', 0.5);
    assert.equal(none?.drive.code, 'NO_LEASE');
    h.take(p, 'HT-05');
    assert.equal(d.drive('HT-05', 0.5)?.drive.code, 'NOT_YOURS');
    assert.match(d.drive('HT-05', 0.5)!.error, /priya has control of HT-05, not you\. Your input was not sent\./);
    assert.match(p.say({ type: 'drive', vehicleId: 'HT-05', throttle: 1.5, n: 99 })!.error, /throttle must be a number from -1 to 1/);
    assert.match(p.say({ type: 'drive', vehicleId: 'HT-05', throttle: '1', n: 100 })!.error, /throttle must be a number/);
    assert.equal(h.drives().length, 0);

    // Out of order: an input numbered below one already relayed is dropped.
    p.say({ type: 'drive', vehicleId: 'HT-05', throttle: 0.2, n: 10 });
    h.r.advance(100);
    p.say({ type: 'drive', vehicleId: 'HT-05', throttle: 0.9, n: 9 });
    assert.deepEqual(h.drives().map((m) => m.throttle), [0.2]);

    // 20 Hz: 50 inputs in 1 s, 10 ms apart, relay at most rate + burst.
    const before = h.drives().length;
    for (let i = 0; i < 50; i++) { p.say({ type: 'drive', vehicleId: 'HT-05', throttle: 0.3, n: 11 + i }); h.r.clock.advance(20); }
    const relayed = h.drives().length - before;
    assert.ok(relayed <= PARAMS.driveRelayMaxRate.value + PARAMS.driveRelayBurst.value, `relayed ${relayed}`);
    assert.ok(relayed >= PARAMS.driveRelayMaxRate.value - 1, `relayed ${relayed}`);
    assert.ok(h.view('HT-05')!.dropped >= 50 - relayed);

    // Link down: input is dropped, said so, and nothing is sent when the link returns.
    h.r.dialer.mode = 'outage';
    h.r.dialer.dropAll();
    h.r.advance(200);
    assert.equal(h.r.link.isUp(), false);
    const atDrop = h.drives().length;
    for (let i = 0; i < 5; i++) { const res = p.say({ type: 'drive', vehicleId: 'HT-05', throttle: 1, n: 100 + i }); assert.equal(res?.drive.code, 'LINK_DOWN'); h.r.advance(100); }
    h.r.dialer.mode = 'normal';
    assert.ok(h.r.until(() => h.r.link.isUp(), 15_000) >= 0);
    h.r.advance(1_000);
    assert.equal(h.drives().length, atDrop, 'nothing queued across the drop');
  } finally { h.done(); }
});

test('L7.2 lag: input age is time since the service last relayed input; echo age is a round trip, correct against an injected delay', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-06', positionM: 300, state: 'HOLDING' }] });
  try {
    // 300 ms more on the way up for drive messages only.
    const UP = 300;
    const sendDrive = h.r.link.sendDrive.bind(h.r.link);
    h.r.link.sendDrive = (m) => { if (!h.r.link.isUp()) return false; h.r.clock.setTimeout(() => sendDrive(m), UP); return true; };
    const p = h.open(PRIYA);
    h.take(p, 'HT-06');
    h.stream(p, 'HT-06', 0.4, 3_000);
    const v = h.view('HT-06')!;
    // Telemetry is sampled at 5 Hz: a round trip is the delay plus up to 200 ms of sampling (plus the
    // rig's 50 ms steps).
    assert.ok(v.echo.stats.samples > 5, JSON.stringify(v.echo.stats));
    assert.ok(v.echo.stats.p50Ms! >= UP && v.echo.stats.maxMs! <= UP + 200 + 100, JSON.stringify(v.echo.stats));
    assert.equal(v.inputAgeMs, 100, 'the stream waits 100 ms after its last input');
    h.r.clock.advance(400);
    assert.equal(h.view('HT-06')!.inputAgeMs, 500);
    const echo = h.view('HT-06')!.echo;
    // The newest input the truck can have applied was sent 500 ms ago: the echo age can't be less, and
    // keeps counting while nothing new is applied.
    assert.ok(echo.ageMs! >= 500, `echo age ${echo.ageMs}`);
    h.r.advance(1_000);
    assert.ok(h.view('HT-06')!.echo.ageMs! >= 1_500, 'counts on');
  } finally { h.done(); }
});

test('L7.6 never into a closed zone: forward input becomes a stop before the boundary, and says so; reverse, away from it, is relayed', () => {
  const h = rig({
    trucks: [{ vehicle_id: 'HT-07', positionM: 40, state: 'HOLDING' }, { vehicle_id: 'HT-08', positionM: 200, state: 'HOLDING' }],
    blasts: [{ zoneId: 'DECLINE', atMs: 0, noticeMs: 500, closedForMs: 3_600_000 }],
  });
  try {
    h.r.advance(1_000);
    assert.equal(h.r.fleet.snapshot().zones.find((z) => z.zoneId === 'DECLINE')!.status, 'CLOSED');
    const p = h.open(PRIYA);
    h.take(p, 'HT-07');
    const replies = h.stream(p, 'HT-07', 1, 15_000);
    const t = h.r.gw.truth('HT-07');
    assert.ok(t.positionM < 80, `never crossed into the closed zone: at ${t.positionM}`);
    assert.ok(t.positionM > 55, `got close, as allowed: at ${t.positionM}`);
    assert.ok(replies.some((r) => r.drive?.code === 'ZONE_CLOSED'), 'the screen was told');
    assert.match(replies.find((r) => r.drive?.code === 'ZONE_CLOSED')!.error, /^Stopped: DECLINE is CLOSED, \d+ m ahead\. Driving forward into it is refused; you can drive the other way\.$/);
    const last = h.drives().at(-1)!;
    assert.equal(last.throttle, 0, 'the refused input went out as a stop');
    assert.equal(h.view('HT-07')!.refusal?.code, 'ZONE_CLOSED');
    assert.ok(h.r.store.auditLog('HT-07').some((a) => a.event === 'drive_refused' && a.actor === 'priya'));

    // Reverse, away from it: relayed as asked.
    const at = t.positionM;
    const back = h.stream(p, 'HT-07', -0.5, 2_000);
    assert.equal(back.length, 0);
    assert.equal(h.drives().at(-1)!.throttle, -0.5);
    assert.ok(h.r.gw.truth('HT-07').positionM < at - 2);

    // Inside the closed zone: both ways out are relayed (CONTEXT.md assumption 10).
    h.take(p, 'HT-08');
    assert.equal(h.stream(p, 'HT-08', 1, 1_000).length, 0);
    assert.equal(h.drives().at(-1)!.throttle, 1);
    assert.equal(h.stream(p, 'HT-08', -1, 1_000).length, 0);
    assert.equal(h.drives().at(-1)!.throttle, -1);
  } finally { h.done(); }
});

test('L7.6 the check, table: CLOSING it can get through is allowed, CLOSING it can\'t is refused; frozen and unknown positions are refused', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-09', positionM: 70, state: 'HOLDING' }] });
  try {
    const site = h.r.fleet.site!;
    const truck = h.r.fleet.truck('HT-09')!;
    const now = h.r.fleet.serverNow();
    const zones = (status: 'OPEN' | 'CLOSING' | 'CLOSED' | null, leftMs: number | null) => h.r.fleet.snapshot().zones.map((z) => z.zoneId === 'DECLINE' ? { ...z, status, effectiveAtMs: leftMs === null ? null : now + leftMs } : z);
    const check = (zs: ReturnType<typeof zones>, throttle: number, t = truck) => checkDrive({ site, zones: zs, truck: t, throttle, nowServerMs: now });
    assert.deepEqual(check(zones('OPEN', null), 1), { allow: true });
    assert.equal((check(zones('CLOSED', null), 1) as any).code, 'ZONE_CLOSED');
    assert.equal((check(zones(null, null), 1) as any).code, 'ZONE_CLOSED', 'unknown is never read as open');
    assert.deepEqual(check(zones('CLOSED', null), -1), { allow: true }, 'the other way');
    assert.deepEqual(check(zones('CLOSED', null), 0), { allow: true }, 'a stop is always relayed');
    // DECLINE is 500 m: at 4 m/s from 10 m out, about 128 s through.
    assert.deepEqual(check(zones('CLOSING', 200_000), 1), { allow: true });
    assert.equal((check(zones('CLOSING', 60_000), 1) as any).code, 'CANT_CLEAR');
    const near = { ...truck, position: { ...truck.position!, value: { ...truck.position!.value, loopM: 78 } } };
    assert.deepEqual(check(zones('CLOSING', 200_000), 1, near), { allow: true });
    assert.equal((check(zones('CLOSING', 200_000), 0.25, near) as any).code, 'CANT_CLEAR', 'slower: can\'t get through');
    assert.equal((check(zones('CLOSED', null), 1, { ...truck, confidence: 'contradicted' }) as any).code, 'DATA_FROZEN');
    assert.equal((check(zones('OPEN', null), 1, { ...truck, position: null, confidence: 'unknown' }) as any).code, 'POSITION_UNKNOWN');
    // Boundaries in each direction, with the zone beyond.
    assert.deepEqual(boundaries(site, zones('CLOSED', null), 70, 'FWD', 600).map((b) => [b.zoneId, Math.round(b.distanceM), b.status]), [['DECLINE', 10, 'CLOSED'], ['L4_NORTH', 510, 'OPEN']]);
    assert.deepEqual(boundaries(site, zones('OPEN', null), 70, 'REV', 100).map((b) => [b.zoneId, Math.round(b.distanceM)]), [['TIP', 70]]);
  } finally { h.done(); }
});

test('L7.3 forced takeover mid-drive: the first driver is told who took it, and their input is refused from then on', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-10', positionM: 300, state: 'HOLDING' }] });
  try {
    const p = h.open(PRIYA);
    const m = h.open(MARTA);
    h.take(p, 'HT-10');
    h.stream(p, 'HT-10', 0.5, 1_000);
    h.take(m, 'HT-10', true);
    const before = h.drives().length;
    const res = p.drive('HT-10', 0.5);
    assert.equal(res?.drive.code, 'NOT_YOURS');
    assert.match(res!.error, /^marta took control of HT-10 from you\. Your input was not sent\.$/);
    assert.equal(h.drives().length, before);
    const end = h.hub.state().leaseEnds['HT-10']!;
    assert.deepEqual([end.operatorId, end.reason, end.by], ['priya', 'FORCED_TAKEOVER', 'marta']);
    // Marta drives it.
    assert.equal(h.stream(m, 'HT-10', 0.5, 500).length, 0);
    assert.equal(h.drives().at(-1)!.lease_id, h.r.registry.lease('HT-10')!.leaseId);
  } finally { h.done(); }
});

test('L7.4 e-stop wins while someone else drives: the truck stops, the lease ends, the driver\'s input is refused', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-11', positionM: 300, state: 'HOLDING' }] });
  try {
    const p = h.open(PRIYA);
    const d = h.open(DAVE);
    h.take(p, 'HT-11');
    h.stream(p, 'HT-11', 1, 1_000);
    assert.equal(d.say({ type: 'command', action: 'ESTOP', vehicleId: 'HT-11' })?.ok, true);
    const replies = h.stream(p, 'HT-11', 1, 1_000);
    assert.equal(h.r.gw.truth('HT-11').state, 'ESTOPPED');
    assert.equal(h.r.gw.truth('HT-11').speedMps, 0);
    assert.ok(replies.length > 0 && replies.every((r) => r.drive.code === 'NO_LEASE'));
    assert.match(replies[0]!.error, /HT-11 was e-stopped by dave; your control ended/);
  } finally { h.done(); }
});

test('L7.7 limp-home: a truck with HYD_PRESSURE_LOW drives at no more than 1.0 m/s and says so; BATTERY_DEPLETED cannot be taken', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-12', positionM: 300, state: 'HOLDING' }, { vehicle_id: 'HT-01', positionM: 500, state: 'HOLDING' }] });
  try {
    h.r.gw.injectFault('HT-12', 'HYD_PRESSURE_LOW');
    h.r.advance(500);
    const p = h.open(PRIYA);
    h.take(p, 'HT-12');
    h.stream(p, 'HT-12', 1, 2_000);
    assert.equal(h.r.gw.truth('HT-12').speedMps, 1.0);
    const v = h.view('HT-12')!;
    assert.deepEqual([v.limp, v.topSpeedMps], [true, 1.0]);

    h.r.gw.model.deplete('HT-01');
    h.r.advance(500);
    p.say({ type: 'command', action: 'TAKE_CONTROL', vehicleId: 'HT-01' });
    h.r.advance(2_000);
    assert.equal(h.r.registry.lease('HT-01'), undefined);
    const rec = h.r.registry.list({ vehicleId: 'HT-01' }).at(-1)!;
    assert.equal(rec.failure?.code, 'INTERLOCK_ACTIVE');
  } finally { h.done(); }
});
