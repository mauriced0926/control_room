// TESTING.md L2.30-L2.38 (the command registry), L6.6, L7.8, L8.1-L8.5, against a scripted
// transport. Hand-built telemetry, one case per test; fixtures are replayed in registry-fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../src/params.ts';
import { AckBook, ALLOW_ALL_GATE_NO_BLAST_SAFETY, matchAck, supervisoryDeadlineMs, type SafetyGate } from '../src/registry.ts';
import { helloAt } from './helpers/fixtures.ts';
import { BLAST, DAVE, MARTA, PRIYA, regRig } from './helpers/registry-rig.ts';

const V = 'HT-04';
const HOLDING = { state: 'HOLDING', speed_mps: 0 };
const DEADLINE = supervisoryDeadlineMs();

// ---- ack matching ----

test('L2.33 matchAck: the latest send at or before the ack, by time', () => {
  const sends = [{ atMs: 0 }, { atMs: 100 }, { atMs: 200 }];
  assert.equal(matchAck(sends, 150), 1);
  assert.equal(matchAck(sends, 200), 2);
  assert.equal(matchAck(sends, 5_000), 2);
  assert.equal(matchAck(sends, -1), -1);
  assert.equal(matchAck([], 10), -1);
});

test('L2.33 AckBook: the first send\'s ack is lost; the resend\'s ack is the resend\'s, not "the first ack" (AI_LOG.md entry 1)', () => {
  const book = new AckBook();
  book.sent('X', 1_000);      // ack lost on the radio
  book.sent('X', 6_000);      // resent with the same id
  assert.deepEqual(book.ack('X', 6_300), { sendIndex: 1, duplicate: false });
  assert.deepEqual(book.ack('X', 6_400), { sendIndex: 1, duplicate: true }, 'a second ack for the same send is a duplicate');
  assert.equal(book.ack('Y', 7_000), null, 'not ours');
  const late = new AckBook();
  late.sent('Z', 5_000);
  assert.equal(late.ack('Z', 4_999), null, 'an ack cannot answer a send it came before');
});

// ---- confirmation by effect ----

test('L2.30 ack before the effect, and effect before the ack: both end confirmed', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    assert.equal(r.registry.get(a.id)!.status, 'acknowledged');
    assert.match(r.registry.get(a.id)!.summary, /accepted, not carried out yet/);
    r.advance(2_000);
    r.tel(V, HOLDING);
    assert.equal(r.registry.get(a.id)!.status, 'confirmed');
    assert.equal(r.registry.get(a.id)!.effect!.ackReceived, true);

    r.tel('HT-05', { offset_m: 100 });
    const b = r.registry.submit({ vehicleId: 'HT-05', action: 'HOLD' }, PRIYA);
    r.advance(1_000);
    r.tel('HT-05', HOLDING);
    assert.equal(r.registry.get(b.id)!.status, 'confirmed', 'effect first');
    r.ack(r.sent[1]!.command_id, 'ACCEPTED');
    const after = r.registry.get(b.id)!;
    assert.equal(after.status, 'confirmed');
    assert.equal(after.attempts[0]!.ack?.status, 'ACCEPTED', 'the late ack is still recorded');
  } finally { r.cleanup(); }
});

test('L2.31 ack lost, effect seen: confirmed, with "no ack received" recorded', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.advance(3_000);
    r.tel(V, HOLDING);
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.status, 'confirmed');
    assert.equal(rec.effect!.ackReceived, false);
    assert.match(rec.summary, /no ack received/);
    assert.ok(r.store.auditLog(V).some((e) => e.event === 'confirmed' && /no ack received/.test(e.what)));
  } finally { r.cleanup(); }
});

test('L2.32 a duplicate ack changes nothing', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    const cid = r.sent[0]!.command_id;
    r.ack(cid, 'ACCEPTED');
    const before = r.registry.get(a.id)!;
    r.ack(cid, 'ACCEPTED');
    const after = r.registry.get(a.id)!;
    assert.equal(after.status, before.status);
    assert.deepEqual(after.attempts[0]!.ack, before.attempts[0]!.ack);
    assert.equal(after.attempts[0]!.duplicateAcks, 1);
    assert.equal(r.sent.length, 1);
  } finally { r.cleanup(); }
});

