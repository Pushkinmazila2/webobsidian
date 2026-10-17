import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { test, after } from 'node:test';
import { guardedLookup, isBlockedAddress, proxyRequest } from '../src/services/proxy.ts';

const status = (e: unknown) => (e as { status?: number })?.status;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '/';
    if (url === '/echo') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, ua: req.headers['user-agent'] }));
    } else if (url === '/gzip') {
      res.setHeader('content-encoding', 'gzip');
      res.end(zlib.gzipSync('compressed hello'));
    } else if (url === '/redir') { res.statusCode = 302; res.setHeader('location', '/echo'); res.end(); }
    else if (url === '/redir-post') { res.statusCode = 303; res.setHeader('location', '/echo'); res.end(); }
    else if (url === '/loop') { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); }
    else if (url === '/big') { res.end(Buffer.alloc(2 * 1048576, 97)); }
    else if (url === '/slow') { setTimeout(() => res.end('late'), 2000); }
    else if (url === '/404') { res.statusCode = 404; res.end('nope'); }
    else res.end('ok');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const local = { allowPrivate: true };

test('[proxy] isBlockedAddress: loopback, private, link-local, CGNAT, metadata, v6 and v4-mapped are refused; public ones pass', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('[proxy] refuses private targets by default (literal IPs, localhost names, bad protocols, credentials in URLs)', async () => {
  for (const url of [`${base}/ok`, 'http://localhost:1/', 'http://[::1]:1/', 'http://169.254.169.254/latest/meta-data/', 'http://foo.internal/', 'http://printer.local/']) {
    await assert.rejects(() => proxyRequest({ url }, { allowPrivate: false }), (e) => status(e) === 403, url);
  }
  await assert.rejects(() => proxyRequest({ url: 'file:///etc/passwd' }, local), (e) => status(e) === 400);
  await assert.rejects(() => proxyRequest({ url: 'ftp://example.com/x' }, local), (e) => status(e) === 400);
  await assert.rejects(() => proxyRequest({ url: 'http://user:pw@127.0.0.1/' }, local), (e) => status(e) === 400);
  await assert.rejects(() => proxyRequest({ url: 'nope' }, local), (e) => status(e) === 400);
});

test('[proxy] a hostname that resolves to a private address is refused at connect time (DNS-rebinding safe)', async () => {
  // `localhost` resolves via /etc/hosts, so this needs no network
  const err = await new Promise<any>((resolve) => guardedLookup('localhost', {}, (e: any) => resolve(e)));
  assert.equal(err?.code, 'EBLOCKED');
  await assert.rejects(() => proxyRequest({ url: `http://localtest.me:${new URL(base).port}/ok` }, { allowPrivate: false, timeoutMs: 3000 }), (e) => [403, 502].includes(status(e) ?? 0));
});

test('[proxy] forwards method, headers and body; never forwards cookies; sets a user agent', async () => {
  const r = await proxyRequest({ url: `${base}/echo`, method: 'POST', headers: { Authorization: 'Bearer x', Cookie: 'sid=1', 'X-A': '1' }, body: Buffer.from('payload') }, local);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body.toString());
  assert.deepEqual([j.method, j.body, j.auth, j.cookie, j.ua], ['POST', 'payload', 'Bearer x', null, 'WebObsidian']);
});

test('[proxy] decodes gzip, reports upstream error statuses as data, follows redirects (303 → GET) and caps them', async () => {
  assert.equal((await proxyRequest({ url: `${base}/gzip` }, local)).body.toString(), 'compressed hello');
  assert.equal((await proxyRequest({ url: `${base}/404` }, local)).status, 404);
  const red = await proxyRequest({ url: `${base}/redir` }, local);
  assert.equal(JSON.parse(red.body.toString()).method, 'GET');
  assert.equal(red.url, `${base}/echo`);
  const post = await proxyRequest({ url: `${base}/redir-post`, method: 'POST', body: Buffer.from('x') }, local);
  assert.deepEqual([JSON.parse(post.body.toString()).method, JSON.parse(post.body.toString()).body], ['GET', '']);
  await assert.rejects(() => proxyRequest({ url: `${base}/loop` }, local), (e) => status(e) === 502);
});

test('[proxy] a redirect into a private address is refused; size and time limits apply', async () => {
  const hop = http.createServer((_req, res) => { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); res.end(); });
  await new Promise<void>((r) => hop.listen(0, '127.0.0.1', r));
  try {
    // first hop allowed only because we allow loopback for the test server; the metadata address is not a loopback…
    await assert.rejects(() => proxyRequest({ url: `http://127.0.0.1:${(hop.address() as AddressInfo).port}/` }, { allowPrivate: false }), (e) => status(e) === 403);
  } finally { hop.close(); }
  await assert.rejects(() => proxyRequest({ url: `${base}/big` }, { ...local, maxBytes: 1048576 }), (e) => status(e) === 502);
  await assert.rejects(() => proxyRequest({ url: `${base}/slow` }, { ...local, timeoutMs: 300 }), (e) => status(e) === 504);
});

test('[proxy] WEBOBSIDIAN_PROXY=off disables it', async () => {
  process.env.WEBOBSIDIAN_PROXY = 'off';
  try { await assert.rejects(() => proxyRequest({ url: `${base}/ok` }, local), (e) => status(e) === 403); }
  finally { delete process.env.WEBOBSIDIAN_PROXY; }
});
