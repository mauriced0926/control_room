// TESTING.md L2.39: every refusal reason in PROTOCOL.md §4.5 maps to a distinct message in the
// operator's words; L2.34 and L2.35 for the two that matter most.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REJECT_REASONS } from '../src/protocol.ts';
import { refusal } from '../src/refusals.ts';

test('L2.39 every protocol reason has its own message, naming the truck, never the bare code', () => {
  const messages = REJECT_REASONS.map((r) => refusal(r, { vehicleId: 'T7', action: 'HOLD', holder: 'priya', state: 'TRAMMING', faults: ['HYD_PRESSURE_LOW'] }).message);
  assert.equal(new Set(messages).size, REJECT_REASONS.length, 'all distinct');
  for (const [i, m] of messages.entries()) {
    assert.ok(!m.includes(REJECT_REASONS[i]!), `${REJECT_REASONS[i]} message shows the bare code: ${m}`);
    if (REJECT_REASONS[i] !== 'UNSUPPORTED_ACTION') assert.match(m, /T7/);
  }
});

test('L2.34 COMMAND_ID_REUSED is reported as our bug and never retried', () => {
  const r = refusal('COMMAND_ID_REUSED', { vehicleId: 'T7', action: 'HOLD' });
  assert.equal(r.ourFault, true);
  assert.equal(r.retry, false);
  assert.match(r.message, /our software's fault/);
});

test('L2.35 LEASE_HELD names the holder', () => {
  assert.match(refusal('LEASE_HELD', { vehicleId: 'T7', action: 'HOLD', holder: 'jsmith' }).message, /driven by jsmith/);
});

test('INTERLOCK_ACTIVE names the fault; INVALID_STATE explains a command still on its way (re-probe Q3)', () => {
  assert.match(refusal('INTERLOCK_ACTIVE', { vehicleId: 'T7', action: 'HOLD', faults: ['HYD_PRESSURE_LOW'] }).message, /HYD_PRESSURE_LOW/);
  const m = refusal('INVALID_STATE', { vehicleId: 'T7', action: 'RESUME', state: 'TRAMMING', inFlight: { action: 'HOLD', sentAgoMs: 1_000 } }).message;
  assert.match(m, /HOLD sent 1\.0 s ago is still on its way/);
  assert.match(m, /cannot be called back/);
});

test('a RESUME refused for a truck that reports HOLDING is surfaced as a contradiction (CONTEXT.md assumption 12)', () => {
  assert.match(refusal('INVALID_STATE', { vehicleId: 'T7', action: 'RESUME', state: 'HOLDING' }).message, /may be wrong/);
});
