import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractLegendItems, type LegendOptions, type LegendRect, type LegendSpan } from '../../src/reader/legendItems';
import { StructureCache } from '../../src/reader/structureCache';
import { pageContentKey } from '../../src/export/pageArchive';

const fixture = JSON.parse(readFileSync('tests/fixtures/regression/kitagawa-legend-p8.spans.json', 'utf8')) as LegendOptions & { items: LegendSpan[] };
const values = ['0.65', '0.74', '0.81', '0.85', '0.70', '0.73', '0.80', '0.84'];
function synthetic(): { items: LegendSpan[]; options: LegendOptions } {
	const items: LegendSpan[] = [], segments: LegendRect[] = [];
	for (let index = 0; index < 4; index++) {
		const top = 400 - index * 30;
		items.push({ text: `Independent label ${index}`, rect: [50, top - 10, 155, top], fontSize: 10 });
		items.push({ text: `Value ${index}`, rect: [50, top - 22, 95, top - 12], fontSize: 10 });
		segments.push([35, top - 5, 47, top - 5]);
	}
	return { items, options: { pageIndex: 2, pageWidth: 600, pageHeight: 800, segments } };
}

test('real PDF gives eight separately anchored legend entries, retaining all labels and AUC values', () => {
	const result = extractLegendItems(fixture.items, fixture);
	assert.equal(result.blocks.length, 8);
	assert.deepEqual(result.blocks.map(b => b.lineRectsPdf!.length), [2, 3, 2, 3, 2, 3, 2, 3]);
	for (const [index, block] of result.blocks.entries()) {
		assert.ok(block.sourceText.endsWith(values[index]!));
		assert.equal((block.sourceText.match(/Area Under the Curve/g) ?? []).length, 1);
		assert.equal(block.sourceRegion!.kind, 'legend-item');
		assert.equal(block.sourceRegion!.evidence, 'marker-aligned-lines');
		assert.equal(typeof block.column, 'number');
		assert.ok(block.sourceRegion!.markerPdf);
		assert.equal(block.sourceRegion!.markerPdf![1],block.sourceRegion!.markerPdf![3]);
	}
	assert.ok(result.blocks[1]!.sourceText.includes('Angiography + Computed Tomography Perfusion:'));
	assert.ok(result.blocks[3]!.sourceText.includes('Score + Computed Tomography Perfusion Values:'));
});

test('marker evidence survives JSON and structure-cache copies without sharing mutable arrays',()=>{
	const source=extractLegendItems(fixture.items,fixture).blocks;
	const original=JSON.parse(JSON.stringify(source)) as typeof source;
	const round=JSON.parse(JSON.stringify(source)) as typeof source;
	assert.deepEqual(round[0]!.sourceRegion!.markerPdf,original[0]!.sourceRegion!.markerPdf);
	round[0]!.sourceRegion!.markerPdf![0]-=3;assert.deepEqual(source,original);
	const cache=new StructureCache();cache.put('marker-proof',source);source[0]!.sourceRegion!.markerPdf![0]-=100;
	const first=cache.get('marker-proof')!;assert.deepEqual(first,original);
	first[0]!.sourceRegion!.markerPdf![0]-=100;assert.deepEqual(cache.get('marker-proof'),original);
});

test('changed or absent marker proof changes the archived page and final redraw identity',()=>{
	const block=extractLegendItems(fixture.items,fixture).blocks[0]!,translations=new Map([[block.id,'同一译文']]);
	const key=pageContentKey([block],translations),moved=JSON.parse(JSON.stringify(block)) as typeof block;
	moved.sourceRegion!.markerPdf![2]+=.25;assert.notEqual(pageContentKey([moved],translations),key);
	const missing=JSON.parse(JSON.stringify(block)) as typeof block;delete missing.sourceRegion!.markerPdf;
	assert.notEqual(pageContentKey([missing],translations),key);
});

test('real-PDF source runs are claimed exactly once and every unrelated span is returned by identity', () => {
	const result = extractLegendItems(fixture.items, fixture), rest = new Set(result.rest);
	assert.equal(fixture.items.length - result.rest.length, 20);
	assert.equal(result.rest.length, 166);
	for (const item of result.rest) assert.ok(fixture.items.includes(item));
	for (const item of fixture.items.filter(i => !rest.has(i))) {
		assert.equal(result.blocks.filter(b => b.lineRectsPdf!.some(r => r.every((v, index) => Math.abs(v - item.rect[index]!) < 1e-7))).length, 1);
	}
});

