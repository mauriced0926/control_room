// The Overview's words and order (task 6a; UI.md "States each screen must show"), checked on real
// fixture replays. Expected values come from the fixture records or the fleet's own view, not from
// the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallMemory, clearanceRows, fleetRows, restartMarker, serviceLink, siteLink, TIERS, type ClearanceRow } from '../src/ui/overview.ts';
import { Replayer } from './helpers/rig.ts';
import { age, countdown, elapsed } from '../src/words.ts';
import { PARAMS } from '../src/params.ts';
import type { FleetSnapshot } from '../src/fleet.ts';
import { fixture } from './helpers/fixtures.ts';
import { replay, rig } from './helpers/rig.ts';

test('words: ages count whole seconds up, countdowns round up and never show 0:00 early', () => {
  assert.equal(age(0), '0 s');
  assert.equal(age(4_999), '4 s');
  assert.equal(age(89_000), '89 s');
  assert.equal(age(92_000), '1 min 32 s');
  assert.equal(age(2 * 3_600_000 + 60_000), '2 h 1 min');
  assert.equal(countdown(120_000), '2:00');
  assert.equal(countdown(83_001), '1:24');
  assert.equal(countdown(1), '0:01');
  assert.equal(countdown(0), '0:00');
  assert.equal(elapsed(3_900), '0:03', 'time since rounds down, like an age');
  assert.equal(elapsed(65_000), '1:05');
});

test('two-zones-closing: one row per closing zone, each with its own countdown; UNSURE while nothing has reported', () => {
  const recs = fixture('two-zones-closing');
  const hello = recs.find((r) => r.m?.type === 'hello')!.m as { server_time_ms: number; zones: Array<{ zone_id: string; status: string; effective_at_ms: number }> };
  const { fleet } = replay(recs.slice(0, 2), { hello: false });
  const rows = clearanceRows(fleet.snapshot());
  const closing = hello.zones.filter((z) => z.status === 'CLOSING');
  assert.deepEqual(rows.map((r) => r.zoneId), closing.map((z) => z.zone_id), 'only the closing zones, in route order');
  for (const r of rows) {
    const z = closing.find((x) => x.zone_id === r.zoneId)!;
    assert.equal(r.verdictWords, 'UNSURE');
    assert.equal(r.action, 'Radio the shot firer to hold the shot');
    assert.equal(r.when, `closes in ${countdown(z.effective_at_ms - fleet.serverNow())}`);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0]!, /never reported: could be anywhere/);
  }
  assert.notEqual(rows[0]!.when, rows[1]!.when);
});

test('two-zones-closing: a CLOSED zone says how long ago it closed', () => {
  const recs = fixture('two-zones-closing');
  const { fleet, clock } = replay(recs.slice(0, 3), { hello: false });
  clock.advance(65_000);
  const tip = clearanceRows(fleet.snapshot()).find((r) => r.zoneId === 'TIP')!;
  assert.equal(tip.status, 'CLOSED');
  assert.match(tip.when, /^closed 1:0[45] ago$/);
});

test('link-drop-in-notice: the site link reads DOWN with a growing age; a recording with no heartbeats says so instead', () => {
  const recs = fixture('link-drop-in-notice');
  const texts: string[] = [];
  replay(recs, { onRecord: (_r, f) => texts.push(siteLink(f.snapshot()).text) });
  assert.match(texts[1]!, /^Site link up/);
  const downs = texts.filter((t) => t.startsWith('Site link DOWN'));
  assert.ok(downs.length >= 5, texts.join('\n'));
  assert.match(downs.at(-1)!, /no heartbeat for 4\d s/);
  const { fleet } = replay(fixture('frozen-truck'));
  assert.deepEqual(siteLink(fleet.snapshot(), false), { state: 'not recorded', text: 'Site link: not in this recording' });
});

test('service link: disconnected once frames stop', () => {
  assert.equal(serviceLink(500, 3_000).state, 'up');
  assert.equal(serviceLink(3_000, 3_000).text, 'Service DISCONNECTED: nothing for 3 s');
  assert.equal(serviceLink(null, 3_000).state, 'down');
  assert.deepEqual(serviceLink(800, 3_000, false), { state: 'down', text: 'Service DISCONNECTED: nothing for 0 s' }, 'a closed connection is down at once');
});

