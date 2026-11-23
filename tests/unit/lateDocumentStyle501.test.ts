import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {ReaderLike} from '../../src/reader/zoteroReaderAdapter';
import {TextExtractor} from '../../src/reader/textExtractor';

// 5.0.1 (发布后复跑): 全篇样式超过等待时间才就绪时,先抽的页按逐页取法建块,
// 样式到了之后同一页的结构不同 —— 块文本不同,缓存键也不同。真机上 Kitagawa
// 第 1–11 页、Bae 第 1–20 页在仅缓存模式下因此成了原图,联网时则会重译一遍。
// 样式到达后,这些页必须能被找出来重建。
// `slowPages`: pages whose reads are slow — the style pass reads every page, so it
// finishes only after them, while a fast page is extracted at once.
function slowReader(pages: string[][], delayMs: number, slowPages: number[] = [0, 1, 2]): ReaderLike {
  const pageObj = (lines: string[], slow: boolean) => ({
    view: [0, 0, 612, 792],
    getTextContent: async () => {
      if (slow) await new Promise(r => setTimeout(r, delayMs));
      return {items: lines.map((str, i) => ({str, width: Math.min(470, str.length * 4.6), transform: [10, 0, 0, 10, 70, 720 - 13 * i]}))};
    },
    getOperatorList: async () => ({fnArray: [], argsArray: []})
  });
  const pdfDocument = {
    numPages: pages.length,
    getPage: async (n: number) => pageObj(pages[n - 1]!, slowPages.includes(n - 1)),
    getPageData: async () => { throw new DOMException('The object could not be cloned.', 'DataCloneError'); }
  };
  return {_internalReader: {_primaryView: {_iframeWindow: {PDFViewerApplication: {pdfDocument}}}}} as ReaderLike;
}

const prose = (n: number) => Array.from({length: n}, (_, i) => `This is body sentence number ${i} of the study and it continues across the column.`);
const unnumbered = (n: number, salt = 0) => Array.from({length: n}, (_, i) => [
  `Feigin${'abcdefghijklmnop'[(i + salt) % 16]} VL, Brainin M, Norrving B, et al. Global stroke fact sheet number ${i}.`,
  `Int J Stroke ${2012 + (i % 9)}; ${17 + i}:18-29`
]).flat();
const pages = [prose(40), prose(40), ['References:', ...unnumbered(12)], unnumbered(12, 5)];

test('5.0.1: a page built before a late document style is reported for rebuilding, and rebuilds like an on-time page', async () => {
  const late = new TextExtractor(slowReader(pages, 150), {includeReferences: true, documentStyleWaitMs: 1});
  await late.extractPage(3);
  assert.equal(late.extractPhasesFor(3)?.documentStyleState, 4, 'page 3 was extracted after the wait timed out');
  assert.equal(late.extractInputsFor(3)?.referencesAlreadyStarted, false, 'without the style the page does not know the references started');

  await late.ensureDocumentStyle();
  assert.deepEqual(late.pagesBuiltBeforeStyle(), [3], 'the page extracted without the style is reported once the style is ready');

  const rebuilt = await late.extractPage(3);
  const onTime = await new TextExtractor(slowReader(pages, 0), {includeReferences: true}).extractPage(3);
  assert.deepEqual(rebuilt.map(b => [b.sourceText, !!b.isReference]), onTime.map(b => [b.sourceText, !!b.isReference]));
  assert.equal(late.extractInputsFor(3)?.referencesAlreadyStarted, true, 'the rebuild uses the style');
  assert.deepEqual(late.pagesBuiltBeforeStyle(), [], 'a rebuilt page is not reported again');
});

test('5.0.1: pages built after the style arrived are not rebuilt; nothing is reported while the style is missing', async () => {
  const x = new TextExtractor(slowReader(pages, 15), {includeReferences: true, documentStyleWaitMs: 1});
  assert.deepEqual(x.pagesBuiltBeforeStyle(), []);
  await x.ensureDocumentStyle();
  await x.extractPage(2);
  await x.extractPage(3);
  assert.deepEqual(x.pagesBuiltBeforeStyle(), []);
});

test('5.0.1: a failed document style (over the page limit) reports nothing', async () => {
  const x = new TextExtractor(slowReader(pages, 0), {includeReferences: true, documentStyleWaitMs: 1});
  (x as unknown as {documentStyleState: string}).documentStyleState = 'failed';
  await x.extractPage(3);
  assert.deepEqual(x.pagesBuiltBeforeStyle(), []);
});

test('5.0.1: the acceptance-only style delay reproduces the late style on a fast reader', async () => {
  const x = new TextExtractor(slowReader(pages, 0), {includeReferences: true, documentStyleWaitMs: 1, documentStyleDelayMs: 40});
  await x.extractPage(3);
  assert.equal(x.extractPhasesFor(3)?.documentStyleState, 4);
  await x.ensureDocumentStyle();
  assert.deepEqual(x.pagesBuiltBeforeStyle(), [3]);
});
