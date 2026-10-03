import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const root = new URL('../src/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

function mountPanel() {
  const html = read('sidepanel/sidepanel.html').replace(/<script[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/sidepanel/sidepanel.html?tabId=7', runScripts: 'outside-only' });
  const sent = [];
  let listener = null;
  dom.window.chrome = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      query: async () => [{ id: 7 }],
      onActivated: { addListener() {} },
      sendMessage: async (id, msg) => {
        sent.push({ id, msg });
        if (msg.action === 'GET_RAIL_STATE') return { success: true, state: null };
        return { success: true };
      }
    }
  };
  dom.window.eval(read('sidepanel/sidepanel.js'));
  return { document: dom.window.document, sent, push: (state, tabId = 7) => listener({ action: 'RAIL_STATE', state }, { tab: { id: tabId } }) };
}

const state = {
  active: true,
  isPaused: false,
  counterText: '2 annotations',
  previousScreens: 1,
  annotations: [
    { index: 1, type: 'bug', comment: 'Le bouton ne réagit pas', selector: 'a.btn-cta' },
    { index: 2, type: 'style', comment: '', selector: 'h1' }
  ]
};

test('side panel renders annotations pushed by the content script', async () => {
  const { document, push } = mountPanel();
  push(state);
  const items = document.querySelectorAll('.item');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Bug/);
  assert.match(items[0].textContent, /Le bouton ne réagit pas/);
  assert.match(items[0].textContent, /a\.btn-cta/);
  assert.match(items[1].textContent, /Aucun commentaire/);
  assert.equal(document.getElementById('counter').textContent, '2 annotations');
  assert.match(document.getElementById('list').textContent, /1 écran déjà capturé/);
});

test('side panel ignores state from other tabs and shows idle when inactive', () => {
  const { document, push } = mountPanel();
  push(state, 99);
  assert.equal(document.querySelectorAll('.item').length, 0);
  push({ active: false });
  assert.equal(document.getElementById('status-text').textContent, 'Inactif');
  assert.equal(document.getElementById('btn-export').disabled, true);
});

test('side panel buttons forward actions to the page', async () => {
  const { document, sent, push } = mountPanel();
  push(state);
  document.getElementById('btn-export').click();
  document.getElementById('btn-next').click();
  document.getElementById('btn-pause').click();
  document.getElementById('btn-close').click();
  document.querySelectorAll('.item')[1].click();
  await new Promise(r => setTimeout(r, 0));
  const ops = sent.filter(s => s.msg.action === 'RAIL_ACTION').map(s => s.msg.op + (s.msg.index ? `:${s.msg.index}` : ''));
  assert.deepEqual(ops, ['export', 'next', 'pause', 'close', 'open:2']);
  assert.ok(sent.every(s => s.id === 7));
});

test('manifest declares the sidePanel permission', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.permissions.includes('sidePanel'));
});
