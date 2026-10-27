import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPagePoint, overlayGeometry, pageQuarterTurn } from '../../src/reader/overlayGeometry';
import { getPageIntrinsicRotation, getPageRender, getPageView } from '../../src/reader/zoteroReaderAdapter';
import { PdfOverlay } from '../../src/reader/pdfOverlay';
import { ReaderSession } from '../../src/reader/readerSession';
import { uprightVerticalBounds, verticalInkFits } from '../../src/ui/textInkBounds';

const turns = [0, 90, 180, 270] as const;

function viewport(rotation: number, scale = 1): any {
	const angle = pageQuarterTurn(rotation);
	return {
		rotation: angle, scale,
		width: (angle % 180 ? 800 : 600) * scale,
		height: (angle % 180 ? 600 : 800) * scale,
		convertToViewportPoint(x: number, y: number) {
			return angle === 90 ? [y * scale, x * scale]
				: angle === 180 ? [(600 - x) * scale, y * scale]
					: angle === 270 ? [(800 - y) * scale, (600 - x) * scale]
						: [x * scale, (800 - y) * scale];
		}
	};
}

/** Small DOM adapter: the production renderer/scheduler still execute. */
function harness(intrinsic = 0, additional = 0) {
	const frames: (() => void)[] = [];
	const events = new Map<string, Function>();
	const copies: any[][] = [];
	const transforms: number[][] = [];
	const doc: any = { defaultView: { requestAnimationFrame: (fn: () => void) => { frames.push(fn); } },
		addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };
	const element = (tag = 'div'): any => {
		const node: any = {
			tag, ownerDocument: doc, className: '', style: { setProperty() {} }, children: [], parent: null,
			attributes: new Map<string, string>(),
			setAttribute(key: string, value: string) { node.attributes.set(key, value); },
			removeAttribute(key: string) { node.attributes.delete(key); },
			appendChild(child: any) { child.parent = node; node.children.push(child); return child; },
			replaceChildren(...children: any[]) { for (const child of node.children) child.parent = null; node.children = []; children.forEach(child => node.appendChild(child)); },
			remove() { if (node.parent) node.parent.children = node.parent.children.filter((child: any) => child !== node); node.parent = null; },
			getBoundingClientRect() { return { height: node.clientHeight }; },
			querySelectorAll(selector: string) {
				const found: any[] = [];
				const scan = (parent: any) => { for (const child of parent.children) {
					if (selector === 'canvas' ? child.tag === 'canvas' : selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) found.push(child);
					scan(child);
				} };
				scan(node); return found;
			},
			querySelector(selector: string) { return node.querySelectorAll(selector)[0] ?? null; },
			getContext() { return { setTransform: (...args: number[]) => transforms.push(args),
				drawImage: (...args: any[]) => copies.push(args), getImageData: () => ({ data: [255, 255, 255, 255] }) }; }
		};
		Object.defineProperties(node, {
			clientWidth: { get: () => parseFloat(node.style.width) || 0 },
			clientHeight: { get: () => parseFloat(node.style.height) || 0 },
			isConnected: { get: () => node === doc.body || !!node.parent?.isConnected }
		});
		return node;
	};
	doc.createElement = element; doc.createElementNS = (_ns: string, tag: string) => element(tag);
	doc.body = element(); doc.head = element();
	const div = element(); doc.body.appendChild(div);
	const page: any = { div, pdfPage: { rotate: intrinsic }, viewport: viewport(intrinsic + additional) };
	const viewer: any = { pagesRotation: additional, getPageView: () => page };
	const nativeCanvas = element('canvas'); div.appendChild(nativeCanvas);
	let rasters = 0;
	const pdfPage = { getViewport: ({ scale }: { scale: number }) => viewport(page.pdfPage.rotate, scale),
		render: () => { rasters++; return { promise: { then: (resolve: () => void) => resolve() } }; } };
	const reader = { _internalReader: { _primaryView: { _iframeWindow: { document: doc,
		PDFViewerApplication: { pdfViewer: viewer, pdfDocument: { getPage: () => ({ then: (resolve: (p: any) => void) => resolve(pdfPage) }) },
			eventBus: { on: (name: string, fn: Function) => events.set(name, fn), off: (name: string) => events.delete(name) } } } } } };
	const turn = (angle: number) => {
		viewer.pagesRotation = angle; page.viewport = viewport(page.pdfPage.rotate + angle);
		div.style.width = `${page.viewport.width}px`; div.style.height = `${page.viewport.height}px`;
		nativeCanvas.width = page.viewport.width * 2; nativeCanvas.height = page.viewport.height * 2;
	};
	turn(additional);
	const overlay: any = new PdfOverlay(reader);
	overlay.enabled = true; overlay.pages.set(0, { blocks: [], translations: new Map() });
	return { doc, div, page, viewer, reader, overlay, turn, frames, events, copies, transforms, rasters: () => rasters };
}

