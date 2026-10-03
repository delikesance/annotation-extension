import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewerVersion, checkForUpdates } from '../src/background/service-worker.js';

test('isNewerVersion - accurately detects newer versions', () => {
  assert.equal(isNewerVersion('1.2.0', '1.1.0'), true);
  assert.equal(isNewerVersion('v1.2.0', '1.1.0'), true);
  assert.equal(isNewerVersion('v2.0.0', 'v1.9.9'), true);
  assert.equal(isNewerVersion('1.1.1', '1.1.0'), true);
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);

  // Same or older versions
  assert.equal(isNewerVersion('1.1.0', '1.1.0'), false);
  assert.equal(isNewerVersion('v1.1.0', '1.1.0'), false);
  assert.equal(isNewerVersion('1.0.9', '1.1.0'), false);
  assert.equal(isNewerVersion('0.9.0', '1.0.0'), false);

  // Edge cases
  assert.equal(isNewerVersion('', '1.1.0'), false);
  assert.equal(isNewerVersion(null, '1.1.0'), false);
  assert.equal(isNewerVersion('invalid', '1.1.0'), false);
});

test('checkForUpdates - fetches Forgejo release API and detects available update', async () => {
  const originalFetch = global.fetch;
  const originalChrome = global.chrome;

  let storedData = {};
  global.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.1.0' })
    },
    storage: {
      local: {
        set: async (obj) => { Object.assign(storedData, obj); },
        remove: async (keys) => { keys.forEach(k => delete storedData[k]); },
        get: async (keys) => storedData
      }
    }
  };

  // Mock newer release on Forgejo
  global.fetch = async (url) => {
    assert.ok(url.includes('/releases/latest'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v1.2.0',
        name: 'AI Web Annotator v1.2.0',
        body: 'Release notes for 1.2.0',
        html_url: 'https://git.delikesance.cloud/releases/v1.2.0',
        assets: [
          {
            name: 'ai-web-annotator-v1.2.0.zip',
            browser_download_url: 'https://git.delikesance.cloud/releases/download/v1.2.0/ai-web-annotator-v1.2.0.zip'
          }
        ]
      })
    };
  };

  try {
    const update = await checkForUpdates();
    assert.ok(update, 'Update should be found');
    assert.equal(update.version, '1.2.0');
    assert.equal(update.downloadUrl, 'https://git.delikesance.cloud/releases/download/v1.2.0/ai-web-annotator-v1.2.0.zip');
    assert.equal(storedData.available_update.version, '1.2.0');

    // Test when current version is already up to date
    global.chrome.runtime.getManifest = () => ({ version: '1.2.0' });
    const noUpdate = await checkForUpdates();
    assert.equal(noUpdate, null, 'Should return null when already up to date');
    assert.equal(storedData.available_update, undefined, 'Storage should be cleared');
  } finally {
    global.fetch = originalFetch;
    global.chrome = originalChrome;
  }
});

test('manifest grants host permission for the update server (service-worker fetch is CORS-blocked otherwise)', async () => {
  const fs = await import('node:fs');
  const manifest = JSON.parse(fs.readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));
  assert.ok(
    (manifest.host_permissions || []).some(p => p.startsWith('https://git.delikesance.cloud/')),
    'host_permissions must include the Forgejo host'
  );
});
