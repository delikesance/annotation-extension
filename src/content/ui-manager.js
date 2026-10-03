/**
 * UI Manager for AI Web Annotator
 * Manages the Shadow DOM lifecycle, hover inspector, numbered badges,
 * inline comment card, floating island HUD, Pause mode (free navigation),
 * and Multi-Page user journey sessions.
 */

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
    this.hud.className = 'ai-annotator-hud';
    this.hud.innerHTML = `
      <div class="ai-hud-drag-handle" title="Glisser pour déplacer le dock">
        <svg width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="4" cy="3" r="1" fill="currentColor"/>
          <circle cx="8" cy="3" r="1" fill="currentColor"/>
          <circle cx="4" cy="7" r="1" fill="currentColor"/>
          <circle cx="8" cy="7" r="1" fill="currentColor"/>
          <circle cx="4" cy="11" r="1" fill="currentColor"/>
          <circle cx="8" cy="11" r="1" fill="currentColor"/>
        </svg>
      </div>
      <div class="ai-hud-status" id="ai-hud-status-badge">
        <span class="ai-pulse-dot"></span>
        <span class="ai-hud-status-text" id="ai-hud-status-text">Page Figée</span>
      </div>
      <div class="ai-hud-counter" id="ai-counter">0 annotation</div>
      <button class="ai-hud-btn ai-hud-btn-pause" id="ai-btn-pause" title="Mettre en pause pour interagir / naviguer librement (Touche P)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <rect x="6" y="4" width="4" height="16" rx="1"/>
          <rect x="14" y="4" width="4" height="16" rx="1"/>
        </svg>
        <span id="ai-btn-pause-text">Pause</span>
      </button>
      <div class="ai-hud-shortcuts-hint" title="Raccourcis : P (Pause/Reprendre), Échap (Quitter), Ctrl+Entrée (Valider)">
        <span>⚡ P / Ctrl+↵</span>
      </div>
      <button class="ai-hud-btn ai-hud-btn-primary" id="ai-btn-export" title="Terminer et exporter les annotations (Ctrl+E)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Terminer</span>
      </button>
      <button class="ai-hud-btn-icon ai-hud-btn-minimize" id="ai-btn-minimize" title="Réduire / Agrandir le dock">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 14 10 14 10 20"></polyline>
          <polyline points="20 10 14 10 14 4"></polyline>
        </svg>
      </button>
      <button class="ai-hud-btn-icon ai-hud-btn-close" id="ai-btn-cancel" title="Quitter le mode annotation (Échap)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;

    this.hud.querySelector('#ai-btn-pause').addEventListener('click', () => this.togglePause());
    this.hud.querySelector('#ai-btn-export').addEventListener('click', () => this.finishAndShowExportModal());
    this.hud.querySelector('#ai-btn-cancel').addEventListener('click', () => this.deactivate());

    const minBtn = this.hud.querySelector('#ai-btn-minimize');
    if (minBtn) {
      minBtn.addEventListener('click', () => {
        this.hud.classList.toggle('ai-hud-collapsed');
      });
    }

    this.setupHudDragging();
    this.shadow.appendChild(this.hud);
  }

  setupHudDragging() {
    const handle = this.hud.querySelector('.ai-hud-drag-handle');
    if (!handle) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.hud.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      this.hud.style.transform = 'none';
      this.hud.style.bottom = 'auto';
      this.hud.style.left = `${initialLeft}px`;
      this.hud.style.top = `${initialTop}px`;
      this.hud.classList.add('ai-hud-is-dragging');
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const winW = typeof window !== 'undefined' ? window.innerWidth : 1024;
      const winH = typeof window !== 'undefined' ? window.innerHeight : 768;
      this.hud.style.left = `${Math.max(10, Math.min(winW - (this.hud.offsetWidth || 300) - 10, initialLeft + dx))}px`;
      this.hud.style.top = `${Math.max(10, Math.min(winH - (this.hud.offsetHeight || 50) - 10, initialTop + dy))}px`;
    }, true);

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.hud.classList.remove('ai-hud-is-dragging');
      }
    }, true);
  }

  updateCounter() {
    const counter = this.shadow.getElementById('ai-counter');
    if (!counter) return;

    const previousCount = (this.session && this.session.pages)
      ? this.session.pages.reduce((acc, p) => acc + (p.annotations ? p.annotations.length : 0), 0)
      : 0;

    const totalCount = previousCount + this.annotations.length;
    const pageSteps = (this.session && this.session.pages) ? this.session.pages.length + 1 : 1;

    if (pageSteps > 1) {
      counter.textContent = `${totalCount} annotation${totalCount > 1 ? 's' : ''} (${pageSteps} pages)`;
    } else {
      counter.textContent = `${totalCount} annotation${totalCount > 1 ? 's' : ''}`;
    }
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
    this.showToast('🎯 Mode Annotation activé : Cliquez sur un élément pour annoter.');
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
    this.showToast('⏸️ Mode Pause activé : Vous pouvez interagir et naviguer librement.');
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
    this.showToast('🎯 Mode Annotation réactivé : Cliquez sur un élément pour annoter.');
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
      if (statusText) statusText.textContent = 'En Pause (Libre)';
      if (pauseBtn) {
        pauseBtn.classList.add('is-paused');
        pauseBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span>Reprendre</span>
        `;
      }
    } else {
      this.hud.classList.remove('ai-hud-paused');
      if (statusBadge) statusBadge.classList.remove('is-paused');
      if (statusText) statusText.textContent = 'Page Figée';
      if (pauseBtn) {
        pauseBtn.classList.remove('is-paused');
        pauseBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <rect x="6" y="4" width="4" height="16" rx="1"/>
            <rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
          <span>Pause</span>
        `;
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
    this.showToast(`🌐 Étape #${this.session.pages.length + 1} de la session : ${document.title}`);
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
          <polygon points="0 0, 8 3, 0 6" fill="#4f46e5" />
        </marker>
      </defs>
      <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#ffffff" stroke-width="5" stroke-linecap="round" marker-end="url(#${markerIdWhite})" />
      <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#4f46e5" stroke-width="2.5" stroke-linecap="round" marker-end="url(#${markerId})" />
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

    if (rect.left + 360 > viewportWidth) {
      modalLeft = Math.max(scrollX + 16, scrollX + viewportWidth - 360);
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
          <span>Point #${annotation.index}</span>
          <span class="ai-comment-tag">&lt;${tagStr}&gt;</span>
        </div>
        <div class="ai-comment-shortcut-badge">Ctrl+Entrée</div>
      </div>
      <textarea class="ai-comment-textarea" placeholder="Indiquez ce que l'IA doit analyser, modifier ou corriger sur cet élément...">${annotation.comment || ''}</textarea>
      <div class="ai-comment-footer">
        <span class="ai-comment-hint">⚡ Entrée ou Ctrl+Entrée pour valider</span>
        <div class="ai-comment-actions">
          <button class="ai-btn-sm ai-btn-delete" id="ai-modal-delete">${isNew ? 'Annuler' : 'Supprimer'}</button>
          <button class="ai-btn-sm ai-btn-save" id="ai-modal-save">Enregistrer</button>
        </div>
      </div>
    `;

    const textarea = card.querySelector('textarea');
    const saveBtn = card.querySelector('#ai-modal-save');
    const deleteBtn = card.querySelector('#ai-modal-delete');

    const saveAction = () => {
      const text = textarea.value.trim();
      annotation.comment = text;

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
          color: '#4f46e5'
        }).catch(() => {});
      }
    };

    const deleteAction = () => {
      this.deleteAnnotation(annotation);
    };

    saveBtn.addEventListener('click', saveAction);
    deleteBtn.addEventListener('click', deleteAction);

    ['keydown', 'keyup', 'keypress'].forEach(evtType => {
      card.addEventListener(evtType, (e) => {
        e.stopPropagation();
      });
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

    setTimeout(() => textarea.focus(), 50);
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
        color: '#4f46e5'
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
      this.showToast('⚠️ Aucune annotation enregistrée. Cliquez d\'abord sur un élément pour annoter.');
      return;
    }

    if (this.activeCommentCard) {
      this.closeCommentModal();
    }

    this.showToast('📸 Préparation de l\'exportation...');

    this.hud.style.display = 'none';
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

      this.hud.style.display = 'flex';

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
      this.hud.style.display = 'flex';
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
    const activePage = pages[pages.length - 1] || { dataUrl: '' };

    const modal = document.createElement('div');
    modal.className = 'ai-export-backdrop';
    modal.innerHTML = `
      <div class="ai-export-dialog">
        <div class="ai-export-header">
          <div class="ai-export-title-row">
            <span class="ai-export-pill">${totalPoints} annotation${totalPoints > 1 ? 's' : ''}</span>
            ${pages.length > 1 ? `<span class="ai-export-step-pill">${pages.length} étapes de navigation</span>` : ''}
            <h3 class="ai-export-title">Annotations Prêtes pour l'IA</h3>
          </div>
          <button class="ai-export-close-btn" id="ai-modal-close" title="Fermer (Échap)">✕</button>
        </div>

        <div class="ai-export-body">
          <div class="ai-export-preview-container">
            <img class="ai-export-thumbnail" id="ai-export-thumb" src="${activePage.dataUrl}" alt="Aperçu capture annotée" />
            <div class="ai-export-preview-overlay">
              <span class="ai-export-preview-tag">✓ Capture avec flèches & indicateurs</span>
            </div>
          </div>

          <div class="ai-export-format-selector">
            <button class="ai-format-tab ${this.currentExportFormat === 'agent' ? 'active' : ''}" data-format="agent">🤖 Agent IA</button>
            <button class="ai-format-tab ${this.currentExportFormat === 'github' ? 'active' : ''}" data-format="github">🐙 GitHub Issue</button>
            <button class="ai-format-tab ${this.currentExportFormat === 'json' ? 'active' : ''}" data-format="json">📊 JSON Brut</button>
          </div>

          <div class="ai-export-primary-actions">
            <button class="ai-export-action-btn ai-btn-copy-image" id="ai-btn-copy-image" title="Copier l'image directement dans le presse-papier">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              <div class="ai-action-text-group">
                <span class="ai-action-main-text">Copier l'image</span>
                <span class="ai-action-sub-text">PNG prêt à coller (Ctrl+V)</span>
              </div>
            </button>

            <button class="ai-export-action-btn ai-btn-copy-prompt" id="ai-btn-copy-prompt" title="Copier le prompt IA dans le presse-papier">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <div class="ai-action-text-group">
                <span class="ai-action-main-text">Copier le prompt IA</span>
                <span class="ai-action-sub-text">Format structuré</span>
              </div>
            </button>
          </div>

          <div class="ai-export-secondary-actions">
            <button class="ai-export-sub-btn" id="ai-btn-dl-png" title="Enregistrer l'image PNG">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Télécharger PNG</span>
            </button>

            <button class="ai-export-sub-btn" id="ai-btn-dl-json" title="Enregistrer JSON">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="16 18 22 12 16 6"></polyline>
                <polyline points="8 6 2 12 8 18"></polyline>
              </svg>
              <span>Télécharger JSON</span>
            </button>
          </div>

          <div class="ai-export-prompt-preview-wrap">
            <div class="ai-export-prompt-label">Aperçu du prompt (${this.currentExportFormat}) :</div>
            <pre class="ai-export-prompt-pre" id="ai-prompt-preview">${this.escapeHtml(promptText)}</pre>
          </div>
        </div>

        <div class="ai-export-footer">
          <button class="ai-btn-footer-link" id="ai-btn-resume">Continuer d'annoter</button>
          <button class="ai-btn-footer-danger" id="ai-btn-quit-all">Terminer la session</button>
        </div>
      </div>
    `;

    const copyImgBtn = modal.querySelector('#ai-btn-copy-image');
    const copyPromptBtn = modal.querySelector('#ai-btn-copy-prompt');
    const dlPngBtn = modal.querySelector('#ai-btn-dl-png');
    const dlJsonBtn = modal.querySelector('#ai-btn-dl-json');
    const resumeBtn = modal.querySelector('#ai-btn-resume');
    const quitBtn = modal.querySelector('#ai-btn-quit-all');
    const closeBtn = modal.querySelector('#ai-modal-close');
    const promptPre = modal.querySelector('#ai-prompt-preview');
    const formatTabs = modal.querySelectorAll('.ai-format-tab');

    formatTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        formatTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.currentExportFormat = tab.getAttribute('data-format');
        const newPrompt = this.generateConsolidatedPrompt(pages, this.currentExportFormat);
        promptPre.textContent = newPrompt;
      });
    });

    ['keydown', 'keyup', 'keypress'].forEach(evtType => {
      modal.addEventListener(evtType, (e) => {
        if (e.key === 'Escape') return;
        e.stopPropagation();
      });
    });

    copyImgBtn.addEventListener('click', () => this.copyImageToClipboard(activePage.dataUrl, copyImgBtn));
    copyPromptBtn.addEventListener('click', () => {
      const activePrompt = this.generateConsolidatedPrompt(pages, this.currentExportFormat);
      this.copyPromptToClipboard(activePrompt, copyPromptBtn);
    });
    dlPngBtn.addEventListener('click', () => this.downloadPNG(activePage.dataUrl));
    dlJsonBtn.addEventListener('click', () => this.downloadJSON(payload));

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

  async copyImageToClipboard(dataUrl, btn) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const res = await chrome.runtime.sendMessage({
          action: 'COPY_TO_CLIPBOARD',
          type: 'image',
          dataUrl: dataUrl
        });
        if (res && res.success) {
          this.markButtonSuccess(btn, '✅ Image copiée !');
          this.showToast('✅ Image copiée dans le presse-papier (Ctrl+V) !');
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
        this.markButtonSuccess(btn, '✅ Image copiée !');
        this.showToast('✅ Image copiée ! Vous pouvez la coller dans votre IA (Ctrl+V).');
        return;
      }
      throw new Error('Clipboard write not supported');
    } catch (err) {
      console.warn('[AI Web Annotator] Image clipboard write fallback to download:', err);
      await this.downloadPNG(dataUrl);
      this.showToast('💾 Image téléchargée.');
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
          this.markButtonSuccess(btn, '✅ Prompt copié !');
          this.showToast('✅ Prompt IA copié dans le presse-papier !');
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
      this.markButtonSuccess(btn, '✅ Prompt copié !');
      this.showToast('✅ Prompt IA copié dans le presse-papier !');
    } catch (err) {
      this.fallbackCopyText(promptText);
      this.markButtonSuccess(btn, '✅ Prompt copié !');
      this.showToast('✅ Prompt IA copié dans le presse-papier !');
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

  async downloadPNG(dataUrl) {
    const hostname = window.location.hostname.replace(/[^a-z0-9]/gi, '_') || 'page';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_FILE',
        url: dataUrl,
        filename: `annotation-${hostname}-${timestamp}.png`
      });
    }
    this.showToast('💾 Capture PNG téléchargée.');
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
    this.showToast('📄 Données JSON téléchargées.');
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
