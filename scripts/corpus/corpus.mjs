#!/usr/bin/env node
// Bundle corpus.ts with esbuild (same toolchain as the plugin build) and run it.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, '.build'), { recursive: true });
const outfile = join(here, '.build', 'corpus.mjs');
await build({
	entryPoints: [join(here, 'corpus.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	logLevel: 'error',
	// Resolved at run time from the repo's node_modules (the bundle sits inside the repo).
	external: ['pdfjs-dist', 'pdfjs-dist/*']
});
process.chdir(join(here, '..', '..'));
await import(pathToFileURL(outfile).href);
