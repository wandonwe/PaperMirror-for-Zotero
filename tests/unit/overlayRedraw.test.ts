import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PdfOverlay } from '../../src/reader/pdfOverlay';

/**
 * The zoom flash-then-vanish bug was scheduleRedraw() keeping only the LAST
 * event's page (clearTimeout + a captured index), so during a zoom storm every
 * page but the last was dropped and its overlay never repainted. These tests
 * drive the private scheduler directly (drawPage stubbed) to prove requests now
 * ACCUMULATE and a document-level event redraws every page.
 */
function makeOverlay(pages: number[]): { overlay: PdfOverlay; drawn: number[] } {
	const overlay = new PdfOverlay({} as never, {});
	const anyOverlay = overlay as unknown as {
		enabled: boolean;
		pages: Map<number, unknown>;
		drawPage: (p: number) => void;
		scheduleRedraw: (p?: number) => void;
	};
	anyOverlay.enabled = true;
	anyOverlay.pages = new Map(pages.map(p => [p, { blocks: [], translations: new Map() }]));
	const drawn: number[] = [];
	anyOverlay.drawPage = (p: number) => drawn.push(p);
	return { overlay, drawn };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('scheduleRedraw ACCUMULATES per-page requests — no page is dropped', async () => {
	const { overlay, drawn } = makeOverlay([3, 4, 5]);
	const s = overlay as unknown as { scheduleRedraw: (p?: number) => void };
	// A zoom storm: three pages fire inside one debounce window.
	s.scheduleRedraw(3);
	s.scheduleRedraw(4);
	s.scheduleRedraw(5);
	assert.deepEqual(drawn, [], 'nothing drawn until the debounce fires');
	await sleep(140);
	assert.deepEqual([...drawn].sort(), [3, 4, 5], 'all three pages redrawn, not just the last');
	overlay.destroy();
});

test('a document-level event (undefined index) redraws every known page', async () => {
	const { overlay, drawn } = makeOverlay([0, 1, 2]);
	const s = overlay as unknown as { scheduleRedraw: (p?: number) => void };
	// scalechanging / rotationchanging arrive with no page number.
	s.scheduleRedraw(undefined);
	await sleep(140);
	assert.deepEqual([...drawn].sort(), [0, 1, 2], 'redrawAll covers every page');
	overlay.destroy();
});

test('a page event followed by a document event still redraws all', async () => {
	const { overlay, drawn } = makeOverlay([0, 1, 2]);
	const s = overlay as unknown as { scheduleRedraw: (p?: number) => void };
	s.scheduleRedraw(1);        // one page dirty…
	s.scheduleRedraw(undefined); // …then a zoom → escalate to all
	await sleep(140);
	assert.deepEqual([...drawn].sort(), [0, 1, 2]);
	overlay.destroy();
});
