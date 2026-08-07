import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	distributeText,
	findCutPoint,
	groupLineRects,
	initialFontSize,
	isOverlayableType,
	rectToCssBox,
	type PdfRect
} from '../../src/reader/overlayLayout';

/** Lines flowing down one column: same x, decreasing y. */
function column(x: number, topY: number, lines: number, lineHeight = 12, width = 200): PdfRect[] {
	return Array.from({ length: lines }, (_, i) => {
		const y2 = topY - i * lineHeight;
		return [x, y2 - lineHeight * 0.8, x + width, y2] as PdfRect;
	});
}

test('single-column paragraph groups into one run', () => {
	const runs = groupLineRects(column(50, 700, 5));
	assert.equal(runs.length, 1);
	assert.equal(runs[0]!.lineCount, 5);
	// union spans all five lines
	assert.ok(runs[0]!.rect[3] - runs[0]!.rect[1] > 12 * 4);
});

test('paragraph wrapping across two columns yields two runs', () => {
	const left = column(50, 200, 3); // bottom of the left column
	const right = column(320, 700, 4); // top of the right column
	const runs = groupLineRects([...left, ...right]);
	assert.equal(runs.length, 2, 'left and right column are separate boxes');
	assert.equal(runs[0]!.lineCount, 3);
	assert.equal(runs[1]!.lineCount, 4);
	// The two boxes must not overlap horizontally (no painting across the gutter)
	assert.ok(runs[0]!.rect[2] <= runs[1]!.rect[0]);
});

test('a page-column break (same x, jump upward) also splits', () => {
	const bottom = column(50, 120, 2);
	const top = column(50, 700, 2);
	const runs = groupLineRects([...bottom, ...top]);
	assert.equal(runs.length, 2);
});

test('empty or malformed input is tolerated', () => {
	assert.deepEqual(groupLineRects([]), []);
	assert.equal(groupLineRects([[NaN, 0, 1, 1] as PdfRect]).length, 0);
});

// ---- text distribution ------------------------------------------------------

test('single run receives the whole translation', () => {
	const runs = groupLineRects(column(50, 700, 3));
	assert.deepEqual(distributeText('完整的译文内容。', runs), ['完整的译文内容。']);
});

test('two runs split proportionally to their area, losing no text', () => {
	const runs = groupLineRects([...column(50, 200, 2), ...column(320, 700, 6)]);
	const text = '这是一个很长的段落,它在原文中从左栏底部延续到右栏顶部,因此译文也应当按面积比例分配到两个覆盖框中显示。';
	const parts = distributeText(text, runs);
	assert.equal(parts.length, 2);
	assert.ok(parts[0]!.length > 0 && parts[1]!.length > 0);
	// Nothing is dropped (whitespace at the split may be trimmed)
	assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
	// The larger box gets the larger share
	assert.ok(parts[1]!.length > parts[0]!.length);
});

test('untranslated block distributes to empty strings', () => {
	const runs = groupLineRects([...column(50, 200, 2), ...column(320, 700, 2)]);
	assert.deepEqual(distributeText('', runs), ['', '']);
});

test('findCutPoint never splits a Latin word', () => {
	const text = 'alpha beta gamma delta epsilon';
	const cut = findCutPoint(text, 8, 0); // inside "beta"
	assert.ok(/\s/.test(text[cut]!) || cut === text.length, 'lands on whitespace');
});

test('findCutPoint prefers a break after CJK punctuation', () => {
	const text = '第一句话。第二句话继续。';
	const cut = findCutPoint(text, 5, 0);
	assert.equal(text.slice(0, cut), '第一句话。');
});

test('findCutPoint always advances past minIndex', () => {
	assert.ok(findCutPoint('abcdefgh', 3, 2) > 2);
});

// ---- geometry & sizing ------------------------------------------------------

test('rectToCssBox normalises corners and applies padding', () => {
	const box = rectToCssBox([120, 40], [20, 90], 2);
	assert.equal(box.left, 18);
	assert.equal(box.top, 38);
	assert.equal(box.width, 104);
	assert.equal(box.height, 54);
});

test('initialFontSize scales with the space per source line and is clamped', () => {
	assert.ok(initialFontSize(60, 4) < initialFontSize(120, 4));
	assert.ok(initialFontSize(4, 10) >= 6, 'floor');
	assert.ok(initialFontSize(9999, 1) <= 28, 'ceiling');
});

