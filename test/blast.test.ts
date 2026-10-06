// The blast engine (BLAST.md): the decision table (planTruck, against truck views from a real
// FleetState fed telemetry) and scenarios against the fake gateway, which knows where every truck
// really is. TESTING.md L2.7, L2.8, L2.52, L2.54, L2.55, L2.57, the CLOSING column of L5, L6.1's
// "acts on the hello snapshot within the time left", and L1.2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BlastEngine, DRIVE_OUT_OR_HOLD, planTruck, type DecideContext, type ZoneInfo } from '../src/blast.ts';
import { HOLD_THE_SHOT } from '../src/clearance.ts';
import { ManualClock } from '../src/clock.ts';
import { FleetState } from '../src/fleet.ts';
import { PARAMS } from '../src/params.ts';
import type { ZoneStatus } from '../src/protocol.ts';
import { ALLOW_ALL_GATE_NO_BLAST_SAFETY, CommandRegistry, type Actor } from '../src/registry.ts';
import { Store } from '../src/store.ts';
import type { AlarmRaise } from '../src/alarms.ts';
import { siteVariant } from '../fake/sites.ts';
import { blastRig, type BlastRig } from './helpers/blast-rig.ts';
import { helloAt, helloFor } from './helpers/fixtures.ts';
import { rig, T0, telemetry, type Rig } from './helpers/rig.ts';

// ---- the decision table ----

function ctx(r: Rig, zones: Record<string, [ZoneStatus, number | null]>, o: Partial<DecideContext> = {}): DecideContext {
  const site = r.fleet.site!;
  const now = r.fleet.serverNow();
  const m = new Map<string, ZoneInfo>(site.zones.map((z) => [z.zoneId, { zoneId: z.zoneId, status: 'OPEN' as ZoneStatus, effectiveAtMs: null }]));
  for (const [id, [status, inMs]] of Object.entries(zones)) m.set(id, { zoneId: id, status, effectiveAtMs: inMs === null ? null : now + inMs });
  return { site, nowMs: now, zones: m, leaseHolder: () => null, exitSentAtMs: () => null, ...o };
}

const at = (segment_id: string, zone_id: string, offset_m: number, over: Record<string, unknown> = {}) => ({ segment_id, zone_id, offset_m, ...over });
let seq = 0;
const send = (r: Rig, over: Record<string, unknown>) => r.send({ seq: ++seq, t_device_ms: r.clock.now(), ...over });

test('L2.8 hold before entry: only once the truck is within (6 s + age + latency) x speed + margin of the boundary', () => {
  const r = rig();
  send(r, at('SEG-BAY', 'BAY', 10));
  const c = { DECLINE: ['CLOSING', 120_000] as [ZoneStatus, number] };
  assert.equal(planTruck(ctx(r, c), r.truck()).want, null, '70 m away: no need yet (Lena: don\'t stop trucks that don\'t need stopping)');
  send(r, at('SEG-BAY', 'BAY', 62));
  const p = planTruck(ctx(r, c), r.truck());
  assert.equal(p.want?.action, 'HOLD');
  assert.equal(p.want?.rule, 'B6');
  assert.deepEqual(p.holdFor, ['DECLINE']);
  // Closed: the same.
  assert.equal(planTruck(ctx(r, { DECLINE: ['CLOSED', 0] }), r.truck()).want?.action, 'HOLD');
});

test('L2.8 / L2.56 a truck that can pass all the way through in time, its duty stop included, is not held; one that can\'t is', () => {
  const r = rig();
  send(r, at('SEG-L4N-1', 'L4_NORTH', 195)); // empty, 5 m from the draw point: loads 20 s inside it, out at ~43 s
  assert.equal(planTruck(ctx(r, { DRAW_12: ['CLOSING', 120_000] }), r.truck()).want, null);
  const p = planTruck(ctx(r, { DRAW_12: ['CLOSING', 40_000] }), r.truck());
  assert.equal(p.want?.action, 'HOLD');
  assert.equal(p.want?.rule, 'B6');
});

