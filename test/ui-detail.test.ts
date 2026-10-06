// Truck detail, the attention tray's words and the audit view (UI.md screens 2 and 4), on real
// command records from the registry against the in-process fake gateway. Cases: the command
// timeline (sent, acknowledged, effect seen; retry n of m; can't verify; failed with the reason),
// L7.9's hand-back state, L8.1's refusal naming the lease holder, L8.4's audit answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlarmStore } from '../src/attention.ts';
import type { Actor, CommandRecord } from '../src/registry.ts';
import { TruckNotes } from '../src/trucknotes.ts';
import { auditLines } from '../src/ui/audit.ts';
import { buttons, heldBy, timelineEntry, truckFacts } from '../src/ui/detail.ts';
import { toSound, trayModel } from '../src/ui/tray.ts';
import { linkRig, type LinkRig } from './helpers/link-rig.ts';
import type { FakeConfig } from '../fake/gateway.ts';

const PRIYA: Actor = { kind: 'operator', operatorId: 'priya', role: 'operator' };
const MARTA: Actor = { kind: 'operator', operatorId: 'marta', role: 'supervisor' };

function up(config: Partial<FakeConfig> = {}): LinkRig {
  const r = linkRig(config);
  r.link.start();
  assert.ok(r.until(() => r.link.isUp(), 5_000) >= 0);
  r.advance(1_500);
  return r;
}

const settle = (r: LinkRig, id: string, ms = 20_000) => r.until(() => !['pending', 'sent', 'acknowledged'].includes(r.registry.get(id)!.status), ms);

test('timeline: a HOLD is requested, sent, acknowledged and its effect seen, in that order, each with a time; "done" only then', () => {
  const r = up();
  try {
    const rec = r.registry.submit({ vehicleId: 'HT-03', action: 'HOLD' }, PRIYA);
    let sawAcceptedNotDone = false;
    r.until(() => {
      const e = timelineEntry(r.registry.get(rec.id)!, r.fleet.truck('HT-03'));
      if (r.registry.get(rec.id)!.status === 'acknowledged') { sawAcceptedNotDone = true; assert.equal(e.headline, 'HOLD by priya: accepted, not done yet'); }
      return e.outcome === 'done';
    }, 15_000, 20);
    assert.ok(sawAcceptedNotDone, 'accepted was shown as accepted, not done');
    const e = timelineEntry(r.registry.get(rec.id)!, r.fleet.truck('HT-03'));
    assert.equal(e.headline, 'HOLD by priya: done');
    assert.deepEqual(e.steps.map((s) => s.kind), ['request', 'send', 'ack', 'effect']);
    assert.match(e.steps[1]!.words, /^Sent to the site \(attempt 1 of 3\)/);
    assert.match(e.steps[2]!.words, /accepted it \(not yet carried out\)/);
    assert.match(e.steps[3]!.words, /^Effect seen in telemetry: HT-03 is holding/);
    const times = e.steps.map((s) => s.atServerMs!);
    assert.deepEqual([...times].sort((a, b) => a - b), times, 'in time order');
  } finally { r.cleanup(); }
});

test('timeline: accepted then ignored is shown as "retry 2 of 3", then done; never done while only accepted (L3.6 in the UI)', () => {
  const r = up({ faults: { ignoredCommands: (c) => c.action === 'RESUME' && c.n === 2 } });
  try {
    const hold = r.registry.submit({ vehicleId: 'HT-04', action: 'HOLD' }, PRIYA);
    assert.ok(settle(r, hold.id) >= 0);
    const rec = r.registry.submit({ vehicleId: 'HT-04', action: 'RESUME' }, PRIYA);
    const heads = new Set<string>();
    r.until(() => { const e = timelineEntry(r.registry.get(rec.id)!, r.fleet.truck('HT-04')); heads.add(e.headline); return e.outcome === 'done'; }, 40_000, 50);
    assert.ok(heads.has('RESUME by priya: retry 2 of 3'), [...heads].join(' | '));
    assert.ok(heads.has('RESUME by priya: accepted, not done yet'));
    const e = timelineEntry(r.registry.get(rec.id)!, r.fleet.truck('HT-04'));
    assert.equal(e.headline, 'RESUME by priya: done');
    assert.ok(e.steps.some((s) => /^Sent again: attempt 2 of 3/.test(s.words)));
  } finally { r.cleanup(); }
});

