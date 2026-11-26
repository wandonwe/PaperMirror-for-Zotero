import test from 'node:test';
import assert from 'node:assert/strict';
import { structureSpanPage, type SpanPage } from '../../src/reader/pagePipeline';
import type { SpanItem } from '../../src/reader/spanBlockBuilder';
import { decideBreak } from '../../src/reader/paragraphHeuristics';
import geometry from '../fixtures/regression/r51-bold-heading-geometry.json';

// 5.1: body-size subheadings set in bold. Fixtures are synthetic, or real layout
// geometry with letters masked to x/X and digits to 0.

const W = 300, LEFT = 40, LINE = 10.5, SIZE = 8;
const item = (text: string, y: number, opts: { x?: number; w?: number; bold?: boolean } = {}): SpanItem => {
	const x = opts.x ?? LEFT, w = opts.w ?? Math.min(250, text.length * 4.1);
	return { text, rect: [x, y, x + w, y + SIZE], fontSize: SIZE, ...(opts.bold ? { bold: true } : {}) };
};
const prose = (y: number, n: number, start = 0): SpanItem[] => Array.from({ length: n }, (_, i) =>
	item(`Body sentence ${start + i} continues across the whole column of this article and wraps here`, y - i * LINE, { w: 250 }));
const page = (items: SpanItem[]): SpanPage => ({ items, pageWidth: W, pageHeight: 400 });
const ctx = { pageIndex: 4, includeReferences: true, referencesAlreadyStarted: false, bodyFontSize: SIZE };
const texts = (p: SpanPage): string[] => structureSpanPage(p, ctx).blocks.map(b => b.sourceText);

test('5.1: a bold body-size heading is not welded onto the paragraph above (2638 "4. Discussion", masked geometry)', () => {
	const fx = geometry as unknown as SpanPage;
	const run = (p: SpanPage): string[] => structureSpanPage(p, { ...ctx, pageIndex: 3 }).blocks.map(b => b.sourceText);
	const heading = run(fx).find(t => /^0\. Xxxxxxxxxx$/.test(t));
	assert.ok(heading, 'the bold heading is a block of its own');
	// Without the weights the 5.0 weld comes back: the heading ends the paragraph above.
	const plain = run({ ...fx, items: fx.items.map(({ bold: _b, ...rest }) => rest) });
	assert.ok(plain.some(t => /\.\s+0\. Xxxxxxxxxx$/.test(t)), 'the fixture reproduces the 5.0 weld without weights');
});

test('5.1: a bold caption label keeps its caption, and a bold word inside a sentence stays inside it', () => {
	const caption = [
		item('Fig. 4. Follow-up MRI of the brain.', 300, { bold: true, w: 150 }),
		item('a — before treatment; b — 1 month after surgery; c — after 3 months.', 300 - LINE, { w: 250 })
	];
	assert.equal(texts(page([...prose(340, 2), ...caption])).filter(t => /Fig\. 4/.test(t) && /before treatment/.test(t)).length, 1);
	const running = [
		...prose(300, 2),
		item('Reset: Change back to the main representation, that is, either Mono+ or', 300 - 2 * LINE, { w: 250 }),
		item('Conv. CT.', 300 - 3 * LINE, { bold: true, w: 36 }),
		...prose(300 - 4 * LINE - 12, 2, 7)
	];
	assert.ok(texts(page(running)).some(t => /Mono\+ or Conv\. CT\./.test(t)), 'the bold product name stays in its sentence');
});

test('5.1: a bold heading that wraps after "of the" stays one heading (3165)', () => {
	const items = [
		...prose(300, 3),
		item('Diseases of the', 300 - 3 * LINE - 14, { bold: true, w: 64 }),
		item('Biliary Tract', 300 - 4 * LINE - 14, { bold: true, w: 52 }),
		...prose(300 - 5 * LINE - 28, 3, 5)
	];
	assert.ok(texts(page(items)).includes('Diseases of the Biliary Tract'));
});

test('5.1: bold inside running text does not split the paragraph', () => {
	// A bold sentence that fills the column, and a run-in bold label at a line start.
	const items = [
		...prose(300, 2),
		item('This highlighted finding is set in bold and fills the whole column of', 300 - 2 * LINE, { bold: true, w: 250 }),
		...prose(300 - 3 * LINE, 2, 5),
		item('Statistics.', 300 - 5 * LINE, { bold: true, w: 44 }),
		item('Continuous variables were compared with the t test throughout', 300 - 5 * LINE, { x: LEFT + 47, w: 203 }),
		...prose(300 - 6 * LINE, 2, 9)
	];
	assert.equal(texts(page(items)).length, 1);
});

test('5.1: no weight break inside a reference list', () => {
	assert.equal(decideBreak({ fontSize: 8, gap: 2, wrapped: true, newColumn: false, indented: false, fontJump: false, listStart: false, weightChange: false }).brk, false);
	assert.ok(decideBreak({ fontSize: 8, gap: 2, wrapped: true, newColumn: false, indented: false, fontJump: false, listStart: false, weightChange: true }).evidence.some(e => e.reason === 'weight-change'));
});

test('5.1: the text-content path marks runs set in a bold face, and leaves weights off when fonts are unavailable', async () => {
	const { getTextContentItems } = await import('../../src/reader/zoteroReaderAdapter');
	const make = (names: Record<string, string>, ops = true) => {
		const raw = [
			{ str: '4. Discussion', transform: [8, 0, 0, 8, 38, 234], width: 52, fontName: 'f_bold' },
			{ str: 'This study investigated the image quality', transform: [8, 0, 0, 8, 50, 214], width: 180, fontName: 'f_body' }
		];
		const page = { view: [0, 0, 612, 792], getTextContent: async () => ({ items: raw }),
			...(ops ? { getOperatorList: async () => ({ fnArray: [], argsArray: [] }) } : {}),
			commonObjs: { get: (id: string, cb?: (v: unknown) => void) => { const v = names[id] ? { name: names[id] } : undefined; cb?.(v); return v; } } };
		const doc = { getPage: async () => page };
		return { _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: doc } } } } } as never;
	};
	const ok = await getTextContentItems(make({ f_bold: 'OHXEQK+CharisSIL-Bold', f_body: 'AQRSFN+CharisSIL' }), 0);
	assert.deepEqual(ok?.items.map(i => !!i.bold), [true, false]);
	assert.equal(ok?.fontRepair?.weights, 'ok');
	const none = await getTextContentItems(make({}, false), 0);
	assert.deepEqual(none?.items.map(i => !!i.bold), [false, false]);
});
