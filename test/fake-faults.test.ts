// TESTING.md L0.F (fault injectors) and L0.P (pessimistic versions) for the fake gateway. Each
// injector is switchable, seeded, and recorded in the truth log with the truck, the time and what.
// Shapes are the live ones (research/fixtures/, research/README.md); rates are checked loosely here
// and against the live statistics in test/fake-conformance.test.ts (L0.C3).
// Positions and names are DLH-1's (fake/dlh1.ts), as in test/fake-model.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import type { CommandAck, Telemetry } from '../src/protocol.ts';
import { DEFAULT_BEHAVIOUR, PESSIMISTIC_VERSION, SPEC_VERSION } from '../fake/behaviour.ts';
import { LIVE_DAY, planTrucks, TruthLog, type Faults } from '../fake/faults.ts';
import { FakeGateway } from '../fake/gateway.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { toWire } from '../fake/wire.ts';
import { harness, T0 } from './fake-helpers.ts';

const AUTH = (email = 'tester@example.com') => ({ type: 'auth', email });
const body = (t: Telemetry) => { const { seq: _s, t_device_ms: _d, ...rest } = t; return JSON.stringify(rest); };
const pct = (n: number, d: number) => (100 * n) / d;

// ---- the truth log ----

test('truth log: intervals and one-off events, queried by time, truck and class; copies only', () => {
  const log = new TruthLog();
  const e = log.start(100, 'A', 'frozen_moving', { x: 1 });
  log.event(150, 'B', 'lost', { seq: 9 });
  const s = log.start(120, 'A', 'silent');
  s.untilMs = 140;
  assert.deepEqual(log.activeAt(130).map((x) => x.fault), ['frozen_moving', 'silent']);
  assert.deepEqual(log.activeAt(150).map((x) => x.fault), ['frozen_moving', 'lost']);
  assert.deepEqual(log.activeAt(151, { vehicle: 'A' }).map((x) => x.fault), ['frozen_moving']);
  assert.equal(log.activeAt(99).length, 0);
  log.entries()[0]!.detail.x = 2;
  assert.equal(log.entries()[0]!.detail.x, 1);
  assert.equal(e.untilMs, null);
});

test('LIVE_DAY puts each per-truck fault on a different truck, from the seed', () => {
  const plan = planTrucks(LIVE_DAY, DLH1.vehicles, DEFAULT_BEHAVIOUR, 5);
  const trucks = Object.values(plan).map((p) => p.vehicle);
  assert.equal(trucks.length, 8);
  assert.equal(new Set(trucks).size, 8, 'one truck per class');
  assert.deepEqual(planTrucks(LIVE_DAY, DLH1.vehicles, DEFAULT_BEHAVIOUR, 5), plan, 'same seed, same plan');
  assert.notDeepEqual(planTrucks(LIVE_DAY, DLH1.vehicles, DEFAULT_BEHAVIOUR, 6), plan);
  // switching one injector on does not move another's truck or time
  const more = planTrucks({ ...LIVE_DAY, frozenStationary: true }, DLH1.vehicles, DEFAULT_BEHAVIOUR, 5);
  assert.deepEqual(more.silent, plan.silent);
  // a pinned truck is used, and kept out of the random deal
  const pinned = planTrucks({ silent: { vehicle: 'HT-07', atMs: 1_000 }, frozenMoving: true }, DLH1.vehicles, DEFAULT_BEHAVIOUR, 5);
  assert.deepEqual(pinned.silent, { vehicle: 'HT-07', atMs: 1_000 });
  assert.notEqual(pinned.frozenMoving!.vehicle, 'HT-07');
});

// ---- the wire ----

