/**
 * Real image boundaries from the PDF.js operator list.
 *
 * The luminance-grid obstacle map GUESSES where figures are, and light-coloured
 * plots slip through it. The operator list doesn't guess: every image the page
 * paints appears as a paint op whose current transform maps the unit square to
 * the image's exact rectangle in PDF user space. This module walks the ops,
 * tracks the graphics-state matrix (save/restore/transform), and returns those
 * rectangles. The grid stays as the fallback when the operator list is
 * unavailable (imageRectsFromOperatorList never throws — it returns []).
 *
 * Pure math over plain arrays — unit-testable without PDF.js.
 */

export type PdfRect = [number, number, number, number]; // x1, y1, x2, y2 (user space)

type Matrix = [number, number, number, number, number, number];

/** pdf.js OPS values (stable across releases; overridable via `ops`). */
export const DEFAULT_OPS = {
	save: 10,
	restore: 11,
	transform: 12,
	paintJpegXObject: 82,
	paintImageMaskXObject: 83,
	paintImageXObject: 85,
	paintInlineImageXObject: 86,
	paintImageXObjectRepeat: 88
};

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		n[0] * m[0] + n[1] * m[2],
		n[0] * m[1] + n[1] * m[3],
		n[2] * m[0] + n[3] * m[2],
		n[2] * m[1] + n[3] * m[3],
		n[4] * m[0] + n[5] * m[2] + m[4],
		n[4] * m[1] + n[5] * m[3] + m[5]
	];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Walk an operator list and return the rectangle every painted image covers.
 * Rectangles smaller than `minSizePt` in both dimensions are dropped (inline
 * bullets, tiny logos — not layout obstacles).
 */
export function imageRectsFromOperatorList(
	fnArray: ArrayLike<number>,
	argsArray: ArrayLike<unknown>,
	ops: Partial<typeof DEFAULT_OPS> = {},
	minSizePt = 12,
 ignoredPaintIndices: ReadonlySet<number> = new Set()
): PdfRect[] {
	const OP = { ...DEFAULT_OPS, ...ops };
	const paintOps = new Set([
		OP.paintJpegXObject,
		OP.paintImageMaskXObject,
		OP.paintImageXObject,
		OP.paintInlineImageXObject,
		OP.paintImageXObjectRepeat
	]);
	const rects: PdfRect[] = [];
	try {
		let ctm: Matrix = IDENTITY;
		const stack: Matrix[] = [];
		for (let i = 0; i < fnArray.length; i++) {
			const fn = fnArray[i]!;
			if (fn === OP.save) {
				stack.push(ctm);
			}
			else if (fn === OP.restore) {
				ctm = stack.pop() ?? IDENTITY;
			}
			else if (fn === OP.transform) {
				const args = argsArray[i] as number[] | undefined;
				if (args && args.length >= 6) {
					ctm = multiply(ctm, args.slice(0, 6) as Matrix);
				}
			}
			else if (paintOps.has(fn) && !ignoredPaintIndices.has(i)) {
				// An image paints the unit square through the current matrix.
				const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
				const xs = corners.map(c => c[0]);
				const ys = corners.map(c => c[1]);
				const rect: PdfRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
				if (rect[2] - rect[0] >= minSizePt || rect[3] - rect[1] >= minSizePt) {
					rects.push(rect);
				}
			}
		}
	}
	catch {
		return [];
	}
	return rects;
}

/** Conservative photometric test for a repeated, behind-text page decoration.
 * It never relaxes protection for unique figures, foreground images or dark plots. */
export function isFaintPageBackground(data:ArrayLike<number>,channels:3|4,rect:PdfRect,repeated:boolean,beforeText:boolean):boolean {
 if(!repeated||!beforeText||rect[2]-rect[0]<100||rect[3]-rect[1]<60||data.length<300)return false;
 let total=0,dark=0,colour=0,white=0,ink=0;
 const pixels=Math.floor(data.length/channels),step=Math.max(1,Math.floor(pixels/50000));
 for(let i=0;i<pixels;i+=step){const k=i*channels,a=channels===4?data[k+3]!/255:1;
  const rgb=[0,1,2].map(j=>255+(data[k+j]!-255)*a),low=Math.min(...rgb),high=Math.max(...rgb);
  total++;if(low<170)dark++;if(high-low>15)colour++;if(low>245)white++;if(low<240)ink++;
 }
 return total>0&&dark/total<.005&&colour/total<.005&&white/total>.7&&ink/total>.01&&ink/total<.25;
}
