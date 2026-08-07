/**
 * Test runner: bundle each tests/unit/*.test.ts with esbuild, then execute
 * with the Node built-in test runner.
 */

import { build } from 'esbuild';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDirs = [join(root, 'tests', 'unit'), join(root, 'tests', 'integration')];
const outDir = join(root, 'build', 'tests');

async function main() {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const entries = testDirs.flatMap(dir =>
		readdirSync(dir)
			.filter(f => f.endsWith('.test.ts'))
			.map(f => join(dir, f))
	);
	if (!entries.length) {
		console.error('No test files found.');
		process.exit(1);
	}
	await build({
		entryPoints: entries,
		outdir: outDir,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node20',
		loader: { '.css': 'text' },
		outExtension: { '.js': '.mjs' },
		external: ['node:*']
	});
	const result = spawnSync(process.execPath, ['--test', join(outDir, '**', '*.test.mjs')], { stdio: 'inherit', shell: false });
	process.exit(result.status ?? 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
