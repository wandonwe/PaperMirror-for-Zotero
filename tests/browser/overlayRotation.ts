import { PdfOverlay } from '../../src/reader/pdfOverlay';
import { pageQuarterTurn } from '../../src/reader/overlayGeometry';
import { buildStrictPage } from '../../src/ui/strictPageReplacement';

/** Real DOM checks for the whole-page overlay turn, independently of fitting. */
export async function checkOverlayRotation(): Promise<void> {
	const turns = [0, 90, 180, 270] as const;
	function viewport(rotation: number, scale: number) {
		const angle = pageQuarterTurn(rotation);
		return { rotation: angle, scale,
			width: (angle % 180 ? 800 : 600) * scale,
			height: (angle % 180 ? 600 : 800) * scale,
			convertToViewportPoint(x: number, y: number): [number, number] {
				return angle === 90 ? [y * scale, x * scale]
					: angle === 180 ? [(600 - x) * scale, y * scale]
						: angle === 270 ? [(800 - y) * scale, (600 - x) * scale]
							: [x * scale, (800 - y) * scale];
			} };
	}
	function box(v: ReturnType<typeof viewport>) {
		const a = v.convertToViewportPoint(70, 662), b = v.convertToViewportPoint(370, 638);
		return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
	}
	for (const intrinsic of turns) for (const scale of [0.8, 1.25]) {
		const div = document.createElement('div');
		div.style.cssText = 'position:relative;margin:0;border:0;padding:0';
		document.body.append(div);
		const page = { div, pdfPage: { rotate: intrinsic }, viewport: viewport(intrinsic, scale) };
		const viewer = { pagesRotation: 0, getPageView: () => page };
		const reader = { _internalReader: { _primaryView: { _iframeWindow: {
			document, PDFViewerApplication: { pdfViewer: viewer }
		} } } };
		const overlay = new PdfOverlay(reader);
		overlay.setPageData(0, { blocks: [], translations: new Map() });
		overlay.setPageRenderer(async (_index, host, width) => {
			const canonical = viewport(intrinsic, width / (intrinsic % 180 ? 800 : 600));
			const rectangle = box(canonical);
			if (intrinsic === 0) {
				// Exercise actual strict fitting and glyph-ink checks under the
				// transformed parent, not only an absolutely positioned test box.
				const canvas=document.createElement('canvas');canvas.width=canonical.width;canvas.height=canonical.height;
				const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
				const built=buildStrictPage(document,{pageIndex:0,
					blocks:[{id:'rotation-probe',pageIndex:0,order:0,type:'paragraph',fontSize:12,
						sourceText:'This paragraph checks visual alignment during page rotation.',lineRectsPdf:[[70,638,370,662]]}],
					translations:new Map([['rotation-probe','页面旋转后，译文仍与原文对齐。']]),
					render:{canvas,scale:canonical.scale,viewportWidth:canonical.width,viewportHeight:canonical.height,
						toViewport:canonical.convertToViewportPoint}})!;
				host.replaceChildren(built.element);
				const strict=built.element as any;
				if(strict.pmSettleStrict(true).length || strict.pmProbe()[0]?.state!=='committed')throw Error('Rotated strict text did not fit');
				built.element.querySelector<HTMLElement>('[data-pm-block]')!.dataset.rotationProbe='true';
				return 'translated';
			}
			const paper = document.createElement('div'); paper.className = 'pm-repage';
			paper.style.cssText = `position:relative;width:${canonical.width}px;height:${canonical.height}px`;
			const marker = document.createElement('div'); marker.dataset.rotationProbe = 'true';
			marker.style.cssText = `position:absolute;left:${rectangle.left}px;top:${rectangle.top}px;width:${rectangle.width}px;height:${rectangle.height}px`;
			marker.textContent = '视觉对齐'; paper.append(marker); host.replaceChildren(paper);
			return 'translated';
		});
		try {
			overlay.setEnabled(true);
			for (const additional of turns) {
				viewer.pagesRotation = additional; page.viewport = viewport(intrinsic + additional, scale);
				div.style.width = `${page.viewport.width}px`; div.style.height = `${page.viewport.height}px`;
				(overlay as any).drawPage(0);
				await Promise.resolve(); await Promise.resolve();
				const markers = div.querySelectorAll<HTMLElement>('[data-rotation-probe]');
				const marker = markers[markers.length - 1];
				if (!marker) throw Error('Missing rotated overlay');
				const actual = marker.getBoundingClientRect(), origin = div.getBoundingClientRect(), expected = box(page.viewport);
				const delta = [actual.left - origin.left - expected.left, actual.top - origin.top - expected.top,
					actual.width - expected.width, actual.height - expected.height];
				if (delta.some(d => Math.abs(d) > 0.05)) {
					throw Error(`Overlay alignment intrinsic=${intrinsic}, viewer=${additional}, scale=${scale}: ${delta}`);
				}
			}
		} finally { overlay.destroy(); div.remove(); }
	}
}
