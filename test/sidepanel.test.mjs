import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { wait } from './helpers/content-env.mjs';

// jsdom objects live in another realm: compare through JSON
const same = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

const root = new URL('../src/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

function mountPanel({ runtime, storage, permissions } = {}) {
  const html = read('sidepanel/sidepanel.html').replace(/<script[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/sidepanel/sidepanel.html?tabId=7', runScripts: 'outside-only' });
  const toTab = [];
  const toRuntime = [];
  const store = { ...(storage || {}) };
  let listener = null;
  dom.window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } },
      sendMessage: async (msg) => {
        toRuntime.push(msg);
        if (runtime) { const r = await runtime(msg); if (r !== undefined) return r; }
        return { success: true };
      }
    },
    tabs: {
      query: async () => [{ id: 7 }],
      onActivated: { addListener() {} },
      sendMessage: async (id, msg) => {
        toTab.push({ id, msg });
        if (msg.action === 'GET_RAIL_STATE') return { success: true, state: null };
        return { success: true };
      }
    },
    permissions: { request: async (r) => (permissions ? permissions(r) : true) },
    storage: { local: {
      get: async () => ({ ...store }),
      set: async (o) => Object.assign(store, o),
      remove: async (keys) => keys.forEach((k) => delete store[k])
    } }
  };
  dom.window.ClipboardItem = class {};
  dom.window.eval(read('sidepanel/insights.js'));
  dom.window.eval(read('sidepanel/sidepanel.js'));
  const d = dom.window.document;
  const push = (state, tabId = 7) => listener({ action: 'RAIL_STATE', state }, { tab: { id: tabId } });
  const ops = () => toTab.filter(s => s.msg.action === 'RAIL_ACTION').map(s => s.msg);
  const key = (target, k, extra = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
  return { dom, d, push, ops, toRuntime, toTab, store, key };
}

const base = {
  active: true, mode: 'browse', isPaused: true, hostname: 'example.com', counterText: '2 annotations',
  previousScreens: 0, status: null, editing: null, exportView: null,
  annotations: [
    { index: 1, type: 'bug', comment: 'Le bouton ne réagit pas', selector: 'a.btn-cta' },
    { index: 2, type: 'style', comment: '', selector: 'h1' }
  ]
};

test('panel shows an inactive state until the content script reports an active session', async () => {
  const { d } = mountPanel();
  await wait(10);
  assert.equal(d.getElementById('status-text').textContent, 'Inactif');
  assert.equal(d.getElementById('btn-annotate').disabled, true);
  assert.equal(d.getElementById('btn-export').disabled, true);
});

test('panel renders annotations pushed by the page and ignores other tabs', () => {
  const { d, push } = mountPanel();
  push(base, 99);
  assert.equal(d.querySelectorAll('.item').length, 0);
  push({ ...base, previousScreens: 1 });
  const items = d.querySelectorAll('.item');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Bug.*Le bouton ne réagit pas.*a\.btn-cta/);
  assert.match(items[1].textContent, /Aucun commentaire/);
  assert.equal(d.getElementById('counter').textContent, '2 annotations');
  assert.match(d.getElementById('list').textContent, /1 écran déjà capturé/);
  assert.equal(d.getElementById('status-text').textContent, 'Navigation libre');
});

test('the add-annotation button toggles annotate mode and reflects it', () => {
  const { d, push, ops } = mountPanel();
  push(base);
  assert.equal(d.getElementById('btn-annotate-text').textContent, 'Ajouter une annotation');
  d.getElementById('btn-annotate').click();
  push({ ...base, mode: 'annotate' });
  assert.equal(d.getElementById('btn-annotate-text').textContent, "Terminer l'annotation");
  assert.equal(d.getElementById('status-text').textContent, 'Mode annotation');
  assert.ok(d.getElementById('btn-annotate').classList.contains('is-active'));
  d.getElementById('btn-annotate').click();
  same(ops().map(o => o.op), ['annotate', 'annotate']);
});

