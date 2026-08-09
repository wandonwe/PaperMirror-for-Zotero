/**
 * The consolidated status capsule — one bottom-right widget shared by both
 * 覆盖原文 (on-page overlay) and 对照翻译 (side pane) modes.
 *
 * It shows a REAL progress ring (never a fake infinite spin), the current page
 * position, honest per-page translate/place counts, and distinct end states
 * (done / partial / failed / cancelled).
 *
 * Interaction uses REAL stacked DOM hit layers (no click-distance guessing):
 *   - center button (over the %) → 刷新本页 (re-translate current page);
 *   - ring outer arc → progress display only, never clickable;
 *   - text body → 收起 (collapse to just the ring);
 *   - collapsed ring square (≥56px) → 展开 (re-expand), via the capsule's own
 *     click handler that fires only while collapsed;
 *   - right-hand button → contextual ■停止 / 重试 / 查看 / 关闭.
 *
 * Pure DOM + a tiny state machine; the host (overlay vs pane) only supplies the
 * document and the container to mount into, so both surfaces look identical.
 */

export type OverlayPhase = 'translating' | 'laying-out' | 'done' | 'partial' | 'failed' | 'cancelled';

export interface OverlayProgress {
	phase: OverlayPhase;
	/** Which task this is — translation (default) or PDF export. */
	task?: 'translation' | 'export';
	/** 1-based current page and document page count (position, not a doc-wide bar). */
	currentPage: number;
	totalPages: number;
	/** Per-CURRENT-page segment counts. */
	segTotal: number;
	segTranslated: number;
	segPlaced: number;
	/** Segments that should have translated but were kept original. */
	kept: number;
	/** For the failed phase, or a task-specific label (e.g. export). */
	message?: string;
	/**
	 * Whether a `failed` state offers a 重试 button. Translation failures are
	 * retryable (retry = re-translate the page); a save-note / copy / open
	 * failure is NOT — offering "重试" there would wrongly re-translate. Default
	 * (undefined) is retryable, i.e. translation.
	 */
	retryable?: boolean;
}

export interface CapsuleAction {
	kind: 'cancel' | 'retry' | 'view' | 'close';
	label: string;
	title?: string;
}

/**
 * Priority of a task competing for the single capsule, highest wins. Several
 * tasks can be live at once (a page translating WHILE a PDF exports); the
 * capsule shows the most important one instead of whichever updated last, so
 * export and translation no longer overwrite each other's status. Order:
 *   failed > active export > partial > active translation > done > cancelled.
 */
export function taskPriority(m: OverlayProgress): number {
	const active = m.phase === 'translating' || m.phase === 'laying-out';
	if (m.phase === 'failed') {
		return 500;
	}
	if (m.phase === 'partial') {
		return 350;
	}
	if (m.task === 'export') {
		return active ? 400 : 150;
	}
	if (active) {
		return 300;
	}
	return m.phase === 'done' ? 120 : 110; // done / cancelled
}

export interface CapsuleState {
	phase: OverlayPhase;
	glyph: 'ring' | 'check' | 'warn' | 'error' | 'dot' | 'stop';
	indeterminate?: boolean;
	fraction: number | null;
	main: string;
	sub?: string;
	action?: CapsuleAction;
	autoHideMs?: number;
}

export interface CapsuleCallbacks {
	onCancel?: () => void;
	onRetry?: () => void;
	onViewPartial?: () => void;
	/** The × on a persistent (failed) state — dismiss the owning task. */
	onDismiss?: () => void;
	/** Clicking the ring re-translates the current page. */
	onRefreshRing?: () => void;
}

export const CAPSULE_CLASS = 'pm-status-capsule';

