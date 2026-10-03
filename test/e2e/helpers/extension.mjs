import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createGateway } from '../../../server/gateway.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

export const PAGE_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Page de test</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  #top { position: fixed; top: 0; left: 0; right: 0; height: 56px; background: #123; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; z-index: 5; }
  #profile { padding: 8px 14px; }
  main { padding: 90px 40px 400px; }
  #hero-title { font-size: 44px; margin: 0 0 16px; }
  #cta { padding: 12px 24px; }
  #open-menu { padding: 12px 24px; margin-left: 12px; }
  #ticker { color: #888; font-size: 12px; }
  .panel { display: none; position: absolute; left: 60px; top: 300px; width: 420px; padding: 20px; border: 2px solid #468; background: #eef; }
  .panel.open { display: block; }
  #dialog { position: fixed; left: 200px; top: 120px; width: 520px; height: 360px; background: #fff; border: 2px solid #333; padding: 24px; z-index: 10; }
</style></head>
<body>
  <header id="top"><span id="brand">Brand</span><button id="profile" type="button">Profil</button></header>
  <main id="main">
    <h1 id="hero-title">Titre de la page</h1>
    <p id="lead">Un texte d'introduction pour la page de test.</p>
    <button id="cta" type="button">Commencer</button>
    <button id="open-menu" type="button">Ouvrir les paramètres</button>
    <button id="toggle-p1" type="button">Panneau 1</button><button id="toggle-p2" type="button">Panneau 2</button>
    <span id="ticker" class="ticker-item">tick 0</span>
    <div id="slot"></div>
    <section id="panel1" class="panel"><h3 id="p1-title">Premier panneau</h3><button id="p1-action" type="button">Action 1</button></section>
    <section id="panel2" class="panel"><h3 id="p2-title">Second panneau</h3><button id="p2-action" type="button">Action 2</button></section>
  </main>
<script>
  let n = 0;
  window.__tickerOn = false;
  setInterval(() => { if (!window.__tickerOn) return; n++; const t = document.createElement('span'); t.className = 'ticker-item'; t.textContent = 'tick ' + n; document.getElementById('slot').appendChild(t); if (n % 3 === 0) { for (let i = 0; i < 4; i++) { const x = document.createElement('span'); x.className = 'ticker-item'; x.textContent = 'x'; document.getElementById('slot').appendChild(x); } } }, 120);
  for (const n of [1, 2]) document.getElementById('toggle-p' + n).addEventListener('click', () => { for (const m of [1, 2]) document.getElementById('panel' + m).classList.toggle('open', m === n); });
  document.getElementById('open-menu').addEventListener('click', () => {
    const d = document.createElement('div'); d.id = 'dialog'; d.setAttribute('role', 'dialog');
    d.innerHTML = '<h2>Paramètres</h2><button id="close-dialog" type="button">Fermer</button><label>Nom <input id="name"></label><button id="save-settings" type="button">Enregistrer</button>';
    document.body.appendChild(d);
    d.querySelector('#close-dialog').addEventListener('click', () => d.remove());
  });
</script>
</body></html>`;

/** Boots Chromium with the built extension (<all_urls> added: in production captureVisibleTab is covered by activeTab, granted by the icon click) and a local web server. */
export async function startExtension() {
  execSync('node scripts/build.mjs', { cwd: root, stdio: 'ignore' });
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-annotator-ext-'));
  fs.cpSync(path.join(root, 'dist'), extDir, { recursive: true });
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), '<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  // The bundled hosting points to our server; tests run against a real gateway instance on localhost.
  const gatewayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-annotator-gateway-'));
  const gateway = createGateway({ dataDir: gatewayDir, ipPer10Min: 1000, ipPerDay: 10000 });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const gatewayUrl = `http://127.0.0.1:${gateway.server.address().port}`;
  gateway.cfg.publicBaseUrl = gatewayUrl;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-annotator-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox']
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Record what the extension asks Chrome to do with the side panel and downloads.
  await sw.evaluate((u) => chrome.storage.local.set({ gateway_url: u }), gatewayUrl);
  await sw.evaluate(() => {
    globalThis.__sidePanel = { open: [], setOptions: [] };
    const sp = chrome.sidePanel;
    const open = sp.open.bind(sp);
    const setOptions = sp.setOptions.bind(sp);
    sp.open = async (o) => { globalThis.__sidePanel.open.push(o); try { return await open(o); } catch (_) {} };
    sp.setOptions = async (o) => { globalThis.__sidePanel.setOptions.push(o); return setOptions(o); };
    globalThis.__downloads = [];
    const dl = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = async (o) => { globalThis.__downloads.push({ filename: o.filename, urlStart: String(o.url).slice(0, 40), urlLength: String(o.url).length }); return dl(o); };
  });

  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });

  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0].id, url);

  /** Same injection the icon click performs in the service worker (scripts + TOGGLE_ANNOTATOR). */
  async function injectAndToggle() {
    await sw.evaluate(async (id) => {
      await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['content/styles.css'] });
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/selector-generator.js', 'content/dom-freeze.js', 'content/ui-manager.js', 'content/content-script.js'] });
      await chrome.tabs.sendMessage(id, { action: 'TOGGLE_ANNOTATOR' });
    }, tabId);
  }

  /** Opens the side panel page in its own window (a stand-in for Chrome's side panel) bound to the test tab. */
  async function openPanel() {
    const panelUrl = `chrome-extension://${extId}/sidepanel/sidepanel.html?tabId=${tabId}`;
    const waiter = ctx.waitForEvent('page', { timeout: 10000 });
    await sw.evaluate((u) => chrome.windows.create({ url: u, type: 'popup', width: 420, height: 800 }), panelUrl);
    const panel = await waiter;
    await panel.waitForLoadState('domcontentloaded');
    return panel;
  }

  const storedSession = () => sw.evaluate(async () => (await chrome.storage.local.get(['ai_web_annotator_session'])).ai_web_annotator_session);
  const swState = () => sw.evaluate(() => ({ sidePanel: globalThis.__sidePanel, downloads: globalThis.__downloads }));

  async function close() {
    await ctx.close().catch(() => {});
    await new Promise((r) => server.close(r));
    gateway.server.close();
    fs.rmSync(gatewayDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }

  return { ctx, sw, extId, page, url, tabId, gateway, gatewayUrl, gatewayDir, injectAndToggle, openPanel, swState, storedSession, close };
}