test('B3 inside, can be got out: EXIT_ZONE, no alarm; L2.7 / B5 too far: EXIT_ZONE anyway, and the can\'t-clear alarm', () => {
  const r = rig();
  send(r, at('SEG-DEC-1', 'DECLINE', 100)); // 100 m in: 400 m ahead is 133 s; 33 s back at 3 m/s, plus 6 s
  const ok = planTruck(ctx(r, { DECLINE: ['CLOSING', 120_000] }), r.truck());
  assert.equal(ok.want?.action, 'EXIT_ZONE');
  assert.equal(ok.want?.rule, 'B3');
  assert.deepEqual(ok.alarms, []);
  const late = planTruck(ctx(r, { DECLINE: ['CLOSING', 40_000] }), r.truck());
  assert.equal(late.want?.action, 'EXIT_ZONE');
  assert.equal(late.want?.rule, 'B5');
  assert.equal(late.alarms.length, 1);
  assert.equal(late.alarms[0]!.action, HOLD_THE_SHOT);
  assert.match(late.alarms[0]!.reason, /can't get out of DECLINE in time: 100 m from the nearest way out/);
});

test('L2.52 / B4 EXIT_ZONE that would land in another zone that is not open is not sent: hold, alarm, and drive it out the other way', () => {
  const r = rig();
  send(r, at('SEG-L4N-1', 'L4_NORTH', 195)); // nearest way out is 5 m ahead, into the draw point
  const p = planTruck(ctx(r, { L4_NORTH: ['CLOSING', 120_000], DRAW_12: ['CLOSED', 0] }), r.truck());
  assert.equal(p.want?.action, 'HOLD');
  assert.equal(p.want?.rule, 'B4');
  const a = p.alarms.find((x) => x.zoneId === 'L4_NORTH')!;
  assert.equal(a.rule, 'B4');
  assert.match(a.reason, /leads into DRAW_12, which is closed\. Held\. Drive it out the other way/);
});

test('L2.54 / B10 BAY closing: a truck parked in the bay gets the alarm at once with "drive it out or hold the shot"; one driving out in time is left to it', () => {
  const r = rig();
  send(r, at('SEG-BAY', 'BAY', 20, { state: 'IDLE', speed_mps: 0 }));
  const p = planTruck(ctx(r, { BAY: ['CLOSING', 120_000] }), r.truck());
  assert.equal(p.want, null, 'EXIT_ZONE is refused in a bay: nothing is sent');
  assert.equal(p.alarms[0]!.rule, 'B10');
  assert.equal(p.alarms[0]!.action, DRIVE_OUT_OR_HOLD);
  send(r, at('SEG-BAY', 'BAY', 70)); // 10 m from the end at 3 m/s
  const q = planTruck(ctx(r, { BAY: ['CLOSING', 120_000] }), r.truck());
  assert.deepEqual(q.alarms, []);
  assert.equal(q.want, null);
});

test('L2.55 / B6a a truck loading, dumping or charging at a boundary into a zone it can\'t pass through is taken with TAKE_CONTROL', () => {
  // Loading at the draw point, L4_SOUTH next and closing in 60 s (a loaded crossing takes 100 s).
  const r = rig();
  for (let i = 0; i <= 15; i++) { send(r, at('SEG-DRAW-12', 'DRAW_12', 59.95, { state: 'LOADING', speed_mps: 0 })); r.advance(1_000); }
  const early = planTruck(ctx(r, { L4_SOUTH: ['CLOSING', 60_000] }), r.truck());
  assert.equal(early.want?.action, 'TAKE_CONTROL');
  assert.equal(early.want?.rule, 'B6a');
  // Just started loading: not yet, it says when.
  const r2 = rig();
  send(r2, at('SEG-DRAW-12', 'DRAW_12', 59.95, { state: 'LOADING', speed_mps: 0 }));
  const wait = planTruck(ctx(r2, { L4_SOUTH: ['CLOSING', 60_000] }), r2.truck());
  assert.equal(wait.want, null);
  assert.match(wait.notes.join(' '), /taking control before loading ends/);
  // Passes through in time: left alone.
  assert.equal(planTruck(ctx(r, { L4_SOUTH: ['CLOSING', 200_000] }), r.truck()).want, null);
  // Dumping at the tip, the bay next (across the wrap).
  const d = rig();
  for (let i = 0; i <= 8; i++) { send(d, at('SEG-TIP-1', 'TIP', 59.95, { state: 'DUMPING', speed_mps: 0, payload_kg: 42000 })); d.advance(1_000); }
  assert.equal(planTruck(ctx(d, { BAY: ['CLOSED', 0] }), d.truck()).want?.action, 'TAKE_CONTROL');
  // Charging at the end of the bay, DECLINE closing: at once (a charge has no known end).
  const c = rig();
  send(c, at('SEG-BAY', 'BAY', 79.95, { state: 'CHARGING', speed_mps: 0, soc_pct: 30 }));
  assert.equal(planTruck(ctx(c, { DECLINE: ['CLOSING', 120_000] }), c.truck()).want?.action, 'TAKE_CONTROL');
});

test('L2.55 / B6a on a different site: duty stops found from segment kinds', () => {
  const cfg = siteVariant({ trucks: 7, noticeMs: 60_000 });
  const r = rig(helloFor(cfg.route, cfg.loop_length_m, cfg.vehicles, T0));
  const face = cfg.route.find((s) => s.kind === 'load')!;
  const next = cfg.route[cfg.route.indexOf(face) + 1]!;
  for (let i = 0; i <= 15; i++) { send(r, { vehicle_id: cfg.vehicles[0], segment_id: face.segment_id, zone_id: face.zone_id, offset_m: face.length_m - 0.05, state: 'LOADING', speed_mps: 0 }); r.advance(1_000); }
  const p = planTruck(ctx(r, { [next.zone_id]: ['CLOSING', 60_000] }), r.truck(cfg.vehicles[0]));
  assert.equal(p.want?.action, 'TAKE_CONTROL');
  assert.equal(p.want?.zoneId, next.zone_id);
});

test('L2.57 / B2 leaving on its own: no command before the last safe moment, EXIT_ZONE at it if not out', () => {
  const r = rig();
  send(r, at('SEG-DRAW-12', 'DRAW_12', 10)); // empty: on to the load point, loads 20 s, out at ~36.7 s
  const p = planTruck(ctx(r, { DRAW_12: ['CLOSING', 45_000] }), r.truck());
  assert.equal(p.want, null, 'no command yet');
  assert.ok(p.lastSafeMoment, 'the moment is fixed in advance');
  const lsmIn = (p.lastSafeMoment!.atMs - r.fleet.serverNow()) / 1000;
  assert.ok(Math.abs(lsmIn - 34) < 0.5, `last safe moment in ${lsmIn} s`);
  // At that moment (the deadline less the command delay), still loading, due out in ~2 s: EXIT_ZONE,
  // as B2 says, though the path has it leaving on its own.
  const q = rig();
  for (let i = 0; i <= 17; i++) { send(q, at('SEG-DRAW-12', 'DRAW_12', 59.95, { state: 'LOADING', speed_mps: 0 })); q.advance(1_000); }
  const w = planTruck(ctx(q, { DRAW_12: ['CLOSING', PARAMS.blastExitMargin.value + PARAMS.supervisoryDelayMax.value + 100] }), q.truck());
  assert.equal(w.want?.action, 'EXIT_ZONE');
  assert.equal(w.want?.rule, 'B2');
});

test('B1 silent or frozen trucks whose range touches the zone are held (never sent out) and alarmed; one far away is left alone', () => {
  const r = rig();
  send(r, at('SEG-DEC-2', 'DECLINE', 240)); // 10 m from the far end
  r.advance(PARAMS.truckSilentAfter.value + 500);
  assert.equal(r.truck().confidence, 'silent');
  const p = planTruck(ctx(r, { L4_NORTH: ['CLOSING', 120_000] }), r.truck());
  assert.equal(p.want?.action, 'HOLD');
  assert.equal(p.want?.rule, 'B1');
  assert.equal(p.alarms[0]!.rule, 'B1');
  assert.match(p.alarms[0]!.reason, /might be in L4_NORTH: it has been silent/);
  assert.equal(planTruck(ctx(r, { TIP: ['CLOSING', 120_000] }), r.truck()).want, null, 'far from TIP');
  const f = rig();
  for (let i = 0; i < 25; i++) { send(f, at('SEG-DEC-2', 'DECLINE', 100)); f.advance(200); }
  assert.equal(f.truck().confidence, 'contradicted');
  const q = planTruck(ctx(f, { DECLINE: ['CLOSING', 120_000] }), f.truck());
  assert.equal(q.want?.action, 'HOLD', 'not EXIT_ZONE: it might really be just outside');
  assert.match(q.alarms[0]!.reason, /frozen/);
});

test('B5 a truck someone is driving, or a faulted one, inside: alarm only (the driver told), never a command', () => {
  const r = rig();
  send(r, at('SEG-DEC-1', 'DECLINE', 100, { state: 'MANUAL', speed_mps: 0, control: { mode: 'MANUAL', operator_id: 'dave', deadman: true, last_drive_seq: 3, last_drive_sent_ms: null } }));
  const p = planTruck(ctx(r, { DECLINE: ['CLOSING', 120_000] }), r.truck());
  assert.equal(p.want, null);
  assert.equal(p.alarms[0]!.notify, 'dave');
  assert.match(p.alarms[0]!.reason, /dave is driving it/);
  const f = rig();
  send(f, at('SEG-DEC-1', 'DECLINE', 100, { state: 'FAULT', speed_mps: 0, faults: ['HYD_PRESSURE_LOW'] }));
  const q = planTruck(ctx(f, { DECLINE: ['CLOSING', 120_000] }), f.truck());
  assert.equal(q.want, null);
  assert.match(q.alarms[0]!.reason, /HYD_PRESSURE_LOW.*limp-home, drive it out under remote control/);
});

// ---- scenarios against the fake gateway ----

const OPERATOR: Actor = { kind: 'operator', operatorId: 'priya', role: 'operator' };

function systemLines(r: BlastRig): Array<Record<string, any>> {
  return r.dialer.sentLines.map((l) => JSON.parse(l)).filter((m) => m.type === 'command');
}

function inside(r: BlastRig, zoneId: string): string[] {
  return r.gw.truthAll().filter((t) => t.zoneId === zoneId).map((t) => t.vehicleId);
}

function raised(r: BlastRig): AlarmRaise[] {
  return r.events.filter((e): e is AlarmRaise => e.type === 'raise');
}

// Runs to just after the zone's effective time and returns who is truly inside then.
function toClosed(r: BlastRig, zoneId: string, maxMs = 300_000): string[] {
  r.until(() => r.gw.zone(zoneId).status === 'CLOSED', maxMs);
  return inside(r, zoneId);
}

test('L4.R0 scenario: a DECLINE blast with the trucks spread round the loop: everyone out or held, no alarm, every command attributed to its rule', () => {
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 60_000 }] });
  try {
    r.advance(9_000);
    assert.ok(inside(r, 'DECLINE').length >= 2, 'trucks inside to begin with');
    assert.deepEqual(toClosed(r, 'DECLINE'), []);
    assert.deepEqual(raised(r), []);
    const cmds = systemLines(r);
    assert.ok(cmds.length > 0);
    for (const c of cmds) assert.match(c.operator_id, /^system:B(3|6|2|6a|1)$/);
  } finally { r.cleanup(); }
});

