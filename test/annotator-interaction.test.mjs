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
        if (msg.action === 'DOWNLOAD_FILE') {
          return { success: true, downloadId: 101 };
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
