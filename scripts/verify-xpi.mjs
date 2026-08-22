/** Release-package gate: fail on missing legal files, hidden macOS debris,
 * generated timestamps, a filename/manifest version mismatch, or ANY file that
 * is not on the explicit allow-list (defence against a stray source map, .ts,
 * .env, key file, or node_modules artefact slipping into a shipped XPI).
 *
 * The pure predicates live in ./xpi-checks.mjs so tests can exercise them
 * without triggering this file's CLI entry point. */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	disallowedEntries,
	forbiddenEntries,
	missingRequired,
	semverCompare,
	versionFromName
} from './xpi-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verifyXpi(xpiPath) {
	if (!existsSync(xpiPath)) throw new Error(`XPI not found: ${xpiPath}`);
	const entries = execFileSync('unzip', ['-Z1', xpiPath], { encoding: 'utf8' })
		.split(/\r?\n/).filter(Boolean);
	const missing = missingRequired(entries);
	if (missing.length) throw new Error(`XPI is missing ${missing.join(', ')}`);
	const forbidden = forbiddenEntries(entries);
	if (forbidden.length) throw new Error(`XPI contains forbidden generated files: ${forbidden.join(', ')}`);

	// Allow-list gate: every non-directory entry must be explicitly permitted.
	const unexpected = disallowedEntries(entries);
	if (unexpected.length) {
		throw new Error(
			`XPI contains files not on the allow-list (possible leak — refusing to ship): ${unexpected.join(', ')}\n`
			+ 'If one of these is a legitimate new asset, add it to ALLOWED in scripts/xpi-checks.mjs.');
	}

	const manifest = JSON.parse(execFileSync('unzip', ['-p', xpiPath, 'manifest.json'], { encoding: 'utf8' }));
	const expected = `zotero-bilingual-reader-${manifest.version}.xpi`;
	if (basename(xpiPath) !== expected) {
		throw new Error(`XPI filename ${basename(xpiPath)} does not match manifest version ${manifest.version}`);
	}
	console.log(`XPI verified: ${entries.length} entries, version ${manifest.version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dist = join(root, 'dist');
	const candidates = existsSync(dist)
		? readdirSync(dist).filter(name => name.endsWith('.xpi')).map(name => join(dist, name))
		: [];
	let target = process.argv[2] ? resolve(process.argv[2]) : undefined;
	if (!target && candidates.length) {
		// Default pick: the XPI matching this repo's package.json version if it
		// exists (that is what a fresh `npm run package` just built); otherwise
		// the highest SEMVER version — NOT `.sort().at(-1)`, whose lexicographic
		// order ranks "2.0.9" above "2.0.10" and would verify a stale build.
		let repoVersion = '';
		try {
			repoVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '';
		}
		catch { /* fall back to semver-max below */ }
		const match = repoVersion && candidates.find(c => versionFromName(c) === repoVersion);
		target = match
			|| candidates.slice().sort((a, b) => semverCompare(versionFromName(a), versionFromName(b))).at(-1);
	}
	if (!target) throw new Error('No XPI found. Run npm run package first or pass an XPI path.');
	verifyXpi(target);
}
