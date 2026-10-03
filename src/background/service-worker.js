/**
 * Service Worker (Background script - Manifest V3)
 * Handles extension activation, multi-page session persistence across navigations,
 * screenshot capture via Chrome API, zero-friction clipboard proxy via Offscreen API,
 * and file downloads.
 */

import { uploadPng, setExpiration, checkAccess, dataUrlToBytes } from './s3.js';

const HOSTING_KEY = 'image_hosting';
// Bundled, zero-config hosting: our own gateway (see server/gateway.mjs). No secret ships in the extension:
// the server validates, rate-limits and expires everything. `gateway_url` in storage overrides it (dev/tests).
export const DEFAULT_GATEWAY_URL = 'https://annotator.delikesance.cloud';
const GATEWAY_ENABLED_KEY = 'gateway_enabled';
const GATEWAY_URL_KEY = 'gateway_url';
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

const SIDE_PANEL_PATH = 'sidepanel/sidepanel.html';

export function normalizeHostingConfig(c) {
  if (!c) return null;
  const endpoint = String(c.endpoint || '').trim().replace(/\/+$/, '');
  const publicBaseUrl = String(c.publicBaseUrl || '').trim().replace(/\/+$/, '');
  const cfg = {
    endpoint,
    bucket: String(c.bucket || '').trim(),
    accessKeyId: String(c.accessKeyId || '').trim(),
    secretAccessKey: String(c.secretAccessKey || '').trim(),
    publicBaseUrl,
    region: String(c.region || 'us-east-1').trim() || 'us-east-1',
    prefix: 'annotations',
    expireDays: Math.max(1, Math.min(365, parseInt(c.expireDays, 10) || 7))
  };
  if (!/^https?:\/\//.test(endpoint) || !/^https?:\/\//.test(publicBaseUrl)) return null;
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) return null;
  return cfg;
}

async function getGateway() {
  try {
    const stored = await chrome.storage.local.get([GATEWAY_ENABLED_KEY, GATEWAY_URL_KEY]);
    if (stored && stored[GATEWAY_ENABLED_KEY] === false) return null;
    const url = String((stored && stored[GATEWAY_URL_KEY]) || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
    return /^https?:\/\//.test(url) ? url : null;
  } catch (_) {
    return DEFAULT_GATEWAY_URL;
  }
}

async function uploadToGateway(base, page) {
  const bytes = dataUrlToBytes(page.dataUrl);
  let res;
  try {
    res = await fetch(`${base}/v1/upload?name=ecran-${page.stepIndex}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
  } catch (_) {
    throw new Error(`serveur d'images injoignable (${new URL(base).host})`);
  }
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok || !body || !body.url) throw new Error((body && body.error) || `Serveur d'images indisponible (HTTP ${res.status})`);
  return body;
}

async function getHostingConfig() {
  try {
    const stored = await chrome.storage.local.get([HOSTING_KEY]);
    return normalizeHostingConfig(stored && stored[HOSTING_KEY]);
  } catch (_) {
    return null;
  }
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
if (typeof chrome !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;

    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
      console.warn('[AI Web Annotator] Cannot run on restricted browser pages.');
      return;
    }

    // Open Chrome's side panel (the review rail) synchronously so the click's user gesture is kept.
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.setOptions({ tabId: tab.id, path: SIDE_PANEL_PATH, enabled: true }).catch(() => {});
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
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
}

// Multi-page session auto-restore on tab navigation
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
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
}

// Auto-Update Checker Configuration
const FORGEJO_REPO_API = 'https://git.delikesance.cloud/api/v1/repos/delikesance/annotation-extension';
const UPDATE_CHECK_INTERVAL_MINUTES = 720; // 12 hours

export function isNewerVersion(remoteVer, currentVer) {
  if (!remoteVer || !currentVer) return false;
  const cleanRemote = String(remoteVer).replace(/^v/, '').trim();
  const cleanCurrent = String(currentVer).replace(/^v/, '').trim();

  const rParts = cleanRemote.split('.').map(n => parseInt(n, 10) || 0);
  const cParts = cleanCurrent.split('.').map(n => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(rParts.length, cParts.length); i++) {
    const r = rParts[i] || 0;
    const c = cParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

export async function checkForUpdates() {
  try {
    const currentVersion = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest().version
      : '1.0.0';

    const response = await fetch(`${FORGEJO_REPO_API}/releases/latest`, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });

    if (!response.ok) {
      console.warn(`[AI Web Annotator] Update check failed: HTTP ${response.status}`);
      return null;
    }

    const release = await response.json();
    if (!release || !release.tag_name) return null;

    const latestVersion = release.tag_name.replace(/^v/, '');
    const updateAvailable = isNewerVersion(latestVersion, currentVersion);

    if (updateAvailable) {
      let downloadUrl = release.html_url || `https://git.delikesance.cloud/delikesance/annotation-extension/releases/tag/${release.tag_name}`;
      if (Array.isArray(release.assets) && release.assets.length > 0) {
        const zipAsset = release.assets.find(a => a.name && a.name.endsWith('.zip'));
        if (zipAsset && zipAsset.browser_download_url) {
          downloadUrl = zipAsset.browser_download_url;
        }
      }

      const updateInfo = {
        version: latestVersion,
        tagName: release.tag_name,
        name: release.name || `Version ${latestVersion}`,
        releaseNotes: release.body || '',
        downloadUrl: downloadUrl,
        releaseUrl: release.html_url || `https://git.delikesance.cloud/delikesance/annotation-extension/releases/tag/${release.tag_name}`,
        checkedAt: Date.now()
      };

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ available_update: updateInfo });
      }
      console.log(`[AI Web Annotator] ✨ Update available: v${latestVersion} (Current: v${currentVersion})`);
      return updateInfo;
    } else {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.remove(['available_update']);
      }
      return null;
    }
  } catch (err) {
    console.warn('[AI Web Annotator] Error during update check:', err);
    return null;
  }
}

