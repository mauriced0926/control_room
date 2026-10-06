// The safety check below every command path (TESTING.md L2.50-L2.54): the blast engine's gate, in the
// registry, against the fake gateway. Operators and the system go through the same check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlastGate } from '../src/gate.ts';
import type { Actor } from '../src/registry.ts';
import { blastRig, type BlastRig } from './helpers/blast-rig.ts';

const PRIYA: Actor = { kind: 'operator', operatorId: 'priya', role: 'operator' };
const SYSTEM: Actor = { kind: 'system', rule: 'B3' };
const gated = (config: Parameters<typeof blastRig>[0]) => blastRig(config, { gate: (fleet, engine) => new BlastGate(fleet, engine) });

function ready(r: BlastRig, ms = 3_000): void {
  r.until(() => r.link.isUp(), 5_000);
  r.advance(ms);
}

test('L2.50 RETURN_TO_BAY by the shorter way through a zone that is closing is refused with the reason; with every zone open it goes', () => {
  // In the second half of INCLINE the bay is shorter ahead, through TIP.
  const r = gated({ trucks: [{ vehicle_id: 'HT-01', positionM: 1_450, loaded: true, state: 'HOLDING' }], blasts: [{ zoneId: 'TIP', atMs: 5_000, closedForMs: 60_000 }] });
  try {
    ready(r);
    const ok = r.registry.submit({ vehicleId: 'HT-01', action: 'RETURN_TO_BAY' }, PRIYA);
    assert.notEqual(ok.status, 'refused', 'all open: sent');
    r.advance(3_000);
    const no = r.registry.submit({ vehicleId: 'HT-01', action: 'RETURN_TO_BAY' }, PRIYA);
    assert.equal(no.status, 'refused');
    assert.equal(no.failure!.code, 'RTB_THROUGH_CLOSING_ZONE');
    assert.match(no.failure!.message, /shorter way to the bay \(ahead\) goes through TIP \(closing in \d+ s\)/);
  } finally { r.cleanup(); }
});

test('L2.51 an operator RESUME of a truck the system held for a blast is refused while the zone is not open, naming it', () => {
  const r = gated({ seed: 7, blasts: [{ zoneId: 'DECLINE', atMs: 10_000, closedForMs: 60_000 }] });
  try {
    r.until(() => r.engine.holds().length > 0, 30_000);
    r.advance(10_000);
    const h = r.engine.holds()[0]!;
    const res = r.registry.submit({ vehicleId: h.vehicleId, action: 'RESUME' }, PRIYA);
    assert.equal(res.status, 'refused');
    assert.equal(res.failure!.code, 'BLAST_HOLD');
    assert.match(res.failure!.message, new RegExp(`${h.vehicleId} is held for the blast in DECLINE \\(closing in \\d+ s\\)\\. It can't be resumed until it reopens`));
  } finally { r.cleanup(); }
});

test('L2.52 / L2.53 EXIT_ZONE whose nearest way out leads into a closing zone is refused: the same check, the same words, for an operator and for the system', () => {
  // 5 m short of the draw point, in L4_NORTH: the nearest way out is ahead, into DRAW_12.
  const r = gated({ trucks: [{ vehicle_id: 'HT-01', positionM: 775, state: 'HOLDING' }], blasts: [{ zoneId: 'DRAW_12', atMs: 5_000, closedForMs: 60_000 }] });
  try {
    ready(r, 6_000);
    const op = r.registry.submit({ vehicleId: 'HT-01', action: 'EXIT_ZONE' }, PRIYA);
    const sys = r.registry.submit({ vehicleId: 'HT-01', action: 'EXIT_ZONE' }, SYSTEM);
    for (const rec of [op, sys]) {
      assert.equal(rec.status, 'refused');
      assert.equal(rec.failure!.code, 'EXIT_ZONE_INTO_CLOSING_ZONE');
      assert.match(rec.failure!.message, /leads into DRAW_12 \(closing in \d+ s\).*drive it out the other way/);
    }
    assert.ok(!r.dialer.sentLines.some((l) => /"EXIT_ZONE"/.test(l)), 'nothing reached the gateway');
    // Stopping is never refused.
    assert.notEqual(r.registry.submit({ vehicleId: 'HT-01', action: 'HOLD' }, PRIYA).status, 'refused');
    assert.notEqual(r.registry.submit({ vehicleId: 'HT-01', action: 'ESTOP' }, PRIYA).status, 'refused');
  } finally { r.cleanup(); }
});

test('L2.53 a RESUME that would put the truck in a closing zone straight away is refused for the system as for an operator', () => {
  const r = gated({ trucks: [{ vehicle_id: 'HT-01', positionM: 70, state: 'HOLDING' }], blasts: [{ zoneId: 'DECLINE', atMs: 5_000, closedForMs: 60_000 }] });
  try {
    ready(r, 6_000);
    for (const actor of [PRIYA, { kind: 'system', rule: 'B12' } as Actor]) {
      const rec = r.registry.submit({ vehicleId: 'HT-01', action: 'RESUME' }, actor);
      assert.equal(rec.status, 'refused');
      assert.equal(rec.failure!.code, 'INTO_CLOSING_ZONE');
      assert.match(rec.failure!.message, /would be in DECLINE/);
    }
  } finally { r.cleanup(); }
});

test('L2.54 EXIT_ZONE in a bay is refused before it reaches the site, with "drive it out, or hold the shot"', () => {
  const r = gated({ trucks: [{ vehicle_id: 'HT-01', positionM: 20, state: 'IDLE' }], blasts: [{ zoneId: 'BAY', atMs: 5_000, closedForMs: 60_000 }] });
  try {
    ready(r, 6_000);
    const rec = r.registry.submit({ vehicleId: 'HT-01', action: 'EXIT_ZONE' }, PRIYA);
    assert.equal(rec.status, 'refused');
    assert.equal(rec.failure!.code, 'EXIT_ZONE_IN_BAY');
    assert.match(rec.failure!.message, /Drive it out, or hold the shot/);
  } finally { r.cleanup(); }
});

test('B1 through the gate: EXIT_ZONE to a truck whose data is frozen is refused while a zone is closing', () => {
  const probe = gated({ seed: 7, blasts: 'none' });
  ready(probe, 1_000);
  const victim = probe.gw.truthAll().find((t) => t.state === 'TRAMMING' && t.zoneId === 'DECLINE')!.vehicleId;
  probe.cleanup();
  const r = gated({ seed: 7, blasts: [{ zoneId: 'TIP', atMs: 5_000, closedForMs: 60_000 }], faults: { frozenMoving: { vehicle: victim, atMs: 1_000 } } });
  try {
    ready(r, 8_000);
    assert.equal(r.fleet.truck(victim)!.confidence, 'contradicted');
    const rec = r.registry.submit({ vehicleId: victim, action: 'EXIT_ZONE' }, PRIYA);
    assert.equal(rec.status, 'refused');
    assert.equal(rec.failure!.code, 'EXIT_ZONE_UNSURE');
  } finally { r.cleanup(); }
});