test('lines are written as the live gateway writes them: ", " and ": ", floats keep ".0"', () => {
  const h = harness({ trucks: [{ vehicle_id: 'HT-01', positionM: 100, loaded: false, socPct: 80 }] });
  h.advance(2_000);
  const hello = h.client.lines[0]!;
  assert.ok(hello.startsWith('{"type": "hello", "protocol": "3.0", '), hello.slice(0, 60));
  assert.ok(hello.includes('"length_m": 80.0, "kind": "bay", "start_m": 0.0}'), 'route lengths are floats');
  assert.ok(hello.includes('"loop_length_m": 1600.0'));
  const line = h.client.lines.find((l) => l.includes('"vehicle_id": "HT-01"'))!;
  assert.match(line, /"seq": \d+, "t_device_ms": \d+, /);
  assert.match(line, /"speed_mps": 3\.0, /);
  assert.match(line, /"payload_kg": 0\.0, /);
  assert.equal(toWire({ soc_pct: 61.5, offset_m: 12, seq: 3, server_time_ms: 5, x: [1, 2] }), '{"soc_pct": 61.5, "offset_m": 12.0, "seq": 3, "server_time_ms": 5, "x": [1, 2]}');
  const hb = h.client.lines.find((l) => l.includes('heartbeat'))!;
  assert.equal(hb, `{"type": "heartbeat", "server_time_ms": ${T0 + 2_000}}`);
});

// ---- radio: loss, duplicates, reordering, truncation ----

function radioDay(faults: Faults, ms = 300_000) {
  const h = harness({ seed: 21, faults });
  h.advance(ms);
  return h;
}

test('loss: about 2.8 % of telemetry never arrives, each one in the truth log by truck and seq', () => {
  const h = radioDay({ loss: true });
  const lost = h.gw.truthLog.entries({ fault: 'lost' });
  let sent = 0, missing = 0;
  for (const v of DLH1.vehicles) {
    const seqs = h.telemetry(v).map((t) => t.seq);
    const max = Math.max(...seqs);
    sent += max;
    const got = new Set(seqs);
    const gone = Array.from({ length: max }, (_, i) => i + 1).filter((s) => !got.has(s));
    missing += gone.length;
    assert.deepEqual(gone, lost.filter((e) => e.vehicle === v && (e.detail.seq as number) <= max).map((e) => e.detail.seq), v);
  }
  assert.ok(pct(missing, sent) > 2 && pct(missing, sent) < 3.6, `${pct(missing, sent).toFixed(2)} % lost`);
});

test('duplicates: about 2 %, byte-identical, the copy up to 0.9 s after the first', () => {
  const h = radioDay({ duplicates: true });
  const lines = h.client.lines.filter((l) => l.includes('"telemetry"'));
  const seen = new Map<string, number>();
  let dups = 0;
  for (const [i, l] of lines.entries()) {
    if (seen.has(l)) dups++;
    else seen.set(l, i);
  }
  assert.ok(pct(dups, lines.length) > 1.5 && pct(dups, lines.length) < 2.6, `${pct(dups, lines.length).toFixed(2)} %`);
  const logged = h.gw.truthLog.entries({ fault: 'duplicate' });
  assert.equal(logged.length, dups);
  assert.ok(logged.every((e) => (e.detail.afterMs as number) >= 0 && (e.detail.afterMs as number) <= 900));
});

test('reordering: about 5 % arrive late, behind a higher seq, by up to 1.7 s', () => {
  const h = radioDay({ reordering: true });
  let behind = 0, total = 0;
  for (const v of DLH1.vehicles) {
    let max = 0;
    for (const t of h.telemetry(v)) { total++; if (t.seq < max) behind++; max = Math.max(max, t.seq); }
  }
  assert.ok(pct(behind, total) > 4 && pct(behind, total) < 6, `${pct(behind, total).toFixed(2)} % behind`);
  const late = h.gw.truthLog.entries({ fault: 'late' });
  assert.ok(late.every((e) => (e.detail.byMs as number) >= 250 && (e.detail.byMs as number) <= 1_700));
  assert.ok(Math.abs(late.length - behind) <= late.length * 0.05, `${late.length} late, ${behind} seen behind`);
});

