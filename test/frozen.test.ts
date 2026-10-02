// TESTING.md L2.24-L2.25: frozen (contradicted) detection. Reported motion that contradicts an
// unchanged position, for longer than PARAMS.frozenAfter. The negatives matter as much: loading,
// held, parked and deadman-stopped trucks send identical messages too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../src/params.ts';
import { rig, T0, type Rig } from './helpers/rig.ts';

const HZ5 = 200;

// Sends the same body at 5 Hz for `ms`, with seq and the device clock advancing, as the live
// frozen truck did.
function repeat(r: Rig, ms: number, over: Record<string, unknown>, from = { seq: 1 }) {
  let seq = from.seq;
  for (let t = 0; t <= ms; t += HZ5) {
    r.send({ ...over, seq, t_device_ms: T0 + seq * HZ5 });
    seq++;
    r.advance(HZ5);
  }
  return { seq };
}

test('L2.24 TRAMMING at 2-3 m/s with an unchanged position, past the threshold: contradicted', () => {
  for (const speed of [2, 3]) {
    const r = rig();
    r.send({ seq: 1, t_device_ms: T0, offset_m: 39.6, speed_mps: speed });
    r.advance(HZ5);
    // Frozen from here: same position, still reporting motion.
    const frozenFrom = r.clock.now();
    let seq = 2;
    while (r.clock.now() - frozenFrom < PARAMS.frozenAfter.value) {
      r.send({ seq: seq++, t_device_ms: T0 + seq * HZ5, offset_m: 40, speed_mps: speed });
      r.advance(HZ5);
    }
    // The last send was at frozenFrom + 2.8 s; the clock is now at frozenFrom + 3.0 s, so the
    // position has been unchanged, while reporting motion, for exactly the threshold.
    assert.equal(r.clock.now() - frozenFrom, PARAMS.frozenAfter.value);
    const t = r.truck();
    assert.equal(t.confidence, 'contradicted', `at ${speed} m/s`);
    assert.match(t.confidenceReason, /has not moved/);
    assert.equal(t.anchor?.atServerMs, frozenFrom, 'range anchored where the position stopped changing');
    assert.equal(t.anchor?.loopM, 80 + 40);
    assert.ok(r.events.some((e) => e.type === 'confidence' && e.to === 'contradicted'));
    // The range widens with time, in both directions: nothing the frozen message says is believable.
    const w1 = t.range!.lengthM;
    r.advance(10_000);
    const w2 = r.truck().range!.lengthM;
    assert.ok(w2 > w1 + 50, `range widened ${w1} -> ${w2}`);
    assert.ok(r.truck().range!.startM < 80 + 40 - 10, 'reaches backwards too');
  }
});

test('L2.24 not contradicted one message short of the threshold', () => {
  const r = rig();
  r.send({ seq: 1, t_device_ms: T0, offset_m: 39.6, speed_mps: 2 });
  r.advance(HZ5);
  const frozenFrom = r.clock.now();
  let seq = 2;
  while (r.clock.now() - frozenFrom < PARAMS.frozenAfter.value - HZ5) {
    r.send({ seq: seq++, t_device_ms: T0 + seq * HZ5, offset_m: 40, speed_mps: 2 });
    r.advance(HZ5);
  }
  assert.equal(r.truck().confidence, 'live');
});

test('L2.24 the contradiction clears when the position moves again', () => {
  const r = rig();
  const { seq } = repeat(r, 4_000, { offset_m: 40, speed_mps: 2 });
  assert.equal(r.truck().confidence, 'contradicted');
  r.send({ seq, t_device_ms: T0 + seq * HZ5, offset_m: 60, speed_mps: 2 });
  assert.equal(r.truck().confidence, 'live');
  assert.equal(r.truck().frozenEpisodes, 1);
});

test('a frozen truck that then goes quiet is silent, and its range still grows from before the freeze', () => {
  const r = rig();
  r.send({ seq: 1, t_device_ms: T0, offset_m: 39.6, speed_mps: 2 });
  r.advance(HZ5);
  const frozenFrom = r.clock.now();
  repeat(r, 4_000, { offset_m: 40, speed_mps: 2 }, { seq: 2 });
  assert.equal(r.truck().confidence, 'contradicted');
  r.advance(PARAMS.truckSilentAfter.value);
  const t = r.truck();
  assert.equal(t.confidence, 'silent');
  assert.match(t.confidenceReason, /last data was frozen/);
  assert.equal(t.anchor?.atServerMs, frozenFrom, 'anchored where the position stopped changing, not at the last frozen message');
});

test('L2.25a LOADING, identical bodies for 20 s: not flagged', () => {
  const r = rig();
  repeat(r, 20_000, { state: 'LOADING', speed_mps: 0, segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12', offset_m: 59.95 });
  assert.equal(r.truck().confidence, 'live');
  assert.equal(r.truck().frozenEpisodes, 0);
});

test('L2.25b HOLDING for an hour: not flagged', () => {
  const r = rig();
  repeat(r, 3_600_000, { state: 'HOLDING', speed_mps: 0, offset_m: 57.07 });
  assert.equal(r.truck().confidence, 'live');
  assert.equal(r.truck().frozenEpisodes, 0);
});

test('L2.25c IDLE or CHARGING in the bay: not flagged', () => {
  for (const state of ['IDLE', 'CHARGING']) {
    const r = rig();
    repeat(r, 60_000, { state, speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 79.9 });
    assert.equal(r.truck().confidence, 'live', state);
  }
});

test('L2.25d MANUAL with deadman true, speed 0: not flagged', () => {
  const r = rig();
  repeat(r, 30_000, { state: 'MANUAL', speed_mps: 0, control: { mode: 'MANUAL', operator_id: 'op', deadman: true, last_drive_seq: 0, last_drive_sent_ms: null } });
  assert.equal(r.truck().confidence, 'live');
});

test('L2.25e MANUAL, speed > 0, position unchanged: flagged', () => {
  const r = rig();
  repeat(r, 5_000, { state: 'MANUAL', speed_mps: 1.0, control: { mode: 'MANUAL', operator_id: 'op', deadman: false, last_drive_seq: 9, last_drive_sent_ms: null } });
  assert.equal(r.truck().confidence, 'contradicted');
});

test('creeping below the minimum reported speed is not a contradiction', () => {
  const r = rig();
  repeat(r, 10_000, { speed_mps: PARAMS.frozenMinReportedSpeed.value / 2 });
  assert.equal(r.truck().confidence, 'live');
});

test('a null speed keeps the last known speed for this check (the HT-02 malformed-field fault)', () => {
  const r = rig();
  r.send({ seq: 1, t_device_ms: T0, offset_m: 40, speed_mps: 2 });
  r.advance(HZ5);
  repeat(r, 4_000, { offset_m: 40, speed_mps: null }, { seq: 2 });
  assert.equal(r.truck().confidence, 'contradicted');
  // And a held truck with a null speed stays a held truck.
  const h = rig();
  h.send({ seq: 1, state: 'HOLDING', speed_mps: 0 });
  h.advance(HZ5);
  repeat(h, 10_000, { state: 'HOLDING', speed_mps: null }, { seq: 2 });
  assert.equal(h.truck().confidence, 'live');
});
