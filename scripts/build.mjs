/**
 * Build: bundle TypeScript sources with esbuild and assemble build/addon/
 * (the XPI layout). Node is build-time only; the produced bundle has no
 * Node/runtime dependencies.
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const addonDir = join(root, 'build', 'addon');

const distributable = (source) => !source.split(/[\\/]/).some(part =>
	part === '.DS_Store' || part.startsWith('._'));

export async function buildAddon() {
	rmSync(join(root, 'build'), { recursive: true, force: true });
	mkdirSync(join(addonDir, 'content'), { recursive: true });

	// Main bundle (runs in the plugin bootstrap sandbox)
	await build({
		entryPoints: [join(root, 'src', 'index.ts')],
		outfile: join(addonDir, 'content', 'index.js'),
		bundle: true,
		format: 'iife',
		target: 'firefox115',
		platform: 'browser',
		loader: { '.css': 'text', '.svg': 'text' },
		logLevel: 'info',
		banner: {
			js: '/* PaperMirror for Zotero — generated bundle; sources in src/ (AGPL-3.0) */'
		}
	});

	// Preferences pane script (runs in the Zotero preferences window)
	await build({
		entryPoints: [join(root, 'src', 'preferences', 'preferences.ts')],
		outfile: join(addonDir, 'content', 'preferences.js'),
		bundle: true,
		format: 'iife',
		target: 'firefox115',
		platform: 'browser',
		logLevel: 'info'
	});

	// Static files
	copyFileSync(join(root, 'manifest.json'), join(addonDir, 'manifest.json'));
	copyFileSync(join(root, 'bootstrap.js'), join(addonDir, 'bootstrap.js'));
	copyFileSync(join(root, 'prefs.js'), join(addonDir, 'prefs.js'));
	copyFileSync(join(root, 'LICENSE'), join(addonDir, 'LICENSE'));
	copyFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), join(addonDir, 'THIRD-PARTY-NOTICES.md'));
	copyFileSync(join(root, 'src', 'preferences', 'preferences.xhtml'), join(addonDir, 'content', 'preferences.xhtml'));
	cpSync(join(root, 'locale'), join(addonDir, 'locale'), { recursive: true, filter: distributable });

	// Icons (generated if missing)
	const iconsDir = join(addonDir, 'content', 'icons');
	mkdirSync(iconsDir, { recursive: true });
	const srcIcons = join(root, 'assets', 'icons');
	// icon.svg is the vector source; the PNGs are renders the manifest needs.
	// Shipping the SVG too lets the preferences pane stay sharp on any display.
	for (const name of ['icon.svg', 'icon48.png', 'icon96.png', 'icon128.png']) {
		if (existsSync(join(srcIcons, name))) {
			copyFileSync(join(srcIcons, name), join(iconsDir, name));
		}
	}

	// Bundled CJK font for the in-plugin translated-PDF builder
	const fontsDir = join(addonDir, 'content', 'fonts');
	mkdirSync(fontsDir, { recursive: true });
	const srcFonts = join(root, 'assets', 'fonts');
	if (existsSync(srcFonts)) {
		cpSync(srcFonts, fontsDir, { recursive: true, filter: distributable });
	}
	console.log(`\nAddon assembled at ${addonDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	buildAddon().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
