// TESTING.md L2.26: the confidence thresholds, run over the full live captures. Frozen flags only
// the frozen trucks, silent flags only the silent trucks, nothing else.
//
// The captures (9-25 MB each) are not in the repo. Set DLH_CAPTURES to their paths, colon-separated:
//   DLH_CAPTURES=run1.jsonl:run2.jsonl:run3.jsonl node --test test/captures.test.ts
// Without it the capture test is skipped; the checker itself still runs on two fixtures.
//
// The oracle is computed straight from the raw records, sharing no code with the product:
//   genuinely silent: a gap of more than ORACLE_GAP_MS between a truck's messages while heartbeats
//     show the link up. Outages are cut out of each gap and the link-up pieces judged on their own:
//     a truck that stays quiet after the link returns is silent, even though its gap began in the
//     outage. A piece shorter than ORACLE_GAP_MS right after an outage may be flagged but need not be,
//     since by then the truck has been quiet since before the outage;
//   genuinely frozen: the same segment and offset for at least ORACLE_GAP_MS while reporting
//     TRAMMING or MANUAL at 0.5 m/s or more.
// Thresholds well apart from the product's (5 s silent, 3 s frozen) mean any truck flagged in the
// band between them is a false flag and fails the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../src/params.ts';
import { fixture, readRecords, type FixtureRecord } from './helpers/fixtures.ts';
import { replay } from './helpers/rig.ts';

const ORACLE_GAP_MS = 10_000;
const SAMPLE_MS = 250;

interface Episode { truck: string; start: number; end: number }

interface Result {
  problems: string[];
  silent: Episode[];
  frozen: Episode[];
  flaggedSilent: Set<string>;
  flaggedFrozen: Set<string>;
  summary: string;
}

type Tm = { vehicle_id: string; seq: number; state: unknown; speed_mps: unknown; segment_id: unknown; offset_m: unknown };

function oracle(records: FixtureRecord[]) {
  const recs = [...records].filter((r) => typeof r.rx_ms === 'number').sort((a, b) => a.rx_ms! - b.rx_ms!);
  const t0 = recs[0]!.rx_ms!, tEnd = recs.at(-1)!.rx_ms!;
  // Outages: heartbeat gaps beyond the link-down threshold, extended until trucks could report again.
  const beats = recs.filter((r) => r.kind === 'msg' && r.m?.type === 'heartbeat').map((r) => r.rx_ms!);
  const outages: Array<[number, number]> = [];
  if (beats.length) {
    const settle = PARAMS.truckSilentAfter.value;
    if (beats[0]! - t0 > PARAMS.linkDownAfter.value) outages.push([t0, beats[0]! + settle]);
    for (let i = 1; i < beats.length; i++) if (beats[i]! - beats[i - 1]! > PARAMS.linkDownAfter.value) outages.push([beats[i - 1]!, beats[i]! + settle]);
    if (tEnd - beats.at(-1)! > PARAMS.linkDownAfter.value) outages.push([beats.at(-1)!, Infinity]);
  }
  const inOutage = (a: number, b: number) => outages.some(([s, e]) => a < e && b > s);
  // The parts of (a, b) outside every outage.
  const linkUpPieces = (a: number, b: number): Array<[number, number]> => {
    let pieces: Array<[number, number]> = [[a, b]];
    for (const [s, e] of outages) pieces = pieces.flatMap(([x, y]): Array<[number, number]> =>
      y <= s || x >= e ? [[x, y]] : [...(x < s ? [[x, s] as [number, number]] : []), ...(y > e ? [[e, y] as [number, number]] : [])]);
    return pieces;
  };

  const byTruck = new Map<string, Array<{ rx: number; m: Tm }>>();
  for (const r of recs) {
    if (r.kind !== 'msg' || r.m?.type !== 'telemetry' || typeof r.m.vehicle_id !== 'string') continue;
    const list = byTruck.get(r.m.vehicle_id) ?? [];
    list.push({ rx: r.rx_ms!, m: r.m as unknown as Tm });
    byTruck.set(r.m.vehicle_id, list);
  }
  const silent: Episode[] = [], tolerated: Episode[] = [], frozen: Episode[] = [];
  const judgeGap = (truck: string, a: number, b: number) => {
    for (const [x, y] of linkUpPieces(a, b)) {
      if (y - x > ORACLE_GAP_MS) silent.push({ truck, start: x, end: y });
      else if (x > a) tolerated.push({ truck, start: x, end: y });
    }
  };
  for (const [truck, msgs] of byTruck) {
    for (let i = 1; i < msgs.length; i++) {
      const a = msgs[i - 1]!.rx, b = msgs[i]!.rx;
      if (b - a > PARAMS.truckSilentAfter.value) judgeGap(truck, a, b);
    }
    const last = msgs.at(-1)!.rx;
    if (tEnd - last > PARAMS.truckSilentAfter.value) judgeGap(truck, last, tEnd);
    // Frozen: walk messages that advance seq (a duplicate or a late one says nothing new).
    let maxSeq = -Infinity, run: { start: number; end: number; key: string } | null = null;
    const close = () => { if (run && run.end - run.start >= ORACLE_GAP_MS) frozen.push({ truck, start: run.start, end: run.end }); run = null; };
    for (const { rx, m } of msgs) {
      const seq = Number(m.seq);
      if (!(seq > maxSeq) && !(seq < maxSeq - 50)) continue;
      maxSeq = seq;
      const moving = (String(m.state).toUpperCase() === 'TRAMMING' || String(m.state).toUpperCase() === 'MANUAL') && Number(m.speed_mps) >= 0.5;
      const key = `${String(m.segment_id)}@${Number(m.offset_m)}`;
      if (!moving) { close(); continue; }
      if (run && run.key === key) run.end = rx;
      else { close(); run = { start: rx, end: rx, key }; }
    }
    close();
  }
  return { recs, outages, inOutage, silent, tolerated, frozen, t0 };
}

