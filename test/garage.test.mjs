import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { checkAccess, setExpiration, uploadPng, signedFetch } from '../src/background/s3.js';

/**
 * Integration with a REAL self-hosted S3 server: Garage (https://garagehq.deuxfleurs.fr), run in a throwaway
 * container. Skipped when docker or the image is not available.
 */
const IMAGE = 'dxflrs/garage:v1.0.1';
const NAME = `annotator-garage-test-${process.pid}`;
const sh = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
let skip = false;
try { sh(['image', 'inspect', IMAGE]); } catch (_) { skip = 'docker or the garage image is not available'; }

let cfg;
let webPort;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-'));

before(async () => {
  if (skip) return;
  fs.writeFileSync(path.join(dir, 'garage.toml'), `
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_secret = "${'ab'.repeat(32)}"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"
[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.garage.localhost"
index = "index.html"
[admin]
api_bind_addr = "[::]:3903"
admin_token = "admin-token"
`);
  sh(['run', '-d', '--name', NAME, '-p', '127.0.0.1::3900', '-p', '127.0.0.1::3902', '-v', `${path.join(dir, 'garage.toml')}:/etc/garage.toml`, IMAGE]);
  const g = (...a) => sh(['exec', NAME, '/garage', ...a]);
  for (let i = 0; i < 40; i++) { try { g('status'); break; } catch (_) { await new Promise((r) => setTimeout(r, 500)); } }
  const nodeId = /^([0-9a-f]{16})/m.exec(g('status').split('HEALTHY NODES')[1] || g('status'))?.[1] || g('node', 'id', '-q').trim().split('@')[0].slice(0, 16);
  g('layout', 'assign', '-z', 'dc1', '-c', '1G', nodeId);
  g('layout', 'apply', '--version', '1');
  g('bucket', 'create', 'annotations');
  const keyOut = g('key', 'create', 'annotator');
  const accessKeyId = /Key ID:\s+(\S+)/.exec(keyOut)[1];
  const secretAccessKey = /Secret key:\s+(\S+)/.exec(keyOut)[1];
  g('bucket', 'allow', '--read', '--write', '--owner', 'annotations', '--key', 'annotator');
  g('bucket', 'website', '--allow', 'annotations');
  const port = (container) => sh(['port', NAME, container]).trim().split('\n')[0].split(':').pop();
  const s3Port = port('3900/tcp');
  webPort = port('3902/tcp');
  cfg = { endpoint: `http://127.0.0.1:${s3Port}`, bucket: 'annotations', accessKeyId, secretAccessKey, region: 'garage', prefix: 'annotations', publicBaseUrl: 'http://annotations.web.garage.localhost' };
  // wait for the s3 api to answer signed requests
  for (let i = 0; i < 40; i++) { try { await checkAccess(cfg); break; } catch (_) { await new Promise((r) => setTimeout(r, 500)); } }
});

after(() => {
  if (skip) return;
  try { sh(['rm', '-f', NAME]); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
});

const getPublic = (key) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: webPort, path: '/' + key, headers: { Host: 'annotations.web.garage.localhost' } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

test('Garage: signed requests are accepted, wrong secret is rejected', { skip }, async () => {
  await checkAccess(cfg);
  await assert.rejects(() => checkAccess({ ...cfg, secretAccessKey: 'f'.repeat(64) }), /HTTP 403/);
});

test('Garage: a screenshot uploaded with uploadPng is served publicly under an unguessable URL', { skip }, async () => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000, 7)]);
  const url = await uploadPng(cfg, 'data:image/png;base64,' + bytes.toString('base64'), 'ecran-1');
  assert.match(url, /^http:\/\/annotations\.web\.garage\.localhost\/annotations\/[0-9a-f]{36}\/ecran-1\.png$/);
  const served = await getPublic(url.replace('http://annotations.web.garage.localhost/', ''));
  assert.equal(served.status, 200);
  assert.deepEqual(served.body, bytes);
  assert.equal(served.type, 'image/png');
  const missing = await getPublic('annotations/deadbeef/ecran-1.png');
  assert.equal(missing.status, 404, 'a guessed URL does not exist');
});

test('Garage: the expiration rule is accepted (or reported as unsupported by the server)', { skip }, async (tc) => {
  try {
    await setExpiration(cfg, 7);
    const res = await signedFetch(cfg, { method: 'GET', query: { lifecycle: '' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<Days>7<\/Days>/);
    tc.diagnostic('expiration rule stored by Garage');
  } catch (e) {
    tc.diagnostic(`expiration not supported by this server: ${e.message}`);
    assert.match(e.message, /HTTP 501|HTTP 400|HTTP 405/, `unexpected failure: ${e.message}`);
  }
});
