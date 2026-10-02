// TESTING.md L2.27-L2.28: battery. SoC is the pack's own number; we add drain against the fleet and
// whether the truck can reach the bay. Warnings name the action and leave it to the operator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { FleetState, type TruckView } from '../src/fleet.ts';
import { PARAMS } from '../src/params.ts';
import { buildSite } from '../src/site.ts';
import { fixture, helloFor, otherRoute } from './helpers/fixtures.ts';
import { replay } from './helpers/rig.ts';

const STEP = 200;

// A different site: bay North [850, 900)+[0, 100), Ramp [100, 300), Face (load) [300, 500),
// Shaft (dump) [500, 850). Trucks are driven along it at 3 m/s, draining a known %/m.
function otherFleet(vehicles: string[]) {
  const hello = helloFor(otherRoute(), 900, vehicles, 1_000_000);
  const site = buildSite(hello).site;
  const clock = new ManualClock(1_000_000);
  const fleet = new FleetState(clock);
  fleet.ingest(hello);
  const seqs = new Map<string, number>();
  const send = (id: string, loopM: number, soc: number, over: Record<string, unknown> = {}) => {
    const p = ((loopM % 900) + 900) % 900;
    const s = site.segments.find((x) => p >= x.startM && p < x.startM + x.lengthM)!;
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    fleet.ingest({
      type: 'telemetry', vehicle_id: id, seq, t_device_ms: clock.now(), state: 'TRAMMING', task: null,
      soc_pct: Math.round(soc * 100) / 100, speed_mps: 3, direction: 'FWD', segment_id: s.segmentId, zone_id: s.zoneId,
      offset_m: p - s.startM, payload_kg: 0, faults: [],
      control: { mode: 'AUTO', operator_id: null, deadman: false, last_drive_seq: null, last_drive_sent_ms: null }, ...over,
    });
  };
  // Drives every truck together, `metres` forward, each at its own drain.
  const drive = (trucks: Array<{ id: string; fromM: number; soc: number; pctPerM: number }>, metres: number) => {
    const perStep = 3 * (STEP / 1000);
    for (let d = 0; d <= metres + 1e-9; d += perStep) {
      for (const t of trucks) send(t.id, t.fromM + d, t.soc - t.pctPerM * d);
      clock.advance(STEP);
    }
    fleet.tick();
  };
  const truck = (id: string): TruckView => fleet.snapshot().trucks.find((t) => t.vehicleId === id)!;
  return { site, clock, fleet, send, drive, truck };
}

const HEALTHY = 0.006; // %/m empty, this site's measured fleet median (6.0 %/km)

test('L2.27 a truck draining well above the fleet median is flagged; the fleet is not', () => {
  const f = otherFleet(['W', 'A', 'B', 'C']);
  f.drive([
    { id: 'W', fromM: 110, soc: 30, pctPerM: HEALTHY * 5 },
    { id: 'A', fromM: 120, soc: 60, pctPerM: HEALTHY },
    { id: 'B', fromM: 130, soc: 70, pctPerM: HEALTHY * 1.02 },
    { id: 'C', fromM: 140, soc: 80, pctPerM: HEALTHY * 0.98 },
  ], 120);
  const w = f.truck('W');
  assert.ok(w.battery.drain.emptyPctPerKm !== null && Math.abs(w.battery.drain.emptyPctPerKm - 30) < 1, `${w.battery.drain.emptyPctPerKm}`);
  assert.ok(w.battery.ratioToFleet.empty !== null && w.battery.ratioToFleet.empty > 4.5);
  assert.equal(w.battery.drainHigh, true);
  for (const id of ['A', 'B', 'C']) assert.equal(f.truck(id).battery.drainHigh, false, id);
});

