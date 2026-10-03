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
  <title>Application Multi-Écrans</title>
  <style>
    body { font-family: sans-serif; padding: 40px; background: #f8fafc; }
    .section { background: white; padding: 30px; border-radius: 8px; margin-bottom: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    button { padding: 10px 20px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="section" id="screen-1">
    <h1>Section 1 - En-tête & Connexion</h1>
    <button id="btn-login">Bouton Se Connecter</button>
  </div>
  <div class="section" id="screen-2" style="margin-top: 400px;">
    <h2>Section 2 - Tableau de Bord</h2>
    <button id="btn-settings">Bouton Paramètres</button>
  </div>
</body>
</html>
`;

test('Real Browser End-to-End: Next Screen Workflow in Chromium', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE_HTML);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/`;

  const userDataDir = path.join(rootDir, 'test/e2e/.temp-chrome-profile-next-screen');
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
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

    // Inject styles & scripts
    const css = fs.readFileSync(path.join(distPath, 'content/styles.css'), 'utf8');
    await page.addStyleTag({ content: css });

    const selectorGenJs = fs.readFileSync(path.join(distPath, 'content/selector-generator.js'), 'utf8');
    const domFreezeJs = fs.readFileSync(path.join(distPath, 'content/dom-freeze.js'), 'utf8');
    const uiManagerJs = fs.readFileSync(path.join(distPath, 'content/ui-manager.js'), 'utf8');

    await page.evaluate(selectorGenJs);
    await page.evaluate(domFreezeJs);
    await page.evaluate(uiManagerJs);

    // 1. Activate Annotator on Screen 1
    await page.evaluate(() => window.AnnotatorUI.activate());
    await page.waitForTimeout(100);

    // 2. Click on #btn-login for Annotation #1
    await page.click('#btn-login');
    await page.waitForTimeout(150);

    await page.keyboard.type('Améliorer le bouton de connexion');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(150);

    // 3. Click on "Écran Suivant"
    await page.evaluate(async () => {
      await window.AnnotatorUI.nextScreen();
    });
    await page.waitForTimeout(200);

    // Verify Screen 1 is stored and visual annotations cleared
    const stateAfterNext = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      return {
        pagesCount: window.AnnotatorUI.session.pages.length,
        currentAnnotationsCount: window.AnnotatorUI.annotations.length,
        isPaused: window.AnnotatorUI.isPaused,
        badgesOnDOM: root.shadowRoot.querySelectorAll('.ai-annotation-badge').length
      };
    });

    assert.equal(stateAfterNext.pagesCount, 1, 'Screen 1 must be committed in session');
    assert.equal(stateAfterNext.currentAnnotationsCount, 0, 'Current page annotations must be empty');
    assert.equal(stateAfterNext.isPaused, true, 'Must switch to free navigation mode');
    assert.equal(stateAfterNext.badgesOnDOM, 0, 'No badges left on screen from previous screen');

    // 4. Scroll to Screen 2 and resume annotation
    await page.evaluate(() => {
      window.scrollTo(0, 400);
      window.AnnotatorUI.resume();
    });
    await page.waitForTimeout(150);

    // 5. Annotate #btn-settings on Screen 2 (must be #2)
    await page.click('#btn-settings');
    await page.waitForTimeout(150);

    const newIndex = await page.evaluate(() => {
      return window.AnnotatorUI.selectedAnnotation.index;
    });
    assert.equal(newIndex, 2, 'Annotation on Screen 2 must continue with index 2!');

    await page.keyboard.type('Ajouter icône roue crantée dans les paramètres');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(150);

    const savedIndex = await page.evaluate(() => {
      return window.AnnotatorUI.annotations[0].index;
    });
    assert.equal(savedIndex, 2, 'Saved annotation must have index 2');

    // 6. Finish and open Export Modal
    await page.evaluate(async () => {
      await window.AnnotatorUI.finishAndShowExportModal();
    });
    await page.waitForTimeout(200);

    const exportData = await page.evaluate(() => {
      return {
        pages: window.AnnotatorUI.lastExportData.pages.length,
        prompt: window.AnnotatorUI.lastExportData.promptText
      };
    });

    assert.equal(exportData.pages, 2, 'Export modal must consolidate all 2 screens');
    assert.ok(exportData.prompt.includes('Étape #1'), 'Prompt contains Step 1');
    assert.ok(exportData.prompt.includes('Étape #2'), 'Prompt contains Step 2');
    assert.ok(exportData.prompt.includes('[Point #1]'), 'Prompt contains Point #1');
    assert.ok(exportData.prompt.includes('[Point #2]'), 'Prompt contains Point #2');

    // 7. Test Export Modal Screen Tabs & Batch Download Button in Shadow DOM
    const modalUi = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const tabs = Array.from(root.shadowRoot.querySelectorAll('.ai-screen-tab')).map(t => t.textContent.trim());
      const dlAllBtnText = root.shadowRoot.querySelector('#ai-btn-dl-all-png')?.textContent?.trim();
      const dlPngText = root.shadowRoot.querySelector('#ai-dl-png-text')?.textContent?.trim();
      return { tabs, dlAllBtnText, dlPngText };
    });

    assert.equal(modalUi.tabs.length, 2, 'Must have 2 screen tabs in export modal');
    assert.match(modalUi.dlAllBtnText, /Tout télécharger/i, 'Batch download button must exist');
    assert.ok(modalUi.dlAllBtnText.includes('2'), 'Batch download button must display total 2 images');
    assert.ok(modalUi.dlPngText.includes('écran #2'), 'Initial download button is for active screen 2');

    // Click Tab 1
    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const tab1 = root.shadowRoot.querySelectorAll('.ai-screen-tab')[0];
      tab1.click();
    });
    await page.waitForTimeout(100);

    const updatedDlText = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      return root.shadowRoot.querySelector('#ai-dl-png-text')?.textContent?.trim();
    });
    assert.ok(updatedDlText.includes('écran #1'), 'Download button text must switch to screen #1');

    console.log('[E2E Next Screen] Next Screen & Multi-Image download passed 100%!');
  } finally {
    await context.close();
    server.close();
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
