import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { create as createFont } from '@pdf-lib/fontkit';
import { embeddedSymbolRepairs, wrapRawCff, type SymbolGlyphObservation } from '../../src/reader/embeddedFontSymbols';
import { cff, evidenceCff, font, source, oneFont, ge, eq, ordinaryDollar } from '../fixtures/regression/symbolFontFixture';

const observe = (unicode = '$', originalCharCode = 36, fontName = 'TestFace'): SymbolGlyphObservation => ({ fontName, unicode, originalCharCode });

test('raw CFF envelope preserves bytes, declared length, alignment and checksum', () => {
 const raw = evidenceCff(), wrapped = wrapRawCff(raw), v = new DataView(wrapped.buffer);
 assert.equal(Buffer.from(wrapped.subarray(0, 4)).toString(), 'OTTO');
 assert.equal(v.getUint16(4), 1);
 assert.equal(Buffer.from(wrapped.subarray(12, 16)).toString(), 'CFF ');
 assert.equal(v.getUint32(20), 28);
 assert.equal(v.getUint32(24), raw.length);
 assert.equal(wrapped.length % 4, 0);
 assert.deepEqual(wrapped.subarray(28, 28 + raw.length), raw);
 let checksum = 0;
 for (let n = 28; n < wrapped.length; n += 4) checksum = (checksum + v.getUint32(n)) >>> 0;
 assert.equal(v.getUint32(16), checksum);
});

test('invalid or oversized CFF headers fail closed', () => {
 for (const raw of [new Uint8Array(), Uint8Array.of(1, 0, 4), Uint8Array.of(2, 0, 4, 4),
  Uint8Array.of(1, 0, 3, 4), Uint8Array.of(1, 0, 5, 4), Uint8Array.of(1, 0, 4, 0), Uint8Array.of(1, 0, 4, 5), new Uint8Array(2 * 1024 * 1024 + 1)]) {
  assert.throws(() => wrapRawCff(raw), RangeError);
 }
});

test('generated embedded Type1C outlines repair both WinAnsi slots without trusting glyph names', async () => {
 const doc = await oneFont();
 const repairs = await embeddedSymbolRepairs(doc, 0, [observe(), observe('¼', 188)]);
 assert.deepEqual([...repairs.get('TestFace')!], [['$', '≥'], ['¼', '=']]);
});

test('CFF default and explicit positive uniform FontMatrix with translation preserve relation evidence', async () => {
 for (const fontMatrix of [undefined, [0.001, 0, 0, 0.001, 0, 0], [0.002, 0, 0, 0.002, -125.5, 340]]) {
  const raw = cff([{ name: 'dollar', commands: ge }, { name: 'onequarter', commands: eq }], { fontMatrix });
  const repairs = await embeddedSymbolRepairs(await oneFont({ raw }), 0, [observe(), observe('¼', 188)]);
  assert.deepEqual([...repairs.get('TestFace')!], [['$', '≥'], ['¼', '=']]);
 }
});

for (const [label, fontMatrix] of [
 ['horizontal reflection', [-0.001, 0, 0, 0.001, 0, 0]],
 ['vertical reflection', [0.001, 0, 0, -0.001, 0, 0]],
 ['half-turn rotation', [-0.001, 0, 0, -0.001, 0, 0]],
 ['quarter-turn rotation', [0, 0.001, -0.001, 0, 0, 0]],
 ['shear', [0.001, 0, 0.0001, 0.001, 0, 0]],
 ['nonuniform scaling', [0.001, 0, 0, 0.002, 0, 0]],
 ['zero scaling', [0, 0, 0, 0, 0, 0]],
 ['missing matrix component', [0.001, 0, 0, 0.001, 0]]
] as const) {
 test(`embedded CFF ${label} cannot authorize printable symbol repair`, async () => {
  const raw = cff([{ name: 'dollar', commands: ge }], { fontMatrix });
  assert.equal((await embeddedSymbolRepairs(await oneFont({ raw }), 0, [observe()])).size, 0);
 });
}

