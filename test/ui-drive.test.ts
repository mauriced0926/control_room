// Task 7: the driving view's words (src/ui/drive.ts) and the Take control button for a truck the
// system holds (BLAST.md B6a). Pure: plain data in, words out.
// Cases: L7.2 (what each lag number says, and its level against the deadman), UI.md's driving-view
// states (old, silent, contradicted, site link down, service down), L7.7's limit, L7.3's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DriveView } from '../src/drive.ts';
import type { TruckView } from '../src/fleet.ts';
import { buttons } from '../src/ui/detail.ts';
import { drivePanel, holderWords, lostWords, throttleFor } from '../src/ui/drive.ts';

const view = (over: Partial<DriveView> = {}): DriveView => ({
  vehicleId: 'T1', operatorId: 'priya', system: false, sinceServerMs: 0, inputAgeMs: 80, lastThrottle: 0.5, lastAsked: 0.5,
  echo: { seq: 10, ageMs: 300, roundTripMs: 250, stats: { samples: 0, p50Ms: null, p95Ms: null, maxMs: null } },
  deadman: false, refusal: null, siteRejected: null, relayed: 10, dropped: 0, topSpeedMps: 4, limp: false,
  ahead: { FWD: { direction: 'FWD', distanceM: 42.4, zoneId: 'Z2', status: 'CLOSED', effectiveAtMs: null }, REV: { direction: 'REV', distanceM: 10, zoneId: 'Z0', status: 'OPEN', effectiveAtMs: null } },
  ...over,
});

const truck = (over: Partial<TruckView> = {}): TruckView => ({
  vehicleId: 'T1', confidence: 'live', confidenceReason: 'reporting normally', ageMs: 100,
  speedMps: { value: 2, atServerMs: 0, ageMs: 100 }, direction: { value: 'FWD', atServerMs: 0, ageMs: 100 },
  control: { value: { mode: 'MANUAL', operatorId: 'priya', deadman: false, lastDriveSeq: 10, lastDriveSentMs: 0 }, atServerMs: 0, ageMs: 100 },
  faults: { value: [], atServerMs: 0, ageMs: 100 }, loaded: false,
  ...over,
} as TruckView);

const panel = (o: { v?: Partial<DriveView>; t?: Partial<TruckView>; since?: number; site?: boolean; service?: boolean; streaming?: boolean } = {}) =>
  drivePanel({ view: view(o.v), truck: truck(o.t), sinceFrameMs: o.since ?? 0, siteLinkDown: o.site ?? false, serviceDown: o.service ?? false, direction: 'FWD', streaming: o.streaming ?? true });

test('L7.2 each lag number says what it measures, and its level is against the 0.5 s deadman; ages count on between frames', () => {
  const p = panel();
  assert.equal(p.input.text, '80 ms since the service last sent your input to T1');
  assert.equal(p.input.level, 'ok');
  assert.match(p.echo.text, /^300 ms since the service sent the newest input T1 reports applying \(round trip \+ up to 200 ms telemetry sampling\)$/);
  assert.equal(p.thresholdFraction, 0.5);
  const later = panel({ since: 450 });
  assert.equal(later.input.ms, 530);
  assert.equal(later.input.level, 'bad');
  assert.match(later.deadman.words, /^Deadman due: no input for 530 ms/);
  assert.equal(panel({ v: { inputAgeMs: 300 } }).input.level, 'warn');
  assert.equal(panel({ v: { echo: { ...view().echo, ageMs: null } } }).echo.text, 'T1 has not reported applying any input yet');
});

test('the deadman in words for each state the driving view must show (UI.md)', () => {
  assert.equal(panel().deadman.words, 'Deadman armed: input arriving.');
  assert.match(panel({ t: { control: { ...truck().control!, value: { ...truck().control!.value, deadman: true } } } }).deadman.words, /^Deadman tripped: stopped/);
  assert.equal(panel({ site: true }).deadman.words, 'Site link down: the truck stops on its deadman.');
  assert.match(panel({ service: true }).deadman.words, /^Service disconnected: nothing from this screen reaches the truck/);
  assert.match(panel({ t: { confidence: 'silent', confidenceReason: 'no message for 6.0 s', ageMs: 6_000 } }).deadman.words, /deadman should have stopped it; this screen can't confirm/);
  assert.match(panel({ t: { confidence: 'silent', ageMs: 6_000 } }).warning!, /^Silent for 6 s/);
  assert.match(panel({ t: { confidence: 'contradicted' } }).warning!, /^Data frozen: position unknown\. Driving refused/);
  assert.match(panel({ t: { confidence: 'old', confidenceReason: 'last position 3.0 s ago' } }).warning!, /lag figures are late too/);
  assert.match(panel({ streaming: false }).warning!, /^Not sending: this window is not in front/);
});

test('speed, the limp-home limit, the boundaries each way with their zone\'s status, and a refusal', () => {
  const p = panel();
  assert.equal(p.speed, '2.0 m/s forward');
  assert.deepEqual(p.ahead, { words: 'Forward: 42 m to Z2, CLOSED', level: 'bad' });
  assert.deepEqual(p.behind, { words: 'Reverse: 10 m to Z0, OPEN', level: 'ok' });
  assert.equal(p.limit, null);
  const limp = panel({ v: { limp: true, topSpeedMps: 1 }, t: { faults: { value: ['HYD_PRESSURE_LOW'], atServerMs: 0, ageMs: 0 } } });
  assert.equal(limp.limit, 'Limp-home (HYD_PRESSURE_LOW): limited to 1.0 m/s');
  assert.equal(panel({ v: { refusal: { code: 'ZONE_CLOSED', reason: 'Stopped: Z2 is CLOSED', zoneId: 'Z2', atServerMs: 0, current: true } } }).refusal, 'Stopped: Z2 is CLOSED');
  assert.equal(panel({ v: { refusal: { code: 'ZONE_CLOSED', reason: 'Stopped: Z2 is CLOSED', zoneId: 'Z2', atServerMs: 0, current: false } } }).refusal, null, 'gone once input is allowed again');
  assert.deepEqual([throttleFor('FWD', 0.5), throttleFor('REV', 0.25), throttleFor(null, 1)], [0.5, -0.25, 0]);
});

test('L7.3 the driver who lost a truck is told who took it and when; a system:B6a lease is explained; only a supervisor can take it now', () => {
  const end = { vehicleId: 'T1', operatorId: 'priya', event: 'REVOKED', reason: 'FORCED_TAKEOVER', by: 'marta', atServerMs: 0 };
  assert.equal(lostWords(end, 'priya', () => '03:12:00'), 'marta took control of T1 from you at 03:12:00. Your input is no longer sent.');
  assert.equal(lostWords(end, 'dave', () => ''), null, 'only to the one who lost it');
  assert.match(holderWords('system:B6a', 'T1'), /^The system holds T1's controls under blast rule B6a/);

  const sys = truck({ control: { ...truck().control!, value: { ...truck().control!.value, operatorId: 'system:B6a' } } });
  const op = buttons(sys, { id: 'priya', role: 'operator' }, null).filter((b) => b.action === 'TAKE_CONTROL');
  assert.equal(op.length, 1);
  assert.match(op[0]!.disabled!, /^The system holds it for a blast \(system:B6a\); its control lapses by itself within 10 s; a supervisor can take over now$/);
  const sup = buttons(sys, { id: 'marta', role: 'supervisor' }, null).filter((b) => b.action === 'TAKE_CONTROL');
  assert.deepEqual(sup.map((b) => [b.label, b.force ?? false, !!b.disabled]), [['Take control', false, true], ['Take over from system:B6a', true, false]]);
});