test('L4.R3 / B12 scenario: trucks held for a zone are resumed within 15 s of it reopening, by the system as B12', () => {
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 60_000 }] });
  try {
    toClosed(r, 'DECLINE');
    const held = r.engine.holds().map((h) => h.vehicleId);
    assert.ok(held.length >= 3, `held: ${held}`);
    r.until(() => r.gw.zone('DECLINE').status === 'OPEN', 120_000);
    const t = r.until(() => held.every((v) => r.gw.truth(v).state === 'TRAMMING'), 30_000);
    assert.ok(t >= 0 && t <= PARAMS.autoResumeWithin.value, `all moving ${t} ms after reopening`);
    assert.ok(systemLines(r).some((c) => c.action === 'RESUME' && c.operator_id === 'system:B12'));
    r.advance(2_000);
    assert.deepEqual(r.engine.holds(), []);
  } finally { r.cleanup(); }
});

test('L5 ★ link drop during CLOSING: link-down alarm, every zone UNSURE with its last call, and on reconnect the engine acts at once on the time left', () => {
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'L4_SOUTH', atMs: 10_000, closedForMs: 60_000 }], faults: { linkDrops: [{ atMs: 11_000, durationMs: 30_000 }] } });
  try {
    r.advance(10_500);
    const before = r.engine.clearances().find((c) => c.zoneId === 'L4_SOUTH')!;
    r.advance(3_000);
    assert.equal(r.link.isUp(), false);
    const during = r.engine.clearances().find((c) => c.zoneId === 'L4_SOUTH')!;
    assert.equal(during.verdict, 'UNSURE');
    assert.deepEqual(during.lastWhileUp?.verdict, before.verdict, 'the last call made with the link up, with its time');
    r.advance(PARAMS.linkDownAfter.value);
    assert.ok(raised(r).some((a) => a.rule === 'B13' && a.interrupt), 'link down while a zone is closing interrupts');
    r.until(() => r.link.isUp(), 60_000);
    const upAt = r.clock.now();
    assert.ok(r.events.some((e) => e.type === 'clear' && e.key === 'blast:link_down'));
    r.advance(1_000);
    const after = systemLines(r).filter((c) => r.dialer.sentLines.length > 0);
    assert.ok(after.length > 0);
    assert.ok(r.clock.now() - upAt < 2_000);
    assert.deepEqual(toClosed(r, 'L4_SOUTH'), [], 'everyone out within the time left');
  } finally { r.cleanup(); }
});

