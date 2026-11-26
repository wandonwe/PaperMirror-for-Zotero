import test from 'node:test';
import assert from 'node:assert/strict';
import { tableHeadersByBlock } from '../../src/translation/tableCellContext';
import { buildSystemPrompt, buildUserPayload } from '../../src/translation/promptBuilder';
import { policyStampFor } from '../../src/translation/promptPolicies';
import type { TranslationRequest } from '../../src/types/models';

// 5.1: table cells get their column / row headers. All fixtures are synthetic.

const cell = (row: number, col: number, text: string, extra: Record<string, unknown> = {}) =>
	({ id: `t-r${row}c${col}`, sourceText: text, tableId: 't1', tableRow: row, tableCol: col, ...extra });

test('5.1: a cell gets the header of its column and of its row (3023: scanner models)', () => {
	const blocks = [
		cell(0, 0, 'Parameter'), cell(0, 1, 'PCD-CT system'), cell(0, 2, 'EID-CT system'),
		cell(1, 0, 'Scanner'), cell(1, 1, 'Alpha'), cell(1, 2, 'Force'),
		cell(2, 0, 'Tube voltage (kV)'), cell(2, 1, '120'), cell(2, 2, '120'),
		{ id: 'p1', sourceText: 'A paragraph outside the table.' }
	];
	const h = tableHeadersByBlock(blocks);
	assert.deepEqual(h.get('t-r1c1'), { column: 'PCD-CT system', row: 'Scanner' });
	assert.deepEqual(h.get('t-r1c2'), { column: 'EID-CT system', row: 'Scanner' });
	assert.equal(h.get('t-r0c1'), undefined, 'the header row itself gets no context (its "row header" would be the corner cell)');
	assert.deepEqual(h.get('t-r1c0'), { column: 'Parameter' }, 'a row header gets the column header only');
	assert.equal(h.get('p1'), undefined);
});

test('5.1: spanning headers, numeric headers and tiny tables', () => {
	const spanned = tableHeadersByBlock([
		cell(0, 0, 'Group'), cell(0, 1, 'Image quality score', { tableColSpan: 2 }),
		cell(1, 0, 'Readers'), cell(1, 1, 'Mean'), cell(1, 2, 'SD'),
		cell(2, 0, '2024'), cell(2, 1, '4.1'), cell(2, 2, '0.3')
	]);
	assert.equal(spanned.get('t-r1c2')?.column, 'Image quality score', 'a header spanning two columns heads both');
	assert.equal(spanned.get('t-r2c1')?.row, undefined, 'a header without letters is not context');
	assert.equal(tableHeadersByBlock([cell(0, 0, 'A'), cell(0, 1, 'B'), cell(1, 0, 'C')]).size, 0, 'fewer than four cells: no table context');
});

test('5.1: the prompt explains tableHeaders only when a block carries them, and the payload sends them', () => {
	const base: TranslationRequest = { sourceLanguage: 'en', targetLanguage: 'zh-CN', blocks: [{ id: 'a', type: 'paragraph', text: 'Alpha' }] } as TranslationRequest;
	assert.ok(!buildSystemPrompt(base).includes('tableHeaders'));
	const withHeaders = { ...base, blocks: [{ ...base.blocks[0]!, tableHeaders: { column: 'PCD-CT system', row: 'Scanner' } }] };
	assert.match(buildSystemPrompt(withHeaders), /tableHeaders.*understanding only.*model names.*exactly as written/s);
	assert.deepEqual(JSON.parse(buildUserPayload(withHeaders)).blocks[0].tableHeaders, { column: 'PCD-CT system', row: 'Scanner' });
});

test('5.1: cells below the header row are re-translated once under the new rule; prose and header cells keep their keys', () => {
	assert.equal(policyStampFor({ sourceText: 'Alpha', tableId: 't1', tableRow: 1 }), 'tableCells2');
	assert.equal(policyStampFor({ sourceText: 'Parameter', tableId: 't1', tableRow: 0 }), '');
	assert.equal(policyStampFor({ sourceText: 'Body text.' }), '');
});

test('5.1: the translation manager sends each table cell with its headers', async () => {
	const { TranslationManager } = await import('../../src/translation/translationManager');
	const cells = [['Parameter', 'PCD-CT system', 'EID-CT system'], ['Scanner', 'Alpha', 'Force'], ['Tube voltage', '120 kV', '120 kV']]
		.flatMap((row, r) => row.map((text, c) => ({ id: `t-r${r}c${c}`, pageIndex: 0, order: r * 3 + c, type: 'paragraph' as const, sourceText: text,
			tableId: 't1', tableRow: r, tableCol: c, translationMode: 'translate' as const })));
	const seen = new Map<string, unknown>();
	const m = new TranslationManager({
		extractPage: async () => cells,
		readCache: async () => null, writeCache: async () => true,
		translateRequest: async request => { for (const b of request.blocks) seen.set(b.id, b.tableHeaders); return { translations: request.blocks.map(b => ({ id: b.id, translatedText: `译${b.text}` })) }; },
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }), getDocumentTitle: () => '', getGlossary: () => [], useContext: () => false,
		pageCount: () => 1, laneFor: () => 'openai', poolSize: () => 1
	}, { onPageUpdate: () => {} }, { prefetch: false, maxConcurrent: 2 });
	try {
		await m.ensurePage(0, 10);
		assert.deepEqual(seen.get('t-r1c1'), { column: 'PCD-CT system', row: 'Scanner' });
		assert.equal(seen.get('t-r0c1'), undefined);
	} finally { m.dispose(); }
});
