import test from 'node:test';
import assert from 'node:assert/strict';
import { flowText } from '../../src/ui/layoutSafety';
import { maxInkBleed, tryInkBleed, inkBleedOf, type TextInkGuard, type InkFailure } from '../../src/ui/textInkBounds';

// 联网校验 3278 p10: the first flow piece is one line tall; a descender (g, p,
// comma) made every longer prefix fail, so the binary search stopped at
// "10. Zhan" and the next line started with "g X".
test('flow pieces never end inside a Latin word when a break exists', () => {
	const text = '10. Zhang X, Zhang G, Xu L 等 (2022) 利用双层能谱CT';
	// Non-monotonic fit: anything containing the "g" of Zhang is "too tall".
	const parts = flowText(text, [1, 2], (t, r) => r === 2 || !t.includes('g'));
	assert.ok(parts);
	assert.equal(parts.join(''), text);
	assert.equal(parts[0], '10. ');
	assert.ok(parts[1]!.startsWith('Zhang'));
});

test('an unbreakable token keeps the measured cut', () => {
	const text = 'https://doi.org/10.1186/s13244';
	const parts = flowText(text, [1, 2], (t, r) => r === 2 || t.length <= 10);
	assert.ok(parts);
	assert.equal(parts.join(''), text);
	// "https://do" may end at the "/" break; never inside "doi" when "/" exists.
	assert.equal(parts[0], 'https://');
});

test('CJK text still splits anywhere', () => {
	const text = '利用双层能谱CT获取的虚拟非增强图像';
	const parts = flowText(text, [1, 2], (t, r) => r === 2 || Array.from(t).length <= 5);
	assert.equal(parts?.[0], '利用双层能');
});

class FakeNode {
	attrs = new Map<string, string>();
	style: Record<string, string> & { setProperty(k: string, v: string): void; removeProperty(k: string): void } = Object.assign(Object.create(null), {
		overflow: 'hidden',
		setProperty(this: Record<string, string>, k: string, v: string) { this[k] = v; },
		removeProperty(this: Record<string, string>, k: string) { delete this[k]; }
	});
	getAttribute(k: string) { return this.attrs.get(k) ?? null; }
	setAttribute(k: string, v: string) { this.attrs.set(k, v); }
	removeAttribute(k: string) { this.attrs.delete(k); }
	hasAttribute(k: string) { return this.attrs.has(k); }
}

/** A guard whose glyphs need `need` px below the box. */
function guardNeeding(need: number, extra: Partial<InkFailure> = {}): TextInkGuard {
	const failures = new WeakMap<object, InkFailure>();
	const g = ((node: HTMLElement) => {
		const over = need - inkBleedOf(node);
		if (over <= 0) { failures.delete(node); return true; }
		failures.set(node, { offset: 0, topOverflow: 0, bottomOverflow: over, rectTop: 0, rectBottom: 0, clipHeight: 10, font: '', metricsAvailable: true, ...extra });
		return false;
	}) as TextInkGuard;
	return Object.assign(g, { failure: (n: HTMLElement) => failures.get(n) });
}

test('a descender 1.5px below the box is painted through a bounded bleed', () => {
	const node = new FakeNode() as unknown as HTMLElement;
	const guard = guardNeeding(1.5);
	assert.equal(guard(node), false);
	assert.equal(tryInkBleed(node, guard, 14.73, () => true), true);
	assert.ok(inkBleedOf(node) >= 1.5 && inkBleedOf(node) <= maxInkBleed(14.73));
	assert.equal(node.style.overflow, 'clip');
	assert.match(String((node.style as unknown as Record<string, string>)['overflow-clip-margin']), /px$/);
});

test('the bleed is refused when the strip below is not blank, and rolled back', () => {
	const node = new FakeNode() as unknown as HTMLElement;
	const guard = guardNeeding(1.5);
	guard(node);
	assert.equal(tryInkBleed(node, guard, 14.73, () => false), false);
	assert.equal(inkBleedOf(node), 0);
	assert.equal(node.style.overflow, 'hidden');
});

test('no bleed beyond a fifth of an em, and never for top or side overflow', () => {
	const small = new FakeNode() as unknown as HTMLElement;
	const deep = guardNeeding(3.2);
	deep(small);
	assert.equal(tryInkBleed(small, deep, 14.73, () => true), false, '3.2px > 2.95px cap');
	assert.equal(inkBleedOf(small), 0);
	const top = new FakeNode() as unknown as HTMLElement;
	const topGuard = guardNeeding(1, { topOverflow: 1 });
	topGuard(top);
	assert.equal(tryInkBleed(top, topGuard, 14.73, () => true), false);
	const side = new FakeNode() as unknown as HTMLElement;
	const sideGuard = guardNeeding(1, { rightOverflow: 0.5 });
	sideGuard(side);
	assert.equal(tryInkBleed(side, sideGuard, 14.73, () => true), false);
	assert.equal(maxInkBleed(30), 3);
});

test('the last flow piece opens its block clip too', () => {
	const piece = new FakeNode() as unknown as HTMLElement;
	const block = new FakeNode() as unknown as HTMLElement;
	const guard = guardNeeding(1);
	guard(piece);
	assert.equal(tryInkBleed(piece, guard, 14.73, () => true, [block]), true);
	assert.ok(inkBleedOf(block) >= inkBleedOf(piece));
});
