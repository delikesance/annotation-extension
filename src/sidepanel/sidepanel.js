/**
 * Side panel controller: renders the state pushed by the content script (RAIL_STATE)
 * and sends the user's actions back (RAIL_ACTION). Also owns clipboard and downloads.
 */
(() => {
  const TYPE_LABELS = { style: 'Style', bug: 'Bug', text: 'Texte' };
  const FORMATS = {
    agent: { name: 'Agent IA', desc: 'Prompt + contexte DOM', cta: "Copier pour l'Agent IA", sub: 'Prompt structuré avec sélecteurs & contexte' },
    github: { name: 'GitHub Issue', desc: 'Markdown prêt à coller', cta: 'Copier pour GitHub Issue', sub: 'Markdown prêt à coller dans une issue' },
    json: { name: 'JSON', desc: 'Données structurées', cta: 'Copier le JSON', sub: 'Données brutes structurées' }
  };
  const $ = (id) => document.getElementById(id);
  const insights = window.AnnotationInsights;

  let tabId = null;
  const fromUrl = new URLSearchParams(location.search).get('tabId');
  if (fromUrl) tabId = Number(fromUrl);

  let state = null;
  let editorKey = null; // identifies the annotation being edited, so typing is never clobbered by re-renders
  let editorNode = null;
  let exportKey = null;
  let exportFormat = 'agent';
  let selectedPage = 0;
  let statusTimer = null;
  let shownStatusId = null;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ------------------------------------------------------------------
  // Messaging
  // ------------------------------------------------------------------
  function send(op, extra) {
    if (tabId == null) return Promise.resolve(null);
    return chrome.tabs.sendMessage(tabId, { action: 'RAIL_ACTION', op, ...(extra || {}) }).catch(() => null);
  }

  let pushes = 0; // pushed states win over a slower GET_RAIL_STATE answer
  async function refresh() {
    const seen = pushes;
    if (tabId == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab ? tab.id : null;
    }
    if (tabId == null) return render(null);
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'GET_RAIL_STATE' });
      if (pushes === seen) render(res && res.state ? res.state : null);
    } catch (_) {
      if (pushes === seen) render(null);
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render(next) {
    state = next && next.active ? next : null;
    const active = Boolean(state);
    const annotating = active && state.mode === 'annotate';
    const exporting = active && Boolean(state.exportView);

    $('status').classList.toggle('is-annotate', annotating);
    $('status').classList.toggle('is-browse', active && !annotating);
    $('status-text').textContent = !active ? 'Inactif' : annotating ? 'Mode annotation' : 'Navigation libre';
    $('counter').textContent = active ? state.counterText : "Cliquez sur l'icône de l'extension pour démarrer.";

    $('btn-annotate').classList.toggle('is-active', annotating);
    $('btn-annotate-text').textContent = annotating ? "Terminer l'annotation" : 'Ajouter une annotation';
    ['btn-annotate', 'btn-export', 'btn-next', 'btn-close'].forEach((id) => { $(id).disabled = !active; });

    $('view-list').hidden = exporting;
    $('view-export').hidden = !exporting;

    renderStatusLine();
    if (!active) {
      $('list').textContent = '';
      editorKey = null;
      editorNode = null;
      return;
    }
    if (exporting) renderExport(); else renderList();
  }

  function renderStatusLine() {
    const line = $('status-line');
    const status = state && state.status;
    if (!status) {
      line.hidden = true;
      return;
    }
    if (shownStatusId === status.id) return;
    shownStatusId = status.id;
    line.textContent = status.text;
    line.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { line.hidden = true; }, 4000);
  }

  function renderList() {
    const list = $('list');
    const editing = state.editing;
    const key = editing ? `${editing.index}:${editing.isNew}` : null;
    if (key !== editorKey) {
      editorKey = key;
      editorNode = editing ? buildEditor(editing) : null;
    }

    list.textContent = '';
    if (state.previousScreens > 0) {
      const n = state.previousScreens;
      list.appendChild(el('div', 'note', `${n} écran${n > 1 ? 's' : ''} déjà capturé${n > 1 ? 's' : ''}`));
    }

    for (const ann of state.annotations) {
      if (editing && !editing.isNew && editing.index === ann.index) {
        list.appendChild(editorNode);
        continue;
      }
      list.appendChild(buildItem(ann));
    }
    if (editing && editing.isNew) list.appendChild(editorNode);

    if (state.annotations.length === 0 && !editing) {
      const hint = state.mode === 'annotate'
        ? 'Cliquez un élément de la page pour poser un repère. Vous pouvez en poser plusieurs.'
        : 'Cliquez « Ajouter une annotation », puis un élément de la page. Si la page change (menu, panneau, onglet), un nouvel écran est capturé automatiquement.';
      list.appendChild(el('div', 'empty', hint));
    }

    if (editing && editorNode) {
      const field = editorNode.querySelector('textarea');
      if (field && document.activeElement !== field) field.focus();
    }
  }

  function buildItem(ann) {
    const type = TYPE_LABELS[ann.type] ? ann.type : 'style';
    const item = el('button', 'item');
    item.type = 'button';
    const pin = el('span', 'pin', String(ann.index));
    const body = el('span', 'item-body');
    body.append(
      el('span', `type-tag type-${type}`, TYPE_LABELS[type]),
      el('span', 'item-text' + (ann.comment ? '' : ' is-empty'), ann.comment || '(Aucun commentaire)'),
      el('span', 'item-sel', ann.selector || '')
    );
    item.append(pin, body);
    item.addEventListener('click', () => send('open', { index: ann.index }));
    return item;
  }

  function buildEditor(editing) {
    const box = el('div', 'editor');
    box.dataset.index = String(editing.index);

    const head = el('div', 'editor-head');
    const who = el('div', 'who');
    who.append(el('span', 'pin', String(editing.index)), el('span', 'eyebrow', `Repère ${editing.index}`));
    head.append(who, el('span', 'editor-sel', editing.selector || `<${editing.tag}>`));

    const label = el('label', 'eyebrow', "Qu'est-ce qui doit changer ?");
    label.htmlFor = `comment-${editing.index}`;
    const field = el('textarea', 'field');
    field.id = `comment-${editing.index}`;
    field.value = editing.comment || '';
    field.placeholder = "Indiquez ce que l'IA doit analyser, modifier ou corriger sur cet élément...";

    let manualType = editing.type || null;
    const chips = el('div', 'chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', "Type d'annotation");
    chips.append(el('span', 'eyebrow', 'Type'));
    const chipButtons = Object.entries(TYPE_LABELS).map(([key, text]) => {
      const chip = el('button', `chip type-${key}`, text);
      chip.type = 'button';
      chip.dataset.type = key;
      chip.addEventListener('click', () => { manualType = key; paint(); });
      chips.appendChild(chip);
      return chip;
    });

    const nudge = el('div', 'nudge');
    nudge.setAttribute('role', 'status');
    nudge.append(el('b', '', 'Précisez :'), el('span', '', 'Quelle valeur cible, sur quel écran ou dans quel état ?'));

    const currentType = () => manualType || insights.suggestType(field.value);
    function paint() {
      const type = currentType();
      chipButtons.forEach((chip) => {
        const on = chip.dataset.type === type;
        chip.classList.toggle('active', on);
        chip.setAttribute('aria-pressed', String(on));
      });
      nudge.hidden = !insights.isVague(field.value);
    }
    field.addEventListener('input', paint);
    paint();

    const save = () => send('save', { comment: field.value, type: currentType() });
    const actions = el('div', 'editor-actions');
    const del = el('button', 'btn btn-small btn-ghost-danger', 'Supprimer');
    del.type = 'button';
    del.id = 'editor-delete';
    del.hidden = editing.isNew;
    del.addEventListener('click', () => send('delete', { index: editing.index }));
    const cancel = el('button', 'btn btn-small', 'Annuler');
    cancel.type = 'button';
    cancel.id = 'editor-cancel';
    cancel.addEventListener('click', () => send('cancel'));
    const saveBtn = el('button', 'btn btn-small btn-accent', 'Enregistrer');
    saveBtn.type = 'button';
    saveBtn.id = 'editor-save';
    saveBtn.addEventListener('click', save);
    const right = el('div', 'right');
    right.append(cancel, saveBtn);
    actions.append(del, right);

    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        save();
      }
    });

    box.append(head, label, field, chips, nudge, actions);
    return box;
  }

  // ------------------------------------------------------------------
  // Export view
  // ------------------------------------------------------------------
  function renderExport() {
    const view = state.exportView;
    const pages = view.pages || [];
    const key = `${view.id}`;
    if (key !== exportKey) {
      exportKey = key;
      selectedPage = Math.max(0, pages.length - 1);
    }
    const multi = pages.length > 1;
    const total = pages.reduce((acc, p) => acc + (p.count || 0), 0);
    $('export-badge').textContent = `${total} annotation${total > 1 ? 's' : ''}${multi ? ` • ${pages.length} écrans` : ''}`;

    const body = $('export-body');
    body.textContent = '';
    const page = pages[selectedPage] || pages[0] || { stepIndex: 1, dataUrl: '' };

    if (multi) {
      const tabs = el('div', 'screens');
      tabs.id = 'screens';
      pages.forEach((p, idx) => {
        const tab = el('button', 'screen-tab' + (idx === selectedPage ? ' active' : ''));
        tab.type = 'button';
        tab.dataset.pageIndex = String(idx);
        tab.append(el('span', 'screen-tab-title', `Écran ${p.stepIndex}`), el('span', 'screen-tab-badge', `${p.count} ann.`));
        tab.addEventListener('click', () => { selectedPage = idx; renderExport(); });
        tabs.appendChild(tab);
      });
      body.appendChild(tabs);
    }

    const preview = el('div', 'preview');
    const img = el('img');
    img.id = 'export-thumb';
    img.alt = "Aperçu de la capture annotée";
    img.src = page.dataUrl;
    preview.append(img, el('span', 'preview-tag', multi ? `Aperçu · écran #${page.stepIndex}` : 'Aperçu avec repères'));
    body.appendChild(preview);

    body.appendChild(el('span', 'eyebrow', 'Destination'));
    const dests = el('div', 'dests');
    Object.entries(FORMATS).forEach(([key2, f]) => {
      const dest = el('button', 'dest' + (key2 === exportFormat ? ' active' : ''));
      dest.type = 'button';
      dest.dataset.format = key2;
      dest.setAttribute('aria-pressed', String(key2 === exportFormat));
      dest.append(el('span', 'dest-name', f.name), el('span', 'dest-desc', f.desc));
      dest.addEventListener('click', () => { exportFormat = key2; renderExport(); });
      dests.appendChild(dest);
    });
    body.appendChild(dests);

    const fmt = FORMATS[exportFormat];
    const copy = el('button', 'btn btn-accent btn-copy');
    copy.type = 'button';
    copy.id = 'btn-copy';
    const copyText = el('span', 'copy-text');
    const main = el('span', 'copy-main', fmt.cta);
    copyText.append(main, el('span', 'copy-sub', fmt.sub));
    copy.appendChild(copyText);
    copy.addEventListener('click', async () => {
      await copyText_(view.prompts[exportFormat]);
      markDone(copy, main, fmt.cta, 'Copié dans le presse-papier');
    });
    body.appendChild(copy);

    const tools = el('div', 'tools');
    const tool = (id, label, handler) => {
      const b = el('button', 'btn', label);
      b.type = 'button';
      b.id = id;
      b.addEventListener('click', handler);
      tools.appendChild(b);
      return b;
    };
    tool('btn-copy-image', multi ? `Copier écran #${page.stepIndex}` : "Copier l'image", () => copyImage(page.dataUrl));
    tool('btn-dl-png', multi ? `Télécharger écran #${page.stepIndex}` : 'Télécharger PNG', () => downloadPng(page.dataUrl, multi ? page.stepIndex : null));
    if (multi) tool('btn-dl-all-png', `Tout télécharger (${pages.length})`, () => downloadAll(pages));
    tool('btn-dl-json', 'Télécharger JSON', () => downloadJson(view.payload));
    body.appendChild(tools);

    const details = el('details', 'prompt');
    details.id = 'prompt-details';
    const summary = el('summary', '', `Voir le contenu généré (${fmt.name})`);
    const pre = el('pre', '', view.prompts[exportFormat]);
    pre.id = 'prompt-preview';
    details.append(summary, pre);
    body.appendChild(details);

    const footer = $('export-footer');
    footer.textContent = '';
    const quit = el('button', 'btn btn-ghost-danger', 'Quitter et effacer');
    quit.type = 'button';
    quit.id = 'btn-quit-all';
    quit.addEventListener('click', () => send('close'));
    footer.appendChild(quit);
  }

  function markDone(button, textNode, original, doneText) {
    button.classList.add('is-done');
    textNode.textContent = doneText;
    setTimeout(() => {
      button.classList.remove('is-done');
      textNode.textContent = original;
    }, 2500);
  }

  // ------------------------------------------------------------------
  // Clipboard & downloads
  // ------------------------------------------------------------------
  async function copyText_(text) {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'COPY_TO_CLIPBOARD', type: 'text', text });
      if (res && res.success) return;
    } catch (_) {}
    try { await navigator.clipboard.writeText(text); } catch (_) {}
  }

  async function copyImage(dataUrl) {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'COPY_TO_CLIPBOARD', type: 'image', dataUrl });
      if (res && res.success) return;
    } catch (_) {}
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (_) {
      downloadPng(dataUrl);
    }
  }

  const host = () => (state && state.hostname ? state.hostname : 'page').replace(/[^a-z0-9]/gi, '_') || 'page';
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  async function download(url, filename) {
    try { await chrome.runtime.sendMessage({ action: 'DOWNLOAD_FILE', url, filename }); } catch (_) {}
  }

  function downloadPng(dataUrl, step) {
    const name = step ? `annotation-ecran-${step}-${host()}-${stamp()}.png` : `annotation-${host()}-${stamp()}.png`;
    return download(dataUrl, name);
  }

  async function downloadAll(pages) {
    const ts = stamp();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p || !p.dataUrl) continue;
      await download(p.dataUrl, `annotation-ecran-${p.stepIndex || i + 1}-${host()}-${ts}.png`);
      if (i < pages.length - 1) await new Promise((r) => setTimeout(r, 200));
    }
  }

  function downloadJson(payload) {
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    return download(url, `annotation-context-${host()}-${stamp()}.json`);
  }

  // ------------------------------------------------------------------
  // Update notice
  // ------------------------------------------------------------------
  async function checkUpdate() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'GET_UPDATE_INFO' });
      const update = res && res.update;
      if (!update) return;
      $('update-text').textContent = `Version ${String(update.version).replace(/^v/, '')} disponible`;
      $('update-banner').hidden = false;
      $('btn-update').onclick = () => {
        chrome.runtime.sendMessage({ action: 'OPEN_URL', url: update.downloadUrl || update.releaseUrl });
      };
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  $('btn-annotate').addEventListener('click', () => send('annotate'));
  $('btn-export').addEventListener('click', () => send('export'));
  $('btn-next').addEventListener('click', () => send('next'));
  $('btn-close').addEventListener('click', () => send('close'));
  $('btn-back').addEventListener('click', () => send('back'));

  document.addEventListener('keydown', (e) => {
    if (!state) return;
    const t = e.target;
    const typing = Boolean(t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable));
    if (e.key === 'Escape') {
      if (state.editing) send('cancel');
      else if (state.exportView) send('back');
      else if (state.mode === 'annotate') send('annotate');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      send('export');
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || state.exportView) return;
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); send('annotate'); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); send('next'); }
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message && message.action === 'RAIL_STATE' && sender && sender.tab && sender.tab.id === tabId) {
      pushes++;
      render(message.state);
    }
  });

  if (chrome.tabs.onActivated && !fromUrl) {
    chrome.tabs.onActivated.addListener((info) => { tabId = info.tabId; refresh(); });
  }

  render(null);
  refresh();
  checkUpdate();
})();
