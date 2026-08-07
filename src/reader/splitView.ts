/**
 * Split-view DOM management.
 *
 * IMPORTANT: the reader's XUL <browser> element is NEVER reparented — moving
 * a <browser> in the DOM destroys its frameloader and reloads/blanks the
 * reader. Instead, the tab container (<tab-content>) itself is switched to a
 * horizontal flex layout and the divider + translation pane are inserted as
 * SIBLINGS after the browser. destroy() restores every inline style and
 * removes only our own nodes (spec 4.1 / §6 cleanup requirements).
 */

import * as logger from '../utils/logger';
import { getPref, setPref } from '../utils/prefs';
import paneCSS from '../ui/styles/translationPane.css';

const MODULE = 'splitView';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const STYLE_ID = 'pm-bilingual-style';

export interface SplitViewHandles {
	paneHost: HTMLElement;
	divider: HTMLElement;
	destroy(): void;
	setRatio(percent: number): void;
	setSide(side: 'left' | 'right'): void;
	/**
	 * Show/hide the translation pane without unmounting it. Used by the
	 * toolbar's 原文 | 覆盖翻译 | 左右对照 switcher so switching to overlay-only
	 * mode keeps the session (and its translations) alive.
	 */
	setPaneVisible(visible: boolean): void;
	isPaneVisible(): boolean;
}

export function ensureStyleInjected(doc: Document): void {
	if (doc.getElementById(STYLE_ID)) {
		return;
	}
	const style = doc.createElementNS(HTML_NS, 'style') as HTMLStyleElement;
	style.id = STYLE_ID;
	style.textContent = paneCSS;
	(doc.documentElement ?? doc).appendChild(style);
}

export function removeInjectedStyle(doc: Document): void {
	doc.getElementById(STYLE_ID)?.remove();
}

/**
 * Layout via CSS `order` so side-swap never moves the browser node:
 *   right pane (default): browser(0) divider(1) pane(2)
 *   left pane:            pane(0)  divider(1) browser(2)
 */
