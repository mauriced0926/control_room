// Path prediction (BLAST.md "Inputs and timing"): TESTING.md L2.7, L2.56 and the last safe moment of
// L2.57, on this site's real hello and on a different site whose duty stops come only from kinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../src/params.ts';
import { dutyStops, lastSafeMoment, positionAt, predictPath, visits, type PathStart } from '../src/path.ts';
import { buildSite } from '../src/site.ts';
import { siteVariant } from '../fake/sites.ts';
import { helloFor, thisSite } from './helpers/fixtures.ts';

const NOW = 1_000_000;
const close = (a: number, b: number, eps = 1) => Math.abs(a - b) <= eps;

function start(over: Partial<PathStart>): PathStart {
  return { atMs: NOW, positionM: 0, state: 'TRAMMING', task: null, direction: 'FWD', loaded: false, socPct: 60, stateSinceMs: NOW, ...over };
}

test('L2.7 a truck entering DECLINE takes ~167 s to cross it: it cannot get out of a 120 s notice on its own', () => {
  const site = thisSite();
  const dec = site.zone('DECLINE')!.ranges[0]!;
  const v = visits(site, predictPath(site, start({ positionM: dec.startM + 0.5 }), 'late', NOW + 600_000));
  assert.equal(v[0]!.zoneId, 'DECLINE');
  const crossS = (v[0]!.tOut - NOW) / 1000;
  assert.ok(close(crossS, (dec.lengthM - 0.5) / PARAMS.autoSpeedEmpty.value), `crossed in ${crossS} s`);
  assert.ok(crossS > 120);
});

test('L2.56 path prediction includes the duty stop: load time, then loaded speed after it', () => {
  const site = thisSite();
  const draw = site.zone('DRAW_12')!.ranges[0]!;
  const p = predictPath(site, start({ positionM: draw.startM + 20 }), 'late', NOW + 600_000);
  const v = visits(site, p);
  assert.deepEqual(v.slice(0, 3).map((x) => x.zoneId), ['DRAW_12', 'L4_SOUTH', 'INCLINE']);
  const toStop = (draw.lengthM - 20 - PARAMS.dutyStopBeforeEnd.value) / PARAMS.autoSpeedEmpty.value;
  const leaveDraw = toStop + PARAMS.loadTime.value / 1000 + PARAMS.dutyStopBeforeEnd.value / PARAMS.autoSpeedLoaded.value;
  assert.ok(close((v[0]!.tOut - NOW) / 1000, leaveDraw, 0.01), `leaves the draw point at ${(v[0]!.tOut - NOW) / 1000} s, expected ${leaveDraw}`);
  const south = site.zone('L4_SOUTH')!.lengthM;
  assert.ok(close((v[1]!.tOut - v[1]!.tIn) / 1000, south / PARAMS.autoSpeedLoaded.value, 0.01), 'crosses L4_SOUTH at loaded speed');
  assert.equal(positionAt(site, p, NOW + (toStop + 5) * 1000).piece.stop, 'LOADING');
});

test('L2.56 a truck already loading leaves when its remaining work is done, loaded', () => {
  const site = thisSite();
  const draw = site.zone('DRAW_12')!.ranges[0]!;
  const end = draw.startM + draw.lengthM - PARAMS.dutyStopBeforeEnd.value;
  const v = visits(site, predictPath(site, start({ positionM: end, state: 'LOADING', speedMps: 0, stateSinceMs: NOW - 15_000 } as Partial<PathStart>), 'late', NOW + 600_000));
  assert.equal(v[0]!.zoneId, 'DRAW_12');
  assert.ok(close((v[0]!.tOut - NOW) / 1000, 5 + PARAMS.dutyStopBeforeEnd.value / PARAMS.autoSpeedLoaded.value, 0.01));
  // The early bound starts the work 1.5 s sooner: the report may be that late.
  const e = visits(site, predictPath(site, start({ positionM: end, state: 'LOADING', stateSinceMs: NOW - 15_000 }), 'early', NOW + 600_000));
  assert.ok(e[0]!.tOut < v[0]!.tOut);
});