test('all eight source rectangles start after the original painted marker, never over it', () => {
	const result = extractLegendItems(fixture.items, fixture);
	for (const block of result.blocks) {
		const first = block.lineRectsPdf![0]!, area = block.sourceRegion!.boundsPdf;
		const marker = fixture.segments.find(s => s[0] < first[0] && s[2] < first[0] && first[0] - s[2] < block.fontSize!
			&& s[1] > first[1] && s[1] < first[3] && s[1] === s[3]);
		assert.ok(marker);
		assert.ok(area[0] > marker![2]);
		assert.equal(area[0], first[0]);
	}
});

test('source and marker input order do not affect text, IDs, geometry or membership', () => {
	const a = extractLegendItems(fixture.items, fixture);
	const b = extractLegendItems([...fixture.items].reverse(), { ...fixture, segments: [...fixture.segments].reverse() });
	assert.deepEqual(b.blocks, a.blocks);
	assert.deepEqual(new Set(b.rest), new Set(a.rest));
});

for (const scale of [.5, 1.75, 3]) test(`uniform scale ${scale} and translation preserve entry ownership`, () => {
	const tx = 23, ty = 47;
	const transform = (r: LegendRect): LegendRect => [r[0] * scale + tx, r[1] * scale + ty, r[2] * scale + tx, r[3] * scale + ty];
	const items = fixture.items.map(i => ({ ...i, rect: transform(i.rect), fontSize: i.fontSize! * scale }));
	const result = extractLegendItems(items, { ...fixture, pageWidth: fixture.pageWidth * scale + tx,
		pageHeight: fixture.pageHeight * scale + ty, segments: fixture.segments.map(transform) });
	assert.equal(result.blocks.length, 8);
	assert.deepEqual(result.blocks.map(b => b.sourceText), extractLegendItems(fixture.items, fixture).blocks.map(b => b.sourceText));
	assert.equal(result.rest.length, 166);
});

test('two adjacent panels keep their own rows and markers', () => {
	const { items, options } = synthetic();
	const second = items.map(i => ({ ...i, text: `Second ${i.text}`, rect: [i.rect[0] + 180, i.rect[1], i.rect[2] + 180, i.rect[3]] as LegendRect }));
	const segments = [...options.segments, ...options.segments.map(s => [s[0] + 180, s[1], s[2] + 180, s[3]] as LegendRect)];
	const result = extractLegendItems([...items, ...second], { ...options, segments });
	assert.equal(result.blocks.length, 8);
	assert.ok(result.blocks.slice(0, 4).every(b => !b.sourceText.includes('Second')));
	assert.ok(result.blocks.slice(4).every(b => b.sourceText.startsWith('Second')));
});

test('thin-rule duplicate edges do not duplicate items', () => {
	const { items, options } = synthetic();
	const result = extractLegendItems(items, { ...options, segments: [...options.segments, ...options.segments.map(s => [...s] as LegendRect)] });
	assert.equal(result.blocks.length, 4);
	assert.equal(result.rest.length, 0);
});

test('tightly adjacent panels whose text row is ambiguous cannot mask the neighbouring marker', () => {
	const { items, options } = synthetic();
	const second = items.map(i => ({ ...i, text: `Adjacent ${i.text}`, rect: [i.rect[0] + 115, i.rect[1], i.rect[2] + 115, i.rect[3]] as LegendRect }));
	const segments = [...options.segments, ...options.segments.map(s => [s[0] + 115, s[1], s[2] + 115, s[3]] as LegendRect)];
	const result = extractLegendItems([...items, ...second], { ...options, segments });
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, [...items, ...second]);
});

test('without repeated vector evidence ordinary same-font prose remains untouched', () => {
	const { items, options } = synthetic();
	for (const segments of [[], options.segments.slice(0, 2)]) {
		const result = extractLegendItems(items, { ...options, segments });
		assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, items);
	}
});

test('axis ticks and numeric unit labels do not establish legend ownership', () => {
	const { items, options } = synthetic();
	const numeric = items.map((item, index) => ({ ...item, text: index % 2 ? '2 ms' : String(index * 20) }));
	const result = extractLegendItems(numeric, options);
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, numeric);
});

