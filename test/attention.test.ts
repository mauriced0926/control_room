// The alarm store behind the attention tray: TESTING.md L2.62-L2.64, and the acknowledgement rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlarmRaise } from '../src/alarms.ts';
import { AlarmStore, alertsFor, type Person, type StoreEvent } from '../src/attention.ts';
import { PARAMS } from '../src/params.ts';

const T0 = 1_790_000_000_000;
const MIN = 60_000;
const PRIYA: Person = { id: 'priya', name: 'Priya', role: 'operator' };
const DAVE: Person = { id: 'dave', name: 'Dave', role: 'operator' };
const MARTA: Person = { id: 'marta', name: 'Marta', role: 'supervisor' };

function raise(o: Partial<AlarmRaise> = {}): AlarmRaise {
  return {
    type: 'raise', source: 'blast', kind: 'cant_clear', key: 'blast:cant_clear:HT-04:INCLINE', vehicleId: 'HT-04', zoneId: 'INCLINE',
    message: 'HT-04 cannot get out of INCLINE in time', action: 'Radio the shot firer to hold the shot', interrupt: true, rule: 'B9', atServerMs: T0, ...o,
  };
}

function rig() {
  const s = new AlarmStore();
  const events: StoreEvent[] = [];
  s.subscribe((e) => events.push(e));
  const alerts = () => events.filter((e) => e.type === 'alert').map((e) => (e as Extract<StoreEvent, { type: 'alert' }>).alert);
  return { s, events, alerts };
}

test('L2.64 one cause, one alarm: the same key raised again while open updates the words and does not alert again', () => {
  const { s, alerts } = rig();
  s.raise(raise());
  s.raise(raise({ message: 'HT-04 still cannot get out', atServerMs: T0 + 5_000 }));
  s.raise(raise({ atServerMs: T0 + 9_000 }));
  assert.equal(s.list().length, 1);
  assert.equal(alerts().length, 1, 'one alert, at the first raise');
  assert.equal(s.get('blast:cant_clear:HT-04:INCLINE')!.raisedAtServerMs, T0);
  // A different truck is a different cause.
  s.raise(raise({ key: 'blast:cant_clear:HT-05:INCLINE', vehicleId: 'HT-05' }));
  assert.equal(alerts().length, 2);
});

test('L2.64 a silent alarm raised again as an interrupt is upgraded, and that alerts; the clocks start from the upgrade', () => {
  const { s, alerts } = rig();
  s.raise(raise({ key: 'link:down', source: 'link', interrupt: false, rule: 'no zone closing' }));
  assert.equal(alerts().length, 0, 'silent: no alert');
  s.raise(raise({ key: 'link:down', source: 'link', interrupt: true, rule: 'zone closing', atServerMs: T0 + 60_000 }));
  assert.deepEqual(alerts().map((a) => a.why), ['upgraded']);
  const item = s.get('link:down')!;
  assert.equal(item.interrupt, true);
  assert.equal(item.interruptSinceServerMs, T0 + 60_000);
  s.raise(raise({ key: 'link:down', source: 'link', interrupt: false, atServerMs: T0 + 70_000 }));
  assert.equal(s.get('link:down')!.interrupt, true, 'never quietly downgraded while open');
});

test('L2.62 a silent item never alerts, carries the rule that kept it silent, and leaves the tray when cleared', () => {
  const { s, alerts } = rig();
  s.raise(raise({ key: 'data:controller_restart:HT-01', kind: 'controller_restart', source: 'data', interrupt: false, rule: 'L2.61: a controller restart needs no action' }));
  s.tick(T0 + 40 * MIN, [PRIYA]);
  assert.equal(alerts().length, 0, 'not at 15 min, not at 30');
  assert.equal(s.list()[0]!.rule, 'L2.61: a controller restart needs no action');
  assert.equal(s.acknowledge('data:controller_restart:HT-01', PRIYA, T0).ok, false, 'nothing to acknowledge');
  s.clear('data:controller_restart:HT-01', 'expired', T0 + 41 * MIN);
  assert.equal(s.list().length, 0);
});

test('an acknowledgement is attributed to the operator who made it; a second one says who already did', () => {
  const { s } = rig();
  s.raise(raise());
  const r = s.acknowledge('blast:cant_clear:HT-04:INCLINE', PRIYA, T0 + 3_000);
  assert.ok(r.ok);
  assert.deepEqual(s.get('blast:cant_clear:HT-04:INCLINE')!.ack, { by: 'priya', name: 'Priya', role: 'operator', atServerMs: T0 + 3_000 });
  const again = s.acknowledge('blast:cant_clear:HT-04:INCLINE', DAVE, T0 + 4_000);
  assert.deepEqual(again, { ok: false, error: 'Already acknowledged by Priya.' });
  assert.equal(s.acknowledge('nope', DAVE, T0).ok, false);
});

test('an interrupt cleared before anyone acknowledged it stays, resolved and quiet, until acknowledged; an acknowledged one leaves at once', () => {
  const { s, alerts } = rig();
  s.raise(raise());
  s.clear('blast:cant_clear:HT-04:INCLINE', 'zone reopened', T0 + 60_000);
  const item = s.get('blast:cant_clear:HT-04:INCLINE')!;
  assert.deepEqual(item.cleared, { reason: 'zone reopened', atServerMs: T0 + 60_000 });
  s.tick(T0 + 40 * MIN, [PRIYA]);
  assert.equal(alerts().length, 1, 'no re-alert or escalation once resolved');
  assert.equal(alertsFor(item, 'priya'), false);
  assert.ok(s.acknowledge(item.key, PRIYA, T0 + 41 * MIN).ok);
  assert.equal(s.list().length, 0);

  s.raise(raise({ key: 'k2' }));
  s.acknowledge('k2', DAVE, T0 + 1_000);
  assert.equal(s.list().length, 1, 'acknowledged, still open: stays');
  s.clear('k2', 'truck confirmed outside', T0 + 2_000);
  assert.equal(s.list().length, 0);
});

