import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startExtension } from './helpers/extension.mjs';
import { startMockS3 } from '../helpers/mock-s3.mjs';

let env;
let panel;
before(async () => {
  env = await startExtension();
  panel = await env.openPanel();
});
after(async () => { await env.close(); });

const inPage = (fn, arg) => env.page.evaluate(fn, arg);
const overlayCount = () => inPage(() => {
  const root = document.getElementById('ai-web-annotator-root');
  return root && root.shadowRoot ? root.shadowRoot.querySelectorAll('.ai-annotation-badge').length : 0;
});
const panelText = (sel) => panel.locator(sel).innerText();

test('1. real service worker, side panel API and panel page are alive; panel is inactive before activation', async () => {
  assert.match(env.sw.url(), /background\/service-worker\.js$/);
  assert.equal(await env.sw.evaluate(() => typeof chrome.sidePanel.open), 'function');
  assert.equal(await panelText('#status-text'), 'Inactif');
  assert.equal(await panel.locator('#btn-annotate').isDisabled(), true);
});

test('2. activating shows the panel UI, injects nothing visible into the page and leaves the layout untouched', async () => {
  const before = await inPage(() => ({
    hero: document.getElementById('hero-title').getBoundingClientRect().toJSON(),
    cta: document.getElementById('cta').getBoundingClientRect().toJSON(),
    docWidth: document.documentElement.getBoundingClientRect().width
  }));
  await env.injectAndToggle();
  await panel.locator('#status-text', { hasText: 'Navigation libre' }).waitFor();
  assert.equal(await panel.locator('#btn-annotate').isDisabled(), false);

  const after = await inPage(() => ({
    hero: document.getElementById('hero-title').getBoundingClientRect().toJSON(),
    cta: document.getElementById('cta').getBoundingClientRect().toJSON(),
    docWidth: document.documentElement.getBoundingClientRect().width,
    frozen: document.documentElement.classList.contains('ai-annotator-page-frozen'),
    shadowChildren: [...document.getElementById('ai-web-annotator-root').shadowRoot.children].map(e => e.className || e.tagName)
  }));
  assert.deepEqual(after.hero, before.hero, 'page elements do not move');
  assert.deepEqual(after.cta, before.cta);
  assert.equal(after.docWidth, before.docWidth, 'the page keeps its full width');
  assert.equal(after.frozen, false, 'free navigation: page stays interactive');
  assert.ok(after.shadowChildren.every(c => !/hud|toast|comment-card|export|update/.test(c)), `no UI in page: ${after.shadowChildren}`);

  // nothing covers the page: the fixed header's right-hand button is the top element at its position
  const topAtProfile = await inPage(() => {
    const r = document.getElementById('profile').getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).id;
  });
  assert.equal(topAtProfile, 'profile');
});

test('3. in free navigation the page works normally (menus open, buttons click)', async () => {
  await env.page.click('#open-menu');
  await env.page.locator('#dialog').waitFor();
  await env.page.click('#close-dialog');
  await env.page.locator('#dialog').waitFor({ state: 'detached' });
  assert.equal(await overlayCount(), 0);
});

test('4. "Ajouter une annotation" enters annotate mode and several annotations can be placed in a row', async () => {
  await panel.click('#btn-annotate');
  await panel.locator('#status-text', { hasText: 'Mode annotation' }).waitFor();
  assert.equal(await panelText('#btn-annotate-text'), "Terminer l'annotation");
  assert.equal(await inPage(() => document.documentElement.classList.contains('ai-annotator-page-frozen')), true);

  // first annotation
  await env.page.hover('#cta');
  await env.page.click('#cta');
  const editor = panel.locator('.editor textarea');
  await editor.waitFor();
  assert.equal(await panel.evaluate(() => document.activeElement.tagName), 'TEXTAREA', 'the comment field is focused');
  await editor.fill('Le bouton ne réagit pas au clic');
  await panel.locator('.chip.active[data-type="bug"]').waitFor();
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'Le bouton ne réagit pas au clic' }).waitFor();
  assert.equal(await overlayCount(), 1);

  // second one, without re-entering the mode
  await env.page.hover('#hero-title');
  await env.page.click('#hero-title');
  await editor.waitFor();
  await editor.fill('Titre trop petit sur mobile, passer à 40px');
  await panel.locator('.chip.active[data-type="style"]').waitFor();
  assert.equal(await panel.locator('.nudge').isHidden(), true);
  await panel.keyboard.press('Enter');
  await panel.locator('.item', { hasText: 'passer à 40px' }).waitFor();
  assert.equal(await overlayCount(), 2);
  assert.equal(await panelText('#counter'), '2 annotations');

  // the click asked Chrome to open the side panel (a user-gesture request)
  const { sidePanel } = await env.swState();
  assert.ok(sidePanel.open.some(o => o.tabId === env.tabId), 'OPEN_SIDE_PANEL reached chrome.sidePanel.open');
});

