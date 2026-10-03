// TESTING.md L1.1 and L1.3: rules about what product code may contain, checked over src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
// The fake gateway (test infrastructure) is held to the same rules: it takes a Clock, and its model
// knows no site. Its default site config is the one place this site's literals belong.
const FAKE = new URL('../fake/', import.meta.url).pathname;
const FAKE_SITE_CONFIG = 'dlh1.ts';

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
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

test('L1.1 the fake gateway never reads the wall clock', () => {
  const found = sourceFiles(FAKE).flatMap((f) => violations(readFileSync(f, 'utf8'), WALL_CLOCK).map((v) => `fake/${relative(FAKE, f)} ${v}`));
  assert.deepEqual(found, []);
});

// The fixture player paces itself on an injected clock too (task 6a), and knows no site. Its
// screenshot list is the exception for site literals: like a test, it names moments in this site's
// recordings.
const PLAYER = new URL('../player/', import.meta.url).pathname;
const PLAYER_SHOT_LIST = 'shoot.ts';

test('L1.1 and L1.3 the fixture player takes a Clock and contains none of this site\'s literals', () => {
  const found = sourceFiles(PLAYER).flatMap((f) =>
    violations(readFileSync(f, 'utf8'), relative(PLAYER, f) === PLAYER_SHOT_LIST ? WALL_CLOCK : [...WALL_CLOCK, ...SITE_LITERALS])
      .map((v) => `player/${relative(PLAYER, f)} ${v}`));
  assert.deepEqual(found, []);
});

test('L1.3 the fake gateway\'s model contains none of this site\'s literals (only its default config does)', () => {
  const found = sourceFiles(FAKE)
    .filter((f) => relative(FAKE, f) !== FAKE_SITE_CONFIG)
    .flatMap((f) => violations(readFileSync(f, 'utf8'), SITE_LITERALS).map((v) => `fake/${relative(FAKE, f)} ${v}`));
  assert.deepEqual(found, []);
});
