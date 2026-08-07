/**
 * Split-view DOM management: wraps the reader browser in a flex wrapper,
 * adds a draggable divider and the translation pane host, and restores the
 * original DOM exactly on destroy (spec 4.1 / §6 cleanup requirements).
 */

import * as logger from '../utils/logger';
import { getPref, setPref } from '../utils/prefs';
import paneCSS from '../ui/styles/translationPane.css';

const MODULE = 'splitView';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const STYLE_ID = 'pm-bilingual-style';

export interface SplitViewHandles {
	wrapper: HTMLElement;
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
 * Build the split layout around `readerBrowser` inside `container`.
 * DOM before:  container > [... readerBrowser ...]
 * DOM after:   container > [... wrapper(readerHost + divider + paneHost) ...]
 */
export function createSplitView(container: Element, readerBrowser: Element): SplitViewHandles {
	const doc = container.ownerDocument!;
	ensureStyleInjected(doc);

	const wrapper = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	wrapper.className = 'pm-bilingual-wrapper';
	wrapper.setAttribute('data-pm-side', getPref<string>('paneSide', 'right') === 'left' ? 'left' : 'right');

	const divider = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	divider.className = 'pm-bilingual-divider';

	const paneHost = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	paneHost.className = 'pm-bilingual-pane';

	// Insert wrapper where the browser was, then move the browser inside.
	const placeholder = doc.createComment('pm-bilingual-placeholder');
	container.insertBefore(placeholder, readerBrowser);
	wrapper.appendChild(readerBrowser);
	wrapper.appendChild(divider);
	wrapper.appendChild(paneHost);
	container.insertBefore(wrapper, placeholder);
	container.removeChild(placeholder);

	const browserEl = readerBrowser as HTMLElement;
	const previousBrowserStyle = browserEl.getAttribute('style') ?? '';

	const applyRatio = (percent: number): void => {
		const clamped = Math.min(85, Math.max(15, percent));
		browserEl.style.setProperty('flex', `0 0 calc(${clamped}% - 3px)`, 'important');
		browserEl.style.setProperty('min-width', '0', 'important');
		paneHost.style.flex = `1 1 calc(${100 - clamped}% - 2px)`;
	};
	applyRatio(getPref<number>('paneRatio', 55));

	// Divider dragging
	let dragging = false;
	const onPointerDown = (event: PointerEvent): void => {
		dragging = true;
		divider.classList.add('pm-dragging');
		divider.setPointerCapture(event.pointerId);
		event.preventDefault();
	};
	const onPointerMove = (event: PointerEvent): void => {
		if (!dragging) {
			return;
		}
		const rect = wrapper.getBoundingClientRect();
		if (rect.width <= 0) {
			return;
		}
		let percent = ((event.clientX - rect.left) / rect.width) * 100;
		if (wrapper.getAttribute('data-pm-side') === 'left') {
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
		// Persist the ratio (read back from computed flex-basis)
		const rect = wrapper.getBoundingClientRect();
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
			// Move the browser back to its original spot and drop the wrapper.
			if (wrapper.parentNode) {
				wrapper.parentNode.insertBefore(readerBrowser, wrapper);
				wrapper.remove();
			}
			if (previousBrowserStyle) {
				browserEl.setAttribute('style', previousBrowserStyle);
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
		wrapper,
		paneHost,
		divider,
		destroy,
		setRatio: applyRatio,
		setSide(side: 'left' | 'right'): void {
			wrapper.setAttribute('data-pm-side', side);
			setPref('paneSide', side);
		}
	};
}
