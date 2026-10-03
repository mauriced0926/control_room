// Task 6b scope 2: sessions held in memory, with an idle timeout and a hard limit; logout ends them;
// login throttling that can't be used to lock someone else out. All on an injected clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { PARAMS } from '../src/params.ts';
import { clearedCookie, LoginThrottle, sessionCookie, sessionIdFrom, Sessions, type EndReason } from '../src/sessions.ts';
import type { User } from '../src/users.ts';

const ANN: User = { id: 'ann', name: 'Ann', role: 'operator' };

test('a session id is 256 random bits, base64url, different every time', () => {
  const s = new Sessions(new ManualClock(0));
  const ids = new Set(Array.from({ length: 200 }, () => s.create(ANN).id));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{43}$/);
});

test('idle timeout: a session unused for the idle time ends, and says why', () => {
  const clock = new ManualClock(0);
  const s = new Sessions(clock);
  const ended: Array<[string, EndReason]> = [];
  s.onEnd((x, why) => ended.push([x.user.id, why]));
  const a = s.create(ANN);
  clock.advance(PARAMS.sessionIdleTimeout.value - 1);
  assert.ok(s.get(a.id));
  s.touch(a.id);
  clock.advance(PARAMS.sessionIdleTimeout.value - 1);
  assert.ok(s.get(a.id), 'touched, so still alive');
  clock.advance(1);
  assert.equal(s.get(a.id), undefined);
  assert.deepEqual(ended, [['ann', 'idle']]);
  s.touch(a.id);
  assert.equal(s.get(a.id), undefined, 'an ended session cannot be revived by touching it');
});

test('maximum age: a session ends at the limit however busy it is', () => {
  const clock = new ManualClock(0);
  const s = new Sessions(clock);
  const ended: EndReason[] = [];
  s.onEnd((_x, why) => ended.push(why));
  const a = s.create(ANN);
  for (let t = 0; t < PARAMS.sessionMaxAge.value; t += 60_000) { s.touch(a.id); clock.advance(60_000); }
  s.sweep();
  assert.equal(s.get(a.id), undefined);
  assert.deepEqual(ended, ['max_age']);
});

test('logout ends exactly that session', () => {
  const s = new Sessions(new ManualClock(0));
  const a = s.create(ANN), b = s.create(ANN);
  assert.equal(s.end(a.id, 'logout')?.id, a.id);
  assert.equal(s.get(a.id), undefined);
  assert.ok(s.get(b.id));
  assert.equal(s.end(a.id, 'logout'), undefined, 'ending twice does nothing');
});

test('cookies: HttpOnly, SameSite=Strict, Path=/; Secure only when asked; ids parsed strictly', () => {
  const c = sessionCookie('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', { secure: false, maxAgeMs: 3_600_000 });
  assert.match(c, /^cr_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG; HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600$/);
  assert.match(sessionCookie('x'.repeat(43), { secure: true, maxAgeMs: 1000 }), /; Secure$/);
  assert.match(clearedCookie({ secure: false }), /^cr_session=; .*Max-Age=0/);
  const id = 'a'.repeat(43);
  assert.equal(sessionIdFrom(`theme=dark; cr_session=${id}; x=1`), id);
  assert.equal(sessionIdFrom('cr_session=short'), undefined);
  assert.equal(sessionIdFrom(`cr_session=${'a'.repeat(40)};drop table`), 'a'.repeat(40));
  assert.equal(sessionIdFrom(`cr_session=${'a'.repeat(40)}"`), undefined);
  assert.equal(sessionIdFrom(undefined), undefined);
});

test('throttle: too many failures from one address are refused for the window, then allowed again', () => {
  const clock = new ManualClock(0);
  const t = new LoginThrottle(clock);
  const k = LoginThrottle.keys('10.0.0.9', 'dave');
  for (let i = 0; i < PARAMS.loginMaxFailures.value; i++) { assert.equal(t.blocked(k), false); t.failed(k); }
  assert.equal(t.blocked(k), true);
  assert.equal(t.blocked(LoginThrottle.keys('10.0.0.9', 'priya')), true, 'the address is blocked for every name');
  assert.equal(t.blocked(LoginThrottle.keys('10.0.0.7', 'dave')), false, 'Dave at his own desk is not locked out');
  clock.advance(PARAMS.loginFailureWindow.value);
  assert.equal(t.blocked(k), false);
});