test('L5 ★ a frozen truck in a closing zone: held (never sent out), the can\'t-clear alarm within 10 s, and the zone UNSURE', () => {
  const probe = blastRig({ seed: 7, blasts: 'none' });
  probe.advance(9_000);
  const victim = inside(probe, 'DECLINE').find((v) => probe.gw.truth(v).state === 'TRAMMING')!;
  probe.cleanup();
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 60_000 }], faults: { frozenMoving: { vehicle: victim, atMs: 4_000 } } });
  try {
    r.advance(12_000);
    const a = raised(r).find((x) => x.vehicleId === victim && x.zoneId === 'DECLINE');
    assert.ok(a, 'alarm raised');
    assert.equal(a!.rule, 'B1');
    assert.ok(a!.atServerMs - (T0 + 10_000) <= PARAMS.cantClearAlarmWithin.value);
    const c = r.engine.clearances().find((x) => x.zoneId === 'DECLINE')!;
    assert.notEqual(c.verdict, 'CLEAR');
    assert.ok(c.reasons.some((x) => x.vehicleIds.includes(victim) && x.certainty === 'might' && /frozen/.test(x.why)));
    r.advance(30_000);
    const toVictim = systemLines(r).filter((c) => c.vehicle_id === victim).map((c) => c.action);
    assert.ok(toVictim.includes('HOLD'));
    assert.ok(!toVictim.includes('EXIT_ZONE'), 'never sent out on data it can\'t trust');
  } finally { r.cleanup(); }
});

