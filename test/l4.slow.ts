// TESTING.md L4 in the slow suite: every seed that ever failed (test/seeds/regressions, one JSON object
// per line: seed, version, site, frozenStationary, and what failed), plus a few fresh days under both
// versions of L0.P. The full 200-seed run is `npm run test:l4` (tools/l4.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runDay, type DayOptions, type Version } from './helpers/l4.ts';

interface Regression extends DayOptions { rule: string; note: string }

const REGRESSIONS = new URL('./seeds/regressions', import.meta.url);
const regressions: Regression[] = readFileSync(REGRESSIONS, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => JSON.parse(l) as Regression);

function check(o: DayOptions): void {
  const r = runDay(o);
  assert.deepEqual(r.violations.map((v) => `${v.rule}: ${v.detail}`), [], `seed ${o.seed} (${o.version}, ${o.site}${o.frozenStationary ? ', frozen while stopped' : ''})`);
}

for (const g of regressions) {
  test(`L4 regression: seed ${g.seed}, ${g.version}, ${g.site}${g.frozenStationary ? ', frozen while stopped' : ''} (${g.rule}: ${g.note})`, { timeout: 120_000 }, () => check(g));
}

for (const version of ['spec', 'pessimistic'] as Version[]) {
  for (const seed of [101, 102]) {
    test(`L4 a fresh live day: seed ${seed}, ${version}`, { timeout: 120_000 }, () => check({ seed, version, site: 'dlh1' }));
  }
  test(`L4.S a different site: seed 103, ${version}, 20 trucks, 60 s notice`, { timeout: 120_000 }, () => check({ seed: 103, version, site: 'v20' }));
}
