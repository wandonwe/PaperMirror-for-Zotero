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
	setInsetProvider(provider: () => number): void;
	refreshLayout(): void;
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
	// P3 (2.0.10): 胶囊样式表 (translationPane 注入到同一主窗口文档) 一并
	// 移除 —— 此前任何路径都不清,disable-without-restart 后残留。
	doc.getElementById('pm-capsule-style')?.remove();
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
	//
	// `ratio` is the VIEWER's share — the visible PDF page area, NOT the
	// whole reader browser. The browser also contains Zotero's own sidebar
	// (thumbnails/annotations), and splitting the raw browser 50/50 gave the
	// layout the user rightly rejected: sidebar+original == translation, so
	// the translation ran wider than the original and its typography was set
	// for the wrong measure. The sidebar's width is measured (insetProvider)
	// and granted to the browser ON TOP of its viewer share, so 原文 and 译文
	// end up pixel-equal.
	let ratio = 50;
	let insetProvider: (() => number) | null = null;
	let lastInset = 0;
	/** The browser width applyRatio last pinned, for the drift watchdog. */
	let lastPx = 0;
	// 注意: 这三个必须声明在 applyRatio 之前 —— 首次 applyRatio 调用发生在
	// createSplitView 的初始化流程里,晚声明会撞 let 的 TDZ。
	let destroyed = false;
	/** 「版面尚未就绪」的重试句柄 —— 全局至多一条链 (审核 P1-7)。 */
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let settleAttempts = 0;
	/** 2 秒(40 × 50ms)还没就绪就放弃: 标签页不可见时宽度恒为 0,
	 *  再等也没有意义;等它重新可见时 refreshLayout 的漂移看门狗会接手。 */
	const MAX_SETTLE_ATTEMPTS = 40;

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
		if (destroyed) {
			// 拆除后残留的重试链仍会执行到这里 (审核 P1-7): 若不拦,它会把已经
			// 恢复原状的阅读器重新用 !important 钉死在 50% 宽,右半空白,
			// 用户只能关标签页才能恢复。
			return;
		}
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
			//
			// 单链 + 上限 (审核 P1-7): 此前这里是裸 setTimeout —— 没有句柄、没有
			// 计数、不看 destroyed。Zotero 会隐藏非选中标签的容器,隐藏元素宽度
			// 恒为 0,于是 total < 50 恒成立、链永不终止;而会话每 350ms 调一次
			// refreshLayout,后者又会调 applyRatio,于是**每 350ms 新增一条 20Hz
			// 链**且互不取消。后台几分钟就是每秒上万次强制重排 + 每 350ms 一条
			// warn(约 13 秒冲光 40 条环形缓冲,把真正的错误全挤掉)。
			if (settleTimer !== null) {
				clearTimeout(settleTimer);
				settleTimer = null;
			}
			if (settleAttempts >= MAX_SETTLE_ATTEMPTS) {
				return; // 交给 refreshLayout 的漂移看门狗,等标签重新可见
			}
			settleAttempts++;
			settleTimer = (doc.defaultView ?? globalThis).setTimeout(() => {
				settleTimer = null;
				applyRatio(ratio);
			}, 50);
			return;
		}
		settleAttempts = 0; // 就绪,重置预算
		let inset = 0;
		try {
			inset = Math.max(0, Math.min(total * 0.5, insetProvider?.() ?? 0));
		}
		catch {
			inset = 0;
		}
		lastInset = inset;
		const contentTotal = Math.max(50, total - 7 - inset);
		const px = Math.round(inset + contentTotal * (ratio / 100)) - 3;
		lastPx = px;
		browserEl.style.setProperty('flex', '0 0 auto', 'important');
		browserEl.style.setProperty('width', `${px}px`, 'important');
		browserEl.style.setProperty('min-width', `${px}px`, 'important');
		browserEl.style.setProperty('max-width', `${px}px`, 'important');
		// Belt and braces: even if the browser's pinning is somehow lost, the
		// pane must NEVER be able to swallow the whole tab — cap it to its own
		// share so the reader always keeps its half.
		paneHost.style.maxWidth = `${Math.max(120, total - px - 7)}px`;
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
		// The divider position marks the edge of the VIEWER area; the
		// sidebar inset sits before it and does not participate in the ratio.
		const inset = lastInset;
		const contentTotal = Math.max(50, rect.width - 7 - inset);
		let x = event.clientX - rect.left;
		if (getPref<string>('paneSide', 'right') === 'left') {
			x = rect.width - x;
		}
		applyRatio(((x - inset) / contentTotal) * 100);
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

	const destroy = (): void => {
		if (destroyed) {
			return;
		}
		destroyed = true;
		if (settleTimer !== null) {
			clearTimeout(settleTimer);
			settleTimer = null;
		}
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
		/** Supply the width of the reader's own sidebar (thumbnails etc.). */
		setInsetProvider(provider: () => number): void {
			insetProvider = provider;
			applyRatio(ratio);
		},
		/**
		 * Cheap periodic check (the session polls this every ~350 ms):
		 *  - re-split when the sidebar opens/closes/resizes;
		 *  - WATCHDOG: Zotero occasionally rewrites the browser element's inline
		 *    styles (navigation, theme changes), which erases the pixel pinning —
		 *    the browser then collapses to its minimum and the pane swallows the
		 *    whole tab, with the reader gone until the tab is closed. Detect the
		 *    drift and re-pin, so the layout self-heals within a beat instead of
		 *    trapping the user.
		 */
		refreshLayout(): void {
			if (!paneVisible || destroyed) {
				return;
			}
			try {
				// 标签页不可见时容器宽度为 0 —— 那不是「漂移」,是「没在布局」
				// (审核 P1-7)。此前这里会把 0 当成漂移: 每 350ms 打一条 warn
				// (约 13 秒冲光 40 条日志环形缓冲)并再开一条 50ms 重试链。
				if (containerEl.getBoundingClientRect().width < 50) {
					return;
				}
				if (lastPx > 0) {
					const actual = browserEl.getBoundingClientRect().width;
					const pinLost = !browserEl.style.getPropertyValue('max-width');
					if (pinLost || Math.abs(actual - lastPx) > 24) {
						logger.warn(MODULE, `Split drifted (pinned ${lastPx}px, actual ${Math.round(actual)}px${pinLost ? ', styles cleared' : ''}); re-pinning`);
						applyRatio(ratio);
						return;
					}
				}
			}
			catch {
				// measurement is best-effort
			}
			let inset = 0;
			try {
				inset = insetProvider?.() ?? 0;
			}
			catch {
				return;
			}
			if (Math.abs(inset - lastInset) > 2) {
				applyRatio(ratio);
			}
		},
		setSide(side: 'left' | 'right'): void {
			setPref('paneSide', side);
			applySide(side);
		},
		setPaneVisible: applyVisible,
		isPaneVisible: (): boolean => paneVisible
	};
}
