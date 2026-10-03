import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const distPath = path.join(rootDir, 'dist');

const TEST_PAGE_HTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Test Page for Auto-Update</title>
</head>
<body>
  <h1>Page de Test pour Auto-Update</h1>
  <p>Test de l'indicateur visuel et de la modale de mise à jour.</p>
</body>
</html>
`;

test('Real Browser End-to-End: Auto-Update indicator and modal in Chromium', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE_HTML);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/`;

  const userDataDir = path.join(rootDir, 'test/e2e/.temp-chrome-profile-update');
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  try {
    const page = await context.newPage();
    await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

    // Inject styles and scripts
    const css = fs.readFileSync(path.join(distPath, 'content/styles.css'), 'utf8');
    await page.addStyleTag({ content: css });

    const selectorGenJs = fs.readFileSync(path.join(distPath, 'content/selector-generator.js'), 'utf8');
    const domFreezeJs = fs.readFileSync(path.join(distPath, 'content/dom-freeze.js'), 'utf8');
    const uiManagerJs = fs.readFileSync(path.join(distPath, 'content/ui-manager.js'), 'utf8');

    await page.evaluate(selectorGenJs);
    await page.evaluate(domFreezeJs);
    await page.evaluate(uiManagerJs);

    // Activate and trigger showUpdateBadge
    await page.evaluate(() => {
      window.AnnotatorUI.activate();
      window.AnnotatorUI.showUpdateBadge({
        version: '1.2.0',
        tagName: 'v1.2.0',
        releaseNotes: 'Nouvelle version 1.2.0 avec système de mise à jour automatique.',
        downloadUrl: 'https://git.delikesance.cloud/releases/download/v1.2.0/ai-web-annotator-v1.2.0.zip',
        releaseUrl: 'https://git.delikesance.cloud/releases/tag/v1.2.0'
      });
    });

    // Check that update button is rendered in the HUD dock
    const updateBtnExists = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const btn = root.shadowRoot.querySelector('#ai-btn-update');
      return btn !== null && btn.textContent.includes('MàJ v1.2.0');
    });
    assert.equal(updateBtnExists, true, 'Update badge must be visible in HUD dock');

    // Click update badge to open modal
    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const btn = root.shadowRoot.querySelector('#ai-btn-update');
      btn.click();
    });

    const modalRendered = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const modal = root.shadowRoot.querySelector('.ai-update-modal-backdrop');
      const hasTitle = modal && modal.textContent.includes('Mise à jour disponible');
      const hasNotes = modal && modal.textContent.includes('Nouvelle version 1.2.0');
      const hasDownload = modal && modal.querySelector('#ai-update-download-btn') !== null;
      return hasTitle && hasNotes && hasDownload;
    });
    assert.equal(modalRendered, true, 'Update modal must display details and download button');

    console.log('[E2E Auto-Update] Real browser update flow passed 100%!');
  } finally {
    await context.close();
    server.close();
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
