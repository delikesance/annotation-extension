#!/usr/bin/env node
/**
 * Screenshot gateway: anonymous, size/rate/quota-limited PNG hosting with automatic expiry.
 * No secret ever ships in the extension: this server holds the storage and enforces the limits.
 *
 *   POST /v1/upload?name=ecran-1   body = PNG bytes (Content-Type: image/png)
 *        -> 201 { url, expiresAt, ttlDays }
 *   GET  /i/<token>/<name>.png      -> the image (unguessable token, nosniff, sandboxed)
 *   GET  /healthz
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DAY = 24 * 3600 * 1000;

export function createGateway(opts = {}) {
  const cfg = {
    dataDir: opts.dataDir || process.env.DATA_DIR || './data',
    publicBaseUrl: (opts.publicBaseUrl || process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:4180').replace(/\/+$/, ''),
    ttlDays: Number(opts.ttlDays ?? process.env.TTL_DAYS ?? 7),
    maxBytes: Number(opts.maxBytes ?? process.env.MAX_BYTES ?? 8 * 1024 * 1024),
    maxDimension: Number(opts.maxDimension ?? process.env.MAX_DIMENSION ?? 16384),
    ipPer10Min: Number(opts.ipPer10Min ?? process.env.IP_PER_10MIN ?? 40),
    ipPerDay: Number(opts.ipPerDay ?? process.env.IP_PER_DAY ?? 400),
    dailyBytes: Number(opts.dailyBytes ?? process.env.DAILY_BYTES ?? 3 * 1024 ** 3),
    diskQuotaBytes: Number(opts.diskQuotaBytes ?? process.env.DISK_QUOTA_BYTES ?? 8 * 1024 ** 3),
    trustProxy: ['1', 'true'].includes(String(opts.trustProxy ?? process.env.TRUST_PROXY ?? '0')),
    now: opts.now || (() => Date.now())
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const hits = new Map(); // ip -> [timestamps]
  let dayStart = cfg.now();
  let dayBytes = 0;

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { ...securityHeaders, ...headers });
    res.end(body);
  };
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); // the hop added by our own proxy
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function rateLimited(ip) {
    const t = cfg.now();
    const list = (hits.get(ip) || []).filter((x) => t - x < DAY);
    const recent = list.filter((x) => t - x < 10 * 60 * 1000).length;
    if (recent >= cfg.ipPer10Min || list.length >= cfg.ipPerDay) { hits.set(ip, list); return true; }
    list.push(t);
    hits.set(ip, list);
    return false;
  }

  function diskUsage() {
    let total = 0;
    for (const d of fs.readdirSync(cfg.dataDir)) {
      const dir = path.join(cfg.dataDir, d);
      try { for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size; } catch (_) {}
    }
    return total;
  }

  /** PNG signature, a sane IHDR and a closing IEND chunk: rejects HTML/SVG/polyglots disguised as images. */
  function validatePng(buf) {
    if (buf.length < 45) return 'trop petit';
    if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'pas un PNG';
    if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return 'en-tête PNG invalide';
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (!w || !h || w > cfg.maxDimension || h > cfg.maxDimension) return 'dimensions refusées';
    if (!buf.subarray(buf.length - 12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) return 'PNG tronqué';
    return null;
  }

  function readBody(req, res) {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > cfg.maxBytes) { json(res, 413, { error: 'Fichier trop volumineux' }); req.destroy(); return resolve(null); }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > cfg.maxBytes) { json(res, 413, { error: 'Fichier trop volumineux' }); req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(null));
    });
  }

  async function handleUpload(req, res, url) {
    if (req.headers['content-type'] !== 'image/png') return json(res, 415, { error: 'Content-Type image/png requis' });
    const ip = clientIp(req);
    if (rateLimited(ip)) return json(res, 429, { error: 'Trop de requêtes, réessayez plus tard' });
    if (cfg.now() - dayStart > DAY) { dayStart = cfg.now(); dayBytes = 0; }

    const body = await readBody(req, res);
    if (!body) return;
    const invalid = validatePng(body);
    if (invalid) return json(res, 400, { error: `Image refusée : ${invalid}` });
    if (dayBytes + body.length > cfg.dailyBytes) return json(res, 503, { error: 'Quota journalier atteint' });
    if (diskUsage() + body.length > cfg.diskQuotaBytes) return json(res, 507, { error: 'Stockage plein' });

    const name = (/^[a-z0-9-]{1,40}$/.test(url.searchParams.get('name') || '') ? url.searchParams.get('name') : 'capture') + '.png';
    const token = crypto.randomBytes(18).toString('hex');
    const dir = path.join(cfg.dataDir, token);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, name), body, { flag: 'wx' });
    dayBytes += body.length;
    json(res, 201, {
      url: `${cfg.publicBaseUrl}/i/${token}/${name}`,
      expiresAt: new Date(cfg.now() + cfg.ttlDays * DAY).toISOString(),
      ttlDays: cfg.ttlDays
    });
  }

  function handleImage(req, res, url) {
    const m = /^\/i\/([0-9a-f]{36})\/([a-z0-9-]{1,40}\.png)$/.exec(url.pathname);
    if (!m) return send(res, 404, 'not found');
    const file = path.join(cfg.dataDir, m[1], m[2]);
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return send(res, 404, 'not found'); }
    if (cfg.now() - stat.mtimeMs > cfg.ttlDays * DAY) return send(res, 410, 'expired');
    res.writeHead(200, { ...securityHeaders, 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  /** Deletes everything older than the TTL. */
  function sweep() {
    let removed = 0;
    for (const d of fs.readdirSync(cfg.dataDir)) {
      const dir = path.join(cfg.dataDir, d);
      try {
        const age = cfg.now() - fs.statSync(dir).mtimeMs;
        if (age > cfg.ttlDays * DAY) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
      } catch (_) {}
    }
    for (const [ip, list] of hits) if (!list.some((x) => cfg.now() - x < DAY)) hits.delete(ip);
    return removed;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://gateway');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/v1/upload') return await handleUpload(req, res, url);
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/i/')) return handleImage(req, res, url);
      return send(res, 404, 'not found');
    } catch (e) {
      console.error('gateway error', e);
      if (!res.headersSent) send(res, 500, 'error');
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;

  return { server, sweep, cfg };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, sweep, cfg } = createGateway();
  const port = Number(process.env.PORT || 4180);
  setInterval(sweep, 10 * 60 * 1000).unref();
  sweep();
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`gateway on :${port}, public ${cfg.publicBaseUrl}, ttl ${cfg.ttlDays}d`));
}