for (const value of [Infinity, -Infinity, NaN]) {
 test(`decoded CFF non-finite FontMatrix translation ${String(value)} fails closed`, async () => {
  const raw = cff([{ name: 'dollar', commands: ge }], { fontMatrix: [0.001, 0, 0, 0.001, value, 0] });
  const parsed = createFont(wrapRawCff(raw)) as unknown as { 'CFF ': { topDict: { FontMatrix: number[] } } };
  assert.equal(Object.is(parsed['CFF '].topDict.FontMatrix[4], value), true, 'fixture reaches the non-finite matrix guard');
  assert.equal((await embeddedSymbolRepairs(await oneFont({ raw }), 0, [observe()])).size, 0);
 });
}

test('no candidates, invalid page indices or missing getData never read document bytes', async () => {
 let reads = 0;
 const doc = { getData: async () => { reads++; throw Error('must not read'); } };
 for (const [page, observations] of [[0, []], [0, [observe('A')]], [0, [observe('$', 36, '')]], [-1, [observe()]], [.5, [observe()]]] as const) {
  assert.equal((await embeddedSymbolRepairs(doc, page, observations)).size, 0);
 }
 assert.equal(reads, 0);
 assert.equal((await embeddedSymbolRepairs({}, 0, [observe()])).size, 0);
});

test('invalid documents, malformed CFF, unsupported font types and absent font resources cannot authorize repair', async () => {
 assert.equal((await embeddedSymbolRepairs({ getData: async () => Uint8Array.of(0, 1, 2) }, 0, [observe()])).size, 0);
 const empty = await PDFDocument.create(); empty.addPage();
 assert.equal((await embeddedSymbolRepairs(await source(empty), 0, [observe()])).size, 0);
 for (const options of [{ raw: Uint8Array.of(1, 0, 4, 4) }, { subtype: 'Type0' }, { fileSubtype: 'OpenType' }]) {
  assert.equal((await embeddedSymbolRepairs(await oneFont(options), 0, [observe()])).size, 0);
 }
});

test('explicit Differences select the glyph under unknown base encoding and nonstandard character slots', async () => {
 const doc = await oneFont({ encoding: { BaseEncoding: 'UnknownEncoding', Differences: [65, 'dollar', 91, 'onequarter'] } });
 const repairs = await embeddedSymbolRepairs(doc, 0, [observe('$', 65), observe('¼', 91)]);
 assert.deepEqual([...repairs.get('TestFace')!], [['$', '≥'], ['¼', '=']]);
});

test('unknown encodings, out-of-range codes and conflicting duplicate Differences fail closed', async () => {
 for (const encoding of ['MacRomanEncoding', { BaseEncoding: 'UnknownEncoding' },
  { BaseEncoding: 'WinAnsiEncoding', Differences: [36, 'dollar', 36, 'onequarter'] }]) {
  assert.equal((await embeddedSymbolRepairs(await oneFont({ encoding }), 0, [observe()])).size, 0);
 }
 const doc = await oneFont();
 for (const code of [-1, 256, .5, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal((await embeddedSymbolRepairs(doc, 0, [observe('$', code)])).size, 0);
 }
});

test('two source glyphs observed as one Unicode cannot be merged into a single repair vote', async () => {
 const raw = cff([{ name: 'dollar', commands: ge }, { name: 'alternate', commands: ge }]);
 const doc = await oneFont({ raw, encoding: { Differences: [36, 'dollar', 'alternate'] } });
 assert.equal((await embeddedSymbolRepairs(doc, 0, [observe('$', 36), observe('$', 37)])).size, 0);
 assert.equal((await embeddedSymbolRepairs(doc, 0, [observe('$', 36), observe('$', 99)])).size, 0);
});

test('duplicate glyph names and actual ordinary-dollar outlines never authorize a relation', async () => {
 const duplicates = cff([{ name: 'dollar', commands: ge }, { name: 'dollar', commands: eq }]);
 assert.equal((await embeddedSymbolRepairs(await oneFont({ raw: duplicates }), 0, [observe()])).size, 0);
 const ordinary = cff([{ name: 'dollar', commands: ordinaryDollar }]);
 assert.equal((await embeddedSymbolRepairs(await oneFont({ raw: ordinary }), 0, [observe()])).size, 0);
});

test('duplicate BaseFont resources are ambiguous, while aliases of the same resource remain usable', async () => {
 for (const duplicate of [true, false]) {
  const pdf = await PDFDocument.create(), page = pdf.addPage(), first = font(pdf);
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: first, F2: duplicate ? font(pdf) : first } }));
  const repairs = await embeddedSymbolRepairs(await source(pdf), 0, [observe()]);
  assert.equal(repairs.get('TestFace')?.get('$'), duplicate ? undefined : '≥');
 }
});

