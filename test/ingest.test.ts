// TESTING.md L2.10-L2.17: ingest, one case per fault class. Each bad field becomes unknown on its
// own (keeping its last known value and age); the rest of the message is used. Every repair or
// rejection is counted per truck and per kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, validateTelemetry } from '../src/ingest.ts';
import { rig, telemetry, T0 } from './helpers/rig.ts';
import { thisSite } from './helpers/fixtures.ts';

test('L2.10 fractional SoC: flagged, shown as reported, not scaled', () => {
  const r = rig();
  r.send({ seq: 1, soc_pct: 0.82 });
  r.advance(200);
  r.send({ seq: 2, soc_pct: 0.82 });
  r.advance(200);
  r.send({ seq: 3, soc_pct: 0.81 });
  const t = r.truck();
  assert.equal(t.socPct?.value, 0.81, 'shown as reported');
  assert.equal(t.socFractional, true);
  assert.equal(t.dataQuality['soc_pct:fractional'], 1, 'counted once per episode, not per message');
  assert.equal(t.battery.warning, null, 'no battery conclusions from a number we cannot read');
});

test('L2.10 a pack draining smoothly through 1 % to 0 is not fractional (weak-pack values)', () => {
  const r = rig();
  const socs = [2.12, 1.66, 1.21, 1.03, 0.94, 0.49, 0.13, 0.04, 0];
  socs.forEach((s, i) => { r.send({ seq: i + 1, soc_pct: s, offset_m: 10 + i }); r.advance(200); });
  const t = r.truck();
  assert.equal(t.socPct?.value, 0);
  assert.equal(t.socFractional, false);
  assert.equal(t.dataQuality['soc_pct:fractional'], undefined);
});

test('L2.10 a jump from a percentage straight into 0-1 is a fraction', () => {
  const r = rig();
  r.send({ seq: 1, soc_pct: 82.4 });
  r.advance(200);
  r.send({ seq: 2, soc_pct: 0.82 });
  assert.equal(r.truck().socFractional, true);
  r.advance(200);
  r.send({ seq: 3, soc_pct: 82.3 });
  assert.equal(r.truck().socFractional, false, 'back to percentages');
});

test('L2.11 truncated line: dropped, counted per connection, never crashes the reader', () => {
  const r = rig();
  r.send({ seq: 1 });
  const before = r.truck().socPct;
  const junk = ['{"m": {"type": "telemetry", "vehicle_id": "HT-01", "seq": 2, "t_dev', '', '   ', '[]', 'null', '42', '"text"', '{}', '{"type": 7}', '\u0000\u0001', '{"type":"telemetry"}', '{"type":"telemetry","vehicle_id":"HT-01"}'];
  for (const j of junk) assert.doesNotThrow(() => r.line(j), JSON.stringify(j));
  const dq = r.fleet.snapshot().dataQuality;
  assert.equal(dq.connection.unparseable, 2, 'the cut-off line and the control characters');
  assert.equal(dq.total.unparseable, 2);
  assert.ok((dq.total.not_object ?? 0) >= 4, 'arrays, null, numbers and strings are not messages');
  assert.deepEqual(r.truck().socPct, before, 'nothing changed');
  r.fleet.newConnection();
  assert.equal(r.fleet.snapshot().dataQuality.connection.unparseable ?? 0, 0, 'per connection');
  assert.equal(r.fleet.snapshot().dataQuality.total.unparseable, 2, 'and in total');
  assert.equal(r.truck().dataQuality['seq:invalid'], 1, 'a truck message without a usable seq cannot be ordered');
});

test('L2.12 lowercase state: normalised, and counted as a data-quality event', () => {
  const r = rig();
  r.send({ seq: 1, state: 'tramming' });
  assert.equal(r.truck().state?.value, 'TRAMMING');
  assert.equal(r.truck().dataQuality['state:lowercase'], 1);
  assert.ok(r.events.some((e) => e.type === 'data_quality' && e.kind === 'state:lowercase' && e.vehicleId === 'HT-01'));
  r.advance(200);
  r.send({ seq: 2, state: 'FLYING' });
  assert.equal(r.truck().state?.value, 'TRAMMING', 'an unknown state keeps the last known one');
  assert.equal(r.truck().dataQuality['state:invalid'], 1);
});

test('L2.13 offset_m as a string: parsed if numeric, counted; otherwise the position is unknown', () => {
  const r = rig();
  r.send({ seq: 1, offset_m: '133.86' });
  const site = thisSite();
  assert.equal(r.truck().position?.value.loopM, site.toLoop('SEG-DEC-1', 133.86));
  assert.equal(r.truck().dataQuality['offset_m:string'], 1);
  r.advance(1_000);
  r.send({ seq: 2, offset_m: 'abc' });
  const t = r.truck();
  assert.equal(t.position?.value.offsetM, 133.86, 'keeps the last known position');
  assert.equal(t.position?.ageMs, 1_000, 'with its age');
  assert.equal(t.dataQuality['offset_m:invalid'], 1);
});

