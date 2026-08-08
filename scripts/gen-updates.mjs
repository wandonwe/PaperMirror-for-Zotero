#!/usr/bin/env node
/**
 * Generate updates.json for Zotero's auto-update.
 *
 * From v0.5.2 the manifest's update_url points at the "latest release" asset
 * (releases/latest/download/updates.json), so this file is uploaded as a
 * RELEASE ASSET on every tag build — never committed to main. That removes the
 * whole class of failures we hit before: CI pushes to main being rejected by
 * branch protection, concurrent tag builds racing on main, and the file simply
 * getting stuck at an old version. Each release's updates.json points at that
 * same release's XPI, and GitHub's latest-download alias always serves the
 * newest one.
 *
 * No update_hash: the XPI is fetched over HTTPS from the project's own release,
 * and a hash that must match a specific build byte-for-byte only ever caused
 * mismatches between locally-built and CI-built XPIs.
 *
 * Usage: node scripts/gen-updates.mjs [version]
 *   version — the release version (with or without a leading "v"). Falls back
 *   to package.json for local runs; CI passes the tag so it never depends on
 *   whichever commit happens to be checked out.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const REPO = 'wandonwe/PaperMirror-for-Zotero';
const ADDON_ID = manifest.applications.zotero.id;
const versionArg = process.argv[2] && /^v?\d/.test(process.argv[2])
	? process.argv[2].replace(/^v/, '')
	: null;
const version = versionArg ?? pkg.version;

const doc = {
	addons: {
		[ADDON_ID]: {
			updates: [
				{
					version,
					update_link: `https://github.com/${REPO}/releases/download/v${version}/zotero-bilingual-reader-${version}.xpi`,
					applications: {
						zotero: {
							strict_min_version: manifest.applications.zotero.strict_min_version,
							strict_max_version: manifest.applications.zotero.strict_max_version
						}
					}
				}
			]
		}
	}
};
writeFileSync(join(root, 'updates.json'), JSON.stringify(doc, null, '\t') + '\n');
console.log(`updates.json → v${version}`);