test('L2.27 no verdict without enough evidence, or without enough of a fleet', () => {
  const short = otherFleet(['W', 'A', 'B', 'C']);
  short.drive([
    { id: 'W', fromM: 110, soc: 30, pctPerM: HEALTHY * 5 },
    { id: 'A', fromM: 120, soc: 60, pctPerM: HEALTHY },
    { id: 'B', fromM: 130, soc: 70, pctPerM: HEALTHY },
    { id: 'C', fromM: 140, soc: 80, pctPerM: HEALTHY },
  ], PARAMS.drainMinEvidence.value / 2);
  assert.equal(short.truck('W').battery.drain.emptyPctPerKm, null);
  assert.equal(short.truck('W').battery.drainHigh, false);
  const lonely = otherFleet(['W', 'A']);
  lonely.drive([{ id: 'W', fromM: 110, soc: 30, pctPerM: HEALTHY * 5 }, { id: 'A', fromM: 120, soc: 60, pctPerM: HEALTHY }], 150);
  assert.equal(lonely.truck('W').battery.ratioToFleet.empty, null);
  assert.equal(lonely.truck('W').battery.drainHigh, false);
});

test('L2.28 warns, naming the action, while the truck can still reach the bay; then that it cannot', () => {
  const f = otherFleet(['W', 'A', 'B', 'C']);
  f.drive([
    { id: 'W', fromM: 110, soc: 30, pctPerM: HEALTHY * 5 },
    { id: 'A', fromM: 120, soc: 30, pctPerM: HEALTHY },
    { id: 'B', fromM: 130, soc: 70, pctPerM: HEALTHY },
    { id: 'C', fromM: 140, soc: 80, pctPerM: HEALTHY },
  ], 120);
  const w = f.truck('W');
  // W is at 230 m with 26.4 %. Shorter way to the bay: back 130 m to its end, 3.9 % at its own rate.
  assert.equal(w.battery.reach.toBay?.direction, 'REV');
  assert.ok(Math.abs(w.battery.reach.toBay!.distanceM - 130) < 1);
  assert.ok(Math.abs(w.battery.reach.toBay!.needPct - 3.9) < 0.2);
  // Its duty cycle goes on forward: 270 m empty to the end of the load segment, then 350 m loaded to
  // the end of the dump segment, which is the bay. Loaded drain is estimated from the fleet's
  // loaded/empty ratio, here the measured fallback since no truck has loaded evidence yet.
  const route = w.battery.reach.onRoute!;
  assert.ok(Math.abs(route.distanceM - 620) < 1, `${route.distanceM}`);
  assert.ok(Math.abs(route.needPct - (270 * 0.03 + 350 * 0.03 * PARAMS.loadedDrainFactor.value)) < 0.3, `${route.needPct}`);
  assert.equal(w.battery.warning, 'WONT_FINISH_LAP');
  assert.match(w.battery.message ?? '', /return to bay/i);
  assert.ok(w.socPct!.value > w.battery.reach.toBay!.needPct, 'warned while it still could get home');
  // A healthy truck with the same charge is fine.
  assert.equal(f.truck('A').battery.warning, null);

  // Lower charge at the same place: the shorter way is out of reach too.
  f.send('W', 231, 3);
  assert.equal(f.truck('W').battery.warning, 'CANNOT_REACH_BAY');
  // Already returning: the route is the shorter way, so only that matters.
  f.send('W', 232, 26, { task: 'RETURN_TO_BAY', direction: 'REV' });
  assert.equal(f.truck('W').battery.warning, null);
  // Depleted: a tow, whatever the numbers say.
  f.send('W', 232, 0, { state: 'FAULT', speed_mps: 0, faults: ['BATTERY_DEPLETED'] });
  assert.equal(f.truck('W').battery.warning, 'DEPLETED');
  assert.match(f.truck('W').battery.message ?? '', /tow/i);
});

