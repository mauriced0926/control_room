// The track diagram's layout (task 6a, UI.md "Track diagram"): pure functions, tested here on this
// site, a different site with a zone across the wrap, and real fixture replays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignLanes, MIN_STRETCH_PX, siteData, splitRange, trackModel, trackScale } from '../src/ui/track.ts';
import { otherSite, thisSite, fixture, helloFor, otherRoute } from './helpers/fixtures.ts';
import { replay, rig, T0 } from './helpers/rig.ts';
import type { FleetSnapshot } from '../src/fleet.ts';

const W = 1200;

test('scale: the route in route order, left to right, from 0 to the full width', () => {
  const s = trackScale(siteData(thisSite()), W, 90);
  assert.equal(s.x(0), 0);
  assert.equal(s.x(thisSite().loopLengthM), W);
  assert.deepEqual(s.stretches.map((x) => x.zoneId), thisSite().zones.map((z) => z.zoneId), 'one stretch per zone, in route order');
  for (let m = 1; m <= thisSite().loopLengthM; m += 7) assert.ok(s.x(m) > s.x(m - 1), `monotonic at ${m}`);
});

test('scale: short zones are widened to fit their label; the rest share what is left in proportion', () => {
  const s = trackScale(siteData(thisSite()), W, 90);
  const widths = new Map(s.stretches.map((x) => [x.zoneId, x.x1 - x.x0]));
  for (const w of widths.values()) assert.ok(w >= 90 - 1e-9, `every stretch at least 90 px: ${[...widths]}`);
  const transits = s.stretches.filter((x) => x.x1 - x.x0 > 90 + 1e-9);
  // Unwidened stretches keep their length ratios.
  const pxPerM = transits.map((x) => (x.x1 - x.x0) / (x.endM - x.startM));
  for (const r of pxPerM) assert.ok(Math.abs(r - pxPerM[0]!) < 1e-9);
  assert.ok(Math.abs(s.stretches.reduce((a, x) => a + (x.x1 - x.x0), 0) - W) < 1e-6);
});

test('scale: too narrow for every minimum falls back to equal widths, still covering the width', () => {
  const s = trackScale(siteData(thisSite()), 300, 90);
  for (const x of s.stretches) assert.ok(Math.abs(x.x1 - x.x0 - 300 / s.stretches.length) < 1e-9);
});

test('scale: a different site, with a zone at both ends of the route, draws it at both ends', () => {
  const s = trackScale(siteData(otherSite()), W, 90);
  assert.deepEqual(s.stretches.map((x) => x.zoneId), ['North', 'Ramp', 'Face', 'Shaft', 'North']);
  assert.equal(s.x(900), W);
});

test('a range that wraps past the loop end is drawn as two pieces, each marked where it continues', () => {
  assert.deepEqual(splitRange(1600, { startM: 100, lengthM: 50 }), [{ startM: 100, endM: 150, wrapsIn: false, wrapsOut: false }]);
  assert.deepEqual(splitRange(1600, { startM: 1580, lengthM: 50 }), [
    { startM: 1580, endM: 1600, wrapsIn: false, wrapsOut: true },
    { startM: 0, endM: 30, wrapsIn: true, wrapsOut: false },
  ]);
  assert.deepEqual(splitRange(1600, { startM: 0, lengthM: 1600 }), [{ startM: 0, endM: 1600, wrapsIn: true, wrapsOut: true }]);
});

test('lanes: overlapping items stack, separate ones share a lane, and an item with two pieces takes one lane', () => {
  const lanes = assignLanes([
    { id: 'a', spans: [[0, 50]] },
    { id: 'b', spans: [[40, 90]] },
    { id: 'c', spans: [[100, 150]] },
    { id: 'd', spans: [[10, 20], [140, 160]] },
  ], 4);
  assert.equal(lanes.get('a'), 0);
  assert.equal(lanes.get('b'), 1);
  assert.equal(lanes.get('c'), 0);
  assert.equal(lanes.get('d'), 1, 'its pieces collide with a and c in lane 0, and miss b in lane 1');
});

// Run the frozen-truck fixture until HT-10 has been contradicted for 10 s.
function frozenMoment(): FleetSnapshot {
  let snap: FleetSnapshot | null = null;
  let since: number | null = null;
  replay(fixture('frozen-truck'), {
    onRecord: (_r, f, c) => {
      if (snap) return;
      const t = f.snapshot().trucks.find((x) => x.vehicleId === 'HT-10')!;
      if (t.confidence === 'contradicted') since ??= c.now();
      if (since !== null && c.now() - since >= 10_000) snap = f.snapshot();
    },
  });
  assert.ok(snap);
  return snap;
}

