import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(resolve('scripts/zotero/ink-clip-check.js'), 'utf8');

function harness(options: { originalShell?: boolean; clipping?: boolean; drift?: boolean; moving?: boolean; missing?: boolean; throwCapture?: boolean; extentChanges?: boolean; moveWhenOpen?: boolean } = {}) {
 let preference = false, reads = 0, rectReads = 0, fontsReady = false, closes = 0;
 const style = { visibility: 'visible', overflow: 'hidden', fontSize: '12px', fontFamily: 'test', fontStyle: 'normal', fontWeight: '400', lineHeight: '14px', display: 'block', transform: 'none', paddingTop: '0px', paddingBottom: '0px' };
 const node = { style, textContent: 'Test paragraph', parentElement: null, scrollTop: 0, scrollLeft: 0, clientHeight: 30, clientWidth: 100,
  get scrollHeight() { return options.extentChanges && style.overflow === 'visible' ? 29 : 30; },
  get scrollWidth() { return options.extentChanges && style.overflow === 'visible' ? 99 : 100; },
  getBoundingClientRect: () => ({ left: 10, top: 10 + (options.moving ? ++rectReads : 0) + (options.moveWhenOpen && style.overflow === 'visible' ? 1 : 0), width: 100, height: 30, bottom: 40 }),
  querySelectorAll: () => [], getAttribute: () => 'page-0-region-0', scrollIntoView: () => {} };
 const page = { querySelectorAll: () => [node] };
 const ctx = { setTransform: () => {}, drawWindow: () => { if (options.throwCapture) throw new Error('capture failed'); },
  getImageData: () => {
   const capture = reads++ % 3;
   const dark = (options.clipping && capture === 1) || (options.drift && capture === 2);
   return { data: Uint8ClampedArray.from([dark ? 0 : 255, dark ? 0 : 255, dark ? 0 : 255, 255]) };
  } };
 const doc = { createElementNS: () => ({ getContext: () => ctx, width: 0, height: 0 }), fonts: { ready: Promise.resolve().then(() => { fontsReady = true; }) } };
 const win = { document: doc, devicePixelRatio: 2, innerHeight: 800, setTimeout: (callback: () => void) => callback(), getComputedStyle: () => style,
  Zotero_Tabs: { close: () => { closes++; } } };
 const Zotero = { getMainWindow: () => win, version: '10.test', PaperMirror: { version: '4.test', setMode: async () => {} },
  File: { putContentsAsync: async () => {} }, Prefs: { get: () => preference, set: (_name: string, value: boolean) => { preference = value; } },
  Reader: { open: async () => {
   assert.equal(preference, true, 'local-only mode must precede opening readers');
   return { tabID: 1, _initPromise: Promise.resolve(), navigate: () => {}, _tabContainer: { querySelector: (selector: string) => options.originalShell ? (selector.includes('data-pm-original') ? {} : null) : options.missing ? null : page } };
  } } };
 const run = runInNewContext(source, { Zotero });
 return { run: () => run({ items: [{ label: 'fixture', attachmentID: 1, pages: 1 }] }),
  invoke: run, state: () => ({ preference, fontsReady, closes, overflow: style.overflow }) };
}

test('Zotero clip audit retains all zero measurements and verifies restoration', async () => {
 const h = harness(), result = await h.run();
 assert.equal(result.auditPass, true);
 assert.equal(result.totals.committed, 1);
 assert.equal(result.items[0].pages[0].measurements.length, 1);
 assert.deepEqual(Array.from(result.items[0].pages[0].measurements[0].perPhase), [0, 0, 0, 0]);
 assert.deepEqual(h.state(), { preference: false, fontsReady: true, closes: 1, overflow: 'hidden' });
});

test('Zotero clip audit retains every phase of reproducible clipping', async () => {
 const result = await harness({ clipping: true }).run();
 assert.equal(result.auditPass, false);
 assert.equal(result.totals.clippedBlocks, 1);
 assert.equal(result.totals.noisyBlocks, 0);
 assert.deepEqual(Array.from(result.items[0].pages[0].measurements[0].perPhase), [1, 1, 1, 1]);
});

