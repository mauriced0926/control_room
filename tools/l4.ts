// TESTING.md L4 over many seeded days (task 5's "L4 run, reported before merge").
//
//   node tools/l4.ts [--seeds 200] [--from 1] [--versions spec,pessimistic] [--sets live,variants,r2c]
//                    [--workers 3] [--minutes 15] [--out report.json]
//
// Sets, per version: "live" is the fake's live day on DLH-1 (LIVE_DAY faults); "variants" is the same
// on L0.S's other site, 7 trucks for odd seeds and 20 for even, with a 60 s notice; "r2c" adds the
// undetectable fault (a truck frozen while stopped) to the live day, counted, not failed. Prints the
// table per version and every failing seed; writes every day's result to --out. Exit code 1 if any
// rule failed.
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { runDay, type DayOptions, type DayResult } from '../test/helpers/l4.ts';

interface Job extends DayOptions { set: string }

if (!isMainThread) {
  const jobs = workerData as Job[];
  for (const j of jobs) {
    const { trace: _t, ...res } = runDay(j);
    parentPort!.postMessage({ ...res, set: j.set });
  }
} else {
  const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : dflt; };
  const seeds = Number(arg('seeds', '200')), from = Number(arg('from', '1'));
  const versions = arg('versions', 'spec,pessimistic').split(',') as Array<'spec' | 'pessimistic'>;
  const sets = arg('sets', 'live,variants,r2c').split(',');
  const workers = Math.max(1, Math.min(Number(arg('workers', '3')), availableParallelism()));
  const minutes = Number(arg('minutes', '15'));
  const out = arg('out', '');

  const jobs: Job[] = [];
  for (const version of versions) {
    for (let seed = from; seed < from + seeds; seed++) {
      if (sets.includes('live')) jobs.push({ set: 'live', seed, version, site: 'dlh1', minutes });
      if (sets.includes('variants')) jobs.push({ set: 'variants', seed, version, site: seed % 2 ? 'v7' : 'v20', minutes });
      if (sets.includes('r2c')) jobs.push({ set: 'r2c', seed, version, site: 'dlh1', minutes, frozenStationary: true });
    }
  }
  const started = Date.now();
  const results: Array<DayResult & { set: string }> = [];
  const chunks: Job[][] = Array.from({ length: workers }, () => []);
  jobs.forEach((j, i) => chunks[i % workers]!.push(j));
  await Promise.all(chunks.map((chunk) => new Promise<void>((resolve, reject) => {
    if (chunk.length === 0) { resolve(); return; }
    const w = new Worker(new URL(import.meta.url), { workerData: chunk });
    w.on('message', (r: DayResult & { set: string }) => {
      results.push(r);
      if (results.length % 50 === 0) process.stderr.write(`${results.length}/${jobs.length} days, ${Math.round((Date.now() - started) / 1000)} s\n`);
    });
    w.on('error', reject);
    w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  })));
  results.sort((a, b) => a.version.localeCompare(b.version) || a.set.localeCompare(b.set) || a.seed - b.seed);
  if (out) writeFileSync(out, JSON.stringify(results, null, 1));

  const RULES = ['R0', 'R1', 'R2a', 'R2b', 'R3', 'R4', 'R5'];
  const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  const f1 = (x: number) => (Math.round(x * 10) / 10).toString();
  let failed = false;
  for (const version of versions) {
    for (const set of sets) {
      const days = results.filter((r) => r.version === version && r.set === set);
      if (!days.length) continue;
      console.log(`\n## ${version} version, ${set} (${days.length} days of ${minutes} min; ${days.reduce((s, d) => s + d.blasts, 0)} blasts, ${days.reduce((s, d) => s + d.closed, 0)} closed)`);
      if (set === 'r2c') {
        const withAny = days.filter((d) => d.r2c > 0);
        console.log(`R2c (undetectable fault, counted): ${days.reduce((s, d) => s + d.r2c, 0)} CLEAR-over-a-truck-inside moments (250 ms checks) on ${withAny.length} days: ${withAny.map((d) => `${d.seed} (${d.r2c})`).join(', ') || 'none'}`);
        const inside = days.filter((d) => d.r2cInside.length);
        console.log(`R2c, its truck inside a closed zone (no alarm is possible): ${inside.reduce((s, d) => s + d.r2cInside.length, 0)} times on ${inside.length} days: ${inside.map((d) => `${d.seed} (${d.r2cInside.join('; ')})`).join(', ') || 'none'}`);
      }
      console.log('| Rule | Days passed | Days failed | Failing seeds |');
      console.log('|---|---|---|---|');
      for (const rule of RULES) {
        const bad = days.filter((d) => d.violations.some((v) => v.rule === rule));
        if (bad.length) failed = true;
        console.log(`| ${rule} | ${days.length - bad.length} | ${bad.length} | ${bad.map((d) => `${d.seed}${d.site === 'dlh1' ? '' : `/${d.site}`}`).join(', ') || '-'} |`);
      }
      const m1 = days.map((d) => d.metrics.unnecessaryHolds), m1h = days.map((d) => d.metrics.holds), co = days.map((d) => d.metrics.heldForCalledOff);
      const m2 = days.map((d) => med(d.metrics.satAfterReopenMs) / 1000), m2w = days.map((d) => Math.max(0, ...d.metrics.satAfterReopenMs) / 1000);
      const m3 = days.map((d) => d.metrics.falseAlarms), m3a = days.map((d) => d.metrics.alarms);
      console.log('| Metric (per day) | Median | Worst |');
      console.log('|---|---|---|');
      console.log(`| M1 unnecessary holds (of all blast holds on closed blasts; median ${f1(med(m1h))} holds a day) | ${f1(med(m1))} | ${Math.max(...m1)} |`);
      console.log(`| M1 holds for blasts then called off | ${f1(med(co))} | ${Math.max(...co)} |`);
      console.log(`| M2 time sat after a reopen, s (day's median / day's worst) | ${f1(med(m2))} / ${f1(med(m2w))} | ${f1(Math.max(...m2))} / ${f1(Math.max(...m2w))} |`);
      console.log(`| M3 false alarms (of can't-clear alarms on closed blasts; median ${f1(med(m3a))} a day) | ${f1(med(m3))} | ${Math.max(...m3)} |`);
      const blocked = days.flatMap((d) => d.resumeBlocked.map((b) => b.replace(/^.*\): /, '')));
      const counts = new Map<string, number>();
      for (const b of blocked) counts.set(b, (counts.get(b) ?? 0) + 1);
      console.log(`R3 exclusions: ${[...counts].map(([k, n]) => `${k}: ${n}`).join('; ') || 'none'}`);
    }
  }
  console.log('\n## Every failing seed');
  for (const r of results) {
    for (const v of r.violations) {
      console.log(`- ${r.version} ${r.set} seed ${r.seed}${r.site === 'dlh1' ? '' : ` (${r.site})`}: ${v.rule}: ${v.detail}`);
    }
  }
  console.log(`\n${results.length} days in ${Math.round((Date.now() - started) / 1000)} s with ${workers} workers`);
  process.exitCode = failed ? 1 : 0;
}
