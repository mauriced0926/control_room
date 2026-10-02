// TESTING.md L2.20-L2.23: restart versus duplicate. Order by seq within a controller run; a large
// seq drop while the device clock moves forward is a new run, not a flood of duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, replay, T0 } from './helpers/rig.ts';
import { fixture, thisSite } from './helpers/fixtures.ts';

test('L2.20 same seq, same body: duplicate, dropped', () => {
  const r = rig();
  r.send({ seq: 5, offset_m: 20 });
  r.advance(300);
  r.send({ seq: 5, offset_m: 20 });
  const t = r.truck();
  assert.equal(t.radio.duplicates, 1);
  assert.equal(t.radio.applied, 1);
  assert.equal(t.lastMessageServerMs, T0, 'a duplicate does not make the truck look fresher');
});

test('L2.20 same seq, different body: dropped and counted as a conflict', () => {
  const r = rig();
  r.send({ seq: 5, offset_m: 20 });
  r.send({ seq: 5, offset_m: 25 });
  assert.equal(r.truck().position?.value.offsetM, 20);
  assert.equal(r.truck().dataQuality['seq:conflict'], 1);
});

test('L2.21 lower seq within the reorder window: older, does not overwrite newer state', () => {
  const r = rig();
  r.send({ seq: 10, t_device_ms: T0 + 2_000, offset_m: 100 });
  r.advance(100);
  r.send({ seq: 8, t_device_ms: T0 + 1_600, offset_m: 96 });
  const t = r.truck();
  assert.equal(t.position?.value.offsetM, 100);
  assert.equal(t.radio.older, 1);
  assert.equal(t.run.restarts, 0);
  // The late message is remembered: its own duplicate is a duplicate, not new data.
  r.send({ seq: 8, t_device_ms: T0 + 1_600, offset_m: 96 });
  assert.equal(r.truck().radio.duplicates, 1);
});

test('L2.22 seq drops by more than the window while t_device_ms moves forward: a new controller run', () => {
  const r = rig();
  r.send({ seq: 887, t_device_ms: T0 + 10_000, offset_m: 100 });
  r.advance(200);
  r.send({ seq: 1, t_device_ms: T0 + 10_200, offset_m: 100.4 });
  let t = r.truck();
  assert.equal(t.run.restarts, 1);
  assert.equal(t.position?.value.offsetM, 100.4, 'the new run is applied');
  assert.ok(r.events.some((e) => e.type === 'controller_restart' && e.vehicleId === 'HT-01'));
  // A late message from the old run, with a higher seq but an older device time, is old news.
  r.advance(200);
  r.send({ seq: 885, t_device_ms: T0 + 9_600, offset_m: 99.2 });
  t = r.truck();
  assert.equal(t.position?.value.offsetM, 100.4);
  assert.equal(t.run.restarts, 1);
  assert.equal(t.radio.older, 1);
  r.send({ seq: 2, t_device_ms: T0 + 10_400, offset_m: 100.8 });
  assert.equal(r.truck().position?.value.offsetM, 100.8);
});

test('L2.22 a counter that restarts while still small is a restart too', () => {
  const r = rig();
  r.send({ seq: 30, t_device_ms: T0 + 6_000, offset_m: 50 });
  r.advance(200);
  r.send({ seq: 1, t_device_ms: T0 + 6_200, offset_m: 50.6 });
  assert.equal(r.truck().run.restarts, 1);
  assert.equal(r.truck().position?.value.offsetM, 50.6);
});

test('L2.22 fixture seq-reset: HT-01 keeps moving across the reset, one restart noted', () => {
  const site = thisSite();
  const positions: number[] = [];
  const { fleet, events } = replay(fixture('seq-reset'), {
    onRecord: (_r, f) => {
      const p = f.snapshot().trucks.find((t) => t.vehicleId === 'HT-01')?.position?.value.loopM;
      if (p !== undefined) positions.push(p);
    },
  });
  const t = fleet.snapshot().trucks.find((x) => x.vehicleId === 'HT-01')!;
  assert.equal(t.run.restarts, 1);
  assert.equal(events.filter((e) => e.type === 'controller_restart').length, 1);
  // Last line of the fixture: seq 47 at SEG-L4S-1 191.3.
  assert.equal(t.position?.value.loopM, site.toLoop('SEG-L4S-1', 191.3));
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i]! >= positions[i - 1]!, `position went backwards at step ${i}`);
  assert.equal(t.confidence, 'live');
  // The fixture's duplicate of seq 1 after the reset is dropped as a duplicate.
  assert.ok(t.radio.duplicates >= 1);
});

test('L2.23 seq drops and t_device_ms goes backwards: reordering, not a restart', () => {
  const r = rig();
  r.send({ seq: 900, t_device_ms: T0 + 180_000, offset_m: 100 });
  r.advance(200);
  r.send({ seq: 100, t_device_ms: T0 + 20_000, offset_m: 10 });
  const t = r.truck();
  assert.equal(t.run.restarts, 0);
  assert.equal(t.position?.value.offsetM, 100);
  assert.equal(t.radio.older, 1);
});

test('without a usable device clock, a lower seq is never taken as a restart', () => {
  const r = rig();
  r.send({ seq: 900, offset_m: 100 });
  r.advance(200);
  r.send({ seq: 1, t_device_ms: 'soon', offset_m: 10 });
  assert.equal(r.truck().run.restarts, 0);
  assert.equal(r.truck().position?.value.offsetM, 100);
  assert.equal(r.truck().dataQuality['t_device_ms:invalid'], 1);
});