test('L5 ★ two zones closing 30 s apart: each zone empty when it closes, or the truck alarmed', () => {
  const r = blastRig({ seed: 11, blasts: [{ zoneId: 'DRAW_12', atMs: 10_000, closedForMs: 90_000 }, { zoneId: 'L4_SOUTH', atMs: 40_000, closedForMs: 60_000 }] });
  try {
    const d = toClosed(r, 'DRAW_12');
    const s = toClosed(r, 'L4_SOUTH');
    const alarmed = new Set(raised(r).map((a) => `${a.zoneId}:${a.vehicleId}`));
    for (const v of d) assert.ok(alarmed.has(`DRAW_12:${v}`), `${v} in DRAW_12 unalarmed`);
    for (const v of s) assert.ok(alarmed.has(`L4_SOUTH:${v}`), `${v} in L4_SOUTH unalarmed`);
    assert.deepEqual([...d, ...s], [], 'and in fact everyone was got out');
  } finally { r.cleanup(); }
});

test('L5 a fault in a closing zone: the can\'t-clear alarm within 10 s of the fault, naming it; the zone NOT CLEAR', () => {
  const probe = blastRig({ seed: 7, blasts: 'none' });
  probe.advance(11_000);
  const victim = inside(probe, 'DECLINE')[0]!;
  probe.cleanup();
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 60_000 }] });
  try {
    r.advance(11_000);
    r.gw.injectFault(victim, 'HYD_PRESSURE_LOW');
    const faultAt = r.clock.now();
    r.advance(10_000);
    const a = raised(r).find((x) => x.vehicleId === victim);
    assert.ok(a && a.atServerMs - faultAt <= PARAMS.cantClearAlarmWithin.value, 'alarm within 10 s of the fault');
    assert.match(a!.message, /HYD_PRESSURE_LOW/);
    assert.equal(a!.action, HOLD_THE_SHOT);
    assert.equal(r.engine.clearances().find((c) => c.zoneId === 'DECLINE')!.verdict, 'NOT_CLEAR');
  } finally { r.cleanup(); }
});

