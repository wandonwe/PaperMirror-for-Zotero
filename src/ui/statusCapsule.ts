/**
 * The consolidated status capsule — one bottom-right widget shared by both
 * 覆盖原文 (on-page overlay) and 对照翻译 (side pane) modes.
 *
 * It shows a REAL progress ring (never a fake infinite spin), the current page
 * position, honest per-page translate/place counts, and distinct end states
 * (done / partial / failed / cancelled). Clicking the RING re-translates the
 * current page; the right-hand button is contextual (cancel / retry / view);
 * clicking the body collapses the capsule to just the ring.
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
.${CAPSULE_CLASS} .pm-ring { position: relative; flex: 0 0 auto; width: 34px; height: 34px; cursor: pointer; border-radius: 50%; }
.${CAPSULE_CLASS} .pm-ring:hover { background: rgba(255, 255, 255, .08); }
.${CAPSULE_CLASS} .pm-ring svg { width: 34px; height: 34px; display: block; transform: rotate(-90deg); }
.${CAPSULE_CLASS} .pm-ring circle { fill: none; stroke-width: 3.5; }
.${CAPSULE_CLASS} .pm-ring .pm-track { stroke: rgba(255, 255, 255, .16); }
.${CAPSULE_CLASS} .pm-ring .pm-arc { stroke: #6c9bff; stroke-linecap: round; transition: stroke-dashoffset .3s ease, stroke .2s ease; }
.${CAPSULE_CLASS} .pm-glyph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; pointer-events: none; }
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
.${CAPSULE_CLASS}[data-pm-collapsed="true"] { width: auto; }
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-body,
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-action { display: none; }
.${CAPSULE_CLASS}[data-pm-phase="done"] .pm-arc { stroke: #37c871; }
.${CAPSULE_CLASS}[data-pm-phase="partial"] .pm-arc { stroke: #f5a623; }
.${CAPSULE_CLASS}[data-pm-phase="failed"] .pm-arc { stroke: #ff6b6b; }
.${CAPSULE_CLASS}[data-pm-phase="cancelled"] .pm-arc { stroke: rgba(255, 255, 255, .4); }
.${CAPSULE_CLASS}[data-pm-indeterminate="true"] .pm-ring svg { animation: pm-capsule-spin 1s linear infinite; }
@keyframes pm-capsule-spin { to { transform: rotate(360deg); } }
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
				action: { kind: 'cancel', label: '×', title: '取消翻译' }
			};
		case 'laying-out':
			return {
				phase: m.phase,
				glyph: 'ring',
				fraction: combined,
				main: `正在适配 ${pagePos} 排版`,
				sub: counts,
				action: { kind: 'cancel', label: '×', title: '取消' }
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
			el.setAttribute('data-pm-collapsed', String(this.collapsed));
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
			const glyph = el.querySelector('.pm-glyph');
			if (glyph) {
				glyph.textContent = state.glyph === 'check' ? '✓'
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

		const ring = doc.createElement('div');
		ring.className = 'pm-ring';
		ring.title = '圆心：刷新本页 · 圆环边缘：展开/收起详情';
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 34 34');
		const track = doc.createElementNS(SVG_NS, 'circle');
		track.setAttribute('class', 'pm-track');
		track.setAttribute('cx', '17'); track.setAttribute('cy', '17'); track.setAttribute('r', '15');
		const arc = doc.createElementNS(SVG_NS, 'circle');
		arc.setAttribute('class', 'pm-arc');
		arc.setAttribute('cx', '17'); arc.setAttribute('cy', '17'); arc.setAttribute('r', '15');
		svg.appendChild(track); svg.appendChild(arc);
		const glyph = doc.createElement('span');
		glyph.className = 'pm-glyph';
		ring.appendChild(svg); ring.appendChild(glyph);
		// The ring is two hit zones: the OUTER band (the drawn circle) toggles
		// the detail body open/closed; the INNER disc (where the % sits)
		// re-translates the current page.
		ring.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const rect = ring.getBoundingClientRect();
			const dx = e.clientX - (rect.left + rect.width / 2);
			const dy = e.clientY - (rect.top + rect.height / 2);
			const dist = Math.hypot(dx, dy);
			// Inner disc ≈ 42% of the ring radius; anything beyond is the edge.
			if (rect.width > 0 && dist > rect.width * 0.42) {
				this.collapsed = !this.collapsed;
				el.setAttribute('data-pm-collapsed', String(this.collapsed));
			}
			else {
				this.callbacks.onRefreshRing?.();
			}
		});

		const body = doc.createElement('div');
		body.className = 'pm-body';
		const main = doc.createElement('div'); main.className = 'pm-main';
		const sub = doc.createElement('div'); sub.className = 'pm-sub';
		body.appendChild(main); body.appendChild(sub);
		// Body click → collapse / expand.
		body.addEventListener('click', () => {
			this.collapsed = !this.collapsed;
			el.setAttribute('data-pm-collapsed', String(this.collapsed));
		});

		const action = doc.createElement('button');
		action.className = 'pm-action';
		action.type = 'button';

		el.appendChild(ring);
		el.appendChild(body);
		el.appendChild(action);
		return el;
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
