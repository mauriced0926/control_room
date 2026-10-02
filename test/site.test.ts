// The site model is built from hello, never from constants (CLAUDE.md invariant 7). Tests use this
// site's real hello from the fixtures, and a deliberately different site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSite } from '../src/site.ts';
import type { Hello, RouteSegment } from '../src/protocol.ts';

function fixtureHello(): Hello {
  const lines = readFileSync(new URL('../research/fixtures/two-zones-closing.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const rec = lines.map((l) => JSON.parse(l)).find((r) => r.kind === 'msg' && r.m.type === 'hello');
  return rec.m as Hello;
}

function hello(route: RouteSegment[], loop: number, vehicles = ['T1', 'T2']): Hello {
  return { type: 'hello', protocol: '3.0', site_id: 'X', server_time_ms: 0, vehicles, route, loop_length_m: loop, zones: [], leases: [] };
}

const seg = (segment_id: string, zone_id: string, start_m: number, length_m: number, kind = 'transit'): RouteSegment =>
  ({ segment_id, zone_id, start_m, length_m, kind });

test('this site: segments, zones in loop order, vehicles and loop length come from hello', () => {
  const { site, issues } = buildSite(fixtureHello());
  assert.deepEqual(issues, []);
  assert.equal(site.loopLengthM, 1600);
  assert.equal(site.segments.length, 9);
  assert.deepEqual(site.zones.map((z) => z.zoneId), ['BAY', 'DECLINE', 'L4_NORTH', 'DRAW_12', 'L4_SOUTH', 'INCLINE', 'TIP']);
  assert.equal(site.vehicles.length, 12);
  const decline = site.zone('DECLINE');
  assert.deepEqual(decline?.ranges, [{ startM: 80, lengthM: 500 }]);
});

test('this site: segment and offset map to loop position and back to a zone', () => {
  const { site } = buildSite(fixtureHello());
  assert.equal(site.toLoop('SEG-L4S-1', 112.4), 952.4);
  assert.equal(site.zoneAt(952.4)?.zoneId, 'L4_SOUTH');
  assert.equal(site.zoneAt(0)?.zoneId, 'BAY');
  assert.equal(site.zoneAt(1599.99)?.zoneId, 'TIP');
  assert.equal(site.zoneAt(1600)?.zoneId, 'BAY', 'wraps');
  assert.equal(site.zoneAt(-0.5)?.zoneId, 'TIP', 'wraps backwards');
  assert.equal(site.toLoop('SEG-NOPE', 1), undefined);
  assert.equal(site.toLoop('SEG-BAY', Number.NaN), undefined);
});

test('the bay is found by segment kind, not by name', () => {
  const { site } = buildSite(fixtureHello());
  assert.deepEqual(site.bayZones().map((z) => z.zoneId), ['BAY']);
  const other = buildSite(hello([seg('a', 'Depot', 0, 50, 'bay'), seg('b', 'Ramp', 50, 450)], 500)).site;
  assert.deepEqual(other.bayZones().map((z) => z.zoneId), ['Depot']);
});

test('a different site: other names, lengths, truck count, and a zone that wraps past the loop end', () => {
  const route = [
    seg('s1', 'North', 0, 100), seg('s2', 'Ramp', 100, 200), seg('s3', 'Face', 300, 200, 'load'),
    seg('s4', 'Shaft', 500, 350, 'dump'), seg('s5', 'North', 850, 50),
  ];
  const { site, issues } = buildSite(hello(route, 900, ['A', 'B', 'C', 'D', 'E', 'F', 'G']));
  assert.deepEqual(issues, []);
  assert.equal(site.vehicles.length, 7);
  assert.deepEqual(site.zones.map((z) => z.zoneId), ['North', 'Ramp', 'Face', 'Shaft']);
  assert.deepEqual(site.zone('North')?.ranges, [{ startM: 850, lengthM: 150 }], 'merged across the wrap');
  assert.equal(site.zoneAt(870)?.zoneId, 'North');
  assert.equal(site.zoneAt(20)?.zoneId, 'North');
  assert.equal(site.zoneAt(120)?.zoneId, 'Ramp');
  assert.equal(site.zone('North')?.lengthM, 150);
});

test('a zone in two separate stretches keeps both, and says so', () => {
  const route = [seg('a', 'P', 0, 100), seg('b', 'Q', 100, 100), seg('c', 'P', 200, 100), seg('d', 'R', 300, 100)];
  const { site, issues } = buildSite(hello(route, 400));
  assert.deepEqual(site.zone('P')?.ranges, [{ startM: 0, lengthM: 100 }, { startM: 200, lengthM: 100 }]);
  assert.equal(site.zoneAt(250)?.zoneId, 'P');
  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? '', /P.*2 separate stretches/);
});

test('a malformed route is reported, not silently accepted', () => {
  const gap = buildSite(hello([seg('a', 'P', 0, 100), seg('b', 'Q', 120, 280)], 400)).issues;
  assert.ok(gap.some((i) => /gap/.test(i)), gap.join('; '));
  const overlap = buildSite(hello([seg('a', 'P', 0, 150), seg('b', 'Q', 100, 300)], 400)).issues;
  assert.ok(overlap.some((i) => /overlap/.test(i)), overlap.join('; '));
  const short = buildSite(hello([seg('a', 'P', 0, 100), seg('b', 'Q', 100, 200)], 400)).issues;
  assert.ok(short.some((i) => /300.*400|400.*300/.test(i)), short.join('; '));
  const dup = buildSite(hello([seg('a', 'P', 0, 200), seg('a', 'Q', 200, 200)], 400)).issues;
  assert.ok(dup.some((i) => /duplicate/.test(i)), dup.join('; '));
});

test('a hello with no usable route is refused outright', () => {
  assert.throws(() => buildSite(hello([], 400)), /no route/);
  assert.throws(() => buildSite(hello([seg('a', 'P', 0, 400)], 0)), /loop length/);
});
