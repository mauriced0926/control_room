// Task 6b scope 2: operators, roles and passwords. Passwords are stored only as scrypt hashes; the
// demo file has two operators and one supervisor; the demo passwords are written in one place
// (README.md) and that place is checked against the file, so the graders' list can't drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEMO_USERS_FILE } from '../src/config.ts';
import { hashPassword, parseUsers, UserBook, verifyPassword } from '../src/users.ts';

const CHEAP = { N: 2 ** 10, r: 8, p: 1 }; // tests only; the demo file uses the real cost

test('a hash verifies its own password and nothing else, and never contains it', async () => {
  const h = await hashPassword('correct horse battery', CHEAP);
  assert.match(h, /^scrypt\$1024\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
  assert.ok(!h.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('correct horse batterz', h), false);
  assert.equal(await verifyPassword('', h), false);
  assert.notEqual(await hashPassword('correct horse battery', CHEAP), h, 'salted: the same password hashes differently');
});

test('a malformed or absurdly costly hash is refused, not run', async () => {
  for (const bad of ['', 'plain-text-password', 'scrypt$1048577$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86), 'scrypt$4194304$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86), 'scrypt$1024$8$1$short$' + 'A'.repeat(86)]) {
    assert.equal(await verifyPassword('x', bad), false, bad.slice(0, 30));
  }
});

test('the users file: ids, roles and hashes are checked; plain passwords and "system" ids are refused', async () => {
  const h = await hashPassword('password-1', CHEAP);
  const doc = (users: unknown[]) => JSON.stringify({ users });
  assert.equal(parseUsers(doc([{ id: 'ann', name: 'Ann', role: 'operator', passwordHash: h }])).length, 1);
  const bad: Array<[unknown, RegExp]> = [
    [{ id: 'Ann', name: 'Ann', role: 'operator', passwordHash: h }, /id must be/],
    [{ id: 'system', name: 'S', role: 'operator', passwordHash: h }, /may not start with "system"/],
    [{ id: 'systemx', name: 'S', role: 'supervisor', passwordHash: h }, /may not start with "system"/],
    [{ id: 'ann', name: 'Ann', role: 'admin', passwordHash: h }, /role must be/],
    [{ id: 'ann', name: 'Ann', role: 'operator', passwordHash: 'hunter22' }, /not a scrypt hash/],
    [{ id: 'ann', name: 'Ann', role: 'operator', passwordHash: h, password: 'hunter22' }, /plain "password" field is not allowed/],
    [{ id: 'ann', name: '', role: 'operator', passwordHash: h }, /name must be/],
  ];
  for (const [u, re] of bad) assert.throws(() => parseUsers(doc([u])), re, JSON.stringify(u));
  assert.throws(() => parseUsers(doc([{ id: 'a1', name: 'A', role: 'operator', passwordHash: h }, { id: 'a1', name: 'B', role: 'operator', passwordHash: h }])), /appears twice/);
  assert.throws(() => parseUsers('{'), /not valid JSON/);
  assert.throws(() => parseUsers('{"users": []}'), /no "users" list/);
});

test('verify gives the user for the right password, null otherwise, and the same for an unknown name', async () => {
  const book = new UserBook(parseUsers(JSON.stringify({ users: [{ id: 'ann', name: 'Ann', role: 'supervisor', passwordHash: await hashPassword('password-1', CHEAP) }] })));
  assert.deepEqual(await book.verify('ann', 'password-1'), { id: 'ann', name: 'Ann', role: 'supervisor' });
  assert.equal(await book.verify('ann', 'password-2'), null);
  assert.equal(await book.verify('bob', 'password-1'), null);
  assert.equal(await book.verify('__proto__', 'x'), null);
});

// The one place the demo passwords are written down: README.md, "Demo logins".
function readmeDemoLogins(): Array<{ id: string; role: string; password: string }> {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rows = [...readme.matchAll(/^\| `([a-z]+)` \| (operator|supervisor) \| `([^`]+)` \|$/gm)];
  return rows.map((m) => ({ id: m[1]!, role: m[2]!, password: m[3]! }));
}

test('the demo users file: two operators and a supervisor, hashes only, and README\'s passwords match it', async () => {
  const text = readFileSync(DEMO_USERS_FILE, 'utf8');
  const users = parseUsers(text);
  assert.deepEqual(users.map((u) => u.role).sort(), ['operator', 'operator', 'supervisor']);
  for (const u of users) assert.match(u.passwordHash, /^scrypt\$32768\$8\$3\$/, `${u.id} uses the full cost`);
  assert.match(JSON.parse(text).note, /DEMO/);

  const logins = readmeDemoLogins();
  assert.equal(logins.length, 3, 'README.md lists the three demo logins');
  const book = UserBook.fromFile(DEMO_USERS_FILE);
  for (const l of logins) {
    assert.ok(!text.includes(l.password), `${l.id}'s plain password is not in the users file`);
    const u = await book.verify(l.id, l.password);
    assert.equal(u?.role, l.role, `${l.id} logs in with the README password as ${l.role}`);
  }
});
