/**
 * Package: zip build/addon into dist/zotero-bilingual-reader-<version>.xpi
 * (an XPI is a plain zip with manifest.json at the root).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAddon } from './build.mjs';
import { verifyXpi } from './verify-xpi.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = join(root, 'build', 'addon');
const distDir = join(root, 'dist');

async function main() {
	// Always rebuild so the XPI can never contain a stale bundle.
	await buildAddon();
	if (!existsSync(join(addonDir, 'manifest.json'))) {
		throw new Error('Build did not produce build/addon/manifest.json');
	}
	const manifest = JSON.parse(readFileSync(join(addonDir, 'manifest.json'), 'utf8'));
	const xpiName = `zotero-bilingual-reader-${manifest.version}.xpi`;
	mkdirSync(distDir, { recursive: true });
	const xpiPath = join(distDir, xpiName);
	rmSync(xpiPath, { force: true });
	// -X strips extra file attributes; store from inside addonDir so
	// manifest.json sits at the zip root.
	execFileSync('zip', ['-r', '-X', xpiPath, '.'], { cwd: addonDir, stdio: 'inherit' });
	verifyXpi(xpiPath);
	console.log(`\nXPI written to ${xpiPath}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
