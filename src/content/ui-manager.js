/**
 * UI Manager for AI Web Annotator (page side)
 *
 * Draws only the lightweight overlays on the page (hover highlight, target boxes,
 * numbered pins, arrows) and owns the annotation/session state. Everything the user
 * reads or types (list, comment editor, export, update notice, status messages)
 * lives in Chrome's side panel, which this class feeds with RAIL_STATE messages and
 * controls through RAIL_ACTION messages (see handleRailAction).
 */

const ANNOTATION_TYPES = { style: 'Style', bug: 'Bug', text: 'Texte' };

class AnnotatorUIManager {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.highlightBox = null;
    this.highlightLabel = null;

    this.annotations = []; // Saved annotations of the current screen: { id, index, element, comment, type, badgeEl, boxEl, arrowEl, metadata }
    this.hoveredElement = null;
    this.selectedAnnotation = null;
    this.isActive = false; // the annotator is running on this page (panel open, session alive)
    this.isInspecting = false; // annotate mode: page frozen, clicking an element places an annotation
    this.isPaused = false; // legacy mirror of !isInspecting while active (free navigation)
    this.isEditingComment = false;
    this.currentEditingAnnotation = null;
    this.screenShot = null; // Promise<string|null>: screenshot of the current screen incl. its pins
    this.domObserver = null;
    this.domChangeTimer = null;
    this.domChangeCount = 0;
    this.domChangeLog = [];
    this.pendingFinalize = false;
    this.exportView = null; // { pages, prompts, payload } while the panel shows the export view
    this.lastExportData = null;
    this.status = null; // { id, text } transient message shown in the panel

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
    this.boundOnPageHide = this.onPageHide.bind(this);
    this.lastShotDataUrl = null;
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
  }

  createHighlightBox() {
    this.highlightBox = document.createElement('div');
    this.highlightBox.className = 'ai-highlight-box';

    this.highlightLabel = document.createElement('span');
    this.highlightLabel.className = 'ai-highlight-label';
    this.highlightBox.appendChild(this.highlightLabel);

    this.shadow.appendChild(this.highlightBox);
  }

  // ------------------------------------------------------------------
  // Side panel bridge
  // ------------------------------------------------------------------

  getPreviousPointsCount() {
    return (this.session && this.session.pages)
      ? this.session.pages.reduce((acc, p) => acc + (p.annotations ? p.annotations.length : 0), 0)
      : 0;
  }

  getCounterText() {
    const totalCount = this.getPreviousPointsCount() + this.annotations.length;
    const currentScreen = (this.session && this.session.pages) ? this.session.pages.length + 1 : 1;
    if (currentScreen > 1) {
      return `Écran #${currentScreen} (${totalCount} point${totalCount > 1 ? 's' : ''})`;
    }
    return `${totalCount} annotation${totalCount > 1 ? 's' : ''}`;
  }

  getSelectorOf(annotation) {
    return (annotation.metadata && annotation.metadata.element && annotation.metadata.element.cssSelector)
      || (annotation.element && annotation.element.tagName ? annotation.element.tagName.toLowerCase() : '');
  }

  /** Everything the side panel needs to render, as plain serialisable data. */
  buildPanelState() {
    const editing = this.currentEditingAnnotation;
    return {
      active: this.isActive,
      mode: this.isInspecting ? 'annotate' : 'browse',
      isPaused: !this.isInspecting,
      hostname: window.location.hostname,
      counterText: this.getCounterText(),
      previousScreens: (this.session && this.session.pages) ? this.session.pages.length : 0,
      annotations: this.annotations.map(a => ({
        index: a.index,
        type: a.type || 'style',
        comment: a.comment || '',
        selector: this.getSelectorOf(a)
      })),
      editing: editing ? {
        index: editing.index,
        isNew: !this.annotations.includes(editing),
        comment: editing.comment || '',
        type: editing.type || null,
        tag: editing.element && editing.element.tagName ? editing.element.tagName.toLowerCase() : '',
        selector: this.getSelectorOf(editing) || (editing.element && editing.element.tagName ? editing.element.tagName.toLowerCase() : '')
      } : null,
      status: this.status,
      exportView: this.exportView
    };
  }

  broadcastPanelState(overrides) {
    this.sendToBackground({ action: 'RAIL_STATE', state: { ...this.buildPanelState(), ...(overrides || {}) } });
  }

  /** Short feedback line shown in the panel (replaces on-page toasts). */
  showToast(message) {
    this.status = { id: Date.now() + Math.random(), text: message };
    this.broadcastPanelState();
  }

  /** Executes an action requested from the side panel. */
  handleRailAction(op, payload = {}) {
    switch (op) {
      case 'annotate': return this.toggleAnnotating();
      case 'next': return this.nextScreen();
      case 'export': return this.finishAndShowExport();
      case 'close': return this.deactivate();
      case 'back': return this.closeExportView();
      case 'export-urls': return this.setExportImageUrls(payload.urls);
      case 'open': {
        const ann = this.annotations.find(a => a.index === payload.index);
        if (ann && this.isInspecting) {
          this.selectedAnnotation = ann;
          this.openEditor(ann);
        }
        return;
      }
      case 'save': return this.saveEditing(payload.comment, payload.type);
      case 'cancel': return this.cancelActiveComment();
      case 'delete': {
        const ann = this.annotations.find(a => a.index === payload.index) || this.currentEditingAnnotation;
        if (ann) this.deleteAnnotation(ann);
        return;
      }
      default: return undefined;
    }
  }

  /** chrome.runtime.sendMessage that never throws (stale content scripts after an extension reload throw synchronously). */
  sendToBackground(message) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return Promise.resolve(undefined);
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
    } catch (_) {
      return Promise.resolve(undefined);
    }
  }

  requestSidePanel() {
    this.sendToBackground({ action: 'OPEN_SIDE_PANEL' });
  }

  updateCounter() {
    this.broadcastPanelState();
  }

  updateHUDState() {
    this.broadcastPanelState();
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Starts the annotator in free-navigation mode; annotating is entered with the "Ajouter une annotation" action. */
  activate() {
    this.init();
    this.isActive = true;
    this.isInspecting = false;
    this.isPaused = true;

    // Start or resume multi-page session
    if (!this.session.isActive) {
      this.session.id = 'session_' + Date.now();
      this.session.isActive = true;
      this.session.pages = [];
      this.session.startingIndex = 1;
      this.syncSessionToStorage();
    }

    window.removeEventListener('mousemove', this.boundOnMouseMove, true);
    window.removeEventListener('click', this.boundOnClick, true);
    window.removeEventListener('keydown', this.boundOnKeyDown, true);
    window.addEventListener('mousemove', this.boundOnMouseMove, true);
    window.addEventListener('click', this.boundOnClick, true);
    window.addEventListener('keydown', this.boundOnKeyDown, true);
    window.removeEventListener('pagehide', this.boundOnPageHide);
    window.addEventListener('pagehide', this.boundOnPageHide);

    this.host.style.display = 'block';
    this.startDomObserver();
    this.updateHUDState();
    this.showToast('Annotateur prêt : cliquez sur « Ajouter une annotation ».');
  }

  toggleAnnotating() {
    if (this.isInspecting) {
      this.leaveAnnotateMode();
    } else {
      this.enterAnnotateMode();
    }
  }

  /** Annotate mode: the page is frozen and clicking an element places an annotation. Several can be placed in a row. */
  enterAnnotateMode() {
    if (!this.isActive) return;
    this.isInspecting = true;
    this.isPaused = false;
    this.exportView = null;

    if (typeof window !== 'undefined' && window.DOMFreeze) {
      window.DOMFreeze.enable();
    }

    this.updateHUDState();
    this.syncSessionToStorage();
    this.showToast('Mode annotation : cliquez sur un élément de la page.');
  }

  /** Back to free navigation: open menus, scroll, navigate; DOM changes start a new screen. */
  leaveAnnotateMode() {
    if (!this.isActive) return;
    this.isInspecting = false;
    this.isPaused = true;

    if (this.highlightBox) {
      this.highlightBox.style.display = 'none';
      this.hoveredElement = null;
    }

    if (this.currentEditingAnnotation) {
      this.cancelActiveComment();
    }

    if (typeof window !== 'undefined' && window.DOMFreeze) {
      window.DOMFreeze.disable();
    }

    this.updateHUDState();
    this.syncSessionToStorage();
    this.showToast('Navigation libre : ouvrez ce dont vous avez besoin.');
  }

  // ------------------------------------------------------------------
  // Automatic new screens when the page changes
  // ------------------------------------------------------------------

  startDomObserver() {
    if (!AnnotatorUIManager.AUTO_SCREEN_ON_DOM_CHANGE) return; // new screens are taken with the "Nouvel écran" button
    if (this.domObserver || typeof MutationObserver === 'undefined') return;
    this.domObserver = new MutationObserver((records) => this.onDomMutations(records));
    // Panels are often shown/hidden by toggling a class, style or attribute rather than adding nodes.
    this.domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'aria-expanded', 'aria-selected', 'data-state', 'data-open', 'inert']
    });
  }

  stopDomObserver() {
    if (this.domObserver) this.domObserver.disconnect();
    this.domObserver = null;
    clearTimeout(this.domChangeTimer);
    this.domChangeTimer = null;
    this.domChangeCount = 0;
  }

  onDomMutations(records) {
    if (!this.isActive || this.annotations.length === 0) return;
    let changed = 0;
    for (const record of records) {
      if (this.host && (record.target === this.host || this.host.contains(record.target))) continue;
      if (record.type === 'attributes') {
        // an element that is now visible and large (or structural) counts as something that appeared
        const el = record.target;
        // <html>/<body> attribute changes include our own freeze class: never a page change
        if (el === document.documentElement || el === document.body) continue;
        if (el.nodeType === 1 && el !== this.host && this.isRendered(el)) { changed++; this.recordDomChange('added', el); }
        else if (el.nodeType === 1) changed++;
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node !== this.host) { changed++; this.recordDomChange('added', node); }
      }
      for (const node of record.removedNodes) {
        if (node.nodeType === 1 && node !== this.host) { changed++; this.recordDomChange('removed', node); }
      }
    }
    if (changed === 0) return;
    this.domChangeCount += changed;
    if (!this.domChangeTimer) {
      // Evaluate after a short window (not reset by new mutations, so noisy pages still settle).
      this.domChangeTimer = setTimeout(() => {
        this.domChangeTimer = null;
        const count = this.domChangeCount;
        const changes = this.domChangeLog;
        this.domChangeCount = 0;
        this.domChangeLog = [];
        if (this.hasStaleAnnotations() || count >= AnnotatorUIManager.DOM_CHANGE_THRESHOLD) this.decideScreenChange(changes);
      }, AnnotatorUIManager.DOM_CHANGE_WINDOW_MS);
    }
  }

  isRendered(el) {
    if (!el.isConnected || !el.getBoundingClientRect) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** True when a saved annotation's element disappeared, got hidden, or moved/resized away from where its pin was placed. */
  hasStaleAnnotations() {
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    return this.annotations.some((ann) => {
      if (!ann.rect) return false;
      if (!this.isRendered(ann.element)) return true;
      const r = ann.element.getBoundingClientRect();
      const t = AnnotatorUIManager.STALE_TOLERANCE_PX;
      return Math.abs(r.left + scrollX - ann.rect.left) > t || Math.abs(r.top + scrollY - ann.rect.top) > t
        || Math.abs(r.width - ann.rect.width) > t || Math.abs(r.height - ann.rect.height) > t;
    });
  }

  /** Compact, serialisable description of a changed element, for the screen-change decision. */
  recordDomChange(kind, node) {
    if (this.domChangeLog.length >= 12) return;
    let width = 0;
    let height = 0;
    if (kind === 'added' && node.getBoundingClientRect) {
      const rect = node.getBoundingClientRect();
      width = Math.round(rect.width);
      height = Math.round(rect.height);
    }
    this.domChangeLog.push({
      kind,
      tag: node.tagName ? node.tagName.toLowerCase() : '',
      role: (node.getAttribute && (node.getAttribute('role') || node.getAttribute('aria-label'))) || '',
      id: node.id || '',
      className: typeof node.className === 'string' ? node.className.slice(0, 60) : '',
      text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      width,
      height
    });
  }

  /**
   * A burst of DOM changes happened under saved annotations: is it a new UI state (menu, dialog,
   * panel, route...) or ambient noise (clock, ticker, spinner...)? Decided locally by
   * AnnotatorUIManager.isNewScreen; the rule is evaluated against Jev judgments in development
   * (scripts/eval-heuristics.mjs).
   */
  decideScreenChange(changes) {
    // If an annotated element is gone, hidden or moved, the screen the pins were placed on no longer exists.
    const isNewScreen = this.hasStaleAnnotations() || AnnotatorUIManager.isNewScreen(changes);
    this.lastScreenDecision = { source: 'local', isNewScreen };
    if (isNewScreen) this.finalizeScreenOnChange();
  }

  /** The page changed under saved annotations: keep what was annotated as a finished screen and start a new one. */
  async finalizeScreenOnChange() {
    if (!this.isActive || this.annotations.length === 0) return;
    if (this.currentEditingAnnotation) {
      this.pendingFinalize = true;
      return;
    }
    this.pendingFinalize = false;

    const dataUrl = (await this.screenShot) || await this.captureScreen();
    if (!this.session.pages) this.session.pages = [];
    const stepIndex = this.session.pages.length + 1;
    this.session.pages.push(this.snapshotPage(stepIndex, dataUrl));
    this.clearAnnotationOverlays();
    this.screenShot = null;
    this.updateCounter();
    this.syncSessionToStorage();
    this.showToast(`Changement détecté : écran #${stepIndex} enregistré, nouvel écran en cours.`);
  }

  /** Re-captures the current screen (with all its pins) so it is ready if the page changes next. */
  refreshScreenShot() {
    if (this.highlightBox) this.highlightBox.style.display = 'none';
    this.screenShot = new Promise((resolve) => setTimeout(resolve, 60))
      .then(() => this.captureScreen())
      .then((dataUrl) => { this.lastShotDataUrl = dataUrl; return dataUrl; })
      .catch(() => null);
  }

  clearAnnotationOverlays() {
    for (const ann of this.annotations) {
      if (ann.badgeEl) ann.badgeEl.remove();
      if (ann.boxEl) ann.boxEl.remove();
      if (ann.arrowEl) ann.arrowEl.remove();
    }
    this.annotations = [];
  }

  async captureScreen() {
    let screenDataUrl = AnnotatorUIManager.PLACEHOLDER_PNG;
    const response = await this.sendToBackground({ action: 'CAPTURE_VISIBLE_TAB' });
    if (response && response.success && response.dataUrl) {
      screenDataUrl = response.dataUrl;
    }
    return screenDataUrl;
  }

  snapshotPage(stepIndex, dataUrl) {
    return {
      stepIndex,
      url: window.location.href,
      title: document.title,
      dataUrl,
      annotations: this.annotations.map(a => ({
        index: a.index,
        comment: a.comment,
        type: a.type || 'style',
        metadata: a.metadata || { element: { tag: a.element.tagName } }
      }))
    };
  }

  async nextScreen() {
    if (this.annotations.length === 0) {
      this.showToast('Ajoutez au moins une annotation sur cet écran avant de passer au suivant.');
      return;
    }

    if (this.currentEditingAnnotation) {
      this.cancelActiveComment();
    }

    this.showToast('Capture et validation de l\'écran...');
    if (this.highlightBox) this.highlightBox.style.display = 'none';

    const screenDataUrl = await this.captureScreen();

    if (!this.session.pages) {
      this.session.pages = [];
    }

    const stepIndex = this.session.pages.length + 1;
    this.session.pages.push(this.snapshotPage(stepIndex, screenDataUrl));

    // Clear visual annotations on current screen
    this.clearAnnotationOverlays();

    this.screenShot = null;
    this.updateCounter();
    this.syncSessionToStorage();
    this.showToast(`Écran #${stepIndex} enregistré. Continuez sur l'écran #${stepIndex + 1}.`);
  }

  restoreFromSession(sessionData) {
    if (!sessionData || !sessionData.isActive) return;

    this.session = sessionData;
    this.session.startingIndex = this.getPreviousPointsCount() + 1;

    this.init();
    this.host.style.display = 'block';

    this.activate();
    if (sessionData.isInspecting) this.enterAnnotateMode();

    this.updateCounter();
    this.showToast(`Étape #${this.session.pages.length + 1} de la session : ${document.title}`);
  }

  buildSessionPayload() {
    return {
      id: this.session.id,
      isActive: this.session.isActive,
      isInspecting: this.isInspecting,
      pages: this.session.pages,
      currentPage: {
        url: window.location.href,
        title: document.title,
        annotationsCount: this.annotations.length
      }
    };
  }

  /** Persists the session through the background, which knows this tab's id (needed to restore it after a navigation). */
  syncSessionToStorage() {
    this.sendToBackground({ action: 'SESSION_SYNC', session: this.buildSessionPayload() });
  }

  /** The page is going away (navigation): keep its annotated screen in the session so the next page continues it. */
  onPageHide() {
    if (!this.isActive || this.annotations.length === 0) return;
    if (!this.session.pages) this.session.pages = [];
    const stepIndex = this.session.pages.length + 1;
    this.session.pages.push(this.snapshotPage(stepIndex, this.lastShotDataUrl || AnnotatorUIManager.PLACEHOLDER_PNG));
    this.syncSessionToStorage();
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
    this.isActive = false;
    this.isInspecting = false;
    this.isPaused = false;
    this.stopDomObserver();
    this.screenShot = null;
    this.isEditingComment = false;
    this.currentEditingAnnotation = null;
    this.selectedAnnotation = null;
    this.exportView = null;
    this.status = null;

    if (typeof window !== 'undefined' && window.DOMFreeze) {
      window.DOMFreeze.disable();
    }

    window.removeEventListener('mousemove', this.boundOnMouseMove, true);
    window.removeEventListener('click', this.boundOnClick, true);
    window.removeEventListener('keydown', this.boundOnKeyDown, true);
    window.removeEventListener('pagehide', this.boundOnPageHide);

    if (this.highlightBox) {
      this.highlightBox.style.display = 'none';
    }

    this.clearAnnotationOverlays();

    if (this.host) {
      this.host.style.display = 'none';
    }

    this.clearSessionStorage();
    this.broadcastPanelState({ active: false, annotations: [], editing: null, exportView: null, status: null, previousScreens: 0, counterText: '0 annotation' });

    this.sendToBackground({ action: 'SET_BADGE', text: '' });
    this.sendToBackground({ action: 'ANNOTATOR_STOPPED' });
  }

  // ------------------------------------------------------------------
  // Page interaction
  // ------------------------------------------------------------------

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

    // The click is a user gesture: make sure the side panel (where the comment is typed) is open.
    this.requestSidePanel();
    this.createAnnotationPoint(target);
  }

  onKeyDown(e) {
    if (!this.isActive) return;

    if (e.key === 'Escape') {
      if (this.exportView) {
        this.closeExportView();
      } else if (this.currentEditingAnnotation) {
        this.cancelActiveComment();
      } else if (this.isInspecting) {
        this.leaveAnnotateMode();
      }
      return;
    }

    // Single-letter shortcuts only apply in annotate mode, where the page is frozen: in free navigation the user types in the page.
    const active = document.activeElement;
    const typing = Boolean(active && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable));

    if (this.isInspecting && !this.isEditingComment && !typing) {
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        this.leaveAnnotateMode();
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        this.nextScreen();
        return;
      }
    }

    // Ctrl+E or Cmd+E triggers export
    if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      const hasPoints = (this.session.pages.length > 0) || (this.annotations.length > 0);
      if (!this.exportView && hasPoints) {
        this.finishAndShowExport();
      }
      return;
    }

    // Delete or Backspace removes selected annotation if not editing text
    if (this.isInspecting && (e.key === 'Delete' || e.key === 'Backspace') && this.selectedAnnotation && !this.isEditingComment && !typing) {
      e.preventDefault();
      this.deleteAnnotation(this.selectedAnnotation);
    }
  }

  createAnnotationPoint(targetElement) {
    const nextIndex = this.getPreviousPointsCount() + this.annotations.length + 1;
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
    badgeEl.title = `Annotation #${nextIndex} (cliquer pour modifier)`;
    this.shadow.appendChild(badgeEl);

    const annotation = {
      id: Date.now() + Math.random(),
      index: nextIndex,
      element: targetElement,
      comment: '',
      type: null,
      rect: { left: elemLeft, top: elemTop, width: rect.width, height: rect.height },
      badgeEl: badgeEl,
      boxEl: boxEl,
      arrowEl: arrowEl,
      metadata: null
    };

    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.requestSidePanel();
      this.selectedAnnotation = annotation;
      this.openEditor(annotation);
    });

    this.selectedAnnotation = annotation;
    this.openEditor(annotation);
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

  // ------------------------------------------------------------------
  // Editing (the form itself is rendered by the side panel)
  // ------------------------------------------------------------------

  openEditor(annotation) {
    if (this.currentEditingAnnotation && this.currentEditingAnnotation !== annotation) {
      this.cancelActiveComment();
    }
    this.isEditingComment = true;
    this.currentEditingAnnotation = annotation;
    if (this.highlightBox) this.highlightBox.style.display = 'none';
    this.broadcastPanelState();
  }

  saveEditing(comment, type) {
    const annotation = this.currentEditingAnnotation;
    if (!annotation) return;

    annotation.comment = String(comment || '').trim();
    annotation.type = ANNOTATION_TYPES[type] ? type : (annotation.type || 'style');

    if (typeof window !== 'undefined' && window.SelectorGenerator) {
      annotation.metadata = window.SelectorGenerator.getElementMetadata(
        annotation.element,
        annotation.index,
        annotation.comment
      );
    }

    if (!this.annotations.includes(annotation)) {
      this.annotations.push(annotation);
    }

    this.closeCommentModal();
    this.updateCounter();
    this.syncSessionToStorage();
    this.refreshScreenShot();

    this.sendToBackground({ action: 'SET_BADGE', text: String(this.annotations.length), color: '#C9400F' });
  }

  deleteAnnotation(annotation) {
    if (annotation.badgeEl) annotation.badgeEl.remove();
    if (annotation.boxEl) annotation.boxEl.remove();
    if (annotation.arrowEl) annotation.arrowEl.remove();

    this.annotations = this.annotations.filter(a => a !== annotation);
    if (this.selectedAnnotation === annotation) this.selectedAnnotation = null;
    this.reindexAnnotations();
    this.closeCommentModal();
    this.updateCounter();
    this.syncSessionToStorage();
    if (this.annotations.length > 0) this.refreshScreenShot(); else this.screenShot = null;

    this.sendToBackground({ action: 'SET_BADGE', text: this.annotations.length > 0 ? String(this.annotations.length) : '', color: '#C9400F' });
  }

  closeCommentModal() {
    this.isEditingComment = false;
    this.currentEditingAnnotation = null;
    this.broadcastPanelState();
    if (this.pendingFinalize) this.finalizeScreenOnChange();
  }

  cancelActiveComment() {
    const annotation = this.currentEditingAnnotation;
    if (!annotation) return;
    const isNew = !this.annotations.includes(annotation);
    if (isNew) {
      if (annotation.badgeEl) annotation.badgeEl.remove();
      if (annotation.boxEl) annotation.boxEl.remove();
      if (annotation.arrowEl) annotation.arrowEl.remove();
    }
    this.closeCommentModal();
  }

  reindexAnnotations() {
    const previousPointsCount = this.getPreviousPointsCount();

    this.annotations.forEach((ann, idx) => {
      ann.index = previousPointsCount + idx + 1;
      if (ann.badgeEl) ann.badgeEl.textContent = ann.index;
      if (ann.metadata) {
        ann.metadata.index = ann.index;
      }
    });
  }

  // ------------------------------------------------------------------
  // Export (the view itself is rendered by the side panel)
  // ------------------------------------------------------------------

  async exportAndFinish() {
    return this.finishAndShowExport();
  }

  async finishAndShowExport() {
    const hasCurrent = this.annotations.length > 0;
    const hasPrevious = this.session && this.session.pages && this.session.pages.length > 0;

    if (!hasCurrent && !hasPrevious) {
      this.showToast('Aucune annotation enregistrée. Cliquez d\'abord sur un élément pour annoter.');
      return;
    }

    if (this.currentEditingAnnotation) {
      this.cancelActiveComment();
    }

    this.showToast('Préparation de l\'exportation...');
    if (this.highlightBox) this.highlightBox.style.display = 'none';

    try {
      const allPages = [...(this.session.pages || [])];
      let currentPageDataUrl = allPages.length ? allPages[allPages.length - 1].dataUrl : '';
      if (hasCurrent) {
        currentPageDataUrl = await this.captureScreen();
        allPages.push(this.snapshotPage(allPages.length + 1, currentPageDataUrl));
      }

      this.exportPages = allPages;
      this.exportViewId = Date.now();
      this.imageUrls = {};
      this.exportView = this.buildExportView(allPages, currentPageDataUrl);
      this.status = null;
      this.broadcastPanelState();
    } catch (err) {
      console.error('[AI Web Annotator] Export failed:', err);
      this.showToast(`Erreur : ${err.message}`);
    }
  }

  /** Builds what the panel shows for an export; image URLs (when hosted) are woven into every format. */
  buildExportView(pages, lastDataUrl) {
    const withUrls = pages.map(p => ({ ...p, imageUrl: (this.imageUrls && this.imageUrls[p.stepIndex]) || null }));
    const payload = this.generateMultiPagePayload(withUrls);
    const prompts = {
      agent: this.generateConsolidatedPrompt(withUrls, 'agent'),
      github: this.generateConsolidatedPrompt(withUrls, 'github'),
      json: ''
    };
    payload.aiPrompt = prompts.agent;
    prompts.json = JSON.stringify(payload, null, 2);
    this.lastExportData = { dataUrl: lastDataUrl, promptText: prompts.agent, payload, pages: withUrls };
    return {
      id: this.exportViewId,
      pages: withUrls.map(p => ({
        stepIndex: p.stepIndex,
        title: p.title,
        url: p.url,
        dataUrl: p.dataUrl,
        imageUrl: p.imageUrl,
        count: (p.annotations || []).length
      })),
      prompts,
      payload
    };
  }

  /** Called by the panel once the screenshots are hosted: rebuild prompts/JSON with their URLs. */
  setExportImageUrls(urls) {
    if (!this.exportView || !this.exportPages) return;
    this.imageUrls = { ...(urls || {}) };
    this.exportView = this.buildExportView(this.exportPages, this.lastExportData && this.lastExportData.dataUrl);
    this.broadcastPanelState();
  }

  closeExportView() {
    this.exportView = null;
    this.broadcastPanelState();
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
      if (page.imageUrl) {
        prompt += `- **Capture d'écran annotée** : ${page.imageUrl}\n`;
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
      if (page.imageUrl) {
        md += `![Écran ${page.stepIndex}](${page.imageUrl})\n\n`;
      }
      (page.annotations || []).forEach((a) => {
        const meta = a.metadata ? a.metadata.element : {};
        md += `- [ ] **[Point #${a.index}]** **${ANNOTATION_TYPES[a.type] || 'Style'}** \`${meta.cssSelector || meta.tag || 'element'}\` : ${a.comment || 'À corriger'}\n`;
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
        imageUrl: p.imageUrl || null,
        annotations: p.annotations
      })),
      aiPrompt: promptText || this.generateConsolidatedPrompt(pages, 'agent')
    };
  }
}