test('the effect must come from telemetry after the send, and believable telemetry: an old HOLDING does not confirm', () => {
  const r = regRig();
  try {
    r.tel(V, HOLDING);
    r.advance(500);
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.registry.tick();
    assert.equal(r.registry.get(a.id)!.status, 'sent', 'the last report predates the send');
    r.tel(V, HOLDING);
    assert.equal(r.registry.get(a.id)!.status, 'confirmed');
  } finally { r.cleanup(); }
});

// ---- refusals ----

test('L2.34 COMMAND_ID_REUSED: reported as our bug, never retried', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.ack(r.sent[0]!.command_id, 'REJECTED', { reason: 'COMMAND_ID_REUSED' });
    r.advance(3 * DEADLINE);
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.status, 'failed');
    assert.equal(rec.failure!.ourFault, true);
    assert.equal(r.sent.length, 1, 'never retried');
  } finally { r.cleanup(); }
});

test('L2.35 and L8.1: LEASE_HELD names the holder, and the holder is told as well as the sender', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.ack(r.sent[0]!.command_id, 'REJECTED', { reason: 'LEASE_HELD', holder: 'dave' });
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.status, 'failed');
    assert.match(rec.failure!.message, /driven by dave/);
    const n = r.events.find((e) => e.type === 'notify');
    assert.ok(n && n.type === 'notify');
    assert.deepEqual([...n.to].sort(), ['dave', 'priya']);
    assert.match(n.message, /priya tried to HOLD HT-04, but dave holds its controls/);
    r.advance(3 * DEADLINE);
    assert.equal(r.sent.length, 1, 'a truck that cannot comply is not retried');

    // The system's own command, blocked the same way, reaches the holder too.
    const b = r.registry.submit({ vehicleId: V, action: 'HOLD' }, BLAST);
    r.ack(r.sent[1]!.command_id, 'REJECTED', { reason: 'LEASE_HELD', holder: 'dave' });
    assert.equal(r.registry.get(b.id)!.status, 'failed');
    const n2 = r.events.filter((e) => e.type === 'notify').at(-1);
    assert.ok(n2 && n2.type === 'notify');
    assert.deepEqual(n2.to, ['dave']);
    assert.match(n2.message, /the system \(blast-evacuation\)/);
  } finally { r.cleanup(); }
});

test('INTERLOCK_ACTIVE fails at once, naming the fault, and is never retried', () => {
  const r = regRig();
  try {
    r.tel(V, { state: 'FAULT', speed_mps: 0, faults: ['HYD_PRESSURE_LOW'] });
    const a = r.registry.submit({ vehicleId: V, action: 'EXIT_ZONE' }, BLAST);
    r.ack(r.sent[0]!.command_id, 'REJECTED', { reason: 'INTERLOCK_ACTIVE' });
    r.advance(3 * DEADLINE);
    assert.equal(r.registry.get(a.id)!.status, 'failed');
    assert.match(r.registry.get(a.id)!.failure!.message, /HYD_PRESSURE_LOW/);
    assert.equal(r.sent.length, 1);
  } finally { r.cleanup(); }
});

// ---- deadlines (L2.36) ----

test('L2.36 deadline when tramming: the 6 s delay plus telemetry latency plus uplink', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    assert.equal(DEADLINE, PARAMS.supervisoryDelayMax.value + PARAMS.telemetryLatencyAllowance.value + PARAMS.commandUplinkAllowance.value);
    assert.equal(r.registry.get(a.id)!.deadlineMs, r.clock.now() + DEADLINE);
    const e = r.registry.submit({ vehicleId: 'HT-05', action: 'ESTOP' }, PRIYA);
    assert.equal(r.registry.get(e.id)!.deadlineMs, r.clock.now() + PARAMS.immediateEffectDeadline.value, 'e-stop acts on receipt');
  } finally { r.cleanup(); }
});

