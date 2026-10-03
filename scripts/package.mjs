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

// Generate Chrome Omaha updates.xml
const updatesXmlContent = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='aiwebannotatorextension'>
    <updatecheck codebase='https://git.delikesance.cloud/delikesance/annotation-extension/releases/download/v${version}/${zipFileName}' version='${version}' />
  </app>
</gupdate>
`;

const rootUpdatesXmlPath = path.join(rootDir, 'updates.xml');
fs.writeFileSync(rootUpdatesXmlPath, updatesXmlContent, 'utf8');
console.log(`[package] Successfully updated: ${rootUpdatesXmlPath}`);

const distUpdatesXmlPath = path.join(distDir, 'updates.xml');
fs.writeFileSync(distUpdatesXmlPath, updatesXmlContent, 'utf8');

// Generate version.json metadata
const versionJson = {
  name: pkg.name || 'ai-web-annotator',
  version: version,
  tagName: `v${version}`,
  downloadUrl: `https://git.delikesance.cloud/delikesance/annotation-extension/releases/download/v${version}/${zipFileName}`,
  releaseUrl: `https://git.delikesance.cloud/delikesance/annotation-extension/releases/tag/v${version}`,
  updatedAt: new Date().toISOString()
};

const versionJsonPath = path.join(distDir, 'version.json');
fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2), 'utf8');
console.log(`[package] Successfully generated: ${versionJsonPath}`);

