import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PDFDocument, PDFPage} from 'pdf-lib';
import {buildTranslatedPdf, exportBlockGeometry, exportExpansionAllowance, setFontSource} from '../../src/pdfgen/translatedPdfBuilder';
import type {SourceBlock} from '../../src/types/models';

type Rect = [number, number, number, number];
const source: Rect = [50, 700, 150, 710];
const block = (id = 'cell'): SourceBlock => ({id, pageIndex: 0, order: 0, type: 'paragraph',
 sourceText: 'A source paragraph with enough characters.', lineRectsPdf: [[...source]], fontSize: 10});
const owned = (bounds: Rect): SourceBlock => ({...block(), tableId: 'table', tableRow: 0, tableCol: 0,
 tableSource: 'text-alignment', tableContentRectPdf: bounds});

test('an empty neighbouring cell is still a boundary, even when neighbour ink leaves room to expand', () => {
 assert.deepEqual(exportExpansionAllowance(source, [], 612, 792, 10), {right: 60, down: 28}, 'old ink-only allowance crossed both owner edges');
 const owner: Rect = [45, 698, 170, 715];
 const geometry = exportBlockGeometry(owned(owner), [], 612, 792, 10)!;
 assert.deepEqual(geometry.box, owner);
 assert.deepEqual(geometry.grow, {right: 0, down: 0});
});

test('body/caption regions cap expansion without moving their source anchor', () => {
 for (const kind of ['body-column', 'caption'] as const) {
  const b = {...block(), sourceRegion: {id: 'region', kind, boundsPdf: [45, 698, 170, 715] as Rect,
   evidence: 'column-geometry' as const}};
  const geometry = exportBlockGeometry(b, [], 612, 792, 10)!;
  assert.deepEqual(geometry.box, source);
  assert.deepEqual(geometry.grow, {right: 20, down: 2});
 }
 const legacy = exportBlockGeometry(block(), [], 612, 792, 10)!;
 assert.deepEqual(legacy.box, source);
 assert.deepEqual(legacy.grow, exportExpansionAllowance(source, [], 612, 792, 10));
 assert.equal(legacy.owner, undefined);
});

test('cell bounds take precedence over a broader region and padded masks stay inside the owner', () => {
 const b = {...owned([...source]), sourceRegion: {id: 'broad', kind: 'body-column' as const,
  boundsPdf: [0, 0, 612, 792] as Rect, evidence: 'column-geometry' as const}};
 const geometry = exportBlockGeometry(b, [], 612, 792, 10)!;
 assert.deepEqual(geometry.owner, source);
 assert.deepEqual(geometry.masks, [source]);
 const legacy = exportBlockGeometry(block(), [], 612, 792, 10)!;
 assert.deepEqual(legacy.masks, [[48.8, 698.8, 151.2, 711.2]]);
});

test('invalid owners and source ink outside its owner cannot be replaced', () => {
 for (const bounds of [[50, 700, 140, 710], [0, 0, 0, 1], [0, 0, NaN, 792]] as Rect[]) {
  assert.equal(exportBlockGeometry(owned(bounds), [], 612, 792, 10), null);
 }
});

const fontBytes = readFileSync(resolve(process.cwd(), 'assets/fonts/NotoSansSC-PM.ttf'));
function installFontStub(): () => void {
 const oldZotero = (globalThis as any).Zotero;
 (globalThis as any).Zotero = {HTTP: {request: async () => ({response:
  fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength)})}};
 setFontSource('resource://test/ownership.ttf');
 return () => { if (oldZotero === undefined) delete (globalThis as any).Zotero; else (globalThis as any).Zotero = oldZotero; };
}
async function pdf(): Promise<Uint8Array> {
 const doc = await PDFDocument.create(); doc.addPage([612, 792]); return doc.save();
}

test('real PDF export retains an overfull owned cell while the unowned legacy paragraph can use whitespace', async () => {
 const restore = installFontStub();
 try {
  const b = owned([45, 699, 165, 711]);
  const translations = new Map([[b.id, '译文'.repeat(30)]]);
  const bytes = await pdf();
  const constrained = await buildTranslatedPdf(bytes, new Map([[0, {blocks: [b], translations}]]), {dual: false});
  assert.equal(constrained.keptOriginal, 1);
  const unconstrained = await buildTranslatedPdf(bytes, new Map([[0, {blocks: [block()], translations}]]), {dual: false});
  assert.equal(unconstrained.keptOriginal, 0);
  assert.equal((await PDFDocument.load(constrained.monoBytes)).getPageCount(), 1);
 } finally {restore();}
});