test('holding, idle, faulted and hand-driven trucks are not predicted to move; a charge never ends on the late bound', () => {
  const site = thisSite();
  for (const state of ['HOLDING', 'IDLE', 'FAULT', 'ESTOPPED', 'MANUAL'] as const) {
    const v = visits(site, predictPath(site, start({ positionM: 300, state }), 'early', NOW + 600_000));
    assert.equal(v.length, 1, state);
    assert.equal(v[0]!.tOut, Infinity, state);
  }
  const bayEnd = dutyStops(site).find((d) => d.kind === 'CHARGING')!.positionM;
  assert.equal(visits(site, predictPath(site, start({ positionM: bayEnd, state: 'CHARGING', socPct: 30 }), 'late', NOW + 600_000))[0]!.tOut, Infinity);
  const early = visits(site, predictPath(site, start({ positionM: bayEnd, state: 'CHARGING', socPct: 30 }), 'early', NOW + 600_000));
  assert.ok(early[0]!.tOut < NOW + 1_000, 'early: it may leave at once');
});

test('a truck reversing out under EXIT_ZONE is predicted to stop 2 m outside, behind it', () => {
  const site = thisSite();
  const south = site.zone('L4_SOUTH')!.ranges[0]!;
  const p = predictPath(site, start({ positionM: south.startM + 30, task: 'EXIT_ZONE', direction: 'REV', loaded: true }), 'late', NOW + 600_000);
  const v = visits(site, p);
  assert.deepEqual(v.map((x) => x.zoneId), ['L4_SOUTH', 'DRAW_12']);
  assert.ok(close((v[0]!.tOut - NOW) / 1000, 30 / PARAMS.reverseSpeedLoadedPlanning.value, 0.01), 'late bound: planning speed');
  assert.equal(v[1]!.tOut, Infinity);
});

test('L2.57 the last safe moment: fixed by the path, and Infinity when the truck is out on its own first', () => {
  const site = thisSite();
  const draw = site.zone('DRAW_12')!.ranges[0]!;
  const end = draw.startM + draw.lengthM - PARAMS.dutyStopBeforeEnd.value;
  // Loading with 10 s to go, the zone due in 30 s: EXIT_ZONE queues behind the load, then 6 s.
  const p = predictPath(site, start({ positionM: end, state: 'LOADING', stateSinceMs: NOW - 10_000 }), 'late', NOW + 600_000);
  const lsm = lastSafeMoment(site, p, 'DRAW_12', NOW, NOW + 30_000);
  assert.equal(lsm, Infinity, 'the load ends and it leaves forward before any command is needed');
  // An empty truck tramming into DECLINE with 120 s left: EXIT_ZONE back costs more each second
  // until it is past the middle; the last moment is when reverse distance + delay just fits.
  const dec = site.zone('DECLINE')!.ranges[0]!;
  const p2 = predictPath(site, start({ positionM: dec.startM + 1 }), 'late', NOW + 600_000);
  const lsm2 = lastSafeMoment(site, p2, 'DECLINE', NOW, NOW + 60_000)!;
  // At time t it is 1 + 3t m in; reverse at 3 m/s: t + 6 + (1 + 3t)/3 <= 60 -> t <= ~26.8 s
  assert.ok(lsm2 !== null && Number.isFinite(lsm2));
  assert.ok(close((lsm2 - NOW) / 1000, 26.8, 0.3), `${(lsm2 - NOW) / 1000}`);
  assert.equal(lastSafeMoment(site, p2, 'DECLINE', NOW, NOW + 5_000), null, 'not even now');
});

test('a different site: duty stops from segment kinds, a zone split over two segments, and the wrap', () => {
  const cfg = siteVariant({ trucks: 7, noticeMs: 60_000 });
  const site = buildSite(helloFor(cfg.route, cfg.loop_length_m, cfg.vehicles)).site;
  const kinds = dutyStops(site).map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['CHARGING', 'DUMPING', 'LOADING']);
  // Loaded, starting near the end of the loop: wraps, dumps at the dump segment's end, then empty.
  const v = visits(site, predictPath(site, start({ positionM: cfg.loop_length_m - 10, loaded: true }), 'late', NOW + 600_000));
  const names = v.map((x) => x.zoneId);
  assert.deepEqual(names.slice(0, 4), [cfg.route.at(-1)!.zone_id, cfg.route[0]!.zone_id, cfg.route[1]!.zone_id, cfg.route[2]!.zone_id]);
  const dumpZone = v[2]!;
  assert.ok((dumpZone.tOut - dumpZone.tIn) / 1000 > PARAMS.dumpTime.value / 1000, 'the dump stop is inside the dump zone');
  // The split zone is one visit, not two.
  const split = cfg.route.filter((r) => r.zone_id === cfg.route[4]!.zone_id).length;
  assert.equal(split, 2);
  assert.equal(names.filter((n) => n === cfg.route[4]!.zone_id).length, 1);
});
