/**
 * Content Script Entry Point
 * Listens for extension messages and toggles annotation / pause / session restore.
 */

(() => {
  if (window.__aiWebAnnotatorLoaded) return;
  window.__aiWebAnnotatorLoaded = true;

  console.log('[AI Web Annotator] Content script loaded and ready.');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TOGGLE_ANNOTATOR') {
      if (window.AnnotatorUI) {
        if (window.AnnotatorUI.isInspecting || window.AnnotatorUI.isPaused) {
          window.AnnotatorUI.deactivate();
        } else {
          window.AnnotatorUI.activate();
        }
      }
      sendResponse({ success: true, active: window.AnnotatorUI ? (window.AnnotatorUI.isInspecting || window.AnnotatorUI.isPaused) : false });
      return false;
    }

    if (message.action === 'RESTORE_SESSION') {
      if (window.AnnotatorUI) {
        window.AnnotatorUI.restoreFromSession(message.session);
      }
      sendResponse({ success: true });
      return false;
    }

    if (message.action === 'TOGGLE_PAUSE') {
      if (window.AnnotatorUI) {
        window.AnnotatorUI.togglePause();
      }
      sendResponse({ success: true, isPaused: window.AnnotatorUI ? window.AnnotatorUI.isPaused : false });
      return false;
    }
  });
})();