/**
 * Is this burst of DOM changes a new UI state (dialog, menu, panel, route...) rather than ambient noise?
 * A change counts when a structural element (dialog, menu, nav, tabs...) appears or disappears, or when
 * a large area of the page is added.
 */
AnnotatorUIManager.STRUCTURAL_ROLES = /^(dialog|alertdialog|menu|menubar|listbox|tablist|tabpanel|navigation|complementary|main)$/;
AnnotatorUIManager.STRUCTURAL_TAGS = /^(dialog|nav|aside|main|menu)$/;
AnnotatorUIManager.NEW_SCREEN_MIN_AREA = 30000; // px² of added elements
AnnotatorUIManager.AMBIENT_NAMES = /(^|[\s_-])(ads?|advert\w*|sponsor\w*|clock|ticker|spinner|loader|skeleton|carousel|slide\w*|toast|badge|tooltip)([\s_-]|$)/i;
AnnotatorUIManager.isNewScreen = function (changes) {
  let addedArea = 0;
  for (const c of changes || []) {
    const label = `${c.className || ''} ${c.id || ''}`;
    if (AnnotatorUIManager.AMBIENT_NAMES.test(label) || c.role === 'status' || c.role === 'tooltip' || c.role === 'progressbar') continue;
    if (AnnotatorUIManager.STRUCTURAL_ROLES.test(c.role || '') || AnnotatorUIManager.STRUCTURAL_TAGS.test(c.tag || '')) return true;
    if (c.kind === 'added') addedArea += (c.width || 0) * (c.height || 0);
  }
  return addedArea >= AnnotatorUIManager.NEW_SCREEN_MIN_AREA;
};
AnnotatorUIManager.PLACEHOLDER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Automatic new screen when the page changes: off, the "Nouvel écran" button is the explicit way.
AnnotatorUIManager.AUTO_SCREEN_ON_DOM_CHANGE = false;
AnnotatorUIManager.STALE_TOLERANCE_PX = 4;
AnnotatorUIManager.DOM_CHANGE_THRESHOLD = 3; // element nodes added/removed within one window
AnnotatorUIManager.DOM_CHANGE_WINDOW_MS = 500;

if (typeof window !== 'undefined') {
  window.AnnotatorUI = new AnnotatorUIManager();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnnotatorUIManager;
}
