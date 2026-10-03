/**
 * UI Manager for AI Web Annotator
 * Manages the Shadow DOM lifecycle, hover inspector, numbered badges,
 * inline comment card, floating island HUD, Pause mode (free navigation),
 * and Multi-Page user journey sessions.
 */

const ANNOTATION_TYPES = { style: 'Style', bug: 'Bug', text: 'Texte' };

/**
 * Local heuristics behind the comment popover's suggestions. They are the seam
 * where a semantic model (e.g. a TypeSafe Choice for the type, a Noul for
 * "too vague") can later replace the keyword rules without touching the UI.
 */
const AnnotationInsights = {
  suggestType(comment) {
    const c = (comment || '').toLowerCase();
    if (/(bug|erreur|cass|ne marche|ne fonctionne|ne r[ée]agit|plante|bloqu|404|500|crash|inactif|ne s'affiche)/.test(c)) return 'bug';
    if (/(texte|libell|reformul|traduc|faute|orthograph|titre|wording|copy|phrase|mot )/.test(c)) return 'text';
    return 'style';
  },
  isVague(comment) {
    const c = (comment || '').trim().toLowerCase();
    if (!c) return false;
    const words = c.split(/\s+/).length;
    const hasSpecifics = /\d|px|rem|%|#[0-9a-f]{3,6}|[«"“].+[»"”]|\b(en|de|à|vers|par)\s+\w+/.test(c);
    const vagueWord = /(trop|bizarre|moche|pas bien|à revoir|a revoir|améliorer|ameliorer|mieux|joli|propre)/.test(c);
    return words <= 3 || (vagueWord && !hasSpecifics);
  }
};

class AnnotatorUIManager {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.hud = null;
    this.highlightBox = null;
    this.highlightLabel = null;
    this.activeCommentCard = null;

    this.annotations = []; // Current page annotations: { id, index, element, comment, badgeEl, boxEl, arrowEl, metadata }
    this.hoveredElement = null;
    this.selectedAnnotation = null;
    this.isInspecting = false;
    this.isPaused = false;
    this.isEditingComment = false;
    this.activeExportModal = null;
    this.lastExportData = null;
    this.currentExportFormat = 'agent'; // 'agent' | 'github' | 'json'

    // Multi-page session tracking
    this.session = {
      id: null,
      isActive: false,
      activeTabId: null,
      pages: [], // Array of { stepIndex, url, title, dataUrl, annotations }
      startingIndex: 1
    };

    this.boundOnMouseMove = this.onMouseMove.bind(this);
    this.boundOnClick = this.onClick.bind(this);
    this.boundOnKeyDown = this.onKeyDown.bind(this);
  }

  init() {
    if (this.host) return;

    this.host = document.createElement('div');
    this.host.id = 'ai-web-annotator-root';
    this.host.style.position = 'absolute';
    this.host.style.top = '0';
    this.host.style.left = '0';
    this.host.style.width = '100%';
    this.host.style.height = '100%';
    this.host.style.pointerEvents = 'none';
    this.host.style.zIndex = '2147483647';
    (document.body || document.documentElement).appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: 'open' });

    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('content/styles.css')
      : 'content/styles.css';
    this.shadow.appendChild(styleLink);

    this.createHighlightBox();
    this.createHUD();
  }

  createHighlightBox() {
    this.highlightBox = document.createElement('div');
    this.highlightBox.className = 'ai-highlight-box';

    this.highlightLabel = document.createElement('span');
    this.highlightLabel.className = 'ai-highlight-label';
    this.highlightBox.appendChild(this.highlightLabel);

    this.shadow.appendChild(this.highlightBox);
  }

  createHUD() {
    this.hud = document.createElement('div');
    this.hud.className = 'ai-annotator-hud ai-hud-collapsed'; // starts as a pill so the page stays fully reachable
    this.hud.innerHTML = `
      <div class="ai-rail-header">
        <div class="ai-rail-title-row">
          <div class="ai-hud-status" id="ai-hud-status-badge">
            <span class="ai-pulse-dot"></span>
            <span class="ai-hud-status-text" id="ai-hud-status-text">Annotation</span>
          </div>
          <div class="ai-rail-tools">
            <button class="ai-hud-btn ai-hud-btn-pause" id="ai-btn-pause" title="Mettre en pause pour naviguer librement (touche P)">
              <span id="ai-btn-pause-text">Pause</span>
              <span class="ai-kbd">P</span>
            </button>
            <button class="ai-hud-btn-icon ai-hud-btn-minimize" id="ai-btn-minimize" aria-label="Réduire ou agrandir le panneau" title="Ouvrir / réduire le panneau">
              <svg class="ai-icon-collapse" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>
              <span class="ai-open-label">Ouvrir</span>
            </button>
            <button class="ai-hud-btn-icon ai-hud-btn-close" id="ai-btn-cancel" aria-label="Quitter le mode annotation" title="Quitter le mode annotation (Échap)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="ai-hud-counter" id="ai-counter">0 annotation</div>
      </div>
      <div class="ai-rail-list" id="ai-rail-list"></div>
      <div class="ai-rail-footer">
        <button class="ai-hud-btn ai-hud-btn-primary" id="ai-btn-export" title="Exporter les annotations (Ctrl+E)">
          <span>Exporter la session</span>
          <span class="ai-kbd">Ctrl E</span>
        </button>
        <button class="ai-hud-btn ai-hud-btn-next" id="ai-btn-next-screen" title="Valider cet écran et passer au suivant (touche N)">
          <span>Écran suivant</span>
          <span class="ai-kbd">N</span>
        </button>
      </div>
    `;

    this.hud.querySelector('#ai-btn-pause').addEventListener('click', () => this.togglePause());
    this.hud.querySelector('#ai-btn-next-screen').addEventListener('click', () => this.nextScreen());
    this.hud.querySelector('#ai-btn-export').addEventListener('click', () => this.finishAndShowExportModal());
    this.hud.querySelector('#ai-btn-cancel').addEventListener('click', () => this.deactivate());
    this.hud.querySelector('#ai-btn-minimize').addEventListener('click', () => {
      this.hud.classList.toggle('ai-hud-collapsed');
      this.syncPageOffset();
    });

    this.shadow.appendChild(this.hud);
    this.renderRail();
    this.checkUpdateStatus();
  }

  setHudVisible(visible) {
    if (!this.hud) return;
    this.hud.style.display = visible ? 'flex' : 'none';
    this.syncPageOffset();
  }

  /** While the rail is open, shrink the page so the rail sits to the right of it instead of covering it. */
  syncPageOffset() {
    const root = document.documentElement;
    const open = this.hud && this.hud.style.display !== 'none'
      && !this.hud.classList.contains('ai-hud-collapsed')
      && this.host && this.host.style.display !== 'none';
    if (open) {
      root.style.setProperty('width', 'calc(100% - 340px)', 'important');
    } else {
      root.style.removeProperty('width');
    }
  }

  /** Rebuilds the annotation list shown in the rail. */
  renderRail() {
    const list = this.hud && this.hud.querySelector('#ai-rail-list');
    if (!list) return;

    list.textContent = '';
    const previous = (this.session && this.session.pages) ? this.session.pages.length : 0;
    if (previous > 0) {
      const note = document.createElement('div');
      note.className = 'ai-rail-previous';
      note.textContent = `${previous} écran${previous > 1 ? 's' : ''} déjà capturé${previous > 1 ? 's' : ''}`;
      list.appendChild(note);
    }

    const pending = this.annotations.filter(a => a.metadata || a.comment !== undefined);
    if (pending.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-rail-empty';
      empty.textContent = 'Cliquez un élément de la page pour ajouter un repère.';
      list.appendChild(empty);
      return;
    }

    for (const ann of pending) {
      const type = ANNOTATION_TYPES[ann.type] ? ann.type : 'style';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ai-rail-item';

      const pin = document.createElement('span');
      pin.className = 'ai-rail-pin';
      pin.textContent = ann.index;

      const body = document.createElement('span');
      body.className = 'ai-rail-item-body';

      const tag = document.createElement('span');
      tag.className = `ai-type-tag ai-type-${type}`;
      tag.textContent = ANNOTATION_TYPES[type];

      const text = document.createElement('span');
      text.className = 'ai-rail-item-text' + (ann.comment ? '' : ' is-empty');
      text.textContent = ann.comment || '(Aucun commentaire)';

      const sel = document.createElement('span');
      sel.className = 'ai-rail-item-sel';
      sel.textContent = (ann.metadata && ann.metadata.element && ann.metadata.element.cssSelector)
        || ann.element.tagName.toLowerCase();

      body.append(tag, text, sel);
      item.append(pin, body);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.isInspecting) return;
        this.selectedAnnotation = ann;
        this.openCommentModal(ann);
      });
      list.appendChild(item);
    }
  }

  async checkUpdateStatus() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const response = await chrome.runtime.sendMessage({ action: 'GET_UPDATE_INFO' });
        if (response && response.update) {
          this.showUpdateBadge(response.update);
        }
      }
    } catch (_) {}
  }

  showUpdateBadge(update) {
    if (!update || !this.hud) return;
    let updateBtn = this.hud.querySelector('#ai-btn-update');
    if (!updateBtn) {
      updateBtn = document.createElement('button');
      updateBtn.className = 'ai-hud-btn ai-hud-btn-update';
      updateBtn.id = 'ai-btn-update';
      updateBtn.title = `Nouvelle version v${update.version} disponible ! Cliquez pour voir ou télécharger.`;
      updateBtn.innerHTML = `
        <span class="ai-update-tag">MàJ v${update.version}</span>
      `;
      updateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showUpdateModal(update);
      });

      const exportBtn = this.hud.querySelector('#ai-btn-export');
      if (exportBtn && exportBtn.parentNode) {
        exportBtn.parentNode.insertBefore(updateBtn, exportBtn);
      } else {
        this.hud.appendChild(updateBtn);
      }
    }
  }

  showUpdateModal(update) {
    if (!this.shadow) return;
    const existing = this.shadow.querySelector('.ai-update-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'ai-update-modal-backdrop';
    backdrop.innerHTML = `
      <div class="ai-update-modal-card">
        <div class="ai-update-modal-header">
          <div class="ai-update-header-title">
            
            <div>
              <h3 style="margin:0;font-size:15px;font-weight:700;color:#1C1B19;">Mise à jour disponible</h3>
              <p style="margin:2px 0 0;font-size:12px;color:#5F5B54;">Version v${String(update.version || update.tagName).replace(/^v/, '')}</p>
            </div>
          </div>
          <button class="ai-update-close-btn" id="ai-update-close" title="Fermer">✕</button>
        </div>
        <div class="ai-update-modal-body">
          <p style="margin:0 0 10px;font-size:13px;color:#3a3835;line-height:1.5;">
            Une nouvelle version de <strong>AI Web Annotator</strong> est disponible sur Forgejo !
          </p>
          ${update.releaseNotes ? `
            <div class="ai-update-notes">
              <div style="font-size:11px;font-weight:600;color:#5F5B54;text-transform:uppercase;margin-bottom:4px;">Notes de version :</div>
              <pre style="margin:0;font-size:12px;color:#1C1B19;white-space:pre-wrap;font-family:inherit;">${this.escapeHtml(update.releaseNotes)}</pre>
            </div>
          ` : ''}
        </div>
        <div class="ai-update-modal-footer">
          <a href="${update.downloadUrl || update.releaseUrl}" target="_blank" class="ai-update-btn-download" id="ai-update-download-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>Télécharger (.zip)</span>
          </a>
          <a href="${update.releaseUrl || update.downloadUrl}" target="_blank" class="ai-update-btn-view" id="ai-update-release-btn">
            <span>Voir la Release</span>
          </a>
        </div>
      </div>
    `;

    backdrop.querySelector('#ai-update-close').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    const dlBtn = backdrop.querySelector('#ai-update-download-btn');
    if (dlBtn) {
      dlBtn.addEventListener('click', () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: 'OPEN_URL', url: update.downloadUrl || update.releaseUrl });
        }
      });
    }

    const relBtn = backdrop.querySelector('#ai-update-release-btn');
    if (relBtn) {
      relBtn.addEventListener('click', () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: 'OPEN_URL', url: update.releaseUrl || update.downloadUrl });
        }
      });
    }

    this.shadow.appendChild(backdrop);
  }

  updateCounter() {
    const counter = this.shadow.getElementById('ai-counter');
    if (!counter) return;

    const previousCount = (this.session && this.session.pages)
      ? this.session.pages.reduce((acc, p) => acc + (p.annotations ? p.annotations.length : 0), 0)
      : 0;

    const totalCount = previousCount + this.annotations.length;
    const currentScreen = (this.session && this.session.pages) ? this.session.pages.length + 1 : 1;

    if (currentScreen > 1) {
      counter.textContent = `Écran #${currentScreen} (${totalCount} point${totalCount > 1 ? 's' : ''})`;
    } else {
      counter.textContent = `${totalCount} annotation${totalCount > 1 ? 's' : ''}`;
    }
    this.renderRail();
  }

  activate() {
    this.init();
    this.isInspecting = true;
    this.isPaused = false;

    // Start or resume multi-page session
    if (!this.session.isActive) {
      this.session.id = 'session_' + Date.now();
      this.session.isActive = true;
      this.session.pages = [];
      this.session.startingIndex = 1;
      this.syncSessionToStorage();
    }

    if (typeof window !== 'undefined' && window.DOMFreeze) {
      window.DOMFreeze.enable();
    }

    window.addEventListener('mousemove', this.boundOnMouseMove, true);
    window.addEventListener('click', this.boundOnClick, true);
    window.addEventListener('keydown', this.boundOnKeyDown, true);

    this.host.style.display = 'block';
    this.updateHUDState();
    this.checkUpdateStatus();
    this.showToast('Mode Annotation activé : Cliquez sur un élément pour annoter.');
  }

  togglePause() {
    if (this.isPaused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  pause() {
    if (!this.isInspecting && !this.isPaused) return;
    this.isPaused = true;
    this.isInspecting = false;

    if (this.highlightBox) {
      this.highlightBox.style.display = 'none';
      this.hoveredElement = null;
    }

    if (this.activeCommentCard) {
      this.cancelActiveComment();
    }

    // Unfreeze DOM so user can freely click, scroll, navigate, fill forms
    if (typeof window !== 'undefined' && window.DOMFreeze) {
      window.DOMFreeze.disable();
    }

    this.updateHUDState();
    this.syncSessionToStorage();
    this.showToast('Mode Pause activé : Vous pouvez interagir et naviguer librement.');
  }

  resume() {
    this.isPaused = false;
    this.isInspecting = true;

    // Re-freeze DOM for element inspection
    if (typeof window !== 'undefined' && window.DOMFreeze) {
      window.DOMFreeze.enable();
    }

    this.updateHUDState();
    this.syncSessionToStorage();
    this.showToast('Mode Annotation réactivé : Cliquez sur un élément pour annoter.');
  }

  async nextScreen() {
    if (this.annotations.length === 0) {
      this.showToast('Ajoutez au moins une annotation sur cet écran avant de passer au suivant.');
      return;
    }

    if (this.activeCommentCard) {
      this.closeCommentModal();
    }

    this.showToast('Capture et validation de l\'écran...');

    if (this.hud) this.setHudVisible(false);
    if (this.highlightBox) this.highlightBox.style.display = 'none';

    await new Promise(r => setTimeout(r, 120));

    let screenDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const response = await chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });
        if (response && response.success && response.dataUrl) {
          screenDataUrl = response.dataUrl;
        }
      }
    } catch (_) {}

    if (this.hud) this.setHudVisible(true);

    if (!this.session.pages) {
      this.session.pages = [];
    }

    const stepIndex = this.session.pages.length + 1;

    this.session.pages.push({
      stepIndex: stepIndex,
      url: window.location.href,
      title: document.title,
      dataUrl: screenDataUrl,
      annotations: this.annotations.map(a => ({
        index: a.index,
        comment: a.comment,
        type: a.type || 'style',
        metadata: a.metadata || { element: { tag: a.element.tagName } }
      }))
    });

    // Clear visual annotations on current screen
    for (const ann of this.annotations) {
      if (ann.badgeEl) ann.badgeEl.remove();
      if (ann.boxEl) ann.boxEl.remove();
      if (ann.arrowEl) ann.arrowEl.remove();
    }
    this.annotations = [];

    // Switch to free navigation mode so user can scroll/click/navigate to next view
    this.pause();

    this.updateCounter();
    this.syncSessionToStorage();
    this.showToast(`Écran #${stepIndex} validé ! Naviguez librement et reprenez (P) pour l'écran #${stepIndex + 1}.`);
  }

  updateHUDState() {
    if (!this.hud) return;

    const statusBadge = this.hud.querySelector('#ai-hud-status-badge');
    const statusText = this.hud.querySelector('#ai-hud-status-text');
    const pauseBtn = this.hud.querySelector('#ai-btn-pause');
    const pauseText = this.hud.querySelector('#ai-btn-pause-text');

    if (this.isPaused) {
      this.hud.classList.add('ai-hud-paused');
      if (statusBadge) statusBadge.classList.add('is-paused');
      if (statusText) statusText.textContent = 'En pause';
      if (pauseBtn) {
        pauseBtn.classList.add('is-paused');
        pauseBtn.innerHTML = `<span id="ai-btn-pause-text">Reprendre</span><span class="ai-kbd">P</span>`;
      }
    } else {
      this.hud.classList.remove('ai-hud-paused');
      if (statusBadge) statusBadge.classList.remove('is-paused');
      if (statusText) statusText.textContent = 'Annotation';
      if (pauseBtn) {
        pauseBtn.classList.remove('is-paused');
        pauseBtn.innerHTML = `<span id="ai-btn-pause-text">Pause</span><span class="ai-kbd">P</span>`;
      }
    }

    this.updateCounter();
  }

  restoreFromSession(sessionData) {
    if (!sessionData || !sessionData.isActive) return;

    this.session = sessionData;
    const previousPointsCount = this.session.pages.reduce((acc, p) => acc + (p.annotations ? p.annotations.length : 0), 0);
    this.session.startingIndex = previousPointsCount + 1;

    this.init();
    this.host.style.display = 'block';

    // Start in active or paused state
    if (sessionData.isPaused) {
      this.pause();
    } else {
      this.activate();
    }

    this.updateCounter();
    this.showToast(`Étape #${this.session.pages.length + 1} de la session : ${document.title}`);
  }

  async syncSessionToStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;

    try {
      const payload = {
        id: this.session.id,
        isActive: this.session.isActive,
        isPaused: this.isPaused,
        pages: this.session.pages,
        currentPage: {
          url: window.location.href,
          title: document.title,
          annotationsCount: this.annotations.length
        }
      };

      await chrome.storage.local.set({ ai_web_annotator_session: payload });
    } catch (_) {}
  }

  async clearSessionStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.remove(['ai_web_annotator_session']);
      } catch (_) {}
    }
    this.session = { id: null, isActive: false, activeTabId: null, pages: [], startingIndex: 1 };
  }

  deactivate() {
    this.isInspecting = false;
    this.isPaused = false;
    this.isEditingComment = false;
    this.selectedAnnotation = null;

    if (typeof window !== 'undefined' && window.DOMFreeze) {
      window.DOMFreeze.disable();
    }

    window.removeEventListener('mousemove', this.boundOnMouseMove, true);
    window.removeEventListener('click', this.boundOnClick, true);
    window.removeEventListener('keydown', this.boundOnKeyDown, true);

    if (this.highlightBox) {
      this.highlightBox.style.display = 'none';
    }

    if (this.activeCommentCard) {
      this.activeCommentCard.remove();
      this.activeCommentCard = null;
    }

    if (this.activeExportModal) {
      this.activeExportModal.remove();
      this.activeExportModal = null;
    }

    for (const ann of this.annotations) {
      if (ann.badgeEl) ann.badgeEl.remove();
      if (ann.boxEl) ann.boxEl.remove();
      if (ann.arrowEl) ann.arrowEl.remove();
    }
    this.annotations = [];
    this.updateCounter();

    if (this.host) {
      this.host.style.display = 'none';
    }
    this.syncPageOffset();

    this.clearSessionStorage();

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'SET_BADGE', text: '' }).catch(() => {});
    }
  }

  onMouseMove(e) {
    if (!this.isInspecting || this.isPaused || this.isEditingComment) return;

    const elements = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
    const target = elements.find(el => el !== this.host && !this.host.contains(el));

    if (!target || target === document.body || target === document.documentElement) {
      this.highlightBox.style.display = 'none';
      this.hoveredElement = null;
      return;
    }

    this.hoveredElement = target;
    const rect = target.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    this.highlightBox.style.display = 'block';
    this.highlightBox.style.top = `${rect.top + scrollY}px`;
    this.highlightBox.style.left = `${rect.left + scrollX}px`;
    this.highlightBox.style.width = `${rect.width}px`;
    this.highlightBox.style.height = `${rect.height}px`;

    const tag = target.tagName.toLowerCase();
    const id = target.id ? `#${target.id}` : '';
    const firstClass = target.classList.length > 0 ? `.${target.classList[0]}` : '';
    this.highlightLabel.textContent = `<${tag}${id}${firstClass}>`;
  }

  onClick(e) {
    if (!this.isInspecting || this.isPaused) return;

    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(this.host)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (this.isEditingComment) {
      return;
    }

    let target = this.hoveredElement;
    if (!target) {
      const elements = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
      target = elements.find(el => el !== this.host && !this.host.contains(el));
      if (!target && e.target && e.target !== this.host && !this.host.contains(e.target)) {
        target = e.target;
      }
    }

    if (!target || target === document.body || target === document.documentElement) {
      return;
    }

    this.createAnnotationPoint(target);
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.activeExportModal) {
        this.activeExportModal.remove();
        this.activeExportModal = null;
      } else if (this.activeCommentCard) {
        this.cancelActiveComment();
      } else {
        this.deactivate();
      }
      return;
    }

    // 'P' key toggles Pause (when not typing in an input/textarea)
    if ((e.key === 'p' || e.key === 'P') && !this.isEditingComment && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      this.togglePause();
      return;
    }

    // 'N' key validates current screen and prepares next screen
    if ((e.key === 'n' || e.key === 'N') && !this.isEditingComment && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      this.nextScreen();
      return;
    }

    // Ctrl+E or Cmd+E triggers export
    if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      const totalPoints = (this.session.pages.length > 0) || (this.annotations.length > 0);
      if (!this.activeExportModal && totalPoints) {
        this.finishAndShowExportModal();
      }
      return;
    }

    // Delete or Backspace removes selected annotation if not editing text
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedAnnotation && !this.isEditingComment) {
      e.preventDefault();
      this.deleteAnnotation(this.selectedAnnotation);
    }
  }

  createAnnotationPoint(targetElement) {
    const previousPointsCount = (this.session && this.session.pages)
      ? this.session.pages.reduce((acc, p) => acc + (p.annotations ? p.annotations.length : 0), 0)
      : 0;

    const nextIndex = previousPointsCount + this.annotations.length + 1;
    const rect = targetElement.getBoundingClientRect ? targetElement.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 };
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    this.highlightBox.style.display = 'none';

    const elemLeft = rect.left + scrollX;
    const elemTop = rect.top + scrollY;
    const elemWidth = Math.max(rect.width, 12);
    const elemHeight = Math.max(rect.height, 12);

    const boxEl = document.createElement('div');
    boxEl.className = 'ai-annotated-target-box';
    boxEl.style.top = `${elemTop}px`;
    boxEl.style.left = `${elemLeft}px`;
    boxEl.style.width = `${elemWidth}px`;
    boxEl.style.height = `${elemHeight}px`;
    this.shadow.appendChild(boxEl);

    let tx = elemLeft + 2;
    let ty = elemTop + 2;
    let bx = elemLeft - 36;
    let by = elemTop - 36;

    if (rect.top < 50) {
      by = elemTop + elemHeight + 36;
      ty = elemTop + elemHeight - 2;
    }
    if (rect.left < 50) {
      bx = elemLeft + elemWidth + 36;
      tx = elemLeft + elemWidth - 2;
    }

    bx = Math.max(20, bx);
    by = Math.max(20, by);

    const arrowEl = this.createArrowElement(nextIndex, bx, by, tx, ty);
    this.shadow.appendChild(arrowEl);

    const badgeEl = document.createElement('div');
    badgeEl.className = 'ai-annotation-badge';
    badgeEl.textContent = nextIndex;
    badgeEl.style.top = `${by}px`;
    badgeEl.style.left = `${bx}px`;
    badgeEl.title = `Annotation #${nextIndex} (Cliquer pour modifier)`;
    this.shadow.appendChild(badgeEl);

    const annotation = {
      id: Date.now() + Math.random(),
      index: nextIndex,
      element: targetElement,
      comment: '',
      badgeEl: badgeEl,
      boxEl: boxEl,
      arrowEl: arrowEl,
      metadata: null
    };

    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectedAnnotation = annotation;
      this.openCommentModal(annotation);
    });

    this.selectedAnnotation = annotation;
    this.openCommentModal(annotation, true);
  }

  createArrowElement(index, bx, by, tx, ty) {
    const dx = tx - bx;
    const dy = ty - by;
    const dist = Math.hypot(dx, dy);

    const startX = dist > 18 ? bx + (dx / dist) * 16 : bx;
    const startY = dist > 18 ? by + (dy / dist) * 16 : by;
    const endX = tx;
    const endY = ty;

    const minX = Math.min(startX, endX) - 20;
    const minY = Math.min(startY, endY) - 20;
    const width = Math.max(Math.abs(endX - startX) + 40, 40);
    const height = Math.max(Math.abs(endY - startY) + 40, 40);

    const lx1 = startX - minX;
    const ly1 = startY - minY;
    const lx2 = endX - minX;
    const ly2 = endY - minY;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'ai-annotation-arrow');
    svg.style.position = 'absolute';
    svg.style.left = `${minX}px`;
    svg.style.top = `${minY}px`;
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    svg.style.pointerEvents = 'none';
    svg.style.overflow = 'visible';
    svg.style.zIndex = '2147483643';

    const markerId = `ai-arrow-${index}-${Date.now()}`;
    const markerIdWhite = `${markerId}-w`;

    svg.innerHTML = `
      <defs>
        <marker id="${markerIdWhite}" markerWidth="10" markerHeight="10" refX="8" refY="3.5" orient="auto">
          <polygon points="0 0, 9 3.5, 0 7" fill="#ffffff" />
        </marker>
        <marker id="${markerId}" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#C9400F" />
        </marker>
      </defs>
      <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#ffffff" stroke-width="5" stroke-linecap="round" marker-end="url(#${markerIdWhite})" />
      <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#C9400F" stroke-width="2.5" stroke-linecap="round" marker-end="url(#${markerId})" />
    `;

    return svg;
  }

  openCommentModal(annotation, isNew = false) {
    if (this.isEditingComment && this.currentEditingAnnotation && this.currentEditingAnnotation !== annotation) {
      this.cancelActiveComment();
    } else if (this.activeCommentCard) {
      this.activeCommentCard.remove();
    }

    this.isEditingComment = true;
    const rect = annotation.element.getBoundingClientRect ? annotation.element.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 };
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    const card = document.createElement('div');
    card.className = 'ai-comment-card';

    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;

    const badgeTop = annotation.badgeEl ? (parseFloat(annotation.badgeEl.style.top) || (rect.top + scrollY)) : (rect.top + scrollY);
    const badgeLeft = annotation.badgeEl ? (parseFloat(annotation.badgeEl.style.left) || (rect.left + scrollX)) : (rect.left + scrollX);

    let modalTop = badgeTop + 24;
    let modalLeft = badgeLeft + 16;

    if (modalLeft - scrollX + 380 > viewportWidth - 16) {
      modalLeft = Math.max(scrollX + 16, scrollX + viewportWidth - 380 - 16);
    }
    if (rect.top + 220 > viewportHeight && rect.top > 180) {
      modalTop = Math.max(scrollY + 16, badgeTop - 190);
    }

    card.style.top = `${modalTop}px`;
    card.style.left = `${modalLeft}px`;

    const tagStr = annotation.element.tagName.toLowerCase();
    card.innerHTML = `
      <div class="ai-comment-header">
        <div class="ai-comment-title">
          <span>Repère ${annotation.index}</span>
          <span class="ai-comment-tag">&lt;${tagStr}&gt;</span>
        </div>
        <div class="ai-comment-shortcut-badge">Échap pour annuler</div>
      </div>
      <textarea class="ai-comment-textarea" aria-label="Ce qui doit changer" placeholder="Indiquez ce que l'IA doit analyser, modifier ou corriger sur cet élément...">${this.escapeHtml(annotation.comment || '')}</textarea>
      <div class="ai-comment-types" role="group" aria-label="Type d'annotation">
        <span class="ai-comment-types-label">Type</span>
        ${Object.entries(ANNOTATION_TYPES).map(([key, label]) => `<button type="button" class="ai-type-chip ai-type-${key}" data-type="${key}">${label}</button>`).join('')}
      </div>
      <div class="ai-comment-nudge" role="status"><b>Précisez :</b><span>Quelle valeur cible, sur quel écran ou dans quel état ?</span></div>
      <div class="ai-comment-footer">
        <span class="ai-comment-hint">Entrée pour valider</span>
        <div class="ai-comment-actions">
          <button class="ai-btn-sm ai-btn-delete" id="ai-modal-delete">${isNew ? 'Annuler' : 'Supprimer'}</button>
          <button class="ai-btn-sm ai-btn-save" id="ai-modal-save">Enregistrer</button>
        </div>
      </div>
    `;

    const textarea = card.querySelector('textarea');
    const saveBtn = card.querySelector('#ai-modal-save');
    const deleteBtn = card.querySelector('#ai-modal-delete');

    const nudge = card.querySelector('.ai-comment-nudge');
    const chips = card.querySelectorAll('.ai-type-chip');
    let chosenType = annotation.type || null; // null until the user picks one manually
    const paintType = (type) => chips.forEach(c => {
      const on = c.getAttribute('data-type') === type;
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', String(on));
    });
    const refreshInsights = () => {
      if (!chosenType) paintType(AnnotationInsights.suggestType(textarea.value));
      nudge.classList.toggle('visible', AnnotationInsights.isVague(textarea.value));
    };
    chips.forEach(chip => chip.addEventListener('click', () => {
      chosenType = chip.getAttribute('data-type');
      paintType(chosenType);
    }));
    textarea.addEventListener('input', refreshInsights);
    refreshInsights();

    const saveAction = () => {
      const text = textarea.value.trim();
      annotation.comment = text;
      annotation.type = chosenType || AnnotationInsights.suggestType(text);

      if (typeof window !== 'undefined' && window.SelectorGenerator) {
        annotation.metadata = window.SelectorGenerator.getElementMetadata(
          annotation.element,
          annotation.index,
          annotation.comment
        );
      }

      if (isNew && !this.annotations.includes(annotation)) {
        this.annotations.push(annotation);
      }

      this.closeCommentModal();
      this.updateCounter();
      this.syncSessionToStorage();

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'SET_BADGE',
          text: String(this.annotations.length),
          color: '#C9400F'
        }).catch(() => {});
      }
    };

    const deleteAction = () => {
      this.deleteAnnotation(annotation);
    };

    saveBtn.addEventListener('click', saveAction);
    deleteBtn.addEventListener('click', deleteAction);

    // Stop mouse/pointer events from bubbling to page freeze handlers
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click'].forEach(evtType => {
      card.addEventListener(evtType, (e) => {
        e.stopPropagation();
      });
    });

    ['keydown', 'keyup', 'keypress', 'input'].forEach(evtType => {
      card.addEventListener(evtType, (e) => {
        e.stopPropagation();
      });
    });

    textarea.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      textarea.focus();
    });

    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        saveAction();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelActiveComment();
      }
    });

    this.shadow.appendChild(card);
    this.activeCommentCard = card;
    this.currentEditingAnnotation = annotation;

    setTimeout(() => {
      if (textarea) {
        textarea.focus();
        if (annotation.comment) {
          textarea.select();
        }
      }
    }, 30);
  }

  deleteAnnotation(annotation) {
    if (annotation.badgeEl) annotation.badgeEl.remove();
    if (annotation.boxEl) annotation.boxEl.remove();
    if (annotation.arrowEl) annotation.arrowEl.remove();

    this.annotations = this.annotations.filter(a => a !== annotation);
    this.reindexAnnotations();
    this.closeCommentModal();
    this.updateCounter();
    this.syncSessionToStorage();

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'SET_BADGE',
        text: this.annotations.length > 0 ? String(this.annotations.length) : '',
        color: '#C9400F'
      }).catch(() => {});
    }
  }

  closeCommentModal() {
    if (this.activeCommentCard) {
      this.activeCommentCard.remove();
      this.activeCommentCard = null;
    }
    this.isEditingComment = false;
    this.currentEditingAnnotation = null;
  }

  cancelActiveComment() {
    if (!this.currentEditingAnnotation) return;
    const isNew = !this.annotations.includes(this.currentEditingAnnotation);
    if (isNew) {
      if (this.currentEditingAnnotation.badgeEl) this.currentEditingAnnotation.badgeEl.remove();
      if (this.currentEditingAnnotation.boxEl) this.currentEditingAnnotation.boxEl.remove();
      if (this.currentEditingAnnotation.arrowEl) this.currentEditingAnnotation.arrowEl.remove();
    }
    this.closeCommentModal();
  }

  reindexAnnotations() {
    const previousPointsCount = (this.session && this.session.pages)
      ? this.session.pages.reduce((acc, p) => acc + (p.annotations ? p.annotations.length : 0), 0)
      : 0;

    this.annotations.forEach((ann, idx) => {
      ann.index = previousPointsCount + idx + 1;
      if (ann.badgeEl) ann.badgeEl.textContent = ann.index;
      if (ann.metadata) {
        ann.metadata.index = ann.index;
      }
    });
  }

  async exportAndFinish() {
    return this.finishAndShowExportModal();
  }

  async finishAndShowExportModal() {
    const hasCurrent = this.annotations.length > 0;
    const hasPrevious = this.session && this.session.pages && this.session.pages.length > 0;

    if (!hasCurrent && !hasPrevious) {
      this.showToast('Aucune annotation enregistrée. Cliquez d\'abord sur un élément pour annoter.');
      return;
    }

    if (this.activeCommentCard) {
      this.closeCommentModal();
    }

    this.showToast('Préparation de l\'exportation...');

    this.setHudVisible(false);
    this.highlightBox.style.display = 'none';

    await new Promise(r => setTimeout(r, 150));

    try {
      let currentPageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const response = await chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });
        if (response && response.success && response.dataUrl) {
          currentPageDataUrl = response.dataUrl;
        }
      }

      this.setHudVisible(true);

      // Save current page to session
      const allPages = [...(this.session.pages || [])];
      if (hasCurrent) {
        allPages.push({
          stepIndex: allPages.length + 1,
          url: window.location.href,
          title: document.title,
          dataUrl: currentPageDataUrl,
          annotations: this.annotations.map(a => ({
            index: a.index,
            comment: a.comment,
            type: a.type || 'style',
            metadata: a.metadata || { element: { tag: a.element.tagName } }
          }))
        });
      }

      const promptText = this.generateConsolidatedPrompt(allPages, this.currentExportFormat);
      const payload = this.generateMultiPagePayload(allPages, promptText);

      this.lastExportData = {
        dataUrl: currentPageDataUrl,
        promptText,
        payload,
        pages: allPages
      };

      this.showExportModal(allPages, promptText, payload);

    } catch (err) {
      this.setHudVisible(true);
      console.error('[AI Web Annotator] Export failed:', err);
      this.showToast(`Erreur : ${err.message}`);
    }
  }

  generateConsolidatedPrompt(pages, format = 'agent') {
    if (format === 'github') {
      return this.generateGitHubMultiPagePrompt(pages);
    }
    if (format === 'json') {
      return JSON.stringify(this.generateMultiPagePayload(pages), null, 2);
    }
    return this.generateAgentMultiPagePrompt(pages);
  }

  generateAgentMultiPagePrompt(pages) {
    const isMultiPage = pages.length > 1;
    let prompt = `### 🎯 Contexte Web & Annotations pour Agent IA\n`;
    prompt += `- **Mode** : ${isMultiPage ? `Parcours Multi-Pages (${pages.length} étapes)` : 'Page Unique'}\n`;
    prompt += `- **Date/Heure** : ${new Date().toISOString()}\n\n`;
    prompt += `### 📌 Actions & Corrections Demandées :\n`;

    pages.forEach((page) => {
      if (isMultiPage) {
        prompt += `\n---\n### 🚩 Étape #${page.stepIndex} : ${page.title} (\`${page.url}\`)\n`;
      }

      (page.annotations || []).forEach((a) => {
        const meta = a.metadata ? a.metadata.element : {};
        prompt += `\n#### [Point #${a.index}]\n`;
        prompt += `- **Type** : ${ANNOTATION_TYPES[a.type] || 'Style'}\n`;
        prompt += `- **Demande / Problème** : ${a.comment || '(Aucun commentaire)'}\n`;
        prompt += `- **Élément Cible** : \`<${meta.tag ? meta.tag.toLowerCase() : 'element'}>\`\n`;
        if (meta.cssSelector) prompt += `- **Sélecteur CSS** : \`${meta.cssSelector}\`\n`;
        if (meta.xpath) prompt += `- **XPath** : \`${meta.xpath}\`\n`;
        if (meta.text) prompt += `- **Texte Visible** : "${meta.text}"\n`;

        // Output clean computed layout styles if present
        if (meta.computedStyles && Object.keys(meta.computedStyles).length > 0) {
          const styles = meta.computedStyles;
          const clean = [];
          if (styles.display) clean.push(`display: ${styles.display}`);
          if (styles.position) clean.push(`position: ${styles.position}`);
          if (styles.width) clean.push(`width: ${styles.width}`);
          if (styles.height) clean.push(`height: ${styles.height}`);
          if (styles.margin && styles.margin !== '0px 0px 0px 0px') clean.push(`margin: ${styles.margin}`);
          if (styles.padding && styles.padding !== '0px 0px 0px 0px') clean.push(`padding: ${styles.padding}`);
          if (clean.length > 0) {
            prompt += `- **Styles Calculés** : \`${clean.join('; ')};\`\n`;
          }
        }
      });
    });

    prompt += `\n---\n*Généré par AI Web Annotator.*`;
    return prompt;
  }

  generateGitHubMultiPagePrompt(pages) {
    let md = `## 🐛 Rapport d'Anomalies & Parcours Utilisateur\n\n`;
    pages.forEach((page) => {
      md += `### 🚩 Étape #${page.stepIndex} : ${page.title}\n`;
      md += `**URL :** ${page.url}  \n\n`;
      (page.annotations || []).forEach((a) => {
        const meta = a.metadata ? a.metadata.element : {};
        md += `- [ ] **[Point #${a.index}]** \`${meta.cssSelector || meta.tag || 'element'}\` : ${a.comment || 'À corriger'}\n`;
      });
      md += `\n`;
    });
    return md;
  }

  generateMultiPagePayload(pages, promptText) {
    return {
      meta: {
        generator: 'AI Web Annotator',
        version: '1.1.0',
        timestamp: new Date().toISOString(),
        totalSteps: pages.length,
        totalAnnotations: pages.reduce((acc, p) => acc + (p.annotations?.length || 0), 0)
      },
      pages: pages.map(p => ({
        stepIndex: p.stepIndex,
        url: p.url,
        title: p.title,
        annotations: p.annotations
      })),
      aiPrompt: promptText || this.generateConsolidatedPrompt(pages, 'agent')
    };
  }

  showExportModal(pages, promptText, payload) {
    if (this.activeExportModal) {
      this.activeExportModal.remove();
    }

    const totalPoints = pages.reduce((acc, p) => acc + (p.annotations?.length || 0), 0);
    let selectedPageIndex = pages.length - 1;
    let activePage = pages[selectedPageIndex] || { dataUrl: '', stepIndex: 1 };
    const isMultiScreen = pages.length > 1;

    const formatConfigs = {
      agent: {
        name: 'Agent IA',
        ctaMain: "Copier pour l'Agent IA",
        ctaSub: 'Prompt structuré avec sélecteurs & contexte',
        desc: 'Prompt + contexte DOM'
      },
      github: {
        name: 'GitHub Issue',
        ctaMain: 'Copier pour GitHub Issue',
        ctaSub: 'Markdown prêt à coller dans une issue',
        desc: 'Markdown prêt à coller'
      },
      json: {
        name: 'JSON',
        ctaMain: 'Copier le JSON',
        ctaSub: 'Données brutes structurées',
        desc: 'Données structurées'
      }
    };

    const currentConfig = formatConfigs[this.currentExportFormat] || formatConfigs.agent;

    const modal = document.createElement('div');
    modal.className = 'ai-export-backdrop';
    const fmtTab = (key) => `
      <button class="ai-format-tab ${this.currentExportFormat === key ? 'active' : ''}" data-format="${key}" aria-pressed="${this.currentExportFormat === key}">
        <span class="ai-format-name">${formatConfigs[key].name}</span>
        <span class="ai-format-desc">${formatConfigs[key].desc}</span>
      </button>`;

    modal.innerHTML = `
      <div class="ai-export-dialog" role="dialog" aria-modal="true" aria-label="Exporter la session">
        <div class="ai-export-header">
          <div class="ai-export-title-group">
            <h3 class="ai-export-title">Exporter la session</h3>
            <span class="ai-export-badge">${totalPoints} annotation${totalPoints > 1 ? 's' : ''}${isMultiScreen ? ` • ${pages.length} écrans` : ''}</span>
          </div>
          <button class="ai-export-close-btn" id="ai-modal-close" aria-label="Fermer" title="Fermer (Échap)">✕</button>
        </div>

        <div class="ai-export-body">
          <div class="ai-export-main">
            ${isMultiScreen ? `
              <div class="ai-export-screens-nav">
                <span class="ai-export-screens-label">Écrans capturés</span>
                <div class="ai-export-screens-tabs" id="ai-screens-tabs">
                  ${pages.map((p, idx) => `
                    <button class="ai-screen-tab ${idx === selectedPageIndex ? 'active' : ''}" data-page-index="${idx}">
                      <span class="ai-screen-tab-title">Écran ${p.stepIndex}</span>
                      <span class="ai-screen-tab-badge">${(p.annotations || []).length} ann.</span>
                    </button>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            <div class="ai-export-preview-container">
              <img class="ai-export-thumbnail" id="ai-export-thumb" src="${activePage.dataUrl}" alt="Aperçu de la capture annotée" />
              <div class="ai-export-preview-overlay">
                <span class="ai-export-preview-tag" id="ai-preview-tag">${isMultiScreen ? `Aperçu · écran #${activePage.stepIndex}` : 'Aperçu avec repères'}</span>
              </div>
            </div>

            <details class="ai-export-prompt-details" id="ai-prompt-details">
              <summary class="ai-export-prompt-summary">
                <span class="ai-summary-label">
                  <svg class="ai-summary-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
                  <span>Voir le contenu généré (<strong id="ai-prompt-format-name">${currentConfig.name}</strong>)</span>
                </span>
              </summary>
              <pre class="ai-export-prompt-pre" id="ai-prompt-preview">${this.escapeHtml(promptText)}</pre>
            </details>
          </div>

          <div class="ai-export-side">
            <span class="ai-eyebrow">Destination</span>
            <div class="ai-export-format-selector">
              ${fmtTab('agent')}${fmtTab('github')}${fmtTab('json')}
            </div>

            <div class="ai-export-primary-action-wrap">
              <button class="ai-export-primary-btn" id="ai-btn-primary-action" title="Copier le contenu formaté dans le presse-papier">
                ${this.svgIcon('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>', 20)}
                <div class="ai-action-text-group">
                  <span class="ai-action-main-text" id="ai-primary-cta-title">${currentConfig.ctaMain}</span>
                  <span class="ai-action-sub-text" id="ai-primary-cta-sub">${currentConfig.ctaSub}</span>
                </div>
              </button>
            </div>

            <div class="ai-export-secondary-tools">
              <button class="ai-export-sub-btn" id="ai-btn-copy-image" title="Copier l'image de l'écran affiché dans le presse-papier">
                ${this.svgIcon('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>')}
                <span id="ai-copy-img-text">${isMultiScreen ? `Copier écran #${activePage.stepIndex}` : "Copier l'image"}</span>
              </button>
              <button class="ai-export-sub-btn" id="ai-btn-dl-png" title="Enregistrer l'image PNG affichée">
                ${this.svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>')}
                <span id="ai-dl-png-text">${isMultiScreen ? `Télécharger écran #${activePage.stepIndex}` : 'Télécharger PNG'}</span>
              </button>
              ${isMultiScreen ? `
                <button class="ai-export-sub-btn" id="ai-btn-dl-all-png" title="Télécharger toutes les captures PNG de la session">
                  ${this.svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>')}
                  <span>Tout télécharger (${pages.length})</span>
                </button>
              ` : ''}
              <button class="ai-export-sub-btn" id="ai-btn-dl-json" title="Enregistrer JSON">
                ${this.svgIcon('<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>')}
                <span>Télécharger JSON</span>
              </button>
            </div>
          </div>
        </div>

        <div class="ai-export-footer">
          <button class="ai-btn-footer-link" id="ai-btn-resume">Continuer d'annoter</button>
          <button class="ai-btn-footer-danger" id="ai-btn-quit-all">Quitter et effacer</button>
        </div>
      </div>
    `;

    const thumbImg = modal.querySelector('#ai-export-thumb');
    const previewTag = modal.querySelector('#ai-preview-tag');
    const copyImgText = modal.querySelector('#ai-copy-img-text');
    const dlPngText = modal.querySelector('#ai-dl-png-text');
    const screenTabs = modal.querySelectorAll('.ai-screen-tab');
    const primaryCtaBtn = modal.querySelector('#ai-btn-primary-action');
    const primaryCtaTitle = modal.querySelector('#ai-primary-cta-title');
    const primaryCtaSub = modal.querySelector('#ai-primary-cta-sub');
    const promptFormatName = modal.querySelector('#ai-prompt-format-name');
    const promptPre = modal.querySelector('#ai-prompt-preview');
    const formatTabs = modal.querySelectorAll('.ai-format-tab');

    const copyImgBtn = modal.querySelector('#ai-btn-copy-image');
    const dlPngBtn = modal.querySelector('#ai-btn-dl-png');
    const dlAllBtn = modal.querySelector('#ai-btn-dl-all-png');
    const dlJsonBtn = modal.querySelector('#ai-btn-dl-json');
    const resumeBtn = modal.querySelector('#ai-btn-resume');
    const quitBtn = modal.querySelector('#ai-btn-quit-all');
    const closeBtn = modal.querySelector('#ai-modal-close');

    const updateFormatUI = (format) => {
      this.currentExportFormat = format;
      const config = formatConfigs[format] || formatConfigs.agent;
      if (primaryCtaTitle) primaryCtaTitle.textContent = config.ctaMain;
      if (primaryCtaSub) primaryCtaSub.textContent = config.ctaSub;
      if (promptFormatName) promptFormatName.textContent = config.name;

      const newPrompt = (format === 'json')
        ? JSON.stringify(payload, null, 2)
        : this.generateConsolidatedPrompt(pages, format);

      if (promptPre) promptPre.textContent = newPrompt;
    };

    formatTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        formatTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const format = tab.getAttribute('data-format');
        updateFormatUI(format);
      });
    });

    screenTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        screenTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const idx = parseInt(tab.getAttribute('data-page-index'), 10);
        selectedPageIndex = idx;
        activePage = pages[selectedPageIndex] || pages[0];

        if (thumbImg) thumbImg.src = activePage.dataUrl;
        if (previewTag) previewTag.textContent = `Aperçu · écran #${activePage.stepIndex}`;
        if (copyImgText) copyImgText.textContent = `Copier écran #${activePage.stepIndex}`;
        if (dlPngText) dlPngText.textContent = `Télécharger écran #${activePage.stepIndex}`;
      });
    });

    ['keydown', 'keyup', 'keypress'].forEach(evtType => {
      modal.addEventListener(evtType, (e) => {
        if (e.key === 'Escape') return;
        e.stopPropagation();
      });
    });

    // Primary CTA Action Handler
    if (primaryCtaBtn) {
      primaryCtaBtn.addEventListener('click', () => {
        if (this.currentExportFormat === 'json') {
          const jsonText = JSON.stringify(payload, null, 2);
          this.copyPromptToClipboard(jsonText, primaryCtaBtn);
        } else {
          const activePrompt = this.generateConsolidatedPrompt(pages, this.currentExportFormat);
          this.copyPromptToClipboard(activePrompt, primaryCtaBtn);
        }
      });
    }

    if (copyImgBtn) {
      copyImgBtn.addEventListener('click', () => this.copyImageToClipboard(activePage.dataUrl, copyImgBtn));
    }

    if (dlPngBtn) {
      dlPngBtn.addEventListener('click', () => {
        const hostname = window.location.hostname.replace(/[^a-z0-9]/gi, '_') || 'page';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = isMultiScreen
          ? `annotation-ecran-${activePage.stepIndex}-${hostname}-${timestamp}.png`
          : `annotation-${hostname}-${timestamp}.png`;
        this.downloadPNG(activePage.dataUrl, filename);
      });
    }

    if (dlAllBtn) {
      dlAllBtn.addEventListener('click', () => this.downloadAllPNG(pages));
    }

    if (dlJsonBtn) {
      dlJsonBtn.addEventListener('click', () => this.downloadJSON(payload));
    }

    const closeModal = () => {
      modal.remove();
      this.activeExportModal = null;
    };

    resumeBtn.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    quitBtn.addEventListener('click', () => {
      closeModal();
      this.deactivate();
    });

    this.shadow.appendChild(modal);
    this.activeExportModal = modal;
  }

  svgIcon(inner, size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  async copyImageToClipboard(dataUrl, btn) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const res = await chrome.runtime.sendMessage({
          action: 'COPY_TO_CLIPBOARD',
          type: 'image',
          dataUrl: dataUrl
        });
        if (res && res.success) {
          this.markButtonSuccess(btn, 'Image copiée');
          this.showToast('Image copiée dans le presse-papier (Ctrl+V) !');
          return;
        }
      } catch (_) {}
    }

    const nav = (typeof window !== 'undefined' && window.navigator && window.navigator.clipboard) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const pngBlob = blob.type === 'image/png' ? blob : new Blob([await blob.arrayBuffer()], { type: 'image/png' });

      if (nav && nav.clipboard && nav.clipboard.write) {
        await nav.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob })
        ]);
        this.markButtonSuccess(btn, 'Image copiée');
        this.showToast('Image copiée ! Vous pouvez la coller dans votre IA (Ctrl+V).');
        return;
      }
      throw new Error('Clipboard write not supported');
    } catch (err) {
      console.warn('[AI Web Annotator] Image clipboard write fallback to download:', err);
      await this.downloadPNG(dataUrl);
      this.showToast('Image téléchargée.');
    }
  }

  async copyPromptToClipboard(promptText, btn) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const res = await chrome.runtime.sendMessage({
          action: 'COPY_TO_CLIPBOARD',
          type: 'text',
          text: promptText
        });
        if (res && res.success) {
          this.markButtonSuccess(btn, 'Prompt copié');
          this.showToast('Prompt IA copié dans le presse-papier !');
          return;
        }
      } catch (_) {}
    }

    const nav = (typeof window !== 'undefined' && window.navigator && window.navigator.clipboard) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);
    try {
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        await nav.clipboard.writeText(promptText);
      } else {
        this.fallbackCopyText(promptText);
      }
      this.markButtonSuccess(btn, 'Prompt copié');
      this.showToast('Prompt IA copié dans le presse-papier !');
    } catch (err) {
      this.fallbackCopyText(promptText);
      this.markButtonSuccess(btn, 'Prompt copié');
      this.showToast('Prompt IA copié dans le presse-papier !');
    }
  }

  markButtonSuccess(btn, message) {
    const textEl = btn.querySelector('.ai-action-main-text');
    if (!textEl) return;
    const orig = textEl.textContent;
    btn.classList.add('ai-btn-success');
    textEl.textContent = message;
    setTimeout(() => {
      btn.classList.remove('ai-btn-success');
      textEl.textContent = orig;
    }, 2500);
  }

  async downloadPNG(dataUrl, customFilename = null) {
    const hostname = window.location.hostname.replace(/[^a-z0-9]/gi, '_') || 'page';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = customFilename || `annotation-${hostname}-${timestamp}.png`;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_FILE',
        url: dataUrl,
        filename: filename
      });
    }
    this.showToast('Capture PNG téléchargée.');
  }

  async downloadAllPNG(pages = []) {
    if (!pages || !pages.length) return;
    const hostname = window.location.hostname.replace(/[^a-z0-9]/gi, '_') || 'page';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    this.showToast(`Téléchargement de ${pages.length} image(s) en cours...`);

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!page || !page.dataUrl) continue;
      const stepNum = page.stepIndex || (i + 1);
      const filename = `annotation-ecran-${stepNum}-${hostname}-${timestamp}.png`;

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        await chrome.runtime.sendMessage({
          action: 'DOWNLOAD_FILE',
          url: page.dataUrl,
          filename: filename
        });
      }

      // Small delay between downloads to prevent browser throttling/concurrency issues
      if (i < pages.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    this.showToast(`${pages.length} capture(s) PNG téléchargées !`);
  }

  async downloadJSON(payload) {
    const hostname = window.location.hostname.replace(/[^a-z0-9]/gi, '_') || 'page';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const jsonBlobUrl = URL.createObjectURL(jsonBlob);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_FILE',
        url: jsonBlobUrl,
        filename: `annotation-context-${hostname}-${timestamp}.json`
      });
    }
    this.showToast('Données JSON téléchargées.');
  }

  fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  showToast(message) {
    const existing = this.shadow.querySelector('.ai-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'ai-toast';
    toast.textContent = message;
    this.shadow.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 3500);
  }
}

if (typeof window !== 'undefined') {
  window.AnnotatorUI = new AnnotatorUIManager();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnnotatorUIManager;
}
