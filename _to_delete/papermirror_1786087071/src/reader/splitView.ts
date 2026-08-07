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
	applySide(getPref<string>('paneSide', 'right') === 'left' ? 'left' : 'right');

	const applyRatio = (percent: number): void => {
		const clamped = Math.min(85, Math.max(15, percent));
		browserEl.style.setProperty('flex', `0 0 calc(${clamped}% - 3px)`, 'important');
		browserEl.style.setProperty('min-width', '0', 'important');
		browserEl.style.setProperty('width', 'auto', 'important');
		paneHost.style.flex = `1 1 calc(${100 - clamped}% - 2px)`;
		paneHost.style.minWidth = '220px';
	};
	applyRatio(getPref<number>('paneRatio', 55));

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
		if (!dragging) {
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
		const rect = containerEl.getBoundingClientRect();
		const browserRect = browserEl.getBoundingClientRect();
		if (rect.width > 0 && browserRect.width > 0) {
			const percent = Math.round((browserRect.width / rect.width) * 100);
			setPref('paneRatio', Math.min(85, Math.max(15, percent)));
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
		}
	};
}
