import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { watchAutoExplainSelection } from '../../src/reader/autoExplainSelection';
import { getOriginalSelectedText, type ReaderLike } from '../../src/reader/zoteroReaderAdapter';

function fixture(t: TestContext) {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const doc = new EventTarget();
 let text = '', enabled = true, changes = 0;
 const seen: string[] = [];
 const stop = watchAutoExplainSelection({ document: doc as Document,
  readText: () => text, enabled: () => enabled,
  onChange: () => { changes++; }, onSelection: value => seen.push(value) });
 const emit = (type: string) => doc.dispatchEvent(new Event(type));
 t.after(stop);
 return { seen, stop, emit, set: (value: string) => { text = value; emit('selectionchange'); },
  disable: () => { enabled = false; }, tick: () => t.mock.timers.tick(400), changes: () => changes };
}

test('automatic analysis waits for pointer release and uses the final stable selection', t => {
 const f = fixture(t);
 f.emit('pointerdown'); f.set('first word'); f.tick();
 assert.deepEqual(f.seen, []);
 f.set('complete passage'); f.emit('pointerup'); f.tick();
 assert.deepEqual(f.seen, ['complete passage']);
 f.emit('selectionchange'); f.tick();
 assert.equal(f.seen.length, 1);
});

test('keyboard selection debounces, cancels stale text and permits a fresh reselection', t => {
 const f = fixture(t);
 f.set('old'); f.set('new'); f.tick();
 assert.deepEqual(f.seen, ['new']);
 assert.equal(f.changes(), 2);
 f.set(''); f.tick(); f.set('new'); f.tick();
 assert.deepEqual(f.seen, ['new', 'new']);
});

test('disabling the setting before dispatch and closing the reader both cancel pending work', t => {
 const f = fixture(t);
 f.set('pending'); f.disable(); f.tick();
 assert.deepEqual(f.seen, []);
 f.stop(); f.set('after close'); f.tick();
 assert.deepEqual(f.seen, []);
});

test('clearing a selection before the debounce expires sends no request', t => {
 const f = fixture(t);
 f.set('pending'); f.set(''); f.tick();
 assert.deepEqual(f.seen, []);
});

test('only native PDF text-layer selections qualify, excluding input fields and translated UI', () => {
 const native = { nodeType: 1, closest: (selector: string) => selector === '.textLayer' ? {} : null };
 const input = { nodeType: 1, closest: () => null };
 const selection = { isCollapsed: false, anchorNode: native, focusNode: native, toString: () => 'paper text' };
 const reader = { _internalReader: { _primaryView: { _iframeWindow: { document: {
  defaultView: { getSelection: () => selection }
 } } } } } as unknown as ReaderLike;
 assert.equal(getOriginalSelectedText(reader), 'paper text');
 selection.focusNode = input;
 assert.equal(getOriginalSelectedText(reader), '');
 selection.focusNode = native; selection.isCollapsed = true;
 assert.equal(getOriginalSelectedText(reader), '');
});

test('manual double-click analysis suppresses the pending automatic word selection', t => {
 const f = fixture(t);
 f.set('word from double click');
 f.stop.suppressCurrentSelection();
 f.emit('selectionchange'); f.tick();
 assert.deepEqual(f.seen, []);
 f.set('a different passage'); f.tick();
 assert.deepEqual(f.seen, ['a different passage']);
});