function checkCapture(records: FixtureRecord[]): Result {
  const o = oracle(records);
  const problems: string[] = [];
  const flaggedSilent = new Set<string>(), flaggedFrozen = new Set<string>();
  const hitSilent = new Set<Episode>(), hitFrozen = new Set<Episode>();
  const s = (ms: number) => `+${((ms - o.t0) / 1000).toFixed(1)} s`;
  let lastHello = -Infinity, nextSample = -Infinity;
  const restarts = new Map<string, number>();
  const drainHigh = new Set<string>();
  const { fleet } = replay(records, {
    hello: !records.some((r) => r.m?.type === 'hello'),
    onRecord: (r, f, c) => {
      const now = c.now();
      if (r.m?.type === 'hello') lastHello = now;
      if (now < nextSample) return;
      nextSample = now + SAMPLE_MS;
      if (o.inOutage(now, now + 1) || now - lastHello < PARAMS.truckSilentAfter.value) return;
      for (const t of f.snapshot().trucks) {
        if (t.battery.drainHigh) drainHigh.add(t.vehicleId);
        if (t.confidence === 'silent') {
          flaggedSilent.add(t.vehicleId);
          const ep = o.silent.find((e) => e.truck === t.vehicleId && now >= e.start && now <= e.end + SAMPLE_MS);
          if (ep) hitSilent.add(ep);
          else if (!o.tolerated.some((e) => e.truck === t.vehicleId && now >= e.start && now <= e.end + SAMPLE_MS)) problems.push(`${t.vehicleId} flagged silent at ${s(now)} (${t.confidenceReason}) with no genuine silence`);
        }
        if (t.confidence === 'contradicted') {
          flaggedFrozen.add(t.vehicleId);
          // A frozen truck stays contradicted until it moves or falls silent.
          const ep = o.frozen.find((e) => e.truck === t.vehicleId && now >= e.start && now <= e.end + PARAMS.truckSilentAfter.value + SAMPLE_MS);
          if (ep) hitFrozen.add(ep);
          else problems.push(`${t.vehicleId} flagged contradicted at ${s(now)} (${t.confidenceReason}) with no genuine freeze`);
        }
      }
    },
  });
  for (const e of o.silent) if (!hitSilent.has(e)) problems.push(`${e.truck} silent ${s(e.start)} to ${s(e.end)} never flagged`);
  for (const e of o.frozen) if (!hitFrozen.has(e)) problems.push(`${e.truck} frozen ${s(e.start)} to ${s(e.end)} never flagged`);
  for (const t of fleet.snapshot().trucks) if (t.run.restarts) restarts.set(t.vehicleId, t.run.restarts);
  const fmt = (es: Episode[]) => es.map((e) => `${e.truck} ${s(e.start)} for ${((e.end - e.start) / 1000).toFixed(0)} s`).join(', ') || 'none';
  const summary = [
    `outages: ${o.outages.map(([a, b]) => `${s(a)}..${Number.isFinite(b) ? s(b) : 'end'}`).join(', ') || 'none'}`,
    `genuinely silent: ${fmt(o.silent)}; flagged silent: ${[...flaggedSilent].join(', ') || 'none'}`,
    `genuinely frozen: ${fmt(o.frozen)}; flagged contradicted: ${[...flaggedFrozen].join(', ') || 'none'}`,
    `controller restarts: ${[...restarts].map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}; drain flagged: ${[...drainHigh].join(', ') || 'none'}`,
    `data quality: ${JSON.stringify(fleet.snapshot().dataQuality.total)}`,
  ].join('\n');
  return { problems, silent: o.silent, frozen: o.frozen, flaggedSilent, flaggedFrozen, summary };
}

test('L2.26 checker, on the silent-truck fixture: HT-03 and only HT-03 flagged silent', (t) => {
  const r = checkCapture(fixture('silent-truck'));
  t.diagnostic(r.summary);
  assert.deepEqual(r.problems, []);
  assert.deepEqual([...r.flaggedSilent], ['HT-03']);
  assert.deepEqual(r.silent.map((e) => e.truck), ['HT-03']);
});

test('L2.26 checker, on the frozen-truck fixture: HT-10 and only HT-10 flagged contradicted', (t) => {
  const r = checkCapture(fixture('frozen-truck'));
  t.diagnostic(r.summary);
  assert.deepEqual(r.problems, []);
  assert.deepEqual([...r.flaggedFrozen], ['HT-10']);
  assert.deepEqual(r.frozen.map((e) => e.truck), ['HT-10']);
});

const captures = (process.env.DLH_CAPTURES ?? '').split(':').filter((p) => p.trim() !== '');

test('L2.26 thresholds over the full captures: frozen and silent flag only the genuine cases', { skip: captures.length === 0 && 'DLH_CAPTURES is not set' }, (t) => {
  for (const path of captures) {
    const r = checkCapture(readRecords(path));
    t.diagnostic(`${path}\n${r.summary}${r.problems.length ? `\nPROBLEMS:\n  ${r.problems.slice(0, 40).join('\n  ')}` : ''}`);
    assert.deepEqual(r.problems.slice(0, 40), [], path);
    assert.ok(r.frozen.length > 0 || r.silent.length > 0, `${path}: no fault found at all; is this a capture?`);
  }
});
