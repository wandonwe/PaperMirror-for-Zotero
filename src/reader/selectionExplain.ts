/**
 * 划词「解析」浮动按钮.
 *
 * The old entry point injected a button into Zotero's SHARED text-selection
 * popup (the colour swatches + annotation "A"). Every translation/note plugin
 * crowds into that same popup, so buttons collide and reorder unpredictably.
 *
 * This is our OWN chip instead: a small pill anchored just under the current
 * PDF selection, living inside the viewer iframe so it tracks the selection's
 * coordinates, and belonging to no shared surface — nothing else can push it
 * around. It shows on mouse-up over a non-empty selection, hides on the next
 * mousedown / scroll / empty selection, and is gated by a preference so the
 * reader can turn it off entirely if they prefer another plugin's flow.
 *
 * No content-compartment awaits: everything here is synchronous DOM in the
 * iframe (selection rects, element creation) — the getPageData-trap rule does
 * not apply.
 */

import * as logger from '../utils/logger';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'selectionExplain';
const CHIP_ID = 'pm-select-explain-chip';
const STYLE_ID = 'pm-select-explain-style';

/** Idle lifespan of the chip once shown, if the reader doesn't click it. */
const AUTO_HIDE_MS = 4000;
/** Shorter grace period after the pointer leaves the chip. */
const AUTO_HIDE_AFTER_LEAVE_MS = 1200;

const CSS = `
#${CHIP_ID} {
	position: fixed;
	z-index: 2147483000;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	margin: 0;
	padding: 5px 11px;
	border: none;
	border-radius: 999px;
	background: linear-gradient(135deg, #4f6bff, #6b52e8);
	color: #fff;
	font: 600 12px/1 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif;
	box-shadow: 0 3px 14px rgba(30, 40, 120, .35);
	cursor: pointer;
	user-select: none;
	white-space: nowrap;
	transition: opacity .12s ease, transform .12s ease;
}
#${CHIP_ID}:hover { transform: translateY(-1px); }
#${CHIP_ID} .pm-sel-spark { font-size: 11px; opacity: .95; }
/* Hidden state under OUR control. The id selector above out-specifies the UA
   [hidden] rule, so relying on the .hidden property left the chip permanently
   visible — this attribute + !important is what actually removes it. */
#${CHIP_ID}[data-pm-hidden="true"] { display: none !important; }
`;

export interface SelectionExplainOptions {
	label: string;
	onExplain: (text: string) => void;
}

export class SelectionExplainButton {
	private reader: ReaderLike;
	private label: string;
	private onExplain: (text: string) => void;
	private enabled = true;
	private destroyed = false;

	private win: (Window & typeof globalThis) | null = null;
	private doc: Document | null = null;
	private chip: HTMLElement | null = null;
	private currentText = '';
	/** Pointer is over the chip — mousedown must not treat it as "click away". */
	private overChip = false;