test('L8.1 a command blocked by a lease fails with the holder named, and the hand-back leaves the truck "held by" its driver with Resume first (L7.9)', () => {
  const r = up();
  try {
    const take = r.registry.submit({ vehicleId: 'HT-05', action: 'TAKE_CONTROL' }, MARTA);
    assert.ok(settle(r, take.id) >= 0);
    assert.equal(r.registry.get(take.id)!.status, 'confirmed');
    const hold = r.registry.submit({ vehicleId: 'HT-05', action: 'HOLD' }, PRIYA);
    assert.ok(settle(r, hold.id) >= 0);
    const e = timelineEntry(r.registry.get(hold.id)!, r.fleet.truck('HT-05'));
    assert.equal(e.outcome, 'failed');
    assert.match(e.detail, /HT-05 is being driven by marta\. Talk to them first; a supervisor can take control from them\./);
    assert.ok(e.steps.some((s) => s.kind === 'refusal' && /LEASE_HELD \(held by marta\)/.test(s.words)));

    // Buttons while marta drives: priya can't take control and is told why; marta releases.
    const t = r.fleet.truck('HT-05')!;
    const forPriya = buttons(t, { id: 'priya', role: 'operator' }, null);
    assert.match(forPriya.find((b) => b.action === 'TAKE_CONTROL')!.disabled!, /marta is driving it\. Talk to them; a supervisor can take over/);
    assert.ok(buttons(t, { id: 'marta', role: 'supervisor' }, null).some((b) => b.action === 'RELEASE_CONTROL' && b.primary));
    assert.ok(buttons(t, { id: 'dave', role: 'supervisor' }, null).some((b) => b.force && b.label === 'Take over from marta'));

    const rel = r.registry.submit({ vehicleId: 'HT-05', action: 'RELEASE_CONTROL' }, MARTA);
    assert.ok(settle(r, rel.id) >= 0);
    r.until(() => r.fleet.truck('HT-05')!.state?.value === 'HOLDING', 5_000);
    const held = heldBy(r.fleet.truck('HT-05'), r.registry.list(), undefined)!;
    assert.equal(held.by, 'marta');
    assert.equal(held.how, 'handed it back after driving');
    const resume = buttons(r.fleet.truck('HT-05')!, { id: 'marta', role: 'supervisor' }, held).find((b) => b.action === 'RESUME')!;
    assert.deepEqual([resume.label, resume.primary], ['Resume (you held it)', true]);
    assert.equal(buttons(r.fleet.truck('HT-05')!, { id: 'priya', role: 'operator' }, held).find((b) => b.action === 'RESUME')!.primary, false);
    const facts = truckFacts(r.fleet.truck('HT-05')!, r.fleet.snapshot(), undefined, held, 'marta');
    assert.equal(facts.find((f) => f.label === 'Held by')!.value, 'you: handed it back after driving');
  } finally { r.cleanup(); }
});

test('held by: a lease that expired with no drive input names the driver; a truck not holding has no "held by"', () => {
  const r = up();
  try {
    const t = r.fleet.truck('HT-02')!;
    assert.equal(heldBy(t, [], undefined), null, t.state?.value);
    const holding = { ...t, state: { ...t.state!, value: 'HOLDING' as const } };
    assert.deepEqual(heldBy(holding, [], { vehicleId: 'HT-02', operatorId: 'dave', event: 'EXPIRED', reason: 'NO_DRIVE_INPUT', by: null, atServerMs: 5 }),
      { by: 'dave', how: 'drove it; control expired with no drive input', atServerMs: 5 });
    assert.equal(heldBy(holding, [], undefined)!.by, null);
  } finally { r.cleanup(); }
});

