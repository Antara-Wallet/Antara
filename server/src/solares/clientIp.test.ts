import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CLIENT_IP_HEADER_SETTING, clientIp, describeClientIpStrategy, parseClientIpHeader, type EdgeClientIpHeader } from './clientIp.js';
import { rateLimit } from './rateLimit.js';
import { observeNetwork } from './layers/network.js';

const RENDER_WEB = { RENDER: 'true', RENDER_SERVICE_TYPE: 'web' };

/** An app wired like index.ts: TRUST_PROXY hops plus, optionally, the edge header. */
function app(trustProxy: number | false, header: EdgeClientIpHeader | null) {
  const server = express();
  server.set('trust proxy', trustProxy);
  server.set(CLIENT_IP_HEADER_SETTING, header);
  server.get('/ip', (req, res) => { res.json({ ip: clientIp(req) ?? null }); });
  server.get('/limited', rateLimit({ max: 2, message: 'Slow down.' }), (_req, res) => { res.json({ ok: true }); });
  return server;
}
const ipOf = async (server: express.Express, headers: Record<string, string>) => {
  let pending = request(server).get('/ip');
  for (const [name, value] of Object.entries(headers)) pending = pending.set(name, value);
  return (await pending.expect(200)).body.ip as string | null;
};

test('CLIENT_IP_HEADER defaults to cf-connecting-ip only on a Render web service and rejects client-settable headers', () => {
  assert.equal(parseClientIpHeader(undefined, RENDER_WEB), 'cf-connecting-ip');
  assert.equal(parseClientIpHeader('', { RENDER: 'true' }), 'cf-connecting-ip');
  assert.equal(parseClientIpHeader(undefined, { RENDER: 'true', RENDER_SERVICE_TYPE: 'pserv' }), null, 'private services are not behind Cloudflare');
  assert.equal(parseClientIpHeader(undefined, {}), null);
  assert.equal(parseClientIpHeader(undefined, { RENDER: 'false', RENDER_SERVICE_TYPE: 'web' }), null);
  assert.equal(parseClientIpHeader(' CF-Connecting-IP ', {}), 'cf-connecting-ip');
  assert.equal(parseClientIpHeader('none', RENDER_WEB), null);
  assert.equal(parseClientIpHeader('false', RENDER_WEB), null);
  // True-Client-IP reaches Render unchanged from the client (measured), so it is client-settable there.
  for (const value of ['x-forwarded-for', 'X-Real-IP', 'forwarded', 'x-client-ip', 'true-client-ip', 'True-Client-IP', 'true', '*', 'cf-connecting-ip,true-client-ip']) {
    assert.throws(() => parseClientIpHeader(value, RENDER_WEB), /not supported/, value);
  }
});

test('edge header: the client is CF-Connecting-IP; forged X-Forwarded-For, X-Real-IP and True-Client-IP are ignored', async () => {
  const server = app(1, 'cf-connecting-ip');
  assert.equal(await ipOf(server, { 'CF-Connecting-IP': '203.0.113.7' }), '203.0.113.7');
  // The X-Forwarded-For shape measured behind Render: <client-supplied>, <real client>, <Cloudflare edge>, <Render internal>.
  const renderChain = { 'X-Forwarded-For': '192.0.2.44, 203.0.113.7, 172.71.1.1, 10.0.0.5', 'CF-Connecting-IP': '203.0.113.7' };
  assert.equal(await ipOf(server, renderChain), '203.0.113.7');
  assert.equal(await ipOf(server, { ...renderChain, 'X-Real-IP': '192.0.2.1', 'True-Client-IP': '192.0.2.2' }), '203.0.113.7');
  // Why hop counting is wrong there: one trusted hop lands on Render's internal address, shared by every client.
  const hops = express();
  hops.set('trust proxy', 1);
  hops.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
  assert.equal((await request(hops).get('/ip').set('X-Forwarded-For', renderChain['X-Forwarded-For']).expect(200)).body.ip, '10.0.0.5');
});

test('edge header: absent or malformed falls back to the TCP peer, never to X-Forwarded-For', async () => {
  const server = app(1, 'cf-connecting-ip');
  assert.equal(await ipOf(server, { 'X-Forwarded-For': '203.0.113.9' }), '127.0.0.1');
  assert.equal(await ipOf(server, { 'True-Client-IP': '203.0.113.9' }), '127.0.0.1');
  for (const forged of ['203.0.113.7, 198.51.100.1', '203.0.113.7:443', '[2001:db8::1]', 'fe80::1%eth0', 'not-an-ip', '']) {
    assert.equal(await ipOf(server, { 'CF-Connecting-IP': forged, 'X-Forwarded-For': '203.0.113.9' }), '127.0.0.1', forged);
  }
  // A duplicated header arrives as one comma-joined value: refused, not split.
  const listening: Server = await new Promise(resolve => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port: (listening.address() as AddressInfo).port, path: '/ip' }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve(text));
      });
      outgoing.on('error', reject);
      outgoing.setHeader('CF-Connecting-IP', ['203.0.113.7', '198.51.100.1']);
      outgoing.end();
    });
    assert.equal(JSON.parse(body).ip, '127.0.0.1');
  } finally { await new Promise(resolve => listening.close(resolve)); }
});

