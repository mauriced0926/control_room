// What the gateway link and the command registry need from fleet state: the link's status, one
// truck's view on its own, and when a truck's reported state last changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers/rig.ts';

test('L2.43 while the link is down nothing is live, however recent its last message', () => {
  const r = rig();
  r.fleet.setLink(true, 'connected');
  r.send({ seq: 1 });
  assert.equal(r.truck().confidence, 'live');
  r.fleet.setLink(false, 'connection closed by the gateway');
  const t = r.truck();
  assert.equal(t.confidence, 'old');
  assert.match(t.confidenceReason, /site link down/);
  const snap = r.fleet.snapshot();
  assert.equal(snap.link.up, false);
  assert.equal(snap.link.reason, 'connection closed by the gateway');
  // It keeps ageing into silence on its own.
  r.advance(6_000);
  assert.equal(r.truck().confidence, 'silent');
  // A confidence event went out when the link dropped, without waiting for a tick.
  assert.ok(r.events.some((e) => e.type === 'confidence' && e.to === 'old' && /site link down/.test(e.reason)));
});

test('the link coming back does not make old data live; fresh messages do', () => {
  const r = rig();
  r.fleet.setLink(true, 'connected');
  r.send({ seq: 1 });
  r.fleet.setLink(false, 'down');
  r.advance(1_000);
  r.fleet.setLink(true, 'connected');
  assert.equal(r.truck().confidence, 'live', 'its last message is 1 s old, under the old threshold');
  r.advance(3_000);
  assert.equal(r.truck().confidence, 'old');
  r.send({ seq: 2, offset_m: 22 });
  assert.equal(r.truck().confidence, 'live');
});

test('truck(id) gives the same view as the snapshot, and undefined for an unknown truck', () => {
  const r = rig();
  r.send({ seq: 1 });
  r.advance(300);
  assert.deepEqual(r.fleet.truck('HT-01'), r.fleet.snapshot().trucks.find((t) => t.vehicleId === 'HT-01'));
  assert.equal(r.fleet.truck('nope'), undefined);
});

test('stateSinceServerMs is when the reported state changed, not when it was last reported', () => {
  const r = rig();
  r.send({ seq: 1, state: 'TRAMMING' });
  r.advance(1_000);
  const since = r.fleet.serverNow();
  r.send({ seq: 2, state: 'LOADING', speed_mps: 0 });
  r.advance(5_000);
  r.send({ seq: 3, state: 'LOADING', speed_mps: 0 });
  assert.equal(r.truck().stateSinceServerMs, since);
});