test('5. the page click was intercepted (the CTA did nothing) and a vague comment gets the "Précisez" nudge', async () => {
  await env.page.hover('#lead');
  await env.page.click('#lead');
  const editor = panel.locator('.editor textarea');
  await editor.waitFor();
  await editor.fill('Pas bien');
  await panel.locator('.nudge').waitFor({ state: 'visible' });
  await panel.click('#editor-cancel');
  await panel.locator('.editor').waitFor({ state: 'detached' });
  assert.equal(await overlayCount(), 2, 'cancelling a new annotation removes its pin');
});

test('6. editing and deleting an existing annotation from the panel', async () => {
  await panel.locator('.item', { hasText: 'passer à 40px' }).click();
  const editor = panel.locator('.editor textarea');
  await editor.waitFor();
  assert.equal(await editor.inputValue(), 'Titre trop petit sur mobile, passer à 40px');
  await editor.fill('Titre à 40px sur mobile');
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'Titre à 40px sur mobile' }).waitFor();

  await panel.locator('.item', { hasText: 'Titre à 40px' }).click();
  await panel.click('#editor-delete');
  await panel.locator('.item', { hasText: 'Titre à 40px' }).waitFor({ state: 'detached' });
  assert.equal(await overlayCount(), 1);
  assert.equal(await panelText('#counter'), '1 annotation');
});

test('7. ambient DOM noise on the page (ticker) does not create a screen', async () => {
  await panel.click('#btn-annotate'); // leave annotate mode: free navigation
  await panel.locator('#status-text', { hasText: 'Navigation libre' }).waitFor();
  await inPage(() => { window.__tickerOn = true; });
  await env.page.waitForTimeout(2200);
  await inPage(() => { window.__tickerOn = false; });
  assert.equal(await panel.locator('#list .note').count(), 0, 'no "écran déjà capturé" note');
  assert.equal(await overlayCount(), 1, 'the annotation is still on its screen');
});