test('L2.14 null or missing speed / SoC: unknown, keeps last value with its age; the rest is used', () => {
  const r = rig();
  r.send({ seq: 1, speed_mps: 3, soc_pct: 60, offset_m: 10 });
  r.advance(400);
  const missingSoc = telemetry({ seq: 2, speed_mps: null, offset_m: 11.2 });
  delete missingSoc.soc_pct;
  r.fleet.ingest(missingSoc);
  const t = r.truck();
  assert.equal(t.speedMps?.value, 3);
  assert.equal(t.speedMps?.ageMs, 400);
  assert.equal(t.socPct?.value, 60);
  assert.equal(t.socPct?.ageMs, 400);
  assert.equal(t.position?.value.offsetM, 11.2, 'position from the same message is used');
  assert.equal(t.position?.ageMs, 0);
  assert.equal(t.dataQuality['speed_mps:null'], 1);
  assert.equal(t.dataQuality['soc_pct:missing'], 1);
});

test('L2.15 unknown segment, or a zone that does not match the segment: position unknown, not guessed', () => {
  const r = rig();
  r.send({ seq: 1, offset_m: 50 });
  r.advance(200);
  r.send({ seq: 2, segment_id: 'SEG-NOWHERE', offset_m: 51 });
  assert.equal(r.truck().position?.value.offsetM, 50);
  assert.equal(r.truck().dataQuality['position:unknown_segment'], 1);
  r.advance(200);
  r.send({ seq: 3, zone_id: 'TIP', offset_m: 52 });
  assert.equal(r.truck().position?.value.offsetM, 50);
  assert.equal(r.truck().dataQuality['position:zone_mismatch'], 1);
  r.advance(200);
  r.send({ seq: 4, offset_m: 9_999 });
  assert.equal(r.truck().position?.value.offsetM, 50);
  assert.equal(r.truck().dataQuality['position:offset_out_of_segment'], 1);
  // A truck whose position has never been valid could be anywhere.
  const r2 = rig();
  r2.send({ seq: 1, segment_id: 'SEG-NOWHERE' });
  const t2 = r2.truck();
  assert.equal(t2.position, null);
  assert.deepEqual(t2.range, { startM: 0, lengthM: thisSite().loopLengthM });
  assert.equal(t2.mightBeIn.length, thisSite().zones.length);
});

test('L2.16 clock skew of +58 min: ages unaffected, skew shown per truck', () => {
  const r = rig();
  const skew = 58 * 60_000;
  r.send({ seq: 1, t_device_ms: T0 + skew });
  r.advance(1_000);
  const t = r.truck();
  assert.equal(t.ageMs, 1_000, 'age from server time, not the device clock');
  assert.equal(t.confidence, 'live');
  assert.ok(Math.abs((t.skewMs ?? 0) - skew) < 10);
  assert.equal(t.skewFlagged, true);
  assert.equal(t.dataQuality.clock_skew, 1);
  // An ordinary truck is not flagged.
  r.send({ vehicle_id: 'HT-02', seq: 1, t_device_ms: r.clock.now() - 1_200 });
  assert.equal(r.truck('HT-02').skewFlagged, false);
});

test('L2.16 ages follow server time learned from heartbeats, never the local clock alone', () => {
  const r = rig();
  // The gateway clock runs 5 s ahead of ours: learned from a heartbeat.
  r.fleet.ingest({ type: 'heartbeat', server_time_ms: T0 + 5_000 });
  assert.equal(r.fleet.serverNow(), T0 + 5_000);
  r.send({ seq: 1 });
  assert.equal(r.truck().lastMessageServerMs, T0 + 5_000);
  r.advance(3_000);
  assert.equal(r.truck().ageMs, 3_000);
  assert.equal(r.truck().confidence, 'old');
});

test('L2.17 a message with an unknown type is ignored, and counted', () => {
  const r = rig();
  r.send({ seq: 1 });
  const before = r.fleet.snapshot();
  r.line('{"type":"weather","rain":true}');
  const after = r.fleet.snapshot();
  assert.deepEqual(after.trucks, before.trucks);
  assert.equal(after.dataQuality.total.unknown_type, 1);
});

test('parseLine and validateTelemetry work on their own, for the UI fixture player', () => {
  assert.deepEqual(parseLine('{"type":"heartbeat","server_time_ms":5}'), { ok: true, msg: { type: 'heartbeat', server_time_ms: 5 } });
  assert.deepEqual(parseLine('{"type":"heart'), { ok: false, reason: 'unparseable' });
  const v = validateTelemetry(telemetry({ state: 'loading', offset_m: '12.5', speed_mps: null }), thisSite());
  assert.equal(v.fields?.state, 'LOADING');
  assert.equal(v.fields?.position?.offsetM, 12.5);
  assert.equal(v.fields?.speedMps, undefined);
  assert.deepEqual(v.issues.map((i) => i.kind).sort(), ['offset_m:string', 'speed_mps:null', 'state:lowercase']);
  assert.equal(validateTelemetry({ type: 'telemetry', seq: 1 }, thisSite()).fields, null, 'no vehicle id: not a truck message');
});

test('a truck not on the roster is still tracked, and flagged', () => {
  const r = rig();
  r.send({ vehicle_id: 'ZZ-99', seq: 1 });
  const t = r.truck('ZZ-99');
  assert.equal(t.onRoster, false);
  assert.equal(t.dataQuality.unknown_vehicle, 1);
});

test('rostered trucks that have not reported yet could be anywhere', () => {
  const r = rig();
  const snap = r.fleet.snapshot();
  assert.equal(snap.trucks.length, thisSite().vehicles.length);
  for (const t of snap.trucks) {
    assert.equal(t.confidence, 'unknown');
    assert.deepEqual(t.range, { startM: 0, lengthM: thisSite().loopLengthM });
  }
});
