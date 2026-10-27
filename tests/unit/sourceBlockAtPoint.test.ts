import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceBlockAtPoint } from '../../src/reader/sourceBlockAtPoint';
import { ReaderSession } from '../../src/reader/readerSession';
import type { SourceBlock } from '../../src/types/models';
const first: SourceBlock = { id: 'region::body', pageIndex: 0, order: 0, type: 'paragraph',
 sourceText: 'A complete paragraph containing several words.', lineRectsPdf: [[10, 20, 100, 30], [10, 35, 80, 45]] };
const second: SourceBlock = { ...first, id: 'right', sourceText: 'A different paragraph.', lineRectsPdf: [[120, 20, 220, 30]] };
const identity = (x: number, y: number): [number, number] => [x, y];

test('double click resolves a whole paragraph on any line without crossing the column gutter', () => {
 assert.equal(sourceBlockAtPoint([first, second], 20, 40, identity)?.sourceText, first.sourceText);
 assert.equal(sourceBlockAtPoint([first, second], 130, 25, identity), second);
 assert.equal(sourceBlockAtPoint([first, second], 110, 25, identity), undefined);
});
test('source hit testing follows PDF viewport scaling and rotation', () => {
 const rotate = (x: number, y: number): [number, number] => [y * 2, 300 - x * 2];
 assert.equal(sourceBlockAtPoint([first], 50, 260, rotate), first);
});
test('native PDF double click dispatches paragraph analysis in overlay mode and unregisters its listener', () => {
 const listeners = new Map<string, Function>();
 const doc = { addEventListener(name: string, fn: Function) { listeners.set(name, fn); },
  removeEventListener(name: string, fn: Function) { if (listeners.get(name) === fn) listeners.delete(name); } };
 const div = { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({left: 100, top: 200}) };
 const reader = { _internalReader: { _primaryView: { _iframeWindow: { document: doc,
  PDFViewerApplication: { pdfViewer: {getPageView: () => ({div, viewport: {convertToViewportPoint: identity}})} } } } } };
 const calls: string[] = [];
 const session = Object.assign(Object.create(ReaderSession.prototype), {reader, viewMode: 'overlay', destroyed: false,
  manager: {getPageState: () => ({blocks: [first, second]})}, explainSelection: (text: string) => {calls.push(text);} });
 session.watchAutomaticExplanation();
 const target = {closest: (selector: string) => selector === '.textLayer' ? {} : {getAttribute: () => '1'}};
 listeners.get('dblclick')!({target, clientX: 120, clientY: 240});
 assert.deepEqual(calls, [first.sourceText]);
 session.viewMode = 'split';
 listeners.get('dblclick')!({target, clientX: 120, clientY: 240});
 assert.equal(calls.length, 1);
 session.disposeOriginalDoubleClick(); session.disposeAutoExplain();
 assert.equal(listeners.size, 0);
});
