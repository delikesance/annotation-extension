/**
 * Minimal S3-compatible client (AWS Signature V4) for uploading screenshots to a bucket such as
 * Cloudflare R2. Runs in the service worker with WebCrypto; credentials come from chrome.storage.
 */

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

export async function sha256(data) {
  return crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data);
}

const encodeRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Signs a request. `headers` must include `host`. Returns { authorization, signedHeaders, canonicalRequest, stringToSign, signature }.
 * `amzDate` is ISO basic format (YYYYMMDDTHHMMSSZ).
 */
export async function signV4({ method, path, query = {}, headers, payloadHash, accessKeyId, secretAccessKey, region, service, amzDate }) {
  const date = amzDate.slice(0, 8);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query).sort().map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k])}`).join('&');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await sha256(canonicalRequest))].join('\n');
  const kDate = await hmac('AWS4' + secretAccessKey, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders, canonicalRequest, stringToSign, signature
  };
}

const amzNow = (now = new Date()) => now.toISOString().replace(/[:-]|\.\d{3}/g, '');

function bucketUrl(cfg, key, query) {
  const base = cfg.endpoint.replace(/\/+$/, '');
  const url = new URL(`${base}/${encodeURIComponent(cfg.bucket)}${key ? '/' + key.split('/').map(encodeRfc3986).join('/') : ''}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  return url;
}

export async function signedFetch(cfg, { method, key, query, body, contentType, extraHeaders }) {
  const url = bucketUrl(cfg, key, query);
  const payload = body ? (typeof body === 'string' ? enc.encode(body) : body) : new Uint8Array(0);
  const payloadHash = hex(await sha256(payload));
  const amzDate = amzNow();
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(extraHeaders || {}) };
  const q = Object.fromEntries(url.searchParams.entries());
  const signed = await signV4({ method, path: url.pathname, query: q, headers, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region || 'us-east-1', service: 's3', amzDate });
  const { host: _h, ...sendHeaders } = headers;
  return fetch(url.toString(), {
    method,
    headers: { ...sendHeaders, ...(contentType ? { 'Content-Type': contentType } : {}), Authorization: signed.authorization },
    body: body ? payload : undefined
  });
}

export function randomToken(bytes = 18) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uploads one PNG under an unguessable key and returns its public URL. */
export async function uploadPng(cfg, dataUrl, name) {
  const key = `${cfg.prefix || 'annotations'}/${randomToken()}/${name}.png`;
  const res = await signedFetch(cfg, { method: 'PUT', key, body: dataUrlToBytes(dataUrl), contentType: 'image/png', extraHeaders: { 'cache-control': 'public, max-age=31536000, immutable' } });
  if (!res.ok) throw new Error(`Upload refusé (HTTP ${res.status})`);
  return `${cfg.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
}

/** Makes objects under the prefix expire after `days` days (S3 lifecycle rule). */
export async function setExpiration(cfg, days) {
  const prefix = `${cfg.prefix || 'annotations'}/`;
  const xml = `<LifecycleConfiguration><Rule><ID>ai-web-annotator-expire</ID><Status>Enabled</Status><Filter><Prefix>${prefix}</Prefix></Filter><Expiration><Days>${days}</Days></Expiration></Rule></LifecycleConfiguration>`;
  const bytes = enc.encode(xml);
  const res = await signedFetch(cfg, {
    method: 'PUT', query: { lifecycle: '' }, body: bytes, contentType: 'application/xml',
    extraHeaders: { 'x-amz-checksum-sha256': b64(await sha256(bytes)), 'x-amz-sdk-checksum-algorithm': 'SHA256' }
  });
  if (!res.ok) throw new Error(`Expiration non configurée (HTTP ${res.status})`);
}

/** Verifies credentials by listing the bucket (max 1 key). */
export async function checkAccess(cfg) {
  const res = await signedFetch(cfg, { method: 'GET', query: { 'list-type': '2', 'max-keys': '1' } });
  if (!res.ok) throw new Error(`Accès refusé (HTTP ${res.status})`);
}
