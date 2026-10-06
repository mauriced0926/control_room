// What interrupts and what stays silent: TESTING.md L2.60-L2.62, against the in-process fake gateway
// on a manual clock. Registry and fleet events are real where the rig makes them easy, injected where
// a whole failure scenario would only obscure the rule under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Alerting, RULES, nextZone } from '../src/alerting.ts';
import { AlarmStore, type AlarmItem } from '../src/attention.ts';
import { HOLD_THE_SHOT } from '../src/clearance.ts';
import type { FleetEvent } from '../src/fleet.ts';
import type { RegistryEvent } from '../src/registry.ts';
import { TruckNotes } from '../src/trucknotes.ts';
import { linkRig, type LinkRig } from './helpers/link-rig.ts';
import type { FakeConfig } from '../fake/gateway.ts';

interface Rig {
  r: LinkRig;
  store: AlarmStore;
  notes: TruckNotes;
  alerting: Alerting;
  reg(e: RegistryEvent): void;
  fleetEvent(e: FleetEvent): void;
  step(ms: number): void;           // advance, evaluating every 250 ms as the hub does
  item(key: string): AlarmItem | undefined;
  done(): void;
}

function rig(config: Partial<FakeConfig> = {}, provisional = true): Rig {
  const r = linkRig(config);
  r.link.start();
  assert.ok(r.until(() => r.link.isUp(), 5_000) >= 0);
  const store = new AlarmStore();
  const notes = new TruckNotes();
  const regFns = new Set<(e: RegistryEvent) => void>();
  const fleetFns = new Set<(e: FleetEvent) => void>();
  r.fleet.subscribe((e) => { for (const f of fleetFns) f(e); });
  const alerting = new Alerting({
    fleet: { subscribe: (fn) => { fleetFns.add(fn); return () => fleetFns.delete(fn); }, serverNow: () => r.fleet.serverNow(), get site() { return r.fleet.site; } },
    link: r.link,
    registry: { subscribe: (fn) => { regFns.add(fn); return () => regFns.delete(fn); } },
    store, notes, provisionalBlast: () => provisional,
  });
  r.registry.subscribe((e) => { for (const f of regFns) f(e); });
  const step = (ms: number) => { for (let left = ms; left > 0; left -= 250) { r.advance(Math.min(250, left)); alerting.evaluate(r.fleet.snapshot()); } };
  step(1_000);
  return {
    r, store, notes, alerting, step,
    reg: (e) => { for (const f of regFns) f(e); },
    fleetEvent: (e) => { for (const f of fleetFns) f(e); },
    item: (k) => store.get(k),
    done: () => { alerting.stop(); r.cleanup(); },
  };
}

test('L2.60 a closing zone that might not be clear interrupts within 10 s of CLOSING, names the action, and clears when the zone reopens', () => {
  const h = rig({ blasts: [{ zoneId: 'DECLINE', atMs: 3_000, closedForMs: 20_000 }], trucks: [{ vehicle_id: 'HT-01', positionM: 200, state: 'HOLDING' }] });
  try {
    const closingAt = () => h.r.fleet.snapshot().zones.find((z) => z.zoneId === 'DECLINE')!.status === 'CLOSING';
    assert.ok(h.r.until(closingAt, 10_000) >= 0);
    const t0 = h.r.clock.now();
    let raisedAfter = -1;
    for (let t = 0; t <= 10_000 && raisedAfter < 0; t += 250) { h.step(250); if (h.item('blast:provisional:DECLINE')) raisedAfter = h.r.clock.now() - t0; }
    assert.ok(raisedAfter >= 0 && raisedAfter <= 10_000, `raised ${raisedAfter} ms after CLOSING`);
    const it = h.item('blast:provisional:DECLINE')!;
    assert.equal(it.interrupt, true);
    assert.equal(it.action, HOLD_THE_SHOT);
    assert.match(it.message, /^DECLINE NOT CLEAR \(CLOSING\): .*HT-01 inside/);
    assert.equal(it.rule, RULES.cantClearProvisional);
    assert.equal(it.alerts.length, 1);
    h.step(10_000);
    assert.equal(h.item('blast:provisional:DECLINE')!.alerts.length, 1, 'one cause, one alarm: not again every evaluation (L2.64)');
    h.step(140_000); // closes, then reopens
    const after = h.item('blast:provisional:DECLINE')!;
    assert.match(after.cleared!.reason, /DECLINE reopened \(CLEARED\)/);
    assert.equal(after.ack, null, 'nobody acknowledged it, so it stays, resolved');
  } finally { h.done(); }
});

test('the provisional can\'t-clear alarm stands down once the blast engine raises its own', () => {
  const h = rig({ blasts: [{ zoneId: 'DECLINE', atMs: 2_000, closedForMs: 20_000 }], trucks: [{ vehicle_id: 'HT-01', positionM: 200, state: 'HOLDING' }] }, false);
  try {
    h.step(8_000);
    assert.equal(h.item('blast:provisional:DECLINE'), undefined);
  } finally { h.done(); }
});

