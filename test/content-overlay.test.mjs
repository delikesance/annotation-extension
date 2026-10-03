import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentEnv, wait } from './helpers/content-env.mjs';

test('DOMFreezeManager - suppresses submit/contextmenu and lets clicks reach the annotator', () => {
  const { window } = createContentEnv();
  window.DOMFreeze.enable();
  assert.equal(window.document.documentElement.classList.contains('ai-annotator-page-frozen'), true);

  const form = window.document.getElementById('contact-form');
  const submit = new window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);

  let pageMousedown = false;
  const btn = window.document.getElementById('cta-button');
  btn.addEventListener('mousedown', () => { pageMousedown = true; });
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  btn.dispatchEvent(down);
  assert.equal(pageMousedown, false);
  assert.equal(down.defaultPrevented, false);

  window.DOMFreeze.disable();
  assert.equal(window.document.documentElement.classList.contains('ai-annotator-page-frozen'), false);
});

test('activate starts in free navigation: no frozen page, no UI injected in the page', () => {
  const { window, ui, lastState } = createContentEnv();
  ui.activate();

  assert.equal(ui.isActive, true);
  assert.equal(ui.isInspecting, false);
  assert.equal(window.DOMFreeze.isActive, false, 'page must stay interactive until annotate mode');

  const shadow = ui.shadow;
  for (const sel of ['.ai-annotator-hud', '.ai-toast', '.ai-comment-card', '.ai-export-backdrop', '.ai-update-modal-backdrop', '.ai-rail-list']) {
    assert.equal(shadow.querySelector(sel), null, `${sel} must not exist in the page: everything lives in the side panel`);
  }

  const state = lastState();
  assert.equal(state.active, true);
  assert.equal(state.mode, 'browse');
  assert.equal(state.annotations.length, 0);
  ui.deactivate();
});

test('"Ajouter une annotation" enters annotate mode; toggling again returns to free navigation', () => {
  const { window, ui, lastState } = createContentEnv();
  ui.activate();

  ui.handleRailAction('annotate');
  assert.equal(ui.isInspecting, true);
  assert.equal(window.DOMFreeze.isActive, true);
  assert.equal(lastState().mode, 'annotate');

  ui.handleRailAction('annotate');
  assert.equal(ui.isInspecting, false);
  assert.equal(window.DOMFreeze.isActive, false);
  assert.equal(lastState().mode, 'browse');
  ui.deactivate();
});

test('clicking in browse mode does nothing; in annotate mode it intercepts the page click and opens the editor in the panel', () => {
  const { window, ui, lastState, clickElement, sent } = createContentEnv();
  const link = window.document.getElementById('nav-link');
  let pageClicked = false;
  link.addEventListener('click', () => { pageClicked = true; });
  ui.activate();

  clickElement(link);
  assert.equal(pageClicked, true, 'in free navigation the page receives its click');
  assert.equal(ui.annotations.length, 0);
  assert.equal(lastState().editing, null);

  pageClicked = false;
  ui.handleRailAction('annotate');
  const evt = clickElement(link);
  assert.equal(evt.defaultPrevented, true);
  assert.equal(pageClicked, false);
  assert.equal(ui.isEditingComment, true);
  assert.ok(sent.some(m => m.action === 'OPEN_SIDE_PANEL'), 'a click must ask for the side panel to be open');

  const editing = lastState().editing;
  assert.equal(editing.index, 1);
  assert.equal(editing.isNew, true);
  assert.equal(editing.tag, 'a');
  ui.deactivate();
});

