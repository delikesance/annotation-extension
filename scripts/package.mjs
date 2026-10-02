import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const pkgPath = path.join(rootDir, 'package.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version || '1.0.0';
const zipFileName = `ai-web-annotator-v${version}.zip`;
const zipFilePath = path.join(distDir, zipFileName);

console.log(`[package] Packaging extension into ${zipFileName}...`);

if (!fs.existsSync(distDir)) {
  throw new Error('dist/ directory not found. Please run npm run build first.');
}

const zip = new AdmZip();

const entries = fs.readdirSync(distDir);
for (const entry of entries) {
  if (entry.endsWith('.zip')) continue;
  const fullPath = path.join(distDir, entry);
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    zip.addLocalFolder(fullPath, entry);
  } else {
    zip.addLocalFile(fullPath);
  }
}

zip.writeZip(zipFilePath);
console.log(`[package] Successfully generated: ${zipFilePath}`);