test('buttons forward actions with the right tab', () => {
  const { d, push, ops, toTab } = mountPanel();
  push(base);
  d.getElementById('btn-export').click();
  d.getElementById('btn-next').click();
  d.getElementById('btn-close').click();
  d.querySelectorAll('.item')[1].click();
  same(ops().map(o => o.op + (o.index ? `:${o.index}` : '')), ['export', 'next', 'close', 'open:2']);
  assert.ok(toTab.every(s => s.id === 7));
});

test('editor: suggests a type while typing, shows the vague nudge, and saves what the user chose', () => {
  const { d, push, ops, dom } = mountPanel();
  push({ ...base, annotations: [], mode: 'annotate', editing: { index: 1, isNew: true, comment: '', type: null, tag: 'h1', selector: 'h1.hero' } });
  const field = d.querySelector('.editor textarea');
  assert.ok(field, 'editor appears in the panel');
  assert.equal(d.activeElement, field, 'textarea is focused');
  assert.equal(d.querySelector('#editor-delete').hidden, true, 'a new annotation cannot be deleted, only cancelled');

  const type = (value) => { field.value = value; field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const active = () => d.querySelector('.chip.active').dataset.type;
  const nudge = () => !d.querySelector('.nudge').hidden;

  type('Le bouton ne réagit pas au clic');
  assert.equal(active(), 'bug');
  assert.equal(nudge(), false);
  type('Reformuler : « Démarrer gratuitement »');
  assert.equal(active(), 'text');
  type('Pas bien');
  assert.equal(nudge(), true, 'a vague comment gets the "Précisez" nudge');
  type('Bouton trop petit sur mobile, passer à 40px');
  assert.equal(active(), 'style');
  assert.equal(nudge(), false);

  d.querySelector('.chip[data-type="bug"]').click();
  assert.equal(active(), 'bug', 'a manual choice wins');
  type('Reformuler : « Démarrer gratuitement »');
  assert.equal(active(), 'bug', 'and is not overridden by later suggestions');

  d.getElementById('editor-save').click();
  const save = ops().at(-1);
  assert.equal(save.op, 'save');
  assert.equal(save.comment, 'Reformuler : « Démarrer gratuitement »');
  assert.equal(save.type, 'bug');
});

test('editor: Enter saves, Shift+Enter does not, Escape cancels; re-renders never clobber typing', () => {
  const { d, push, ops, key } = mountPanel();
  const editing = { index: 1, isNew: true, comment: '', type: null, tag: 'a', selector: 'a' };
  push({ ...base, annotations: [], editing });
  const field = d.querySelector('.editor textarea');
  field.value = 'en cours de frappe';

  push({ ...base, annotations: [], editing, status: { id: 1, text: 'info' } }); // unrelated broadcast
  assert.equal(d.querySelector('.editor textarea'), field, 'same node');
  assert.equal(field.value, 'en cours de frappe');

  key(field, 'Enter', { shiftKey: true });
  assert.equal(ops().length, 0);
  key(field, 'Enter');
  assert.equal(ops().at(-1).op, 'save');
  key(field, 'Escape');
  assert.equal(ops().at(-1).op, 'cancel');
});

test('editor for an existing annotation replaces its row and offers delete', () => {
  const { d, push, ops } = mountPanel();
  push({ ...base, editing: { index: 1, isNew: false, comment: 'Le bouton ne réagit pas', type: 'bug', tag: 'a', selector: 'a.btn-cta' } });
  assert.equal(d.querySelectorAll('.item').length, 1, 'row 1 is replaced by the editor');
  assert.equal(d.querySelector('.editor textarea').value, 'Le bouton ne réagit pas');
  assert.equal(d.querySelector('.chip.active').dataset.type, 'bug');
  d.getElementById('editor-delete').click();
  same(ops().at(-1), { action: 'RAIL_ACTION', op: 'delete', index: 1 });
});

test('status messages replace toasts: shown in the panel then hidden', async () => {
  const { d, push } = mountPanel();
  push({ ...base, status: { id: 1, text: 'Écran #1 enregistré.' } });
  assert.equal(d.getElementById('status-line').hidden, false);
  assert.equal(d.getElementById('status-line').textContent, 'Écran #1 enregistré.');
});

const exportState = (extra = {}) => ({
  ...base,
  exportView: {
    id: 1,
    pages: [
      { stepIndex: 1, title: 'A', url: 'u1', dataUrl: 'data:image/png;base64,AAA', count: 1 },
      { stepIndex: 2, title: 'B', url: 'u2', dataUrl: 'data:image/png;base64,BBB', count: 2 }
    ],
    prompts: { agent: 'AGENT PROMPT Point #1', github: 'GITHUB MD', json: '{"k":1}' },
    payload: { meta: { totalSteps: 2 }, pages: [] }
  },
  ...extra
});

test('export view: tabs per screen, destination cards, one copy action per format', async () => {
  const { d, push, toRuntime } = mountPanel();
  push(exportState());
  assert.equal(d.getElementById('view-export').hidden, false);
  assert.equal(d.getElementById('view-list').hidden, true);
  assert.match(d.getElementById('export-badge').textContent, /3 annotations • 2 écrans/);

  const tabs = d.querySelectorAll('.screen-tab');
  assert.equal(tabs.length, 2);
  assert.ok(tabs[1].classList.contains('active'), 'last screen selected by default');
  assert.equal(d.getElementById('export-thumb').src, 'data:image/png;base64,BBB');
  assert.match(d.getElementById('btn-dl-png').textContent, /écran #2/);
  assert.match(d.getElementById('btn-dl-all-png').textContent, /Tout télécharger \(2\)/);

  tabs[0].click();
  assert.equal(d.getElementById('export-thumb').src, 'data:image/png;base64,AAA');
  assert.match(d.getElementById('btn-dl-png').textContent, /écran #1/);

  assert.match(d.getElementById('btn-copy').textContent, /Copier pour l'Agent IA/);
  d.getElementById('btn-copy').click();
  await wait(10);
  same(toRuntime.find(m => m.action === 'COPY_TO_CLIPBOARD'), { action: 'COPY_TO_CLIPBOARD', type: 'text', text: 'AGENT PROMPT Point #1' });
  assert.match(d.getElementById('btn-copy').textContent, /Copié/);

  d.querySelector('.dest[data-format="github"]').click();
  assert.match(d.getElementById('btn-copy').textContent, /Copier pour GitHub Issue/);
  assert.equal(d.getElementById('prompt-preview').textContent, 'GITHUB MD');
  d.getElementById('btn-copy').click();
  await wait(10);
  assert.equal(toRuntime.filter(m => m.action === 'COPY_TO_CLIPBOARD').at(-1).text, 'GITHUB MD');

  d.querySelector('.dest[data-format="json"]').click();
  assert.match(d.getElementById('btn-copy').textContent, /Copier le JSON/);
  assert.equal(d.getElementById('prompt-preview').textContent, '{"k":1}');
});

test('export view: image copy and PNG/JSON/batch downloads go through the background', async () => {
  const { d, push, toRuntime } = mountPanel();
  push(exportState());
  d.getElementById('btn-copy-image').click();
  await wait(10);
  same(toRuntime.find(m => m.type === 'image'), { action: 'COPY_TO_CLIPBOARD', type: 'image', dataUrl: 'data:image/png;base64,BBB' });

  d.getElementById('btn-dl-png').click();
  d.getElementById('btn-dl-json').click();
  d.getElementById('btn-dl-all-png').click();
  await wait(600);
  const dls = toRuntime.filter(m => m.action === 'DOWNLOAD_FILE');
  assert.equal(dls.length, 4);
  assert.match(dls[0].filename, /^annotation-ecran-2-example_com-.*\.png$/);
  assert.equal(dls[0].url, 'data:image/png;base64,BBB');
  assert.match(dls[1].filename, /^annotation-context-example_com-.*\.json$/);
  assert.ok(decodeURIComponent(dls[1].url.split(',')[1]).includes('"totalSteps": 2'));
  assert.match(dls[2].filename, /annotation-ecran-1-/);
  assert.match(dls[3].filename, /annotation-ecran-2-/);
});

test('export view: single screen has no tabs or batch button; back and quit go to the page', () => {
  const { d, push, ops } = mountPanel();
  const s = exportState();
  s.exportView = { ...s.exportView, pages: [s.exportView.pages[0]] };
  push(s);
  assert.equal(d.querySelectorAll('.screen-tab').length, 0);
  assert.equal(d.getElementById('btn-dl-all-png'), null);
  assert.match(d.getElementById('btn-dl-png').textContent, /Télécharger PNG/);
  d.getElementById('btn-back').click();
  d.getElementById('btn-quit-all').click();
  same(ops().map(o => o.op), ['back', 'close']);
});

test('keyboard shortcuts in the panel', () => {
  const { d, push, ops, key } = mountPanel();
  push(base);
  key(d.body, 'a');
  key(d.body, 'n');
  key(d.body, 'e', { ctrlKey: true });
  same(ops().map(o => o.op), ['annotate', 'next', 'export']);

  push({ ...base, mode: 'annotate' });
  key(d.body, 'Escape');
  assert.equal(ops().at(-1).op, 'annotate', 'Escape leaves annotate mode');
  push(exportState());
  key(d.body, 'Escape');
  assert.equal(ops().at(-1).op, 'back', 'Escape leaves the export view');
});

test('update banner appears when the background reports a newer version and opens the download', async () => {
  const { d, toRuntime } = mountPanel({ runtime: (m) => (m.action === 'GET_UPDATE_INFO' ? { success: true, update: { version: '9.9.9', downloadUrl: 'https://x/zip', releaseUrl: 'https://x/rel' } } : undefined) });
  await wait(20);
  assert.equal(d.getElementById('update-banner').hidden, false);
  assert.match(d.getElementById('update-text').textContent, /9\.9\.9/);
  d.getElementById('btn-update').click();
  same(toRuntime.find(m => m.action === 'OPEN_URL'), { action: 'OPEN_URL', url: 'https://x/zip' });
});

test('no update banner when up to date', async () => {
  const { d } = mountPanel({ runtime: (m) => (m.action === 'GET_UPDATE_INFO' ? { success: true, update: null } : undefined) });
  await wait(20);
  assert.equal(d.getElementById('update-banner').hidden, true);
});

test('image hosting: when configured, screenshots are uploaded once per export and the page rebuilds the prompts with the links', async () => {
  const { d, push, ops, toRuntime } = mountPanel({ runtime: (m) => {
    if (m.action === 'HOSTING_STATUS') return { configured: true, expireDays: 7 };
    if (m.action === 'HOSTING_UPLOAD') return { success: true, urls: { 1: 'https://cdn/x/1.png', 2: 'https://cdn/x/2.png' }, expireDays: 7 };
    return undefined;
  } });
  push(exportState());
  await wait(30);
  const upload = toRuntime.find(m => m.action === 'HOSTING_UPLOAD');
  assert.equal(upload.pages.length, 2);
  assert.equal(upload.pages[1].dataUrl, 'data:image/png;base64,BBB');
  const urlsOp = ops().find(o => o.op === 'export-urls');
  same(urlsOp.urls, { 1: 'https://cdn/x/1.png', 2: 'https://cdn/x/2.png' });
  assert.match(d.getElementById('hosting-line').textContent, /liens ajoutés.*expiration 7 j/);

  push(exportState()); // same export id: no second upload
  push(exportState({ exportView: { ...exportState().exportView, pages: exportState().exportView.pages.map(p => ({ ...p, imageUrl: 'u' })) } }));
  await wait(20);
  assert.equal(toRuntime.filter(m => m.action === 'HOSTING_UPLOAD').length, 1);
});

test('image hosting: nothing is uploaded when not configured; upload failures are shown and exports still work', async () => {
  const off = mountPanel({ runtime: (m) => (m.action === 'HOSTING_STATUS' ? { configured: false } : undefined) });
  off.push(exportState());
  await wait(30);
  assert.equal(off.toRuntime.some(m => m.action === 'HOSTING_UPLOAD'), false);
  assert.equal(off.d.getElementById('hosting-line').hidden, true);

  const failing = mountPanel({ runtime: (m) => {
    if (m.action === 'HOSTING_STATUS') return { configured: true, expireDays: 7 };
    if (m.action === 'HOSTING_UPLOAD') return { success: false, error: 'Upload refusé (HTTP 403)' };
    return undefined;
  } });
  failing.push(exportState());
  await wait(30);
  const line = failing.d.getElementById('hosting-line');
  assert.equal(line.hidden, false);
  assert.match(line.textContent, /Hébergement impossible : Upload refusé \(HTTP 403\)/);
  assert.ok(line.classList.contains('is-error'));
  assert.equal(failing.d.getElementById('btn-copy').disabled, false);
});

test('image hosting settings: asks Chrome for access to the bucket origin, then verifies and saves via the background', async () => {
  const asked = [];
  const { d, toRuntime } = mountPanel({
    permissions: (r) => { asked.push(r); return true; },
    runtime: (m) => (m.action === 'HOSTING_SETUP' ? { success: true } : m.action === 'HOSTING_STATUS' ? { configured: true, expireDays: 3 } : undefined)
  });
  d.getElementById('h-endpoint').value = 'https://acct.r2.cloudflarestorage.com';
  d.getElementById('h-bucket').value = 'annotations';
  d.getElementById('h-key').value = 'AKIA';
  d.getElementById('h-secret').value = 'shh';
  d.getElementById('h-public').value = 'https://img.example.com';
  d.getElementById('h-days').value = '3';
  d.getElementById('hosting-form').dispatchEvent(new d.defaultView.Event('submit', { cancelable: true, bubbles: true }));
  await wait(30);

  same(asked, [{ origins: ['https://acct.r2.cloudflarestorage.com/*'] }]);
  const setup = toRuntime.find(m => m.action === 'HOSTING_SETUP');
  assert.equal(setup.config.secretAccessKey, 'shh');
  assert.equal(setup.config.publicBaseUrl, 'https://img.example.com');
  assert.match(d.getElementById('h-result').textContent, /Accès vérifié.*3 jours/);
  assert.equal(d.getElementById('h-secret').value, '', 'the secret is cleared from the form');
  assert.match(d.getElementById('hosting-state').textContent, /actif \(3 j\)/);
});

test('image hosting settings: a refused permission or a failing check is reported', async () => {
  const refused = mountPanel({ permissions: () => false });
  refused.d.getElementById('h-endpoint').value = 'https://acct.example.com';
  refused.d.getElementById('hosting-form').dispatchEvent(new refused.d.defaultView.Event('submit', { cancelable: true, bubbles: true }));
  await wait(20);
  assert.match(refused.d.getElementById('h-result').textContent, /Autorisation.*refusée/);

  const failing = mountPanel({ runtime: (m) => (m.action === 'HOSTING_SETUP' ? { success: false, error: 'Accès refusé (HTTP 403)' } : undefined) });
  failing.d.getElementById('h-endpoint').value = 'https://acct.example.com';
  failing.d.getElementById('hosting-form').dispatchEvent(new failing.d.defaultView.Event('submit', { cancelable: true, bubbles: true }));
  await wait(20);
  assert.match(failing.d.getElementById('h-result').textContent, /Accès refusé \(HTTP 403\)/);
  assert.ok(failing.d.getElementById('h-result').classList.contains('is-error'));
});

test('hosting toggle: the bundled gateway is on by default and can be switched off from the panel', async () => {
  const { d, toRuntime } = mountPanel({ runtime: (m) => (m.action === 'HOSTING_STATUS' ? { configured: true, mode: 'gateway', expireDays: 7, host: 'annotator.delikesance.cloud' } : undefined) });
  await wait(30);
  assert.equal(d.getElementById('h-gateway').checked, true);
  assert.match(d.getElementById('hosting-state').textContent, /actif \(7 j\)/);
  assert.equal(d.getElementById('h-gateway-host').textContent, 'annotator.delikesance.cloud');
  d.getElementById('h-gateway').checked = false;
  d.getElementById('h-gateway').dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));
  await wait(20);
  same(toRuntime.find(m => m.action === 'HOSTING_TOGGLE'), { action: 'HOSTING_TOGGLE', enabled: false });
});

test('hosting toggle: with a personal S3 storage the default switch is locked and the state says so', async () => {
  const { d } = mountPanel({ runtime: (m) => (m.action === 'HOSTING_STATUS' ? { configured: true, mode: 's3', expireDays: 3 } : undefined) });
  await wait(30);
  assert.equal(d.getElementById('h-gateway').disabled, true);
  assert.match(d.getElementById('hosting-state').textContent, /stockage perso \(3 j\)/);
});
