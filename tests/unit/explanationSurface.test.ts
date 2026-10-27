import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReaderSession } from '../../src/reader/readerSession';
import { TranslationPane } from '../../src/ui/translationPane';
import { getProvider } from '../../src/translation/providers/registry';

test('overlay analysis targets a floating host without opening the split reader', () => {
 const paneHost = {}, explanationHost = {};
 let target: unknown, paneVisible = true;
 const session = Object.assign(Object.create(ReaderSession.prototype), {
  viewMode: 'overlay',
  pane: { setExplanationHost: (host: unknown) => { target = host; }, setSurfaceActive() {} },
  split: { paneHost, explanationHost, setPaneVisible(value: boolean) { paneVisible = value; } },
  applyOverlay() {}, renderTopTask() {}, syncCapsuleCollapsedState() {}
 });
 (globalThis as any).Zotero = { Prefs: { get: () => true } };
 try {
  session.applyViewMode();
  assert.equal(target, explanationHost);
  assert.equal(paneVisible, false);
  assert.equal(session.getViewMode(), 'overlay');
  session.viewMode = 'split'; session.applyViewMode();
  assert.equal(target, paneHost);
  assert.equal(paneVisible, true);
 } finally { delete (globalThis as any).Zotero; }
});

test('the same explanation card moves between surfaces and closes from its current surface', () => {
 const card = { removed: false, remove() { this.removed = true; } };
 const paneHost = { getAttribute: () => 'dark', querySelector: () => card };
 let attached: unknown, theme: unknown;
 const overlayHost = { appendChild: (node: unknown) => { attached = node; },
  setAttribute: (_key: string, value: unknown) => { theme = value; }, querySelector: () => card };
 const pane = Object.assign(Object.create(TranslationPane.prototype), {
  host: paneHost, explanationHost: paneHost
 });
 pane.setExplanationHost(overlayHost as any);
 assert.equal(attached, card);
 assert.equal(theme, 'dark');
 pane.hideExplanation();
 assert.equal(card.removed, true);
});

test('outside clicks in both the reader and pane close analysis; internal actions stay usable', () => {
 const mainListeners = new Map<string, Function>(), pdfListeners = new Map<string, Function>();
 const fakeDoc = (listeners: Map<string, Function>) => ({
  addEventListener: (name: string, fn: Function) => listeners.set(name, fn),
  removeEventListener: (name: string, fn: Function) => { if (listeners.get(name) === fn) listeners.delete(name); }
 });
 const mainDoc = fakeDoc(mainListeners), pdfDoc = fakeDoc(pdfListeners);
 const inside = {}, outside = {};
 let removed = 0, dismissed = 0;
 const card = { contains: (node: unknown) => node === inside, remove: () => { removed++; } };
 const pane = Object.assign(Object.create(TranslationPane.prototype), {
  doc: mainDoc, explanationDismissDocuments: [], explanationHost: {querySelector: () => card},
  callbacks: {onDismissExplanation: () => {dismissed++;}}
 });
 pane.setExplanationDismissDocument(pdfDoc as any);
 pane.watchExplanationOutside(card);
 mainListeners.get('pointerdown')!({button: 0, target: inside});
 assert.equal(removed, 0);
 mainListeners.get('pointerdown')!({button: 2, target: outside});
 assert.equal(removed, 0);
 pdfListeners.get('pointerdown')!({button: 0, target: outside});
 assert.equal(removed, 1); assert.equal(dismissed, 1);
 assert.equal(mainListeners.size, 0); assert.equal(pdfListeners.size, 0);
 pane.watchExplanationOutside(card);
 mainListeners.get('pointerdown')!({button: 0, target: outside});
 assert.equal(removed, 2); assert.equal(dismissed, 2);
 // Programmatic hiding during a new selection must not suppress that selection.
 pane.hideExplanation();
 assert.equal(dismissed, 2);
});

