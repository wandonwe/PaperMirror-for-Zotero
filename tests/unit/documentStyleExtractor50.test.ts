import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {ReaderLike} from '../../src/reader/zoteroReaderAdapter';
import {TextExtractor} from '../../src/reader/textExtractor';

// 5.0 全篇样式接入抽取:结构与翻页顺序无关,参考文献会结束。
function readerOf(pages: string[][]): {reader: ReaderLike; reads: () => number} {
  let reads = 0;
  const pageObj = (lines: string[]) => ({
    view: [0, 0, 612, 792],
    getTextContent: async () => {
      reads++;
      return {items: lines.map((str, i) => ({str, width: Math.min(470, str.length * 4.6), transform: [10, 0, 0, 10, 70, 720 - 13 * i]}))};
    },
    getOperatorList: async () => ({fnArray: [], argsArray: []})
  });
  const pdfDocument = {
    numPages: pages.length,
    getPage: async (n: number) => pageObj(pages[n - 1]!),
    getPageData: async () => { throw new DOMException('The object could not be cloned.', 'DataCloneError'); }
  };
  return {reader: {_internalReader: {_primaryView: {_iframeWindow: {PDFViewerApplication: {pdfDocument}}}}} as ReaderLike, reads: () => reads};
}

const prose = (n: number) => Array.from({length: n}, (_, i) => `This is body sentence number ${i} of the study and it continues across the column.`);
// Unnumbered Vancouver entries (AJR / PMC manuscripts): per-page content detection
// does not recognise these, so only the document style can say "references".
const unnumbered = (n: number, salt = 0) => Array.from({length: n}, (_, i) => [
  `Feigin${'abcdefghijklmnop'[(i + salt) % 16]} VL, Brainin M, Norrving B, et al. Global stroke fact sheet number ${i}.`,
  `Int J Stroke ${2012 + (i % 9)}; ${17 + i}:18-29`
]).flat();
const entries = (from: number, n: number) => Array.from({length: n}, (_, i) => [
  `${from + i}. Smith J, Brown K, Lee M. A study of imaging protocols in patients with disease`,
  `number ${from + i}. J Radiol. ${2010 + (i % 10)};${20 + i}:${100 + i}-${110 + i}.`
]).flat();

test('5.0: a reference continuation page opened FIRST is still references', async () => {
  const {reader} = readerOf([prose(40), prose(40), ['References:', ...unnumbered(12)], unnumbered(12, 5)]);
  const extractor = new TextExtractor(reader, {includeReferences: true});
  const continuation = await extractor.extractPage(3); // heading page 2 never extracted
  assert.ok(continuation.length > 0);
  assert.ok(continuation.every(b => b.isReference), continuation.map(b => `${b.isReference ? 'R' : '-'} ${b.sourceText.slice(0, 40)}`).join(' | '));
  assert.deepEqual(extractor.documentStyleSummary(), {state: 'ready', ms: extractor.documentStyleSummary().ms, bodyFontSize: 10, referenceRanges: [[2, 3]]});
  const phases = extractor.extractPhasesFor(3)!;
  assert.equal(phases.documentStyleState, 2);
  assert.equal(phases.referencesFirstPage, 3);
  assert.equal(phases.referencesLastPage, 4);
});

test('5.0: the references end — figure legends after them are not references, even after visiting the heading page', async () => {
  const {reader} = readerOf([
    prose(40), ['References', ...entries(1, 12)], entries(13, 12),
    ['Figure 1. Phantom images reconstructed at three dose levels for both detectors.', 'Figure 2. Image noise as a function of dose for both detector types.']
  ]);
  const extractor = new TextExtractor(reader, {includeReferences: true});
  await extractor.extractPage(1);
  await extractor.extractPage(2);
  const legends = await extractor.extractPage(3);
  assert.ok(legends.length > 0);
  assert.ok(legends.every(b => !b.isReference), 'figure legends after the references are translated normally');
  // The range ends at page 2: page 3 is extracted with "not in references" as its input.
  assert.deepEqual(extractor.documentStyleSummary().referenceRanges, [[1, 2]]);
  assert.equal(extractor.extractInputsFor(3)?.referencesAlreadyStarted, false);
  assert.equal(extractor.extractInputsFor(2)?.referencesAlreadyStarted, true);
  // (The old per-page context never ended the references; the real-paper corpus
  // shows it on 2897 p11–16 and 2721 p10–30, where figure legends and a whole
  // supplement were treated as references.)
});

test('5.0: the same page gets the same structure whichever page was opened first', async () => {
  const pages = [prose(40), ['References:', ...unnumbered(12)], unnumbered(12, 5)];
  const a = new TextExtractor(readerOf(pages).reader, {includeReferences: true});
  const first = await a.extractPage(2);
  const b = new TextExtractor(readerOf(pages).reader, {includeReferences: true});
  await b.extractPage(0);
  await b.extractPage(1);
  const later = await b.extractPage(2);
  assert.deepEqual(later.map(x => [x.sourceText, !!x.isReference]), first.map(x => [x.sourceText, !!x.isReference]));
});