test('B16 in the UI: an open command on a truck whose data is silent or frozen reads "can\'t verify", not waiting or failed', () => {
  const r = up();
  try {
    const rec = r.registry.submit({ vehicleId: 'HT-06', action: 'HOLD' }, PRIYA);
    const t = r.fleet.truck('HT-06')!;
    const e = timelineEntry(r.registry.get(rec.id)!, { ...t, confidence: 'contradicted' });
    assert.equal(e.outcome, "can't verify");
    assert.equal(e.headline, "HOLD by priya: can't verify");
    assert.match(e.detail, /Can't verify: data frozen/);
    const failed = { ...r.registry.get(rec.id)!, status: 'failed', failure: { code: 'NO_EFFECT', message: 'HOLD for HT-06 did not take effect after 3 attempts.', ourFault: false } } as CommandRecord;
    assert.equal(timelineEntry(failed, { ...t, confidence: 'silent' }).outcome, "can't verify");
    assert.equal(timelineEntry(failed, t).outcome, 'failed', 'with live data, a failure is a failure');
  } finally { r.cleanup(); }
});

test('truck facts: a fault with when and where, clock skew, drain against the fleet, controller restarts; a depleted truck offers no driving', () => {
  const r = up({ faults: { hydPressureLow: { vehicle: 'HT-08', atMs: 4_000 }, clockSkew: { vehicle: 'HT-09' } } });
  try {
    const notes = new TruckNotes();
    for (let i = 0; i < 40; i++) { r.advance(250); notes.observe(r.fleet.snapshot()); }
    notes.restart('HT-08', 'seq went from 887 to 1', r.fleet.serverNow() - 3_000);
    const snap = r.fleet.snapshot();
    const t = snap.trucks.find((x) => x.vehicleId === 'HT-08')!;
    assert.deepEqual(t.faults!.value, ['HYD_PRESSURE_LOW']);
    const facts = truckFacts(t, snap, notes.get('HT-08'), null, 'priya');
    const f = (label: string) => facts.find((x) => x.label === label)!;
    assert.match(f('Faults').value, new RegExp(`^HYD_PRESSURE_LOW: from \\d+ s ago, in ${t.position!.value.zoneId} \\(${t.position!.value.segmentId} at \\d+ m\\)$`));
    assert.equal(f('Faults').flag, true);
    assert.equal(f('Controller restarts').value, '3 s ago');
    assert.match(f('Drain').value, /^(not measured yet|empty|loaded)/);
    const skewed = snap.trucks.find((x) => x.vehicleId === 'HT-09')!;
    const clock = truckFacts(skewed, snap, undefined, null, null).find((x) => x.label === 'Clock')!;
    assert.match(clock.value, /^device clock [\d.]+ min (ahead of|behind) server time: its own timestamps are ignored; ages use server time$/);
    const dead = { ...t, faults: { ...t.faults!, value: ['BATTERY_DEPLETED'] } };
    assert.match(buttons(dead, { id: 'priya', role: 'operator' }, null).find((b) => b.action === 'TAKE_CONTROL')!.disabled!, /needs a tow/);
  } finally { r.cleanup(); }
});

test('tray words: who acknowledged, what resolved it, re-alerts and escalation; each alert sounds once, only where it is addressed', () => {
  const s = new AlarmStore();
  const T = 1_790_000_000_000;
  s.raise({ type: 'raise', source: 'blast', kind: 'cant_clear', key: 'a', vehicleId: 'HT-01', zoneId: 'Z', message: 'm', action: 'Radio the shot firer to hold the shot', interrupt: true, rule: 'r', atServerMs: T });
  s.raise({ type: 'raise', source: 'data', kind: 'controller_restart', key: 'b', vehicleId: 'HT-02', zoneId: null, message: 'restart', action: null, interrupt: false, rule: 'Silent (L2.61): why', atServerMs: T });
  const heard = new Map<string, number>();
  assert.deepEqual(toSound(s.list(), 'priya', heard).map((i) => i.key), ['a']);
  assert.deepEqual(toSound(s.list(), 'priya', heard), [], 'once');
  let tray = trayModel(s.list(), 'priya', T + 65_000);
  assert.equal(tray.needAck, 1);
  assert.deepEqual(tray.interrupts.map((e) => [e.key, e.state, e.when]), [['a', 'needs-ack', 'raised 1:05 ago']]);
  assert.deepEqual(tray.silent.map((e) => [e.key, e.rule]), [['b', 'Silent (L2.61): why']]);
  s.tick(T + 15 * 60_000, [{ id: 'priya', name: 'Priya', role: 'operator' }, { id: 'marta', name: 'Marta', role: 'supervisor' }]);
  assert.equal(toSound(s.list(), 'priya', heard).length, 1, 'the re-alert sounds');
  assert.match(trayModel(s.list(), 'priya', T + 15 * 60_000).interrupts[0]!.status!, /Re-alerted at 15 min/);
  s.tick(T + 30 * 60_000, [{ id: 'priya', name: 'Priya', role: 'operator' }, { id: 'marta', name: 'Marta', role: 'supervisor' }]);
  assert.equal(toSound(s.list(), 'priya', heard).length, 0, 'the escalation sounds at the supervisor\'s screen, not priya\'s');
  assert.equal(toSound(s.list(), 'marta', new Map()).length, 1);
  s.acknowledge('a', { id: 'marta', name: 'Marta', role: 'supervisor' }, T + 30 * 60_000 + 5_000);
  tray = trayModel(s.list(), 'priya', T + 30 * 60_000 + 10_000);
  assert.deepEqual([tray.interrupts[0]!.state, tray.interrupts[0]!.status], ['acknowledged', 'Acknowledged by Marta 0:05 ago']);
  assert.equal(tray.needAck, 0);
});

test('L8.4 the audit view: every command around a time on one truck, operator or system with rule and inputs, the acks and the effect', () => {
  const r = up();
  try {
    const at = r.fleet.serverNow();
    const a = r.registry.submit({ vehicleId: 'HT-06', action: 'HOLD' }, PRIYA);
    settle(r, a.id);
    const b = r.registry.submit({ vehicleId: 'HT-06', action: 'RESUME' }, { kind: 'system', rule: 'B12', inputs: { zone: 'TIP', reopened: 'CLEARED' } });
    settle(r, b.id);
    r.registry.submit({ vehicleId: 'HT-07', action: 'HOLD' }, PRIYA);
    const lines = auditLines(r.store.history('HT-06', at - 60_000, at + 60_000), at);
    assert.deepEqual(lines.map((l) => [l.action, l.who]), [['HOLD', 'priya (operator)'], ['RESUME', 'the system, rule B12']]);
    assert.equal(lines[0]!.closest, true);
    assert.match(lines[0]!.outcome, /^done: HT-06 is holding/);
    assert.match(lines[0]!.acks, /^ACCEPTED for /);
    assert.match(lines[0]!.sent, /^attempt 1 as /);
    assert.equal(lines[1]!.inputs, '{"zone":"TIP","reopened":"CLEARED"}');
    assert.equal(lines[1]!.system, true);
  } finally { r.cleanup(); }
});