test('L2.36 deadline behind LOADING and DUMPING: the work left plus the normal deadline', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 50, segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12' });
    r.advance(200);
    r.tel(V, { state: 'LOADING', speed_mps: 0, offset_m: 59.95, segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12' });
    r.advance(5_000);
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.queued?.behind, 'LOADING');
    assert.equal(rec.queued?.estimateMs, PARAMS.loadTime.value - 5_000);
    assert.equal(rec.deadlineMs, r.clock.now() + PARAMS.loadTime.value - 5_000 + DEADLINE);
    assert.match(rec.summary, /queued behind LOADING/);

    r.tel('HT-05', { state: 'DUMPING', speed_mps: 0, payload_kg: 42000, segment_id: 'SEG-TIP-1', zone_id: 'TIP', offset_m: 59.95 });
    r.advance(2_000);
    const b = r.registry.submit({ vehicleId: 'HT-05', action: 'RETURN_TO_BAY' }, PRIYA);
    assert.equal(r.registry.get(b.id)!.deadlineMs, r.clock.now() + PARAMS.dumpTime.value - 2_000 + DEADLINE);
  } finally { r.cleanup(); }
});

test('L2.36 behind CHARGING: no fixed deadline, shown as queued with an estimate from the charge rate', () => {
  const r = regRig();
  try {
    r.tel(V, { state: 'CHARGING', speed_mps: 0, soc_pct: 30, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 79.95 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.deadlineMs, null);
    assert.equal(rec.queued?.estimateMs, ((PARAMS.chargeTo.value - 30) / PARAMS.chargeRate.value) * 1000);
    assert.match(rec.summary, /queued until CHARGING ends \(~600 s left\): no fixed deadline/);
    r.advance(10 * 60_000, 1_000);
    assert.equal(r.registry.get(a.id)!.status, 'acknowledged', 'still waiting, not retried');
    assert.equal(r.sent.length, 1);
  } finally { r.cleanup(); }
});

test('a queued command is checked the moment the work ends, and retried at once if it has not taken effect (re-probe Q1)', () => {
  const r = regRig();
  try {
    const draw = { segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12' };
    r.tel(V, { state: 'LOADING', speed_mps: 0, offset_m: 59.95, ...draw });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, BLAST);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    r.advance(10_000);
    r.tel(V, { state: 'LOADING', speed_mps: 0, offset_m: 59.95, ...draw });
    assert.equal(r.sent.length, 1);
    r.advance(200);
    r.tel(V, { state: 'TRAMMING', speed_mps: 0, offset_m: 59.95, payload_kg: 42000, ...draw });
    assert.equal(r.sent.length, 2, 'retried on the first telemetry after loading ended');
    assert.notEqual(r.sent[1]!.command_id, r.sent[0]!.command_id, 'under a new command_id');
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.attempts.length, 2);
    assert.match(rec.summary, /attempt 2 of 3/);
    assert.ok(r.store.auditLog(V).some((e) => e.event === 'no_effect' && /LOADING ended/.test(e.what)));
  } finally { r.cleanup(); }
});

// ---- retries (L2.37, L2.38) ----

test('L2.37 accepted, no effect by the deadline: retried under a new command_id with the count shown, then failed and alarmed', () => {
  const r = regRig();
  try {
    r.tel(V, HOLDING);
    const a = r.registry.submit({ vehicleId: V, action: 'RESUME' }, PRIYA);
    const ids: string[] = [];
    for (let i = 0; i < PARAMS.commandMaxAttempts.value; i++) {
      const cid = r.sent[i]!.command_id;
      ids.push(cid);
      r.ack(cid, 'ACCEPTED');
      r.advance(DEADLINE - 200);
      r.tel(V, HOLDING);
      assert.equal(r.sent.length, i + 1, `no retry before the deadline (attempt ${i + 1})`);
      r.advance(300);
    }
    assert.equal(new Set(ids).size, ids.length, 'every attempt has its own command_id');
    assert.equal(r.sent.length, PARAMS.commandMaxAttempts.value, 'no more than the set number of attempts');
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.status, 'failed');
    assert.equal(rec.failure!.code, 'NO_EFFECT');
    assert.match(rec.failure!.message, /after 3 attempts: accepted but not carried out/);
    assert.ok(r.events.some((e) => e.type === 'alarm' && e.kind === 'command_failed' && e.recordId === a.id));
    assert.ok(r.events.some((e) => e.type === 'command' && e.record.id === a.id && /attempt 2 of 3/.test(e.record.summary)), 'attempt count shown');
  } finally { r.cleanup(); }
});

