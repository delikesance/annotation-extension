import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

export const PAGE_HTML = `
<!DOCTYPE html>
<html>
  <head><title>Test Page</title></head>
  <body>
    <main id="app">
      <header><a href="https://example.com/nav" id="nav-link">Navigation Link</a></header>
      <section id="main-section">
        <button id="cta-button" type="button">Perform Action</button>
        <h1 id="title">Titre</h1>
        <form id="contact-form" action="/submit" method="POST">
          <input type="text" id="username" name="username" value="JohnDoe" />
        </form>
        <div id="menu-host"></div>
      </section>
    </main>
  </body>
</html>`;

/**
 * Builds a jsdom page with the content scripts loaded and a chrome mock.
 * `respond(msg)` may return a custom response for a runtime message.
 */
export function createContentEnv({ respond } = {}) {
  const dom = new JSDOM(PAGE_HTML, { url: 'https://example.com/test', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];

  window.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: async (msg) => {
        sent.push(msg);
        if (respond) {
          const custom = await respond(msg);
          if (custom !== undefined) return custom;
        }
        if (msg.action === 'CAPTURE_VISIBLE_TAB') return { success: true, dataUrl: 'data:image/png;base64,mockPngData' };
        return { success: true };
      }
    },
    storage: { local: { set: async () => {}, remove: async () => {}, get: async () => ({}) } }
  };

  global.window = window;
  global.document = window.document;
  global.chrome = window.chrome;
  global.MutationObserver = window.MutationObserver;
  global.Node = window.Node;

  for (const mod of ['selector-generator', 'dom-freeze', 'ui-manager']) {
    delete require.cache[require.resolve(`../../src/content/${mod}.js`)];
  }
  const SelectorGenerator = require('../../src/content/selector-generator.js');
  const DOMFreezeManager = require('../../src/content/dom-freeze.js');
  const AnnotatorUIManager = require('../../src/content/ui-manager.js');

  window.SelectorGenerator = SelectorGenerator;
  window.DOMFreeze = new DOMFreezeManager();
  const ui = new AnnotatorUIManager();
  window.AnnotatorUI = ui;

  const states = () => sent.filter(m => m.action === 'RAIL_STATE').map(m => m.state);
  const lastState = () => states().at(-1);

  function stubRect(el, rect) {
    el.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, bottom: rect.top + rect.height, right: rect.left + rect.width });
  }

  /** Simulates the user clicking an element while the annotator listens. */
  function clickElement(el) {
    stubRect(el, { top: 100, left: 80, width: 120, height: 40 });
    window.document.elementsFromPoint = () => [el, window.document.body, window.document.documentElement];
    window.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 90, clientY: 110 }));
    const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 90, clientY: 110 });
    el.dispatchEvent(evt);
    return evt;
  }

  return { dom, window, ui, sent, states, lastState, clickElement, stubRect };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
