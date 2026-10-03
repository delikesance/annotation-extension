import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

function createMockEnvironment() {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>Test Interaction Page</title></head>
      <body>
        <main id="app">
          <header>
            <a href="https://example.com/nav" id="nav-link">Navigation Link</a>
          </header>
          <section id="main-section">
            <button id="cta-button" type="button">Perform Action</button>
            <form id="contact-form" action="/submit" method="POST">
              <input type="text" id="username" name="username" value="JohnDoe" />
              <button id="submit-btn" type="submit">Submit Form</button>
            </form>
          </section>
        </main>
      </body>
    </html>
  `;

  const dom = new JSDOM(html, { url: 'https://example.com/test', runScripts: 'dangerously' });
  const { window } = dom;

  // Mock chrome extension runtime API
  const sentMessages = [];
  window.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        if (msg.action === 'CAPTURE_VISIBLE_TAB') {
          return { success: true, dataUrl: 'data:image/png;base64,mockPngData' };
        }
        if (msg.action === 'COPY_TO_CLIPBOARD') {
          if (msg.type === 'text' && window.navigator.clipboard && window.navigator.clipboard.writeText) {
            await window.navigator.clipboard.writeText(msg.text);
          }
          if (msg.type === 'image' && window.navigator.clipboard && window.navigator.clipboard.write) {
            await window.navigator.clipboard.write([new (global.ClipboardItem || window.ClipboardItem)({ 'image/png': msg.dataUrl })]);
          }
          return { success: true };
        }
        if (msg.action === 'DOWNLOAD_FILE') {
          return { success: true, downloadId: 101 };
        }
        if (msg.action === 'GET_UPDATE_INFO') {
          return { success: true, update: window.__mockUpdate || null };
        }
        return { success: true };
      }
    }
  };

  // Provide globals expected by content scripts
  global.window = window;
  global.document = window.document;
  global.chrome = window.chrome;

  const SelectorGenerator = require('../src/content/selector-generator.js');
  const DOMFreezeManager = require('../src/content/dom-freeze.js');
  const AnnotatorUIManager = require('../src/content/ui-manager.js');

  window.SelectorGenerator = SelectorGenerator;
  window.DOMFreeze = new DOMFreezeManager();
  window.AnnotatorUI = new AnnotatorUIManager();

  return { dom, window, sentMessages };
}

test('DOMFreezeManager - intercepts page submit and contextmenu but lets click through to annotator', () => {
  const { dom, window } = createMockEnvironment();

  window.DOMFreeze.enable();
  assert.equal(window.DOMFreeze.isActive, true);
  assert.equal(window.document.documentElement.classList.contains('ai-annotator-page-frozen'), true);

  // Submit event should be prevented
  const form = window.document.getElementById('contact-form');
  const submitEvt = new window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(submitEvt);
  assert.equal(submitEvt.defaultPrevented, true);

  // Context menu should be prevented
  const ctxEvt = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  form.dispatchEvent(ctxEvt);
  assert.equal(ctxEvt.defaultPrevented, true);

  // Pointerdown and mousedown should stop propagation to page handlers without calling preventDefault
  let pageMousedownRan = false;
  const btn = window.document.getElementById('cta-button');
  btn.addEventListener('mousedown', () => { pageMousedownRan = true; });

  const pdownEvt = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  btn.dispatchEvent(pdownEvt);
  assert.equal(pdownEvt.defaultPrevented, false, 'pointerdown MUST NOT be preventDefaulted in Chromium');

  const mdownEvt = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  btn.dispatchEvent(mdownEvt);
  assert.equal(pageMousedownRan, false, 'mousedown propagation should be stopped for page element handlers');
  assert.equal(mdownEvt.defaultPrevented, false, 'mousedown MUST NOT be preventDefaulted');

  window.DOMFreeze.disable();
  assert.equal(window.DOMFreeze.isActive, false);
  assert.equal(window.document.documentElement.classList.contains('ai-annotator-page-frozen'), false);
});

test('AnnotatorUIManager - clicking an element successfully creates an annotation and opens comment modal', () => {
  const { dom, window } = createMockEnvironment();

  let pageLinkClicked = false;
  const link = window.document.getElementById('nav-link');
  link.addEventListener('click', () => { pageLinkClicked = true; });
  link.getBoundingClientRect = () => ({ top: 20, left: 30, width: 140, height: 25, x: 30, y: 20, bottom: 45, right: 170 });

  window.document.elementsFromPoint = (x, y) => [link, window.document.body, window.document.documentElement];

  // Activate annotator
  window.AnnotatorUI.activate();
  assert.equal(window.AnnotatorUI.isInspecting, true);
  assert.equal(window.DOMFreeze.isActive, true);

  // Hover over link
  const mmEvt = new window.MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 25 });
  window.dispatchEvent(mmEvt);
  assert.equal(window.AnnotatorUI.hoveredElement, link);

  // Click link to annotate
  const clickEvt = new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 25 });
  link.dispatchEvent(clickEvt);

  // Link click must be intercepted: default prevented, page listener blocked, modal opened
  assert.equal(clickEvt.defaultPrevented, true, 'Link navigation must be prevented');
  assert.equal(pageLinkClicked, false, 'Page click listener must not fire');
  assert.ok(window.AnnotatorUI.activeCommentCard, 'Comment card modal must be opened');
  assert.equal(window.AnnotatorUI.isEditingComment, true);

  // Verify modal elements
  const textarea = window.AnnotatorUI.activeCommentCard.querySelector('.ai-comment-textarea');
  assert.ok(textarea, 'Textarea must be present in comment card');
  const saveBtn = window.AnnotatorUI.activeCommentCard.querySelector('#ai-modal-save');
  assert.ok(saveBtn, 'Save button must be present in comment card');

  // Fill comment and validate
  textarea.value = 'Update this link destination';
  saveBtn.click();

  // Annotation should now be saved
  assert.equal(window.AnnotatorUI.annotations.length, 1);
  assert.equal(window.AnnotatorUI.annotations[0].comment, 'Update this link destination');
  assert.equal(window.AnnotatorUI.annotations[0].index, 1);
  assert.equal(window.AnnotatorUI.isEditingComment, false);
  assert.equal(window.AnnotatorUI.activeCommentCard, null);

  // Verify badge exists in shadow root
  const badgeEl = window.AnnotatorUI.annotations[0].badgeEl;
  assert.ok(badgeEl, 'Badge element must exist');
  assert.equal(badgeEl.textContent, '1');

  // Clicking badge re-opens comment modal
  badgeEl.click();
  assert.ok(window.AnnotatorUI.activeCommentCard, 'Comment card modal must re-open on badge click');
  const reloadedTextarea = window.AnnotatorUI.activeCommentCard.querySelector('.ai-comment-textarea');
  assert.equal(reloadedTextarea.value, 'Update this link destination');

  // Deactivating annotator cleans up
  window.AnnotatorUI.deactivate();
  assert.equal(window.AnnotatorUI.isInspecting, false);
  assert.equal(window.DOMFreeze.isActive, false);
  assert.equal(window.AnnotatorUI.annotations.length, 0);
});

test('AnnotatorUIManager - clicking without prior mousemove still detects target and annotates', () => {
  const { dom, window } = createMockEnvironment();

  const btn = window.document.getElementById('cta-button');
  btn.getBoundingClientRect = () => ({ top: 100, left: 50, width: 120, height: 40, x: 50, y: 100, bottom: 140, right: 170 });
  window.document.elementsFromPoint = (x, y) => [btn, window.document.body, window.document.documentElement];

  window.AnnotatorUI.activate();

  // Notice: no mousemove event dispatched, hoveredElement is null!
  assert.equal(window.AnnotatorUI.hoveredElement, null);

  // Directly click button
  const clickEvt = new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 110 });
  btn.dispatchEvent(clickEvt);

  assert.ok(window.AnnotatorUI.activeCommentCard, 'Comment card modal must be opened even without prior mousemove');
  assert.equal(window.AnnotatorUI.currentEditingAnnotation.element, btn);

  // Cancel comment modal
  const deleteBtn = window.AnnotatorUI.activeCommentCard.querySelector('#ai-modal-delete');
  deleteBtn.click();

  assert.equal(window.AnnotatorUI.activeCommentCard, null);
  assert.equal(window.AnnotatorUI.annotations.length, 0);

  window.AnnotatorUI.deactivate();
});

test('AnnotatorUIManager - renders directional arrow SVG and opens export modal with copy buttons on Terminer', async () => {
  const { dom, window, sentMessages } = createMockEnvironment();

  // Mock clipboard
  let clipboardText = '';
  let clipboardItems = [];
  window.navigator.clipboard = {
    writeText: async (t) => { clipboardText = t; },
    write: async (items) => { clipboardItems = items; }
  };
  global.ClipboardItem = class ClipboardItem {
    constructor(obj) { this.data = obj; }
  };
  global.fetch = async (url) => ({
    blob: async () => new (window.Blob || Blob)(['fake-png'], { type: 'image/png' }),
    arrayBuffer: async () => new ArrayBuffer(8)
  });

  const btn = window.document.getElementById('cta-button');
  btn.getBoundingClientRect = () => ({ top: 80, left: 120, width: 150, height: 45, x: 120, y: 80, bottom: 125, right: 270 });
  window.document.elementsFromPoint = (x, y) => [btn, window.document.body, window.document.documentElement];

  window.AnnotatorUI.activate();

  // Click to annotate
  const clickEvt = new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 130, clientY: 90 });
  btn.dispatchEvent(clickEvt);

  // 1. Verify Arrow Element exists
  const ann = window.AnnotatorUI.currentEditingAnnotation;
  assert.ok(ann.arrowEl, 'Arrow SVG element must be generated');
  assert.equal(ann.arrowEl.getAttribute('class'), 'ai-annotation-arrow');
  const lineEls = ann.arrowEl.querySelectorAll('line');
  assert.equal(lineEls.length, 2, 'Arrow should have halo line and colored indicator line');

  // Save annotation comment
  const textarea = window.AnnotatorUI.activeCommentCard.querySelector('textarea');
  textarea.value = 'Remplacer ce bouton par un CTA vert';
  window.AnnotatorUI.activeCommentCard.querySelector('#ai-modal-save').click();

  assert.equal(window.AnnotatorUI.annotations.length, 1);
  assert.ok(window.AnnotatorUI.annotations[0].arrowEl, 'Saved annotation must retain arrowEl');

  // 2. Click "Terminer" in HUD
  const finishBtn = window.AnnotatorUI.hud.querySelector('#ai-btn-export');
  assert.ok(finishBtn, 'Finish button must exist in HUD');
  assert.match(finishBtn.textContent, /Terminer/);

  await window.AnnotatorUI.finishAndShowExportModal();

  // 3. Verify Export Modal is opened
  assert.ok(window.AnnotatorUI.activeExportModal, 'Export modal must be displayed');
  const modal = window.AnnotatorUI.activeExportModal;

  const copyImgBtn = modal.querySelector('#ai-btn-copy-image');
  const copyPromptBtn = modal.querySelector('#ai-btn-copy-prompt');
  const dlPngBtn = modal.querySelector('#ai-btn-dl-png');
  const dlJsonBtn = modal.querySelector('#ai-btn-dl-json');

  assert.ok(copyImgBtn, 'Copier l\'image button must exist');
  assert.ok(copyPromptBtn, 'Copier le prompt IA button must exist');
  assert.ok(dlPngBtn, 'Télécharger PNG button must exist');
  assert.ok(dlJsonBtn, 'Télécharger JSON button must exist');

  // 4. Test "Copier le prompt"
  copyPromptBtn.click();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(clipboardText.includes('Remplacer ce bouton par un CTA vert'), 'Prompt must contain the annotation comment');
  assert.ok(clipboardText.includes('Point #1'), 'Prompt must contain Point #1');

  // 5. Test "Copier l'image"
  copyImgBtn.click();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(clipboardItems.length, 1, 'ClipboardItem must be written to clipboard');

  // 6. Test Downloads
  dlPngBtn.click();
  const dlPngMsg = sentMessages.find(m => m.action === 'DOWNLOAD_FILE' && m.filename.endsWith('.png'));
  assert.ok(dlPngMsg, 'Download PNG message must be dispatched');

  // Close modal via resume
  modal.querySelector('#ai-btn-resume').click();
  assert.equal(window.AnnotatorUI.activeExportModal, null);

  window.AnnotatorUI.deactivate();
});

test('AnnotatorUIManager - typing in comment textarea completely blocks website keyboard shortcuts', () => {
  const { dom, window } = createMockEnvironment();

  const websiteShortcutsFired = [];
  // Simulate common web app shortcut listeners on window and document
  window.addEventListener('keydown', (e) => {
    websiteShortcutsFired.push(`window-keydown-${e.key}`);
  });
  window.document.addEventListener('keydown', (e) => {
    websiteShortcutsFired.push(`document-keydown-${e.key}`);
  });
  window.addEventListener('keyup', (e) => {
    websiteShortcutsFired.push(`window-keyup-${e.key}`);
  });
  window.document.addEventListener('keyup', (e) => {
    websiteShortcutsFired.push(`document-keyup-${e.key}`);
  });

  const btn = window.document.getElementById('cta-button');
  btn.getBoundingClientRect = () => ({ top: 50, left: 50, width: 100, height: 40, x: 50, y: 50, bottom: 90, right: 150 });
  window.document.elementsFromPoint = () => [btn, window.document.body];

  window.AnnotatorUI.activate();

  // Click button to open comment modal
  const clickEvt = new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 });
  btn.dispatchEvent(clickEvt);

  assert.ok(window.AnnotatorUI.activeCommentCard, 'Comment card must be open');
  const textarea = window.AnnotatorUI.activeCommentCard.querySelector('textarea');
  assert.ok(textarea, 'Textarea must exist');

  // Simulate user typing shortcuts that would normally trigger page actions (e.g. "f", "k", "s", "j", "?", " ")
  const testKeys = ['f', 'k', 's', 'j', '?', ' '];
  for (const k of testKeys) {
    const kd = new window.KeyboardEvent('keydown', { key: k, bubbles: true, composed: true });
    textarea.dispatchEvent(kd);
    textarea.value += k;
    const ku = new window.KeyboardEvent('keyup', { key: k, bubbles: true, composed: true });
    textarea.dispatchEvent(ku);
  }

  // Textarea must receive the text
  assert.equal(textarea.value, 'fksj? ');

  // None of the website shortcuts must have fired!
  assert.deepEqual(websiteShortcutsFired, [], 'No website shortcut listeners should receive keyboard events when typing in the textarea');

  // Verify Escape cancels modal without firing page shortcuts
  const escEvt = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true });
  textarea.dispatchEvent(escEvt);
  assert.equal(window.AnnotatorUI.activeCommentCard, null, 'Escape should close the active comment card');
  assert.deepEqual(websiteShortcutsFired, [], 'Escape in textarea must not leak to website');

  window.AnnotatorUI.deactivate();
});

test('AnnotatorUIManager - displays update badge when update is available and opens modal', async () => {
  const env = createMockEnvironment();
  const { window } = env;

  window.__mockUpdate = {
    version: '1.2.0',
    tagName: 'v1.2.0',
    name: 'AI Web Annotator v1.2.0',
    releaseNotes: '- Added auto-update system\n- Improved UI dock',
    downloadUrl: 'https://git.delikesance.cloud/releases/v1.2.0/ai-web-annotator-v1.2.0.zip',
    releaseUrl: 'https://git.delikesance.cloud/releases/tag/v1.2.0'
  };

  window.AnnotatorUI.activate();

  // Wait tick for async checkUpdateStatus
  await new Promise(r => setTimeout(r, 10));

  const shadow = window.AnnotatorUI.shadow;
  const updateBtn = shadow.querySelector('#ai-btn-update');
  assert.ok(updateBtn, 'Update button must be rendered in HUD dock');
  assert.ok(updateBtn.textContent.includes('MàJ v1.2.0'), 'Badge should show new version number');

  // Click update button to open modal
  updateBtn.click();

  const modal = shadow.querySelector('.ai-update-modal-backdrop');
  assert.ok(modal, 'Update modal must be opened upon clicking badge');
  assert.ok(modal.textContent.includes('v1.2.0'), 'Modal should display update version');
  assert.ok(modal.textContent.includes('Added auto-update system'), 'Modal should display release notes');

  const dlLink = modal.querySelector('#ai-update-download-btn');
  assert.ok(dlLink, 'Download button must exist');
  assert.equal(dlLink.getAttribute('href'), window.__mockUpdate.downloadUrl);

  const closeBtn = modal.querySelector('#ai-update-close');
  assert.ok(closeBtn, 'Close button must exist');
  closeBtn.click();

  assert.equal(shadow.querySelector('.ai-update-modal-backdrop'), null, 'Modal must close on close button click');

  window.AnnotatorUI.deactivate();
});

test('AnnotatorUIManager - nextScreen() commits current screen, clears DOM, and continues numbering sequentially', async () => {
  const env = createMockEnvironment();
  const { window } = env;

  const btn1 = window.document.getElementById('nav-link');
  const btn2 = window.document.getElementById('cta-button');

  btn1.getBoundingClientRect = () => ({ top: 10, left: 10, width: 80, height: 30, x: 10, y: 10, bottom: 40, right: 90 });
  btn2.getBoundingClientRect = () => ({ top: 100, left: 10, width: 100, height: 40, x: 10, y: 100, bottom: 140, right: 110 });

  window.AnnotatorUI.activate();

  // Screen 1: Create Annotation #1
  window.document.elementsFromPoint = () => [btn1, window.document.body];
  btn1.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  assert.equal(window.AnnotatorUI.selectedAnnotation.index, 1);
  const ta1 = window.AnnotatorUI.activeCommentCard.querySelector('textarea');
  ta1.value = 'Comment for Screen 1 Point 1';
  window.AnnotatorUI.activeCommentCard.querySelector('#ai-modal-save').click();
  assert.equal(window.AnnotatorUI.annotations.length, 1);

  // Screen 1: Create Annotation #2
  window.document.elementsFromPoint = () => [btn2, window.document.body];
  btn2.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 110 }));
  assert.equal(window.AnnotatorUI.selectedAnnotation.index, 2);
  const ta2 = window.AnnotatorUI.activeCommentCard.querySelector('textarea');
  ta2.value = 'Comment for Screen 1 Point 2';
  window.AnnotatorUI.activeCommentCard.querySelector('#ai-modal-save').click();
  assert.equal(window.AnnotatorUI.annotations.length, 2);

  // Click "+ Écran Suivant"
  await window.AnnotatorUI.nextScreen();

  // Verify that Screen 1 was committed
  assert.equal(window.AnnotatorUI.session.pages.length, 1, 'Screen 1 must be committed to session.pages');
  assert.equal(window.AnnotatorUI.session.pages[0].annotations.length, 2, 'Screen 1 must have 2 annotations');
  assert.equal(window.AnnotatorUI.annotations.length, 0, 'Current page annotations array must be cleared');
  assert.equal(window.AnnotatorUI.isPaused, true, 'Should switch to pause/free navigation mode for next screen');

  // Resume for Screen 2
  window.AnnotatorUI.resume();

  // Screen 2: Create Annotation (must be #3!)
  window.document.elementsFromPoint = () => [btn1, window.document.body];
  btn1.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  assert.equal(window.AnnotatorUI.selectedAnnotation.index, 3, 'Next annotation must start at index 3!');

  const ta3 = window.AnnotatorUI.activeCommentCard.querySelector('textarea');
  ta3.value = 'Comment for Screen 2 Point 3';
  window.AnnotatorUI.activeCommentCard.querySelector('#ai-modal-save').click();
  assert.equal(window.AnnotatorUI.annotations.length, 1, 'Screen 2 has 1 active annotation');

  // Finish and export
  await window.AnnotatorUI.finishAndShowExportModal();

  assert.ok(window.AnnotatorUI.lastExportData, 'Export data must exist');
  assert.equal(window.AnnotatorUI.lastExportData.pages.length, 2, 'Total 2 screens must be exported');
  assert.ok(window.AnnotatorUI.lastExportData.promptText.includes('Étape #1'), 'Prompt must contain Step 1');
  assert.ok(window.AnnotatorUI.lastExportData.promptText.includes('Étape #2'), 'Prompt must contain Step 2');
  assert.ok(window.AnnotatorUI.lastExportData.promptText.includes('[Point #1]'), 'Prompt must contain Point #1');
  assert.ok(window.AnnotatorUI.lastExportData.promptText.includes('[Point #2]'), 'Prompt must contain Point #2');
  assert.ok(window.AnnotatorUI.lastExportData.promptText.includes('[Point #3]'), 'Prompt must contain Point #3');

  window.AnnotatorUI.deactivate();
});