test('8. opening a dialog on the page starts a new screen automatically, with a real screenshot of the previous one', async () => {
  await env.page.click('#open-menu');
  await env.page.locator('#dialog').waitFor();
  await panel.locator('#list .note', { hasText: '1 écran déjà capturé' }).waitFor({ timeout: 8000 });
  assert.equal(await overlayCount(), 0, 'pins of the previous screen are cleared');
  assert.match(await panelText('#counter'), /Écran #2/);
  assert.match(await panel.locator('#status-line').innerText(), /écran #1 enregistré/i);

  const session = await env.storedSession();
  assert.equal(session.pages.length, 1);
  assert.equal(session.pages[0].annotations[0].comment, 'Le bouton ne réagit pas au clic');
  const shot = session.pages[0].dataUrl;
  assert.ok(shot.startsWith('data:image/png;base64,'));
  assert.ok(shot.length > 3000, `a real screenshot, not the 1x1 placeholder (length ${shot.length})`);
});

test('9. annotating the new screen, then exporting shows both screens with real previews', async () => {
  await panel.click('#btn-annotate');
  await env.page.hover('#save-settings');
  await env.page.click('#save-settings');
  await panel.locator('.editor textarea').fill('Le bouton Enregistrer doit être vert');
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'doit être vert' }).waitFor();

  await panel.click('#btn-export');
  await panel.locator('#view-export').waitFor({ state: 'visible' });
  assert.match(await panelText('#export-badge'), /2 annotations • 2 écrans/);
  assert.equal(await panel.locator('.screen-tab').count(), 2);
  assert.match(await panelText('#btn-dl-png'), /écran #2/);

  const dims = await panel.evaluate(() => { const i = document.getElementById('export-thumb'); return { w: i.naturalWidth, h: i.naturalHeight }; });
  assert.ok(dims.w >= 500 && dims.h >= 300, `preview is a real capture (${dims.w}x${dims.h})`);
  await panel.locator('.screen-tab').first().click();
  assert.match(await panelText('#btn-dl-png'), /écran #1/);
  assert.equal(await panel.evaluate(() => document.getElementById('export-thumb').naturalWidth > 500), true);
});

test('10. copy for the agent puts the full prompt on the real clipboard; GitHub and JSON destinations too', async () => {
  const readClipboard = () => panel.evaluate(() => navigator.clipboard.readText());

  await panel.click('#btn-copy');
  await panel.locator('#btn-copy', { hasText: 'Copié' }).waitFor();
  const agent = await readClipboard();
  for (const needle of ['Étape #1', 'Étape #2', '[Point #1]', '[Point #2]', 'Le bouton ne réagit pas au clic', 'Le bouton Enregistrer doit être vert', 'Type** : Bug', '#cta']) {
    assert.ok(agent.includes(needle), `agent prompt must contain ${needle}`);
  }

  await panel.click('.dest[data-format="github"]');
  assert.match(await panelText('#btn-copy'), /Copier pour GitHub Issue/);
  await panel.click('#btn-copy');
  await panel.locator('#btn-copy', { hasText: 'Copié' }).waitFor();
  assert.match(await readClipboard(), /- \[ \] \*\*\[Point #1\]\*\* \*\*Bug\*\*/);

  await panel.click('.dest[data-format="json"]');
  await panel.click('#btn-copy');
  await panel.locator('#btn-copy', { hasText: 'Copié' }).waitFor();
  const json = JSON.parse(await readClipboard());
  assert.equal(json.meta.totalAnnotations, 2);
  assert.equal(json.pages.length, 2);
  assert.equal(json.pages[0].annotations[0].type, 'bug');
});

test('11. image copy, PNG, batch and JSON downloads are issued through the background', async () => {
  await panel.click('#btn-copy-image');
  await panel.waitForTimeout(500);
  const clip = await panel.evaluate(async () => (await navigator.clipboard.read()).map(i => i.types));
  assert.ok(clip.flat().includes('image/png'), `image on the clipboard: ${JSON.stringify(clip)}`);

  await panel.click('#btn-dl-png');
  await panel.click('#btn-dl-all-png');
  await panel.click('#btn-dl-json');
  await panel.waitForTimeout(1500);
  const { downloads } = await env.swState();
  const names = downloads.map(d => d.filename);
  assert.ok(names.some(n => /^annotation-ecran-1-127_0_0_1-.*\.png$/.test(n)), `single PNG: ${names}`);
  assert.ok(names.filter(n => /^annotation-ecran-\d-/.test(n)).length >= 3, 'single + batch (2) PNGs');
  assert.ok(names.some(n => /^annotation-context-127_0_0_1-.*\.json$/.test(n)), 'JSON');
  assert.ok(downloads.filter(d => d.filename.endsWith('.png')).every(d => d.urlLength > 3000), 'PNG downloads carry the real screenshot');
});

test('12. back returns to the list; quitting clears the page and disables the side panel', async () => {
  await panel.click('#btn-back');
  await panel.locator('#view-list').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#view-export').isHidden(), true);

  await panel.click('#btn-close');
  await panel.locator('#status-text', { hasText: 'Inactif' }).waitFor();
  assert.equal(await overlayCount(), 0);
  assert.equal(await inPage(() => document.documentElement.classList.contains('ai-annotator-page-frozen')), false);
  const { sidePanel } = await env.swState();
  assert.deepEqual(sidePanel.setOptions.at(-1), { tabId: env.tabId, enabled: false });
  assert.equal(await panel.locator('#btn-annotate').isDisabled(), true);
});

test('13. navigating to another page keeps the session: the annotated screen is saved and the annotator restarts on the new page', async () => {
  await env.injectAndToggle(); // start a fresh session after quitting in test 12
  await panel.locator('#status-text', { hasText: 'Navigation libre' }).waitFor();
  await panel.click('#btn-annotate');
  await env.page.hover('#cta');
  await env.page.click('#cta');
  await panel.locator('.editor textarea').fill('Le bouton ne réagit pas au clic');
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'ne réagit pas' }).waitFor();
  await env.page.waitForTimeout(400); // let the screenshot of this screen be taken

  await env.page.goto(env.url + '?page=2', { waitUntil: 'load' });
  await panel.locator('#list .note', { hasText: '1 écran déjà capturé' }).waitFor({ timeout: 10000 });
  assert.match(await panelText('#counter'), /Écran #2/);
  assert.equal(await panel.locator('#status-text').innerText(), 'Mode annotation', 'the mode survives the navigation');

  const session = await env.storedSession();
  assert.equal(session.activeTabId, env.tabId, 'the background knows which tab owns the session');
  assert.equal(session.pages.length, 1);
  assert.equal(session.pages[0].annotations[0].comment, 'Le bouton ne réagit pas au clic');
  assert.ok(session.pages[0].dataUrl.length > 3000, 'the saved screen is a real screenshot');

  // and the new page can be annotated, numbering continues
  await env.page.hover('#lead');
  await env.page.click('#lead');
  await panel.locator('.editor textarea').fill('Reformuler : « Bienvenue »');
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'Bienvenue' }).waitFor();
  assert.equal(await panel.locator('.item .pin').first().innerText(), '2');
  await panel.click('#btn-close');
  await panel.locator('#status-text', { hasText: 'Inactif' }).waitFor();
  assert.equal(await env.storedSession(), undefined, 'quitting clears the stored session');
});

test('14. the exported screenshot actually contains the annotation pins', async () => {
  await env.injectAndToggle();
  await panel.locator('#status-text', { hasText: 'Navigation libre' }).waitFor();
  await panel.click('#btn-annotate');
  await env.page.hover('#cta');
  await env.page.click('#cta');
  await panel.locator('.editor textarea').fill('Le bouton doit être vert');
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'doit être vert' }).waitFor();
  await panel.click('#btn-export');
  await panel.locator('#export-thumb').waitFor();
  await panel.waitForFunction(() => document.getElementById('export-thumb').naturalWidth > 100);

  // count pixels close to the pin/box accent colour (#C9400F) in the preview
  const accentPixels = await panel.evaluate(() => {
    const img = document.getElementById('export-thumb');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - 0xC9) < 12 && Math.abs(data[i + 1] - 0x40) < 12 && Math.abs(data[i + 2] - 0x0F) < 12) n++;
    }
    return n;
  });
  assert.ok(accentPixels > 200, `pins/boxes are drawn in the screenshot (${accentPixels} accent pixels)`);
  await panel.click('#btn-quit-all');
  await panel.locator('#status-text', { hasText: 'Inactif' }).waitFor();
});