test('L2.60 site link down while a zone is closing interrupts; with every zone open it is one silent item, and per-truck items wait for the link', () => {
  const h = rig({ blasts: [{ zoneId: 'TIP', atMs: 30_000, closedForMs: 20_000 }] });
  try {
    h.step(2_000);
    h.r.dialer.mode = 'outage';
    h.r.dialer.dropAll();
    h.step(8_000);
    const quiet = h.item('link:down')!;
    assert.equal(quiet.interrupt, false);
    assert.equal(quiet.rule, RULES.linkDownQuiet);
    assert.ok(!h.store.list().some((i) => i.key.startsWith('data:doubt:')), 'twelve silent trucks are one cause: the link');
    h.r.dialer.mode = 'normal';
    h.step(30_000); // reconnects; TIP is closing
    assert.equal(h.item('link:down'), undefined, 'cleared on reconnect');
    assert.equal(h.r.fleet.snapshot().zones.find((z) => z.zoneId === 'TIP')!.status, 'CLOSING');
    h.r.dialer.mode = 'outage';
    h.r.dialer.dropAll();
    h.step(7_000);
    const loud = h.item('link:down')!;
    assert.equal(loud.interrupt, true);
    assert.equal(loud.rule, RULES.linkDownClosing);
    assert.match(loud.message, /Site link down while TIP \(CLOSING\) is not open/);
    assert.equal(loud.action, HOLD_THE_SHOT);
  } finally { h.done(); }
});

test('L2.60 / L2.61 a failed command interrupts only on a truck in or approaching a closing zone; an e-stop that failed always does', () => {
  const h = rig({ blasts: [{ zoneId: 'DECLINE', atMs: 1_000, closedForMs: 200_000 }], trucks: [{ vehicle_id: 'HT-02', positionM: 300, state: 'HOLDING' }, { vehicle_id: 'HT-03', positionM: 1_200, state: 'HOLDING' }, { vehicle_id: 'HT-04', positionM: 40, state: 'HOLDING' }] });
  try {
    h.step(3_000);
    h.reg({ type: 'alarm', kind: 'command_failed', vehicleId: 'HT-03', recordId: 'x1', message: 'HOLD for HT-03 did not take effect after 3 attempts.' });
    const far = h.item('registry:command_failed:HT-03')!;
    assert.equal(far.interrupt, false);
    assert.equal(far.rule, RULES.commandFailedFar);
    h.reg({ type: 'alarm', kind: 'command_failed', vehicleId: 'HT-02', recordId: 'x2', message: 'HOLD for HT-02 did not take effect after 3 attempts.' });
    const inside = h.item('registry:command_failed:HT-02')!;
    assert.equal(inside.interrupt, true);
    assert.match(inside.message, /HT-02 is in or approaching DECLINE\./);
    h.reg({ type: 'alarm', kind: 'command_failed', vehicleId: 'HT-04', recordId: 'x3', message: 'HOLD for HT-04 did not take effect.' });
    assert.equal(h.item('registry:command_failed:HT-04')!.interrupt, true, 'in the bay, DECLINE is next along the route: approaching');
    h.reg({ type: 'command', record: { id: 'x4', action: 'ESTOP', vehicleId: 'HT-03', status: 'failed' } as never });
    h.reg({ type: 'alarm', kind: 'command_failed', vehicleId: 'HT-03', recordId: 'x4', message: 'ESTOP for HT-03 did not take effect after 5 attempts.' });
    const estop = h.item('registry:command_failed:HT-03')!;
    assert.equal(estop.interrupt, true, 'upgraded: same truck, now an e-stop');
    assert.equal(estop.rule, RULES.commandFailedEstop);
    // A later command confirmed on the truck ends the failure alarm.
    h.reg({ type: 'command', record: { id: 'x5', action: 'HOLD', vehicleId: 'HT-02', status: 'confirmed', effect: { atMs: 0, serverMs: 0, detail: 'HT-02 is holding', ackReceived: true } } as never });
    assert.match(h.item('registry:command_failed:HT-02')!.cleared!.reason, /a later HOLD on HT-02 was confirmed/);
  } finally { h.done(); }
});

test('L2.60 an e-stop not delivered interrupts, and clears when it is cancelled or delivered', () => {
  const h = rig();
  try {
    h.reg({ type: 'alarm', kind: 'estop_undelivered', vehicleId: 'HT-09', recordId: 'e1', message: 'E-stop for HT-09 NOT delivered: the site link is down.' });
    const it = h.item('registry:estop_undelivered:e1')!;
    assert.equal(it.interrupt, true);
    assert.equal(it.rule, RULES.estopUndelivered);
    h.reg({ type: 'command', record: { id: 'e1', action: 'ESTOP', vehicleId: 'HT-09', status: 'cancelled' } as never });
    assert.equal(h.item('registry:estop_undelivered:e1')!.cleared!.reason, 'cancelled before it was sent');
  } finally { h.done(); }
});