test('only body text and headings are ever covered by the overlay', () => {
	assert.equal(isOverlayableType('paragraph'), true);
	assert.equal(isOverlayableType('heading'), true);
	assert.equal(isOverlayableType('title'), true);
	// Captions hug artwork, lists are often figure legends, tables and
	// unknown blocks are risky — all excluded by policy.
	assert.equal(isOverlayableType('caption'), false);
	assert.equal(isOverlayableType('list'), false);
	assert.equal(isOverlayableType('table'), false);
	assert.equal(isOverlayableType('unknown'), false);
});

// ---- fit policy (strict vs expand) ------------------------------------------

test('strict mode never changes the box height', async () => {
	const { availableHeight } = await import('../../src/reader/textFitter');
	const box = { left: 50, top: 100, width: 200, height: 40 };
	const below = { left: 50, top: 160, width: 200, height: 40 };
	assert.equal(availableHeight(box, [box, below], 800, 'strict'), 40);
});

test('expand mode grows down to the next block in the same column', async () => {
	const { availableHeight } = await import('../../src/reader/textFitter');
	const box = { left: 50, top: 100, width: 200, height: 40 };
	const below = { left: 50, top: 180, width: 200, height: 40 };
	// grows from 40 up to (180 - 3) - 100 = 77
	assert.equal(availableHeight(box, [box, below], 800, 'expand', 3), 77);
});

test('expand mode ignores blocks in the other column (no gutter crossing)', async () => {
	const { availableHeight, MAX_GROWTH_RATIO } = await import('../../src/reader/textFitter');
	const box = { left: 50, top: 100, width: 200, height: 40 };
	const otherColumn = { left: 320, top: 120, width: 200, height: 40 };
	// Nothing in its own column blocks it, so growth is limited only by the
	// growth cap — NOT by the neighbouring column, and NOT by the page bottom.
	// The cap matters: figures and tables are not in the obstacle list, so an
	// unbounded box would eventually be painted straight over one.
	assert.equal(availableHeight(box, [box, otherColumn], 800, 'expand'), 40 * MAX_GROWTH_RATIO);
	assert.ok(40 * MAX_GROWTH_RATIO < 700, 'the cap really does bite before the page bottom');
});

test('expand growth is capped even with unlimited space below', async () => {
	const { availableHeight } = await import('../../src/reader/textFitter');
	const box = { left: 50, top: 10, width: 200, height: 30 };
	assert.equal(availableHeight(box, [box], 5000, 'expand', 3, 2), 60);
});

test('expand mode is capped by the page height', async () => {
	const { availableHeight } = await import('../../src/reader/textFitter');
	const box = { left: 50, top: 760, width: 200, height: 30 };
	assert.equal(availableHeight(box, [box], 800, 'expand'), 40);
});

test('sameColumn requires real horizontal overlap', async () => {
	const { sameColumn } = await import('../../src/reader/textFitter');
	const left = { left: 50, top: 0, width: 200, height: 10 };
	const right = { left: 320, top: 0, width: 200, height: 10 };
	const shifted = { left: 90, top: 0, width: 200, height: 10 };
	assert.equal(sameColumn(left, right), false);
	assert.equal(sameColumn(left, shifted), true);
});

test('fontSizeBounds and shrinkRatio flag heavily compressed text', async () => {
	const { fontSizeBounds, shrinkRatio } = await import('../../src/reader/textFitter');
	const { min, max } = fontSizeBounds(48, 4); // 12px per line
	assert.equal(min, 4);
	assert.ok(max > 9 && max < 11);
	assert.ok(shrinkRatio(max, 48, 4) === 1);
	assert.ok(shrinkRatio(5, 48, 4) < 0.62, 'a 5px fit counts as heavy shrink');
});

test('overlaps detects box collisions', async () => {
	const { overlaps } = await import('../../src/reader/textFitter');
	const a = { left: 0, top: 0, width: 100, height: 50 };
	assert.equal(overlaps(a, { left: 50, top: 25, width: 100, height: 50 }), true);
	assert.equal(overlaps(a, { left: 0, top: 50, width: 100, height: 50 }), false);
});
