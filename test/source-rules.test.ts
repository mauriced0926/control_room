// TESTING.md L1.1 and L1.3: rules about what product code may contain, checked over src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith('._') ? [] : e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

// L1.1: only the clock adapter may touch the wall clock or timers.
const WALL_CLOCK = [
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bprocess\.hrtime\b/,
  /(?<![.\w])(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval)\s*\(/,
];

// L1.3: this site's names and numbers. The product takes them from hello and zone_event instead.
const SITE_LITERALS = [
  /\b(DECLINE|L4_NORTH|DRAW_12|L4_SOUTH|INCLINE|TIP)\b/,
  /['"`]BAY['"`]/,
  /\bSEG-/,
  /\bHT-\d/,
  /\b1600(\.0)?\b/,
  /\b120_?000\b/,
];

function violations(text: string, rules: RegExp[]): string[] {
  return text.split('\n').flatMap((line, i) => rules.filter((r) => r.test(line)).map((r) => `line ${i + 1}: ${line.trim()}  [${r}]`));
}

test('L1.1 the rule catches each kind of wall-clock access', () => {
  for (const planted of ['const t = Date.now();', 'new Date()', 'performance.now()', 'process.hrtime.bigint()', 'setTimeout(f, 10)', 'clearInterval(h)']) {
    assert.equal(violations(planted, WALL_CLOCK).length, 1, planted);
  }
  assert.deepEqual(violations('clock.setTimeout(f, 10); clock.now()', WALL_CLOCK), []);
});

test('L1.1 no product module outside the clock adapter reads the wall clock', () => {
  const found = sourceFiles(SRC)
    .filter((f) => relative(SRC, f) !== 'clock.ts')
    .flatMap((f) => violations(readFileSync(f, 'utf8'), WALL_CLOCK).map((v) => `${relative(SRC, f)} ${v}`));
  assert.deepEqual(found, []);
});

test('L1.3 the rule catches each kind of site literal', () => {
  for (const planted of ["zone === 'DECLINE'", "if (z === 'BAY')", "'SEG-BAY'", "vehicle: 'HT-04'", 'const loop = 1600;', 'const notice = 120_000;']) {
    assert.equal(violations(planted, SITE_LITERALS).length, 1, planted);
  }
  assert.deepEqual(violations("segment.kind === 'bay'; const n = 16000;", SITE_LITERALS), []);
});

test('L1.3 product code contains none of this site\'s literals', () => {
  const found = sourceFiles(SRC).flatMap((f) => violations(readFileSync(f, 'utf8'), SITE_LITERALS).map((v) => `${relative(SRC, f)} ${v}`));
  assert.deepEqual(found, []);
});