test('several annotations can be placed in a row; save/open/delete/cancel go through panel actions', () => {
  const { window, ui, lastState, clickElement } = createContentEnv();
  ui.activate();
  ui.handleRailAction('annotate');

  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'Remplacer ce bouton par un CTA vert', type: 'style' });
  assert.equal(ui.annotations.length, 1);
  assert.equal(ui.isInspecting, true, 'annotate mode stays on after saving');
  assert.equal(ui.isEditingComment, false);

  clickElement(window.document.getElementById('title'));
  ui.handleRailAction('save', { comment: 'Le titre ne s\'affiche pas', type: 'bug' });
  assert.equal(ui.annotations.length, 2);
  assert.deepEqual(lastState().annotations.map(a => [a.index, a.type, a.comment]), [
    [1, 'style', 'Remplacer ce bouton par un CTA vert'],
    [2, 'bug', "Le titre ne s'affiche pas"]
  ]);
  assert.equal(ui.annotations[0].badgeEl.textContent, '1');
  assert.ok(ui.annotations[0].metadata.element.cssSelector, 'selector metadata is captured on save');

  // reopen from the panel
  ui.handleRailAction('open', { index: 1 });
  assert.equal(lastState().editing.index, 1);
  assert.equal(lastState().editing.isNew, false);
  assert.equal(lastState().editing.comment, 'Remplacer ce bouton par un CTA vert');

  // clicking the pin reopens it too
  ui.handleRailAction('cancel');
  ui.annotations[1].badgeEl.click();
  assert.equal(lastState().editing.index, 2);

  // cancel a new one removes its overlay
  ui.handleRailAction('cancel');
  clickElement(window.document.getElementById('username'));
  const overlaysBefore = ui.shadow.querySelectorAll('.ai-annotation-badge').length;
  ui.handleRailAction('cancel');
  assert.equal(ui.shadow.querySelectorAll('.ai-annotation-badge').length, overlaysBefore - 1);
  assert.equal(ui.annotations.length, 2);

  // delete reindexes
  ui.handleRailAction('delete', { index: 1 });
  assert.equal(ui.annotations.length, 1);
  assert.equal(ui.annotations[0].index, 1);
  assert.equal(lastState().annotations[0].comment, "Le titre ne s'affiche pas");
  ui.deactivate();
});

test('panel state is fully serialisable (no DOM nodes) and Escape leaves annotate mode before anything else', () => {
  const { window, ui, states, clickElement } = createContentEnv();
  ui.activate();
  ui.handleRailAction('annotate');
  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'x', type: 'style' });
  for (const s of states()) assert.doesNotThrow(() => JSON.stringify(s));

  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.isInspecting, false, 'Escape leaves annotate mode');
  assert.equal(ui.isActive, true, 'but does not quit the annotator');
  assert.equal(ui.annotations.length, 1);
  ui.deactivate();
});

test('DOM change under saved annotations starts a new screen automatically when a menu/dialog opens', async () => {
  const { window, ui, lastState, clickElement } = createContentEnv();
  const savedWindow = ui.constructor.DOM_CHANGE_WINDOW_MS;
  ui.constructor.DOM_CHANGE_WINDOW_MS = 30;
  ui.activate();
  ui.handleRailAction('annotate');
  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'Premier écran', type: 'style' });
  await wait(100); // screenshot refresh

  // user leaves annotate mode and opens a menu: several nodes appear
  ui.handleRailAction('annotate');
  const host = window.document.getElementById('menu-host');
  const menu = window.document.createElement('ul');
  menu.setAttribute('role', 'menu');
  menu.textContent = 'Mon profil Mes commandes';
  host.appendChild(menu);
  for (let i = 0; i < 3; i++) {
    const item = window.document.createElement('li');
    item.setAttribute('role', 'menuitem');
    item.textContent = `Option ${i}`;
    menu.appendChild(item);
  }
  await wait(200);

  assert.equal(ui.session.pages.length, 1, 'the annotated screen is saved as screen #1');
  assert.equal(ui.session.pages[0].annotations[0].comment, 'Premier écran');
  assert.equal(ui.session.pages[0].dataUrl, 'data:image/png;base64,mockPngData');
  assert.equal(ui.annotations.length, 0, 'pins of the previous screen are cleared');
  assert.equal(ui.shadow.querySelectorAll('.ai-annotation-badge').length, 0);
  assert.equal(lastState().previousScreens, 1);
  assert.match(lastState().status.text, /écran #1 enregistré/);
  assert.equal(ui.lastScreenDecision.source, 'local');

  ui.constructor.DOM_CHANGE_WINDOW_MS = savedWindow;
  ui.deactivate();
});

