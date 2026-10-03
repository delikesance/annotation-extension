/**
 * Side panel controller. Renders the annotation list pushed by the content script
 * (RAIL_STATE) and forwards button presses back to it (RAIL_ACTION).
 */
(() => {
  const TYPE_LABELS = { style: 'Style', bug: 'Bug', text: 'Texte' };
  const $ = (id) => document.getElementById(id);

  let tabId = null;
  const fromUrl = new URLSearchParams(location.search).get('tabId');
  if (fromUrl) tabId = Number(fromUrl);

  function render(state) {
    const active = Boolean(state && state.active);
    const list = $('list');
    list.textContent = '';

    $('status').classList.toggle('is-paused', active && Boolean(state.isPaused));
    $('status').classList.toggle('is-idle', !active);
    $('status-text').textContent = !active ? 'Inactif' : state.isPaused ? 'En pause' : 'Annotation';
    $('btn-pause-text').textContent = active && state.isPaused ? 'Reprendre' : 'Pause';
    $('btn-pause').classList.toggle('is-paused', active && Boolean(state.isPaused));
    ['btn-pause', 'btn-export', 'btn-next', 'btn-close'].forEach((id) => { $(id).disabled = !active; });

    if (!active) {
      $('counter').textContent = 'Cliquez sur l’icône de l’extension pour démarrer.';
      return;
    }

    $('counter').textContent = state.counterText || '';

    if (state.previousScreens > 0) {
      const note = document.createElement('div');
      note.className = 'note';
      const n = state.previousScreens;
      note.textContent = `${n} écran${n > 1 ? 's' : ''} déjà capturé${n > 1 ? 's' : ''}`;
      list.appendChild(note);
    }

    const items = state.annotations || [];
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Cliquez un élément de la page pour ajouter un repère.';
      list.appendChild(empty);
      return;
    }

    for (const ann of items) {
      const type = TYPE_LABELS[ann.type] ? ann.type : 'style';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'item';

      const pin = document.createElement('span');
      pin.className = 'pin';
      pin.textContent = ann.index;

      const body = document.createElement('span');
      body.className = 'item-body';

      const tag = document.createElement('span');
      tag.className = `type-tag type-${type}`;
      tag.textContent = TYPE_LABELS[type];

      const text = document.createElement('span');
      text.className = 'item-text' + (ann.comment ? '' : ' is-empty');
      text.textContent = ann.comment || '(Aucun commentaire)';

      const sel = document.createElement('span');
      sel.className = 'item-sel';
      sel.textContent = ann.selector || '';

      body.append(tag, text, sel);
      item.append(pin, body);
      item.addEventListener('click', () => send('open', { index: ann.index }));
      list.appendChild(item);
    }
  }

  function send(op, extra) {
    if (tabId == null) return Promise.resolve(null);
    return chrome.tabs.sendMessage(tabId, { action: 'RAIL_ACTION', op, ...(extra || {}) }).catch(() => null);
  }

  async function refresh() {
    if (tabId == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab ? tab.id : null;
    }
    if (tabId == null) return render(null);
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'GET_RAIL_STATE' });
      render(res && res.state ? res.state : null);
    } catch (_) {
      render(null);
    }
  }

  $('btn-pause').addEventListener('click', () => send('pause'));
  $('btn-export').addEventListener('click', () => send('export'));
  $('btn-next').addEventListener('click', () => send('next'));
  $('btn-close').addEventListener('click', () => send('close'));

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message && message.action === 'RAIL_STATE' && sender && sender.tab && sender.tab.id === tabId) {
      render(message.state);
    }
  });

  if (chrome.tabs.onActivated && !fromUrl) {
    chrome.tabs.onActivated.addListener((info) => { tabId = info.tabId; refresh(); });
  }

  render(null);
  refresh();
})();