test('Zotero clip audit exposes closed-image drift without suppressing nonzero readings', async () => {
 const result = await harness({ drift: true }).run();
 assert.equal(result.auditPass, false);
 assert.equal(result.totals.noisyBlocks, 1);
 assert.equal(result.totals.clippedBlocks, 1, 'noise must not silently erase a nonzero raw reading');
 const phase = result.items[0].pages[0].measurements[0].phaseEvidence[0];
 assert.equal(phase.beforePixels, 0);
 assert.equal(phase.afterPixels, 1);
 assert.equal(phase.closedDriftPixels, 1);
});

test('missing or continuously moving pages cannot report a passing zero-clipping audit', async () => {
 for (const options of [{ missing: true }, { moving: true }]) {
  const h = harness(options), result = await h.run();
  assert.equal(result.auditPass, false);
  assert.equal(result.totals.unverifiedPages, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(h.state().preference, false);
 }
});

test('capture errors restore overflow and local-only preference and fail the audit', async () => {
 const h = harness({ throwCapture: true }), result = await h.run();
 assert.equal(result.auditPass, false);
 assert.equal(result.errors.length, 1);
 assert.equal(h.state().overflow, 'hidden');
 assert.equal(h.state().preference, false);
});

test('clip audit rejects weakened thresholds and empty phase coverage', async () => {
 const h = harness();
 await assert.rejects(h.invoke({ threshold: 65 }), /must not exceed/);
 await assert.rejects(h.invoke({ phases: [] }), /nonempty/);
});


test('reversible Gecko scroll extent accounting remains recorded without inventing geometry drift', async () => {
 const result = await harness({ extentChanges: true }).run();
 assert.equal(result.auditPass, true);
 assert.equal(result.totals.noisyBlocks, 0);
 const phase = result.items[0].pages[0].measurements[0].phaseEvidence[0];
 assert.equal(phase.rawGeometryStable, false);
 assert.equal(phase.geometryStable, true);
 assert.equal(phase.geometryRestored, true);
 assert.equal(phase.scrollExtentChanged, true);
 assert.equal(phase.scrollExtents.closed[0].scrollHeight, 30);
 assert.equal(phase.scrollExtents.open[0].scrollHeight, 29);
 assert.equal(phase.scrollExtents.restored[0].scrollHeight, 30);
});

test('a painted position change during opening remains noisy even if the closed position returns', async () => {
 const result = await harness({ moveWhenOpen: true }).run();
 assert.equal(result.auditPass, false);
 assert.equal(result.totals.noisyBlocks, 1);
 const phase = result.items[0].pages[0].measurements[0].phaseEvidence[0];
 assert.equal(phase.geometryRestored, true);
 assert.equal(phase.geometryStable, false);
 assert.equal(phase.geometryStates.closed[0].rect.top, 10);
 assert.equal(phase.geometryStates.open[0].rect.top, 11);
});

test('real clipping is never suppressed by a reversible scroll extent change', async () => {
 const result = await harness({ clipping: true, extentChanges: true }).run();
 assert.equal(result.auditPass, false);
 assert.equal(result.totals.clippedBlocks, 1);
 assert.equal(result.totals.noisyBlocks, 0);
 assert.deepEqual(Array.from(result.items[0].pages[0].measurements[0].perPhase), [1, 1, 1, 1]);
});

test('a page left as its original bitmap is reported separately, not as missing', async () => {
 const result = await harness({ originalShell: true }).run();
 const page = result.items[0].pages[0];
 assert.equal(page.found, true); assert.equal(page.settled, true); assert.equal(page.original, true);
 assert.deepEqual(Array.from(page.blocks), []);
 assert.equal(result.totals.originalPages, 1); assert.equal(result.totals.unverifiedPages, 0);
 assert.deepEqual(Array.from(result.errors), []);
});