test('ambient DOM noise (ticker, clock, spinner) does not create a screen; a dialog does', async () => {
  const { window, ui, lastState, clickElement } = createContentEnv();
  const saved = ui.constructor.DOM_CHANGE_WINDOW_MS;
  ui.constructor.DOM_CHANGE_WINDOW_MS = 30;
  ui.activate();
  ui.handleRailAction('annotate');
  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'Annotation', type: 'style' });
  await wait(100);

  const host = window.document.getElementById('menu-host');
  for (let i = 0; i < 4; i++) {
    const tick = window.document.createElement('span');
    tick.className = 'ticker-item';
    tick.textContent = `CAC ${i}`;
    host.appendChild(tick);
  }
  await wait(150);
  assert.equal(ui.session.pages.length, 0, 'ticker updates are noise: still the same screen');
  assert.equal(ui.annotations.length, 1);
  assert.equal(ui.lastScreenDecision.isNewScreen, false);

  const dialog = window.document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.id = 'settings-modal';
  host.appendChild(dialog);
  for (let i = 0; i < 3; i++) host.appendChild(window.document.createElement('button'));
  await wait(150);
  assert.equal(ui.session.pages.length, 1, 'a dialog opening is a new screen');
  assert.equal(ui.annotations.length, 0);
  assert.equal(lastState().previousScreens, 1);

  ui.constructor.DOM_CHANGE_WINDOW_MS = saved;
  ui.deactivate();
});

test('isNewScreen rule: structural elements and large areas count, ambient names and small updates do not', () => {
  const { ui } = createContentEnv();
  const UI = ui.constructor;
  assert.equal(UI.isNewScreen([{ kind: 'added', tag: 'div', role: 'dialog', width: 10, height: 10 }]), true);
  assert.equal(UI.isNewScreen([{ kind: 'removed', tag: 'main', role: '', width: 0, height: 0 }]), true);
  assert.equal(UI.isNewScreen([{ kind: 'added', tag: 'div', role: '', className: 'panel', width: 400, height: 300 }]), true);
  assert.equal(UI.isNewScreen([{ kind: 'added', tag: 'span', role: '', className: 'clock', width: 60, height: 16 }]), false);
  assert.equal(UI.isNewScreen([{ kind: 'added', tag: 'div', role: '', className: 'ad-slot', width: 900, height: 300 }]), false);
  assert.equal(UI.isNewScreen([{ kind: 'added', tag: 'div', role: 'status', className: '', width: 900, height: 300 }]), false);
  assert.equal(UI.isNewScreen([]), false);
});

test('DOM changes without saved annotations, and changes inside the overlay itself, never create screens', async () => {
  const { window, ui } = createContentEnv();
  const saved = ui.constructor.DOM_CHANGE_WINDOW_MS;
  ui.constructor.DOM_CHANGE_WINDOW_MS = 30;
  ui.activate();
  const host = window.document.getElementById('menu-host');
  for (let i = 0; i < 5; i++) host.appendChild(window.document.createElement('div'));
  await wait(120);
  assert.equal(ui.session.pages.length, 0);
  ui.constructor.DOM_CHANGE_WINDOW_MS = saved;
  ui.deactivate();
});

test('manual "Nouvel écran" captures the current screen and keeps the mode', async () => {
  const { window, ui, lastState, clickElement } = createContentEnv();
  ui.activate();
  ui.handleRailAction('annotate');

  await ui.nextScreen();
  assert.match(lastState().status.text, /Ajoutez au moins une annotation/);
  assert.equal(ui.session.pages.length, 0);

  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'A', type: 'style' });
  await ui.nextScreen();
  assert.equal(ui.session.pages.length, 1);
  assert.equal(ui.annotations.length, 0);
  assert.equal(ui.isInspecting, true);
  assert.equal(lastState().counterText, 'Écran #2 (1 point)');
  ui.deactivate();
});