test('whole-page turns preserve canonical size and invert live viewport points', () => {
	for (const turn of turns) {
		const sideways = turn % 180 !== 0;
		const w = sideways ? 800.5 : 600.25, h = sideways ? 600.25 : 800.5;
		const geometry = overlayGeometry(w, h, turn);
		assert.equal(geometry.width, 600.25); assert.equal(geometry.height, 800.5);
		for (const [x, y] of [[0, 0], [80.25, 120.5], [600.25, 800.5]]) {
			const live = turn === 90 ? [w - y!, x!] : turn === 180 ? [w - x!, h - y!]
				: turn === 270 ? [y!, h - x!] : [x!, y!];
			assert.deepEqual(canonicalPagePoint(live[0]!, live[1]!, w, h, turn), [x, y]);
		}
	}
	assert.notEqual(overlayGeometry(600, 800, 0).signature, overlayGeometry(600, 800, 180).signature);
	assert.notEqual(overlayGeometry(600.2, 800, 0).signature, overlayGeometry(600.4, 800, 0).signature);
	assert.equal(pageQuarterTurn(-90), 270); assert.equal(pageQuarterTurn(450), 90);
	assert.equal(pageQuarterTurn(NaN), 0); assert.equal(pageQuarterTurn(45), 0);
});

test('glyph ink is checked along its original vertical axis under every viewer turn', () => {
	const clip = {left:100,right:160,top:200,bottom:240};
	for (const rotation of turns) {
		const height = rotation % 180 ? clip.right-clip.left : clip.bottom-clip.top;
		const inward = rotation === 90 ? {...clip,right:159,left:101}
			: rotation === 180 ? {...clip,top:201,bottom:239}
				: rotation === 270 ? {...clip,left:101,right:159} : {...clip,top:201,bottom:239};
		const overflow = rotation === 90 ? {...clip,right:161}
			: rotation === 180 ? {...clip,bottom:241}
				: rotation === 270 ? {...clip,left:99} : {...clip,top:199};
		assert.equal(verticalInkFits(uprightVerticalBounds(inward,clip,rotation),{top:0,bottom:height}),true);
		assert.equal(verticalInkFits(uprightVerticalBounds(overflow,clip,rotation),{top:0,bottom:height}),false);
	}
});

for (const intrinsic of turns) for (const additional of turns) {
	test(`live-canvas fallback removes viewer turn ${additional} and preserves PDF intrinsic turn ${intrinsic}`, () => {
		const h = harness(intrinsic, additional);
		try {
			const view = getPageView(h.reader, 0)!;
			assert.equal(view.rotation, additional); assert.equal(getPageIntrinsicRotation(h.reader, 0), intrinsic);
			const fallback = getPageRender(h.reader, 0)!;
			const canonical = viewport(intrinsic);
			assert.equal(fallback.viewportWidth, canonical.width); assert.equal(fallback.viewportHeight, canonical.height);
			assert.equal(fallback.canvas.width, canonical.width * 2); assert.equal(fallback.canvas.height, canonical.height * 2);
			assert.deepEqual(fallback.toViewport(70, 650), canonical.convertToViewportPoint(70, 650));
			assert.equal(h.transforms.length, additional ? 1 : 0);
		} finally { h.overlay.destroy(); }
	});
}

const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };

