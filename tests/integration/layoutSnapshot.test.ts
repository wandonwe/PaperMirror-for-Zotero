/**
 * 布局快照回归 (1.1.2, 无 BabelDOC 的回归测试集方案):
 *
 * 对 tests/fixtures/layout/*.spans.json(scripts/dump-spans.mjs 从真实 PDF
 * 转储)跑与阅读器文本层路径同构的纯函数流水线
 * (buildBlocksFromSpans → order → structureTableCells → coalesce → order),
 * 把每块的 (type, column, readingIndex, tableRow/Col, 文本前 40 字) 摘要与
 * 同名 .snapshot.json 对比。快照缺失时自动生成并通过(首跑);之后任何
 * 分段/阅读序/表格结构变化都在这里现形——有意的改动删旧快照重新生成,
 * diff 进 PR 审阅。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { orderBlocksForReading } from '../../src/reader/readingOrder';
import { structureTableCells } from '../../src/reader/tableStructure';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
import { validatePageIR } from '../../src/ir/documentIR';
import type { SourceBlock } from '../../src/types/models';

// 兼容两种执行方式: tsx 直跑(文件在 tests/integration/)与 scripts/test.mjs
// 的 esbuild 打包(产物在 build/tests/)。从 cwd(仓库根)定位语料目录。
const layoutDir = join(process.cwd(), 'tests', 'fixtures', 'layout');

interface SpanDump {
	source: string;
	page: number;
	pageWidth: number;
	pageHeight: number;
	items: SpanItem[];
}

function pipeline(dump: SpanDump): SourceBlock[] {
	const result = buildBlocksFromSpans(dump.items, {
		pageIndex: 0,
		pageWidth: dump.pageWidth,
		pageHeight: dump.pageHeight,
		includeReferences: false,
		referencesAlreadyStarted: false,
		imageRectsPdf: []
	});
	const structured = structureTableCells(orderBlocksForReading(result.blocks), 0, 10);
	const cells = structured.filter(b => b.translationMode !== undefined);
	const prose = coalesceRegions(structured.filter(b => b.translationMode === undefined), []);
	return orderBlocksForReading([...prose, ...cells]);
}

function summarize(blocks: SourceBlock[]): unknown[] {
	return blocks.map(b => ({
		type: b.type,
		column: b.column ?? null,
		readingIndex: b.readingIndex,
		...(typeof b.tableRow === 'number' ? { tableRow: b.tableRow, tableCol: b.tableCol } : {}),
		...(b.translationMode ? { mode: b.translationMode } : {}),
		text: b.sourceText.replace(/\s+/g, ' ').slice(0, 40)
	}));
}

const dumps = existsSync(layoutDir)
	? readdirSync(layoutDir).filter(f => f.endsWith('.spans.json'))
	: [];

test(`layout snapshots (${dumps.length} fixture(s))`, () => {
	assert.ok(dumps.length >= 1, 'at least the bundled sample fixture must exist');
	for (const file of dumps) {
		const dump = JSON.parse(readFileSync(join(layoutDir, file), 'utf8')) as SpanDump;
		const blocks = pipeline(dump);
		// 每个语料页同时也是 IR 契约的回归载体。
		assert.deepEqual(validatePageIR({ pageIndex: 0, blocks }), [], `${file}: IR violations`);
		const summary = summarize(blocks);
		const snapshotFile = join(layoutDir, file.replace(/\.spans\.json$/, '.snapshot.json'));
		if (!existsSync(snapshotFile)) {
			// 假绿灯修复 (1.2.2, 审核项): 缺基线曾被"当场生成并通过"掩盖 —— 测试
			// 报绿却没有任何被审阅过的基线。现在缺失即失败;只有显式
			// UPDATE_SNAPSHOTS=1 才允许生成,生成后必须人工审阅并提交。
			if (process.env.UPDATE_SNAPSHOTS) {
				writeFileSync(snapshotFile, JSON.stringify(summary, null, '\t') + '\n');
				console.log(`snapshot created: ${snapshotFile} (${summary.length} block(s)) — review and commit it`);
				continue;
			}
			assert.fail(`${file}: missing baseline snapshot — run UPDATE_SNAPSHOTS=1 npm test to create it, review it, and commit it`);
		}
		const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'));
		assert.deepEqual(summary, expected,
			`${file}: layout changed vs snapshot — if intentional, delete ${snapshotFile} and re-run with UPDATE_SNAPSHOTS=1, review the diff, and commit it`);
	}
});
