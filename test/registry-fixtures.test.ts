// The registry against what the live gateway actually did (research/fixtures/, re-probe of
// 2026-10-03): TESTING.md L3.6 and L2.37 (accepted-then-ignored-resume), L2.36 and the re-probe's Q1
// (queued-hold-dropped) and Q3 (resume-during-pending-hold), L2.35 (a LEASE_HELD with its holder).
//
// The fixture is replayed in arrival order on a manual clock. Where the probe sent a command, the
// registry is asked to send the same one, and its command_id is the probe's, so the fixture's acks
// answer it. The registry decides its own retries. When a retry stands for a later probe send (the
// probe's own retry), the replay skips ahead to that send, shifting the rest of the fixture in time;
// the test checks that what it skipped changes nothing (the same state throughout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../src/clock.ts';
import { FleetState } from '../src/fleet.ts';
import { PARAMS } from '../src/params.ts';
import type { CommandMessage } from '../src/protocol.ts';
import { ALLOW_ALL_GATE_NO_BLAST_SAFETY, CommandRegistry, supervisoryDeadlineMs, type Actor, type RegistryEvent, type SubmitRequest } from '../src/registry.ts';
import { Store } from '../src/store.ts';
import { fixture, helloAt, type FixtureRecord } from './helpers/fixtures.ts';

const PROBE: Actor = { kind: 'operator', operatorId: 'probe', role: 'operator' };

interface Plan { req: SubmitRequest; actor?: Actor; retries?: string[] }

interface Run {
  registry: CommandRegistry;
  store: Store;
  sent: Array<{ msg: CommandMessage; atMs: number; fixtureMs: number }>;
  events: RegistryEvent[];
  skipped: FixtureRecord[];
  statusAt: Array<{ fixtureMs: number; recordId: string; status: string; summary: string }>;
  shiftMs: number;
  idOf(probeId: string): string; // our record id for the probe's first send
}

function replayWithRegistry(name: string, plans: Record<string, Plan>, opts: { untilFixtureMs?: number } = {}): Run {
  const body = fixture(name).filter((r) => r.kind !== 'fixture' && typeof r.rx_ms === 'number').sort((a, b) => a.rx_ms! - b.rx_ms!);
  const start = body[0]!.rx_ms!;
  const clock = new ManualClock(start);
  const fleet = new FleetState(clock);
  fleet.ingest(helloAt(start));
  const dir = mkdtempSync(join(tmpdir(), 'cr-fixture-'));
  const store = new Store(join(dir, 'db'));
  const ids = new Map<string, string[]>(); // our record id -> command_ids per attempt
  const records = new Map<string, string>(); // probe id -> our record id
  let jumpTo: string | null = null;
  const run: Run = {
    registry: undefined as unknown as CommandRegistry, store, sent: [], events: [], skipped: [], statusAt: [], shiftMs: 0,
    idOf: (p) => records.get(p)!,
  };
  let n = 0;
  const registry = new CommandRegistry({
    clock, fleet, store, gate: ALLOW_ALL_GATE_NO_BLAST_SAFETY,
    newId: () => `r${++n}`,
    commandIdFor: (rid, attempt) => ids.get(rid)?.[attempt - 1] ?? `${rid}-a${attempt}`,
    transport: {
      isUp: () => true,
      send: (m) => {
        run.sent.push({ msg: m, atMs: clock.now(), fixtureMs: clock.now() + run.shiftMs - start });
        if (m.command_id !== undefined && [...ids.values()].some((l) => l.indexOf(m.command_id) > 0)) jumpTo = m.command_id;
        return true;
      },
    },
  });
  run.registry = registry;
  registry.subscribe((e) => {
    run.events.push(e);
    if (e.type === 'command') run.statusAt.push({ fixtureMs: clock.now() + run.shiftMs - start, recordId: e.record.id, status: e.record.status, summary: e.record.summary });
  });

  const step = (to: number) => {
    while (clock.now() < to && jumpTo === null) {
      clock.advance(Math.min(100, to - clock.now()));
      fleet.tick();
      registry.tick();
    }
  };

  for (let i = 0; i < body.length; i++) {
    const r = body[i]!;
    if (opts.untilFixtureMs !== undefined && r.rx_ms! - start > opts.untilFixtureMs) break;
    step(r.rx_ms! - run.shiftMs);
    if (jumpTo !== null) {
      // Our retry stands for the probe's later send: skip to it.
      const target = body.findIndex((x, k) => k >= i && x.kind === 'sent' && JSON.parse(String(x.raw)).command_id === jumpTo);
      assert.ok(target >= 0, `no later probe send ${jumpTo}`);
      run.skipped.push(...body.slice(i, target));
      run.shiftMs = body[target]!.rx_ms! - clock.now();
      jumpTo = null;
      i = target; // the probe's own send is ours already
      continue;
    }
    if (r.kind === 'msg') {
      fleet.ingestLine(JSON.stringify(r.m));
      registry.message(r.m as Record<string, unknown>);
    } else if (r.kind === 'unparseable') {
      fleet.ingestLine(String(r.raw));
    } else if (r.kind === 'sent') {
      const m = JSON.parse(String(r.raw)) as { type: string; command_id: string };
      const plan = plans[m.command_id];
      if (m.type === 'command' && plan) {
        const rid = `r${n + 1}`;
        ids.set(rid, [m.command_id, ...(plan.retries ?? [])]);
        records.set(m.command_id, rid);
        registry.submit(plan.req, plan.actor ?? PROBE);
      }
    }
  }
  t_cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return run;
}

