// TESTING.md L1: injectable time. The manual clock is what lets blast scenarios run in milliseconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';

test('now() only moves when advanced', () => {
  const c = new ManualClock(1_000);
  assert.equal(c.now(), 1_000);
  c.advance(250);
  assert.equal(c.now(), 1_250);
});

test('timers fire in due order, and each sees now() equal to its due time', () => {
  const c = new ManualClock(0);
  const seen: Array<[string, number]> = [];
  c.setTimeout(() => seen.push(['b', c.now()]), 200);
  c.setTimeout(() => seen.push(['a', c.now()]), 100);
  c.setTimeout(() => seen.push(['c', c.now()]), 300);
  c.advance(250);
  assert.deepEqual(seen, [['a', 100], ['b', 200]]);
  assert.equal(c.now(), 250);
  c.advance(50);
  assert.deepEqual(seen.at(-1), ['c', 300]);
});

test('timers due at the same moment fire in the order they were set', () => {
  const c = new ManualClock(0);
  const seen: string[] = [];
  for (const k of ['x', 'y', 'z']) c.setTimeout(() => seen.push(k), 10);
  c.advance(10);
  assert.deepEqual(seen, ['x', 'y', 'z']);
});

test('a timer set by a firing timer runs within the same advance if it falls due', () => {
  const c = new ManualClock(0);
  const seen: number[] = [];
  const tick = () => { seen.push(c.now()); if (c.now() < 1_000) c.setTimeout(tick, 200); };
  c.setTimeout(tick, 200);
  c.advance(1_000);
  assert.deepEqual(seen, [200, 400, 600, 800, 1_000]);
});

test('a cleared timer never fires; clearing twice is harmless', () => {
  const c = new ManualClock(0);
  let fired = false;
  const h = c.setTimeout(() => { fired = true; }, 10);
  c.clearTimeout(h);
  c.clearTimeout(h);
  c.advance(100);
  assert.equal(fired, false);
  assert.equal(c.pending(), 0);
});

test('advance refuses to go backwards', () => {
  const c = new ManualClock(0);
  assert.throws(() => c.advance(-1), RangeError);
});

test('a runaway timer loop is stopped, not hung', () => {
  const c = new ManualClock(0);
  const again = () => { c.setTimeout(again, 0); };
  c.setTimeout(again, 0);
  assert.throws(() => c.advance(1), /runaway/);
});

// L1.2 at the clock level: a blast-length schedule of 12 trucks at 5 Hz (about 230 s of CLOSING and
// CLOSED) runs in well under 100 ms of real time. The full L1.2, with the blast engine, comes in task 5.
test('L1.2 (clock level) a blast-length timeline runs in under 100 ms', () => {
  const c = new ManualClock(0);
  let ticks = 0;
  for (let truck = 0; truck < 12; truck++) {
    const tick = () => { ticks++; c.setTimeout(tick, 200); };
    c.setTimeout(tick, 200);
  }
  const started = performance.now();
  c.advance(230_000);
  const took = performance.now() - started;
  assert.equal(ticks, 12 * 1_150);
  assert.ok(took < 100, `took ${took.toFixed(1)} ms`);
});