test('site link: the live service\'s own "link down" is down at once, before the heartbeat goes stale', () => {
  const { fleet } = replay(fixture('link-drop-in-notice'));
  const snap = fleet.snapshot();
  const fresh = { ...snap, heartbeat: { lastServerMs: 1, ageMs: 1_200, stale: false } };
  assert.equal(siteLink({ ...fresh, link: { up: true, sinceServerMs: 0, reason: 'connected' } }).state, 'up');
  assert.deepEqual(siteLink({ ...fresh, link: { up: false, sinceServerMs: 0, reason: 'connection closed' } }), { state: 'down', text: 'Site link DOWN: no heartbeat for 1 s' });
  assert.equal(siteLink({ ...fresh, link: { up: null, sinceServerMs: null, reason: 'not connected yet' } }).state, 'up', 'the player reports no link of its own');
});

test('the last-command column shows what the live service says, and a dash otherwise', () => {
  const { fleet } = replay(fixture('frozen-truck'));
  const rows = fleetRows(fleet.snapshot(), new Map([['HT-10', 'HOLD by priya: accepted, not carried out yet']]));
  assert.equal(rows.find((r) => r.vehicleId === 'HT-10')!.lastCommand, 'HOLD by priya: accepted, not carried out yet');
  assert.equal(rows.find((r) => r.vehicleId === 'HT-05')!.lastCommand, '—');
});

test('silent-truck: HT-03 is the first row, "silent N s", last seen where it was', () => {
  let snap: FleetSnapshot | null = null;
  replay(fixture('silent-truck'), {
    onRecord: (_r, f) => {
      const t = f.snapshot().trucks.find((x) => x.vehicleId === 'HT-03')!;
      if (!snap && t.confidence === 'silent' && t.ageMs! >= 20_000) snap = f.snapshot();
    },
  });
  const rows = fleetRows(snap!);
  assert.equal(rows[0]!.vehicleId, 'HT-03');
  assert.equal(rows[0]!.dataKind, 'silent');
  assert.match(rows[0]!.data, /^silent 2\d s$/);
  assert.match(rows[0]!.zone, /^last seen \w+; could be in /);
  assert.equal(rows[0]!.lastCommand, '—');
});

test('fractional-soc: HT-12 shown as sent, flagged, not scaled to a percentage', () => {
  const recs = fixture('fractional-soc');
  const last = recs.filter((r) => r.m?.vehicle_id === 'HT-12').at(-1)!.m as { soc_pct: number };
  const { fleet } = replay(recs);
  const row = fleetRows(fleet.snapshot()).find((r) => r.vehicleId === 'HT-12')!;
  assert.equal(row.soc, `${last.soc_pct} (as sent)`);
  assert.ok(row.socFlags.some((f) => /fraction/.test(f)));
  assert.equal(row.tier, TIERS.indexOf('battery figure doubted'));
});

test('weak-pack: HT-06 flagged draining fast, then warned, then depleted with a tow; it rises to the top', () => {
  const seen = { drain: null as number | null, warn: null as number | null, depleted: null as number | null };
  let topWhenWarned: string | undefined;
  const { start } = replay(fixture('weak-pack'), {
    onRecord: (_r, f, c) => {
      const rows = fleetRows(f.snapshot());
      const r = rows.find((x) => x.vehicleId === 'HT-06')!;
      if (seen.drain === null && r.socFlags.some((x) => /draining \d+\.\d× faster/.test(x))) seen.drain = c.now();
      if (seen.warn === null && r.socFlags.some((x) => /reach the bay|finish its lap/.test(x))) { seen.warn = c.now(); topWhenWarned = rows[0]!.vehicleId; }
      if (seen.depleted === null && r.socFlags.includes('depleted: needs a tow')) {
        seen.depleted = c.now();
        assert.equal(r.fault, 'BATTERY_DEPLETED');
        assert.equal(r.attention, 'faulted (BATTERY_DEPLETED)');
        assert.equal(rows[0]!.vehicleId, 'HT-06');
      }
    },
  });
  assert.ok(seen.drain !== null && seen.drain - start < 60_000, `drain flagged ${seen.drain! - start} ms in`);
  assert.ok(seen.warn !== null && seen.depleted !== null && seen.warn < seen.depleted, 'warned before it died');
  assert.equal(topWhenWarned, 'HT-06');
});

