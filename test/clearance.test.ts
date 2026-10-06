// Zone clearance from belief (CLAUDE.md invariant 6; UI.md "Zone clearance panel"). Truck views come
// from a real FleetState fed telemetry with a manual clock, not hand-built, so the rule is tested
// against the confidence and ranges the UI will actually receive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_THE_SHOT, zoneClearance } from '../src/clearance.ts';
import type { ZoneView } from '../src/fleet.ts';
import { PARAMS } from '../src/params.ts';
import { otherRoute, helloFor } from './helpers/fixtures.ts';
import { rig, T0 } from './helpers/rig.ts';

// A zone as the snapshot shows it, set to closing. The status does not change the verdict; it only
// decides whether the panel shows the zone.
function closing(zoneId: string): ZoneView {
  return { zoneId, status: 'CLOSING', reason: 'BLAST_WINDOW', effectiveAtMs: T0 + 120_000, msUntilEffective: 120_000, updatedServerMs: T0, trucksMightBeIn: [] };
}

// Live, steady trucks: HT-01 deep inside DECLINE, the rest of the roster parked far from it.
function steady() {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  ids.forEach((id, i) => r.send({ vehicle_id: id, seq: 1, state: 'IDLE', speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 5 + i }));
  r.send({ vehicle_id: ids[0], seq: 2, state: 'TRAMMING', speed_mps: 3, segment_id: 'SEG-DEC-2', zone_id: 'DECLINE', offset_m: 100 });
  return { r, ids };
}

test('CLEAR only when no truck might be inside', () => {
  const { r } = steady();
  const snap = r.fleet.snapshot();
  const c = zoneClearance(closing('L4_SOUTH'), snap.trucks);
  assert.equal(c.verdict, 'CLEAR');
  assert.equal(c.action, null);
  assert.deepEqual(c.reasons, []);
});

