type Rect = [number, number, number, number];

/** Dotted section rules are sometimes emitted by PDF.js as ordinary text.
 * Require a long, independent, wide dot row: inline ellipses and missing-value
 * dash rows carry content and must not be discarded. The original page keeps
 * the drawing; only translation text excludes it. */
export function isDecorativeTextRule(text: string, rect: Rect, fontSize: number): boolean {
	return /^[.·…]{12,}$/.test(text.replace(/\s/g, ''))
		&& rect[2] - rect[0] >= Math.max(1, fontSize) * 8;
}