test('frozen-truck: the frozen truck is a hatched range with its last position, never a dot', () => {
  const m = trackModel(siteData(thisSite()), frozenMoment(), W);
  assert.ok(!m.chips.some((c) => c.vehicleId === 'HT-10'), 'no chip for the frozen truck');
  const r = m.ranges.find((x) => x.vehicleIds.includes('HT-10'))!;
  assert.equal(r.kind, 'contradicted');
  assert.match(r.label, /HT-10.*data frozen/);
  assert.ok(r.anchorX !== null);
  assert.ok(r.pieces.length === 2, 'its range wraps from TIP into BAY, so it is drawn at both ends');
});

test('frozen-truck, later: HT-05 loading (identical bodies, speed 0) is a solid chip, not a range', () => {
  // The fixture's second part is HT-05 alone, after HT-10's records end.
  const { fleet } = replay(fixture('frozen-truck'));
  const m = trackModel(siteData(thisSite()), fleet.snapshot(), W);
  const c = m.chips.find((x) => x.vehicleId === 'HT-05')!;
  assert.equal(c.kind, 'live');
  assert.match(c.lines.join(' '), /loading/);
  assert.equal(m.ranges.find((x) => x.vehicleIds.includes('HT-10'))?.kind, 'silent', 'HT-10, quiet by then, is still a range');
});

test('trucks that never reported are one shared range over the whole loop, not twelve', () => {
  const m = trackModel(siteData(thisSite()), frozenMoment(), W);
  const unknown = m.ranges.filter((x) => x.kind === 'unknown');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]!.vehicleIds.length, thisSite().vehicles.length - 1, 'all but HT-10, the only truck heard from so far');
  assert.match(unknown[0]!.label, /never reported/i);
  assert.deepEqual(unknown[0]!.pieces.map((p) => [p.x0, p.x1]), [[0, W]]);
});

test('live, old, silent and contradicted are four different marks (L9.1, in the model)', () => {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  const [live, old, silent, frozen] = ids as unknown as [string, string, string, string];
  r.send({ vehicle_id: silent, seq: 1, segment_id: 'SEG-INC-1', zone_id: 'INCLINE', offset_m: 10 });
  r.advance(4_000);
  r.send({ vehicle_id: old, seq: 1, segment_id: 'SEG-L4S-1', zone_id: 'L4_SOUTH', offset_m: 10 });
  for (let s = 1; s <= 20; s++) {
    r.send({ vehicle_id: frozen, seq: s, state: 'TRAMMING', speed_mps: 2, segment_id: 'SEG-DEC-2', zone_id: 'DECLINE', offset_m: 30 });
    r.advance(150);
  }
  r.send({ vehicle_id: live, seq: 1, segment_id: 'SEG-DEC-1', zone_id: 'DECLINE', offset_m: 10 });
  const snap = r.fleet.snapshot();
  const conf = (id: string) => snap.trucks.find((t) => t.vehicleId === id)!.confidence;
  assert.deepEqual([live, old, silent, frozen].map(conf), ['live', 'old', 'silent', 'contradicted']);
  const m = trackModel(siteData(r.fleet.site!), snap, W);
  const chip = (id: string) => m.chips.find((c) => c.vehicleId === id);
  const range = (id: string) => m.ranges.find((x) => x.vehicleIds.includes(id));
  assert.equal(chip(live)?.kind, 'live');
  assert.equal(chip(old)?.kind, 'old');
  assert.match(chip(old)!.lines.join(' '), /old 3 s/);
  assert.equal(range(silent)?.kind, 'silent');
  assert.match(range(silent)!.label, /silent 7 s/);
  assert.equal(range(frozen)?.kind, 'contradicted');
  assert.match(range(frozen)!.label, /data frozen/);
});

test('zone bands: OPEN, a CLOSING countdown, CLOSED, and unknown are all in words', () => {
  const recs = fixture('two-zones-closing');
  const { fleet } = replay(recs.slice(0, 3), { hello: false });
  const m = trackModel(siteData(fleet.site!), fleet.snapshot(), W);
  const band = (z: string) => m.bands.find((b) => b.zoneId === z)!;
  assert.match(band('DRAW_12').status, /^CLOSING \d+:\d\d$/);
  assert.match(band('TIP').status, /^CLOSED/);
  assert.equal(band('DECLINE').status, 'open');
  assert.equal(band('TIP').kind, 'closed');
});

test('a different site: chips and ranges land on its own route', () => {
  const r = rig(helloFor(otherRoute(), 900, ['A', 'B'], T0));
  r.send({ vehicle_id: 'A', seq: 1, state: 'TRAMMING', speed_mps: 3, segment_id: 's4', zone_id: 'Shaft', offset_m: 340 });
  const m = trackModel(siteData(r.fleet.site!), r.fleet.snapshot(), W);
  const a = m.chips.find((c) => c.vehicleId === 'A')!;
  const s = trackScale(siteData(r.fleet.site!), W, MIN_STRETCH_PX);
  assert.equal(a.x, s.x(840));
  assert.deepEqual(m.bands.map((b) => b.zoneId), ['North', 'Ramp', 'Face', 'Shaft', 'North']);
});