test('truncation: about 0.19 % of lines, always telemetry cut mid-object after 193-209 characters', () => {
  const h = radioDay({ truncation: true }, 600_000);
  const cut = h.client.unparseable;
  assert.ok(pct(cut.length, h.client.lines.length) > 0.1 && pct(cut.length, h.client.lines.length) < 0.3, `${cut.length} of ${h.client.lines.length}`);
  for (const l of cut) {
    assert.ok(l.startsWith('{"type": "telemetry", "vehicle_id": '), l);
    assert.ok(l.length >= 193 && l.length <= 209, `${l.length} chars`);
  }
  assert.equal(h.gw.truthLog.entries({ fault: 'truncated' }).length, cut.length);
});

// ---- acks ----

test('ack latency: acks arrive 150 ms to 2.6 s after the command, stamped with when the gateway got it; lease events at once', () => {
  const h = harness({ faults: { ackLatency: true }, trucks: [{ vehicle_id: 'HT-04', positionM: 300, loaded: false, socPct: 80 }] });
  const delays: number[] = [];
  for (let i = 0; i < 60; i++) {
    const sentAt = h.clock.now();
    h.sendCommand({ command_id: `lat-${i}`, vehicle_id: 'HT-01', action: i % 2 ? 'RESUME' : 'HOLD', operator_id: 'op' });
    assert.equal(h.messages('command_ack').filter((a) => a.command_id === `lat-${i}`).length, 0, 'not at once');
    let ack: CommandAck | undefined;
    while (!ack) { h.advance(10); ack = h.messages('command_ack').find((a) => a.command_id === `lat-${i}`); }
    assert.equal(ack.server_time_ms, sentAt, 'stamped on receipt');
    delays.push(h.clock.now() - sentAt);
    h.advance(3_000);
  }
  delays.sort((a, b) => a - b);
  assert.ok(delays[0]! >= 150 && delays.at(-1)! <= 2_610, `${delays[0]}..${delays.at(-1)}`);
  const median = delays[30]!;
  assert.ok(median > 350 && median < 1_100, `median ${median} (live ~570)`);

  // the gateway's own rejections come back quickly
  const t0 = h.clock.now();
  h.client.send('{"type":"command", nope');
  while (!h.messages('command_ack').some((a) => a.command_id === '<unparseable>')) h.advance(10);
  assert.ok(h.clock.now() - t0 >= 50 && h.clock.now() - t0 <= 160);

  // lease events are the gateway's, not the vehicle's: GRANTED arrives before the ack (live 103 vs 310 ms)
  h.sendCommand({ command_id: 'take', vehicle_id: 'HT-04', action: 'TAKE_CONTROL', operator_id: 'op' });
  assert.equal(h.messages('lease_event').at(-1)?.event, 'GRANTED');
  assert.equal(h.messages('command_ack').filter((a) => a.command_id === 'take').length, 0);
});

test('lost ack: the command still executes; resending the same command_id gets the original result', () => {
  const h = harness({ faults: { lostAcks: (c) => c.n === 1 }, trucks: [{ vehicle_id: 'HT-01', positionM: 300, loaded: false, socPct: 80 }] });
  assert.equal(h.sendCommand({ command_id: 'h1', vehicle_id: 'HT-01', action: 'HOLD', operator_id: 'op' }), undefined);
  assert.ok(h.until('HT-01', (t) => t.state === 'HOLDING', 6_100) >= 0, 'executed without an ack');
  const again = h.sendCommand({ command_id: 'h1', vehicle_id: 'HT-01', action: 'HOLD', operator_id: 'op' });
  assert.equal(again?.status, 'ACCEPTED');
  const lost = h.gw.truthLog.entries({ fault: 'lost_ack' });
  assert.equal(lost.length, 1);
  assert.equal(lost[0]!.detail.command_id, 'h1');
  assert.equal(lost[0]!.vehicle, 'HT-01');
});

test('lost ack at the measured rate: about 1 in 25', () => {
  const h = harness({ faults: { lostAcks: true } });
  for (let i = 0; i < 1_000; i++) h.sendCommand({ command_id: `x${i}`, vehicle_id: 'HT-99', action: 'HOLD', operator_id: 'op' });
  const got = h.messages('command_ack').length;
  assert.ok(1_000 - got > 25 && 1_000 - got < 60, `${1_000 - got} lost`);
  assert.equal(h.gw.truthLog.entries({ fault: 'lost_ack' }).length, 1_000 - got);
});