test('short horizontal grid edges connected to vertical borders are excluded', () => {
	const { items, options } = synthetic();
	const verticals = options.segments.map(s => [s[0], s[1] - 15, s[0], s[1] + 15] as LegendRect);
	const result = extractLegendItems(items, { ...options, segments: [...options.segments, ...verticals] });
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, items);
});

test('ordinary underlines below the text cannot become left-hand markers', () => {
	const { items, options } = synthetic();
	const underlines = options.segments.map((s, index) => [50, items[index * 2]!.rect[1] - 1, 155, items[index * 2]!.rect[1] - 1] as LegendRect);
	assert.equal(extractLegendItems(items, { ...options, segments: underlines }).blocks.length, 0);
});

test('long borders and oblique plot strokes do not become legend marks', () => {
	const { items, options } = synthetic();
	for (const segments of [options.segments.map(s => [s[2] - 45, s[1], s[2], s[3]] as LegendRect),
		options.segments.map(s => [s[0], s[1] - 2, s[2], s[3] + 2] as LegendRect)]) {
		assert.equal(extractLegendItems(items, { ...options, segments }).blocks.length, 0);
	}
});

test('an overlapping image or obstacle never donates its text to an entry', () => {
	const { items, options } = synthetic();
	const result = extractLegendItems(items, { ...options, obstacles: [[30, 280, 160, 410]] });
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, items);
});

test('obstacle cutting a wrapped continuation rejects the stack instead of translating a partial item', () => {
	const { items, options } = synthetic();
	const result = extractLegendItems(items, { ...options, obstacles: [[60, 379, 90, 387]] });
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, items);
});

test('unrelated caption and nearby body text retain their own source spans', () => {
	const { items, options } = synthetic();
	const caption: LegendSpan = { text: 'A separate caption with substantially wider bounds.', rect: [50, 260, 350, 270], fontSize: 10 };
	const body: LegendSpan = { text: 'An unrelated body paragraph.', rect: [200, 300, 390, 310], fontSize: 10 };
	const result = extractLegendItems([...items, caption, body], options);
	assert.equal(result.blocks.length, 4); assert.deepEqual(result.rest, [caption, body]);
});

test('a ragged final legend tail followed by contiguous same-size same-left prose fails closed', () => {
	const { items, options } = synthetic();
	const body = { text: 'A subsequent body paragraph.', rect: [50, 276, 150, 286] as LegendRect, fontSize: 10 };
	const result = extractLegendItems([...items, body], options);
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, [...items, body]);
});

test('a ragged final legend tail followed by a same-font caption and following lines fails closed', () => {
	const { items, options } = synthetic();
	const caption = [0, 1, 2].map(index => ({ text: `Independent caption line ${index}`,
		rect: [50, 276 - index * 12, 150, 286 - index * 12] as LegendRect, fontSize: 10 }));
	const result = extractLegendItems([...items, ...caption], options);
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, [...items, ...caption]);
});

test('a long unbounded final prose continuation makes ownership ambiguous and remains untouched', () => {
	const { items, options } = synthetic();
	// No ragged final line supplies a source paragraph-end signal.
	for (const item of items) item.rect[2] = 155;
	for (let index = 0; index < 5; index++) items.push({ text: `Additional prose line ${index}`, rect: [50, 276 - index * 12, 150, 286 - index * 12], fontSize: 10 });
	const result = extractLegendItems(items, options);
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, items);
});

test('distinct markers claiming one first line cannot duplicate or absorb that ambiguous label', () => {
	const { items, options } = synthetic();
	const result = extractLegendItems(items, { ...options, segments: [...options.segments, [31, 395, 43, 395]] });
	assert.ok(result.rest.includes(items[0]!));
	assert.ok(result.blocks.every(b => !b.sourceText.includes('Independent label 0')));
});

test('missing coordinates and degenerate segments fail closed without source mutation', () => {
	const { items, options } = synthetic(); const before = JSON.stringify(items);
	const result = extractLegendItems(items, { ...options, segments: [[NaN, 1, 2, 1], [1, 1, 1, 1], [2, 1, 1, 2]] });
	assert.equal(result.blocks.length, 0); assert.deepEqual(result.rest, items); assert.equal(JSON.stringify(items), before);
});
