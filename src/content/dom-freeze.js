/**
 * DOM Freeze Engine
 * Intercepts and suppresses all regular web page interactions (clicks, form submits, keypresses)
 * while allowing interaction with the extension UI.
 */

class DOMFreezeManager {
  constructor() {
    this.isActive = false;
    this.interceptedEvents = [
      'click',
      'dblclick',
      'mousedown',
      'mouseup',
      'pointerdown',
      'pointerup',
      'contextmenu',
      'submit'
    ];
    this.boundHandler = this.handleEvent.bind(this);
    this.boundKeyHandler = this.handleKeydown.bind(this);
  }

  isExtensionEvent(event) {
    const root = document.getElementById('ai-web-annotator-root');
    if (!root) return false;

    // Check composedPath for Shadow DOM traversal
    const path = event.composedPath ? event.composedPath() : [];
    return path.includes(root);
  }

  handleEvent(event) {
    if (!this.isActive) return;

    // Allow interaction if it originates from our extension Shadow DOM UI
    if (this.isExtensionEvent(event)) {
      return;
    }

    // Freeze page: stop all propagation and default browser actions (like link navigation or form submit)
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  handleKeydown(event) {
    if (!this.isActive) return;

    if (this.isExtensionEvent(event)) {
      return;
    }

    // Allow F12, DevTools shortcuts, but prevent page shortcuts
    if (event.key === 'F12' || (event.ctrlKey && event.shiftKey && (event.key === 'I' || event.key === 'C'))) {
      return;
    }

    // Stop page from catching keys while annotating
    if (event.key !== 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  }

  enable() {
    if (this.isActive) return;
    this.isActive = true;

    for (const evt of this.interceptedEvents) {
      window.addEventListener(evt, this.boundHandler, true);
    }
    window.addEventListener('keydown', this.boundKeyHandler, true);

    document.documentElement.classList.add('ai-annotator-page-frozen');
    console.log('[AI Web Annotator] Page interactions frozen.');
  }

  disable() {
    if (!this.isActive) return;
    this.isActive = false;

    for (const evt of this.interceptedEvents) {
      window.removeEventListener(evt, this.boundHandler, true);
    }
    window.removeEventListener('keydown', this.boundKeyHandler, true);

    document.documentElement.classList.remove('ai-annotator-page-frozen');
    console.log('[AI Web Annotator] Page interactions un-frozen.');
  }
}

if (typeof window !== 'undefined') {
  window.DOMFreeze = new DOMFreezeManager();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DOMFreezeManager;
}