test('L2.38 a retry never displaces a different command we queued: the newer command supersedes the older', () => {
  const r = regRig();
  try {
    const draw = { segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12', state: 'LOADING', speed_mps: 0, offset_m: 59.95 };
    r.tel(V, draw);
    const hold = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    const exit = r.registry.submit({ vehicleId: V, action: 'EXIT_ZONE' }, BLAST);
    r.ack(r.sent[1]!.command_id, 'ACCEPTED');
    assert.equal(r.registry.get(hold.id)!.status, 'superseded');
    assert.equal(r.registry.get(hold.id)!.supersededBy, exit.id);
    // Loading ends with neither in effect: only the EXIT_ZONE is sent again.
    for (let t = 0; t < PARAMS.loadTime.value; t += 1_000) { r.advance(1_000); r.tel(V, draw); }
    r.tel(V, { ...draw, state: 'TRAMMING' });
    r.advance(3 * DEADLINE);
    assert.deepEqual(r.sent.map((m) => m.action), ['HOLD', 'EXIT_ZONE', 'EXIT_ZONE']);
    assert.equal(r.registry.get(hold.id)!.status, 'superseded');
  } finally { r.cleanup(); }
});

test('re-probe Q3: a RESUME within a HOLD\'s delay is refused, says the HOLD cannot be called back, and the HOLD is still tracked to its effect', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    const hold = r.registry.submit({ vehicleId: V, action: 'HOLD' }, BLAST);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    r.advance(1_000);
    const resume = r.registry.submit({ vehicleId: V, action: 'RESUME' }, PRIYA);
    assert.equal(r.registry.get(hold.id)!.status, 'acknowledged', 'a RESUME does not pretend to cancel it');
    r.tel(V, { offset_m: 13 }); // still moving: this must not count as the RESUME taking effect
    assert.equal(r.registry.get(resume.id)!.status, 'sent');
    r.ack(r.sent[1]!.command_id, 'REJECTED', { reason: 'INVALID_STATE' });
    const rr = r.registry.get(resume.id)!;
    assert.equal(rr.status, 'failed');
    assert.match(rr.failure!.message, /HOLD sent 1\.0 s ago is still on its way to HT-04 and cannot be called back/);
    r.advance(3_000);
    r.tel(V, HOLDING);
    assert.equal(r.registry.get(hold.id)!.status, 'confirmed');
  } finally { r.cleanup(); }
});

test('a RESUME accepted while our HOLD is queued cancels it, at the truck and here', () => {
  const r = regRig();
  try {
    const draw = { segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12', state: 'LOADING', speed_mps: 0, offset_m: 59.95 };
    r.tel(V, draw);
    const hold = r.registry.submit({ vehicleId: V, action: 'HOLD' }, BLAST);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    const resume = r.registry.submit({ vehicleId: V, action: 'RESUME' }, PRIYA);
    r.ack(r.sent[1]!.command_id, 'ACCEPTED');
    assert.equal(r.registry.get(hold.id)!.status, 'superseded');
    assert.equal(r.registry.get(resume.id)!.status, 'confirmed', 'the ack is the only evidence of a cancelled queue; the truck is in its duty cycle');
  } finally { r.cleanup(); }
});

test('an EXIT_ZONE under way that is not confirmed outside is failed, never sent again blind', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 100 });
    const a = r.registry.submit({ vehicleId: V, action: 'EXIT_ZONE' }, BLAST);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    r.advance(2_000);
    r.tel(V, { offset_m: 97, direction: 'REV', task: 'EXIT_ZONE' });
    const rec = r.registry.get(a.id)!;
    assert.match(rec.summary, /under way: leaving DECLINE/);
    r.advance(10 * 60_000, 1_000); // goes silent
    assert.equal(r.registry.get(a.id)!.status, 'failed');
    assert.equal(r.registry.get(a.id)!.failure!.code, 'EXIT_NOT_CONFIRMED');
    assert.equal(r.sent.length, 1);
  } finally { r.cleanup(); }
});

