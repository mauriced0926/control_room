// TESTING.md L2.1-L2.6: loop geometry, time to clear, reachable ranges and the zones they touch.
// This site's numbers come from its real hello; every rule is also checked on a different site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneExit, timeToClearMs, reachableRange, rangesOverlap, zonesOverlapping, forwardDistance, normalise } from '../src/geometry.ts';
import { PARAMS } from '../src/params.ts';
import { thisSite, otherSite } from './helpers/fixtures.ts';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test('normalise and forward distance wrap at the loop end', () => {
  const site = thisSite();
  const L = site.loopLengthM;
  assert.equal(normalise(L, L), 0);
  assert.equal(normalise(L, -10), L - 10);
  assert.equal(forwardDistance(L, L - 10, 15), 25);
  assert.equal(forwardDistance(L, 15, L - 10), L - 25);
  assert.equal(forwardDistance(L, 42, 42), 0);
});

test('L2.1 distance to each boundary of the current zone, this site', () => {
  const site = thisSite();
  // In TIP, the last zone: forward runs to the loop end and wraps to 0.
  const tip = site.zone('TIP')!.ranges[0]!;
  const p = tip.startM + 20;
  const e = zoneExit(site, p)!;
  assert.equal(e.zoneId, 'TIP');
  assert.ok(close(e.revM, 20));
  assert.ok(close(e.fwdM, tip.lengthM - 20));
  assert.ok(close(e.fwdBoundaryM, 0), 'the forward boundary of the last zone is 0, across the wrap');
  // In BAY, the first zone: reverse runs back across the wrap.
  const bay = site.zone('BAY')!.ranges[0]!;
  const b = zoneExit(site, 5)!;
  assert.equal(b.zoneId, 'BAY');
  assert.ok(close(b.revM, 5));
  assert.ok(close(b.fwdM, bay.lengthM - 5));
  assert.ok(close(b.revBoundaryM, 0));
  // Positions given past the loop end wrap.
  assert.equal(zoneExit(site, site.loopLengthM + 5)!.zoneId, 'BAY');
});

test('L2.1 distance to each boundary, for a zone that itself wraps (different site)', () => {
  const site = otherSite();
  // North is [850, 900) + [0, 100): one 150 m range across the wrap.
  const inTail = zoneExit(site, 870)!;
  assert.equal(inTail.zoneId, 'North');
  assert.ok(close(inTail.revM, 20));
  assert.ok(close(inTail.fwdM, 130));
  const inHead = zoneExit(site, 20)!;
  assert.equal(inHead.zoneId, 'North');
  assert.ok(close(inHead.revM, 70));
  assert.ok(close(inHead.fwdM, 80));
  assert.ok(close(inHead.fwdBoundaryM, 100));
  assert.ok(close(inHead.revBoundaryM, 850));
});

test('L2.2 nearer boundary and direction for every zone, at each end and in the middle', () => {
  for (const site of [thisSite(), otherSite()]) {
    for (const z of site.zones) {
      for (const r of z.ranges) {
        const nearStart = zoneExit(site, r.startM + 1)!;
        assert.equal(nearStart.zoneId, z.zoneId);
        assert.equal(nearStart.direction, 'REV', `${z.zoneId} near its start`);
        assert.ok(close(nearStart.distanceM, 1));
        const nearEnd = zoneExit(site, r.startM + r.lengthM - 1)!;
        assert.equal(nearEnd.direction, 'FWD', `${z.zoneId} near its end`);
        assert.ok(close(nearEnd.distanceM, 1));
        const mid = zoneExit(site, r.startM + r.lengthM / 2)!;
        assert.equal(mid.direction, 'FWD', `${z.zoneId} middle: a tie goes forward, the normal direction of travel`);
        assert.ok(close(mid.distanceM, r.lengthM / 2));
        const justPastMid = zoneExit(site, r.startM + r.lengthM / 2 - 0.5)!;
        assert.equal(justPastMid.direction, 'REV');
      }
    }
  }
});

