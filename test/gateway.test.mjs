import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server/gateway.mjs';
import { makePng } from './helpers/png.mjs';

async function start(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-'));
  let clock = Date.now();
  const gw = createGateway({ dataDir, publicBaseUrl: 'https://cdn.test', now: () => clock, ...opts });
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gw.server.address().port}`;
  return {
    ...gw, base, dataDir, advance: (ms) => { clock += ms; },
    upload: (body, { type = 'image/png', query = '?name=ecran-1', headers = {} } = {}) => fetch(`${base}/v1/upload${query}`, { method: 'POST', headers: { 'Content-Type': type, ...headers }, body }),
    close: () => { gw.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
}

test('gateway: a valid PNG is stored and served back under an unguessable URL with safe headers', async () => {
  const g = await start();
  const png = makePng(8, 8);
  const res = await g.upload(png);
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.match(out.url, /^https:\/\/cdn\.test\/i\/[0-9a-f]{36}\/ecran-1\.png$/);
  assert.equal(out.ttlDays, 7);
  assert.ok(Date.parse(out.expiresAt) > Date.now() + 6 * 24 * 3600 * 1000);

  const img = await fetch(g.base + new URL(out.url).pathname);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /default-src 'none'/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  g.close();
});

test('gateway: not-PNG, truncated, oversized-dimension, wrong content-type and polyglot uploads are refused', async () => {
  const g = await start();
  assert.equal((await g.upload(Buffer.from('<html><script>alert(1)</script></html>'.padEnd(80, ' ')))).status, 400);
  assert.equal((await g.upload(makePng().subarray(0, 40))).status, 400);
  assert.equal((await g.upload(makePng(20000, 4))).status, 400, 'dimensions above the limit');
  const polyglot = Buffer.concat([makePng(), Buffer.from('<script>alert(1)</script>')]);
  assert.equal((await g.upload(polyglot)).status, 400, 'data after IEND');
  assert.equal((await g.upload(makePng(), { type: 'text/html' })).status, 415);
  assert.equal(fs.readdirSync(g.dataDir).length, 0, 'nothing was stored');
  g.close();
});

test('gateway: body size limit is enforced', async () => {
  const g = await start({ maxBytes: 2000 });
  const big = Buffer.concat([makePng(), Buffer.alloc(5000)]);
  const res = await g.upload(big).catch(() => ({ status: 413 }));
  assert.equal(res.status, 413);
  assert.equal(fs.readdirSync(g.dataDir).length, 0);
  g.close();
});

test('gateway: per-IP rate limits (10 minutes and daily) and the global daily byte quota', async () => {
  const g = await start({ ipPer10Min: 3, ipPerDay: 100 });
  for (let i = 0; i < 3; i++) assert.equal((await g.upload(makePng())).status, 201);
  assert.equal((await g.upload(makePng())).status, 429);
  g.advance(11 * 60 * 1000);
  assert.equal((await g.upload(makePng())).status, 201, 'window slides');
  g.close();

  const quota = await start({ dailyBytes: makePng().length * 2 + 10 });
  assert.equal((await quota.upload(makePng())).status, 201);
  assert.equal((await quota.upload(makePng())).status, 201);
  assert.equal((await quota.upload(makePng())).status, 503);
  quota.advance(25 * 3600 * 1000);
  assert.equal((await quota.upload(makePng())).status, 201, 'quota resets after a day');
  quota.close();

  const disk = await start({ diskQuotaBytes: makePng().length + 10 });
  assert.equal((await disk.upload(makePng())).status, 201);
  assert.equal((await disk.upload(makePng())).status, 507, 'storage quota');
  disk.close();
});

test('gateway: X-Forwarded-For is only trusted behind our proxy (last hop), so clients cannot dodge the rate limit', async () => {
  const open = await start({ ipPer10Min: 1 });
  assert.equal((await open.upload(makePng(), { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status, 201);
  assert.equal((await open.upload(makePng(), { headers: { 'X-Forwarded-For': '2.2.2.2' } })).status, 429, 'header ignored without TRUST_PROXY');
  open.close();

  const proxied = await start({ ipPer10Min: 1, trustProxy: true });
  assert.equal((await proxied.upload(makePng(), { headers: { 'X-Forwarded-For': 'spoofed, 9.9.9.9' } })).status, 201);
  assert.equal((await proxied.upload(makePng(), { headers: { 'X-Forwarded-For': 'other-spoof, 9.9.9.9' } })).status, 429, 'same real client (last hop)');
  assert.equal((await proxied.upload(makePng(), { headers: { 'X-Forwarded-For': 'x, 8.8.8.8' } })).status, 201);
  proxied.close();
});

test('gateway: files expire, are swept from disk, and expired links answer 410/404', async () => {
  const g = await start({ ttlDays: 1 });
  const out = await (await g.upload(makePng())).json();
  const pathname = new URL(out.url).pathname;
  assert.equal((await fetch(g.base + pathname)).status, 200);
  g.advance(25 * 3600 * 1000);
  assert.equal((await fetch(g.base + pathname)).status, 410);
  // mtime is real time in the sweep: age the directory on disk too
  const dir = path.join(g.dataDir, fs.readdirSync(g.dataDir)[0]);
  fs.utimesSync(dir, new Date(Date.now() - 3 * 24 * 3600 * 1000), new Date(Date.now() - 3 * 24 * 3600 * 1000));
  g.advance(0);
  assert.equal(g.sweep(), 1);
  assert.equal(fs.readdirSync(g.dataDir).length, 0);
  assert.equal((await fetch(g.base + pathname)).status, 404);
  g.close();
});

test('gateway: no listing, no traversal, no other methods, healthz works', async () => {
  const g = await start();
  const out = await (await g.upload(makePng())).json();
  const token = new URL(out.url).pathname.split('/')[2];
  for (const p of ['/i/', `/i/${token}/`, `/i/${token}`, '/i/../../etc/passwd', `/i/${token}/..%2f..%2fetc%2fpasswd`, `/i/${token}/ecran-1.png/../../x`, '/', '/v1/upload']) {
    const r = await fetch(g.base + p);
    assert.ok([404, 405].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await fetch(g.base + `/i/${token}/ecran-1.png`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(g.base + '/healthz')).status, 200);
  assert.equal((await g.upload(makePng(), { query: '?name=../../evil' })).status, 201, 'a bad name is replaced, not used');
  const names = fs.readdirSync(g.dataDir).flatMap((d) => fs.readdirSync(path.join(g.dataDir, d)));
  assert.ok(names.every((n) => /^[a-z0-9-]+\.png$/.test(n)), names.join());
  g.close();
});
