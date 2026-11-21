import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {getPageData, type ReaderLike} from '../../src/reader/zoteroReaderAdapter';
import {TextExtractor} from '../../src/reader/textExtractor';
import {PaperMirrorError} from '../../src/types/models';

// Gecko cannot structured-clone a privileged wrapper when getPageData passes
// its argument straight to a content Worker. Node cannot emulate Xray, but it
// can exercise the production fallback using the same DOMException and ensure
// a present, failing chars API never implies an encrypted or text-free PDF.
function fixture() {
  const lines = [
    'Contrast enhancement was measured before treatment.',
    'The mean value was 17.25 HU in the study group.',
    'Measurements remained stable during follow-up.'
  ];
  let textReads = 0;
  const page = {
    view: [0, 0, 612, 792],
    getTextContent: async () => {
      textReads++;
      return {items: lines.map((str, i) => ({str, width: 280, transform: [10, 0, 0, 10, 70, 680 - 14 * i]}))};
    },
    getOperatorList: async () => ({fnArray: [], argsArray: []})
  };
  const pdfDocument = {
    numPages: 1,
    getPage: async () => page,
    getPageData: async () => { throw new DOMException('The object could not be cloned.', 'DataCloneError'); }
  };
  const reader: ReaderLike = {_internalReader: {_primaryView: {_iframeWindow: {PDFViewerApplication: {pdfDocument}}}}};
  return {reader, lines, textReads: () => textReads};
}

test('DataCloneError is an extraction transport failure, not encryption or missing text', async () => {
  const f = fixture();
  await assert.rejects(getPageData(f.reader, 0), (e: unknown) => {
    assert.ok(e instanceof PaperMirrorError);
    assert.equal(e.code, 'EXTRACTION_FAILED');
    assert.match(e.message, /could not be cloned/);
    return true;
  });
  assert.equal(f.textReads(), 0, 'adapter error classification does not itself start a different extraction');
});

test('DataCloneError preserves every source line through the standard text-content fallback', async () => {
  const f = fixture(), extractor = new TextExtractor(f.reader, {includeReferences: true});
  const blocks = await extractor.extractPage(0);
  assert.equal(extractor.extractPathFor(0), 'text-content');
  assert.deepEqual(extractor.charsPathOutcomes(), {'threw:EXTRACTION_FAILED/present': 1});
  assert.deepEqual(extractor.textContentOutcomes(), {ok: 1});
  const actual = blocks.map(b => b.sourceText).join(' ').replace(/\s+/g, ' ');
  assert.equal(actual, f.lines.join(' '), 'no dropped, duplicated, or altered source characters');
  assert.ok(blocks.every(b => b.boundingBox && b.boundingBox.width > 0 && b.boundingBox.height > 0));
  // 5.0: one read for the page itself + one for the whole-document style scan
  // (each page once per document, lightweight). Extracting again reads nothing new.
  assert.equal(f.textReads(), 2);
  await extractor.extractPage(0);
  assert.equal(f.textReads(), 2, 'the document style is computed once per document');
});

test('realm probe repeats its chrome control and restores local mode without exposing source text', async () => {
  let localOnly = false, saved = '';
  const nativeRequests = new WeakSet<object>(), closed: string[] = [];
  class ContentObject { constructor() { nativeRequests.add(this); } }
  const rawText = 'Private source text must stay out of diagnostic output.';
  const doc = {getPageData: async (request: object) => {
    assert.equal(localOnly, true, 'all four reads must run with the network restriction enabled');
    if (!nativeRequests.has(request)) throw new DOMException(rawText, 'DataCloneError');
    return {chars: [{c: rawText, lineBreakAfter: true}]};
  }};
  const reader = {tabID: 'new-tab', _initPromise: Promise.resolve(),
    _internalReader: {_primaryView: {_iframeWindow: {Object: ContentObject, PDFViewerApplication: {pdfDocument: doc}}}}};
  const run = runInNewContext(readFileSync('scripts/zotero/page-data-realm-check.js', 'utf8'), {
    Zotero: {version: '10.0.9', PaperMirror: {version: '4.9.0'},
      Prefs: {get: () => localOnly, set: (_key: string, value: boolean) => {localOnly = value;}},
      getMainWindow: () => ({setTimeout, clearTimeout, Zotero_Tabs: {close: (id: string) => {closed.push(id);}}}),
      Reader: {_readers: [], open: async () => reader},
      File: {putContentsAsync: async (_path: string, content: string) => {saved = content;}}},
    Cu: {cloneInto: (data: object) => Object.assign(new ContentObject(), data)}
  });
  const result = await run({items: [{label: 'Synthetic paper', attachmentID: 1, pageIndexes: [0]}], output: 'counts.json'});
  const tests = JSON.parse(JSON.stringify(result.rows[0].tests)) as {label: string; ok: boolean; name?: string; chars?: number}[];
  assert.deepEqual(tests.map(t => [t.label, t.ok]), [
    ['chrome object', false], ['content Object', true], ['Cu.cloneInto', true], ['chrome object repeat', false]
  ]);
  assert.equal(tests[0]?.name, 'DataCloneError');
  assert.equal(tests[3]?.name, 'DataCloneError');
  assert.equal(tests[1]?.chars, 1);
  assert.equal(localOnly, false);
  assert.equal(result.localOnlyRestored, true);
  assert.deepEqual(closed, ['new-tab']);
  assert.ok(!saved.includes(rawText));
  assert.ok(!saved.includes('stack'));
});
