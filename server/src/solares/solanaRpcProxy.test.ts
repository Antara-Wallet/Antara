import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { refuseCall, solanaRpcRouter, SQUADS_PROGRAM_ID } from './solanaRpcProxy';

async function upstream(): Promise<{ url: string; server: Server; seen: unknown[] }> {
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }).on('end', () => {
      const parsed = JSON.parse(body); seen.push(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(call => ({ jsonrpc: '2.0', id: call.id, result: call.method })) : { jsonrpc: '2.0', id: parsed.id, result: parsed.method }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}/v2/secret-key-never-leak`, server, seen };
}
function app(url: string, extra: Parameters<typeof solanaRpcRouter>[0] = {}) {
  const instance = express(); instance.use(express.json({ limit: '256kb' }));
  instance.use('/rpc', solanaRpcRouter({ upstream: () => url, configured: () => true, ...extra }));
  return instance;
}

test('forwards allowlisted calls and filtered Squads lookups', async () => {
  const up = await upstream();
  try {
    const res = await request(app(up.url)).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }).expect(200);
    assert.equal(res.body.result, 'getLatestBlockhash');
    const gpa = { jsonrpc: '2.0', id: 2, method: 'getProgramAccounts', params: [SQUADS_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: 'abc' } }, { memcmp: { offset: 8, bytes: 'EMBKd4yFBPGFYSn6aBBRQuy3uy9oZL9XWwFvvWV4rj9o' } }] }] };
    assert.equal((await request(app(up.url)).post('/rpc').send(gpa).expect(200)).body.result, 'getProgramAccounts');
    assert.equal((await request(app(up.url)).post('/rpc').send([{ jsonrpc: '2.0', id: 3, method: 'getSlot' }, { jsonrpc: '2.0', id: 4, method: 'getBalance', params: ['x'] }]).expect(200)).body.length, 2);
    assert.ok(!JSON.stringify(res.body).includes('secret-key-never-leak'));
  } finally { up.server.close(); }
});

test('refuses unlisted methods, open program scans and oversized batches', async () => {
  assert.equal(refuseCall({ method: 'getProgramAccounts', params: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { filters: [{ memcmp: { offset: 8, bytes: 'x' } }] }] }), 'Program not available.');
  assert.equal(refuseCall({ method: 'getProgramAccounts', params: [SQUADS_PROGRAM_ID] }), 'A filtered query is required.');
  assert.equal(refuseCall({ method: 'getProgramAccounts', params: [SQUADS_PROGRAM_ID, { filters: [{ dataSize: 100 }] }] }), 'A filtered query is required.');
  assert.equal(refuseCall({ method: 'requestAirdrop', params: [] }), 'Method not available.');
  assert.equal(refuseCall({ method: 'getLargestAccounts' }), 'Method not available.');
  const up = await upstream();
  try {
    await request(app(up.url)).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getLargestAccounts' }).expect(400);
    await request(app(up.url)).post('/rpc').send(Array.from({ length: 11 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'getSlot' }))).expect(400);
    assert.equal(up.seen.length, 0);
  } finally { up.server.close(); }
});

test('rate limits per caller and globally, and never leaks the upstream on failure', async () => {
  const up = await upstream();
  try {
    const limited = app(up.url, { perIpPerMinute: 2 });
    await request(limited).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getSlot' }).expect(200);
    await request(limited).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getSlot' }).expect(200);
    await request(limited).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getSlot' }).expect(429);
    const global = app(up.url, { globalPerMinute: 1 });
    await request(global).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getSlot' }).expect(200);
    await request(global).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getSlot' }).expect(429);
  } finally { up.server.close(); }
  const down = await request(app('http://127.0.0.1:9/v2/secret-key-never-leak')).post('/rpc').send({ jsonrpc: '2.0', id: 7, method: 'getSlot' }).expect(502);
  assert.equal(down.body.id, 7);
  assert.ok(!JSON.stringify(down.body).includes('secret-key-never-leak'));
  const unconfigured = express(); unconfigured.use(express.json());
  unconfigured.use('/rpc', solanaRpcRouter({ upstream: () => '', configured: () => false }));
  await request(unconfigured).post('/rpc').send({ jsonrpc: '2.0', id: 1, method: 'getSlot' }).expect(503);
});