const t_cleanup: Array<() => void> = [];
const cleanup = () => { while (t_cleanup.length) t_cleanup.pop()!(); };

test('L3.6 and L2.37 accepted-then-ignored-resume: RESUME shown accepted-not-executed, retried under a new id, then confirmed', () => {
  try {
    const run = replayWithRegistry('accepted-then-ignored-resume', {
      'probe-119b43-7': { req: { vehicleId: 'HT-02', action: 'TAKE_CONTROL' } },
      'probe-119b43-8': { req: { vehicleId: 'HT-02', action: 'HOLD' } },
      'probe-119b43-9': { req: { vehicleId: 'HT-02', action: 'RESUME' }, retries: ['probe-119b43-23'] },
    });
    const take = run.registry.get(run.idOf('probe-119b43-7'))!;
    assert.equal(take.status, 'confirmed', take.summary);
    assert.equal(take.attempts[0]!.ack?.leaseId, 'L-00001-f5e2');
    assert.equal(take.effect!.ackReceived, true, 'MANUAL telemetry came 0.18 s before the ack; the ack still counts');

    // L2.35 from live data: the HOLD was refused LEASE_HELD with holder "probe".
    const hold = run.registry.get(run.idOf('probe-119b43-8'))!;
    assert.equal(hold.status, 'failed');
    assert.match(hold.failure!.message, /driven by probe/);

    const id = run.idOf('probe-119b43-9');
    const resume = run.registry.get(id)!;
    const seen = run.statusAt.filter((s) => s.recordId === id).map((s) => s.summary);
    assert.ok(seen.includes('accepted, not carried out yet'), seen.join(' | '));
    // Retried at the deadline after the first send, as attempt 2, under the probe's later id.
    const sends = run.sent.filter((s) => s.msg.action === 'RESUME');
    assert.deepEqual(sends.map((s) => s.msg.command_id), ['probe-119b43-9', 'probe-119b43-23']);
    assert.ok(Math.abs(sends[1]!.atMs - sends[0]!.atMs - supervisoryDeadlineMs()) <= 100, `${sends[1]!.atMs - sends[0]!.atMs}`);
    assert.ok(seen.includes('sent, no answer from the site yet (attempt 2 of 3)'), 'attempt count shown; the new attempt is not shown as accepted');
    assert.equal(resume.status, 'confirmed', resume.summary);
    assert.equal(resume.attempts.length, 2);
    assert.equal(resume.attempts[1]!.ack, null, 'the fixture has no ack for the second RESUME');
    assert.ok(resume.effect!.atMs - sends[1]!.atMs <= 1_500, 'moving within 1.3 s of the retry, as live');
    // What the replay skipped: HT-02 holding throughout, nothing else about it.
    const skippedStates = new Set(run.skipped.filter((r) => r.kind === 'msg' && r.m?.type === 'telemetry' && r.m.vehicle_id === 'HT-02').map((r) => String(r.m!.state).toUpperCase()));
    assert.deepEqual([...skippedStates], ['HOLDING']);
    assert.ok(!run.skipped.some((r) => r.kind === 'msg' && r.m?.type === 'command_ack'), 'no ack skipped');
  } finally { cleanup(); }
});

