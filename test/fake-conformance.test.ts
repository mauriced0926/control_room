// TESTING.md L0.C1 and L0.C3: the fake gateway, with its faults injected, against the live site.
//
// L0.C1: each fixture's fault, injected into the fake, gives a stream that research/report.py flags
// the same way it flags the fixture. Both streams go through the unmodified report.py (as a
// subprocess, so python3 is needed); the comparison reads report.py's output, never the fake's own
// view of what it did. Each case extracts the same few things from both reports and compares them.
// Fixtures are fed to report.py as a capture: without their description line (report.py reads
// rx_ms from the first record) and, where the fixture has none, after DLH-1's real hello (the site
// is the same; report.py needs the route).
//
// L0.C3: a 15-minute live day, recorded as research/capture.py records (same reconnect backoff),
// measured by test/helpers/radio-stats.ts, must fall within the live ranges. The same code measured
// the live captures; set DLH_CAPTURES to check that it reproduces research/README.md's table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../src/clock.ts';
import type { Behaviour } from '../fake/behaviour.ts';
import { LIVE_DAY, type Faults } from '../fake/faults.ts';
import { FakeGateway } from '../fake/gateway.ts';
import type { Blasts, TruckInit } from '../fake/model.ts';
import { DLH1 } from '../fake/dlh1.ts';
import { fixture, readRecords, siteHello, type FixtureRecord } from './helpers/fixtures.ts';
import { capture } from './helpers/fake-capture.ts';
import { radioStats, type RadioStats } from './helpers/radio-stats.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const HAVE_PYTHON = !spawnSync('python3', ['--version'], { stdio: 'ignore' }).error;
const T0 = 1_790_000_000_000;

// ---- report.py, run and read ----

interface Report {
  text: string;
  status: number | null;
  stderr: string;
  trucks: Map<string, { line: string; flags: string[] }>;
  heartbeatGaps: string;
  wholeLinkSilencesS: number[];
  truncatedPct: number;
  closedByPeer: number;
  hellos: string[];
  closedWindows: Array<{ zone: string; from: number; to: number }>;
  other: string[];
}

