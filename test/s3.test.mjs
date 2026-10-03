import test from 'node:test';
import assert from 'node:assert/strict';
import { signV4, sha256 } from '../src/background/s3.js';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

test('SigV4 reproduces the official AWS documentation example (iam ListUsers)', async () => {
  const emptyHash = hex(await sha256(''));
  assert.equal(emptyHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const out = await signV4({
    method: 'GET',
    path: '/',
    query: { Action: 'ListUsers', Version: '2010-05-08' },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Host: 'iam.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    payloadHash: emptyHash,
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'iam',
    amzDate: '20150830T123600Z'
  });
  assert.equal(hex(await sha256(out.canonicalRequest)), 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
  assert.equal(out.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.match(out.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79/);
});