test('accepted then ignored: RESUME ACCEPTED, the truck stays HOLDING; a RESUME under a new id moves it (fixture)', () => {
  const h = harness({
    faults: { ignoredCommands: (c) => c.action === 'RESUME' && c.command_id === 'r1' },
    trucks: [{ vehicle_id: 'HT-02', positionM: 900, loaded: true, socPct: 60 }],
  });
  h.command('HT-02', 'HOLD');
  assert.ok(h.until('HT-02', (t) => t.state === 'HOLDING', 6_100) >= 0);
  assert.equal(h.sendCommand({ command_id: 'r1', vehicle_id: 'HT-02', action: 'RESUME', operator_id: 'op' })?.status, 'ACCEPTED');
  h.advance(70_000);
  assert.equal(h.latest('HT-02').state, 'HOLDING');
  assert.deepEqual(h.gw.truth('HT-02').pending, []);
  const ign = h.gw.truthLog.entries({ fault: 'accepted_ignored' });
  assert.equal(ign.length, 1);
  assert.deepEqual([ign[0]!.vehicle, ign[0]!.detail.command_id, ign[0]!.detail.action], ['HT-02', 'r1', 'RESUME']);
  h.sendCommand({ command_id: 'r2', vehicle_id: 'HT-02', action: 'RESUME', operator_id: 'op' });
  assert.ok(h.until('HT-02', (t) => t.state === 'TRAMMING' && t.speed_mps > 0, 6_100) >= 0);
});

test('accepted then ignored at the measured rate, any supervisory command, never a rejection', () => {
  const h = harness({ faults: { ignoredCommands: true } });
  for (let i = 0; i < 300; i++) h.sendCommand({ command_id: `i${i}`, vehicle_id: DLH1.vehicles[i % 12], action: 'HOLD', operator_id: 'op' });
  const n = h.gw.truthLog.entries({ fault: 'accepted_ignored' }).length;
  assert.ok(n > 15 && n < 55, `${n} of 300 ignored (1 in 9 measured once)`);
});

// ---- link drops ----

test('link drop: every client is cut off; logins during it are accepted then closed before hello; nothing is queued', () => {
  const h = harness({ faults: { linkDrops: [{ atMs: 10_000, durationMs: 30_000 }] } });
  h.advance(9_950);
  assert.ok(!h.client.closed);
  h.advance(100);
  assert.ok(h.client.closed, 'cut off at 10 s');
  assert.equal(h.gw.linkUp, false);
  const during = h.gw.connect();
  during.send(AUTH());
  assert.ok(during.closed);
  assert.deepEqual(during.lines, [], 'no hello, no auth_error');
  h.advance(29_850);
  const early = h.gw.connect();
  early.send(AUTH());
  assert.ok(early.closed, 'still down at 39.9 s');
  h.advance(100);
  const after = h.gw.connect();
  after.send(AUTH());
  assert.equal(after.messages()[0]?.type, 'hello');
  assert.equal(after.lines.length, 1, 'nothing from the outage replayed');
  const [e] = h.gw.truthLog.entries({ fault: 'link_drop' });
  assert.deepEqual([e!.atMs - T0, e!.untilMs! - T0], [10_000, 40_000]);
});

test('link drops at random: the first lands in a blast notice, later ones every ~8 minutes, 15-42 s long', () => {
  let inNotice = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const h = harness({ seed, blasts: 'random', faults: { linkDrops: true } });
    h.advance(1_800_000);
    const drops = h.gw.truthLog.entries({ fault: 'link_drop' });
    assert.ok(drops.length >= 3, `seed ${seed}: ${drops.length} drops in 30 minutes`);
    for (const d of drops) {
      const len = d.untilMs! - d.atMs;
      assert.ok(len >= 15_000 && len <= 42_000, `drop of ${len} ms`);
    }
    for (let i = 1; i < drops.length; i++) {
      const gap = drops[i]!.atMs - drops[i - 1]!.atMs;
      assert.ok(gap >= 460_000 && gap <= 530_000, `spacing ${gap}`);
    }
    // the first drop starts 0-20 s after a CLOSING (which the client saw before it was cut off), at least 5 minutes in
    const first = drops[0]!;
    assert.ok(first.atMs - T0 >= 300_000);
    const closing = h.messages('zone_event').filter((e) => e.status === 'CLOSING').at(-1)!;
    const into = first.atMs - closing.server_time_ms;
    if (into >= 0 && into <= 20_000 && first.atMs < closing.effective_at_ms!) inNotice++;
  }
  assert.equal(inNotice, 5, 'every first drop lands in a notice');
});