test('a truck that might be in a closing zone outranks everything, and its zone cell is marked', () => {
  const r = rig();
  const ids = r.fleet.site!.vehicles;
  ids.forEach((id, i) => r.send({ vehicle_id: id, seq: 1, state: 'IDLE', speed_mps: 0, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 5 + i }));
  r.send({ vehicle_id: ids[1], seq: 2, state: 'FAULT', speed_mps: 0, faults: ['HYD_PRESSURE_LOW'], segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 7 });
  r.send({ vehicle_id: ids[5], seq: 2, state: 'TRAMMING', speed_mps: 3, segment_id: 'SEG-INC-1', zone_id: 'INCLINE', offset_m: 50 });
  r.fleet.ingest({ type: 'zone_event', zone_id: 'INCLINE', status: 'CLOSING', reason: 'BLAST_WINDOW', effective_at_ms: r.clock.now() + 120_000, server_time_ms: r.clock.now() });
  const rows = fleetRows(r.fleet.snapshot());
  assert.deepEqual(rows.slice(0, 2).map((x) => x.vehicleId), [ids[5], ids[1]]);
  assert.equal(rows[0]!.attention, 'in INCLINE (CLOSING)');
  assert.equal(rows[0]!.zoneAlert, 'INCLINE CLOSING');
  assert.equal(rows[1]!.attention, 'faulted (HYD_PRESSURE_LOW)');
  assert.equal(rows[1]!.state, 'FAULT');
});

test('old: the row says "old N s" between the old and silent thresholds', () => {
  const r = rig();
  r.send({ seq: 1 });
  r.advance(PARAMS.truckOldAfter.value + 1_200);
  const row = fleetRows(r.fleet.snapshot()).find((x) => x.vehicleId === r.fleet.site!.vehicles[0])!;
  assert.equal(row.data, 'old 3 s');
  assert.equal(row.dataKind, 'old');
});

test('link-drop-in-notice (UI.md, BLAST.md B13): while the site link is down, a closing zone is UNSURE whatever the data said, with the last call in grey beneath it and its age', () => {
  const recs = fixture('link-drop-in-notice');
  const memory = new CallMemory();
  const seen: Array<{ down: boolean; row: ClearanceRow | undefined }> = [];
  const r = new Replayer(recs, { hello: null });
  for (let t = r.start; t <= r.end; t += 500) {
    r.advanceTo(t);
    const snap = r.fleet.snapshot();
    const down = siteLink(snap).state === 'down';
    seen.push({ down, row: clearanceRows(snap, { linkDown: down, memory }).find((x) => x.zoneId === 'DRAW_12') });
  }
  const before = seen.find((s) => !s.down && s.row);
  assert.ok(before, 'a call made with the link up');
  const during = seen.filter((s) => s.down && s.row);
  assert.ok(during.length > 40, `${during.length} samples with the link down and DRAW_12 closing`);
  for (const s of during) {
    assert.equal(s.row!.verdictWords, 'UNSURE');
    assert.equal(s.row!.linkDown, true);
    assert.equal(s.row!.action, 'Radio the shot firer to hold the shot');
    assert.match(s.row!.reasons[0]!, /^Site link down/);
    assert.ok(s.row!.was, 'the last call is shown');
  }
  const ages = during.map((s) => s.row!.was!.agoMs);
  assert.ok(ages.at(-1)! > ages[0]! + 30_000, `its age grows: ${ages[0]} to ${ages.at(-1)}`);
  assert.equal(during[0]!.row!.was!.verdictWords, before.row!.verdictWords, 'the call from before the drop');
  assert.equal(during[0]!.row!.was!.verdictWords, 'CLEAR', 'here the last call before the drop was CLEAR: exactly what must not stay on screen');
});

test('the call memory forgets a zone when it reopens, so an earlier blast\'s call is never shown as this one\'s', () => {
  const m = new CallMemory();
  m.call('Z', 'CLEAR', 1);
  m.forgetOpen({ zones: [{ zoneId: 'Z', status: 'OPEN' }] } as unknown as FleetSnapshot);
  assert.equal(m.call('Z', null, 2), null);
});

test('UI.md: a controller restart marks the data column for about a minute, then the marker goes', () => {
  assert.equal(restartMarker(1_000, 13_500), 'controller restarted 12 s ago');
  assert.equal(restartMarker(1_000, 1_000 + PARAMS.restartMarkerFor.value), null);
  assert.equal(restartMarker(undefined, 5), null);
  const { fleet } = replay(fixture('seq-reset'));
  const snap = fleet.snapshot();
  const rows = fleetRows(snap, new Map(), new Map([['HT-01', snap.atServerMs - 5_000]]));
  assert.equal(rows.find((r) => r.vehicleId === 'HT-01')!.restarted, 'controller restarted 5 s ago');
  assert.ok(rows.filter((r) => r.vehicleId !== 'HT-01').every((r) => r.restarted === null));
});
