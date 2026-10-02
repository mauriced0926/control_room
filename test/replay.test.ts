// TESTING.md L3: each fixture replayed through ingest and fleet state with injected time. The
// assertion is what the operator would see. Expected values are read from the fixture records
// themselves, not from the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../src/params.ts';
import type { FleetState } from '../src/fleet.ts';
import { fixture, thisSite, type FixtureRecord } from './helpers/fixtures.ts';
import { replay } from './helpers/rig.ts';

type Tm = { vehicle_id: string; seq: number; state: string; speed_mps: number; segment_id: string; offset_m: number; soc_pct: number };
const telemetryOf = (recs: FixtureRecord[], id: string) =>
  recs.filter((r) => r.kind === 'msg' && r.m?.type === 'telemetry' && r.m.vehicle_id === id).map((r) => ({ rx: r.rx_ms!, m: r.m as unknown as Tm }));
const truck = (f: FleetState, id: string) => f.snapshot().trucks.find((t) => t.vehicleId === id)!;

test('L3.1 frozen-truck: HT-10 contradicted within the threshold, shown as a range; HT-05 loading shown normally', () => {
  const recs = fixture('frozen-truck');
  const ht10 = telemetryOf(recs, 'HT-10');
  // From the raw records: the first TRAMMING message after the DUMPING ones is the frozen body.
  const lastDump = ht10.findLastIndex((x) => x.m.state === 'DUMPING');
  const frozenStart = ht10.slice(lastDump).find((x) => x.m.state === 'TRAMMING')!;
  assert.equal(frozenStart.m.speed_mps, 2);
  const frozenPos = thisSite().toLoop(frozenStart.m.segment_id, frozenStart.m.offset_m)!;
  assert.ok(ht10.slice(lastDump + 1).every((x) => x.m.offset_m === frozenStart.m.offset_m), 'every later HT-10 body has the same position');

  let contradictedAt: number | null = null;
  let ht05EverDoubted = false;
  const widths: number[] = [];
  replay(recs, {
    onRecord: (_r, f, c) => {
      const t = truck(f, 'HT-10');
      if (t.confidence === 'contradicted') {
        contradictedAt ??= c.now();
        widths.push(t.range!.lengthM);
        assert.ok(t.mightBeIn.length >= 1);
      }
      const h5 = truck(f, 'HT-05');
      if (h5.state && h5.confidence !== 'live' && h5.confidence !== 'unknown' && c.now() - (h5.lastMessageServerMs ?? 0) < PARAMS.truckOldAfter.value) ht05EverDoubted = true;
      if (h5.confidence === 'contradicted') ht05EverDoubted = true;
    },
  });
  assert.ok(contradictedAt !== null, 'HT-10 flagged');
  const delay = contradictedAt! - frozenStart.rx;
  assert.ok(delay >= PARAMS.frozenAfter.value && delay <= PARAMS.frozenAfter.value + 1_000, `flagged ${delay} ms after the freeze`);
  assert.ok(widths.at(-1)! > widths[0]! + 100, `range widens: ${widths[0]} -> ${widths.at(-1)}`);
  assert.equal(ht05EverDoubted, false, 'HT-05 loading is never shown as doubtful');
  // The range is anchored at the frozen position, which is at the end of the loop: it wraps into the bay.
  const { fleet } = replay(recs);
  const t = truck(fleet, 'HT-10');
  assert.equal(t.anchor?.loopM, frozenPos);
  assert.ok(t.mightBeIn.includes('BAY') && t.mightBeIn.includes('TIP'), t.mightBeIn.join(','));
});

test('L3.2 seq-reset: HT-01 keeps moving on screen across the reset; a "controller restarted" note', () => {
  const { fleet, events } = replay(fixture('seq-reset'));
  const t = truck(fleet, 'HT-01');
  assert.equal(t.confidence, 'live');
  assert.equal(t.run.restarts, 1);
  const notes = events.filter((e) => e.type === 'controller_restart');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.type === 'controller_restart' ? notes[0]!.detail : '', /887.*1/);
});

test('L3.3 silent-truck: HT-03 shown at its last position with a growing age, then silent; link healthy', () => {
  const recs = fixture('silent-truck');
  const ht03 = telemetryOf(recs, 'HT-03');
  // From the raw records: the longest gap between HT-03 messages.
  let gapIdx = 0;
  for (let i = 1; i < ht03.length; i++) if (ht03[i]!.rx - ht03[i - 1]!.rx > ht03[gapIdx + 1]!.rx - ht03[gapIdx]!.rx) gapIdx = i - 1;
  const after = ht03[gapIdx + 1]!;
  assert.ok(after.rx - ht03[gapIdx]!.rx > 50_000, `the gap is ${(after.rx - ht03[gapIdx]!.rx) / 1000} s`);
  // The last record before the gap is a duplicate of seq 449, so the truck's age runs from the
  // last message that advanced seq. After the gap seq resumes at 450: the controller sent nothing.
  const maxSeqBefore = Math.max(...ht03.slice(0, gapIdx + 1).map((x) => x.m.seq));
  const before = ht03.find((x) => x.m.seq === maxSeqBefore)!;
  assert.equal(ht03[gapIdx]!.m.seq, maxSeqBefore, 'the last record before the gap repeats the highest seq');
  assert.equal(after.m.seq, maxSeqBefore + 1, 'seq resumes where it stopped');
  const lastPos = thisSite().toLoop(before.m.segment_id, before.m.offset_m)!;

  const seen = new Map<string, number>();
  let heartbeatWorst = 0;
  replay(recs, {
    onRecord: (r, f, c) => {
      const now = c.now();
      if (now <= before.rx || now >= after.rx) return;
      const t = truck(f, 'HT-03');
      assert.equal(t.position?.value.loopM, lastPos, 'shown at its last position');
      assert.equal(t.ageMs, now - before.rx, 'with its age');
      if (!seen.has(t.confidence)) seen.set(t.confidence, now - before.rx);
      if (r.kind === 'msg' && r.m?.type === 'heartbeat') heartbeatWorst = Math.max(heartbeatWorst, f.snapshot().heartbeat.ageMs ?? Infinity);
      const hb = f.snapshot().heartbeat;
      assert.ok(hb.ageMs !== null && hb.ageMs < PARAMS.linkDownAfter.value, 'heartbeats show the link up');
      if (t.confidence === 'silent') assert.ok(t.range!.lengthM > 0);
    },
  });
  assert.ok(seen.get('silent')! >= PARAMS.truckSilentAfter.value && seen.get('silent')! < PARAMS.truckSilentAfter.value + 2_100);
  assert.ok(seen.has('old'));
});

