/**
 * Dev install helper: writes a Zotero "proxy file" pointing at build/addon so
 * code changes only need a rebuild + Zotero restart (no repacking).
 *
 * Usage: node scripts/dev-install.mjs /path/to/Zotero/Profiles/xxxx.default
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = join(root, 'build', 'addon');
const PLUGIN_ID = 'zotero-bilingual-reader@local';

const profileDir = process.argv[2];
if (!profileDir) {
	console.error('Usage: node scripts/dev-install.mjs <zotero-profile-directory>');
	console.error('Find yours via Zotero: Help → Debug Output Logging → shows profile path,');
	console.error('or look in ~/Zotero (data dir) vs profile dir (contains prefs.js, extensions/).');
	process.exit(1);
}

const extensionsDir = join(profileDir, 'extensions');
mkdirSync(extensionsDir, { recursive: true });
writeFileSync(join(extensionsDir, PLUGIN_ID), addonDir + '\n');
console.log(`Wrote proxy file ${join(extensionsDir, PLUGIN_ID)} -> ${addonDir}`);
console.log('Now (1) run `npm run build`, (2) start Zotero with -purgecaches.');
console.log('If Zotero previously had the XPI version installed, remove it first.');