test('export builds agent/github/json content for every screen, with types and selectors', async () => {
  const { window, ui, lastState, clickElement } = createContentEnv();
  ui.activate();
  ui.handleRailAction('annotate');
  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'Le bouton ne réagit pas', type: 'bug' });
  await ui.nextScreen();
  clickElement(window.document.getElementById('title'));
  ui.handleRailAction('save', { comment: 'Titre trop petit', type: 'style' });

  await ui.handleRailAction('export');
  const view = lastState().exportView;
  assert.ok(view, 'export view is part of the panel state');
  assert.equal(view.pages.length, 2);
  assert.deepEqual(view.pages.map(p => p.count), [1, 1]);
  assert.ok(view.pages.every(p => p.dataUrl.startsWith('data:image/png')));

  const { agent, github, json } = view.prompts;
  for (const needle of ['Étape #1', 'Étape #2', '[Point #1]', '[Point #2]', 'Type** : Bug', 'Type** : Style', 'Le bouton ne réagit pas']) {
    assert.ok(agent.includes(needle), `agent prompt must contain ${needle}`);
  }
  assert.match(github, /\[ \] \*\*\[Point #1\]\*\* \*\*Bug\*\*/);
  const parsed = JSON.parse(json);
  assert.equal(parsed.meta.totalAnnotations, 2);
  assert.equal(parsed.pages[0].annotations[0].type, 'bug');
  assert.equal(parsed.aiPrompt, agent);

  ui.handleRailAction('back');
  assert.equal(lastState().exportView, null);
  ui.handleRailAction('close');
  assert.equal(lastState().active, false);
});

test('closing the annotator clears overlays, session and notifies the background', () => {
  const { window, ui, sent, clickElement } = createContentEnv();
  ui.activate();
  ui.handleRailAction('annotate');
  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'x', type: 'style' });
  ui.handleRailAction('close');

  assert.equal(ui.isActive, false);
  assert.equal(window.DOMFreeze.isActive, false);
  assert.equal(ui.annotations.length, 0);
  assert.equal(ui.shadow.querySelectorAll('.ai-annotation-badge').length, 0);
  assert.ok(sent.some(m => m.action === 'ANNOTATOR_STOPPED'));
});

test('leaving the page (navigation) saves the annotated screen into the session and syncs it to the background', async () => {
  const { window, ui, sent, clickElement } = createContentEnv();
  ui.activate();
  ui.handleRailAction('annotate');
  clickElement(window.document.getElementById('cta-button'));
  ui.handleRailAction('save', { comment: 'Avant de naviguer', type: 'style' });
  await wait(120); // screenshot of the screen is taken after saving

  window.dispatchEvent(new window.Event('pagehide'));
  assert.equal(ui.session.pages.length, 1);
  assert.equal(ui.session.pages[0].annotations[0].comment, 'Avant de naviguer');
  assert.equal(ui.session.pages[0].dataUrl, 'data:image/png;base64,mockPngData');
  const sync = sent.filter(m => m.action === 'SESSION_SYNC').at(-1);
  assert.equal(sync.session.pages.length, 1);
  assert.equal(sync.session.isInspecting, true);
  ui.deactivate();
});

test('restoring a session on a new page continues numbering and the mode', () => {
  const { ui, lastState } = createContentEnv();
  ui.restoreFromSession({ id: 's', isActive: true, isInspecting: true, pages: [{ stepIndex: 1, annotations: [{ index: 1 }], dataUrl: 'x' }] });
  assert.equal(ui.isActive, true);
  assert.equal(ui.isInspecting, true);
  assert.equal(lastState().previousScreens, 1);
  assert.equal(lastState().counterText, 'Écran #2 (1 point)');
  ui.deactivate();
});