	private onMouseUp: ((event: MouseEvent) => void) | null = null;
	private onMouseDown: ((event: MouseEvent) => void) | null = null;
	private onScroll: (() => void) | null = null;
	private onSelectionChange: (() => void) | null = null;
	private attachTimer: ReturnType<typeof setInterval> | null = null;
	private showTimer: ReturnType<typeof setTimeout> | null = null;
	private autoHideTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(reader: ReaderLike, opts: SelectionExplainOptions) {
		this.reader = reader;
		this.label = opts.label;
		this.onExplain = opts.onExplain;
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			// Still make sure listeners exist the first time we're enabled.
			if (enabled && !this.win) {
				this.ensureAttached();
			}
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			this.ensureAttached();
		}
		else {
			this.hide();
		}
	}

	setLabel(label: string): void {
		this.label = label;
		const span = this.chip?.querySelector('.pm-sel-label');
		if (span) {
			span.textContent = label;
		}
	}

	/**
	 * Resolve the iframe window and wire selection listeners. The reader iframe
	 * is not always ready when the session starts, so poll briefly.
	 */
	private ensureAttached(): void {
		if (this.destroyed || this.win) {
			return;
		}
		const tryAttach = (): boolean => {
			const win = adapter.getPdfViewerWindow(this.reader);
			if (!win?.document) {
				return false;
			}
			this.win = win;
			this.doc = win.document;
			adapter.injectPdfStyle(this.reader, STYLE_ID, CSS);

			this.onMouseUp = (event: MouseEvent): void => {
				if (!this.enabled || this.destroyed) {
					return;
				}
				// A click on the chip itself is a request to explain, not a
				// selection gesture — handled by the chip's own listener.
				if (this.overChip || (this.chip && event.target && this.chip.contains(event.target as Node))) {
					return;
				}
				// Let the selection settle before reading it.
				if (this.showTimer) {
					clearTimeout(this.showTimer);
				}
				this.showTimer = setTimeout(() => this.evaluateSelection(), 10);
			};
			this.onMouseDown = (event: MouseEvent): void => {
				// Interacting with the chip must NOT be read as "click away". The
				// overChip flag is the reliable guard (event.target identity across
				// the content compartment isn't always the chip node); contains()
				// is a backup.
				if (this.overChip) {
					return;
				}
				if (this.chip && event.target && this.chip.contains(event.target as Node)) {
					return;
				}
				this.hide();
			};
			this.onScroll = (): void => this.hide();
			// The authoritative "not selected → hidden" signal: the moment the
			// selection collapses (a click anywhere, keyboard nav, another app
			// clearing it), the chip goes away. mouseup only ever SHOWS it.
			this.onSelectionChange = (): void => {
				if (!this.enabled || this.destroyed) {
					return;
				}
				let text = '';
				try {
					const sel = this.win?.getSelection?.();
					text = sel ? String(sel.toString()).trim() : '';
				}
				catch {
					text = '';
				}
				if (!text) {
					this.hide();
				}
			};

			this.doc.addEventListener('mouseup', this.onMouseUp, true);
			this.doc.addEventListener('mousedown', this.onMouseDown, true);
			this.doc.addEventListener('selectionchange', this.onSelectionChange);
			// PDF.js scrolls #viewerContainer, not the window; catch both.
			this.win.addEventListener('scroll', this.onScroll, true);
			return true;
		};

		if (tryAttach()) {
			return;
		}
		let tries = 0;
		this.attachTimer = setInterval(() => {
			if (this.destroyed || tryAttach() || ++tries > 25) {
				if (this.attachTimer) {
					clearInterval(this.attachTimer);
					this.attachTimer = null;
				}
			}
		}, 400);
	}

	private evaluateSelection(): void {
		if (!this.enabled || this.destroyed || !this.win || !this.doc) {
			return;
		}
		let text = '';
		let rect: DOMRect | null = null;
		try {
			const selection = this.win.getSelection?.();
			text = selection ? String(selection.toString()).trim() : '';
			if (text && selection && selection.rangeCount > 0) {
				const r = selection.getRangeAt(0).getBoundingClientRect();
				if (r && (r.width > 0 || r.height > 0)) {
					rect = r;
				}
			}
		}
		catch (e) {
			logger.debug(MODULE, 'reading selection failed', e);
		}
		if (!text || !rect) {
			this.hide();
			return;
		}
		this.currentText = text;
		this.show(rect);
	}

	private ensureChip(): HTMLElement {
		if (this.chip) {
			return this.chip;
		}
		const doc = this.doc!;
		const chip = doc.createElement('button');
		chip.id = CHIP_ID;
		chip.type = 'button';
		const spark = doc.createElement('span');
		spark.className = 'pm-sel-spark';
		spark.textContent = '✦';
		const label = doc.createElement('span');
		label.className = 'pm-sel-label';
		label.textContent = this.label;
		chip.append(spark, label);
		// Preserve the selection: a mousedown inside the chip must not clear it.
		chip.addEventListener('mousedown', (event) => event.preventDefault());
		chip.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			// Fall back to the live selection: even if a stray mousedown cleared
			// currentText, the selection is still there (mousedown was prevented).
			let text = this.currentText;
			if (!text) {
				try {
					const sel = this.win?.getSelection?.();
					text = sel ? String(sel.toString()).trim() : '';
				}
				catch {
					text = '';
				}
			}
			this.hide();
			if (text) {
				this.onExplain(text);
			}
		});
		// Hovering keeps the chip alive (the reader is aiming for it); leaving it
		// starts a short countdown so it never lingers once attention moves on.
		chip.addEventListener('mouseenter', () => {
			this.overChip = true;
			this.cancelAutoHide();
		});
		chip.addEventListener('mouseleave', () => {
			this.overChip = false;
			this.scheduleAutoHide(AUTO_HIDE_AFTER_LEAVE_MS);
		});
		(doc.body ?? doc.documentElement).appendChild(chip);
		this.chip = chip;
		return chip;
	}

	private show(rect: DOMRect): void {
		const chip = this.ensureChip();
		chip.removeAttribute('data-pm-hidden');
		chip.style.visibility = 'hidden';
		chip.style.left = '0px';
		chip.style.top = '0px';
		// Measure, then clamp within the viewport.
		const cw = chip.offsetWidth || 84;
		const ch = chip.offsetHeight || 26;
		const vw = this.win?.innerWidth ?? (this.doc?.documentElement.clientWidth ?? 800);
		const vh = this.win?.innerHeight ?? (this.doc?.documentElement.clientHeight ?? 600);
		let left = rect.left;
		let top = rect.bottom + 6;
		// Below the selection unless that would run off the bottom.
		if (top + ch > vh - 4) {
			top = Math.max(4, rect.top - ch - 6);
		}
		left = Math.max(4, Math.min(left, vw - cw - 4));
		chip.style.left = `${Math.round(left)}px`;
		chip.style.top = `${Math.round(top)}px`;
		chip.style.visibility = 'visible';
		// Never let it live on the page indefinitely.
		this.scheduleAutoHide(AUTO_HIDE_MS);
	}

	private scheduleAutoHide(ms: number): void {
		this.cancelAutoHide();
		// The plugin sandbox's own setTimeout — fires reliably and runs the
		// closure in our context. (Scheduling through the content window proved
		// unreliable across the compartment.)
		this.autoHideTimer = setTimeout(() => {
			this.autoHideTimer = null;
			this.hide();
		}, ms);
	}

	private cancelAutoHide(): void {
		if (this.autoHideTimer) {
			clearTimeout(this.autoHideTimer);
			this.autoHideTimer = null;
		}
	}

	hide(): void {
		if (this.showTimer) {
			clearTimeout(this.showTimer);
			this.showTimer = null;
		}
		this.cancelAutoHide();
		this.overChip = false;
		if (this.chip) {
			this.chip.setAttribute('data-pm-hidden', 'true');
		}
		this.currentText = '';
	}

	destroy(): void {
		this.destroyed = true;
		if (this.attachTimer) {
			clearInterval(this.attachTimer);
			this.attachTimer = null;
		}
		if (this.showTimer) {
			clearTimeout(this.showTimer);
			this.showTimer = null;
		}
		this.cancelAutoHide();
		try {
			if (this.doc && this.onMouseUp) {
				this.doc.removeEventListener('mouseup', this.onMouseUp, true);
			}
			if (this.doc && this.onMouseDown) {
				this.doc.removeEventListener('mousedown', this.onMouseDown, true);
			}
			if (this.win && this.onScroll) {
				this.win.removeEventListener('scroll', this.onScroll, true);
			}
			if (this.doc && this.onSelectionChange) {
				this.doc.removeEventListener('selectionchange', this.onSelectionChange);
			}
			this.chip?.remove();
			adapter.removePdfStyle(this.reader, STYLE_ID);
		}
		catch (e) {
			logger.debug(MODULE, 'cleanup failed', e);
		}
		this.chip = null;
		this.win = null;
		this.doc = null;
		this.onMouseUp = null;
		this.onMouseDown = null;
		this.onScroll = null;
		this.onSelectionChange = null;
	}
}