export const CAPSULE_CSS = `
.${CAPSULE_CLASS} {
	position: fixed;
	right: 22px;
	bottom: 22px;
	z-index: 2147483000;
	display: flex;
	align-items: center;
	gap: 10px;
	width: 260px;
	min-height: 56px;
	box-sizing: border-box;
	padding: 10px 12px;
	border-radius: 16px;
	background: rgba(24, 26, 31, .9);
	color: #eef1f5;
	font: 12px/1.35 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif;
	box-shadow: 0 6px 22px rgba(0, 0, 0, .28);
	transition: opacity .18s ease, width .18s ease;
	user-select: none;
}
.${CAPSULE_CLASS}[data-pm-hidden="true"] { opacity: 0; pointer-events: none; }
/* Ring = two REAL DOM hit layers, no distance-guessing:
   - .pm-ring-progress (the SVG) only DRAWS progress; pointer-events: none.
   - .pm-ring-refresh (center button, on top) = 刷新本页; stops propagation.
   - .pm-ring-shell (the square behind) = 展开; the capsule's own click handles it. */
.${CAPSULE_CLASS} .pm-ring-shell {
	position: relative;
	flex: 0 0 auto;
	width: 34px;
	height: 34px;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 12px;
	transition: width .18s ease, height .18s ease, background .15s ease;
}
.${CAPSULE_CLASS} .pm-ring-progress {
	position: absolute;
	top: 50%;
	left: 50%;
	width: 34px;
	height: 34px;
	transform: translate(-50%, -50%) rotate(-90deg);
	pointer-events: none; /* 外圈只显示进度，不承担点击 */
}
.${CAPSULE_CLASS} .pm-ring-progress circle { fill: none; stroke-width: 3.5; }
.${CAPSULE_CLASS} .pm-track { stroke: rgba(255, 255, 255, .16); }
.${CAPSULE_CLASS} .pm-arc { stroke: #6c9bff; stroke-linecap: round; transition: stroke-dashoffset .3s ease, stroke .2s ease; }
/* Center button = 刷新本页. FULLY reset the native <button> (appearance/margin/
   min-width/text-align/text-indent/box-sizing) so no host default shifts the %,
   and make it a full 34×34 disc concentric with the SVG — "100%" never overflows
   a too-narrow button. The % lives in an independent .pm-ring-label span that
   handles the visual centering, so button text layout can't nudge it. */
.${CAPSULE_CLASS} .pm-ring-refresh {
	position: absolute;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
	width: 34px;
	height: 34px;
	margin: 0;
	padding: 0;
	min-width: 0;
	box-sizing: border-box;
	-webkit-appearance: none;
	appearance: none;
	border: 0;
	border-radius: 50%;
	background: transparent;
	color: inherit;
	font: 600 11px/1 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif;
	text-align: center;
	text-indent: 0;
	cursor: pointer;
	transition: background .15s ease;
}
.${CAPSULE_CLASS} .pm-ring-refresh:hover { background: rgba(255, 255, 255, .16); }
.${CAPSULE_CLASS} .pm-ring-label {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	pointer-events: none;
}
.${CAPSULE_CLASS} .pm-body { flex: 1 1 auto; min-width: 0; cursor: pointer; }
.${CAPSULE_CLASS} .pm-main { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${CAPSULE_CLASS} .pm-sub { margin-top: 2px; opacity: .72; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${CAPSULE_CLASS} .pm-action {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	justify-content: center;
	min-width: 26px;
	height: 26px;
	padding: 0 8px;
	border: none;
	border-radius: 8px;
	background: rgba(255, 255, 255, .08);
	color: inherit;
	font: inherit;
	cursor: pointer;
}
.${CAPSULE_CLASS} .pm-action:hover { background: rgba(255, 255, 255, .18); }
/* Collapsed: SAME 56×56 outer size as the expanded capsule's height — no more
   padding:6px + shell:56 = 68px jump. The shell fills the 56 square (easy hit
   target), the SVG stays 34×34 so the RING itself does not grow; only the
   clickable background does. */
.${CAPSULE_CLASS}[data-pm-collapsed="true"] {
	width: 56px;
	height: 56px;
	min-height: 56px;
	padding: 0;
	gap: 0;
	cursor: pointer;
}
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-ring-shell { width: 56px; height: 56px; cursor: pointer; }
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-ring-shell:hover { background: rgba(255, 255, 255, .1); }
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-body,
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-action { display: none; }
.${CAPSULE_CLASS}[data-pm-phase="done"] .pm-arc { stroke: #37c871; }
.${CAPSULE_CLASS}[data-pm-phase="partial"] .pm-arc { stroke: #f5a623; }
.${CAPSULE_CLASS}[data-pm-phase="failed"] .pm-arc { stroke: #ff6b6b; }
.${CAPSULE_CLASS}[data-pm-phase="cancelled"] .pm-arc { stroke: rgba(255, 255, 255, .4); }
.${CAPSULE_CLASS}[data-pm-indeterminate="true"] .pm-ring-progress { animation: pm-capsule-spin 1s linear infinite; }
@keyframes pm-capsule-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }
`;