test('15. a newer release shows the update banner in the panel and its button opens the download', async () => {
  // The service worker's update check hits the Forgejo API: answer it with a newer release.
  await env.sw.evaluate((base) => {
    globalThis.__realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v99.0.0', name: 'v99', body: 'Notes', html_url: base + 'release',
        assets: [{ name: 'ai-web-annotator-v99.0.0.zip', browser_download_url: base + 'download.zip' }]
      })
    });
    return chrome.storage.local.remove(['available_update']);
  }, env.url);
  const fresh = await env.openPanel();
  await fresh.locator('#update-banner').waitFor({ state: 'visible', timeout: 8000 });
  assert.match(await fresh.locator('#update-text').innerText(), /99\.0\.0/);

  const opened = env.ctx.waitForEvent('page', { timeout: 8000 });
  await fresh.click('#btn-update');
  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded');
  assert.match(tab.url(), /\/download\.zip$/);
  await env.sw.evaluate(() => { globalThis.fetch = globalThis.__realFetch; }); // do not leak the stub into later tests
  await fresh.close(); // one panel per tab, like Chrome's side panel
});

test('16. panels shown/hidden by class toggles (no node added): each panel gets its own screen and its pins sit on the right elements', async () => {
  await env.page.goto(env.url, { waitUntil: 'load' });
  await env.injectAndToggle();
  await panel.locator('#status-text', { hasText: /Navigation libre|Mode annotation/ }).waitFor();
  if ((await panel.locator('#status-text').innerText()) === 'Mode annotation') await panel.click('#btn-annotate');

  // panel 1: open it (free navigation), annotate its button
  await env.page.click('#toggle-p1');
  await env.page.locator('#panel1.open').waitFor();
  await panel.click('#btn-annotate');
  await env.page.hover('#p1-action');
  await env.page.click('#p1-action');
  await panel.locator('.editor textarea').fill('Le bouton du premier panneau est trop petit, passer à 48px');
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'premier panneau' }).waitFor();
  await env.page.waitForTimeout(500); // screenshot of screen 1

  // leave annotate mode, open panel 2 (panel 1 hidden by a class change only)
  await panel.click('#btn-annotate');
  await panel.locator('#status-text', { hasText: 'Navigation libre' }).waitFor();
  await env.page.click('#toggle-p2');
  await panel.locator('#list .note', { hasText: '1 écran déjà capturé' }).waitFor({ timeout: 8000 });
  assert.equal(await overlayCount(), 0, 'screen 1 pins are gone');

  // annotate panel 2
  await panel.click('#btn-annotate');
  await env.page.hover('#p2-action');
  await env.page.click('#p2-action');
  await panel.locator('.editor textarea').fill('Ce bouton du second panneau doit être vert');
  await panel.click('#editor-save');
  await panel.locator('.item', { hasText: 'second panneau' }).waitFor();

  // the pin sits next to the element it annotates
  const geometry = await inPage(() => {
    const badge = document.getElementById('ai-web-annotator-root').shadowRoot.querySelector('.ai-annotation-badge').getBoundingClientRect();
    const target = document.getElementById('p2-action').getBoundingClientRect();
    return { dx: Math.abs(badge.left - target.left), dy: Math.abs(badge.top - target.top) };
  });
  assert.ok(geometry.dx < 80 && geometry.dy < 80, `pin near its element (${JSON.stringify(geometry)})`);

  await panel.click('#btn-export');
  await panel.locator('#view-export').waitFor({ state: 'visible' });
  assert.match(await panelText('#export-badge'), /2 annotations • 2 écrans/);
  assert.equal(await panel.locator('.screen-tab').count(), 2);
  await panel.click('#btn-quit-all');
  await panel.locator('#status-text', { hasText: 'Inactif' }).waitFor();
});

