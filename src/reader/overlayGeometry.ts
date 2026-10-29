/** A viewer turn is applied to the whole canonical page, after text fitting. */
export type PageQuarterTurn = 0 | 90 | 180 | 270;

export function pageQuarterTurn(value: unknown): PageQuarterTurn {
	const angle = typeof value === 'number' ? value : NaN;
	if (!Number.isFinite(angle) || angle % 90 !== 0) return 0;
	return ((angle % 360 + 360) % 360) as PageQuarterTurn;
}

export interface OverlayGeometry {
	/** Size expected by the canonical (intrinsic PDF orientation) renderer. */
	width: number;
	height: number;
	/** CSS transform from canonical page pixels to the live viewer page. */
	transform: string;
	signature: string;
}

/** Inverse of the whole-page viewer turn, also used by live-canvas fallback. */
export function canonicalPagePoint(x: number, y: number, width: number, height: number, rotation: PageQuarterTurn): [number, number] {
	return rotation === 90 ? [y, width - x]
		: rotation === 180 ? [width - x, height - y]
			: rotation === 270 ? [height - y, x] : [x, y];
}

export function overlayGeometry(
	viewerWidth: number,
	viewerHeight: number,
	rotation: PageQuarterTurn,
	viewportKey = ''
): OverlayGeometry {
	const sideways = rotation === 90 || rotation === 270;
	const width = sideways ? viewerHeight : viewerWidth;
	const height = sideways ? viewerWidth : viewerHeight;
	const transform = rotation === 90 ? `matrix(0,1,-1,0,${viewerWidth},0)`
		: rotation === 180 ? `matrix(-1,0,0,-1,${viewerWidth},${viewerHeight})`
			: rotation === 270 ? `matrix(0,-1,1,0,0,${viewerHeight})` : 'none';
	return {
		width, height, transform,
		// Fractional zoom changes and a 180-degree turn both matter even when
		// rounded page dimensions are unchanged.
		signature: `${viewerWidth}x${viewerHeight}@${rotation}/${viewportKey}`
	};
}