// Alarms & Periodic checking
if (typeof chrome !== 'undefined' && chrome.alarms) {
  try {
    chrome.alarms.create('check-updates', { periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'check-updates') {
        checkForUpdates();
      }
    });
  } catch (_) {}
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
  if (chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      checkForUpdates();
    });
  }
  if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      checkForUpdates();
    });
  }
}

// Handle messages from content script
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
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

  if (message.action === 'CHECK_UPDATES' || message.action === 'GET_UPDATE_INFO') {
    (async () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const stored = await chrome.storage.local.get(['available_update']);
          if (stored && stored.available_update && (Date.now() - (stored.available_update.checkedAt || 0) < 60000)) {
            sendResponse({ success: true, update: stored.available_update });
            return;
          }
        }
        const updateInfo = await checkForUpdates();
        sendResponse({ success: true, update: updateInfo });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'HOSTING_STATUS') {
    (async () => {
      const cfg = await getHostingConfig();
      if (cfg) return sendResponse({ configured: true, mode: 's3', expireDays: cfg.expireDays });
      const gateway = await getGateway();
      if (gateway) return sendResponse({ configured: true, mode: 'gateway', expireDays: 7, host: new URL(gateway).host });
      sendResponse({ configured: false, mode: 'off', expireDays: null });
    })();
    return true;
  }

  if (message.action === 'HOSTING_TOGGLE') {
    chrome.storage.local.set({ [GATEWAY_ENABLED_KEY]: Boolean(message.enabled) }).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'HOSTING_SETUP') {
    (async () => {
      const cfg = normalizeHostingConfig(message.config);
      if (!cfg) return sendResponse({ success: false, error: 'Configuration incomplète.' });
      try {
        await checkAccess(cfg);
        let expirationWarning = null;
        try {
          await setExpiration(cfg, cfg.expireDays);
        } catch (error) {
          // some servers do not implement lifecycle rules: keep going, the expiry must then be set server-side
          expirationWarning = error.message;
        }
        await chrome.storage.local.set({ [HOSTING_KEY]: cfg });
        sendResponse({ success: true, expirationWarning });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.action === 'HOSTING_CLEAR') {
    chrome.storage.local.remove([HOSTING_KEY]).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'HOSTING_UPLOAD') {
    (async () => {
      try {
        const cfg = await getHostingConfig();
        const urls = {};
        if (cfg) {
          for (const page of message.pages || []) urls[page.stepIndex] = await uploadPng(cfg, page.dataUrl, `ecran-${page.stepIndex}`);
          return sendResponse({ success: true, urls, expireDays: cfg.expireDays });
        }
        const gateway = await getGateway();
        if (!gateway) return sendResponse({ success: false, error: 'Hébergement désactivé.' });
        let ttl = 7;
        for (const page of message.pages || []) {
          const out = await uploadToGateway(gateway, page);
          urls[page.stepIndex] = out.url;
          ttl = out.ttlDays || ttl;
        }
        sendResponse({ success: true, urls, expireDays: ttl });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.action === 'OPEN_SIDE_PANEL') {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId && chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.setOptions({ tabId, path: SIDE_PANEL_PATH, enabled: true }).catch(() => {});
      chrome.sidePanel.open({ tabId })
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }
    sendResponse({ success: false });
    return false;
  }

  if (message.action === 'SESSION_SYNC') {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId && message.session) {
      chrome.storage.local.set({ ai_web_annotator_session: { ...message.session, activeTabId: tabId } })
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }
    sendResponse({ success: false });
    return false;
  }

  if (message.action === 'ANNOTATOR_STOPPED') {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (tabId && chrome.sidePanel && chrome.sidePanel.setOptions) {
      chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    }
    chrome.storage.local.remove(['ai_web_annotator_session']).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'OPEN_URL' && message.url) {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: message.url });
    }
    sendResponse({ success: true });
    return false;
  }
  });
}

