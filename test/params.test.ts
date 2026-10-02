// Every parameter says where it came from (CLAUDE.md invariant 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS } from '../src/params.ts';

test('every parameter is a positive number with a source and a reference', () => {
  for (const [name, p] of Object.entries(PARAMS)) {
    assert.ok(Number.isFinite(p.value) && p.value > 0, `${name} value`);
    assert.ok(['spec', 'measured', 'decided'].includes(p.source), `${name} source`);
    assert.ok(p.ref.length > 10, `${name} needs a real reference`);
  }
});

test('values the research marks as assumed are not labelled measured', () => {
  assert.equal(PARAMS.reverseSpeedLoaded.source, 'spec');
  assert.match(PARAMS.reverseSpeedLoaded.ref, /not measured/);
});

test('the silent threshold leaves room inside the 10 s can\'t-clear budget', () => {
  assert.ok(PARAMS.truckSilentAfter.value < PARAMS.cantClearAlarmWithin.value);
  assert.ok(PARAMS.frozenAfter.value < PARAMS.cantClearAlarmWithin.value);
});
