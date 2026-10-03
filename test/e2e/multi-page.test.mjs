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

const STEP1_HTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Étape 1 - Connexion</title>
  <style>
    body { font-family: sans-serif; background: #f1f5f9; padding: 40px; }
    .card { background: white; max-width: 400px; margin: 0 auto; padding: 24px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    input { display: block; width: 100%; margin-bottom: 12px; padding: 8px; box-sizing: border-box; }
    button { background: #4f46e5; color: white; padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; width: 100%; }
    .link-row { margin-top: 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Connexion à la Plateforme</h2>
    <form id="login-form">
      <input type="email" id="email-input" placeholder="nom@domaine.com" />
      <input type="password" id="pass-input" placeholder="Mot de passe" />
      <button type="button" id="login-submit-btn">Se connecter</button>
    </form>
    <div class="link-row">
      <a href="/step2.html" id="link-dashboard">Passer au Dashboard (Étape 2)</a>
    </div>
  </div>
</body>
</html>
`;

const STEP2_HTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Étape 2 - Tableau de Bord</title>
  <style>
    body { font-family: sans-serif; background: #0f172a; color: white; padding: 40px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .panel { background: #1e293b; padding: 20px; border-radius: 8px; border: 1px solid #334155; }
    .chart { height: 120px; background: #334155; display: flex; align-items: center; justify-content: center; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Tableau de Bord Analytics</h1>
  <div class="grid">
    <div class="panel" id="panel-metrics">
      <h3>Statistiques Ventes</h3>
      <div class="chart" id="sales-chart">Graphique des Ventes</div>
    </div>
    <div class="panel" id="panel-users">
      <h3>Utilisateurs Actifs</h3>
      <p id="active-users-count">1 420 utilisateurs en ligne</p>
    </div>
  </div>
</body>
</html>
`;

test('Real Browser End-to-End: Multi-Page Session and Pause Mode in Chromium', async (t) => {
  // 1. Setup local HTTP server with multi-step pages
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url.includes('step2.html')) {
      res.end(STEP2_HTML);
    } else {
      res.end(STEP1_HTML);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const urlStep1 = `http://127.0.0.1:${port}/step1.html`;
  const urlStep2 = `http://127.0.0.1:${port}/step2.html`;
  console.log(`[E2E Multi-Page] Server running at ${urlStep1}`);

  const userDataDir = path.join(rootDir, 'test/e2e/.temp-chrome-profile-multipage');
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
    ],
    permissions: ['clipboard-read', 'clipboard-write']
  });

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(urlStep1, { waitUntil: 'domcontentloaded' });

    // Inject annotator scripts on Page 1
    await page.addStyleTag({ path: path.join(distPath, 'content/styles.css') });
    await page.addScriptTag({ path: path.join(distPath, 'content/selector-generator.js') });
    await page.addScriptTag({ path: path.join(distPath, 'content/dom-freeze.js') });
    await page.addScriptTag({ path: path.join(distPath, 'content/ui-manager.js') });

    // Activate session on Page 1
    await page.evaluate(() => {
      window.AnnotatorUI.activate();
    });
    await page.waitForTimeout(100);

    // Annotate email input (#1)
    await page.click('#email-input');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const textarea = root.shadowRoot.querySelector('.ai-comment-textarea');
      textarea.value = 'Ajouter icône de validation et vérification du format';
    });
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);

    // Annotate login button (#2)
    await page.click('#login-submit-btn');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const textarea = root.shadowRoot.querySelector('.ai-comment-textarea');
      textarea.value = 'Changer la couleur de survol pour un contraste plus élevé';
    });
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);

    const countPage1 = await page.evaluate(() => window.AnnotatorUI.annotations.length);
    assert.equal(countPage1, 2, 'Page 1 must have 2 annotations');

    // Test Pause mode: click Pause button in HUD
    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const pauseBtn = root.shadowRoot.querySelector('#ai-btn-pause');
      pauseBtn.click();
    });
    await page.waitForTimeout(100);

    const isPaused = await page.evaluate(() => window.AnnotatorUI.isPaused);
    assert.equal(isPaused, true, 'Annotator must be in Pause mode');

    // While in Pause mode, click the navigation link to go to Step 2
    // Save current step to session before navigation
    const sessionState = await page.evaluate(() => {
      window.AnnotatorUI.session.pages.push({
        stepIndex: 1,
        url: window.location.href,
        title: document.title,
        dataUrl: 'data:image/png;base64,mockPage1Png',
        annotations: window.AnnotatorUI.annotations.map(a => ({
          index: a.index,
          comment: a.comment,
          metadata: a.metadata || { element: { tag: a.element.tagName } }
        }))
      });
      return window.AnnotatorUI.session;
    });

    // Navigate to Page 2
    await page.goto(urlStep2, { waitUntil: 'domcontentloaded' });

    // Inject scripts on Page 2
    await page.addStyleTag({ path: path.join(distPath, 'content/styles.css') });
    await page.addScriptTag({ path: path.join(distPath, 'content/selector-generator.js') });
    await page.addScriptTag({ path: path.join(distPath, 'content/dom-freeze.js') });
    await page.addScriptTag({ path: path.join(distPath, 'content/ui-manager.js') });

    // Restore multi-page session on Page 2
    await page.evaluate((sess) => {
      window.AnnotatorUI.restoreFromSession(sess);
    }, sessionState);
    await page.waitForTimeout(100);

    // Annotate sales chart on Page 2 -> this should automatically be Point #3!
    await page.click('#sales-chart');
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const textarea = root.shadowRoot.querySelector('.ai-comment-textarea');
      textarea.value = 'Graphique non responsive en mode mobile';
    });
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);

    const point3Index = await page.evaluate(() => {
      const ann = window.AnnotatorUI.annotations[0];
      return ann ? ann.index : 0;
    });
    assert.equal(point3Index, 3, 'Point created on Page 2 must have index #3');

    // Open multi-page export modal
    await page.evaluate(async () => {
      await window.AnnotatorUI.finishAndShowExportModal();
    });
    await page.waitForTimeout(300);

    const exportData = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const modal = root.shadowRoot.querySelector('.ai-export-backdrop');
      if (!modal) return null;

      const promptPreview = modal.querySelector('#ai-prompt-preview')?.textContent || '';
      const stepPill = modal.querySelector('.ai-export-step-pill')?.textContent || '';
      return { promptPreview, stepPill };
    });

    assert.ok(exportData, 'Multi-page export modal must render');
    assert.match(exportData.stepPill, /2 étapes/i, 'Step pill must indicate 2 steps in session');

    // Verify chronological User Journey prompt structure
    assert.ok(exportData.promptPreview.includes('Étape #1'), 'Prompt must contain Étape #1');
    assert.ok(exportData.promptPreview.includes('Étape #2'), 'Prompt must contain Étape #2');
    assert.ok(exportData.promptPreview.includes('Point #1'), 'Prompt must contain Point #1');
    assert.ok(exportData.promptPreview.includes('Point #2'), 'Prompt must contain Point #2');
    assert.ok(exportData.promptPreview.includes('Point #3'), 'Prompt must contain Point #3');

    console.log('[E2E Multi-Page] Multi-page user journey test passed 100%!');

  } finally {
    await context.close();
    server.close();
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
