/**
 * UI Manager for AI Web Annotator
 * Manages the Shadow DOM lifecycle, hover inspector, numbered badges,
 * inline comment card, HUD toolbar, and export workflow.
 */

class AnnotatorUIManager {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.hud = null;
    this.highlightBox = null;
    this.highlightLabel = null;
    this.activeCommentCard = null;

    this.annotations = []; // Array of { id, index, element, comment, badgeEl, boxEl, arrowEl, metadata }
    this.hoveredElement = null;
    this.isInspecting = false;
    this.isEditingComment = false;
    this.activeExportModal = null;
    this.lastExportData = null;

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

    // Inject styles into Shadow DOM
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = chrome.runtime.getURL('content/styles.css');
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
      <div class="ai-hud-status">
        <span class="ai-pulse-dot"></span>
        <span>Page Figée</span>
      </div>
      <div class="ai-hud-counter" id="ai-counter">0 annotation</div>
      <button class="ai-hud-btn ai-hud-btn-primary" id="ai-btn-export" title="Terminer et copier l'image / le prompt">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Terminer</span>
      </button>
      <button class="ai-hud-btn ai-hud-btn-danger" id="ai-btn-cancel" title="Quitter le mode annotation (Échap)">
        <span>Quitter</span>
      </button>
    `;

    this.hud.querySelector('#ai-btn-export').addEventListener('click', () => this.finishAndShowExportModal());
    this.hud.querySelector('#ai-btn-cancel').addEventListener('click', () => this.deactivate());

    this.shadow.appendChild(this.hud);
  }

  updateCounter() {
    const counter = this.shadow.getElementById('ai-counter');
    if (!counter) return;
    const count = this.annotations.length;
    counter.textContent = `${count} annotation${count > 1 ? 's' : ''}`;
  }

  activate() {
    this.init();
    this.isInspecting = true;

    // Enable page interaction freeze
    if (window.DOMFreeze) {
      window.DOMFreeze.enable();
    }

    // Attach mouse and key listeners
    window.addEventListener('mousemove', this.boundOnMouseMove, true);
    window.addEventListener('click', this.boundOnClick, true);
    window.addEventListener('keydown', this.boundOnKeyDown, true);

    this.host.style.display = 'block';
    this.showToast('Mode Annotation activé : Cliquez sur un élément pour annoter.');
  }

  deactivate() {
    this.isInspecting = false;
    this.isEditingComment = false;

    // Un-freeze DOM
    if (window.DOMFreeze) {
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

    // Clear saved annotations
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

    // Reset action badge
    chrome.runtime.sendMessage({ action: 'SET_BADGE', text: '' }).catch(() => {});
  }

  onMouseMove(e) {
    if (!this.isInspecting || this.isEditingComment) return;

    // Find element under cursor excluding our extension UI
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
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

    // Format tag label
    const tag = target.tagName.toLowerCase();
    const id = target.id ? `#${target.id}` : '';
    const firstClass = target.classList.length > 0 ? `.${target.classList[0]}` : '';
    this.highlightLabel.textContent = `<${tag}${id}${firstClass}>`;
  }

  onClick(e) {
    if (!this.isInspecting) return;

    // Allow interaction with Shadow DOM elements (buttons, inputs)
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(this.host)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // If already editing a comment, don't create another point immediately
    if (this.isEditingComment) {
      return;
    }

    // Determine target element under cursor (fallback to elementsFromPoint or e.target if hoveredElement is not set)
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
    }
  }

  createAnnotationPoint(targetElement) {
    const nextIndex = this.annotations.length + 1;
    const rect = targetElement.getBoundingClientRect ? targetElement.getBoundingClientRect() : { top: 0, left: 0, width: 0, height: 0 };
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    // Hide hover highlight box while creating point
    this.highlightBox.style.display = 'none';

    // Target coordinates
    const elemLeft = rect.left + scrollX;
    const elemTop = rect.top + scrollY;
    const elemWidth = Math.max(rect.width, 12);
    const elemHeight = Math.max(rect.height, 12);

    // 1. Target boundary box
    const boxEl = document.createElement('div');
    boxEl.className = 'ai-annotated-target-box';
    boxEl.style.top = `${elemTop}px`;
    boxEl.style.left = `${elemLeft}px`;
    boxEl.style.width = `${elemWidth}px`;
    boxEl.style.height = `${elemHeight}px`;
    this.shadow.appendChild(boxEl);

    // Compute smart badge position & target arrow destination
    let tx = elemLeft + 2;
    let ty = elemTop + 2;
    let bx = elemLeft - 36;
    let by = elemTop - 36;

    // Boundary checks: if near top or left of screen/document
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

    // 2. Visual directional arrow from badge to target element
    const arrowEl = this.createArrowElement(nextIndex, bx, by, tx, ty);
    this.shadow.appendChild(arrowEl);

    // 3. Numbered Badge (pinned at bx, by)
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
      this.openCommentModal(annotation);
    });

    this.openCommentModal(annotation, true);
  }

  createArrowElement(index, bx, by, tx, ty) {
    const dx = tx - bx;
    const dy = ty - by;
    const dist = Math.hypot(dx, dy);

    // Arrow starts at radius 16px from badge center (bx, by)
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
      <!-- White halo for high visibility on any page background -->
      <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#ffffff" stroke-width="5" stroke-linecap="round" marker-end="url(#${markerIdWhite})" />
      <!-- Main indigo arrow line -->
      <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#4f46e5" stroke-width="2.5" stroke-linecap="round" marker-end="url(#${markerId})" />
    `;

    return svg;
  }

  openCommentModal(annotation, isNew = false) {
    // If currently editing another annotation that was new and unsaved, cancel it first
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

    // Position popover near badge
    let modalTop = badgeTop + 24;
    let modalLeft = badgeLeft + 16;

    // Boundary check so modal stays on screen horizontally
    if (rect.left + 340 > viewportWidth) {
      modalLeft = Math.max(scrollX + 16, scrollX + viewportWidth - 340);
    }

    // Boundary check vertically: if bottom is cut off, display above the element
    if (rect.top + 200 > viewportHeight && rect.top > 160) {
      modalTop = Math.max(scrollY + 16, badgeTop - 170);
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
      </div>
      <textarea class="ai-comment-textarea" placeholder="Indiquez ce que l'IA doit analyser ou modifier sur cet élément...">${annotation.comment || ''}</textarea>
      <div class="ai-comment-footer">
        <span class="ai-comment-hint">Entrée pour valider</span>
        <div class="ai-comment-actions">
          <button class="ai-btn-sm ai-btn-delete" id="ai-modal-delete">${isNew ? 'Annuler' : 'Supprimer'}</button>
          <button class="ai-btn-sm ai-btn-save" id="ai-modal-save">Valider</button>
        </div>
      </div>
    `;

    const textarea = card.querySelector('textarea');
    const saveBtn = card.querySelector('#ai-modal-save');
    const deleteBtn = card.querySelector('#ai-modal-delete');

    const saveAction = () => {
      const text = textarea.value.trim();
      annotation.comment = text;

      // Extract DOM metadata
      if (window.SelectorGenerator) {
        annotation.metadata = window.SelectorGenerator.getElementMetadata(
          annotation.element,
          annotation.index,
          annotation.comment
        );
      }

      if (isNew) {
        this.annotations.push(annotation);
      }

      this.closeCommentModal();
      this.updateCounter();

      // Update extension toolbar badge count
      chrome.runtime.sendMessage({
        action: 'SET_BADGE',
        text: String(this.annotations.length),
        color: '#4f46e5'
      }).catch(() => {});
    };

    const deleteAction = () => {
      if (annotation.badgeEl) annotation.badgeEl.remove();
      if (annotation.boxEl) annotation.boxEl.remove();
      if (annotation.arrowEl) annotation.arrowEl.remove();

      this.annotations = this.annotations.filter(a => a !== annotation);
      this.reindexAnnotations();
      this.closeCommentModal();
      this.updateCounter();

      chrome.runtime.sendMessage({
        action: 'SET_BADGE',
        text: this.annotations.length > 0 ? String(this.annotations.length) : '',
        color: '#4f46e5'
      }).catch(() => {});
    };

    saveBtn.addEventListener('click', saveAction);
    deleteBtn.addEventListener('click', deleteAction);

    // Isolate keyboard events so typing in textarea NEVER triggers website shortcuts
    ['keydown', 'keyup', 'keypress'].forEach(evtType => {
      card.addEventListener(evtType, (e) => {
        e.stopPropagation();
      });
    });

    textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveAction();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelActiveComment();
      }
    });

    textarea.addEventListener('keyup', (e) => {
      e.stopPropagation();
    });

    textarea.addEventListener('keypress', (e) => {
      e.stopPropagation();
    });

    this.shadow.appendChild(card);
    this.activeCommentCard = card;
    this.currentEditingAnnotation = annotation;

    setTimeout(() => textarea.focus(), 50);
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
    this.annotations.forEach((ann, idx) => {
      ann.index = idx + 1;
      if (ann.badgeEl) ann.badgeEl.textContent = ann.index;
      if (ann.metadata) {
        ann.metadata.index = ann.index;
      }
    });
  }

  // Alias for backward compatibility
  async exportAndFinish() {
    return this.finishAndShowExportModal();
  }

  async finishAndShowExportModal() {
    if (this.annotations.length === 0) {
      this.showToast('Aucune annotation enregistrée. Cliquez d\'abord sur un élément pour annoter.');
      return;
    }

    if (this.activeCommentCard) {
      this.closeCommentModal();
    }

    this.showToast('Génération de la capture avec flèches & prompt IA...');

    // 1. Temporarily hide HUD and highlight box so only the web page, arrows, and numbered badges appear in screenshot
    this.hud.style.display = 'none';
    this.highlightBox.style.display = 'none';

    await new Promise(r => setTimeout(r, 150)); // Allow DOM repaint

    try {
      // 2. Request native high-fidelity screenshot from background worker
      const response = await chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });

      // Restore HUD visibility
      this.hud.style.display = 'flex';

      if (!response || !response.success || !response.dataUrl) {
        throw new Error(response ? response.error : 'Capture non disponible');
      }

      // 3. Compile prompt and payload
      const promptText = this.generateAIPrompt();
      const payload = this.generateContextPayload(promptText);

      this.lastExportData = {
        dataUrl: response.dataUrl,
        promptText: promptText,
        payload: payload
      };

      // 4. Show the Export Completion Modal with Copy Image & Copy Prompt buttons!
      this.showExportModal(response.dataUrl, promptText, payload);

    } catch (err) {
      this.hud.style.display = 'flex';
      console.error('[AI Web Annotator] Capture failed:', err);
      this.showToast(`Erreur lors de la capture: ${err.message}`);
    }
  }

  showExportModal(dataUrl, promptText, payload) {
    if (this.activeExportModal) {
      this.activeExportModal.remove();
    }

    const modal = document.createElement('div');
    modal.className = 'ai-export-backdrop';
    modal.innerHTML = `
      <div class="ai-export-dialog">
        <div class="ai-export-header">
          <div class="ai-export-title-row">
            <span class="ai-export-pill">${this.annotations.length} annotation${this.annotations.length > 1 ? 's' : ''}</span>
            <h3 class="ai-export-title">Annotations prêtes pour l'IA</h3>
          </div>
          <button class="ai-export-close-btn" id="ai-modal-close" title="Fermer (Échap)">✕</button>
        </div>

        <div class="ai-export-body">
          <div class="ai-export-preview-container">
            <img class="ai-export-thumbnail" src="${dataUrl}" alt="Aperçu capture annotée" />
            <div class="ai-export-preview-overlay">
              <span class="ai-export-preview-tag">✓ Capture avec flèches & indicateurs</span>
            </div>
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
                <span class="ai-action-sub-text">Markdown structuré</span>
              </div>
            </button>
          </div>

          <div class="ai-export-secondary-actions">
            <button class="ai-export-sub-btn" id="ai-btn-dl-png" title="Enregistrer l'image PNG sur l'ordinateur">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Télécharger PNG</span>
            </button>

            <button class="ai-export-sub-btn" id="ai-btn-dl-json" title="Enregistrer les données JSON">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="16 18 22 12 16 6"></polyline>
                <polyline points="8 6 2 12 8 18"></polyline>
              </svg>
              <span>Télécharger JSON</span>
            </button>
          </div>

          <div class="ai-export-prompt-preview-wrap">
            <div class="ai-export-prompt-label">Aperçu du prompt IA :</div>
            <pre class="ai-export-prompt-pre">${this.escapeHtml(promptText)}</pre>
          </div>
        </div>

        <div class="ai-export-footer">
          <button class="ai-btn-footer-link" id="ai-btn-resume">Continuer d'annoter</button>
          <button class="ai-btn-footer-danger" id="ai-btn-quit-all">Quitter l'annotateur</button>
        </div>
      </div>
    `;

    // Button event listeners
    const copyImgBtn = modal.querySelector('#ai-btn-copy-image');
    const copyPromptBtn = modal.querySelector('#ai-btn-copy-prompt');
    const dlPngBtn = modal.querySelector('#ai-btn-dl-png');
    const dlJsonBtn = modal.querySelector('#ai-btn-dl-json');
    const resumeBtn = modal.querySelector('#ai-btn-resume');
    const quitBtn = modal.querySelector('#ai-btn-quit-all');
    const closeBtn = modal.querySelector('#ai-modal-close');

    // Isolate keyboard events inside the export modal from the parent page
    ['keydown', 'keyup', 'keypress'].forEach(evtType => {
      modal.addEventListener(evtType, (e) => {
        if (e.key === 'Escape') return; // Allow Escape to close modal
        e.stopPropagation();
      });
    });

    copyImgBtn.addEventListener('click', () => this.copyImageToClipboard(dataUrl, copyImgBtn));
    copyPromptBtn.addEventListener('click', () => this.copyPromptToClipboard(promptText, copyPromptBtn));
    dlPngBtn.addEventListener('click', () => this.downloadPNG(dataUrl));
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
    const nav = (typeof window !== 'undefined' && window.navigator && window.navigator.clipboard) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const pngBlob = blob.type === 'image/png' ? blob : new Blob([await blob.arrayBuffer()], { type: 'image/png' });

      if (nav && nav.clipboard && nav.clipboard.write) {
        await nav.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob })
        ]);
      } else {
        throw new Error('Clipboard write not supported');
      }

      this.markButtonSuccess(btn, '✅ Image copiée !');
      this.showToast('✅ Image copiée ! Vous pouvez la coller dans votre IA (Ctrl+V).');
    } catch (err) {
      console.warn('[AI Web Annotator] Image clipboard write failed:', err);
      // Fallback: trigger download so user still gets the image
      await this.downloadPNG(dataUrl);
      this.showToast('⚠️ Image téléchargée (accès presse-papier restreint par le navigateur).');
    }
  }

  async copyPromptToClipboard(promptText, btn) {
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
    await chrome.runtime.sendMessage({
      action: 'DOWNLOAD_FILE',
      url: dataUrl,
      filename: `annotation-${hostname}-${timestamp}.png`
    });
    this.showToast('💾 Capture PNG téléchargée.');
  }

  async downloadJSON(payload) {
    const hostname = window.location.hostname.replace(/[^a-z0-9]/gi, '_') || 'page';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const jsonBlobUrl = URL.createObjectURL(jsonBlob);
    await chrome.runtime.sendMessage({
      action: 'DOWNLOAD_FILE',
      url: jsonBlobUrl,
      filename: `annotation-context-${hostname}-${timestamp}.json`
    });
    this.showToast('📄 Données JSON téléchargées.');
  }

  generateContextPayload(promptText) {
    return {
      meta: {
        generator: 'AI Web Annotator (Manifest V3)',
        version: '1.0.2',
        pageUrl: window.location.href,
        pageTitle: document.title,
        timestamp: new Date().toISOString(),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          scrollX: window.scrollX || window.pageXOffset || 0,
          scrollY: window.scrollY || window.pageYOffset || 0
        },
        totalAnnotations: this.annotations.length
      },
      annotations: this.annotations.map(a => a.metadata || {
        index: a.index,
        comment: a.comment,
        element: {
          tag: a.element.tagName,
          id: a.element.id || null
        }
      }),
      aiPromptPreview: promptText || this.generateAIPrompt()
    };
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

  generateAIPrompt() {
    let prompt = `### Contexte de la page web annotée\n`;
    prompt += `- **URL** : ${window.location.href}\n`;
    prompt += `- **Titre** : ${document.title}\n`;
    prompt += `- **Dimensions Viewport** : ${window.innerWidth}x${window.innerHeight}\n\n`;
    prompt += `### Points d'annotations sur la capture d'écran :\n`;

    this.annotations.forEach(a => {
      const meta = a.metadata ? a.metadata.element : {};
      prompt += `\n**[Point #${a.index}]**\n`;
      prompt += `- **Commentaire / Demande** : ${a.comment || '(Aucun commentaire)'}\n`;
      prompt += `- **Élément DOM** : \`<${meta.tag ? meta.tag.toLowerCase() : 'element'}>\`\n`;
      if (meta.cssSelector) prompt += `- **Sélecteur CSS** : \`${meta.cssSelector}\`\n`;
      if (meta.xpath) prompt += `- **XPath** : \`${meta.xpath}\`\n`;
      if (meta.text) prompt += `- **Texte visible** : "${meta.text}"\n`;
    });

    return prompt;
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