test('Escape in the focused PDF document dismisses and clears both documents listeners', () => {
 const documents = [new EventTarget(), new EventTarget()];
 const card = { contains: () => false, remove() { removed++; } };
 let removed = 0, dismissed = 0;
 const pane = Object.assign(Object.create(TranslationPane.prototype), {
  doc: documents[0], explanationDismissDocuments: [documents[1]],
  explanationHost: {querySelector: () => card},
  callbacks: {onDismissExplanation: () => {dismissed++;}}
 });
 pane.watchExplanationOutside(card);
 const key = (value: string) => Object.assign(new Event('keydown'), {key: value});
 documents[1]!.dispatchEvent(key('Enter'));
 assert.equal(dismissed, 0);
 documents[1]!.dispatchEvent(key('Escape'));
 assert.equal(dismissed, 1); assert.equal(removed, 1);
 documents[0]!.dispatchEvent(key('Escape'));
 documents[1]!.dispatchEvent(key('Escape'));
 assert.equal(dismissed, 1, 'closing removes the listeners from both documents');
 pane.watchExplanationOutside(card);
 documents[0]!.dispatchEvent(key('Escape'));
 assert.equal(dismissed, 2); assert.equal(removed, 2);
});

test('switching the PDF dismiss document cleans up listeners from the previous iframe', () => {
 const main = new EventTarget(), previous = new EventTarget(), next = new EventTarget();
 let dismissed = 0;
 const card = { contains: () => false, remove() {} };
 const pane = Object.assign(Object.create(TranslationPane.prototype), {
  doc: main, explanationDismissDocuments: [previous], explanationHost: {querySelector: () => card},
  callbacks: {onDismissExplanation: () => {dismissed++;}}
 });
 pane.watchExplanationOutside(card);
 pane.setExplanationDismissDocument(next as any);
 previous.dispatchEvent(Object.assign(new Event('keydown'), {key: 'Escape'}));
 assert.equal(dismissed, 0);
 next.dispatchEvent(Object.assign(new Event('keydown'), {key: 'Escape'}));
 assert.equal(dismissed, 1);
});

test('dismissal cancels a delayed explanation and prevents its result from reopening the card', async () => {
 const provider = getProvider('openai-compatible'), originalComplete = provider.complete;
 const previousZotero = (globalThis as any).Zotero;
 let resolveResult!: (text: string) => void, completeStarted!: () => void;
 const started = new Promise<void>(resolve => { completeStarted = resolve; });
 const response = new Promise<string>(resolve => { resolveResult = resolve; });
 const shows: unknown[] = [];
 let signal: AbortSignal | undefined;
 provider.complete = async (_prompt, _settings, options) => {
  signal = options?.signal; completeStarted(); return response;
 };
 (globalThis as any).Zotero = {Prefs: {get: () => true}};
 const pane = Object.assign(Object.create(TranslationPane.prototype), {
  explanationHost: {querySelector: () => ({remove() {}})},
  getSelectedBlockId: () => null, showExplanation: (value: unknown) => {shows.push(value);}
 });
 const session = Object.assign(Object.create(ReaderSession.prototype), {
  pane, reader: {_internalReader: {_state: {primaryViewState: {pageIndex: 0}}}}, destroyed: false,
  providerSettings: async () => ({providerId: 'openai-compatible', apiKey: 'fake-local-test-key'}),
  resolveLanguages: () => ({target: 'zh'}), explainCache: new Map()
 });
 pane.callbacks = {onDismissExplanation: () => {
  session.explanationRequest?.abort(); session.explanationRequest = null;
 }};
 try {
  const explaining = session.explainSelection('A complete source passage.');
  await started;
  assert.equal(shows.length, 1, 'loading card is visible');
  pane.dismissExplanation();
  assert.equal(signal?.aborted, true);
  resolveResult('整体翻译 — 延迟结果');
  await explaining;
  assert.equal(shows.length, 1, 'cancelled response never redraws the card');
 } finally {
  provider.complete = originalComplete;
  if (previousZotero === undefined) delete (globalThis as any).Zotero;
  else (globalThis as any).Zotero = previousZotero;
 }
});
