/**
 * Offscreen Document Script
 * Dedicated to handling clipboard write operations reliably in Manifest V3.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.action === 'OFFSCREEN_COPY_IMAGE') {
    handleCopyImage(message.dataUrl)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] Copy image failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // async response
  }

  if (message.action === 'OFFSCREEN_COPY_TEXT') {
    handleCopyText(message.text)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] Copy text failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // async response
  }
});

async function handleCopyImage(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const pngBlob = blob.type === 'image/png' ? blob : new Blob([await blob.arrayBuffer()], { type: 'image/png' });

  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': pngBlob })
  ]);
}

async function handleCopyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
