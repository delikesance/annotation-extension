/**
 * Content Script Entry Point
 * Listens for extension messages and toggles the annotation mode.
 */

(() => {
  // Guard against multiple initializations
  if (window.__aiWebAnnotatorLoaded) return;
  window.__aiWebAnnotatorLoaded = true;

  console.log('[AI Web Annotator] Content script loaded and ready.');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TOGGLE_ANNOTATOR') {
      if (window.AnnotatorUI) {
        if (window.AnnotatorUI.isInspecting) {
          window.AnnotatorUI.deactivate();
        } else {
          window.AnnotatorUI.activate();
        }
      }
      sendResponse({ success: true, active: window.AnnotatorUI ? window.AnnotatorUI.isInspecting : false });
      return false;
    }
  });
})();