// ---- per-truck telemetry faults ----

test('frozen while moving: the whole message repeats with seq and the device clock advancing; the truck really moves on', () => {
  const h = harness({ faults: { frozenMoving: { vehicle: 'HT-03', atMs: 5_000 } }, trucks: [{ vehicle_id: 'HT-03', positionM: 300, loaded: false, socPct: 80 }] });
  h.advance(5_000);
  h.advance(60_000);
  const after = h.telemetry('HT-03').filter((t) => t.t_device_ms >= T0 + 5_200);
  assert.ok(after.length > 250);
  assert.equal(new Set(after.map(body)).size, 1, 'one body, repeated');
  for (let i = 1; i < after.length; i++) {
    assert.equal(after[i]!.seq, after[i - 1]!.seq + 1);
    assert.equal(after[i]!.t_device_ms - after[i - 1]!.t_device_ms, 200);
  }
  assert.equal(after[0]!.state, 'TRAMMING');
  assert.equal(after[0]!.speed_mps, 3, 'reports motion');
  assert.ok(h.gw.truth('HT-03').positionM > 300 + 3 * 60 - 1, 'the truth moved on');
  const [e] = h.gw.truthLog.entries({ fault: 'frozen_moving' });
  assert.equal(e!.vehicle, 'HT-03');
  assert.equal(e!.untilMs, null, 'frozen to the end of the day, as live');
  assert.equal((e!.detail.reported as { speed_mps: number }).speed_mps, 3);
  assert.equal(h.gw.truthLog.activeAt(T0 + 30_000, { vehicle: 'HT-03' })[0]?.fault, 'frozen_moving');
});

test('frozen while stationary, then it moves: telemetry says LOADING at 0 m/s while the truck drives off (L4.R2c)', () => {
  const h = harness({ faults: { frozenStationary: { vehicle: 'HT-01', atMs: 0 } }, trucks: [{ vehicle_id: 'HT-01', positionM: 835, loaded: false, socPct: 80 }] });
  h.advance(120_000);
  const truth = h.gw.truth('HT-01');
  assert.equal(truth.state, 'TRAMMING');
  assert.ok(truth.positionM > 900, `really at ${truth.positionM}`);
  const last = h.latest('HT-01');
  assert.equal(last.state, 'LOADING');
  assert.equal(last.speed_mps, 0);
  assert.equal(last.offset_m, 59.95);
  const [e] = h.gw.truthLog.entries({ fault: 'frozen_stationary' });
  assert.equal(e!.vehicle, 'HT-01');
});

test('silent truck: nothing for 24-55 s at a time, seq not advancing across it, heartbeats carry on; repeats', () => {
  const h = harness({ faults: { silent: { vehicle: 'HT-05', atMs: 10_000 } } });
  h.advance(600_000);
  const ts = h.telemetry('HT-05');
  const gaps: Array<[number, number]> = [];
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i]!.t_device_ms - ts[i - 1]!.t_device_ms;
    if (gap > 200) { gaps.push([ts[i - 1]!.t_device_ms, gap]); assert.equal(ts[i]!.seq, ts[i - 1]!.seq + 1, 'seq carries on from where it stopped'); }
  }
  assert.ok(gaps.length >= 3, `${gaps.length} silences in 10 minutes`);
  for (const [, g] of gaps) assert.ok(g >= 24_000 && g <= 55_200, `silent ${g} ms`);
  assert.ok(gaps[0]![0] - T0 >= 9_800 && gaps[0]![0] - T0 < 10_000, 'first silence from 10 s');
  const log = h.gw.truthLog.entries({ fault: 'silent', vehicle: 'HT-05' });
  assert.ok(log.length >= gaps.length);
  assert.equal(log[0]!.atMs, T0 + 10_000);
  const hb = h.messages('heartbeat');
  assert.equal(hb.length, 300, 'the link stayed up');
});

