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
