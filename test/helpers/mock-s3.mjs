import http from 'node:http';
import crypto from 'node:crypto';

const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const rfc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * A tiny S3-compatible server that verifies AWS Signature V4 independently (node:crypto, written
 * from the spec) before storing objects, and serves them back under /public/.
 */
export async function startMockS3({ bucket = 'annotations', accessKeyId = 'AKIATEST', secretAccessKey = 'secret-test-key' } = {}) {
  const objects = new Map();
  const log = [];
  let lifecycle = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname.startsWith('/public/')) {
        const obj = objects.get(decodeURIComponent(url.pathname.slice('/public/'.length)));
        if (!obj) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': obj.contentType, 'Access-Control-Allow-Origin': '*' });
        return res.end(obj.body);
      }

      const auth = req.headers.authorization || '';
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
      const deny = (code, why) => { log.push({ method: req.method, path: url.pathname, denied: why }); res.writeHead(code); res.end(why); };
      if (!m) return deny(403, 'no/invalid Authorization');
      const [, akid, date, region, signedHeaders, signature] = m;
      if (akid !== accessKeyId) return deny(403, 'unknown key');
      const amzDate = req.headers['x-amz-date'];
      if (!amzDate || !amzDate.startsWith(date)) return deny(403, 'bad date');
      if (Math.abs(Date.now() - Date.parse(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))) > 15 * 60 * 1000) return deny(403, 'clock skew');
      const payloadHash = req.headers['x-amz-content-sha256'];
      if (payloadHash !== sha(body)) return deny(400, 'payload hash mismatch');

      const names = signedHeaders.split(';');
      const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
      const query = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${rfc(k)}=${rfc(v)}`).join('&');
      const canonical = [req.method, url.pathname.split('/').map((s) => rfc(decodeURIComponent(s))).join('/'), query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
      const scope = `${date}/${region}/s3/aws4_request`;
      const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
      const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), 's3'), 'aws4_request');
      if (hmac(key, sts).toString('hex') !== signature) return deny(403, 'SignatureDoesNotMatch');

      const rel = url.pathname.replace(/^\/+/, '');
      if (!rel.startsWith(bucket)) return deny(404, 'NoSuchBucket');
      const objectKey = decodeURIComponent(rel.slice(bucket.length).replace(/^\/+/, ''));
      log.push({ method: req.method, path: url.pathname, query: url.search, bytes: body.length });

      if (req.method === 'PUT' && url.searchParams.has('lifecycle')) { lifecycle = body.toString('utf8'); res.writeHead(200); return res.end(); }
      if (req.method === 'PUT' && objectKey) {
        objects.set(objectKey, { body, contentType: req.headers['content-type'] || 'application/octet-stream' });
        res.writeHead(200); return res.end();
      }
      if (req.method === 'GET' && !objectKey) { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end('<ListBucketResult></ListBucketResult>'); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint: base, publicBaseUrl: `${base}/public`, bucket, accessKeyId, secretAccessKey,
    objects, log, getLifecycle: () => lifecycle,
    close: () => new Promise((r) => server.close(r))
  };
}