function runReport(rows: FixtureRecord[]): Report {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  try {
    const path = join(dir, 'capture.jsonl');
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = spawnSync('python3', [join(ROOT, 'research/report.py'), path], { encoding: 'utf8' });
    return parse(r.stdout, r.status, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parse(text: string, status: number | null, stderr: string): Report {
  const trucks = new Map<string, { line: string; flags: string[] }>();
  let current: { line: string; flags: string[] } | null = null;
  const lines = text.split('\n');
  for (const l of lines) {
    const m = /^(\S+) n=\d+ /.exec(l);
    if (m) { current = { line: l, flags: [] }; trucks.set(m[1]!, current); continue; }
    if (current && l.startsWith('    - ')) current.flags.push(l.slice(6));
    else if (!l.startsWith('    ')) current = null;
  }
  const pctM = /truncated\/unparseable lines: \d+ of \d+ \(([\d.]+)%\)/.exec(text);
  return {
    text, status, stderr, trucks,
    heartbeatGaps: /heartbeat gaps >3s: (.*)/.exec(text)?.[1] ?? '',
    wholeLinkSilencesS: [...text.matchAll(/silence on whole link\s+\S+ for ([\d.]+)s/g)].map((x) => Number(x[1])),
    truncatedPct: pctM ? Number(pctM[1]) : NaN,
    closedByPeer: lines.filter((l) => l.includes('closed_by_peer')).length,
    hellos: lines.filter((l) => l.includes('hello: non-open zones')),
    closedWindows: [...text.matchAll(/while (\S+) CLOSED\s+\+\s*(\d+)s\.\.\s*\+\s*(\d+)s/g)].map((x) => ({ zone: x[1]!, from: Number(x[2]), to: Number(x[3]) })),
    other: lines.filter((l) => l.startsWith('  OTHER')),
  };
}

const flag = (r: Report, truck: string, kind: string) => r.trucks.get(truck)?.flags.find((f) => f.startsWith(kind)) ?? null;
const trucksFlagged = (r: Report, kind: string) => [...r.trucks.entries()].filter(([, t]) => t.flags.some((f) => f.startsWith(kind))).map(([v]) => v).sort();
// The states a truck's EVENTS go through, case-normalised, repeats collapsed: "MANUAL > HOLDING".
const events = (r: Report, truck: string) => {
  const f = flag(r, truck, 'EVENTS');
  if (!f) return [];
  const out: string[] = [];
  for (const e of f.slice('EVENTS '.length).split(';')) {
    const s = e.trim().replace(/^\+\s*\d+s\s+/, '').toUpperCase();
    if (s && out.at(-1) !== s) out.push(s);
  }
  return out;
};
const last = (r: Report, truck: string) => /\| last (\S+) (\S+) (-?\d+)m/.exec(r.trucks.get(truck)?.line ?? '')?.slice(1) ?? [];
const acks = (r: Report) => r.other.filter((l) => l.includes('command_ack')).map((l) => {
  const m = JSON.parse(l.slice(l.indexOf('{'))) as { status: string; reason?: string };
  return m.status === 'ACCEPTED' ? 'ACCEPTED' : String(m.reason);
});

function fixtureReport(name: string): Report {
  const recs = fixture(name).filter((r) => r.kind !== 'fixture');
  const first = recs[0]!.rx_ms!;
  const hasHello = recs.some((r) => r.kind === 'msg' && r.m?.type === 'hello');
  const rows = hasHello ? recs : [{ kind: 'msg', m: siteHello() as unknown as Record<string, unknown>, rx_ms: first }, ...recs];
  return runReport(rows);
}

// ---- a fake day, recorded as a capture ----

interface Scenario {
  faults?: Faults;
  trucks?: TruckInit[];
  blasts?: Blasts;
  behaviour?: Partial<Behaviour>;
  seed?: number;
  script?: (at: (ms: number, fn: () => void) => void, send: (vehicle: string, action: string, id: string, extra?: object) => void) => void;
  ms: number;
}

function fakeRun(s: Scenario): { rows: FixtureRecord[]; gw: FakeGateway } {
  const clock = new ManualClock(T0);
  const gw = new FakeGateway(clock, { seed: s.seed ?? 1, site: DLH1, blasts: s.blasts ?? 'none', trucks: s.trucks ?? [], behaviour: s.behaviour ?? {}, faults: s.faults ?? {} });
  gw.start();
  const cap = capture(gw, clock);
  s.script?.((ms, fn) => clock.setTimeout(fn, ms), (vehicle, action, id, extra = {}) =>
    cap.send({ type: 'command', command_id: id, vehicle_id: vehicle, action, operator_id: 'probe', ...extra }));
  clock.advance(s.ms);
  gw.stop();
  return { rows: cap.rows, gw };
}

const fakeReport = (s: Scenario) => runReport(fakeRun(s).rows);

// ---- L0.C1, one case per fixture ----

const C1 = { skip: HAVE_PYTHON ? false : 'needs python3' };

test('L0.C1 frozen-truck: report.py flags FROZEN POSITION on the frozen truck only, not the loading one', C1, () => {
  const fx = fixtureReport('frozen-truck');
  const fk = fakeReport({ faults: { frozenMoving: { vehicle: 'HT-10', atMs: 20_000 } }, ms: 240_000 });
  assert.deepEqual(trucksFlagged(fx, 'FROZEN POSITION'), ['HT-10']);
  assert.deepEqual(trucksFlagged(fk, 'FROZEN POSITION'), ['HT-10']);
  assert.match(flag(fk, 'HT-10', 'FROZEN POSITION')!, /\(to end\)/);
  assert.match(flag(fx, 'HT-10', 'FROZEN POSITION')!, /\(to end\)/);
});

test('L0.C1 seq-reset: SEQ RESET n->1 on the one truck', C1, () => {
  const fx = fixtureReport('seq-reset');
  const fk = fakeReport({ faults: { seqReset: { vehicle: 'HT-01', atMs: 20_000 } }, ms: 40_000 });
  for (const r of [fx, fk]) {
    assert.deepEqual(trucksFlagged(r, 'SEQ RESET'), ['HT-01']);
    assert.match(flag(r, 'HT-01', 'SEQ RESET')!, /\d+->1$/);
  }
});

test('L0.C1 silent-truck: SILENT for ~53 s on one truck while heartbeats show the link up', C1, () => {
  const fx = fixtureReport('silent-truck');
  const fk = fakeReport({ faults: { silent: { vehicle: 'HT-03', atMs: 5_000, forMs: 53_000 } }, ms: 65_000 });
  for (const r of [fx, fk]) {
    assert.deepEqual(trucksFlagged(r, 'SILENT'), ['HT-03']);
    assert.match(flag(r, 'HT-03', 'SILENT')!, /\s53s$/);
    assert.equal(r.heartbeatGaps, '[]');
  }
});

test('L0.C1 truncated-lines: unparseable lines, every one a telemetry line cut mid-object; ~0.2 % of a day', C1, () => {
  const fx = fixture('truncated-lines').filter((r) => r.kind === 'unparseable');
  const { rows } = fakeRun({ faults: { truncation: true }, ms: 900_000 });
  const fk = runReport(rows);
  const cut = rows.filter((r) => r.kind === 'unparseable');
  for (const raws of [fx.map((r) => r.raw!), cut.map((r) => r.raw!)]) {
    assert.ok(raws.length > 0);
    for (const raw of raws) {
      assert.match(raw, /^\{"type": "telemetry", "vehicle_id": "HT-\d\d", /);
      assert.throws(() => JSON.parse(raw));
      assert.ok(raw.length >= 193 && raw.length <= 209, `${raw.length} chars`);
    }
  }
  // research/README.md: 0.18-0.21 % live
  assert.ok(fk.truncatedPct >= 0.12 && fk.truncatedPct <= 0.27, `${fk.truncatedPct} %`);
});

test('L0.C1 fractional-soc: SOC LOOKS LIKE A FRACTION on the one truck', C1, () => {
  const fx = fixtureReport('fractional-soc');
  const fk = fakeReport({ faults: { fractionalSoc: { vehicle: 'HT-12' } }, ms: 10_000 });
  for (const r of [fx, fk]) assert.deepEqual(trucksFlagged(r, 'SOC LOOKS LIKE A FRACTION'), ['HT-12']);
});

test('L0.C1 accepted-then-ignored-resume: lease expires to HOLDING, RESUME ACCEPTED, still HOLDING; a new RESUME moves it', C1, () => {
  const fx = fixtureReport('accepted-then-ignored-resume');
  const fk = fakeReport({
    trucks: [{ vehicle_id: 'HT-02', positionM: 885, loaded: true, socPct: 60.6 }],
    faults: { ignoredCommands: (c) => c.command_id === 'r1', lostAcks: (c) => c.command_id === 'r2', ackLatency: true },
    script: (at, send) => {
      at(5_000, () => send('HT-02', 'TAKE_CONTROL', 't1'));
      at(7_000, () => send('HT-02', 'HOLD', 'h1'));
      at(18_000, () => send('HT-02', 'RESUME', 'r1'));
      at(88_000, () => send('HT-02', 'RESUME', 'r2'));
    },
    ms: 91_000,
  });
  for (const r of [fx, fk]) {
    assert.deepEqual(events(r, 'HT-02'), ['MANUAL', 'HOLDING'], r.trucks.get('HT-02')?.flags.join(' | '));
    assert.deepEqual(acks(r), ['ACCEPTED', 'LEASE_HELD', 'ACCEPTED'], 'TAKE_CONTROL, HOLD while leased, the first RESUME; the second RESUME\'s ack never came');
    assert.deepEqual(last(r, 'HT-02').slice(0, 1), ['TRAMMING']);
  }
});

test('L0.C1 reverse-exit-zone: EXIT_ZONE reverses an empty truck out of DECLINE and it holds 2 m inside BAY', C1, () => {
  const fx = fixtureReport('reverse-exit-zone');
  const fk = fakeReport({
    trucks: [{ vehicle_id: 'HT-05', positionM: 209.6, loaded: false, socPct: 33.7 }],
    faults: { ackLatency: true },
    script: (at, send) => at(5_000, () => send('HT-05', 'EXIT_ZONE', 'e1')),
    ms: 62_000,
  });
  for (const r of [fx, fk]) {
    assert.deepEqual(events(r, 'HT-05'), ['TRAMMING TASK=EXIT_ZONE', 'HOLDING']);
    assert.deepEqual(last(r, 'HT-05'), ['HOLDING', 'BAY', '78']);
  }
});

test('L0.C1 two-zones-closing: DRAW_12 and TIP closed at the same time', C1, () => {
  const fx = fixtureReport('two-zones-closing');
  const fk = fakeReport({
    blasts: [{ zoneId: 'TIP', atMs: 1_000, closedForMs: 120_000 }, { zoneId: 'DRAW_12', atMs: 31_000, closedForMs: 64_000 }],
    ms: 260_000,
  });
  for (const r of [fx, fk]) {
    const w = r.closedWindows;
    assert.deepEqual(w.map((x) => x.zone).sort(), ['DRAW_12', 'TIP']);
    assert.ok(w[0]!.from < w[1]!.to && w[1]!.from < w[0]!.to, 'overlapping');
  }
});

test('L0.C1 link-drop-in-notice: the link drops just after a CLOSING, logins are closed, the hello on reconnect still has it CLOSING', C1, () => {
  const fx = fixtureReport('link-drop-in-notice');
  const fk = fakeReport({
    blasts: [{ zoneId: 'DRAW_12', atMs: 10_000, closedForMs: 90_000 }],
    faults: { linkDrops: [{ atMs: 11_000, durationMs: 45_000 }] },
    ms: 70_000,
  });
  for (const r of [fx, fk]) {
    assert.ok(r.closedByPeer >= 5, `${r.closedByPeer} closed: the drop, then logins accepted and closed`);
    assert.match(r.hellos.at(-1)!, /\[\('DRAW_12', 'CLOSING'\)\]/);
    const longest = Math.max(...r.wholeLinkSilencesS);
    assert.ok(longest >= 40 && longest <= 60, `whole link silent ${longest} s`);
  }
});

test('L0.C1 weak-pack: one truck draining ~5x the fleet stops with BATTERY_DEPLETED in the incline', C1, () => {
  const fx = fixtureReport('weak-pack');
  // research/report.py used to crash on this fixture (a median over trucks with no drain figure); it
  // now runs to the end. The comparison is still the per-truck output.
  assert.equal(fx.stderr, '');
  const fk = fakeReport({ trucks: [{ vehicle_id: 'HT-06', positionM: 100, loaded: false }], faults: { weakPack: { vehicle: 'HT-06' } }, ms: 560_000 });
  for (const r of [fx, fk]) {
    assert.ok(events(r, 'HT-06').includes('FAULT BATTERY_DEPLETED'), events(r, 'HT-06').join(' > '));
    assert.deepEqual(last(r, 'HT-06').slice(0, 2), ['FAULT', 'INCLINE']);
  }
  const outlier = /outliers: \{'HT-06': ([\d.]+)\}/.exec(fk.text);
  assert.ok(outlier && Number(outlier[1]) >= 4.5 && Number(outlier[1]) <= 5.5, `fake drain ratio ${outlier?.[1]} (live 5.0-5.2)`);
});

test('L0.C1 queued-hold-dropped: HOLD ACCEPTED 0.2 s into loading; the truck drives on and never holds', C1, () => {
  const fx = fixtureReport('queued-hold-dropped');
  const fk = fakeReport({
    trucks: [{ vehicle_id: 'HT-06', positionM: 830, loaded: false, socPct: 63.9 }],
    faults: { queuedDrops: true, ackLatency: true }, behaviour: { queuedDropProbability: 1 },
    script: (at, send) => at(3_550, () => send('HT-06', 'HOLD', 'q1')),
    ms: 46_000,
  });
  for (const r of [fx, fk]) {
    assert.ok(!events(r, 'HT-06').includes('HOLDING'));
    assert.deepEqual(acks(r), ['ACCEPTED']);
    assert.deepEqual(last(r, 'HT-06').slice(0, 2), ['TRAMMING', 'L4_SOUTH']);
  }
});

test('L0.C1 resume-during-pending-hold: RESUME during the HOLD\'s delay is INVALID_STATE and the HOLD lands; a RESUME lost and ignored; a retry works', C1, () => {
  const fx = fixtureReport('resume-during-pending-hold');
  const fk = fakeReport({
    seed: 4,
    trucks: [{ vehicle_id: 'HT-08', positionM: 839.9, loaded: false, socPct: 18.5 }],
    faults: { ackLatency: true, lostAcks: (c) => c.command_id === 'c4', ignoredCommands: (c) => c.command_id === 'c4' },
    script: (at, send) => {
      at(3_600, () => send('HT-08', 'HOLD', 'c2'));
      at(4_600, () => send('HT-08', 'RESUME', 'c3'));
      at(30_200, () => send('HT-08', 'RESUME', 'c4'));
      at(55_300, () => send('HT-08', 'RESUME', 'c5'));
    },
    ms: 65_000,
  });
  for (const r of [fx, fk]) {
    assert.deepEqual(acks(r), ['ACCEPTED', 'INVALID_STATE', 'ACCEPTED']);
    assert.deepEqual(events(r, 'HT-08'), ['HOLDING']);
    assert.deepEqual(last(r, 'HT-08').slice(0, 1), ['TRAMMING']);
  }
});

test('L0.C1 loaded-reverse-into-silence: EXIT_ZONE reverses a loaded truck, it goes silent, the link drops, and it reappears holding', C1, () => {
  const fx = fixtureReport('loaded-reverse-into-silence');
  const fk = fakeReport({
    trucks: [{ vehicle_id: 'HT-04', positionM: 887, loaded: true, socPct: 61.5 }],
    // Live: HT-04 alone went quiet ~15 s with the link up, then the gateway closed the connection and
    // refused logins until the fifth attempt (closed_by_peer at +24 s; hello at +49 s, after retries
    // at 2, 4, 8 and 10 s). A drop, not a stall: the outage ends before that fifth attempt.
    faults: { ackLatency: true, silent: { vehicle: 'HT-04', atMs: 9_000, forMs: 40_500 }, linkDrops: [{ atMs: 24_010, durationMs: 23_000 }] },
    script: (at, send) => {
      at(4_000, () => send('HT-04', 'EXIT_ZONE', 'x1'));
      at(49_500, () => send('HT-04', 'RESUME', 'x2'));
    },
    ms: 58_000,
  });
  for (const r of [fx, fk]) {
    assert.match(flag(r, 'HT-04', 'SILENT') ?? '', /\s(39|40|41)s$/);
    assert.deepEqual(events(r, 'HT-04'), ['TRAMMING TASK=EXIT_ZONE', 'HOLDING']);
    assert.match(r.heartbeatGaps, /, 2[4-7]\.\d\)\]$/);
    assert.ok(r.text.split('\n').filter((l) => /closed_by_peer/.test(l)).length >= 3, 'logins accepted then closed during the drop');
  }
});

// ---- L0.C3: a 15-minute live day against the measured statistics ----

// research/README.md "Radio and blast statistics", runs 1-3. Lost is as test/helpers/radio-stats.ts
// counts it on the same captures (3.38, 3.16, 3.17 %): seqs missing within a controller run, over
// the seqs in it, with the seqs sent during an outage left out of both. The table's 2.68 and 2.51 %
// for runs 2 and 3, the runs with outages, are lower; their method is not in the repository. Tolerances allow for one 15-minute
// sample; any statistic outside its band is a gap to write down, not to tune away.
const LIVE = {
  telemetryHz: [4.44, 4.80, 0.15],
  duplicatePct: [1.97, 2.09, 0.3],
  reorderedPct: [4.89, 5.09, 0.5],
  lostPct: [3.16, 3.38, 0.5],
  truncatedPct: [0.18, 0.21, 0.08],
  maxNormalGapS: [0.99, 1.67, 0.5],
} as const;

function liveDay(seed: number): RadioStats {
  return radioStats(fakeRun({ seed, faults: LIVE_DAY, blasts: 'random', ms: 900_000 }).rows);
}

test('L0.C3 a 15-minute live day falls within the measured radio and blast statistics', () => {
  for (const seed of [1, 2, 3]) {
    const s = liveDay(seed);
    console.log(`L0.C3 seed ${seed}: ${JSON.stringify(s)}`);
    for (const [k, [lo, hi, tol]] of Object.entries(LIVE) as Array<[keyof typeof LIVE, readonly [number, number, number]]>) {
      assert.ok(s[k] >= lo - tol && s[k] <= hi + tol, `seed ${seed}: ${k} ${s[k]} outside ${lo}-${hi} ±${tol}`);
    }
    assert.ok(s.noticesS.length >= 2 && s.noticesS.every((n) => n === 120), `notices ${s.noticesS}`);
    assert.ok(s.closedForS.every((c) => c >= 66 && c <= 111), `closed for ${s.closedForS}`);
    // A second zone CLOSING 30 s after the first (seen once live) is not a blast spacing.
    const spacing = s.betweenClosingsS.filter((g) => g > 60);
    assert.ok(spacing.every((g) => g >= 276 && g <= 318), `between closings ${s.betweenClosingsS}`);
    assert.ok(s.linkDropsS.length >= 1 && s.linkDropsS.length <= 2, `link drops ${s.linkDropsS}`);
    assert.ok(s.linkDropsS.every((d) => d >= 18 && d <= 55), `link drops ${s.linkDropsS} (live 22-49 s)`);
  }
});

// What the brief singles out: the faults that are not easy. Over several default days, each happens.
test('a live day produces the hard cases: a frozen truck reporting motion, a link drop inside a notice, a weak pack dying in the incline', () => {
  for (const seed of [11, 12, 13, 14, 15]) {
    const { gw, rows } = fakeRun({ seed, faults: LIVE_DAY, blasts: 'random', ms: 900_000 });
    const [frozen] = gw.truthLog.entries({ fault: 'frozen_moving' });
    assert.ok(frozen, `seed ${seed}: no frozen truck`);
    const rep = frozen!.detail.reported as { speed_mps: number };
    assert.ok(rep.speed_mps > 0.5, `seed ${seed}: frozen at ${rep.speed_mps} m/s`);

    const [drop] = gw.truthLog.entries({ fault: 'link_drop' });
    const closings = rows.filter((r) => r.kind === 'msg' && r.m!.type === 'zone_event' && r.m!.status === 'CLOSING').map((r) => r.m!);
    assert.ok(drop && closings.some((c) => drop.atMs >= (c.server_time_ms as number) && drop.atMs < (c.effective_at_ms as number)),
      `seed ${seed}: the first link drop is not inside a notice`);

    const [weak] = gw.truthLog.entries({ fault: 'weak_pack' });
    const dead = gw.truthLog.entries({ fault: 'fault', vehicle: weak!.vehicle! }).find((e) => e.detail.code === 'BATTERY_DEPLETED');
    assert.ok(dead, `seed ${seed}: the weak pack (${weak!.vehicle}) did not die in 15 minutes`);
    assert.equal(dead!.detail.zoneId, 'INCLINE', `seed ${seed}`);
  }
});

// The calculator against the live captures: it must reproduce research/README.md's table.
const CAPTURES = process.env.DLH_CAPTURES?.split(':').filter(Boolean) ?? [];
test('L0.C3 the statistics code reproduces the README table on the live captures', { skip: CAPTURES.length === 0 ? 'set DLH_CAPTURES' : false }, () => {
  const expected: Record<string, Partial<RadioStats>> = {
    0: { telemetryHz: 4.8, duplicatePct: 2.09, reorderedPct: 4.96, truncatedPct: 0.19, lostPct: 3.38 },
    1: { telemetryHz: 4.44, duplicatePct: 1.97, reorderedPct: 5.09, truncatedPct: 0.21, lostPct: 3.16 },
    2: { telemetryHz: 4.6, duplicatePct: 1.97, reorderedPct: 4.89, truncatedPct: 0.18, lostPct: 3.17 },
  };
  for (const [i, path] of CAPTURES.entries()) {
    const s = radioStats(readRecords(path));
    console.log(`live capture ${i + 1}: ${JSON.stringify(s)}`);
    for (const [k, v] of Object.entries(expected[i] ?? {})) assert.equal(s[k as keyof RadioStats], v, `capture ${i + 1} ${k}`);
  }
});
