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
  <title>Application E-Commerce de Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f8fafc; color: #1e293b; padding: 40px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; padding-bottom: 20px; border-bottom: 1px solid #e2e8f0; }
    .top-nav { display: flex; gap: 16px; align-items: center; }
    .top-nav a { color: #4f46e5; text-decoration: none; font-weight: 600; }
    .hero { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); margin-bottom: 40px; }
    .hero h1 { font-size: 32px; color: #0f172a; margin-bottom: 12px; }
    .hero p { color: #64748b; font-size: 16px; margin-bottom: 24px; }
    .btn-cta { display: inline-flex; align-items: center; justify-content: center; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 16px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; }
    .card { background: white; padding: 24px; border-radius: 12px; border: 1px solid #e2e8f0; }
    .card h3 { font-size: 20px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <header>
    <div id="brand-logo" class="logo">AcmeStore</div>
    <nav class="top-nav" id="top-nav-bar">
      <a href="#features" id="nav-features">Fonctionnalités</a>
      <a href="#pricing" id="nav-pricing">Tarifs</a>
      <button id="nav-profile-btn" style="background:#0f172a;color:white;padding:6px 12px;border-radius:6px;border:none;">Mon Compte</button>
    </nav>
  </header>
  <main>
    <section class="hero" id="hero-section">
      <h1 id="main-heading">Votre Solution Cloud Tout-en-Un</h1>
      <p id="hero-subtitle">Accélérez vos déploiements et optimisez vos coûts d'infrastructure.</p>
      <button id="cta-button" class="btn-cta" data-testid="hero-cta-btn">Démarrer Gratuitement</button>
    </section>
    <section class="grid" id="pricing-grid">
      <div class="card" id="tier-starter">
        <h3 class="tier-title">Starter</h3>
        <p class="tier-desc">Idéal pour les projets personnels et prototypes.</p>
      </div>
      <div class="card" id="tier-pro">
        <h3 class="tier-title">Professionnel</h3>
        <p class="tier-desc">Pour les équipes en pleine croissance.</p>
      </div>
    </section>
  </main>
</body>
</html>
`;

test('Real Browser End-to-End: Full Annotation Lifecycle in Chromium with Bottom-Center HUD', async (t) => {
  // 1. Start local mock HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE_HTML);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/`;
  console.log(`[E2E] Test server running at ${testUrl}`);

  // 2. Launch real Chromium instance with unpacked extension
  const userDataDir = path.join(rootDir, 'test/e2e/.temp-chrome-profile');
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
    await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

    // 3. Inject and activate the extension
    await page.addStyleTag({ path: path.join(distPath, 'content/styles.css') });
    await page.addScriptTag({ path: path.join(distPath, 'content/selector-generator.js') });
    await page.addScriptTag({ path: path.join(distPath, 'content/dom-freeze.js') });
    await page.addScriptTag({ path: path.join(distPath, 'content/ui-manager.js') });

    const activated = await page.evaluate(() => {
      if (window.AnnotatorUI) {
        window.AnnotatorUI.activate();
        return window.AnnotatorUI.isInspecting;
      }
      return false;
    });

    assert.equal(activated, true, 'AnnotatorUI must be activated');

    // Inject CSS directly into Shadow Root to ensure synchronous styling in headless test
    const cssContent = fs.readFileSync(path.join(distPath, 'content/styles.css'), 'utf8');
    await page.evaluate((css) => {
      const root = document.getElementById('ai-web-annotator-root');
      if (root && root.shadowRoot) {
        const style = document.createElement('style');
        style.textContent = css;
        root.shadowRoot.appendChild(style);
      }
    }, cssContent);

    await page.waitForTimeout(100);

    // 4. Verify HUD Position at Bottom-Center
    const hudPosition = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const hud = root.shadowRoot.querySelector('.ai-annotator-hud');
      const rect = hud.getBoundingClientRect();
      return {
        bottomDistance: window.innerHeight - rect.bottom,
        top: rect.top,
        left: rect.left,
        width: rect.width
      };
    });

    assert.ok(hudPosition.bottomDistance < 60, `HUD must be docked near bottom (bottomDistance: ${hudPosition.bottomDistance})`);
    assert.ok(hudPosition.top > 500, `HUD must NOT be at top (top: ${hudPosition.top})`);

    // 5. Test Top-Right Element Access (Zero Obstruction verification!)
    // Hover and click on top-right button (#nav-profile-btn)
    await page.hover('#nav-profile-btn');
    await page.waitForTimeout(100);

    const topNavHighlight = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const label = root.shadowRoot.querySelector('.ai-highlight-label');
      return label ? label.textContent : '';
    });
    assert.ok(topNavHighlight.includes('button#nav-profile-btn'), `Top-right button must be directly hoverable without obstruction, got: ${topNavHighlight}`);

    // Click on top-right element to create Annotation #1
    await page.click('#nav-profile-btn');
    await page.waitForTimeout(200);

    // Type via real keyboard events
    await page.keyboard.type('Remplacer ce bouton par un avatar utilisateur circulaire avec menu déroulant');
    await page.waitForTimeout(100);

    const typedValue1 = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const textarea = root.shadowRoot.querySelector('.ai-comment-textarea');
      return textarea ? textarea.value : '';
    });
    assert.equal(typedValue1, 'Remplacer ce bouton par un avatar utilisateur circulaire avec menu déroulant', 'Keyboard typing into comment textarea must work flawlessly');

    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);

    const annCount1 = await page.evaluate(() => window.AnnotatorUI.annotations.length);
    assert.equal(annCount1, 1, 'Annotation #1 on top-right element saved successfully');

    // 6. Hover and click on CTA Button for Annotation #2
    await page.hover('#cta-button');
    await page.waitForTimeout(100);
    await page.click('#cta-button');
    await page.waitForTimeout(200);

    // Type via real keyboard events for Annotation #2
    await page.keyboard.type('Le bouton CTA déborde sur mobile et doit passer en flex column');
    await page.waitForTimeout(100);

    const typedValue2 = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const textarea = root.shadowRoot.querySelector('.ai-comment-textarea');
      return textarea ? textarea.value : '';
    });
    assert.equal(typedValue2, 'Le bouton CTA déborde sur mobile et doit passer en flex column', 'Keyboard typing into annotation #2 must work');

    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);

    const annCount2 = await page.evaluate(() => window.AnnotatorUI.annotations.length);
    assert.equal(annCount2, 2, 'Annotation #2 saved');

    // 7. Test HUD Minimize Toggle
    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const minBtn = root.shadowRoot.querySelector('#ai-btn-minimize');
      minBtn.click();
    });
    await page.waitForTimeout(100);

    const isCollapsed = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      return root.shadowRoot.querySelector('.ai-annotator-hud').classList.contains('ai-hud-collapsed');
    });
    assert.equal(isCollapsed, true, 'HUD must toggle to collapsed state');

    // Restore HUD
    await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const minBtn = root.shadowRoot.querySelector('#ai-btn-minimize');
      minBtn.click();
    });

    // 8. Open Export Modal
    await page.evaluate(async () => {
      await window.AnnotatorUI.finishAndShowExportModal();
    });
    await page.waitForTimeout(300);

    const modalData = await page.evaluate(() => {
      const root = document.getElementById('ai-web-annotator-root');
      const modal = root.shadowRoot.querySelector('.ai-export-backdrop');
      if (!modal) return null;

      const exportBadge = modal.querySelector('.ai-export-badge')?.textContent || '';
      const promptPreview = modal.querySelector('#ai-prompt-preview')?.textContent || '';
      const copyImgBtn = Boolean(modal.querySelector('#ai-btn-copy-image'));
      const primaryCtaBtn = Boolean(modal.querySelector('#ai-btn-primary-action'));

      return { exportBadge, promptPreview, copyImgBtn, primaryCtaBtn };
    });

    assert.ok(modalData, 'Export modal must be rendered in Shadow DOM');
    assert.ok(modalData.copyImgBtn, 'Copy Image button must exist');
    assert.ok(modalData.primaryCtaBtn, 'Primary CTA button must exist');
    assert.match(modalData.exportBadge, /2 annotations/i, 'Export badge must show 2 annotations');

    // Verify both points appear in prompt
    assert.ok(modalData.promptPreview.includes('Point #1'), 'Prompt must include Point #1');
    assert.ok(modalData.promptPreview.includes('nav-profile-btn'), 'Prompt must contain top-right selector');
    assert.ok(modalData.promptPreview.includes('Point #2'), 'Prompt must include Point #2');

    console.log('[E2E] Real browser test with Bottom-Center HUD and Top-Right inspection completed 100% successfully!');

  } finally {
    await context.close();
    server.close();
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