test('NOT CLEAR when a live truck is inside, with the hold-the-shot action and the truck named', () => {
  const { r, ids } = steady();
  const c = zoneClearance(closing('DECLINE'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'NOT_CLEAR');
  assert.equal(c.action, HOLD_THE_SHOT);
  assert.equal(HOLD_THE_SHOT, 'Radio the shot firer to hold the shot');
  assert.deepEqual(c.reasons.map((x) => x.vehicleIds), [[ids[0]]]);
  assert.match(c.reasons[0]!.why, /inside/);
});

test('NOT CLEAR when an old truck is inside, and the reason says how old', () => {
  const { r, ids } = steady();
  // Keep the others fresh; let HT-01 age past "old" but not "silent".
  r.advance(PARAMS.truckOldAfter.value + 500);
  ids.slice(1).forEach((id) => r.send({ vehicle_id: id, seq: 2, state: 'IDLE', speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 5 }));
  const t = r.truck(ids[0]);
  assert.equal(t.confidence, 'old');
  const c = zoneClearance(closing('DECLINE'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'NOT_CLEAR');
  assert.match(c.reasons[0]!.why, /old 2 s/);
});

test('UNSURE, never CLEAR, when only a silent truck could have reached the zone', () => {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  // HT-01 last seen tramming in L4_NORTH, 20 m before DRAW_12; everyone else in the bay, kept fresh.
  r.send({ vehicle_id: ids[0], seq: 1, state: 'TRAMMING', speed_mps: 3, segment_id: 'SEG-L4N-1', zone_id: 'L4_NORTH', offset_m: 180 });
  for (let s = 0; s < 8; s++) {
    ids.slice(1).forEach((id) => r.send({ vehicle_id: id, seq: s + 1, state: 'IDLE', speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 5 }));
    r.advance(1_000);
  }
  assert.equal(r.truck(ids[0]).confidence, 'silent');
  const c = zoneClearance(closing('DRAW_12'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'UNSURE');
  assert.equal(c.action, HOLD_THE_SHOT);
  assert.deepEqual(c.reasons.map((x) => x.vehicleIds), [[ids[0]]]);
  assert.match(c.reasons[0]!.why, /silent 8 s/);
  // A zone the silent truck cannot have reached in 8 s stays clear.
  assert.equal(zoneClearance(closing('INCLINE'), r.fleet.snapshot().trucks).verdict, 'CLEAR');
});

test('UNSURE when a contradicted (frozen) truck could be inside, even if it reports a position outside', () => {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  // HT-01 reports tramming at 2 m/s but never moves, 1 m short of L4_SOUTH.
  for (let s = 1; s <= 30; s++) {
    r.send({ vehicle_id: ids[0], seq: s, state: 'TRAMMING', speed_mps: 2, segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12', offset_m: 59 });
    ids.slice(1).forEach((id) => r.send({ vehicle_id: id, seq: s, state: 'IDLE', speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 5 }));
    r.advance(200);
  }
  const t = r.truck(ids[0]);
  assert.equal(t.confidence, 'contradicted');
  assert.equal(t.position?.value.zoneId, 'DRAW_12');
  const c = zoneClearance(closing('L4_SOUTH'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'UNSURE');
  assert.match(c.reasons[0]!.why, /frozen/);
});

test('UNSURE when trucks have never reported: they could be anywhere, and are named together', () => {
  const r = rig();
  const c = zoneClearance(closing('TIP'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'UNSURE');
  assert.equal(c.reasons.length, 1, 'one line for all of them');
  assert.equal(c.reasons[0]!.vehicleIds.length, r.fleet.site!.vehicles.length);
  assert.match(c.reasons[0]!.why, /never reported/);
});

test('NOT CLEAR wins over UNSURE, and every doubtful truck is still listed', () => {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  r.send({ vehicle_id: ids[0], seq: 1, state: 'TRAMMING', speed_mps: 3, segment_id: 'SEG-DEC-1', zone_id: 'DECLINE', offset_m: 100 });
  const c = zoneClearance(closing('DECLINE'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'NOT_CLEAR');
  assert.equal(c.reasons[0]!.certainty, 'inside', 'the certain reason comes first');
  assert.ok(c.reasons.some((x) => x.certainty === 'might' && /never reported/.test(x.why)));
});

test('a live truck at the boundary, reported outside, is UNSURE: it might already be in', () => {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  ids.forEach((id, i) => r.send({ vehicle_id: id, seq: 1, state: 'IDLE', speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 5 + i }));
  r.send({ vehicle_id: ids[0], seq: 2, state: 'TRAMMING', speed_mps: 3, segment_id: 'SEG-L4N-1', zone_id: 'L4_NORTH', offset_m: 199 });
  const c = zoneClearance(closing('DRAW_12'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'UNSURE');
  assert.match(c.reasons[0]!.why, /boundary/);
});

// BLAST.md B11: CLEAR needs every truck's range outside the zone, old trucks included. An old truck is
// judged by where it could be now, not where it last said it was: 2-5 s at 3 m/s is up to ~15 m.
test('an old truck reported just outside and heading in is UNSURE, never CLEAR; the same truck live is CLEAR', () => {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  const parkRest = (seq: number) => ids.slice(1).forEach((id, i) => r.send({ vehicle_id: id, seq, state: 'IDLE', speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 5 + i }));
  parkRest(1);
  // HT-01 tramming forward at 3 m/s, 10 m short of DRAW_12.
  r.send({ vehicle_id: ids[0], seq: 1, state: 'TRAMMING', speed_mps: 3, direction: 'FWD', segment_id: 'SEG-L4N-1', zone_id: 'L4_NORTH', offset_m: 190 });
  assert.equal(r.truck(ids[0]).confidence, 'live');
  assert.equal(zoneClearance(closing('DRAW_12'), r.fleet.snapshot().trucks).verdict, 'CLEAR', 'live, its range stops short of the zone');

  r.advance(4_000);
  parkRest(2);
  assert.equal(r.truck(ids[0]).confidence, 'old');
  const c = zoneClearance(closing('DRAW_12'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'UNSURE', 'old by 4 s it could have driven ~12 m: it might be inside');
  assert.equal(c.action, HOLD_THE_SHOT);
  assert.deepEqual(c.reasons.map((x) => x.vehicleIds), [[ids[0]]]);
});

test('a faulted truck inside says so', () => {
  const r = rig();
  r.send({ seq: 1, state: 'FAULT', speed_mps: 0, faults: ['BATTERY_DEPLETED'], segment_id: 'SEG-INC-1', zone_id: 'INCLINE', offset_m: 50 });
  const c = zoneClearance(closing('INCLINE'), r.fleet.snapshot().trucks);
  assert.equal(c.verdict, 'NOT_CLEAR');
  assert.match(c.reasons[0]!.why, /BATTERY_DEPLETED/);
});

test('works on a different site, including a zone that wraps past the loop end', () => {
  const r = rig(helloFor(otherRoute(), 900, ['A', 'B'], T0));
  r.send({ vehicle_id: 'A', seq: 1, state: 'TRAMMING', speed_mps: 3, segment_id: 's1', zone_id: 'North', offset_m: 10 });
  r.send({ vehicle_id: 'B', seq: 1, state: 'IDLE', speed_mps: 0, segment_id: 's3', zone_id: 'Face', offset_m: 100 });
  const snap = r.fleet.snapshot();
  assert.equal(zoneClearance(closing('North'), snap.trucks).verdict, 'NOT_CLEAR');
  assert.equal(zoneClearance(closing('Shaft'), snap.trucks).verdict, 'CLEAR');
});

test('B13 with the site link down every zone that is not open is UNSURE, even one a truck was seen in; with it up the usual rule', () => {
  const { r, ids } = steady();
  const trucks = r.fleet.snapshot().trucks;
  const down = zoneClearance(closing('DECLINE'), trucks, { linkUp: false });
  assert.equal(down.verdict, 'UNSURE');
  assert.equal(down.action, HOLD_THE_SHOT);
  assert.ok(down.reasons.some((x) => /site link down/.test(x.why)));
  assert.ok(down.reasons.some((x) => x.vehicleIds.includes(ids[0]!)), 'what was seen is still listed');
  assert.equal(zoneClearance(closing('L4_SOUTH'), trucks, { linkUp: false }).verdict, 'UNSURE', 'never CLEAR while the link is down');
  assert.equal(zoneClearance(closing('L4_SOUTH'), trucks, { linkUp: true }).verdict, 'CLEAR');
  assert.equal(zoneClearance(closing('DECLINE'), trucks, { linkUp: true }).verdict, 'NOT_CLEAR');
});