/** Map a progress model to the capsule's normalized state and final 文案. */
export function capsuleStateFor(m: OverlayProgress): CapsuleState {
	if (m.task === 'export') {
		return exportStateFor(m);
	}
	const pagePos = `第 ${m.currentPage} / ${m.totalPages} 页`;
	const counts = `翻译 ${m.segTranslated}/${m.segTotal} 段 · 排版 ${m.segPlaced}/${m.segTotal} 段`;
	// Combined progress across BOTH halves of the work — translation is the
	// first 50%, placement the second — so the ring climbs 0→100% smoothly and
	// never resets to 0% when a fully-translated page enters the layout phase.
	const combined = m.segTotal > 0
		? (m.segTranslated + m.segPlaced) / (m.segTotal * 2)
		: null;
	switch (m.phase) {
		case 'translating':
			return {
				phase: m.phase,
				glyph: 'ring',
				indeterminate: m.segTotal <= 0,
				fraction: combined,
				main: `正在处理 ${pagePos}`,
				sub: m.segTotal > 0 ? counts : '正在识别段落',
				// ■ (stop), not a pause glyph — the backend cancels and restarts,
				// there is no pause/resume.
				action: { kind: 'cancel', label: '■', title: '停止任务' }
			};
		case 'laying-out':
			return {
				phase: m.phase,
				glyph: 'ring',
				fraction: combined,
				main: `正在适配 ${pagePos} 排版`,
				sub: counts,
				action: { kind: 'cancel', label: '■', title: '停止任务' }
			};
		case 'done':
			return {
				phase: m.phase,
				glyph: 'check',
				fraction: 1,
				main: `已完成 第 ${m.currentPage} 页`,
				autoHideMs: 2000
			};
		case 'partial':
			return {
				phase: m.phase,
				glyph: 'warn',
				fraction: combined,
				main: `第 ${m.currentPage} 页 · ${m.kept} 段保留原文`,
				sub: counts,
				action: { kind: 'view', label: '查看', title: '查看保留原文的段落' }
			};
		case 'failed':
			return {
				phase: m.phase,
				glyph: 'error',
				fraction: null,
				main: m.message ?? '翻译失败',
				// Retry re-translates the page, so it is only offered for
				// translation failures — never for save/copy/open failures.
				action: m.retryable === false
					? { kind: 'close', label: '×', title: '关闭' }
					: { kind: 'retry', label: '重试', title: '重试翻译' }
			};
		case 'cancelled':
			return {
				phase: m.phase,
				glyph: 'stop',
				fraction: null,
				main: '已停止翻译',
				autoHideMs: 2600
			};
	}
}