test('re-probe Q1 queued-hold-dropped: a HOLD queued behind LOADING, checked the moment loading ends, retried at once', () => {
  try {
    const run = replayWithRegistry('queued-hold-dropped', { 'probe-46d5e7-1': { req: { vehicleId: 'HT-06', action: 'HOLD' } } });
    const id = run.idOf('probe-46d5e7-1');
    const rec = run.registry.get(id)!;
    const seen = run.statusAt.filter((s) => s.recordId === id);
    const queued = seen.find((s) => /queued/.test(s.summary));
    assert.ok(queued, seen.map((s) => s.summary).join(' | '));
    // From the raw fixture: the first HT-06 message after loading that is not LOADING.
    const body = fixture('queued-hold-dropped').filter((r) => typeof r.rx_ms === 'number').sort((a, b) => a.rx_ms! - b.rx_ms!);
    const start = body[0]!.rx_ms!;
    const ht06 = body.filter((r) => r.kind === 'msg' && r.m?.type === 'telemetry' && r.m.vehicle_id === 'HT-06');
    const lastLoading = ht06.findLastIndex((r) => r.m!.state === 'LOADING');
    const ended = ht06[lastLoading + 1]!;
    assert.equal(ended.m!.state, 'TRAMMING');
    const holds = run.sent.filter((s) => s.msg.action === 'HOLD');
    assert.ok(holds.length >= 2, 'retried');
    assert.equal(holds[1]!.fixtureMs, ended.rx_ms! - start, 'on the very message that showed loading had ended');
    assert.notEqual(holds[1]!.msg.command_id, holds[0]!.msg.command_id);
    // The truck drives on; nobody answers our retries in a recording, so it ends failed and alarmed.
    assert.equal(rec.status, 'failed');
    assert.ok(run.events.some((e) => e.type === 'alarm' && e.recordId === id));
    assert.equal(holds.length, PARAMS.commandMaxAttempts.value);
  } finally { cleanup(); }
});

test('re-probe Q3 resume-during-pending-hold: the RESUME is refused as "cannot be called back", and the HOLD is confirmed when it lands', () => {
  try {
    const run = replayWithRegistry('resume-during-pending-hold', {
      'probe-46d5e7-2': { req: { vehicleId: 'HT-08', action: 'HOLD' } },
      'probe-46d5e7-3': { req: { vehicleId: 'HT-08', action: 'RESUME' } },
    }, { untilFixtureMs: 20_000 });
    const hold = run.registry.get(run.idOf('probe-46d5e7-2'))!;
    const resume = run.registry.get(run.idOf('probe-46d5e7-3'))!;
    assert.equal(resume.status, 'failed');
    assert.match(resume.failure!.message, /still on its way to HT-08 and cannot be called back/);
    // Never shown as done on the TRAMMING messages that arrived before the refusal.
    assert.ok(!run.statusAt.some((s) => s.recordId === resume.id && s.status === 'confirmed'));
    assert.equal(hold.status, 'confirmed', hold.summary);
    // The live HOLD landed ~5.6 s after it was sent; confirmed on the first HOLDING message.
    const body = fixture('resume-during-pending-hold').filter((r) => typeof r.rx_ms === 'number').sort((a, b) => a.rx_ms! - b.rx_ms!);
    const firstHolding = body.find((r) => r.kind === 'msg' && r.m?.type === 'telemetry' && r.m.vehicle_id === 'HT-08' && String(r.m.state).toUpperCase() === 'HOLDING')!;
    assert.equal(hold.effect!.atMs, firstHolding.rx_ms!);
  } finally { cleanup(); }
});