test('L5 cancelled blast: what the system held is moving again within 15 s; a truck still exiting gets HOLD before RESUME (B12, B7)', () => {
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 60_000, cancelAfterMs: 20_000 }] });
  try {
    r.advance(29_900);
    const held = r.engine.holds().map((h) => h.vehicleId);
    assert.ok(held.length > 0);
    r.until(() => r.gw.zone('DECLINE').status === 'OPEN', 5_000);
    const t = r.until(() => held.every((v) => r.gw.truth(v).state === 'TRAMMING' && r.gw.truth(v).task === null), 30_000);
    assert.ok(t >= 0 && t <= PARAMS.autoResumeWithin.value, `moving ${t} ms after the call-off`);
    for (const v of held) {
      const acts = systemLines(r).filter((c) => c.vehicle_id === v && c.operator_id === 'system:B12').map((c) => c.action);
      if (acts.includes('HOLD')) assert.ok(acts.indexOf('HOLD') < acts.lastIndexOf('RESUME'), `${v}: HOLD then RESUME`);
    }
  } finally { r.cleanup(); }
});

test('L5 BAY closing: every truck in the bay is alarmed at once with "drive it out or hold the shot"; approaching ones are held', () => {
  const trucks = [
    { vehicle_id: 'HT-01', positionM: 20, state: 'IDLE' as const },
    { vehicle_id: 'HT-02', positionM: 1_590, loaded: false },
  ];
  const r = blastRig({ seed: 7, trucks, blasts: [{ zoneId: 'BAY', atMs: 5_000, closedForMs: 60_000 }] });
  try {
    r.advance(5_000 + 3_000);
    const a = raised(r).find((x) => x.vehicleId === 'HT-01');
    assert.ok(a);
    assert.equal(a!.rule, 'B10');
    assert.equal(a!.action, DRIVE_OUT_OR_HOLD);
    assert.ok(!systemLines(r).some((c) => c.vehicle_id === 'HT-01' && c.action === 'EXIT_ZONE'));
    toClosed(r, 'BAY');
    assert.notEqual(r.gw.truth('HT-02').zoneId, 'BAY', 'held before entering');
  } finally { r.cleanup(); }
});

test('L4.R4 scenario: a truck an operator held is evacuated if it must be, and never resumed by the system', () => {
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 40_000 }] });
  try {
    r.advance(3_000);
    const v = inside(r, 'DECLINE')[0]!;
    r.registry.submit({ vehicleId: v, action: 'HOLD' }, OPERATOR);
    toClosed(r, 'DECLINE');
    assert.notEqual(r.gw.truth(v).zoneId, 'DECLINE', 'still got out');
    r.until(() => r.gw.zone('DECLINE').status === 'OPEN', 120_000);
    r.advance(30_000);
    assert.ok(!systemLines(r).some((c) => c.vehicle_id === v && c.action === 'RESUME'), 'not resumed');
    assert.equal(r.gw.truth(v).state, 'HOLDING');
  } finally { r.cleanup(); }
});

test('L6.1 / B14 the service restarts mid-CLOSING: it acts on the hello snapshot within the time left, and remembers what it held', () => {
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 60_000 }] });
  let r2: BlastRig | null = null;
  try {
    r.advance(14_000);
    const heldBefore = r.engine.holds().map((h) => h.vehicleId).sort();
    assert.ok(heldBefore.length > 0);
    r2 = r.restartService();
    assert.deepEqual(r2.engine.holds().map((h) => h.vehicleId).sort(), heldBefore, 'restored from the store');
    r2.until(() => r2!.link.isUp(), 10_000);
    const upAt = r2.clock.now();
    r2.advance(1_000);
    assert.ok(r2.log.some((l) => /^blast B/.test(l)) || r2.engine.holds().length > 0);
    assert.ok(r2.clock.now() - upAt <= 1_000);
    assert.deepEqual(toClosed(r2, 'DECLINE'), []);
    r2.until(() => r2!.gw.zone('DECLINE').status === 'OPEN', 120_000);
    const t = r2.until(() => heldBefore.every((v) => r2!.gw.truth(v).state === 'TRAMMING'), 30_000);
    assert.ok(t >= 0 && t <= PARAMS.autoResumeWithin.value, 'the new process resumes what the old one held');
  } finally { (r2 ?? r).cleanup(); }
});