test('EXIT_ZONE is confirmed only once holding outside the zone it was sent in', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 5 });
    const a = r.registry.submit({ vehicleId: V, action: 'EXIT_ZONE' }, BLAST);
    assert.equal(r.registry.get(a.id)!.targetZone, 'DECLINE');
    r.advance(2_000);
    r.tel(V, { offset_m: 2, direction: 'REV', task: 'EXIT_ZONE' });
    r.advance(1_000);
    r.tel(V, { ...HOLDING, offset_m: 5 }); // holding but still inside: not done
    assert.notEqual(r.registry.get(a.id)!.status, 'confirmed');
    r.tel(V, { ...HOLDING, segment_id: 'SEG-BAY', zone_id: 'BAY', offset_m: 78 });
    assert.equal(r.registry.get(a.id)!.status, 'confirmed');
    assert.match(r.registry.get(a.id)!.effect!.detail, /outside DECLINE, in BAY/);
  } finally { r.cleanup(); }
});

// ---- the safety gate ----

test('the safety gate sits below every caller: a refusal is recorded with its reason and nothing is sent', () => {
  const asked: string[] = [];
  const gate: SafetyGate = {
    check: ({ record }) => {
      asked.push(`${record.actor.kind}:${record.action}`);
      return record.action === 'RETURN_TO_BAY' ? { allow: false, code: 'PATH_THROUGH_CLOSING_ZONE', reason: 'its way to the bay passes through DECLINE, which closes in 40 s' } : { allow: true };
    },
  };
  const r = regRig({ gate });
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'RETURN_TO_BAY' }, PRIYA);
    const b = r.registry.submit({ vehicleId: 'HT-05', action: 'RETURN_TO_BAY' }, BLAST);
    for (const x of [a, b]) {
      assert.equal(x.status, 'refused');
      assert.match(x.failure!.message, /passes through DECLINE/);
    }
    assert.equal(r.sent.length, 0);
    assert.deepEqual(asked, ['operator:RETURN_TO_BAY', 'system:RETURN_TO_BAY'], 'one code path for both callers');
    const refusals = r.store.auditLog().filter((e) => e.event === 'refused');
    assert.deepEqual(refusals.map((e) => e.actor), ['priya', 'system']);
  } finally { r.cleanup(); }
});

test('the gate is asked again before a retry, and can stop it', () => {
  let allowRetries = true;
  const gate: SafetyGate = { check: ({ attempt }) => (attempt > 1 && !allowRetries ? { allow: false, code: 'ZONE_CLOSING', reason: 'the zone is now closing' } : { allow: true }) };
  const r = regRig({ gate });
  try {
    r.tel(V, HOLDING);
    const a = r.registry.submit({ vehicleId: V, action: 'RESUME' }, PRIYA);
    allowRetries = false;
    r.advance(DEADLINE + 100);
    assert.equal(r.registry.get(a.id)!.status, 'refused');
    assert.equal(r.sent.length, 1);
  } finally { r.cleanup(); }
});

test('the placeholder gate allows everything, and says what it is in its name', () => {
  assert.deepEqual(ALLOW_ALL_GATE_NO_BLAST_SAFETY.check({} as never), { allow: true });
});

// ---- persistence and restart (L6.6, L6.1 replay half) ----

test('L6.6 every command is written down before it is sent', () => {
  let rowAtSend: unknown = null;
  const r = regRig({ onSend: (m, rig) => { rowAtSend = rig.store.sendsOf(rig.registry.list()[0]!.id).find((s) => s.commandId === m.command_id); } });
  try {
    r.tel(V, { offset_m: 10 });
    r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    assert.ok(rowAtSend, 'the send row existed when the line went to the link');
    assert.equal((rowAtSend as { line: string }).line, JSON.stringify(r.sent[0]));
  } finally { r.cleanup(); }
});