test('L2.28 a truck about to charge is not warned about the lap it will not drive yet', () => {
  const f = otherFleet(['W', 'A', 'B', 'C']);
  f.drive([
    { id: 'W', fromM: 750, soc: 30, pctPerM: HEALTHY * 5 },
    { id: 'A', fromM: 120, soc: 60, pctPerM: HEALTHY },
    { id: 'B', fromM: 130, soc: 70, pctPerM: HEALTHY },
    { id: 'C', fromM: 140, soc: 80, pctPerM: HEALTHY },
  ], 150);
  // W has wrapped into the bay (North) with 25.5 %: just above the charge threshold, so it will leave
  // on another lap, and at its drain that lap is out of reach.
  const w = f.truck('W');
  assert.equal(w.position?.value.zoneId, 'North');
  assert.equal(w.battery.warning, 'WONT_FINISH_LAP');
  // Below the charge threshold it will charge at the end of the bay: no warning.
  f.send('W', 20, PARAMS.chargeBelow.value - 1);
  assert.equal(f.truck('W').battery.warning, null);
  f.send('W', 99, 20, { state: 'CHARGING', speed_mps: 0 });
  assert.equal(f.truck('W').battery.warning, null);
});

test('L2.27 / L3.10 weak-pack: HT-06 flagged in its first minute, warned while it could still get home, then needs a tow', () => {
  const recs = fixture('weak-pack');
  const rx = recs.filter((r) => r.rx_ms !== undefined).map((r) => r.rx_ms!);
  assert.ok(rx.every((t, i) => i === 0 || t >= rx[i - 1]!), 'weak-pack.jsonl is in arrival order on disk');
  let flaggedAt: number | null = null;
  let firstWarning: { at: number; warning: string; soc: number; toBayNeed: number } | null = null;
  const othersFlagged = new Set<string>();
  const othersWarned = new Set<string>();
  const { fleet, start } = replay(recs, {
    onRecord: (_r, f, c) => {
      for (const t of f.snapshot().trucks) {
        if (t.vehicleId === 'HT-06') {
          if (t.battery.drainHigh && flaggedAt === null) flaggedAt = c.now();
          if (t.battery.warning && !firstWarning) {
            firstWarning = { at: c.now(), warning: t.battery.warning, soc: t.socPct!.value, toBayNeed: t.battery.reach.toBay?.needPct ?? Infinity };
          }
        } else {
          if (t.battery.drainHigh) othersFlagged.add(t.vehicleId);
          if (t.battery.warning) othersWarned.add(`${t.vehicleId}:${t.battery.warning}`);
        }
      }
    },
  });
  assert.ok(flaggedAt !== null, 'HT-06 flagged');
  assert.ok(flaggedAt! - start <= 60_000, `flagged ${(flaggedAt! - start) / 1000} s in`);
  assert.deepEqual([...othersFlagged], [], 'no other truck flagged');
  assert.deepEqual([...othersWarned], [], 'no other truck warned');
  assert.ok(firstWarning, 'HT-06 warned');
  const fw = firstWarning as unknown as { at: number; warning: string; soc: number; toBayNeed: number };
  assert.equal(fw.warning, 'WONT_FINISH_LAP');
  assert.ok(fw.soc > fw.toBayNeed * PARAMS.batteryReserveFactor.value, 'it could still reach the bay by the shorter way');
  assert.ok(fw.at - start <= 60_000, `warned ${(fw.at - start) / 1000} s in`);
  const end = fleet.snapshot().trucks.find((t) => t.vehicleId === 'HT-06')!;
  assert.equal(end.state?.value, 'FAULT');
  assert.deepEqual(end.faults?.value, ['BATTERY_DEPLETED']);
  assert.equal(end.battery.warning, 'DEPLETED');
  assert.equal(end.socFractional, false, 'a pack draining through 1 % is not a fraction');
  // HT-12 reports fractions all run: never judged on them.
  const ht12 = fleet.snapshot().trucks.find((t) => t.vehicleId === 'HT-12')!;
  assert.equal(ht12.socFractional, true);
  assert.equal(ht12.battery.drain.emptyPctPerKm, null);
});