/** Export task states (whole-PDF export runs through the same capsule). */
function exportStateFor(m: OverlayProgress): CapsuleState {
	const pct = m.segTotal > 0 ? Math.max(0, Math.min(1, m.segPlaced / m.segTotal)) : null;
	switch (m.phase) {
		case 'done':
			return { phase: 'done', glyph: 'check', fraction: 1, main: m.message ?? 'PDF 已导出', autoHideMs: 2200 };
		case 'failed':
			return {
				phase: 'failed', glyph: 'error', fraction: null,
				main: m.message ?? 'PDF 导出失败',
				action: { kind: 'close', label: '×', title: '关闭' }
			};
		case 'cancelled':
			return { phase: 'cancelled', glyph: 'stop', fraction: null, main: '已停止导出', autoHideMs: 2200 };
		default:
			return {
				phase: 'translating', glyph: 'ring', indeterminate: pct == null, fraction: pct,
				main: m.message ?? '正在导出 PDF'
			};
	}
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A single status capsule mounted into a host document/container. */
export class StatusCapsule {
	private collapsed = false;
	private last: CapsuleState | null = null;

	constructor(
		private getHost: () => { doc: Document; container: HTMLElement } | null,
		private callbacks: CapsuleCallbacks = {},
		private ensureStyle?: (doc: Document) => void
	) {}

	setProgress(model: OverlayProgress | null): void {
		if (!model) {
			this.hide();
			return;
		}
		this.render(capsuleStateFor(model));
	}

	/** Re-paint the last state (after a host redraw that may have dropped it). */
	reassert(): void {
		if (this.last) {
			this.render(this.last);
		}
	}

	hide(): void {
		this.last = null;
		try {
			this.getHost()?.doc.querySelector(`.${CAPSULE_CLASS}`)?.setAttribute('data-pm-hidden', 'true');
		}
		catch {
			// host gone
		}
	}

	remove(): void {
		this.last = null;
		try {
			this.getHost()?.doc.querySelectorAll(`.${CAPSULE_CLASS}`).forEach(n => n.remove());
		}
		catch {
			// host gone
		}
	}

	private render(state: CapsuleState): void {
		this.last = state;
		const host = this.getHost();
		if (!host) {
			return;
		}
		const { doc, container } = host;
		try {
			this.ensureStyle?.(doc);
			let el = doc.querySelector(`.${CAPSULE_CLASS}`) as HTMLElement | null;
			if (!el || el.ownerDocument !== doc) {
				el?.remove();
				el = this.build(doc);
				container.appendChild(el);
			}
			el.removeAttribute('data-pm-hidden');
			el.setAttribute('data-pm-phase', state.phase);
			this.setCollapsed(el, this.collapsed);
			el.setAttribute('data-pm-indeterminate', String(!!state.indeterminate));

			const C = 2 * Math.PI * 15;
			const arc = el.querySelector('.pm-arc') as SVGElement | null;
			if (arc) {
				arc.setAttribute('stroke-dasharray', String(C));
				const frac = state.indeterminate || state.fraction == null
					? 0.25
					: Math.max(0, Math.min(1, state.fraction));
				arc.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
			}
			// The %/glyph lives in the center 刷新 button's label span (so hovering
			// the center reads "重新翻译本页" and clicking it re-translates, while
			// the span keeps the number optically centred).
			const label = el.querySelector('.pm-ring-label');
			if (label) {
				label.textContent = state.glyph === 'check' ? '✓'
					: state.glyph === 'warn' || state.glyph === 'error' ? '!'
						: state.glyph === 'stop' ? '—'
							: (!state.indeterminate && state.fraction != null && state.phase !== 'done')
								? `${Math.round(Math.max(0, Math.min(1, state.fraction)) * 100)}%`
								: '';
			}
			const main = el.querySelector('.pm-main');
			if (main) {
				main.textContent = state.main;
			}
			const sub = el.querySelector('.pm-sub') as HTMLElement | null;
			if (sub) {
				sub.textContent = state.sub ?? '';
				sub.style.display = state.sub ? '' : 'none';
			}
			const action = el.querySelector('.pm-action') as HTMLButtonElement | null;
			if (action) {
				if (state.action) {
					action.style.display = '';
					action.textContent = state.action.label;
					action.title = state.action.title ?? state.action.label;
					action.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						this.runAction(state.action!.kind);
					};
				}
				else {
					action.style.display = 'none';
					action.onclick = null;
				}
			}
			// Lifecycle (auto-hide of done/cancelled) is owned by the caller's
			// task queue, not the capsule — so a finished task can't hide another
			// task that is still running.
		}
		catch {
			// host may be mid-teardown
		}
	}

	private build(doc: Document): HTMLElement {
		const el = doc.createElement('div');
		el.className = CAPSULE_CLASS;

		// --- ring layer: two real DOM hit zones stacked, no geometry guessing ---
		const shell = doc.createElement('div');
		shell.className = 'pm-ring-shell';
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('class', 'pm-ring-progress');
		svg.setAttribute('viewBox', '0 0 34 34');
		const track = doc.createElementNS(SVG_NS, 'circle');
		track.setAttribute('class', 'pm-track');
		track.setAttribute('cx', '17'); track.setAttribute('cy', '17'); track.setAttribute('r', '15');
		const arc = doc.createElementNS(SVG_NS, 'circle');
		arc.setAttribute('class', 'pm-arc');
		arc.setAttribute('cx', '17'); arc.setAttribute('cy', '17'); arc.setAttribute('r', '15');
		svg.appendChild(track); svg.appendChild(arc);
		// Center button (on top of the ring) = 刷新本页. It stops the click from
		// reaching the capsule's expand handler, so 刷新 never doubles as 展开.
		const refresh = doc.createElement('button');
		refresh.className = 'pm-ring-refresh';
		refresh.type = 'button';
		refresh.title = '重新翻译本页';
		// The % text is an independent span so button text-layout quirks across
		// platforms can never nudge it off the ring's geometric centre.
		const label = doc.createElement('span');
		label.className = 'pm-ring-label';
		refresh.appendChild(label);
		refresh.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.callbacks.onRefreshRing?.();
		});
		shell.appendChild(svg);
		shell.appendChild(refresh);

		// --- text body = 点击收起 (only present when expanded) ---
		const body = doc.createElement('div');
		body.className = 'pm-body';
		body.title = '点击收起';
		const main = doc.createElement('div'); main.className = 'pm-main';
		const sub = doc.createElement('div'); sub.className = 'pm-sub';
		body.appendChild(main); body.appendChild(sub);
		body.addEventListener('click', (e) => {
			e.stopPropagation();
			this.setCollapsed(el, true);
		});

		// --- right action (stop / retry / view / close) ---
		const action = doc.createElement('button');
		action.className = 'pm-action';
		action.type = 'button';

		// The capsule expands when collapsed: clicking the big square ring
		// background (anything that isn't the center button) bubbles up to here.
		// When already expanded this is a no-op, so the ring edge never collapses
		// by accident — collapsing is the text body's job.
		el.addEventListener('click', () => {
			if (this.collapsed) {
				this.setCollapsed(el, false);
			}
		});

		el.appendChild(shell);
		el.appendChild(body);
		el.appendChild(action);
		return el;
	}

	/** Flip collapsed state and keep the ring shell's tooltip honest. */
	private setCollapsed(el: HTMLElement, collapsed: boolean): void {
		this.collapsed = collapsed;
		el.setAttribute('data-pm-collapsed', String(collapsed));
		const shell = el.querySelector('.pm-ring-shell') as HTMLElement | null;
		if (shell) {
			shell.title = collapsed ? '展开任务详情' : '';
		}
	}

	private runAction(kind: CapsuleAction['kind']): void {
		if (kind === 'cancel') {
			this.callbacks.onCancel?.();
		}
		else if (kind === 'retry') {
			this.callbacks.onRetry?.();
		}
		else if (kind === 'view') {
			this.callbacks.onViewPartial?.();
		}
		else if (this.callbacks.onDismiss) {
			this.callbacks.onDismiss();
		}
		else {
			this.hide();
		}
	}
}