test('L6.6 and L6.1: killed between writing and sending, the command is replayed under the same command_id after restart', () => {
  let kill = true;
  const r = regRig({ onSend: () => { if (kill) throw new Error('killed'); } });
  const cleanups = [r.cleanup];
  try {
    r.tel(V, { offset_m: 10 });
    assert.throws(() => r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA), /killed/);
    kill = false;
    const r2 = r.restart();
    cleanups.push(r2.cleanup);
    r2.clock.advance(2_000);
    const open = r2.registry.list({ open: true });
    assert.equal(open.length, 1);
    const cid = open[0]!.attempts[0]!.commandId;
    r2.registry.linkUp(helloAt(r2.clock.now()));
    assert.equal(r2.sent.length, 1);
    assert.equal(r2.sent[0]!.command_id, cid, 'same command_id: the gateway de-duplicates it');
    r2.ack(cid, 'ACCEPTED');
    r2.tel(V, HOLDING);
    assert.equal(r2.registry.get(open[0]!.id)!.status, 'confirmed');
    assert.ok(r2.store.auditLog().some((e) => e.event === 'restored'));
    assert.ok(r2.store.auditLog().some((e) => e.event === 'replayed'));
  } finally { for (const c of cleanups.reverse()) c(); }
});

test('L6.6 a command older than its deadline at restart is marked expired, not sent', () => {
  const r = regRig();
  const cleanups = [r.cleanup];
  try {
    r.tel(V, { offset_m: 10 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.clock.advance(DEADLINE + 1);
    const r2 = r.restart();
    cleanups.push(r2.cleanup);
    r2.registry.linkUp(helloAt(r2.clock.now()));
    assert.equal(r2.sent.length, 0);
    assert.equal(r2.registry.get(a.id)!.status, 'expired');
    assert.match(r2.registry.get(a.id)!.failure!.message, /restarted/);
  } finally { for (const c of cleanups.reverse()) c(); }
});

// ---- the link drops (L2.42 command half) ----

test('link drop: in-flight commands within their deadline are replayed under the same id; older ones expire', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    r.tel('HT-05', { offset_m: 100 });
    const a = r.registry.submit({ vehicleId: V, action: 'HOLD' }, PRIYA);
    r.setUp(false);
    r.advance(2_000);
    r.setUp(true);
    r.registry.linkUp(helloAt(r.clock.now()));
    assert.equal(r.sent.length, 2);
    assert.equal(r.sent[1]!.command_id, r.sent[0]!.command_id);
    assert.equal(r.registry.get(a.id)!.attempts[0]!.sends.length, 2);
    assert.equal(r.registry.get(a.id)!.attempts[0]!.sends[1]!.replay, true);

    const b = r.registry.submit({ vehicleId: 'HT-05', action: 'HOLD' }, PRIYA);
    r.setUp(false);
    r.advance(30_000, 1_000);
    assert.equal(r.registry.get(b.id)!.status, 'sent', 'no retries while nothing can be sent or seen');
    r.setUp(true);
    r.registry.linkUp(helloAt(r.clock.now()));
    assert.equal(r.registry.get(b.id)!.status, 'expired');
    assert.equal(r.sent.filter((m) => m.vehicle_id === 'HT-05').length, 1);
  } finally { r.cleanup(); }
});

// ---- e-stop while the link is down (L7.8) ----

test('L7.8 e-stop while the link is down: pending and visible with a cancel, sent if the link returns within 10 s', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    r.setUp(false);
    const a = r.registry.submit({ vehicleId: V, action: 'ESTOP' }, PRIYA);
    assert.equal(a.status, 'pending');
    assert.match(a.summary, /NOT sent yet: waiting for the site link/);
    assert.ok(r.events.some((e) => e.type === 'alarm' && e.kind === 'estop_undelivered'));
    assert.equal(r.sent.length, 0);
    r.advance(9_000);
    r.setUp(true);
    r.registry.linkUp(helloAt(r.clock.now()));
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]!.action, 'ESTOP');
    assert.equal(r.registry.get(a.id)!.status, 'sent', 'never shown as done until telemetry says so');
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    assert.notEqual(r.registry.get(a.id)!.status, 'confirmed');
    r.tel(V, { state: 'ESTOPPED', speed_mps: 0 });
    assert.equal(r.registry.get(a.id)!.status, 'confirmed');
  } finally { r.cleanup(); }
});