test('seq reset: seq drops to 1 while the device clock carries on (fixture seq-reset)', () => {
  const h = harness({ faults: { seqReset: { vehicle: 'HT-01', atMs: 100_000 } } });
  h.advance(120_000);
  const ts = h.telemetry('HT-01');
  const i = ts.findIndex((t, k) => k > 0 && t.seq < ts[k - 1]!.seq);
  assert.ok(i > 0);
  assert.ok(ts[i - 1]!.seq >= 490 && ts[i - 1]!.seq <= 500, `${ts[i - 1]!.seq} at 100 s`);
  assert.equal(ts[i]!.seq, 1);
  assert.equal(ts[i + 1]!.seq, 2);
  assert.equal(ts[i]!.t_device_ms - ts[i - 1]!.t_device_ms, 200);
  const [e] = h.gw.truthLog.entries({ fault: 'seq_reset' });
  assert.equal(e!.detail.fromSeq, ts[i - 1]!.seq);
  assert.equal(e!.atMs, ts[i]!.t_device_ms);
});

test('fractional SoC: soc_pct / 100 with 4 decimals, all day (fixture fractional-soc)', () => {
  const h = harness({ faults: { fractionalSoc: { vehicle: 'HT-12' } }, trucks: [{ vehicle_id: 'HT-12', positionM: 500, loaded: false, socPct: 82.01 }] });
  h.advance(10_000);
  const ts = h.telemetry('HT-12');
  assert.equal(ts[0]!.soc_pct, 0.8201);
  assert.ok(ts.every((t) => t.soc_pct <= 1));
  assert.ok(Math.abs(ts.at(-1)!.soc_pct * 100 - h.gw.truth('HT-12').socPct) < 0.01);
  assert.ok(h.telemetry('HT-01').every((t) => t.soc_pct > 1));
});

test('malformed fields: lowercase state, null speed, missing SoC, offset as a string, each in ~2 % of one truck\'s messages', () => {
  const h = harness({ faults: { malformed: { vehicle: 'HT-02' } } });
  h.advance(600_000);
  const lines = h.client.lines.filter((l) => l.includes('"vehicle_id": "HT-02"'));
  const ts = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const n = ts.length;
  const lower = ts.filter((t) => typeof t.state === 'string' && t.state !== (t.state as string).toUpperCase()).length;
  const nullSpeed = ts.filter((t) => t.speed_mps === null).length;
  const noSoc = ts.filter((t) => !('soc_pct' in t)).length;
  const strOffset = ts.filter((t) => typeof t.offset_m === 'string').length;
  for (const [what, k] of [['lowercase state', lower], ['null speed', nullSpeed], ['missing soc', noSoc], ['string offset', strOffset]] as const) {
    assert.ok(pct(k, n) > 1.2 && pct(k, n) < 2.8, `${what}: ${pct(k, n).toFixed(2)} %`);
  }
  const s = ts.find((t) => typeof t.offset_m === 'string')!;
  assert.match(s.offset_m as string, /^\d+\.\d+$/, 'as Python writes a float: "59.95", "20.5", "59.0"');
  assert.ok(lines.some((l) => l.includes('"speed_mps": null')));
  assert.equal(h.gw.truthLog.entries({ fault: 'malformed' }).filter((e) => e.untilMs !== null).length,
    ts.filter((t) => typeof t.state === 'string' && t.state !== (t.state as string).toUpperCase() || t.speed_mps === null || !('soc_pct' in t) || typeof t.offset_m === 'string').length);
  for (const v of DLH1.vehicles.filter((x) => x !== 'HT-02')) assert.ok(h.telemetry(v).every((t) => typeof t.offset_m === 'number' && t.speed_mps !== null));
});

