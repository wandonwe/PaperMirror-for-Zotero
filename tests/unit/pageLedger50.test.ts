import test from 'node:test';
import assert from 'node:assert/strict';
import { PageLedger } from '../../src/reader/pageLedger';

type R = { element: string; unfit: string[]; token: number };

test('5.0 按页账本: views behave like the Map / Set they replace', () => {
	const ledger = new PageLedger<string, string>();
	const stats = ledger.view<number>('placementStats');
	const translated = ledger.flag('translatedPages');
	stats.set(3, 30).set(1, 10);
	translated.add(1).add(5);
	assert.equal(stats.get(3), 30);
	assert.equal(stats.size, 2);
	assert.deepEqual([...stats.keys()].sort(), [1, 3]);
	assert.deepEqual([...stats].sort(), [[1, 10], [3, 30]]);
	assert.ok(translated.has(5) && !translated.has(3));
	assert.equal(stats.delete(3), true);
	assert.equal(stats.delete(3), false);
	translated.clear();
	assert.equal(translated.size, 0);
	assert.equal(stats.get(1), 10, 'clearing one field leaves the others');
});

test('5.0 按页账本: placement reset drops every placement result for that page only', () => {
	const ledger = new PageLedger();
	for (const f of ['placementStats', 'placementProbe', 'abandonedBlocks', 'geometryAudits']) {
		ledger.view(f).set(1, 'x'); ledger.view(f).set(2, 'y');
	}
	ledger.view('renderToken').set(1, 7);
	ledger.resetPlacement(1);
	for (const f of ['placementStats', 'placementProbe', 'abandonedBlocks', 'geometryAudits']) {
		assert.equal(ledger.view(f).has(1), false, f);
		assert.equal(ledger.view(f).get(2), 'y', f);
	}
	assert.equal(ledger.view('renderToken').get(1), 7, 'render tokens survive a content change');
});

test('5.0 按页账本: one compress in flight per page; a turned-away render is handed over, not lost', () => {
	const ledger = new PageLedger<string, string>();
	const g1 = ledger.beginCompress(4);
	assert.ok(g1 > 0);
	assert.equal(ledger.beginCompress(4), 0, 'second begin while pending is refused');
	ledger.deferRender(4, { element: 'old', unfit: ['a'], token: 1 });
	ledger.deferRender(4, { element: 'new', unfit: ['b'], token: 2 });
	const d = ledger.endCompress(4, g1) as R;
	assert.equal(d.element, 'new', 'the newest turned-away render wins');
	assert.equal(ledger.isCompressPending(4), false);
	assert.equal(ledger.endCompress(4, g1), null, 'ending twice is harmless');
});

test('5.0 按页账本: the finally of round 1 no longer clears round 2 (latent bug in the old two-set version)', () => {
	const ledger = new PageLedger<string, string>();
	const g1 = ledger.beginCompress(2);
	ledger.deferRender(2, { element: 'el', unfit: [], token: 9 });
	// then-branch: result applied, release early, next round starts.
	ledger.releaseCompress(2, g1);
	const g2 = ledger.beginCompress(2);
	ledger.adoptCarried(2);
	assert.ok(g2 > g1);
	// finally of round 1 runs now: it must not touch round 2.
	const fromRound1 = ledger.endCompress(2, g1) ?? ledger.takeCarried(2);
	assert.equal(fromRound1, null, 'the turned-away render went to round 2');
	assert.equal(ledger.isCompressPending(2), true, 'round 2 is still in flight');
	assert.equal(ledger.beginCompress(2), 0, 'no concurrent third compress');
	const fromRound2 = ledger.endCompress(2, g2) as R;
	assert.equal(fromRound2.token, 9, 'round 2 hands the turned-away render back when it ends');
});

test('5.0 按页账本: with no next round, the early-released round still hands its deferred render back', () => {
	const ledger = new PageLedger<string, string>();
	const g = ledger.beginCompress(1);
	ledger.deferRender(1, { element: 'el', unfit: [], token: 3 });
	ledger.releaseCompress(1, g);
	const d = (ledger.endCompress(1, g) ?? ledger.takeCarried(1)) as R;
	assert.equal(d.token, 3);
});

test('5.0 按页账本: reset and dispose release everything', () => {
	const ledger = new PageLedger<string, string>();
	const g = ledger.beginCompress(1);
	ledger.deferRender(1, { element: 'el', unfit: [], token: 1 });
	ledger.resetCompress(1);
	assert.equal(ledger.isCompressPending(1), false);
	assert.equal(ledger.endCompress(1, g), null, 'an old finally after a reset does nothing');
	ledger.view('renderToken').set(1, 5);
	ledger.flag('exportPins').add(1);
	ledger.dispose();
	assert.equal(ledger.view('renderToken').size, 0);
	assert.equal(ledger.flag('exportPins').size, 0);
});