test('L7.8 after 10 s the e-stop is not sent; the operator confirms again (or cancels)', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    r.setUp(false);
    const a = r.registry.submit({ vehicleId: V, action: 'ESTOP' }, PRIYA);
    r.advance(10_500);
    const rec = r.registry.get(a.id)!;
    assert.equal(rec.status, 'pending');
    assert.equal(rec.hold?.needsReconfirm, true);
    assert.match(rec.summary, /NOT sent: the site link was down too long/);
    r.setUp(true);
    r.registry.linkUp(helloAt(r.clock.now()));
    assert.equal(r.sent.length, 0, 'a stale e-stop is not sent by itself');
    r.registry.reconfirm(a.id, DAVE);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]!.operator_id, 'priya', 'still the e-stop priya asked for');
    assert.ok(r.store.auditLog(V).some((e) => e.event === 'reconfirmed' && e.actor === 'dave'));

    r.setUp(false);
    const b = r.registry.submit({ vehicleId: 'HT-05', action: 'ESTOP' }, PRIYA);
    r.registry.cancel(b.id, PRIYA);
    assert.equal(r.registry.get(b.id)!.status, 'cancelled');
    r.setUp(true);
    r.registry.linkUp(helloAt(r.clock.now()));
    assert.equal(r.sent.filter((m) => m.vehicle_id === 'HT-05').length, 0);
  } finally { r.cleanup(); }
});

// ---- leases and identity (L8.1-L8.3) ----

test('L8.2 only a supervisor can force a takeover', () => {
  const r = regRig();
  try {
    const a = r.registry.submit({ vehicleId: V, action: 'TAKE_CONTROL', force: true }, PRIYA);
    assert.equal(a.status, 'refused');
    assert.match(a.failure!.message, /Only a supervisor/);
    assert.equal(r.sent.length, 0);
    const b = r.registry.submit({ vehicleId: V, action: 'TAKE_CONTROL', force: true }, MARTA);
    assert.equal(b.status, 'sent');
    assert.equal(r.sent[0]!.force, true);
  } finally { r.cleanup(); }
});

test('L8.3 an operator_id in the request is ignored; the caller\'s identity is used', () => {
  const r = regRig();
  try {
    r.tel(V, { offset_m: 10 });
    r.registry.submit({ vehicleId: V, action: 'HOLD', operator_id: 'mallory' } as never, PRIYA);
    assert.equal(r.sent[0]!.operator_id, 'priya');
    r.registry.submit({ vehicleId: 'HT-05', action: 'HOLD', operator_id: 'mallory' } as never, BLAST);
    assert.equal(r.sent[1]!.operator_id, 'system');
    assert.ok(!JSON.stringify(r.store.auditLog()).includes('mallory'));
  } finally { r.cleanup(); }
});

test('leases: TAKE_CONTROL gives the lease id from the ack; RELEASE_CONTROL uses it; a forced takeover tells the driver who took it', () => {
  const r = regRig();
  try {
    r.tel(V, HOLDING);
    r.registry.submit({ vehicleId: V, action: 'TAKE_CONTROL' }, PRIYA);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED', { lease_id: 'L-1', lease_idle_timeout_ms: 10_000, deadman_ms: 500 });
    assert.equal(r.registry.lease(V)?.leaseId, 'L-1');
    r.tel(V, { state: 'MANUAL', speed_mps: 0, control: { mode: 'MANUAL', operator_id: 'priya', deadman: true, last_drive_seq: null, last_drive_sent_ms: null } });
    assert.equal(r.registry.list({ vehicleId: V })[0]!.status, 'confirmed');
    r.feed({ type: 'lease_event', vehicle_id: V, event: 'REVOKED', lease_id: 'L-1', operator_id: 'priya', reason: 'FORCED_TAKEOVER', by_operator: 'marta', server_time_ms: r.fleet.serverNow() });
    const n = r.events.filter((e) => e.type === 'notify').at(-1);
    assert.ok(n && n.type === 'notify');
    assert.deepEqual(n.to, ['priya']);
    assert.match(n.message, /marta took control of HT-04 from priya/);
    r.feed({ type: 'lease_event', vehicle_id: V, event: 'GRANTED', lease_id: 'L-2', operator_id: 'marta', forced: true, server_time_ms: r.fleet.serverNow() });
    r.registry.submit({ vehicleId: V, action: 'RELEASE_CONTROL' }, MARTA);
    assert.equal(r.sent.at(-1)!.lease_id, 'L-2');
  } finally { r.cleanup(); }
});

