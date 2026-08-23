/**
 * 离线性能基线报告 (2.3.6, 优化计划 第五批): `npm run bench`
 *
 * 对 tests/fixtures/layout/*.spans.json 语料跑与运行时同构的确定性流水线
 * (与 tests/integration/pipelineBaseline.test.ts 同一段代码),输出每页:
 *   - 流水线耗时 (提取块→阅读序→表格→合并→模块→请求计划,N 轮取中位数)
 *   - 请求计划形状 (chunks/fast/slow/payloadChars/去重)
 * 耗时是环境相关的**信息性**指标(不进 CI 断言);计数形状由集成测试锁定。
 */

import { build } from 'esbuild';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build', 'bench');

async function main() {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	await build({
		entryPoints: [join(root, 'tests', 'integration', 'pipelineBaseline.test.ts')],
		outdir: outDir,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node20',
		outExtension: { '.js': '.mjs' },
		external: ['node:*']
	});
	const mod = await import(pathToFileURL(join(outDir, 'pipelineBaseline.test.mjs')).href);
	const { measurePage } = mod;
	const layoutDir = join(root, 'tests', 'fixtures', 'layout');
	const dumps = readdirSync(layoutDir).filter(f => f.endsWith('.spans.json')).sort();
	const ROUNDS = 7;
	const rows = [];
	for (const file of dumps) {
		const dump = JSON.parse(readFileSync(join(layoutDir, file), 'utf8'));
		const times = [];
		let m = null;
		for (let i = 0; i < ROUNDS; i++) {
			const t0 = performance.now();
			m = measurePage(dump);
			times.push(performance.now() - t0);
		}
		times.sort((a, b) => a - b);
		rows.push({
			page: file.replace(/\.spans\.json$/, '').slice(0, 44),
			ms: times[Math.floor(ROUNDS / 2)].toFixed(1),
			blocks: m.blocks, chunks: m.chunks, slow: m.slowChunks,
			payload: m.payloadChars, dup: m.dupBlocks
		});
	}
	console.log('\n流水线离线基线 (中位数耗时/页, 提取块→请求计划):\n');
	console.table(rows);
	const total = rows.reduce((n, r) => n + Number(r.ms), 0);
	console.log(`合计 ${rows.length} 页语料, 流水线总耗时 ${total.toFixed(1)}ms (中位数和)。`);
	console.log('计数形状由 tests/integration/pipelineBaseline.test.ts 锁定进 CI;');
	console.log('真实世界指标 (API attempts/命中率/耗时) 用 scripts/baseline-report.mjs 汇总诊断 JSON。');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