test('clock skew: one controller about 58 minutes ahead, the others within 3.3 s', () => {
  const h = harness({ faults: { clockSkew: { vehicle: 'HT-08' } } });
  h.advance(2_000);
  for (const v of DLH1.vehicles) {
    const t = h.latest(v);
    const skew = t.t_device_ms - h.clock.now();
    if (v === 'HT-08') assert.ok(skew >= 3_475_000 && skew <= 3_484_000, `${v} ${skew}`);
    else assert.ok(Math.abs(skew) <= 3_300 + 200, `${v} ${skew}`);
  }
  assert.equal(h.gw.truthLog.entries({ fault: 'clock_skew' })[0]!.vehicle, 'HT-08');
});

// ---- truck faults ----

test('weak pack: drains about 5x the fleet and dies with BATTERY_DEPLETED loaded in the incline (fixture weak-pack)', () => {
  for (const seed of [1, 2, 3]) {
    const h = harness({ seed, faults: { weakPack: true }, blasts: 'none' });
    const [wp] = h.gw.truthLog.entries({ fault: 'weak_pack' });
    const v = wp!.vehicle!;
    const factor = wp!.detail.factor as number;
    assert.ok(factor >= 5 && factor <= 5.2);
    h.advance(1_200_000);
    const [dead] = h.gw.truthLog.entries({ fault: 'fault', vehicle: v });
    assert.ok(dead, `seed ${seed}: ${v} never died`);
    assert.equal(dead!.detail.code, 'BATTERY_DEPLETED');
    assert.equal(dead!.detail.zoneId, 'INCLINE', `seed ${seed}: died in ${String(dead!.detail.zoneId)}`);
    const last = h.latest(v);
    assert.equal(last.state, 'FAULT');
    assert.deepEqual(last.faults, ['BATTERY_DEPLETED']);
    assert.equal(last.payload_kg, 42_000, 'loaded');
  }
});

test('HYD_PRESSURE_LOW at 280-340 s; BATTERY_DEPLETED on its own; both in the truth log with where', () => {
  const h = harness({ seed: 9, faults: { hydPressureLow: true, batteryDepleted: { vehicle: 'HT-04', atMs: 30_000 } } });
  h.advance(400_000);
  const faults = h.gw.truthLog.entries({ fault: 'fault' });
  const hyd = faults.find((e) => e.detail.code === 'HYD_PRESSURE_LOW')!;
  assert.ok(hyd.atMs - T0 >= 280_000 && hyd.atMs - T0 <= 340_000);
  assert.deepEqual(h.latest(hyd.vehicle!).faults, ['HYD_PRESSURE_LOW']);
  const dep = faults.find((e) => e.detail.code === 'BATTERY_DEPLETED')!;
  assert.deepEqual([dep.vehicle, dep.atMs - T0], ['HT-04', 30_000]);
  assert.equal(h.latest('HT-04').state, 'FAULT');
  assert.equal(h.latest('HT-04').soc_pct, 0);
  assert.equal(typeof dep.detail.zoneId, 'string');
});

// ---- blasts ----

test('two zones closing at once, and cancelled blasts: switchable, and in the truth log', () => {
  const h = harness({ seed: 4, blasts: 'random', behaviour: { secondZoneProbability: 1, cancelProbability: 1 } });
  h.advance(900_000);
  const closing = h.messages('zone_event').filter((e) => e.status === 'CLOSING');
  assert.ok(closing.length >= 4);
  assert.ok(h.messages('zone_event').filter((e) => e.status === 'OPEN').every((e) => e.reason === 'CANCELLED'));
  assert.equal(h.gw.truthLog.entries({ fault: 'cancelled_blast' }).length, closing.length);
  assert.ok(h.gw.truthLog.entries({ fault: 'two_zones' }).length >= 2);
  const none = harness({ seed: 4, blasts: 'random', behaviour: { secondZoneProbability: 0, cancelProbability: 0 } });
  none.advance(900_000);
  assert.equal(none.gw.truthLog.entries({ fault: 'two_zones' }).length, 0);
  assert.ok(none.messages('zone_event').every((e) => e.reason !== 'CANCELLED'));
});

