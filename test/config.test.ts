// Task 6b scope 1: the service's configuration comes from the environment, names what is missing,
// and never echoes a value (the email is what the gateway logs us under).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOST, DEFAULT_PORT, DEMO_USERS_FILE, serviceConfigFromEnv } from '../src/config.ts';

const EMAIL = 'someone.secret@example.org';
const BASE = { GATEWAY_HOST: 'gw.invalid', GATEWAY_PORT: '7443', GATEWAY_EMAIL: EMAIL };

test('the three GATEWAY_* variables are enough; the rest has defaults', () => {
  const c = serviceConfigFromEnv(BASE);
  assert.deepEqual(c.link, { host: 'gw.invalid', port: 7443, email: EMAIL });
  assert.equal(c.http.port, DEFAULT_PORT);
  assert.equal(c.http.port, 8090);
  assert.equal(c.http.host, DEFAULT_HOST);
  assert.equal(c.http.host, '127.0.0.1');
  assert.deepEqual(c.http.publicOrigins, []);
  assert.equal(c.dataDir, 'data');
  assert.equal(c.usersFile, DEMO_USERS_FILE);
  assert.equal(c.demoUsers, true);
});

test('a missing variable is named, and no value is ever in the message', () => {
  for (const k of ['GATEWAY_HOST', 'GATEWAY_PORT', 'GATEWAY_EMAIL'] as const) {
    const env: Record<string, string> = { ...BASE };
    delete env[k];
    assert.throws(() => serviceConfigFromEnv(env), (e: Error) => {
      assert.match(e.message, new RegExp(k));
      for (const v of Object.values(BASE)) assert.ok(!e.message.includes(v), `${k}: message must not echo ${v}`);
      return true;
    });
  }
  assert.throws(() => serviceConfigFromEnv({}), /GATEWAY_HOST, GATEWAY_PORT, GATEWAY_EMAIL/);
});

test('bad values are named without echoing them', () => {
  const bad: Array<[Record<string, string>, RegExp]> = [
    [{ PORT: '80x' }, /Error: PORT is not a port number$/],
    [{ PORT: '70000' }, /Error: PORT is not a port number$/],
    [{ HOST: 'a b' }, /Error: HOST is not an address$/],
    [{ PUBLIC_ORIGIN: 'not a url' }, /Error: PUBLIC_ORIGIN is not/],
    [{ PUBLIC_ORIGIN: 'https://x.example/path' }, /Error: PUBLIC_ORIGIN is not/],
    [{ PUBLIC_ORIGIN: 'ftp://x.example' }, /Error: PUBLIC_ORIGIN is not/],
  ];
  for (const [over, re] of bad) assert.throws(() => serviceConfigFromEnv({ ...BASE, ...over }), re, JSON.stringify(over));
});

test('PORT, HOST, DATA_DIR, USERS_FILE and PUBLIC_ORIGIN are taken when given', () => {
  const c = serviceConfigFromEnv({ ...BASE, PORT: '0', HOST: '0.0.0.0', DATA_DIR: '/var/x', USERS_FILE: '/etc/users.json', PUBLIC_ORIGIN: 'https://cr.example.com, http://10.0.0.5:8090' });
  assert.equal(c.http.port, 0);
  assert.equal(c.http.host, '0.0.0.0');
  assert.equal(c.dataDir, '/var/x');
  assert.equal(c.usersFile, '/etc/users.json');
  assert.equal(c.demoUsers, false);
  assert.deepEqual(c.http.publicOrigins, ['https://cr.example.com', 'http://10.0.0.5:8090']);
});