test('real PDF export fits a narrow source header inside its cell and never masks outside that cell', async () => {
 const restore = installFontStub();
 const rectangle = PDFPage.prototype.drawRectangle, draw = PDFPage.prototype.drawText;
 const masks: Rect[] = [], draws: {x: number; y: number; width: number}[] = [];
 PDFPage.prototype.drawRectangle = function (options) {
  masks.push([options?.x || 0, options?.y || 0, (options?.x || 0) + (options?.width || 0), (options?.y || 0) + (options?.height || 0)]);
  return rectangle.call(this, options);
 };
 PDFPage.prototype.drawText = function (text, options) {
  draws.push({x: options?.x || 0, y: options?.y || 0, width: options?.font?.widthOfTextAtSize(text, options?.size || 10) || 0});
  return draw.call(this, text, options);
 };
 try {
  const owner: Rect = [45, 698, 130, 712];
  const header = {...owned(owner), sourceText: 'Section', fontSize: 8, lineRectsPdf: [[50, 700, 76, 708] as Rect]};
  const built = await buildTranslatedPdf(await pdf(), new Map([[0, {blocks: [header],
   translations: new Map([[header.id, '章节']])}]]), {dual: false});
  assert.equal(built.keptOriginal, 0);
  assert.ok(draws.length > 0, 'narrow source ink no longer makes a valid table header ineligible');
  for (const r of masks) assert.ok(r[0] >= owner[0] && r[1] >= owner[1] && r[2] <= owner[2] && r[3] <= owner[3]);
  for (const d of draws) assert.ok(d.x >= owner[0] && d.x + d.width <= owner[2] && d.y >= owner[1] && d.y <= owner[3]);
 } finally {PDFPage.prototype.drawRectangle = rectangle; PDFPage.prototype.drawText = draw; restore();}
});

test('an invalid owner is counted as kept original and paints neither masks nor translated text', async () => {
 const restore = installFontStub();
 const rectangle = PDFPage.prototype.drawRectangle, draw = PDFPage.prototype.drawText;
 let paints = 0;
 PDFPage.prototype.drawRectangle = function (options) {paints++; return rectangle.call(this, options);};
 PDFPage.prototype.drawText = function (text, options) {paints++; return draw.call(this, text, options);};
 try {
  const b = owned([50, 700, 140, 710]);
  const built = await buildTranslatedPdf(await pdf(), new Map([[0, {blocks: [b],
   translations: new Map([[b.id, '边界异常时保留原文']])}]]), {dual: false});
  assert.equal(built.keptOriginal, 1); assert.equal(paints, 0);
 } finally {PDFPage.prototype.drawRectangle = rectangle; PDFPage.prototype.drawText = draw; restore();}
});


test('stale cached translations never paint intentionally preserved formula or data blocks', async () => {
 const restore = installFontStub();
 const rectangle = PDFPage.prototype.drawRectangle, draw = PDFPage.prototype.drawText;
 let paints = 0;
 PDFPage.prototype.drawRectangle = function (options) {paints++; return rectangle.call(this, options);};
 PDFPage.prototype.drawText = function (text, options) {paints++; return draw.call(this, text, options);};
 try {
  const formula = {...block('formula'), sourceText: 'x ≈ 0.75 / y', translationMode: 'preserve' as const, preserveReason: 'display-formula'};
  const data = {...owned([45, 698, 170, 715]), id: 'data', sourceText: 'Preserved original data label',
   translationMode: 'preserve' as const, preserveReason: 'data'};
  const built = await buildTranslatedPdf(await pdf(), new Map([[0, {blocks: [formula, data],
   translations: new Map([[formula.id, '旧缓存的公式译文'], [data.id, '旧缓存的数据标签译文']])}]]), {dual: false});
  assert.equal(paints, 0);
  assert.equal(built.keptOriginal, 0, 'intentional preservation is not a layout failure');
 } finally {PDFPage.prototype.drawRectangle = rectangle; PDFPage.prototype.drawText = draw; restore();}
});