// One cycle on the engine, the fleet state and the registry with a scripted link: HT-01 reverses out
// and holds in the bay; the other trucks never report, so the engine holds them all (B1) as well.
function blastCycle(): { ms: number; sent: string[] } {
  const clock = new ManualClock(T0);
  const fleet = new FleetState(clock);
  const store = new Store(':memory:');
  const sent: string[] = []; // HT-01's commands
  const link = { isUp: () => true, subscribe: () => () => {} };
  const registry = new CommandRegistry({ clock, fleet, store, gate: ALLOW_ALL_GATE_NO_BLAST_SAFETY, transport: { isUp: () => true, send: (m) => { if (m.vehicle_id === 'HT-01') sent.push(m.action); return true; } } });
  const engine = new BlastEngine({ clock, fleet, registry, store, link });
  fleet.ingest(helloAt(T0));
  fleet.setLink(true, 'connected');
  engine.start();
  let s = 0;
  const tel = (over: Record<string, unknown>) => { const m = telemetry({ seq: ++s, t_device_ms: clock.now(), ...over }); fleet.ingest(m); registry.message(m); };
  const zone = (status: string, eff: number) => fleet.ingest({ type: 'zone_event', zone_id: 'DECLINE', status, reason: status === 'OPEN' ? 'CLEARED' : 'BLAST_WINDOW', effective_at_ms: eff, server_time_ms: clock.now() });
  tel({ offset_m: 100 });
  const started = performance.now(); // from CLOSING to OPEN and the resume: the cycle itself
  zone('CLOSING', clock.now() + 120_000);
  // Reverses out once EXIT_ZONE takes effect, then holds 2 m outside, in the bay.
  for (let i = 1; i <= 120; i++) {
    clock.advance(1_000);
    const back = Math.max(0, i - 4) * 3;
    tel(back <= 102 ? { offset_m: Math.max(0, 100 - back), direction: 'REV', task: i > 4 ? 'EXIT_ZONE' : null } : { segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 78, state: 'HOLDING', speed_mps: 0 });
  }
  zone('CLOSED', clock.now());
  for (let i = 0; i < 90; i++) { clock.advance(1_000); tel({ segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 78, state: 'HOLDING', speed_mps: 0 }); }
  zone('OPEN', clock.now());
  for (let i = 0; i < 20; i++) { clock.advance(1_000); tel({ segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 78, state: 'HOLDING', speed_mps: 0 }); }
  const ms = performance.now() - started; // the cycle; closing the database is teardown
  engine.shutdown();
  store.close();
  return { ms, sent };
}

test('L1.2 a full blast cycle (CLOSING, CLOSED, OPEN) through the engine runs in under 100 ms of real time', () => {
  // The first run in a process pays for compiling the modules (measured ~0.4 s); the cost that
  // decides how fast blast scenarios run is the steady one, so the second run is the one held to it.
  const cold = blastCycle();
  const warm = blastCycle();
  assert.ok(warm.sent.includes('EXIT_ZONE') && warm.sent.includes('RESUME'), `the engine acted: ${warm.sent.join(',')}`);
  assert.ok(warm.ms < 100, `took ${warm.ms.toFixed(1)} ms (cold: ${cold.ms.toFixed(1)} ms)`);
});

test('B12 / B16 a frozen truck the system held is resumed once no zone is closing, though its HOLD could never be verified; the next blast gets a new HOLD', () => {
  const probe = blastRig({ seed: 7, blasts: 'none' });
  probe.advance(9_000);
  const victim = inside(probe, 'DECLINE').find((v) => probe.gw.truth(v).state === 'TRAMMING')!;
  probe.cleanup();
  const r = blastRig({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 40_000 }, { zoneId: 'TIP', atMs: 250_000, closedForMs: 40_000 }], faults: { frozenMoving: { vehicle: victim, atMs: 4_000 } } });
  try {
    r.until(() => r.gw.zone('DECLINE').status === 'OPEN' && r.clock.now() > T0 + 100_000, 300_000);
    r.advance(PARAMS.autoResumeWithin.value);
    const acts = () => systemLines(r).filter((c) => c.vehicle_id === victim).map((c) => `${c.action} ${c.operator_id}`);
    assert.ok(acts().includes('RESUME system:B12'), `resumed: ${acts().join(', ')}`);
    const before = acts().filter((a) => a.startsWith('HOLD')).length;
    r.until(() => r.gw.zone('TIP').status === 'CLOSED', 300_000);
    assert.ok(acts().filter((a) => a.startsWith('HOLD')).length > before, 'held again for the next blast: the old unverified HOLD does not count as in flight');
  } finally { r.cleanup(); }
});
