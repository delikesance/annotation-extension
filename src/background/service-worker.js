/**
 * Service Worker (Background script - Manifest V3)
 * Handles extension activation, screenshot capture via Chrome API, and file downloads.
 */

// Toggle annotator when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  // Check for restricted URLs (chrome://, edge://, etc.)
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
    console.warn('[AI Web Annotator] Cannot run on restricted browser pages.');
    return;
  }

  try {
    // Try sending message to existing content script
    await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_ANNOTATOR' });
  } catch (err) {
    // Content script not loaded yet in this tab, inject dynamically
    console.log('[AI Web Annotator] Injecting content scripts into tab:', tab.id);
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/styles.css']
      });

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'content/selector-generator.js',
          'content/dom-freeze.js',
          'content/ui-manager.js',
          'content/content-script.js'
        ]
      });

      // Send toggle message after injection
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_ANNOTATOR' }).catch((e) => {
          console.error('[AI Web Annotator] Failed to toggle after injection:', e);
        });
      }, 50);
    } catch (injectErr) {
      console.error('[AI Web Annotator] Failed to inject scripts:', injectErr);
    }
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CAPTURE_VISIBLE_TAB') {
    const windowId = sender.tab ? sender.tab.windowId : undefined;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      .then((dataUrl) => {
        sendResponse({ success: true, dataUrl });
      })
      .catch((error) => {
        console.error('[AI Web Annotator] Capture failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep message channel open for async response
  }

  if (message.action === 'DOWNLOAD_FILE') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: false
    })
      .then((downloadId) => {
        sendResponse({ success: true, downloadId });
      })
      .catch((error) => {
        console.error('[AI Web Annotator] Download failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'SET_BADGE') {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId) {
      chrome.action.setBadgeText({ tabId, text: message.text || '' });
      if (message.color) {
        chrome.action.setBadgeBackgroundColor({ tabId, color: message.color });
      }
    }
    sendResponse({ success: true });
    return false;
  }
});