export function createSplitView(container: Element, readerBrowser: Element): SplitViewHandles {
	const doc = container.ownerDocument!;
	ensureStyleInjected(doc);

	const containerEl = container as HTMLElement;
	const browserEl = readerBrowser as HTMLElement;
	const savedContainerStyle = containerEl.getAttribute('style') ?? '';
	const savedBrowserStyle = browserEl.getAttribute('style') ?? '';

	// Horizontal flex on the tab container; the browser stays where it is.
	containerEl.style.setProperty('display', 'flex', 'important');
	containerEl.style.setProperty('flex-direction', 'row', 'important');
	containerEl.style.setProperty('align-items', 'stretch', 'important');

	const divider = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	divider.className = 'pm-bilingual-divider';
	divider.style.order = '1';

	const paneHost = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	paneHost.className = 'pm-bilingual-pane';

	// Insert AFTER the browser (never move the browser itself).
	browserEl.after(divider, paneHost);

	const applySide = (side: 'left' | 'right'): void => {
		if (side === 'left') {
			paneHost.style.order = '0';
			browserEl.style.setProperty('order', '2', 'important');
		}
		else {
			paneHost.style.order = '2';
			browserEl.style.setProperty('order', '0', 'important');
		}
	};
	// 对照翻译 always opens 原文左、译文右. A stored 'left' from an old swap
	// is healed rather than honoured — the swap button still works live.
	if (getPref<string>('paneSide', 'right') !== 'right') {
		setPref('paneSide', 'right');
	}
	applySide('right');

	let paneVisible = true;
	// 对照翻译 ALWAYS opens at 50/50 — 原文和译文各占一半, same size. The
	// divider still lets the reader rebalance during the session, but that
	// adjustment is deliberately not persisted: next open is a clean spread.
	let ratio = 50;

	/**
	 * Pixel sizing, not percentage flex.
	 *
	 * A percentage flex-basis on the XUL <browser> proved unreliable — the
	 * browser kept collapsing to its minimum and the pane swallowed the whole
	 * tab. So the browser's width is pinned in computed PIXELS (width,
	 * min-width and max-width all set) and only the pane flexes into the
	 * remainder. A ResizeObserver keeps the split correct on window resizes.
	 */
	const applyRatio = (percent: number): void => {
		ratio = Math.min(85, Math.max(25, percent));
		paneHost.style.flex = '1 1 0';
		// min-width MUST be 0: a flex item defaults to min-width:auto (its
		// content width), so a wide rebuilt page would otherwise refuse to
		// shrink and push the reader off screen. overflow:hidden is the
		// backstop that makes the guarantee absolute.
		paneHost.style.minWidth = '0';
		paneHost.style.overflow = 'hidden';
		if (!paneVisible) {
			return;
		}
		const total = containerEl.getBoundingClientRect().width;
		if (total < 50) {
			// Layout has not settled yet — try again shortly.
			(doc.defaultView ?? globalThis).setTimeout(() => applyRatio(ratio), 50);
			return;
		}
		const px = Math.round(total * (ratio / 100)) - 3;
		browserEl.style.setProperty('flex', '0 0 auto', 'important');
		browserEl.style.setProperty('width', `${px}px`, 'important');
		browserEl.style.setProperty('min-width', `${px}px`, 'important');
		browserEl.style.setProperty('max-width', `${px}px`, 'important');
	};

	// Keep the pixel split correct when the window (or tab) resizes.
	let resizeObserver: { disconnect(): void } | null = null;
	try {
		const win = doc.defaultView as (Window & { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } }) | null;
		if (win?.ResizeObserver) {
			const observer = new win.ResizeObserver(() => {
				if (paneVisible) {
					applyRatio(ratio);
				}
			});
			observer.observe(containerEl);
			resizeObserver = observer;
		}
	}
	catch {
		// resize tracking is best-effort
	}

	const applyVisible = (visible: boolean): void => {
		paneVisible = visible;
		divider.style.display = visible ? '' : 'none';
		paneHost.style.display = visible ? '' : 'none';
		if (visible) {
			applyRatio(ratio);
		}
		else {
			// The browser takes the whole tab back. Still never moved in the DOM.
			browserEl.style.setProperty('flex', '1 1 100%', 'important');
			browserEl.style.setProperty('min-width', '0', 'important');
			browserEl.style.setProperty('width', 'auto', 'important');
			browserEl.style.removeProperty('max-width');
		}
	};
	applyRatio(ratio);

	// Divider dragging
	let dragging = false;
	const onPointerDown = (event: PointerEvent): void => {
		dragging = true;
		divider.classList.add('pm-dragging');
		try {
			divider.setPointerCapture(event.pointerId);
		}
		catch {
			// ignore
		}
		event.preventDefault();
	};
	const onPointerMove = (event: PointerEvent): void => {
		if (!dragging || !paneVisible) {
			return;
		}
		const rect = containerEl.getBoundingClientRect();
		if (rect.width <= 0) {
			return;
		}
		let percent = ((event.clientX - rect.left) / rect.width) * 100;
		if (getPref<string>('paneSide', 'right') === 'left') {
			percent = 100 - percent;
		}
		applyRatio(percent);
	};
	const onPointerUp = (event: PointerEvent): void => {
		if (!dragging) {
			return;
		}
		dragging = false;
		divider.classList.remove('pm-dragging');
		try {
			divider.releasePointerCapture(event.pointerId);
		}
		catch {
			// ignore
		}
	};
	divider.addEventListener('pointerdown', onPointerDown);
	divider.addEventListener('pointermove', onPointerMove);
	divider.addEventListener('pointerup', onPointerUp);
	divider.addEventListener('pointercancel', onPointerUp);

	let destroyed = false;
	const destroy = (): void => {
		if (destroyed) {
			return;
		}
		destroyed = true;
		resizeObserver?.disconnect();
		resizeObserver = null;
		divider.removeEventListener('pointerdown', onPointerDown);
		divider.removeEventListener('pointermove', onPointerMove);
		divider.removeEventListener('pointerup', onPointerUp);
		divider.removeEventListener('pointercancel', onPointerUp);
		try {
			divider.remove();
			paneHost.remove();
			// Restore original inline styles exactly.
			if (savedContainerStyle) {
				containerEl.setAttribute('style', savedContainerStyle);
			}
			else {
				containerEl.removeAttribute('style');
			}
			if (savedBrowserStyle) {
				browserEl.setAttribute('style', savedBrowserStyle);
			}
			else {
				browserEl.removeAttribute('style');
			}
		}
		catch (e) {
			logger.error(MODULE, 'Failed to restore reader DOM', e);
		}
	};

	return {
		paneHost,
		divider,
		destroy,
		setRatio: applyRatio,
		setSide(side: 'left' | 'right'): void {
			setPref('paneSide', side);
			applySide(side);
		},
		setPaneVisible: applyVisible,
		isPaneVisible: (): boolean => paneVisible
	};
}