test('edge header values are canonicalised', async () => {
  const server = app(false, 'cf-connecting-ip');
  assert.equal(await ipOf(server, { 'CF-Connecting-IP': '::ffff:203.0.113.7' }), '203.0.113.7');
  assert.equal(await ipOf(server, { 'CF-Connecting-IP': '2001:DB8:0:0:0:0:0:1' }), '2001:db8::1');
  assert.equal(await ipOf(server, { 'True-Client-IP': '203.0.113.8', 'CF-Connecting-IP': '203.0.113.7' }), '203.0.113.7');
});

test('without an edge header, client-sent CF-Connecting-IP is ignored and only TRUST_PROXY hops count', async () => {
  const hops = app(1, null);
  assert.equal(await ipOf(hops, { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.2, 203.0.113.7' }), '203.0.113.7');
  const socket = app(false, null);
  const peer = await ipOf(socket, { 'CF-Connecting-IP': '192.0.2.1', 'True-Client-IP': '192.0.2.3', 'X-Forwarded-For': '192.0.2.2' });
  assert.ok(peer === '::ffff:127.0.0.1' || peer === '127.0.0.1' || peer === '::1', String(peer));
});

test('rate limits behind the edge: one bucket per CF-Connecting-IP that forged X-Forwarded-For cannot escape', async () => {
  const server = app(1, 'cf-connecting-ip');
  const hit = (cf: string, xff: string) => request(server).get('/limited').set('CF-Connecting-IP', cf).set('X-Forwarded-For', `${xff}, ${cf}, 172.71.1.1, 10.0.0.5`);
  await hit('203.0.113.7', '192.0.2.1').expect(200);
  await hit('203.0.113.7', '192.0.2.2').expect(200);
  await hit('203.0.113.7', '192.0.2.3').expect(429);
  // Another client behind the same Cloudflare edge and Render hop keeps its own bucket.
  await hit('198.51.100.9', '192.0.2.3').expect(200);
});

test('rate limits key an IPv6 client by its /64, so rotating addresses inside it opens no new bucket', async () => {
  const server = app(false, 'cf-connecting-ip');
  const hit = (cf: string) => request(server).get('/limited').set('CF-Connecting-IP', cf);
  await hit('2001:db8:1:2::1').expect(200);
  await hit('2001:db8:1:2:ffff:ffff:ffff:ffff').expect(200);
  await hit('2001:DB8:1:2:0:0:abcd:1').expect(429);
  // The next /64 is another subscriber; IPv4 (also as IPv4-mapped IPv6) keeps one bucket per address.
  await hit('2001:db8:1:3::1').expect(200);
  await hit('203.0.113.7').expect(200);
  await hit('::ffff:203.0.113.7').expect(200);
  await hit('203.0.113.7').expect(429);
  await hit('203.0.113.8').expect(200);
});

test('the Wi-Fi layer observes the edge client in production even when TRUST_PROXY is false', () => {
  assert.equal(observeNetwork('203.0.113.7', { production: true, trustProxy: false, clientIpHeader: 'cf-connecting-ip' }).status, 'public');
  assert.equal(observeNetwork('203.0.113.7', { production: true, trustProxy: false }).status, 'unconfigured');
  assert.equal(observeNetwork('10.0.0.5', { production: true, trustProxy: 1, clientIpHeader: 'cf-connecting-ip' }).status, 'not-public');
});

test('the startup line names the strategy and nothing else', () => {
  assert.deepEqual(describeClientIpStrategy('cf-connecting-ip', 1, false), { event: 'antara.client-ip', strategy: 'edge-header', header: 'cf-connecting-ip', source: 'render-default', fallback: 'socket' });
  assert.deepEqual(describeClientIpStrategy('cf-connecting-ip', false, true), { event: 'antara.client-ip', strategy: 'edge-header', header: 'cf-connecting-ip', source: 'CLIENT_IP_HEADER', fallback: 'socket' });
  assert.deepEqual(describeClientIpStrategy(null, 2, false), { event: 'antara.client-ip', strategy: 'proxy-hops', hops: 2 });
  assert.deepEqual(describeClientIpStrategy(null, false, false), { event: 'antara.client-ip', strategy: 'socket' });
});