test('L2.3 time to clear is distance over speed plus the command delay, by load and direction', () => {
  const delay = PARAMS.supervisoryDelayMax.value;
  assert.equal(timeToClearMs(300, { loaded: false, direction: 'FWD' }), (300 / PARAMS.autoSpeedEmpty.value) * 1000 + delay);
  assert.equal(timeToClearMs(300, { loaded: true, direction: 'FWD' }), (300 / PARAMS.autoSpeedLoaded.value) * 1000 + delay);
  assert.equal(timeToClearMs(300, { loaded: false, direction: 'REV' }), (300 / PARAMS.reverseSpeedEmpty.value) * 1000 + delay);
  assert.equal(timeToClearMs(300, { loaded: true, direction: 'REV' }), (300 / PARAMS.reverseSpeedLoaded.value) * 1000 + delay);
  // The loaded reverse speed is assumed, so it is a parameter: the pessimistic 1.5 m/s of L0.P.
  assert.equal(timeToClearMs(300, { loaded: true, direction: 'REV', speedMps: 1.5 }), 200_000 + delay);
  // This site: crossing all of DECLINE empty takes about 167 s, longer than a 120 s notice.
  const decline = thisSite().zone('DECLINE')!;
  const crossing = timeToClearMs(decline.lengthM, { loaded: false, direction: 'FWD' }) - delay;
  assert.ok(close(crossing / 1000, 166.67, 0.01));
  assert.equal(timeToClearMs(0, { loaded: false, direction: 'FWD' }), delay);
});

test('L2.4 reachable range for a frozen truck grows with time from its last position that moved', () => {
  const site = thisSite();
  const L = site.loopLengthM;
  const anchor = 1599.95; // the frozen-truck fixture's last believable position, at the end of the loop
  const at = (ms: number) => reachableRange(L, anchor, ms, 3, 3);
  const r10 = at(10_000);
  assert.ok(close(r10.startM, anchor - 30));
  assert.ok(close(r10.lengthM, 60));
  assert.ok(r10.startM + r10.lengthM > L, 'wraps past the loop end');
  const r60 = at(60_000);
  assert.ok(r60.lengthM > r10.lengthM, 'a frozen truck\'s range widens with time');
  // Forward only, for a truck that cannot reverse.
  const fwd = reachableRange(L, 100, 10_000, 2, 0);
  assert.deepEqual(fwd, { startM: 100, lengthM: 20 });
  // Never more than the whole loop.
  const all = reachableRange(L, 100, 3_600_000, 3, 3);
  assert.deepEqual(all, { startM: 0, lengthM: L });
  assert.deepEqual(reachableRange(L, 100, 0, 3, 3), { startM: 100, lengthM: 0 });
});

test('L2.5 reachable range for a silent truck, the same way, from its last message (different site)', () => {
  const site = otherSite();
  const r = reachableRange(site.loopLengthM, 880, 10_000, 3, 1);
  assert.ok(close(r.startM, 870));
  assert.ok(close(r.lengthM, 40));
  assert.deepEqual(zonesOverlapping(site, r), ['North'], 'covers 870..910 = 870..900 and 0..10, all North');
});

test('L2.6 a range that straddles a boundary counts as inside both zones; touching counts', () => {
  const site = thisSite();
  const draw = site.zone('DRAW_12')!.ranges[0]!;
  const straddle = { startM: draw.startM - 5, lengthM: 10 };
  assert.deepEqual(zonesOverlapping(site, straddle), ['L4_NORTH', 'DRAW_12']);
  const touching = { startM: draw.startM + draw.lengthM, lengthM: 0 };
  assert.deepEqual(zonesOverlapping(site, touching).sort(), ['DRAW_12', 'L4_SOUTH'].sort(), 'exactly on a boundary: both');
  // Across the wrap: end of TIP into BAY.
  const wrap = { startM: site.loopLengthM - 10, lengthM: 20 };
  assert.deepEqual(zonesOverlapping(site, wrap), ['BAY', 'TIP']);
  // The whole loop is in every zone.
  assert.equal(zonesOverlapping(site, { startM: 0, lengthM: site.loopLengthM }).length, site.zones.length);
  // A zone in two stretches (different site) is found through either.
  const other = otherSite();
  assert.ok(zonesOverlapping(other, { startM: 30, lengthM: 5 }).includes('North'));
  assert.ok(rangesOverlap(other.loopLengthM, { startM: 890, lengthM: 20 }, { startM: 0, lengthM: 5 }));
  assert.ok(!rangesOverlap(other.loopLengthM, { startM: 200, lengthM: 20 }, { startM: 300, lengthM: 5 }));
});