test('overlay redraws a 180-degree turn with unchanged dimensions and leaves scrolling inert', async () => {
	const h = harness(); let draws = 0;
	h.overlay.renderer = async () => { draws++; return 'translated'; };
	try {
		h.overlay.drawPage(0); await microtasks();
		h.overlay.drawPage(0); await microtasks(); assert.equal(draws, 1);
		h.turn(180); h.overlay.drawPage(0); await microtasks(); assert.equal(draws, 2);
		const layers = h.div.querySelectorAll('.pm-overlay-layer');
		assert.equal(layers.at(-1).style.transform, 'matrix(-1,0,0,-1,600,800)');
	} finally { h.overlay.destroy(); }
});

test('overlay uses unrounded PDF viewport dimensions at fractional zoom', async () => {
	const h=harness();let width=0;
	h.page.viewport=viewport(0,1.001);h.div.style.width='601px';h.div.style.height='801px';
	h.overlay.renderer=async(_p:number,_slot:any,w:number)=>{width=w;return 'translated';};
	try {
		h.overlay.drawPage(0);await microtasks();assert.equal(width,h.page.viewport.width);
		assert.notEqual(width,h.div.clientWidth);
	} finally {h.overlay.destroy();}
});

test('a rotation during an async overlay render discards the stale layer', async () => {
	const h = harness(); let finish!: (result: string) => void;
	h.overlay.renderer = () => new Promise(resolve => { finish = resolve; });
	try {
		h.overlay.drawPage(0); const old = h.div.querySelector('.pm-overlay-layer');
		h.turn(90); finish('translated'); await microtasks();
		assert.equal(old.isConnected, false); assert.equal(h.overlay.drawnSignature.has(0), false);
	} finally { h.overlay.destroy(); }
});

test('releasing a page cancels its render and releases pending geometry references', async () => {
	const h=harness();let finish!:(result:string)=>void;
	h.overlay.renderer=()=>new Promise(resolve=>{finish=resolve;});
	try {
		h.overlay.drawPage(0);h.overlay.clearPage(0);finish('translated');await microtasks();
		assert.equal(h.overlay.inFlight.size,0);assert.equal(h.overlay.inFlightGeometry.size,0);
		assert.equal(h.div.querySelector('.pm-overlay-layer'),null);
	} finally {h.overlay.destroy();}
});

test('geometry events abort stale fitting before its next asynchronous commit', async () => {
	const h = harness(); let finish!: (result: string) => void; let signal!: AbortSignal;
	h.overlay.renderer = (_p: number, _slot: any, _width: number, s: AbortSignal) => {
		signal = s; return new Promise(resolve => { finish = resolve; });
	};
	try {
		h.overlay.subscribe(); h.overlay.drawPage(0);
		h.turn(180); h.events.get('rotationchanging')!({});
		assert.equal(signal.aborted, true); finish('translated'); await microtasks();
		assert.equal(h.div.querySelector('.pm-overlay-layer'), null);
	} finally { h.overlay.destroy(); }
});

test('old animation-frame cleanup never removes a newer in-flight overlay', async () => {
	const h = harness(); let finish!: (result: string) => void;
	h.overlay.renderer = async () => 'translated';
	try {
		h.overlay.drawPage(0); await microtasks(); h.frames.shift()!();
		h.turn(90); h.overlay.renderer = () => new Promise(resolve => { finish = resolve; });
		h.overlay.drawPage(0); const newest = h.div.querySelectorAll('.pm-overlay-layer').at(-1);
		h.frames.shift()!(); assert.equal(newest.isConnected, true);
		finish('translated'); await microtasks();
	} finally { h.overlay.destroy(); }
});

test('canonical bitmap cache separates fractional widths and intrinsic turns while reusing viewer turns', async () => {
	const h = harness();
	const slot = h.doc.createElement('div');
	const session: any = Object.assign(Object.create(ReaderSession.prototype), { reader: h.reader, destroyed: false,
		renderToken: new Map(), baseBitmaps: new Map() });
	try {
		await session.renderDocPage(0, slot, 600.2); await session.renderDocPage(0, slot, 600.4);
		assert.equal(h.rasters(), 2);
		h.turn(180); await session.renderDocPage(0, slot, 600.2); assert.equal(h.rasters(), 2);
		h.page.pdfPage.rotate = 90; h.turn(0); await session.renderDocPage(0, slot, 600.2); assert.equal(h.rasters(), 3);
	} finally { h.overlay.destroy(); }
});
