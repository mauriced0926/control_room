// Login throttling counts per client address, so behind a proxy the service must see the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../src/http.ts';
import { serviceConfigFromEnv as loadConfig } from '../src/config.ts';

const req = (peer: string, xff?: string) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as never;

test('from loopback, the proxy\'s last X-Forwarded-For entry is the client', () => {
  assert.equal(clientAddress(req('127.0.0.1', '203.0.113.9'), false), '203.0.113.9');
  assert.equal(clientAddress(req('::1', 'spoofed, 198.51.100.4'), false), '198.51.100.4', 'the last entry is the one the proxy saw');
});

test('from Docker\'s bridge, X-Forwarded-For is ignored unless TRUST_PROXY is set', () => {
  assert.equal(clientAddress(req('172.18.0.1', '203.0.113.9'), false), '172.18.0.1');
  assert.equal(clientAddress(req('172.18.0.1', '203.0.113.9'), true), '203.0.113.9');
});

test('with no X-Forwarded-For, the peer itself, trusted or not', () => {
  assert.equal(clientAddress(req('172.18.0.1'), true), '172.18.0.1');
});

test('TRUST_PROXY is off unless set to a yes', () => {
  const base = { GATEWAY_HOST: 'h', GATEWAY_PORT: '443', GATEWAY_EMAIL: 'e@example.com' };
  assert.equal(loadConfig(base).http.trustProxy, false);
  assert.equal(loadConfig({ ...base, TRUST_PROXY: '1' }).http.trustProxy, true);
  assert.equal(loadConfig({ ...base, TRUST_PROXY: 'no' }).http.trustProxy, false);
});