test('a cause that comes back after clearing is a new alarm, and alerts again', () => {
  const { s, alerts } = rig();
  s.raise(raise());
  s.acknowledge('blast:cant_clear:HT-04:INCLINE', PRIYA, T0 + 1_000);
  s.clear('blast:cant_clear:HT-04:INCLINE', 'zone reopened', T0 + 2_000);
  s.raise(raise({ atServerMs: T0 + 300_000 }));
  assert.equal(alerts().length, 2);
  assert.equal(s.get('blast:cant_clear:HT-04:INCLINE')!.ack, null);
});

test('L2.63 unacknowledged: re-alerts at 15 minutes and escalates to the supervisor on screen at 30', () => {
  const { s, alerts } = rig();
  s.raise(raise());
  for (let t = 0; t <= 31 * MIN; t += 15_000) s.tick(T0 + t, [PRIYA, DAVE, MARTA]);
  const a = alerts();
  assert.deepEqual(a.map((x) => x.why), ['raised', 're-alert', 'escalated']);
  assert.equal(a[1]!.atServerMs, T0 + PARAMS.realertAfter.value);
  assert.equal(a[1]!.to, 'everyone');
  assert.equal(a[2]!.atServerMs, T0 + PARAMS.escalateAfter.value);
  assert.deepEqual(a[2]!.to, ['marta'], 'escalation goes to the supervisor');
  const item = s.get('blast:cant_clear:HT-04:INCLINE')!;
  assert.equal(item.escalation!.mode, 'supervisor');
  assert.match(item.escalation!.words, /escalated to Marta \(supervisor\)/);
  assert.equal(alertsFor(item, 'marta'), true);
  assert.equal(alertsFor(item, 'priya'), false, 'the escalation alert sounds at the supervisor\'s screen');
  // Still unacknowledged: the supervisor is reminded every 15 min after, not every minute.
  for (let t = 31 * MIN; t <= 46 * MIN; t += 15_000) s.tick(T0 + t, [PRIYA, DAVE, MARTA]);
  assert.deepEqual(alerts().map((x) => x.why), ['raised', 're-alert', 'escalated', 'persistent']);
});

test('L2.63 nights: when the only person on is the supervisor, escalation is persistent alerting to that same person', () => {
  const { s, alerts } = rig();
  s.raise(raise());
  for (let t = 0; t <= 35 * MIN; t += 5_000) s.tick(T0 + t, [MARTA]);
  const a = alerts();
  assert.deepEqual(a.slice(0, 3).map((x) => x.why), ['raised', 're-alert', 'escalated']);
  assert.deepEqual(a[2]!.to, ['marta']);
  const persistent = a.filter((x) => x.why === 'persistent');
  assert.equal(persistent.length, 5, 'one a minute from 30 to 35 min');
  assert.ok(persistent.every((x) => Array.isArray(x.to) && x.to.length === 1 && x.to[0] === 'marta'));
  const item = s.get('blast:cant_clear:HT-04:INCLINE')!;
  assert.equal(item.escalation!.mode, 'same-person');
  assert.match(item.escalation!.words, /Marta is the supervisor and the only one on/);
  s.acknowledge(item.key, MARTA, T0 + 35 * MIN + 1);
  for (let t = 36 * MIN; t <= 40 * MIN; t += 5_000) s.tick(T0 + t, [MARTA]);
  assert.equal(alerts().length, a.length, 'acknowledged: quiet');
});

test('L2.63 no supervisor on at all: escalation alerts every screen persistently and says to phone the supervisor', () => {
  const { s, alerts } = rig();
  s.raise(raise());
  for (let t = 0; t <= 32 * MIN; t += 5_000) s.tick(T0 + t, [DAVE]);
  const item = s.get('blast:cant_clear:HT-04:INCLINE')!;
  assert.equal(item.escalation!.mode, 'no-supervisor');
  assert.match(item.escalation!.words, /no supervisor is logged in.*Phone the supervisor/);
  assert.deepEqual(alerts().slice(2).map((x) => [x.why, x.to]), [['escalated', 'everyone'], ['persistent', 'everyone'], ['persistent', 'everyone']]);
});

test('an acknowledged interrupt is neither re-alerted nor escalated', () => {
  const { s, alerts } = rig();
  s.raise(raise());
  s.acknowledge('blast:cant_clear:HT-04:INCLINE', DAVE, T0 + 10_000);
  for (let t = 0; t <= 60 * MIN; t += 30_000) s.tick(T0 + t, [DAVE, MARTA]);
  assert.equal(alerts().length, 1);
});

test('the tray order: interrupts needing acknowledgement first, longest-waiting on top; silent items last, newest first', () => {
  const { s } = rig();
  s.raise(raise({ key: 'silent-old', interrupt: false, atServerMs: T0 }));
  s.raise(raise({ key: 'i-new', atServerMs: T0 + 2_000 }));
  s.raise(raise({ key: 'i-old', atServerMs: T0 + 1_000 }));
  s.raise(raise({ key: 'i-acked', atServerMs: T0 }));
  s.acknowledge('i-acked', PRIYA, T0 + 3_000);
  s.raise(raise({ key: 'silent-new', interrupt: false, atServerMs: T0 + 4_000 }));
  s.raise(raise({ key: 'i-resolved', atServerMs: T0 }));
  s.clear('i-resolved', 'gone', T0 + 5_000);
  assert.deepEqual(s.list().map((i) => i.key), ['i-old', 'i-new', 'i-resolved', 'i-acked', 'silent-new', 'silent-old']);
});