test('Form XObject resources participate in name ambiguity and successful glyph evidence', async () => {
 for (const duplicate of [true, false]) {
  const pdf = await PDFDocument.create(), page = pdf.addPage();
  const nested = pdf.context.register(pdf.context.flateStream('', { Type: 'XObject', Subtype: 'Form',
   BBox: [0, 0, 10, 10], Resources: { Font: { Inner: font(pdf) } } }));
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ ...(duplicate ? { Font: { Outer: font(pdf) } } : {}), XObject: { Form1: nested } }));
  const repairs = await embeddedSymbolRepairs(await source(pdf), 0, [observe()]);
  assert.equal(repairs.get('TestFace')?.get('$'), duplicate ? undefined : '≥');
 }
});

test('partial traversal beyond the resource depth limit cannot accept a font found earlier', async () => {
 const pdf = await PDFDocument.create(), page = pdf.addPage();
 let resources = pdf.context.obj({});
 for (let i = 0; i < 10; i++) {
  const form = pdf.context.register(pdf.context.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: resources }));
  resources = pdf.context.obj({ XObject: { Nested: form } });
 }
 resources.set(PDFName.of('Font'), pdf.context.obj({ F1: font(pdf) }));
 page.node.set(PDFName.of('Resources'), resources);
 assert.equal((await embeddedSymbolRepairs(await source(pdf), 0, [observe()])).size, 0);
});

test('font and resource caches stay isolated across documents and pages using the same BaseFont', async () => {
 const math = await oneFont(), ordinary = await oneFont({ raw: cff([{ name: 'dollar', commands: ordinaryDollar }]) });
 assert.equal((await embeddedSymbolRepairs(math, 0, [observe()])).get('TestFace')?.get('$'), '≥');
 assert.equal((await embeddedSymbolRepairs(ordinary, 0, [observe()])).size, 0);
 assert.equal((await embeddedSymbolRepairs(math, 0, [observe('¼', 188)])).get('TestFace')?.get('¼'), '=');
 assert.equal(math.reads(), 1, 'same PDF bytes are parsed once across observations');
 const pdf = await PDFDocument.create(), first = pdf.addPage(), second = pdf.addPage();
 first.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font(pdf) } }));
 second.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font(pdf, { raw: cff([{ name: 'dollar', commands: ordinaryDollar }]) }) } }));
 const doc = await source(pdf);
 assert.equal((await embeddedSymbolRepairs(doc, 0, [observe()])).get('TestFace')?.get('$'), '≥');
 assert.equal((await embeddedSymbolRepairs(doc, 1, [observe()])).size, 0);
 assert.equal((await embeddedSymbolRepairs(doc, 0, [observe()])).get('TestFace')?.get('$'), '≥');
});

test('caller mutation of a repair result cannot contaminate cached font evidence', async () => {
 const doc = await oneFont(), observations = [observe(), observe('¼', 188)];
 const before = JSON.stringify(observations), repairs = await embeddedSymbolRepairs(doc, 0, observations);
 repairs.get('TestFace')!.set('$', 'wrong'); repairs.clear();
 assert.deepEqual([...(await embeddedSymbolRepairs(doc, 0, observations)).get('TestFace')!], [['$', '≥'], ['¼', '=']]);
 assert.equal(JSON.stringify(observations), before);
});
