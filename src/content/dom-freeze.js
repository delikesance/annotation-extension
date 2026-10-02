/**
 * DOM Freeze Engine
 * Intercepts and suppresses all regular web page interactions (clicks, form submits, keypresses)
 * while allowing interaction with the extension UI.
 */

class DOMFreezeManager {
  constructor() {
    this.isActive = false;
    // Events to completely suppress on the webpage (prevent default + stop propagation)
    this.interceptedEvents = [
      'submit',
      'contextmenu',
      'dblclick',
      'dragstart'
    ];
    // Mouse events to stop propagation to webpage handlers without preventing click generation
    this.stoppedMouseEvents = [
      'mousedown',
      'mouseup',
      'pointerdown',
      'pointerup'
    ];
    this.boundHandler = this.handleEvent.bind(this);
    this.boundMouseHandler = this.handleMouseEvent.bind(this);
    this.boundKeyHandler = this.handleKeydown.bind(this);
  }

  isExtensionEvent(event) {
    const root = document.getElementById('ai-web-annotator-root');
    const path = event.composedPath ? event.composedPath() : [];
    if (root && path.includes(root)) return true;
    if (event.target) {
      if (root && root.contains(event.target)) return true;
      if (typeof event.target.className === 'string' && event.target.className.includes('ai-')) return true;
    }
    return false;
  }

  handleEvent(event) {
    if (!this.isActive) return;

    // Allow interaction if it originates from our extension Shadow DOM UI
    if (this.isExtensionEvent(event)) {
      return;
    }

    // Freeze page: stop all propagation and default browser actions (like form submit or contextmenu)
    event.preventDefault();
    event.stopPropagation();
  }

  handleMouseEvent(event) {
    if (!this.isActive) return;

    // Allow interaction if it originates from our extension Shadow DOM UI
    if (this.isExtensionEvent(event)) {
      return;
    }

    // Stop propagation so page scripts do not catch mousedown/pointerdown
    // Note: Do NOT call preventDefault() here, otherwise Chromium suppresses 'click' events.
    event.stopPropagation();
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
    }
  }

  enable() {
    if (this.isActive) return;
    this.isActive = true;

    for (const evt of this.interceptedEvents) {
      window.addEventListener(evt, this.boundHandler, true);
    }
    for (const evt of this.stoppedMouseEvents) {
      window.addEventListener(evt, this.boundMouseHandler, true);
    }
    for (const evt of ['keydown', 'keyup', 'keypress']) {
      window.addEventListener(evt, this.boundKeyHandler, true);
    }

    document.documentElement.classList.add('ai-annotator-page-frozen');
    console.log('[AI Web Annotator] Page interactions frozen.');
  }

  disable() {
    if (!this.isActive) return;
    this.isActive = false;

    for (const evt of this.interceptedEvents) {
      window.removeEventListener(evt, this.boundHandler, true);
    }
    for (const evt of this.stoppedMouseEvents) {
      window.removeEventListener(evt, this.boundMouseHandler, true);
    }
    for (const evt of ['keydown', 'keyup', 'keypress']) {
      window.removeEventListener(evt, this.boundKeyHandler, true);
    }

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
