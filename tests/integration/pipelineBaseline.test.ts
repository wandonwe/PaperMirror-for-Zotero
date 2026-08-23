/**
 * 流水线性能基线 (2.3.6, 优化计划 第五批): 对 tests/fixtures/layout/*.spans.json
 * (真实 PDF 页语料)跑与运行时同构的确定性流水线
 * (buildBlocksFromSpans → order → structureTableCells → coalesce → order →
 *  buildLayoutModules → planChunks),把**请求计划形状**锁进基线:
 *   blocks / translatable / tableCells / regions / modules /
 *   chunks / fastChunks / slowChunks / maxBlocksPerChunk /
 *   payloadChars(请求输入体量代理) / dupBlocks(API-2 同页去重省下的块)
 *
 * 这正是第一~四批各项 API 优化作用的对象 —— 任何让某页 chunk 数/payload 回涨的
 * 改动都会在这里现形。基线缺失时自动生成并通过(首跑);有意的改动删
 * tests/fixtures/baseline/pipeline-baseline.json 重新生成,diff 进 PR 审阅。
 * 只锁**确定性计数**;耗时是环境相关的,由 `npm run bench` 报告、不在 CI 断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { orderBlocksForReading } from '../../src/reader/readingOrder';
import { structureTableCells } from '../../src/reader/tableStructure';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
import { buildLayoutModules } from '../../src/reader/layoutModules';
import { planChunks } from '../../src/translation/segmenter';
import { isFormulaDenseRisk } from '../../src/reader/formulaGuard';
import { isMetadataBlock } from '../../src/reader/metaFilter';
import type { SourceBlock } from '../../src/types/models';

const layoutDir = join(process.cwd(), 'tests', 'fixtures', 'layout');
const baselineDir = join(process.cwd(), 'tests', 'fixtures', 'baseline');
const baselinePath = join(baselineDir, 'pipeline-baseline.json');

interface SpanDump {
	source: string;
	page: number;
	pageWidth: number;
	pageHeight: number;
	items: SpanItem[];
}

export interface PageBaseline {
	blocks: number;
	translatable: number;
	tableCells: number;
	modules: number;
	chunks: number;
	fastChunks: number;
	slowChunks: number;
	maxBlocksPerChunk: number;
	payloadChars: number;
	dupBlocks: number;
}

/** 与阅读器同构的确定性流水线 + 请求计划 —— 纯函数,无 Date/random。 */
export function measurePage(dump: SpanDump): PageBaseline {
	// 与 layoutSnapshot 的同构流水线完全一致的调用序。
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
	const blocks: SourceBlock[] = orderBlocksForReading([...prose, ...cells]);

	const tableCells = blocks.filter(b => typeof b.tableRow === 'number').length;
	// 与 startTranslating 的可译准入近似: 非 preserve、非元数据、有文本。
	const translatable = blocks.filter(b =>
		b.translationMode !== 'preserve'
		&& !!b.sourceText.trim()
		&& !isMetadataBlock(b.sourceText)
		&& (b.type === 'paragraph' || b.type === 'list' || b.type === 'caption'
			|| b.type === 'heading' || b.type === 'title'));

	// API-2 同页去重: 相同 sourceText 只送代表块。
	const seen = new Set<string>();
	const unique: SourceBlock[] = [];
	for (const b of translatable) {
		if (!seen.has(b.sourceText)) {
			seen.add(b.sourceText);
			unique.push(b);
		}
	}
	const modules = buildLayoutModules(unique);
	const riskOf = (b: SourceBlock): boolean =>
		b.type === 'table' || b.sourceText.length > 2400 || isFormulaDenseRisk(b.sourceText, 0);
	const chunks = planChunks(unique, modules, { riskOf });
	return {
		blocks: blocks.length,
		translatable: translatable.length,
		tableCells,
		modules: modules.length,
		chunks: chunks.length,
		fastChunks: chunks.filter(c => c.lane === 'fast').length,
		slowChunks: chunks.filter(c => c.lane === 'slow').length,
		maxBlocksPerChunk: chunks.reduce((m, c) => Math.max(m, c.blocks.length), 0),
		payloadChars: chunks.reduce((n, c) => n + c.blocks.reduce((m, b) => m + b.sourceText.length, 0), 0),
		dupBlocks: translatable.length - unique.length
	};
}

test('流水线请求计划基线: 语料页的 chunk 形状与基线一致 (第五批)', () => {
	const dumps = readdirSync(layoutDir).filter(f => f.endsWith('.spans.json')).sort();
	assert.ok(dumps.length >= 8, `语料太少 (${dumps.length}),基线失去代表性`);
	const current: Record<string, PageBaseline> = {};
	for (const file of dumps) {
		const dump = JSON.parse(readFileSync(join(layoutDir, file), 'utf8')) as SpanDump;
		current[file.replace(/\.spans\.json$/, '')] = measurePage(dump);
	}
	if (!existsSync(baselinePath)) {
		mkdirSync(baselineDir, { recursive: true });
		writeFileSync(baselinePath, JSON.stringify(current, null, '\t') + '\n');
		console.log(`pipeline baseline generated: ${Object.keys(current).length} corpus pages → ${baselinePath}`);
		return; // 首跑: 生成即通过
	}
	const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, PageBaseline>;
	for (const [name, cur] of Object.entries(current)) {
		const base = baseline[name];
		if (!base) {
			// 新语料页: 提示补基线(删基线文件重生成),不失败——加语料不该红 CI。
			console.log(`new corpus page without baseline: ${name} (delete the baseline file to regenerate)`);
			continue;
		}
		assert.deepEqual(cur, base,
			`${name}: 请求计划形状偏离基线 —— 若为有意优化,删除 ${baselinePath} 重新生成并把 diff 进 PR`);
	}
});
