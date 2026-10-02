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

    this.annotations = []; // Array of { id, index, element, comment, badgeEl, boxEl, metadata }
    this.hoveredElement = null;
    this.isInspecting = false;
    this.isEditingComment = false;

    this.boundOnMouseMove = this.onMouseMove.bind(this);
    this.boundOnClick = this.onClick.bind(this);
    this.boundOnKeyDown = this.onKeyDown.bind(this);
  }

  init() {
    if (this.host) return;

    this.host = document.createElement('div');
    this.host.id = 'ai-web-annotator-root';
    document.body.appendChild(this.host);

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
      <button class="ai-hud-btn ai-hud-btn-primary" id="ai-btn-export" title="Exporter capture et données JSON">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Terminer & Exporter</span>
      </button>
      <button class="ai-hud-btn ai-hud-btn-danger" id="ai-btn-cancel" title="Quitter le mode annotation (Échap)">
        <span>Quitter</span>
      </button>
    `;

    this.hud.querySelector('#ai-btn-export').addEventListener('click', () => this.exportAndFinish());
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

    // Clear saved annotations
    for (const ann of this.annotations) {
      if (ann.badgeEl) ann.badgeEl.remove();
      if (ann.boxEl) ann.boxEl.remove();
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

    if (!this.hoveredElement) return;

    this.createAnnotationPoint(this.hoveredElement);
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.activeCommentCard) {
        this.cancelActiveComment();
      } else {
        this.deactivate();
      }
    }
  }

  createAnnotationPoint(targetElement) {
    const nextIndex = this.annotations.length + 1;
    const rect = targetElement.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    // Hide hover highlight box while creating point
    this.highlightBox.style.display = 'none';

    // 1. Target boundary box
    const boxEl = document.createElement('div');
    boxEl.className = 'ai-annotated-target-box';
    boxEl.style.top = `${rect.top + scrollY}px`;
    boxEl.style.left = `${rect.left + scrollX}px`;
    boxEl.style.width = `${rect.width}px`;
    boxEl.style.height = `${rect.height}px`;
    this.shadow.appendChild(boxEl);

    // 2. Numbered Badge
    const badgeEl = document.createElement('div');
    badgeEl.className = 'ai-annotation-badge';
    badgeEl.textContent = nextIndex;
    badgeEl.style.top = `${rect.top + scrollY}px`;
    badgeEl.style.left = `${rect.left + scrollX}px`;
    badgeEl.title = `Annotation #${nextIndex} (Cliquer pour modifier)`;
    this.shadow.appendChild(badgeEl);

    const annotation = {
      id: Date.now() + Math.random(),
      index: nextIndex,
      element: targetElement,
      comment: '',
      badgeEl: badgeEl,
      boxEl: boxEl,
      metadata: null
    };

    badgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openCommentModal(annotation);
    });

    this.openCommentModal(annotation, true);
  }

  openCommentModal(annotation, isNew = false) {
    if (this.activeCommentCard) {
      this.activeCommentCard.remove();
    }

    this.isEditingComment = true;
    const rect = annotation.element.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    const card = document.createElement('div');
    card.className = 'ai-comment-card';

    // Position popover near badge
    let modalTop = rect.top + scrollY + 24;
    let modalLeft = rect.left + scrollX + 16;

    // Boundary check so modal stays on screen
    if (modalLeft + 330 > window.innerWidth) {
      modalLeft = Math.max(16, window.innerWidth - 340);
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

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveAction();
      }
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

  async exportAndFinish() {
    if (this.annotations.length === 0) {
      this.showToast('Aucune annotation enregistrée à exporter.');
      return;
    }

    if (this.activeCommentCard) {
      this.closeCommentModal();
    }

    this.showToast('Génération de la capture et du contexte IA...');

    // 1. Temporarily hide HUD and highlight box so only the web page and numbered badges appear in screenshot
    this.hud.style.display = 'none';
    this.highlightBox.style.display = 'none';

    await new Promise(r => setTimeout(r, 120)); // Allow DOM repaint

    try {
      // 2. Request native high-fidelity screenshot from background worker
      const response = await chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });

      // Restore HUD visibility
      this.hud.style.display = 'flex';

      if (!response || !response.success || !response.dataUrl) {
        throw new Error(response ? response.error : 'Capture non disponible');
      }

      const hostname = window.location.hostname.replace(/[^a-z0-9]/gi, '_') || 'page';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // 3. Trigger download of screenshot PNG
      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_FILE',
        url: response.dataUrl,
        filename: `annotation-${hostname}-${timestamp}.png`
      });

      // 4. Compile Structured JSON Context
      const payload = {
        meta: {
          generator: 'AI Web Annotator (Manifest V3)',
          version: '1.0.0',
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
        aiPromptPreview: this.generateAIPrompt()
      };

      // 5. Trigger download of JSON Context
      const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const jsonBlobUrl = URL.createObjectURL(jsonBlob);

      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_FILE',
        url: jsonBlobUrl,
        filename: `annotation-context-${hostname}-${timestamp}.json`
      });

      // 6. Copy AI prompt to clipboard
      try {
        await navigator.clipboard.writeText(payload.aiPromptPreview);
        this.showToast('✅ Export réussi ! Capture PNG, JSON & Prompt IA copiés.');
      } catch (_) {
        this.showToast('✅ Export réussi ! Capture PNG et JSON téléchargés.');
      }

      // Automatically deactivate after brief delay
      setTimeout(() => this.deactivate(), 2500);

    } catch (err) {
      this.hud.style.display = 'flex';
      console.error('[AI Web Annotator] Export failed:', err);
      this.showToast(`Erreur lors de l'export: ${err.message}`);
    }
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