test('17. screenshots are uploaded to the S3-compatible bucket (verified SigV4) and their links land in the agent prompt, GitHub issue and JSON', async () => {
  const s3 = await startMockS3();
  try {
    // configure the hosting through the panel form, like a user would
    await panel.locator('#hosting summary').click().catch(() => {});
    await env.page.goto(env.url, { waitUntil: 'load' });
    await env.injectAndToggle();
    await panel.locator('#status-text', { hasText: /Navigation libre|Mode annotation/ }).waitFor();
    await panel.evaluate(() => { document.getElementById('hosting').open = true; });
    await panel.fill('#h-endpoint', s3.endpoint);
    await panel.fill('#h-bucket', s3.bucket);
    await panel.fill('#h-key', s3.accessKeyId);
    await panel.fill('#h-secret', s3.secretAccessKey);
    await panel.fill('#h-public', s3.publicBaseUrl);
    await panel.fill('#h-days', '5');
    await panel.click('#h-save');
    await panel.locator('#h-result', { hasText: 'Accès vérifié' }).waitFor({ timeout: 10000 });
    assert.match(s3.getLifecycle(), /<Days>5<\/Days>/, 'expiry rule was installed on the bucket');
    assert.match(await panelText('#hosting-state'), /actif \(5 j\)/);

    // annotate and export
    if ((await panel.locator('#status-text').innerText()) !== 'Mode annotation') await panel.click('#btn-annotate');
    await env.page.hover('#cta');
    await env.page.click('#cta');
    await panel.locator('.editor textarea').fill('Le bouton ne réagit pas au clic');
    await panel.click('#editor-save');
    await panel.locator('.item', { hasText: 'ne réagit pas' }).waitFor();
    await panel.click('#btn-export');
    await panel.locator('#hosting-line', { hasText: 'Captures hébergées' }).waitFor({ timeout: 15000 });

    const stored = [...s3.objects.entries()];
    assert.equal(stored.length, 1);
    const [key, obj] = stored[0];
    assert.match(key, /^annotations\/[0-9a-f]{36}\/ecran-1\.png$/);
    assert.deepEqual([...obj.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real PNG was uploaded');
    assert.ok(obj.body.length > 3000);
    assert.ok(s3.log.every(l => !l.denied), `every signed request was accepted: ${JSON.stringify(s3.log.filter(l => l.denied))}`);

    const url = `${s3.publicBaseUrl}/${key}`;
    const served = await fetch(url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');

    const readClipboard = () => panel.evaluate(() => navigator.clipboard.readText());
    await panel.click('#btn-copy');
    await panel.locator('#btn-copy', { hasText: 'Copié' }).waitFor();
    const agent = await readClipboard();
    assert.ok(agent.includes(url), 'agent prompt carries the image link');
    assert.match(agent, /Capture d'écran annotée\*\* : http/);

    await panel.click('.dest[data-format="github"]');
    await panel.click('#btn-copy');
    await panel.locator('#btn-copy', { hasText: 'Copié' }).waitFor();
    assert.ok((await readClipboard()).includes(`![Écran 1](${url})`));

    await panel.click('.dest[data-format="json"]');
    await panel.click('#btn-copy');
    await panel.locator('#btn-copy', { hasText: 'Copié' }).waitFor();
    assert.equal(JSON.parse(await readClipboard()).pages[0].imageUrl, url);

    await panel.click('#btn-quit-all');
    await panel.locator('#status-text', { hasText: 'Inactif' }).waitFor();
    await panel.click('#h-clear');
  } finally {
    await s3.close();
  }
});