test('BAY closing (open question 5): off by default; switched on, the bay is blasted like any zone', () => {
  const on = harness({ seed: 3, blasts: 'random', faults: { bayClosing: true } });
  on.advance(7_200_000);
  assert.ok(on.messages('zone_event').some((e) => e.zone_id === 'BAY' && e.status === 'CLOSED'));
  assert.ok(on.gw.truthLog.entries({ fault: 'bay_closing' }).length > 0);
  const off = harness({ seed: 3, blasts: 'random' });
  off.advance(7_200_000);
  assert.ok(off.messages('zone_event').every((e) => e.zone_id !== 'BAY'));
});

// ---- slow reader ----

test('slow reader: a client more than 4 MB behind is dropped; the others are not', () => {
  const h = harness();
  const slow = h.gw.connect();
  slow.send(AUTH('slow@example.com'));
  slow.pause();
  h.advance(60_000);
  assert.ok(!slow.closed, 'about 2.4 MB a minute: not yet');
  h.advance(120_000);
  assert.ok(slow.closed, 'over 4 MB behind');
  assert.ok(!h.client.closed);
  assert.equal(h.gw.truthLog.entries({ fault: 'slow_reader' })[0]!.detail.email, 'slow@example.com');
});

// ---- L0.P: the pessimistic versions of what is unverified ----

test('L0.P queuing, pessimistic: a queued command is sometimes dropped without notice; the spec version never drops it', () => {
  const run = (behaviour: object) => {
    const h = harness({ behaviour: { ...behaviour, queuedDropProbability: 1 }, trucks: [{ vehicle_id: 'HT-01', positionM: 835, loaded: false, socPct: 80 }] });
    assert.ok(h.until('HT-01', (t) => t.state === 'LOADING', 5_000) >= 0);
    assert.equal(h.command('HT-01', 'HOLD').status, 'ACCEPTED', 'accepted either way');
    h.advance(30_000);
    return h;
  };
  const spec = run(SPEC_VERSION);
  assert.equal(spec.latest('HT-01').state, 'HOLDING');
  const pess = run(PESSIMISTIC_VERSION);
  assert.equal(pess.latest('HT-01').state, 'TRAMMING', 'the HOLD vanished');
  assert.deepEqual(pess.gw.truthLog.entries({ fault: 'queued_dropped' }).map((e) => [e.vehicle, e.detail.action]), [['HT-01', 'HOLD']]);
  assert.equal(DEFAULT_BEHAVIOUR.queueing, 'spec');
  assert.ok(DEFAULT_BEHAVIOUR.queuedDropProbability > 0 && DEFAULT_BEHAVIOUR.queuedDropProbability < 1, 'sometimes, not always');
});

test('L0.P reverse loaded: 2.0 m/s in the spec version, 1.5 m/s in the pessimistic one', () => {
  for (const [version, speed] of [[SPEC_VERSION, 2], [PESSIMISTIC_VERSION, 1.5]] as const) {
    const h = harness({ behaviour: version, trucks: [{ vehicle_id: 'HT-03', positionM: 900, loaded: true, socPct: 60 }] });
    h.command('HT-03', 'EXIT_ZONE');
    assert.ok(h.until('HT-03', (t) => t.task === 'EXIT_ZONE' && t.speed_mps > 0, 6_300) >= 0);
    assert.equal(h.latest('HT-03').direction, 'REV');
    assert.equal(h.latest('HT-03').speed_mps, speed);
  }
});

test('without faults switched on the fake is milestone 1\'s perfect site', () => {
  const clock = new ManualClock(T0);
  const gw = new FakeGateway(clock, { seed: 2, site: DLH1, blasts: 'none' });
  gw.start();
  const c = gw.connect();
  c.send(AUTH());
  clock.advance(60_000);
  assert.equal(c.unparseable.length, 0);
  assert.deepEqual(gw.truthLog.entries(), []);
  const per = c.messages().filter((m) => m.type === 'telemetry').length / 12;
  assert.equal(per, 300);
});