// ---- the log (L8.4, L8.5) ----

test('L8.4 "who moved HT-06 at 3:12?" is one query: who, the rule and inputs, every send and ack, the effect', () => {
  const r = regRig();
  try {
    r.tel('HT-06', { offset_m: 10 });
    const t0 = r.fleet.serverNow();
    r.registry.submit({ vehicleId: 'HT-06', action: 'HOLD' }, BLAST);
    r.ack(r.sent[0]!.command_id, 'ACCEPTED');
    r.advance(3_000);
    r.tel('HT-06', HOLDING);
    r.advance(60_000, 1_000);
    r.registry.submit({ vehicleId: 'HT-06', action: 'RESUME', why: 'blast called off' }, PRIYA);
    r.advance(2_000);
    r.tel('HT-06', { offset_m: 11 });

    const rows = r.store.history('HT-06', t0 + 1_000, t0 + 2_000);
    assert.equal(rows.length, 1, 'only what was in play at that moment');
    const h = rows[0]!;
    assert.equal(h.action, 'HOLD');
    assert.equal(h.actorKind, 'system');
    assert.equal(h.rule, 'blast-evacuation');
    assert.deepEqual(h.inputs, BLAST.kind === 'system' ? BLAST.inputs : null);
    assert.equal(h.sends.length, 1);
    assert.equal(h.acks[0]!.status, 'ACCEPTED');
    assert.equal(h.status, 'confirmed');
    assert.match(String((h.effect as { detail: string }).detail), /holding/);

    const later = r.store.history('HT-06', t0 + 62_000, t0 + 70_000);
    assert.equal(later.at(-1)!.actor, 'priya');
    assert.equal(later.at(-1)!.why, 'blast called off');
  } finally { r.cleanup(); }
});

test('L8.5 the audit log is append-only, survives a restart, and holds system and operator actions together with what, when and why', () => {
  const r = regRig();
  const cleanups = [r.cleanup];
  try {
    r.tel(V, { offset_m: 10 });
    r.registry.submit({ vehicleId: V, action: 'HOLD', why: 'checking a noise' }, PRIYA);
    r.registry.submit({ vehicleId: 'HT-05', action: 'HOLD' }, BLAST);
    assert.throws(() => r.store.rawExec('UPDATE audit SET actor = \'nobody\''), /append-only/);
    assert.throws(() => r.store.rawExec('DELETE FROM audit'), /append-only/);
    assert.throws(() => r.store.rawExec('DELETE FROM sends'), /append-only/);
    const before = r.store.auditLog();
    const r2 = r.restart();
    cleanups.push(r2.cleanup);
    const after = r2.store.auditLog();
    assert.deepEqual(after.slice(0, before.length), before);
    const actors = new Set(after.map((e) => `${e.actorKind}:${e.actor}`));
    assert.ok(actors.has('operator:priya') && actors.has('system:system'));
    const op = after.find((e) => e.actor === 'priya' && e.event === 'sent')!;
    assert.equal(op.why, 'checking a noise');
    assert.ok(op.serverMs > 0 && op.what.includes('HOLD HT-04'));
    const sys = after.find((e) => e.actorKind === 'system' && e.event === 'sent')!;
    assert.equal(sys.rule, 'blast-evacuation');
    assert.deepEqual(sys.inputs, { zone: 'Z', effectiveAtMs: 0 });
  } finally { for (const c of cleanups.reverse()) c(); }
});
