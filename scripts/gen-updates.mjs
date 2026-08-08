#!/usr/bin/env node
/**
 * Regenerate updates.json for Zotero's auto-update.
 *
 * Zotero polls the manifest's update_url (the raw updates.json on the main
 * branch); when the listed version is newer than the installed one it downloads
 * update_link and installs it. So a release is "live" the moment this file on
 * main points at the new release asset — which is exactly what the release
 * workflow commits back after publishing the XPI.
 *
 * Usage: node scripts/gen-updates.mjs [path-to-xpi]
 *   With an XPI path, an sha256 update_hash is included (recommended: Zotero
 *   verifies the download). Without it, the entry is still valid, just unhashed.
 */
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const REPO = 'wandonwe/papermirror-zotero';
const ADDON_ID = manifest.applications.zotero.id;
const version = pkg.version;
const zoteroApp = {
	strict_min_version: manifest.applications.zotero.strict_min_version,
	strict_max_version: manifest.applications.zotero.strict_max_version
};

async function sha256(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(path)
			.on('data', chunk => hash.update(chunk))
			.on('end', () => resolve(hash.digest('hex')))
			.on('error', reject);
	});
}

const xpiPath = process.argv[2];
const update = {
	version,
	update_link: `https://github.com/${REPO}/releases/download/v${version}/zotero-bilingual-reader-${version}.xpi`,
	applications: { zotero: zoteroApp }
};
if (xpiPath) {
	update.update_hash = `sha256:${await sha256(xpiPath)}`;
}

const doc = { addons: { [ADDON_ID]: { updates: [update] } } };
writeFileSync(join(root, 'updates.json'), JSON.stringify(doc, null, '\t') + '\n');
console.log(`updates.json → v${version}${xpiPath ? ' (hashed)' : ''}`);
