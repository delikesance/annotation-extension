import test from 'node:test';
import assert from 'node:assert/strict';

function mockChrome() {
  const calls = { setOptions: [], open: [], tabsSend: [], inject: [] };
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  global.chrome = {
    runtime: { getManifest: () => ({ version: '1.0.0' }), getURL: (p) => p, onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message') },
    action: { onClicked: ev('clicked') },
    tabs: { onUpdated: ev('updated'), sendMessage: async (id, msg) => { calls.tabsSend.push({ id, msg }); return { success: true }; } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    alarms: { create() {}, onAlarm: ev('alarm') },
    scripting: { insertCSS: async () => {}, executeScript: async (o) => { calls.inject.push(o); } },
    sidePanel: {
      setOptions: async (o) => { calls.setOptions.push(o); },
      open: async (o) => { calls.open.push(o); }
    }
  };
  return { calls, listeners };
}

const { calls, listeners } = mockChrome();
await import('../src/background/service-worker.js?sw-test');

const message = (msg, sender) => new Promise((resolve) => {
  const async_ = listeners.message(msg, sender, resolve);
  if (async_ !== true) resolve(undefined);
});

test('clicking the extension icon opens the side panel for that tab and toggles the annotator', async () => {
  await listeners.clicked({ id: 5, url: 'https://example.com/' });
  assert.deepEqual(calls.open, [{ tabId: 5 }]);
  assert.deepEqual(calls.setOptions[0], { tabId: 5, path: 'sidepanel/sidepanel.html', enabled: true });
  assert.deepEqual(calls.tabsSend[0], { id: 5, msg: { action: 'TOGGLE_ANNOTATOR' } });
});

test('restricted browser pages are ignored', async () => {
  const before = calls.open.length;
  await listeners.clicked({ id: 6, url: 'chrome://extensions' });
  assert.equal(calls.open.length, before);
});

test('OPEN_SIDE_PANEL from a page opens the panel of the sender tab', async () => {
  const res = await message({ action: 'OPEN_SIDE_PANEL' }, { tab: { id: 9 } });
  assert.deepEqual(res, { success: true });
  assert.deepEqual(calls.open.at(-1), { tabId: 9 });
});

test('OPEN_SIDE_PANEL without a tab, or when the API rejects, reports failure', async () => {
  assert.deepEqual(await message({ action: 'OPEN_SIDE_PANEL' }, {}), { success: false });
  chrome.sidePanel.open = async () => { throw new Error('needs user gesture'); };
  const res = await message({ action: 'OPEN_SIDE_PANEL' }, { tab: { id: 9 } });
  assert.equal(res.success, false);
  assert.match(res.error, /user gesture/);
});

test('ANNOTATOR_STOPPED disables the side panel for that tab', async () => {
  const res = await message({ action: 'ANNOTATOR_STOPPED' }, { tab: { id: 9 } });
  assert.deepEqual(res, { success: true });
  assert.deepEqual(calls.setOptions.at(-1), { tabId: 9, enabled: false });
});

test('unknown actions are not answered (the side panel and page share the message bus)', async () => {
  assert.equal(await message({ action: 'RAIL_STATE', state: {} }, { tab: { id: 1 } }), undefined);
});

test('SESSION_SYNC stores the session with the sender tab id so it can be restored after a navigation; stopping clears it', async () => {
  const stored = {};
  chrome.storage.local.set = async (o) => Object.assign(stored, o);
  chrome.storage.local.remove = async (keys) => keys.forEach((k) => delete stored[k]);
  const res = await message({ action: 'SESSION_SYNC', session: { id: 's1', isActive: true, pages: [] } }, { tab: { id: 12 } });
  assert.deepEqual(res, { success: true });
  assert.deepEqual(stored.ai_web_annotator_session, { id: 's1', isActive: true, pages: [], activeTabId: 12 });
  assert.deepEqual(await message({ action: 'SESSION_SYNC', session: {} }, {}), { success: false });

  await message({ action: 'ANNOTATOR_STOPPED' }, { tab: { id: 12 } });
  assert.equal(stored.ai_web_annotator_session, undefined);
});

test('after a navigation the background re-injects the annotator and restores the session of that tab', async () => {
  chrome.storage.local.get = async () => ({ ai_web_annotator_session: { isActive: true, activeTabId: 31, pages: [{ stepIndex: 1 }] } });
  const before = calls.inject.length;
  await listeners.updated(31, { status: 'complete' }, { url: 'https://example.com/next' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(calls.inject.length > before, 'scripts are injected again');
  const restore = calls.tabsSend.filter(c => c.msg.action === 'RESTORE_SESSION').at(-1);
  assert.equal(restore.id, 31);
  assert.equal(restore.msg.session.pages.length, 1);

  const n = calls.tabsSend.length;
  await listeners.updated(32, { status: 'complete' }, { url: 'https://example.com/other' });
  assert.equal(calls.tabsSend.length, n, 'other tabs are left alone');
});

import { startMockS3 } from './helpers/mock-s3.mjs';

test('image hosting: setup verifies credentials, sets expiry and saves; upload returns unguessable public URLs', async () => {
  const s3 = await startMockS3();
  const stored = {};
  chrome.storage.local.get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in stored).map((k) => [k, stored[k]]));
  chrome.storage.local.set = async (o) => Object.assign(stored, o);
  chrome.storage.local.remove = async (keys) => keys.forEach((k) => delete stored[k]);

  assert.deepEqual(await message({ action: 'HOSTING_STATUS' }, {}), { configured: false, expireDays: null });
  const bad = await message({ action: 'HOSTING_SETUP', config: { endpoint: s3.endpoint, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: 'wrong', publicBaseUrl: s3.publicBaseUrl } }, {});
  assert.equal(bad.success, false);
  assert.match(bad.error, /403/);
  assert.equal((await message({ action: 'HOSTING_SETUP', config: { endpoint: 'nope' } }, {})).success, false);

  const config = { endpoint: s3.endpoint, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, publicBaseUrl: s3.publicBaseUrl + '/', expireDays: '3' };
  assert.deepEqual(await message({ action: 'HOSTING_SETUP', config }, {}), { success: true, expirationWarning: null });
  assert.match(s3.getLifecycle(), /<Days>3<\/Days>/);
  assert.match(s3.getLifecycle(), /<Prefix>annotations\/<\/Prefix>/);
  assert.deepEqual(await message({ action: 'HOSTING_STATUS' }, {}), { configured: true, expireDays: 3 });

  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');
  const up = await message({ action: 'HOSTING_UPLOAD', pages: [{ stepIndex: 1, dataUrl: png }, { stepIndex: 2, dataUrl: png }] }, {});
  assert.equal(up.success, true);
  const [u1, u2] = [up.urls[1], up.urls[2]];
  assert.match(u1, new RegExp(`^${s3.publicBaseUrl}/annotations/[0-9a-f]{36}/ecran-1\\.png$`));
  assert.notEqual(u1.split('/')[5], u2.split('/')[5], 'each upload gets its own random folder');
  const fetched = await fetch(u1);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await fetched.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

  await message({ action: 'HOSTING_CLEAR' }, {});
  assert.equal((await message({ action: 'HOSTING_UPLOAD', pages: [] }, {})).success, false);
  await s3.close();
});

test('image hosting: a failing bucket reports the error instead of throwing', async () => {
  const s3 = await startMockS3();
  const stored = { image_hosting: { endpoint: s3.endpoint, bucket: 'other-bucket', accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, publicBaseUrl: s3.publicBaseUrl } };
  chrome.storage.local.get = async () => ({ ...stored });
  const res = await message({ action: 'HOSTING_UPLOAD', pages: [{ stepIndex: 1, dataUrl: 'data:image/png;base64,AAAA' }] }, {});
  assert.equal(res.success, false);
  assert.match(res.error, /404/);
  await s3.close();
});