test('L3.4 truncated-lines: nothing changes on screen; the data-quality count rises by 87', () => {
  const recs = fixture('truncated-lines');
  const expected = recs.filter((r) => r.kind === 'unparseable').length;
  assert.equal(expected, 87);
  const { fleet } = replay(recs);
  const snap = fleet.snapshot();
  assert.equal(snap.dataQuality.total.unparseable, 87);
  assert.ok(snap.trucks.every((t) => t.confidence === 'unknown' && t.state === null), 'no truck state invented from the fragments');
});

test('L3.5 fractional-soc: HT-12 SoC shown as reported, with a flag, not as 82 %', () => {
  const recs = fixture('fractional-soc');
  const last = telemetryOf(recs, 'HT-12').at(-1)!;
  const { fleet } = replay(recs);
  const t = truck(fleet, 'HT-12');
  assert.ok(last.m.soc_pct <= 1);
  assert.equal(t.socPct?.value, last.m.soc_pct);
  assert.equal(t.socFractional, true);
  assert.equal(t.dataQuality['soc_pct:fractional'], 1);
});

test('L3.8 two-zones-closing: both zones shown closing, each with its own countdown and trucks', () => {
  const recs = fixture('two-zones-closing');
  const hello = recs.find((r) => r.m?.type === 'hello')!.m as { server_time_ms: number; zones: Array<{ zone_id: string; status: string; effective_at_ms: number }> };
  const closing = hello.zones.filter((z) => z.status === 'CLOSING');
  assert.deepEqual(closing.map((z) => z.zone_id).sort(), ['DRAW_12', 'TIP']);
  const states: string[] = [];
  replay(recs, {
    hello: false,
    onRecord: (r, f, c) => {
      const snap = f.snapshot();
      if (r.m?.type === 'hello') {
        for (const z of closing) {
          const v = snap.zones.find((x) => x.zoneId === z.zone_id)!;
          assert.equal(v.status, 'CLOSING');
          assert.equal(v.effectiveAtMs, z.effective_at_ms);
          assert.equal(v.msUntilEffective, z.effective_at_ms - f.serverNow());
          // No telemetry yet: every truck might be anywhere, so every truck might be in each zone.
          assert.equal(v.trucksMightBeIn.length, thisSite().vehicles.length);
        }
        const draw = snap.zones.find((x) => x.zoneId === 'DRAW_12')!, tip = snap.zones.find((x) => x.zoneId === 'TIP')!;
        assert.notEqual(draw.msUntilEffective, tip.msUntilEffective, 'separate countdowns');
      }
      states.push(snap.zones.filter((z) => z.zoneId === 'DRAW_12' || z.zoneId === 'TIP').map((z) => `${z.zoneId}:${z.status}`).join(' '));
      void c;
    },
  });
  assert.deepEqual(states, [
    'DRAW_12:CLOSING TIP:CLOSING',
    'DRAW_12:CLOSING TIP:CLOSED',
    'DRAW_12:CLOSED TIP:CLOSED',
    'DRAW_12:OPEN TIP:CLOSED',
    'DRAW_12:OPEN TIP:OPEN',
  ]);
});

test('L3.9 (fleet-state half) link-drop-in-notice: heartbeat goes stale; on reconnect DRAW_12 still closing, time left recalculated', () => {
  const recs = fixture('link-drop-in-notice');
  const closing = recs.find((r) => r.m?.type === 'zone_event')!.m as { effective_at_ms: number };
  let worstHeartbeatAge = 0;
  const { fleet } = replay(recs, {
    hello: false,
    onRecord: (_r, f) => { worstHeartbeatAge = Math.max(worstHeartbeatAge, f.snapshot().heartbeat.ageMs ?? 0); },
  });
  assert.ok(worstHeartbeatAge > PARAMS.linkDownAfter.value, 'the outage shows as stale heartbeats');
  const z = fleet.snapshot().zones.find((x) => x.zoneId === 'DRAW_12')!;
  assert.equal(z.status, 'CLOSING');
  assert.equal(z.effectiveAtMs, closing.effective_at_ms);
  assert.ok(z.msUntilEffective! < 120_000 - 45_000, `${z.msUntilEffective} ms left after a 45 s outage`);
});
