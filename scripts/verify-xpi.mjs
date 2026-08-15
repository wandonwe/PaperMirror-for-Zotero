/** Release-package gate: fail on missing legal files, hidden macOS debris,
 * generated timestamps, or a filename/manifest version mismatch. */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verifyXpi(xpiPath) {
	if (!existsSync(xpiPath)) throw new Error(`XPI not found: ${xpiPath}`);
	const entries = execFileSync('unzip', ['-Z1', xpiPath], { encoding: 'utf8' })
		.split(/\r?\n/).filter(Boolean);
	for (const required of ['manifest.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
		if (!entries.includes(required)) throw new Error(`XPI is missing ${required}`);
	}
	const forbidden = entries.filter(entry =>
		/(^|\/)\.DS_Store$/.test(entry) || /(^|\/)\._/.test(entry) || entry === '.built');
	if (forbidden.length) throw new Error(`XPI contains forbidden generated files: ${forbidden.join(', ')}`);

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
	const target = process.argv[2]
		? resolve(process.argv[2])
		: candidates.sort().at(-1);
	if (!target) throw new Error('No XPI found. Run npm run package first or pass an XPI path.');
	verifyXpi(target);
}
