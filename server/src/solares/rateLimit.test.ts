import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimit, type RateLimitBuckets } from './rateLimit.js';
import { parseTrustProxy } from '../config.js';

function app(trustProxy: number | false, user?: (req: express.Request) => string | undefined) {
  const server = express();
  server.set('trust proxy', trustProxy);
  server.use((req, _res, next) => { const id = user?.(req); if (id) req.solaresUser = { id, wallets: [] }; next(); });
  server.get('/', rateLimit({ max: 2, message: 'Slow down.' }), (_req, res) => { res.json({ ok: true }); });
  return server;
}

test('TRUST_PROXY accepts hop counts or false, defaults to one hop only in production, and never trusts all', () => {
  assert.equal(parseTrustProxy(undefined, true), 1);
  assert.equal(parseTrustProxy('', true), 1);
  assert.equal(parseTrustProxy(undefined, false), false);
  assert.equal(parseTrustProxy('false', true), false);
  assert.equal(parseTrustProxy('0', true), false);
  assert.equal(parseTrustProxy(' 2 ', false), 2);
  for (const value of ['true', 'TRUE', '*', 'loopback', '-1', '1.5', '100', '10.0.0.1']) assert.throws(() => parseTrustProxy(value, true), value);
});

test('limits are per authenticated user and return Retry-After without calling the handler', async () => {
  const server = app(false, req => String(req.headers['x-test-user'] || '') || undefined);
  for (let i = 0; i < 2; i++) await request(server).get('/').set('x-test-user', 'alice').expect(200);
  const limited = await request(server).get('/').set('x-test-user', 'alice').expect(429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.deepEqual(limited.body, { error: 'Slow down.', code: 'RATE_LIMITED' });
  await request(server).get('/').set('x-test-user', 'bob').expect(200);
});

test('behind one trusted proxy, client IPs get separate buckets', async () => {
  const server = app(parseTrustProxy('1', false));
  for (let i = 0; i < 2; i++) await request(server).get('/').set('X-Forwarded-For', '203.0.113.7').expect(200);
  await request(server).get('/').set('X-Forwarded-For', '203.0.113.7').expect(429);
  await request(server).get('/').set('X-Forwarded-For', '198.51.100.9').expect(200);
  // Only the last hop is trusted: a client-prepended address cannot pick a new bucket.
  await request(server).get('/').set('X-Forwarded-For', '192.0.2.1, 203.0.113.7').expect(429);
});

test('without a trusted proxy, forged X-Forwarded-For cannot escape the limit', async () => {
  const server = app(parseTrustProxy(undefined, false));
  for (let i = 0; i < 2; i++) await request(server).get('/').set('X-Forwarded-For', `198.51.100.${i}`).expect(200);
  await request(server).get('/').set('X-Forwarded-For', '198.51.100.99').expect(429);
});

test('distinct keys inside one window cannot grow memory past maxKeys', async () => {
  const store: RateLimitBuckets = new Map();
  const server = express();
  server.set('trust proxy', 1);
  server.get('/', rateLimit({ max: 1, message: 'Slow down.', maxKeys: 5, store }), (_req, res) => { res.json({ ok: true }); });
  // Rotating client networks within a single window (IPv6 is keyed by /64: each of these is another /64).
  for (let i = 0; i < 40; i++) {
    await request(server).get('/').set('X-Forwarded-For', `2001:db8:${i.toString(16)}::1`).expect(200);
    assert.ok(store.size <= 5, `size ${store.size} after ${i + 1} keys`);
  }
  // The newest buckets are kept and still enforce the limit, for any address in that /64; the oldest were evicted.
  await request(server).get('/').set('X-Forwarded-For', '2001:db8:27::abcd').expect(429);
  assert.equal(store.has('2001:db8:27::/64:'), true);
  assert.equal(store.has('2001:db8::/64:'), false);
});

test('expired buckets are dropped before live ones when the key cap is reached', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const store: RateLimitBuckets = new Map();
  const server = express();
  server.set('trust proxy', 1);
  server.get('/', rateLimit({ max: 1, message: 'Slow down.', maxKeys: 2, windowMs: 1_000, store }), (_req, res) => { res.json({ ok: true }); });
  await request(server).get('/').set('X-Forwarded-For', '198.51.100.1').expect(200);
  t.mock.timers.tick(2_000);
  await request(server).get('/').set('X-Forwarded-For', '198.51.100.2').expect(200);
  await request(server).get('/').set('X-Forwarded-For', '198.51.100.3').expect(200);
  assert.deepEqual([...store.keys()], ['198.51.100.2:', '198.51.100.3:']);
});
