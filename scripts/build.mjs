import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

function copyFolderSync(from, to) {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }
  const entries = fs.readdirSync(from, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyFolderSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function build() {
  console.log('[build] Building Chrome Extension to dist/...');
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  copyFolderSync(srcDir, distDir);

  // Validate manifest.json exists
  const manifestPath = path.join(distDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json is missing in src/');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`[build] Extension built successfully: ${manifest.name} v${manifest.version}`);
}

const isWatch = process.argv.includes('--watch');

build();

if (isWatch) {
  console.log('[watch] Watching src/ for changes...');
  let timeoutId = null;
  fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
    if (filename) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        console.log(`[watch] Change detected in ${filename}, rebuilding...`);
        try {
          build();
        } catch (err) {
          console.error('[watch] Build error:', err);
        }
      }, 100);
    }
  });
}
