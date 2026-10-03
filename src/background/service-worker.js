/**
 * Service Worker (Background script - Manifest V3)
 * Handles extension activation, multi-page session persistence across navigations,
 * screenshot capture via Chrome API, zero-friction clipboard proxy via Offscreen API,
 * and file downloads.
 */

let creatingOffscreenDocument = null;

async function setupOffscreenDocument(path) {
  if (await hasOffscreenDocument(path)) return;
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
  } else {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Zero-friction copy of annotated screenshots and AI prompts to system clipboard'
    });
    await creatingOffscreenDocument;
    creatingOffscreenDocument = null;
  }
}

async function hasOffscreenDocument(path) {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(path)]
    });
    return Boolean(contexts && contexts.length > 0);
  }
  if (typeof clients !== 'undefined' && clients.matchAll) {
    const matchedClients = await clients.matchAll();
    return matchedClients.some(c => c.url === chrome.runtime.getURL(path));
  }
  return false;
}

// Inject scripts into a tab
async function injectAnnotatorScripts(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/styles.css']
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'content/selector-generator.js',
        'content/dom-freeze.js',
        'content/ui-manager.js',
        'content/content-script.js'
      ]
    });
    return true;
  } catch (err) {
    console.warn('[AI Web Annotator] Injection error:', err);
    return false;
  }
}

// Toggle annotator when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
    console.warn('[AI Web Annotator] Cannot run on restricted browser pages.');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_ANNOTATOR' });
  } catch (err) {
    const ok = await injectAnnotatorScripts(tab.id);
    if (ok) {
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_ANNOTATOR' }).catch(() => {});
      }, 50);
    }
  }
});

// Auto-restore multi-page session on tab navigation
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab || !tab.url) return;
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) return;

  try {
    const stored = await chrome.storage.local.get(['ai_web_annotator_session']);
    const session = stored.ai_web_annotator_session;

    if (session && session.activeTabId === tabId && session.isActive) {
      const ok = await injectAnnotatorScripts(tabId);
      if (ok) {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, {
            action: 'RESTORE_SESSION',
            session: session
          }).catch(() => {});
        }, 100);
      }
    }
  } catch (_) {}
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
    return true;
  }

  if (message.action === 'COPY_TO_CLIPBOARD') {
    (async () => {
      try {
        await setupOffscreenDocument('offscreen/offscreen.html');
        const res = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: message.type === 'image' ? 'OFFSCREEN_COPY_IMAGE' : 'OFFSCREEN_COPY_TEXT',
          dataUrl: message.dataUrl,
          text: message.text
        });
        sendResponse(res || { success: true });
      } catch (err) {
        console.error('[AI Web Annotator] Offscreen clipboard error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
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