test('L2.61 / L2.62 controller restart and a lost ack later confirmed are silent, say why, and leave the tray after 10 min', () => {
  const h = rig();
  try {
    const at = h.r.fleet.serverNow();
    h.fleetEvent({ type: 'controller_restart', vehicleId: 'HT-01', detail: 'seq went from 887 to 1 while its clock moved forward: controller restarted', atServerMs: at });
    const it = h.item('data:controller_restart:HT-01')!;
    assert.equal(it.interrupt, false);
    assert.equal(it.rule, RULES.restart);
    assert.equal(h.notes.get('HT-01').restarts[0]!.atServerMs, at, 'truck detail keeps it');
    h.reg({ type: 'command', record: { id: 'c1', action: 'RESUME', vehicleId: 'HT-05', status: 'confirmed', effect: { atMs: 0, serverMs: 0, detail: 'HT-05 is TRAMMING', ackReceived: false } } as never });
    assert.equal(h.item('registry:lost_ack:c1')!.rule, RULES.lostAck);
    assert.equal(h.store.list().filter((i) => i.interrupt).length, 0, 'nothing here interrupts');
    h.step(10 * 60_000 + 500);
    assert.equal(h.item('data:controller_restart:HT-01'), undefined);
    assert.equal(h.item('registry:lost_ack:c1'), undefined);
    assert.equal(h.notes.get('HT-01').restarts.length, 1, 'still in truck detail');
  } finally { h.done(); }
});

test('L2.60 / L2.61 battery: cannot reach the bay interrupts with the action; a weak pack that can still reach the bay is silent', () => {
  const h = rig({ trucks: [{ vehicle_id: 'HT-06', positionM: 1_100, socPct: 60, drainFactor: 5 }, { vehicle_id: 'HT-07', positionM: 1_000, socPct: 4 }] });
  try {
    h.step(90_000);
    const weak = h.item('battery:weak:HT-06');
    assert.ok(weak, 'HT-06 flagged as draining fast');
    assert.equal(weak.interrupt, false);
    assert.equal(weak.rule, RULES.batteryWeak);
    const reach = h.store.list().find((i) => i.key === 'battery:reach:HT-07');
    assert.ok(reach, 'HT-07 warned');

    assert.equal(reach.interrupt, true);
    assert.equal(reach.action, 'Send HT-07 Return to bay');
    assert.equal(reach.rule, RULES.batteryCannotReach);
  } finally { h.done(); }
});

test('L2.61 a frozen or silent truck outside any closing zone is silent; old data is silent; each says which rule', () => {
  const h = rig();
  try {
    const snap = h.r.fleet.snapshot();
    const t = snap.trucks.find((x) => x.vehicleId === 'HT-01')!;
    // A truck's data going old or silent: stop its telemetry by dropping it at the rig's dialer is
    // not possible per truck, so the rule is checked on a doctored snapshot.
    const doctored = { ...snap, trucks: snap.trucks.map((x) => x.vehicleId === 'HT-01' ? { ...t, confidence: 'silent' as const, mightBeIn: [t.position!.value.zoneId] } : x.vehicleId === 'HT-02' ? { ...x, confidence: 'old' as const } : x) };
    h.alerting.evaluate(doctored);
    assert.equal(h.item('data:doubt:HT-01')!.rule, RULES.doubtFar);
    assert.equal(h.item('data:doubt:HT-02')!.rule, RULES.old);
    assert.equal(h.item('data:doubt:HT-01')!.interrupt, false);
    const closing = { ...doctored, zones: doctored.zones.map((z) => z.zoneId === t.position!.value.zoneId ? { ...z, status: 'CLOSING' as const } : z) };
    h.alerting.evaluate(closing);
    assert.equal(h.item('data:doubt:HT-01')!.rule, RULES.doubtNear, 'near a closing zone, the zone\'s alarm carries it');
    h.alerting.evaluate(h.r.fleet.snapshot());
    assert.equal(h.item('data:doubt:HT-01'), undefined, 'live again: gone');
  } finally { h.done(); }
});

test('nextZone follows the route forward, with wrap', () => {
  const h = rig();
  try {
    const site = h.r.fleet.site!;
    assert.equal(nextZone(site, 'SEG-BAY'), 'DECLINE');
    assert.equal(nextZone(site, 'SEG-DEC-1'), 'L4_NORTH');
    assert.equal(nextZone(site, 'SEG-TIP-1'), 'BAY');
  } finally { h.done(); }
});
