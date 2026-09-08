/**
 * Translation pane UI — DOM structure mirrors demo/index.html exactly:
 *
 *   header  .pm-title-row   → [eyebrow(live dot + PAPERMIRROR) + h2 镜像译文]
 *                             [swap] [settings] [close]
 *           .pm-controls-row→ [源语言 → 目标语言] [服务商] [刷新全部]
 *   scroll  → 讲解卡片 / 第 N 页 分隔 / 译文段落(原文小字 + 衬线译文)
 *   footer  → 显示原文对照 · 同步滚动 · 复制译文 · 保存到笔记
 *
 * Task/error status is NOT in the pane chrome any more — it lives in the shared
 * StatusCapsule (bottom-right). The pane only keeps the success Toast, the
 * privacy card, the explain card, and per-page inline status (.pm-status-inline).
 *
 * Security: every dynamic string is rendered via textContent or a text node.
 * Model/remote content is NEVER assigned to innerHTML.
 */

import { isFormulaRun } from '../reader/formulaGuard';
import { stripStyleMarkers } from '../reader/styleRuns';
import * as logger from '../utils/logger';
import { RenderPump } from './renderPump';
import { CachedPageIndex, type PageOffsetIndex } from './pageOffsetIndex';
import { getPref } from '../utils/prefs';
import type { ExplanationSection } from '../translation/explainer';
import type { PageTranslationState } from '../translation/translationManager';
import type { SourceBlock } from '../types/models';
import { StatusCapsule, CAPSULE_CSS, type OverlayProgress } from './statusCapsule';
import { flashKeptIndicator } from './strictPageReplacement';
// Official brand marks (vendored from lobe-icons, MIT — see brandIcons/README).
import svgMicrosoft from './brandIcons/microsoft.svg';
import svgGoogle from './brandIcons/google.svg';
import svgOpenAI from './brandIcons/openai.svg';
import svgClaude from './brandIcons/claude.svg';
import svgGemini from './brandIcons/gemini.svg';
import svgDeepSeek from './brandIcons/deepseek.svg';
import svgDeepL from './brandIcons/deepl.svg';
import svgKimi from './brandIcons/kimi.svg';
import svgQwen from './brandIcons/qwen.svg';
import svgZhipu from './brandIcons/zhipu.svg';
import svgSiliconFlow from './brandIcons/siliconflow.svg';
import svgGroq from './brandIcons/groq.svg';
import svgOllama from './brandIcons/ollama.svg';
import svgOpenRouter from './brandIcons/openrouter.svg';

/**
 * id → official SVG source. openai-compatible / custom deliberately have no
 * entry: they are generic endpoints with no brand, and get the neutral globe.
 */
const BRAND_SVGS: Record<string, string> = {
	'bing-free': svgMicrosoft,
	'google-free': svgGoogle,
	openai: svgOpenAI,
	anthropic: svgClaude,
	gemini: svgGemini,
	deepseek: svgDeepSeek,
	deepl: svgDeepL,
	moonshot: svgKimi,
	qwen: svgQwen,
	zhipu: svgZhipu,
	siliconflow: svgSiliconFlow,
	groq: svgGroq,
	ollama: svgOllama,
	openrouter: svgOpenRouter
};

const MODULE = 'translationPane';
/**
 * 一页最多重试几次降级重建 (2.5.2)。够覆盖偶发失败(底图被淘汰、页刚被
 * PDF.js 销毁、字体未就绪),又不至于让确定性失败的页每 2.5 秒空转一次。
 */
const MAX_DEGRADED_REBUILDS = 3;
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Icon paths copied from demo/index.html
const ICON_PATHS = {
	swap: 'm7 7-4 4 4 4M3 11h13M17 17l4-4-4-4M21 13H8',
	settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.01V3h4v.08a1.7 1.7 0 0 0 1.03 1.53 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.96 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z',
	close: 'm6 6 12 12M18 6 6 18',
	refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7',
	// 三点「更多」(2.4.2): h.01 + stroke-linecap:round = 三个圆点。
	more: 'M5 12h.01 M12 12h.01 M19 12h.01'
} as const;

export interface PaneStrings {
	eyebrow: string;
	title: string;
	explain: string;
	/** 工具条按钮全名「解析选中内容」(2.3.1 item3); `explain` 留给块级 mini 按钮。 */
	explainSelection: string;
	explainTip: string;
	explainTitle: string;
	explainSubtitle: string;
	explainCopy: string;
	explainSave: string;
	syncScroll: string;
	statusTranslating: string; // template with %n%
	statusDone: string; // template with %n%
	statusCached: string;
	statusError: string;
	noTextLayer: string;
	pagePrefix: string;
	pageSuffix: string;
	retranslate: string;
	saveNote: string;
	settings: string;
	close: string;
	swapSides: string;
	pending: string;
	viewArticle: string;
	viewPage: string;
	privacyNotice: string;
	privacyAccept: string;
}

/**
 * 一次整页重建的结果 (2.5.2)。
 *
 *   'translated' 译文页已画上。
 *   'original'   这页本来就没有可替换的译文(纯图/扫描页,或该页尚未翻完)
 *                —— 画原文是**正确**结果,是终态。
 *   'degraded'   这页确实翻完了、有译文,但这一趟重建没成(buildStrictPage
 *                抛异常或返回 null),画的是原文兜底。**必须能再试**:此前它
 *                和 'original' 不分,被当成终态钉死,于是一次偶发失败会让那
 *                一页整个会话都停在英文 —— 用户看到的就是"往回翻译文消失"。
 *   false        现在画不了(底图没拿到、渲染被更新的一趟顶掉),保持 ghost。
 */
export type PageRenderResult = 'translated' | 'partial' | 'original' | 'degraded' | false;

/**
 * 增量显示的准入 (2.7.10, 外部审核 第二批·3)。
 *
 * 管理器每译完一个 chunk 就 notify 一次(progressive rendering per chunk),
 * 但页视图此前只在 status==='done' 时重建 —— 于是块多、批次多的页整段时间
 * 都是原文。真实诊断 (Radiology 2026 PCCT, p13) 上这一页 33 个可替换块、
 * 3 个批次、34.7 秒:首批约 12 秒就到了,用户却要等满 34 秒才看到第一个字。
 *
 * 但"每次 notify 都重画"正是老注释警告的那件事: 重建要跑一次严格排版 +
 * 遮罩/文本层,页面还会闪。三道闸让它只在真的划算时才画:
 *   - 只画**看得见**的页 —— 看不见的页重建纯属浪费(后台页只更新数据,
 *     不立即排版),反正 done 时还会再画;
 *   - 修订号必须真的前进 —— **同一修订版本只渲染一次**;
 *   - 两次增量之间至少隔 MIN_INTERVAL_MS (2.8.2: 2000 → 500 ms,
 *     配合修订号去重,节流本身就是限速器,不再另外要求"够多新块")。
 * done 不走这里(它是终态,无条件重建,并把最终修订号记下)。
 */
export const MIN_INTERVAL_MS = 500;

export interface PartialRenderInput {
	status: 'idle' | 'extracting' | 'translating' | 'done' | 'error' | 'no-text-layer';
	/**
	 * 译文修订号 (2.8.2 第三批): 管理器在译文内容**真的变了**时 +1。
	 * 用它而不是"已到块数": 原地重译(单块 replay / 补救)块数不变、内容变了,
	 * 按块数判会漏;而同一批 notify 被重复投递时按块数判又会白重建一次。
	 */
	revision: number;
	/** 上一次画上去的修订号(0 = 还没画过)。 */
	rendered: number;
	/** 上一次增量重建的时刻 (0 = 还没画过)。 */
	lastAt: number;
	now: number;
	/** 这一页在可视窗口内吗。 */
	visible: boolean;
}

/** 纯函数,单测锁死。 */
export function shouldRenderPartial(i: PartialRenderInput): boolean {
	if (i.status !== 'translating' || !i.visible) {
		return false;
	}
	if (i.revision <= i.rendered) {
		return false; // 同一修订版本只渲染一次
	}
	return i.lastAt === 0 || i.now - i.lastAt >= MIN_INTERVAL_MS;
}

/** pumpRenders 对一次重建结果的处置 —— 纯函数,单测锁死。 */
export interface SlotDecision {
	state: 'empty' | 'original' | 'translated';
	/** 是否排进重排队列(与 retryAt 一起构成退避重试)。 */
	dirty: boolean;
	/** 早于此刻不重排;0 = 不设退避。 */
	retryAt: number;
	/** 更新后的降级重试计数。 */
	tries: number;
}

/**
 * 槽状态机 (2.5.2)。
 *
 * 关键在于 'degraded' 与 'original' 必须**分开**处置:泵只重排 'empty' 或
 * slotDirty 的槽,而 slotDirty 只在 manager 通知时置位。所以任何被写成终态的
 * 结果就是"这一页这辈子不会再重建了"。此前 'degraded'(有译文却没重建出来)
 * 被当成 'original' 写死,一次偶发失败 —— 往回翻时 PDF.js 刚销毁该页、底图被
 * LRU 淘汰、fonts 未就绪 —— 就把那一页整个会话钉死在英文,正是"往回翻译文
 * 消失"。
 *
 * 现在 'degraded' 像 false 一样自愈,区别只在画面:false 保持 ghost,
 * 'degraded' 先把原文画上(总比空白强),两者都排进退避重试。
 */
export function nextSlotState(
	result: PageRenderResult,
	degradeTries: number,
	now: number
): SlotDecision {
	if (result === false) {
		// 现在画不了:保持 ghost,过一会儿再来 —— 绝不在同一页上空转。
		return { state: 'empty', dirty: false, retryAt: now + 2500, tries: degradeTries };
	}
	if (result === 'partial') {
		// 半成品页 (2.7.10): 画上去了,但这页还在翻 —— 不是终态,也不是失败。
		// 不排重试(下一批到达时 renderPage 会重新置脏),降级预算不动。
		return { state: 'translated', dirty: false, retryAt: 0, tries: degradeTries };
	}
	if (result === 'degraded') {
		const tries = degradeTries + 1;
		if (tries > MAX_DEGRADED_REBUILDS) {
			// 确定性失败:停在原文,不再空转(用户仍可手动刷新本页)。
			return { state: 'original', dirty: false, retryAt: 0, tries };
		}
		return { state: 'original', dirty: true, retryAt: now + 1200 * tries, tries };
	}
	return { state: result, dirty: false, retryAt: 0, tries: 0 };
}

export interface PaneCallbacks {
	onExplainBlock(pageIndex: number, blockId: string): void;
	onCopyExplanation(): void;
	onSaveExplanationNote(): void;
	/** 菜单栏「解析」按钮 — explain the current PDF selection. */
	onExplainSelection(): void;
	onToggleSync(enabled: boolean): void;
	/**
	 * 菜单栏刷新按钮 — 刷新全部 (强制全量): clears BOTH the page cache and the
	 * per-segment store for the whole document, then re-translates from scratch.
	 */
	onRetranslate(): void;
	/**
	 * 状态胶囊圆环 — 刷新本页 (普通刷新): re-runs the current page but REUSES
	 * qualified cached segments — only untranslated / invalid / unfit segments
	 * cost a fresh request (with a provider pool it rotates the engine, which
	 * changes the segment context and forces a genuine re-translation).
	 */
	onRefreshPage(): void;
	/** 状态胶囊取消 — stop the current page's translation. */
	onCancelPage(): void;
	/** 状态胶囊「查看保留原文」— locate the kept-original segments. */
	onViewPartial(): void;
	/** 状态胶囊 × — dismiss the current persistent task. */
	onDismiss(): void;
	/** 状态胶囊折叠/展开 — the session owns the shared collapsed state. */
	onCollapsedChange(collapsed: boolean): void;
	onSaveNote(): void;
	/** 「更多」菜单「诊断」(2.4.2) — copy the sanitized per-page diagnostics JSON (NO source text). */
	onShowDiagnostics(): void;
	/** 「更多」菜单「语料」(仅 debugLogging) — copy the current page's text-layer spans (CONTAINS source text). */
	onCopyCorpus(): void;
	/** 「更多」菜单「导出诊断文件」(2.8.8) — 整份会话的脱敏诊断写成一个 .jsonl 文件。 */
	onExportDiagnosticsFile(): void;
	/**
	 * 「更多」菜单「导出翻译语料」(2.8.8) — 含原文与译文,**常驻菜单**,
	 * 与调试日志解绑: 调试日志只决定排版探针是否采样,不该拦住语料导出。
	 */
	onExportCorpusFile(): void;
	/** 菜单栏「术语」(2.3.1, item3 · WF-8) — 预览本篇学得的术语并保存到词汇表
	 *  (去重/确认/可撤销;「仅复制 TSV」保留为确认框第二按钮)。 */
	onSaveTerms(): void;
	/** 「更多」菜单「导出」— 导出译文 PDF(单语+对照两份,添加为条目附件)。 */
	onExportPdf(): void;
	onToggleViewKind(kind: 'page' | 'article'): void;
	/** 菜单栏直接切换 — no round-trip through the settings pane. */
	onPickLanguages(source: string, target: string): void;
	onPickProvider(providerId: string): void;
	onOpenSettings(): void;
	onClose(): void;
	onSwapSides(): void;
	onBlockClick(pageIndex: number, blockId: string): void;
	onScrolledToPage(pageIndex: number): void;
	onAcceptPrivacy(): void;
}

interface PageSection {
	marker: HTMLElement;
	blocksHost: HTMLElement;
	status: HTMLElement;
}

export class TranslationPane {
	private host: HTMLElement;
	private doc: Document;
	private strings: PaneStrings;
	private callbacks: PaneCallbacks;

	private scroll!: HTMLElement;
	private articleHost!: HTMLElement;
	private languagePill!: HTMLElement;
	private providerName!: HTMLElement;
	private providerMark!: HTMLElement;
	private syncSwitch!: HTMLElement;

	private pages = new Map<number, PageSection>();
	private selectedBlockId: string | null = null;
	private privacyNoticeEl: HTMLElement | null = null;
	private scrollHandler: (() => void) | null = null;
	private keyHandler: ((event: KeyboardEvent) => void) | null = null;

	/**
	 * 'page'    整页对照 — the page rebuilt with translated body text, read as
	 *           a spread beside the original PDF (default).
	 * 'article' 流式译文 — the translation as a continuous article.
	 */
	private viewKind: 'page' | 'article' = 'page';
	private pageRenderer: ((pageIndex: number, slot: HTMLElement, width: number, signal: AbortSignal) => Promise<PageRenderResult>) | null = null;
	private pageHost: HTMLElement | null = null;
	private currentPage = -1;
	private compareOriginal = false;
	private resizeObserver: { disconnect(): void } | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private explainKeyHandler: ((event: KeyboardEvent) => void) | null = null;
	private viewKindButton: HTMLElement | null = null;
	private sideButton: HTMLElement | null = null;
	private sideFill: HTMLElement | null = null;
	private paneSide: 'left' | 'right' = 'right';
	private providerPill: HTMLElement | null = null;
	private barMenu: HTMLElement | null = null;
	private barMenuDismiss: (() => void) | null = null;
	private langSource = 'auto';
	private langTarget = 'auto';
	private providerChoices: { id: string; displayName: string }[] = [];
	private currentProviderId = '';

	// ---- full-document page list (整页对照) --------------------------------
	/** Page boxes in PDF points, one per page, whether rendered or not. */
	private docPageSizes: { width: number; height: number }[] = [];
	/** One slot element per page, alive for the whole session. */
	private slots: HTMLElement[] = [];
	/** What each slot currently shows. */
	private slotState: ('empty' | 'original' | 'translated')[] = [];
	/** Set when a slot's content is stale (translation arrived, resize…). */
	private slotDirty: boolean[] = [];
	/** Monotonic token per slot — a stale async render must never land. */
	private slotToken: number[] = [];
	/** A failed slot is not retried before this timestamp (no hot spinning). */
	private slotRetryAt: number[] = [];
	/**
	 * 降级重建的重试次数 (2.5.2)。'degraded' = 这页确实有译文,但这一趟重建
	 * 没成,画的是原文。它必须能再试 —— 见 pumpRenders 里的说明。上限防的是
	 * 确定性失败(某页 buildStrictPage 必抛)变成每 2.5 秒一次的永久空转。
	 */
	private slotDegradeTries: number[] = [];
	/** 增量显示: 每槽上次画上去的译文修订号与时刻 (2.8.2)。 */
	private slotRenderedRevision: number[] = [];
	private slotPartialAt: number[] = [];
	/** One render at a time; re-prioritised between renders. */
	private ensureTimer: ReturnType<typeof setTimeout> | null = null;
	/** 渲染泵 (2.8.0 第一批): 当前页优先 + 过时任务取消,逻辑在 renderPump.ts。 */
	private pump: RenderPump = new RenderPump({
		windowOf: () => {
			if (this.viewKind !== 'page' || !this.pageRenderer || !this.slots.length) {
				return null;
			}
			const [first, last] = this.visibleRange(0);
			if (first < 0) {
				return null;
			}
			// 当前页夹到可视范围里 (滚动与阅读器翻页之间总有一小段不同步),
			// buffer=1 = 可视范围前后各预取一页,与 releaseFarSlots 的 2 页
			// 保留窗口配套。
			return { current: Math.max(first, Math.min(last, this.currentPage)), first, last, buffer: 1 };
		},
		needsRender: page => (this.slotState[page] === 'empty' || this.slotDirty[page] === true)
			&& Date.now() >= (this.slotRetryAt[page] ?? 0),
		anyWaiting: () => {
			const [first, last] = this.visibleRange(1);
			for (let i = first; i <= last && i >= 0; i++) {
				if (this.slotState[i] === 'empty' || this.slotDirty[i]) {
					return true;
				}
			}
			return false;
		},
		render: (page, signal) => this.renderSlot(page, signal),
		commit: (page, result, aborted) => this.commitRender(page, result, aborted),
		afterPass: () => this.releaseFarSlots(),
		now: () => Date.now(),
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: handle => {
			if (handle !== null) {
				clearTimeout(handle as ReturnType<typeof setTimeout>);
			}
		},
		schedule: delayMs => {
			if (this.ensureTimer) {
				return;
			}
			this.ensureTimer = setTimeout(() => {
				this.ensureTimer = null;
				this.pump.request();
			}, delayMs);
		}
	});
	/** 每槽一个渲染序号 —— 与在飞任务比对,过时结果绝不落地。 */
	private slotRenderSeq: number[] = [];
	/**
	 * 渲染计量 (2.8.4, 性能第五批: 先量再改)。只有计数与毫秒,随诊断导出。
	 * `cancelled` 大 = 第一批的取消在频繁生效(翻页快),不是故障;
	 * 它与 `layoutMs` 一起看才知道"排版耗时"是被谁吃掉的。
	 */
	private renderStats = { started: 0, committed: 0, cancelled: 0, failed: 0, totalMs: 0 };
	/**
	 * 页位置索引 (2.8.0 第二批): 建一次、二分查,滚动期间零 DOM 读取。
	 * 几何真的变了(页宽 / 缩放 / 页面尺寸)才作废重建。
	 */
	private pageIndex = new CachedPageIndex();
	/** 已挂载内容的页 —— 回收时只看这个集合,不遍历全篇。 */
	private mounted = new Set<number>();
	/** Echo guard: ignore our own programmatic scrolls. */
	private suppressScrollUntil = 0;
	/** Width the slots were laid out for. */
	private layoutWidth = 0;
	/**
	 * CSS px per PDF point at the LEFT reader's current zoom. The translated
	 * page renders at this scale (capped by the pane), so its glyphs are the
	 * same size as the original's — never larger because the pane happens to
	 * be wider than the reader's page display.
	 */
	private displayPxPerPoint = 0;

	private statusCapsule!: StatusCapsule;

	constructor(host: HTMLElement, _title: string, strings: PaneStrings, callbacks: PaneCallbacks) {
		this.host = host;
		this.doc = host.ownerDocument!;
		this.strings = strings;
		this.callbacks = callbacks;
		this.build();
		// The consolidated status capsule (same widget as 覆盖原文 mode). Ring →
		// 刷新本页; the 刷新全部 button lives in the menu bar.
		this.statusCapsule = new StatusCapsule(
			() => ({ doc: this.doc, container: this.host }),
			{
				onCancel: () => this.callbacks.onCancelPage(), // 取消 = 真正停止翻译
				onRetry: () => this.callbacks.onRefreshPage(),
				onViewPartial: () => this.callbacks.onViewPartial(), // 查看保留原文
				onDismiss: () => this.callbacks.onDismiss(), // × 关闭当前通知
				onCollapsedChange: (c) => this.callbacks.onCollapsedChange(c), // 折叠状态上报会话
				onRefreshRing: () => this.callbacks.onRefreshPage() // 圆环 = 刷新本页
			},
			(doc) => {
				if (!doc.getElementById('pm-capsule-style')) {
					const style = doc.createElementNS(HTML_NS, 'style') as HTMLStyleElement;
					style.id = 'pm-capsule-style';
					style.textContent = CAPSULE_CSS;
					(doc.head ?? doc.documentElement).appendChild(style);
				}
			}
		);
	}

	/** Rich per-page progress → the pane's status capsule (对照翻译 mode). */
	setProgress(model: OverlayProgress | null): void {
		this.statusCapsule.setProgress(model);
	}

	// ---- element helpers ----------------------------------------------------

	private el(tag: string, className?: string, text?: string): HTMLElement {
		const node = this.doc.createElementNS(HTML_NS, tag) as HTMLElement;
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}

	private svgIcon(paths: string): Element {
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		for (const d of paths.split(' M').map((p, i) => (i === 0 ? p : 'M' + p))) {
			const path = this.doc.createElementNS(SVG_NS, 'path');
			path.setAttribute('d', d);
			svg.appendChild(path);
		}
		return svg;
	}

	private iconButton(pathD: string, title: string, onClick: () => void, extraClass = ''): HTMLElement {
		const btn = this.el('button', `pm-icon-button${extraClass ? ' ' + extraClass : ''}`);
		btn.setAttribute('title', title);
		btn.setAttribute('aria-label', title);
		btn.appendChild(this.svgIcon(pathD));
		btn.addEventListener('click', onClick);
		return btn;
	}

	private textButton(className: string, label: string, title: string, onClick: () => void): HTMLElement {
		const btn = this.el('button', className, label);
		btn.setAttribute('title', title);
		btn.addEventListener('click', onClick);
		return btn;
	}

	/**
	 * 「更多」三点图标 (2.4.2): 低频动作收进一个菜单 —— 导出译文 PDF 与诊断
	 * 常驻;语料仅在开启调试日志时出现(P0-2 隐私姿态: 它含整页原文,不在普通
	 * 用户一层可见)。菜单每次点开现读 pref,无需常驻观察者。
	 * 诊断与语料是两个动作 (审核 P0-2): 诊断只含脱敏指标(引擎自检段一并产出);
	 * 语料含整页原文,名字和提示都明说。
	 */
	private buildMoreButton(): HTMLElement {
		let moreChip: HTMLElement;
		moreChip = this.iconButton(ICON_PATHS.more, '更多:导出译文 PDF、诊断', () => {
			const items: { label: string; checked: boolean; onPick(): void }[] = [
				{ label: '导出译文 PDF(单语 + 对照两份)', checked: false, onPick: () => this.callbacks.onExportPdf() },
				// 2.8.8 (导出方案 P3): 两个文件导出入口。语料**常驻**,与调试日志解绑。
				{ label: '导出诊断文件(整篇;不含原文/译文/密钥)', checked: false, onPick: () => this.callbacks.onExportDiagnosticsFile() },
				{ label: '导出翻译语料(整篇;含原文与译文)', checked: false, onPick: () => this.callbacks.onExportCorpusFile() },
				{ label: '诊断:复制脱敏指标 + 引擎自检(不含原文/密钥)', checked: false, onPick: () => this.callbacks.onShowDiagnostics() }
			];
			if (getPref<boolean>('debugLogging', false)) {
				items.push({ label: '语料:复制本页布局语料(含本页原文)', checked: false, onPick: () => this.callbacks.onCopyCorpus() });
			}
			this.openBarMenu(moreChip, [{ items }]);
		});
		return moreChip;
	}

	/** demo .switch-label — label + iOS-style toggle */
	private switchControl(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
		const wrap = this.el('span', 'pm-switch-label');
		wrap.setAttribute('data-pm-on', String(initial));
		wrap.setAttribute('title', label);
		wrap.setAttribute('role', 'switch');
		wrap.append(this.el('span', 'pm-switch'), this.el('span', undefined, label));
		wrap.addEventListener('click', () => {
			const next = wrap.getAttribute('data-pm-on') !== 'true';
			wrap.setAttribute('data-pm-on', String(next));
			onChange(next);
		});
		return wrap;
	}

	// ---- structure (demo/index.html) ----------------------------------------

	/** Human label for a language code, for the in-bar menus. */
	private static langLabel(code: string): string {
		const MAP: Record<string, string> = {
			'auto': '自动', 'en': 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文',
			'ja': '日本語', 'ko': '한국어', 'fr': 'Français', 'de': 'Deutsch',
			'es': 'Español', 'ru': 'Русский'
		};
		return MAP[code] ?? code;
	}

	private closeBarMenu(): void {
		this.barMenu?.remove();
		this.barMenu = null;
		if (this.barMenuDismiss) {
			this.doc.removeEventListener('click', this.barMenuDismiss, true);
			this.barMenuDismiss = null;
		}
	}

	/**
	 * One dropdown component for every bar chip. Anchored under its chip,
	 * dismissed by any click elsewhere — switching language or engine is a
	 * two-click affair, never a trip through the settings pane.
	 */
	private openBarMenu(
		anchor: HTMLElement,
		sections: { title?: string; items: { badge?: Element; label: string; checked: boolean; onPick(): void }[] }[]
	): void {
		if (this.barMenu?.getAttribute('data-pm-anchor') === anchor.className) {
			this.closeBarMenu();
			return;
		}
		this.closeBarMenu();
		const menu = this.el('div', 'pm-bar-menu');
		menu.setAttribute('data-pm-anchor', anchor.className);
		for (const section of sections) {
			if (section.title) {
				menu.appendChild(this.el('div', 'pm-bar-menu-title', section.title));
			}
			for (const item of section.items) {
				// div 而非 button (2.6.2): Zotero 阅读器文档里 HTML button 的内部
				// 布局不随折行内容长高 —— 2.6.1 让标签折行后,行与行叠印、菜单
				// 底部截字。div 没有 UA 内部盒,折行即长高;键盘可达性用
				// tabindex + Enter/Space 补回。
				const row = this.el('div', 'pm-bar-menu-item');
				row.setAttribute('role', 'menuitemradio');
				row.setAttribute('tabindex', '0');
				row.setAttribute('aria-checked', String(item.checked));
				if (item.badge) {
					row.appendChild(item.badge);
				}
				row.appendChild(this.el('span', 'pm-bar-menu-label', item.label));
				const pick = (event: Event): void => {
					event.stopPropagation();
					this.closeBarMenu();
					item.onPick();
				};
				row.addEventListener('click', pick);
				row.addEventListener('keydown', (event) => {
					if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') {
						(event as KeyboardEvent).preventDefault();
						pick(event);
					}
				});
				menu.appendChild(row);
			}
		}
		const hostRect = this.host.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		menu.style.top = `${anchorRect.bottom - hostRect.top + 4}px`;
		menu.style.left = `${Math.max(6, anchorRect.left - hostRect.left)}px`;
		this.host.appendChild(menu);
		// Keep it on screen when the chip sits near the right edge.
		const overflow = menu.getBoundingClientRect().right - hostRect.right + 8;
		if (overflow > 0) {
			menu.style.left = `${Math.max(6, anchorRect.left - hostRect.left - overflow)}px`;
		}
		this.barMenu = menu;
		this.barMenuDismiss = () => this.closeBarMenu();
		setTimeout(() => {
			if (this.barMenuDismiss) {
				this.doc.addEventListener('click', this.barMenuDismiss, true);
			}
		}, 0);
	}

	private openLanguageMenu(): void {
		const SOURCES = ['auto', 'en', 'zh-CN', 'ja', 'ko', 'de', 'fr'];
		const TARGETS = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
		this.openBarMenu(this.languagePill, [
			{
				title: '源语言',
				items: SOURCES.map(code => ({
					label: code === 'auto' ? '自动检测' : TranslationPane.langLabel(code),
					checked: this.langSource === code,
					onPick: () => this.callbacks.onPickLanguages(code, this.langTarget)
				}))
			},
			{
				title: '目标语言',
				items: TARGETS.map(code => ({
					label: code === 'auto' ? '自动（与源语言配对）' : TranslationPane.langLabel(code),
					checked: this.langTarget === code,
					onPick: () => this.callbacks.onPickLanguages(this.langSource, code)
				}))
			}
		]);
	}

	private openProviderMenu(): void {
		if (!this.providerPill || !this.providerChoices.length) {
			this.callbacks.onOpenSettings();
			return;
		}
		this.openBarMenu(this.providerPill, [
			{
				title: '翻译服务',
				items: this.providerChoices.map(choice => ({
					badge: this.providerBadge(choice.id),
					label: choice.displayName,
					checked: this.currentProviderId === choice.id,
					onPick: () => this.callbacks.onPickProvider(choice.id)
				}))
			},
			{
				items: [{
					label: this.strings.settings + '…',
					checked: false,
					onPick: () => this.callbacks.onOpenSettings()
				}]
			}
		]);
	}

	/** The engine roster for the in-bar switcher, supplied by the session. */
	setProviderChoices(choices: { id: string; displayName: string }[], currentId: string): void {
		this.providerChoices = choices;
		this.currentProviderId = currentId;
	}

	/** Current language codes, so the menus can mark the active entries. */
	setLanguageCodes(source: string, target: string): void {
		this.langSource = source;
		this.langTarget = target;
	}

	/**
	 * The OFFICIAL vector mark for a service, from the vendored lobe-icons
	 * SVGs. Monochrome marks (OpenAI, Groq, Ollama, OpenRouter) carry
	 * fill="currentColor" and follow the pane's text colour in both themes.
	 * Returns null for unbranded ids (compatible/custom) or if parsing is
	 * unavailable — the caller then falls back to the drawn glyph.
	 */
	private realBrandBadge(id: string): Element | null {
		const source = BRAND_SVGS[id];
		if (!source) {
			return null;
		}
		try {
			const win = this.doc.defaultView as (Window & { DOMParser?: typeof DOMParser }) | null;
			const Parser = win?.DOMParser ?? (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
			if (!Parser) {
				return null;
			}
			const parsed = new Parser().parseFromString(source, 'image/svg+xml');
			const rootEl = parsed.documentElement;
			if (!rootEl || rootEl.nodeName.toLowerCase() !== 'svg') {
				return null;
			}
			const svg = this.doc.importNode(rootEl, true) as Element;
			svg.setAttribute('class', 'pm-provider-badge');
			svg.setAttribute('width', '16');
			svg.setAttribute('height', '16');
			svg.removeAttribute('style'); // drop the icon set's flex inline style
			return svg;
		}
		catch (e) {
			logger.debug(MODULE, `brand svg for ${id} failed to parse`, e);
			return null;
		}
	}

	/**
	 * A small brand badge per translation service. Real official marks first
	 * (realBrandBadge); the code-drawn glyphs below survive only as a fallback
	 * and for the unbranded generic endpoints. One function, used by the
	 * header chip and the switcher menu, so the two can never disagree.
	 */
	private providerBadge(id: string): Element {
		const real = this.realBrandBadge(id);
		if (real) {
			return real;
		}
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('class', 'pm-provider-badge');
		const node = (name: string, attrs: Record<string, string>, text?: string): Element => {
			const el = this.doc.createElementNS(SVG_NS, name);
			for (const [k, v] of Object.entries(attrs)) {
				el.setAttribute(k, v);
			}
			if (text !== undefined) {
				el.textContent = text;
			}
			return el;
		};
		const tile = (fill: string): Element => node('rect', { x: '.5', y: '.5', width: '15', height: '15', rx: '3.5', fill });

		switch (id) {
			case 'openai-compatible':
			case 'custom': {
				// No brand to borrow: a neutral endpoint glyph.
				svg.append(tile('#3A4150'),
					node('circle', { cx: '8', cy: '8', r: '4.4', fill: 'none', stroke: '#fff', 'stroke-width': '1.1' }),
					node('path', { d: 'M3.6 8h8.8M8 3.6c1.5 1.3 1.5 7.5 0 8.8M8 3.6c-1.5 1.3-1.5 7.5 0 8.8', fill: 'none', stroke: '#fff', 'stroke-width': '.9' })
				);
				return svg;
			}
			default:
				svg.append(tile('#5b6472'), node('text', {
					x: '8', y: '8.5', fill: '#fff', 'text-anchor': 'middle', 'dominant-baseline': 'central',
					'font-family': 'Inter, system-ui, sans-serif', 'font-weight': '700', 'font-size': '8'
				}, (id[0] ?? '?').toUpperCase()));
				return svg;
		}
	}

	/** The plugin mark — the split card, in miniature, in colour. */
	private makeBrandIcon(): HTMLElement {
		const wrap = this.el('span', 'pm-brand');
		wrap.setAttribute('title', this.strings.title);
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		const node = (name: string, attrs: Record<string, string>): Element => {
			const el = this.doc.createElementNS(SVG_NS, name);
			for (const [k, v] of Object.entries(attrs)) {
				el.setAttribute(k, v);
			}
			return el;
		};
		const defs = this.doc.createElementNS(SVG_NS, 'defs');
		const grad = node('linearGradient', { id: 'pm-brand-grad', x1: '0', y1: '0', x2: '0', y2: '1' });
		grad.appendChild(node('stop', { offset: '0', 'stop-color': '#96abf1' }));
		grad.appendChild(node('stop', { offset: '1', 'stop-color': '#6f6ce8' }));
		defs.appendChild(grad);
		svg.appendChild(defs);
		svg.appendChild(node('path', {
			d: 'M8 2.4H3.9A1.9 1.9 0 0 0 2 4.3v7.4a1.9 1.9 0 0 0 1.9 1.9H8Z',
			fill: '#f7f8fa', stroke: 'rgba(0,0,0,.26)', 'stroke-width': '.6'
		}));
		svg.appendChild(node('path', {
			d: 'M8 1.9h4.1A1.9 1.9 0 0 1 14 3.8v7.9a1.9 1.9 0 0 1-1.9 1.9H8Z',
			fill: 'url(#pm-brand-grad)'
		}));
		svg.appendChild(node('rect', { x: '3.4', y: '4.25', width: '3', height: '1.13', rx: '.56', fill: '#1c1e24' }));
		svg.appendChild(node('rect', { x: '3.4', y: '6.6', width: '3.4', height: '.88', rx: '.44', fill: '#9096a0' }));
		svg.appendChild(node('circle', { cx: '9.5', cy: '3.1', r: '.58', fill: '#37c871' }));
		svg.appendChild(node('rect', { x: '9', y: '4.25', width: '3.2', height: '1.13', rx: '.56', fill: '#ffffff' }));
		svg.appendChild(node('rect', { x: '9', y: '6.6', width: '3.6', height: '.88', rx: '.44', fill: 'rgba(255,255,255,.72)' }));
		wrap.appendChild(svg);
		return wrap;
	}

	/**
	 * The layout-swap button. Not a generic arrow: it DRAWS the current
	 * arrangement — two panels side by side, the translation's one filled —
	 * so the button says which side the translation is on before you click it.
	 */
	private makeSideButton(): HTMLElement {
		const btn = this.el('button', 'pm-icon-button pm-side-toggle');
		btn.setAttribute('title', this.strings.swapSides);
		btn.setAttribute('aria-label', this.strings.swapSides);
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		const frame = this.doc.createElementNS(SVG_NS, 'rect');
		frame.setAttribute('x', '3');
		frame.setAttribute('y', '5');
		frame.setAttribute('width', '18');
		frame.setAttribute('height', '14');
		frame.setAttribute('rx', '2.5');
		svg.appendChild(frame);
		const divider = this.doc.createElementNS(SVG_NS, 'path');
		divider.setAttribute('d', 'M12 5v14');
		svg.appendChild(divider);
		// The filled half marks where the translation lives.
		const fill = this.doc.createElementNS(SVG_NS, 'rect');
		fill.setAttribute('class', 'pm-side-fill');
		fill.setAttribute('y', '5');
		fill.setAttribute('width', '9');
		fill.setAttribute('height', '14');
		svg.appendChild(fill);
		btn.appendChild(svg);
		btn.addEventListener('click', () => this.callbacks.onSwapSides());
		this.sideButton = btn;
		this.sideFill = fill as unknown as HTMLElement;
		this.setPaneSide(this.paneSide);
		return btn;
	}

	/** Which side the translation pane is on — drives the swap button's icon. */
	setPaneSide(side: 'left' | 'right'): void {
		this.paneSide = side;
		if (!this.sideFill || !this.sideButton) {
			return;
		}
		this.sideFill.setAttribute('x', side === 'right' ? '12' : '3');
		this.sideButton.setAttribute('data-pm-side', side);
	}

	private build(): void {
		// --- header: one row, fixed left-to-right order.
		//   icon · languages · engine · refresh · status · sync · save ·
		//   layout · settings · close
		const header = this.el('div', 'pm-header');
		const bar = this.el('div', 'pm-bar');

		// Three zones, in the fixed order 图标 · 语言 · 引擎 · 刷新 · 同步滚动 ·
		// 保存到笔记 · 布局 · 设置 · 关闭 — but grouped so the eye can find
		// things: what is being translated (left), what to do with it (middle),
		// what to do with the window (right). Hairlines mark the seams.
		bar.appendChild(this.makeBrandIcon());

		this.languagePill = this.el('button', 'pm-chip pm-chip-lang');
		this.languagePill.setAttribute('title', '切换语言');
		this.languagePill.addEventListener('click', (event) => {
			event.stopPropagation();
			this.openLanguageMenu();
		});

		const providerPill = this.el('button', 'pm-chip pm-chip-provider');
		this.providerPill = providerPill;
		providerPill.setAttribute('title', '切换翻译服务');
		this.providerMark = this.el('span', 'pm-provider-mark');
		this.providerName = this.el('span', 'pm-provider-name', '');
		providerPill.append(this.providerMark, this.providerName);
		providerPill.addEventListener('click', (event) => {
			event.stopPropagation();
			this.openProviderMenu();
		});

		this.syncSwitch = this.switchControl(this.strings.syncScroll, true, on => this.callbacks.onToggleSync(on));

		// 刷新按钮 (2.3.8 恢复直达): 点击即「清缓存重译全文」(readerSession 侧
		// 带确认对话框,破坏性动作不裸奔);悬停 tooltip 说明后果。轻量「修复
		// 本页」仍在状态胶囊圆环上,不占菜单栏。
		const refreshChip = this.iconButton(
			ICON_PATHS.refresh,
			'全文重译(丢失已翻译内容)',
			() => this.callbacks.onRetranslate(),
			'pm-refresh'
		);

		bar.append(
			this.languagePill,
			providerPill,
			refreshChip,
			this.el('span', 'pm-bar-spacer'),
			this.syncSwitch,
			this.textButton('pm-bar-action', `✦ ${this.strings.explainSelection}`, this.strings.explainTip, () => this.callbacks.onExplainSelection()),
			this.textButton('pm-bar-action', this.strings.saveNote, this.strings.saveNote, () => this.callbacks.onSaveNote()),
			this.textButton('pm-bar-action', '术语', '预览本篇自动学得的术语,可保存到词汇表(可撤销)或仅复制 TSV', () => this.callbacks.onSaveTerms()),
			this.buildMoreButton(),
			this.el('span', 'pm-bar-sep'),
			this.makeSideButton(),
			this.iconButton(ICON_PATHS.settings, this.strings.settings, () => this.callbacks.onOpenSettings()),
			this.iconButton(ICON_PATHS.close, this.strings.close, () => this.callbacks.onClose())
		);

		header.append(bar);

		// --- scroll body
		this.scroll = this.el('div', 'pm-scroll');
		this.scroll.setAttribute('data-pm-view', this.viewKind);
		this.articleHost = this.el('div', 'pm-article-host');
		this.scroll.append(this.articleHost);
		this.scrollHandler = () => this.handleScroll();
		this.scroll.addEventListener('scroll', this.scrollHandler, { passive: true });

		// Every notification — task, error AND transient success — now lives in
		// the StatusCapsule. There is no separate bottom toast module anymore.
		this.host.append(header, this.scroll);

		this.keyHandler = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				this.hideExplanation();
			}
		};
		this.doc.addEventListener('keydown', this.keyHandler);
	}

	// ---- scroll anchoring ---------------------------------------------------

	/** Keep the topmost visible paragraph in place across a layout change. */
	private preserveScroll(mutate: () => void): void {
		const anchor = this.topmostVisibleBlock();
		const beforeTop = anchor?.getBoundingClientRect().top ?? 0;
		mutate();
		if (!anchor) {
			return;
		}
		const afterTop = anchor.getBoundingClientRect().top;
		this.scroll.scrollTop += afterTop - beforeTop;
	}

	private topmostVisibleBlock(): HTMLElement | null {
		const rect = this.scroll.getBoundingClientRect();
		for (const block of Array.from(this.articleHost.querySelectorAll('.pm-block'))) {
			if (block.getBoundingClientRect().bottom > rect.top + 4) {
				return block as HTMLElement;
			}
		}
		return null;
	}

	// ---- public state setters -----------------------------------------------

	setTheme(theme: 'light' | 'dark'): void {
		this.host.setAttribute('data-pm-theme', theme);
	}

	setArticleFontSize(px: number): void {
		this.host.style.setProperty('--pm-article-size', `${Math.min(22, Math.max(12, px))}px`);
	}

	/**
	 * 显示原文对照.
	 *   article view — show the small source line above each translation.
	 *   page view    — lift the mask so the ORIGINAL page shows through the
	 *                  rebuilt one, for a direct read against the source.
	 */
	setShowOriginal(enabled: boolean): void {
		this.host.setAttribute('data-pm-show-original', String(enabled));
		this.compareOriginal = enabled;
		this.applyCompareState();
	}

	setSyncEnabled(enabled: boolean): void {
		this.syncSwitch?.setAttribute('data-pm-on', String(enabled));
	}

	setLanguagePair(source: string, target: string): void {
		// One chip, both languages. Two separate truncating pills turned this
		// into "Eng… → 简体…", which tells the reader nothing.
		this.languagePill.replaceChildren(
			this.el('span', 'pm-lang-from', source),
			this.el('i', 'pm-lang-arrow', '→'),
			this.el('span', 'pm-lang-to', target)
		);
	}

	setProviderInfo(displayName: string, providerId?: string): void {
		this.providerName.textContent = displayName;
		this.providerMark.replaceChildren();
		if (providerId) {
			this.currentProviderId = providerId;
			this.providerMark.appendChild(this.providerBadge(providerId));
		}
	}

	setBusy(busy: boolean): void {
		this.host.classList.toggle('pm-refreshing', busy);
	}

	/** Mirror the session-owned collapsed state onto this surface's capsule. */
	setCollapsed(collapsed: boolean): void {
		this.statusCapsule.setCollapsed(collapsed);
	}

	// ---- privacy notice -----------------------------------------------------

	showPrivacyNotice(hostName: string): void {
		if (this.privacyNoticeEl) {
			return;
		}
		const notice = this.el('div', 'pm-bilingual-notice');
		// 首次引导 (2.3.3, 第四批 item5 · WF-3): 新用户在这张卡上往往还没配置任何
		// 服务 —— 加一个「配置翻译服务 →」直达设置页,不必先接受再自己找设置。
		const actions = this.el('div', 'pm-notice-actions');
		actions.append(
			this.textButton('pm-footer-button', '配置翻译服务 →', '打开设置选择翻译服务商 / 填写 API Key', () => this.callbacks.onOpenSettings()),
			this.textButton('pm-footer-button pm-primary', this.strings.privacyAccept, this.strings.privacyAccept, () => {
				notice.remove();
				this.privacyNoticeEl = null;
				this.callbacks.onAcceptPrivacy();
			})
		);
		notice.append(
			this.el('div', undefined, this.strings.privacyNotice),
			this.el('div', 'pm-notice-host', `→ ${hostName}`),
			actions
		);
		this.articleHost.before(notice);
		this.privacyNoticeEl = notice;
	}

	// ---- explain card (demo .explain-card) ----------------------------------

	showExplanation(content: { loading?: boolean; sections?: ExplanationSection[]; error?: string; passage?: string }): void {
		// The card FLOATS over the pane's lower edge — it must never touch the
		// scroll position. The old behaviour prepended it into the scroll body
		// and jumped to the top of the document, which read as "everything I
		// was looking at just vanished".
		let card = this.host.querySelector('.pm-explain-card') as HTMLElement | null;
		if (!card) {
			card = this.el('div', 'pm-explain-card pm-explain-floating');
			const head = this.el('div', 'pm-card-head');
			const titles = this.el('div', 'pm-card-titles');
			titles.append(
				this.el('strong', undefined, this.strings.explainTitle),
				this.el('small', 'pm-explain-passage', this.strings.explainSubtitle)
			);
			const closeBtn = this.el('button', 'pm-card-close', '×');
			closeBtn.setAttribute('title', this.strings.close);
			closeBtn.addEventListener('click', () => this.hideExplanation());
			head.append(this.el('span', 'pm-sparkle', '✦'), titles, closeBtn);

			const grid = this.el('div', 'pm-explain-grid');
			const actions = this.el('div', 'pm-explain-actions');
			actions.append(
				this.textButton('pm-footer-button', this.strings.explainCopy, this.strings.explainCopy, () => this.callbacks.onCopyExplanation()),
				this.textButton('pm-footer-button', this.strings.explainSave, this.strings.explainSave, () => this.callbacks.onSaveExplanationNote())
			);
			card.append(head, grid, actions);
			this.host.append(card);
			// Esc dismisses — there must always be an obvious way out.
			this.explainKeyHandler = (event: KeyboardEvent): void => {
				if (event.key === 'Escape') {
					this.hideExplanation();
				}
			};
			this.doc.addEventListener('keydown', this.explainKeyHandler, true);
		}

		const passageEl = card.querySelector('.pm-explain-passage') as HTMLElement;
		const grid = card.querySelector('.pm-explain-grid') as HTMLElement;
		const actions = card.querySelector('.pm-explain-actions') as HTMLElement;

		if (content.passage !== undefined) {
			passageEl.textContent = content.passage || this.strings.explainSubtitle;
			passageEl.setAttribute('title', content.passage);
		}
		if (content.loading) {
			grid.replaceChildren();
			const loading = this.el('div', 'pm-explain-section');
			const p = this.el('p');
			p.append(this.el('span', 'pm-bilingual-spinner'), this.doc.createTextNode('…'));
			loading.append(p);
			grid.append(loading);
			actions.hidden = true;
		}
		else if (content.error !== undefined) {
			grid.replaceChildren();
			const err = this.el('div', 'pm-explain-section pm-error');
			err.append(this.el('p', undefined, content.error));
			grid.append(err);
			actions.hidden = true;
		}
		else if (content.sections) {
			grid.replaceChildren();
			for (const section of content.sections) {
				const sec = this.el('div', 'pm-explain-section');
				if (section.label) {
					sec.append(this.el('b', undefined, section.label));
				}
				sec.append(this.el('p', undefined, section.text));
				grid.append(sec);
			}
			actions.hidden = false;
		}
	}

	hideExplanation(): void {
		if (this.explainKeyHandler) {
			this.doc.removeEventListener('keydown', this.explainKeyHandler, true);
			this.explainKeyHandler = null;
		}
		this.host.querySelector('.pm-explain-card')?.remove();
	}

	// ---- pages & blocks -----------------------------------------------------

	private ensurePageSection(pageIndex: number): PageSection {
		let section = this.pages.get(pageIndex);
		if (section) {
			return section;
		}
		const marker = this.el('div', 'pm-page-marker');
		marker.setAttribute('data-pm-page', String(pageIndex));
		marker.append(
			this.el('span', undefined, `${this.strings.pagePrefix} ${pageIndex + 1} ${this.strings.pageSuffix}`.trim()),
			this.el('i')
		);
		const status = this.el('div', 'pm-status-inline');
		const blocksHost = this.el('div');
		blocksHost.setAttribute('data-pm-page-host', String(pageIndex));
		section = { marker, blocksHost, status };
		this.pages.set(pageIndex, section);
		const after = [...this.pages.keys()].filter(p => p > pageIndex).sort((a, b) => a - b)[0];
		const anchor = after !== undefined ? this.pages.get(after)!.marker : null;
		this.preserveScroll(() => {
			if (anchor) {
				this.articleHost.insertBefore(marker, anchor);
				this.articleHost.insertBefore(status, anchor);
				this.articleHost.insertBefore(blocksHost, anchor);
			}
			else {
				this.articleHost.append(marker, status, blocksHost);
			}
		});
		return section;
	}

	// ---- 整页对照 -----------------------------------------------------------

	/**
	 * Install the page renderer. The session owns it because rendering needs
	 * the reader and the translation state; the pane only decides WHICH pages
	 * to render and when. The renderer resolves to what the slot now shows —
	 * 'translated', 'original' (translation not finished yet), or false when
	 * the page could not be rendered at all.
	 */
	setPageRenderer(renderer: (pageIndex: number, slot: HTMLElement, width: number, signal: AbortSignal) => Promise<PageRenderResult>): void {
		this.pageRenderer = renderer;
		this.observeResize();
	}

	setViewKind(kind: 'page' | 'article'): void {
		if (this.viewKind === kind) {
			return;
		}
		this.viewKind = kind;
		this.scroll.setAttribute('data-pm-view', kind);
		this.articleHost.replaceChildren();
		this.pages.clear();
		this.pageHost = null;
		this.slots = [];
		this.slotState = [];
		this.slotDirty = [];
		this.slotToken = [];
		this.slotRetryAt = [];
		this.slotDegradeTries = [];
		this.slotRenderedRevision = [];
		this.slotPartialAt = [];
		this.slotRenderSeq = [];
		this.mounted.clear();
		this.invalidatePageIndex();
		this.pump.cancelAll();
		this.refreshViewKindButton();
		if (kind === 'page') {
			this.initPageList();
		}
	}

	/**
	 * The pane's two readings of the same text: 文章流 is complete and never
	 * clips; 整页对照 rebuilds the page's own layout beside the original. The
	 * button offers the OTHER one.
	 */
	private refreshViewKindButton(): void {
		if (!this.viewKindButton) {
			return;
		}
		const label = this.viewKind === 'page' ? this.strings.viewArticle : this.strings.viewPage;
		this.viewKindButton.textContent = label;
		this.viewKindButton.setAttribute('title', label);
	}

	getViewKind(): 'page' | 'article' {
		return this.viewKind;
	}

	/** Width a page gets, in CSS px — nearly edge to edge of the pane. */
	private pageWidthAvailable(): number {
		const scrollW = this.scroll.clientWidth || this.host.clientWidth;
		return Math.max(160, (scrollW || 400) - 20);
	}

	/**
	 * Pane resized: re-lay the slots out at the new width and re-render what
	 * is on screen. Debounced — a divider drag fires continuously, and each
	 * re-render costs real canvases.
	 */
	private observeResize(): void {
		const view = this.doc.defaultView as (Window & { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } }) | null;
		if (!view?.ResizeObserver || this.resizeObserver) {
			return;
		}
		const observer = new view.ResizeObserver(() => {
			if (this.viewKind !== 'page' || !this.slots.length) {
				return;
			}
			if (Math.abs(this.pageWidthAvailable() - this.layoutWidth) < 8) {
				return;
			}
			if (this.resizeTimer) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.relayoutSlots();
			}, 180);
		});
		observer.observe(this.scroll);
		this.resizeObserver = observer;
	}

	private relayoutSlots(force = false): void {
		const fresh = this.pageWidthAvailable();
		if (!force && Math.abs(fresh - this.layoutWidth) < 8) {
			return;
		}
		// Keep the same document position through the resize.
		const anchorFraction = this.scroll.scrollHeight > 0
			? this.scroll.scrollTop / this.scroll.scrollHeight
			: 0;
		this.layoutWidth = fresh;
		// 页宽/缩放变了 —— 位置索引整体作废 (2.8.0 第二批)。
		this.invalidatePageIndex();
		for (let i = 0; i < this.slots.length; i++) {
			this.sizeSlot(this.slots[i]!, i);
			// Content was built for the old width: release it.
			if (this.slotState[i] !== 'empty') {
				this.slotToken[i]!++;
				this.slotState[i] = 'empty';
				this.slots[i]!.replaceChildren(this.makeGhost(i));
			}
		}
		this.mounted.clear();
		this.scroll.scrollTop = anchorFraction * this.scroll.scrollHeight;
		this.scheduleEnsure();
	}

	/**
	 * 整页对照 now shows the WHOLE document: one slot per page, laid out from
	 * the page boxes before anything is rendered, so the scrollbar and page
	 * positions are correct from the first frame. Pages render lazily around
	 * the viewport — the original page while its translation is pending, the
	 * rebuilt translated page once it is done.
	 */
	setDocumentPages(sizes: { width: number; height: number }[]): void {
		this.docPageSizes = sizes;
		if (this.viewKind === 'page') {
			this.initPageList();
		}
	}

	/** The reader zoomed — match it. */
	setDisplayScale(pxPerPoint: number): void {
		if (!Number.isFinite(pxPerPoint) || pxPerPoint <= 0) {
			return;
		}
		if (Math.abs(pxPerPoint - this.displayPxPerPoint) < 0.005) {
			return;
		}
		this.displayPxPerPoint = pxPerPoint;
		if (this.viewKind === 'page' && this.slots.length) {
			this.relayoutSlots(true);
		}
	}

	/** Target CSS width for one page: the reader's display width, pane-capped. */
	private slotWidthFor(pageIndex: number): number {
		const available = this.pageWidthAvailable();
		const size = this.docPageSizes[pageIndex];
		if (!size || this.displayPxPerPoint <= 0) {
			return available;
		}
		return Math.min(available, Math.round(size.width * this.displayPxPerPoint));
	}

	private initPageList(): void {
		if (!this.docPageSizes.length) {
			return;
		}
		const host = this.ensurePageHost();
		this.layoutWidth = this.pageWidthAvailable();
		this.slots = [];
		this.slotState = [];
		this.slotDirty = [];
		this.slotToken = [];
		this.slotRetryAt = [];
		this.slotDegradeTries = [];
		this.slotRenderedRevision = [];
		this.slotPartialAt = [];
		this.slotRenderSeq = [];
		this.mounted.clear();
		this.invalidatePageIndex();
		const children: HTMLElement[] = [];
		for (let i = 0; i < this.docPageSizes.length; i++) {
			const slot = this.el('div', 'pm-repage-slot');
			slot.setAttribute('data-pm-slot', String(i));
			this.sizeSlot(slot, i);
			slot.appendChild(this.makeGhost(i));
			this.slots.push(slot);
			this.slotState.push('empty');
			this.slotDirty.push(false);
			this.slotToken.push(0);
			this.slotRetryAt.push(0);
			this.slotDegradeTries.push(0);
			this.slotRenderedRevision.push(0);
			this.slotPartialAt.push(0);
			this.slotRenderSeq.push(0);
			children.push(
				this.el('div', 'pm-repage-page-label',
					`${this.strings.pagePrefix} ${i + 1} ${this.strings.pageSuffix}`.trim()),
				slot
			);
		}
		host.replaceChildren(...children);
		this.scheduleEnsure();
	}

	private sizeSlot(slot: HTMLElement, pageIndex: number): void {
		const size = this.docPageSizes[pageIndex]!;
		const width = this.slotWidthFor(pageIndex);
		slot.style.width = `${width}px`;
		slot.style.height = `${Math.round(width * (size.height / size.width))}px`;
	}

	/** Placeholder shown before a page renders and after it is released. */
	private makeGhost(pageIndex: number): HTMLElement {
		const ghost = this.el('div', 'pm-repage-ghost');
		ghost.append(
			this.el('span', 'pm-bilingual-spinner'),
			this.el('span', undefined, String(pageIndex + 1))
		);
		return ghost;
	}

	private ensurePageHost(): HTMLElement {
		if (this.pageHost) {
			return this.pageHost;
		}
		const host = this.el('div', 'pm-repage-host');
		this.pageHost = host;
		this.articleHost.replaceChildren(host);
		return host;
	}

	// ---- virtualisation -----------------------------------------------------

	/** Slots intersecting the viewport, expanded by `buffer` pages each way. */
	/**
	 * 页位置索引 —— 没有就建一次。**一趟批量读完**所有槽的几何,读写不交错。
	 */
	private ensurePageIndex(): PageOffsetIndex | null {
		return this.pageIndex.get(this.slots.length, page => {
			const slot = this.slots[page]!;
			return { top: slot.offsetTop, height: slot.offsetHeight };
		});
	}

	/**
	 * 这一页此刻还挂在面板上吗 (2.8.3, 性能第四批): 管理器据此决定能不能卸掉
	 * 它的完整内容 —— 正挂着的页卸掉会当场变回原文。
	 */
	/** 渲染计量的只读快照 (2.8.4)。 */
	renderMetrics(): { started: number; committed: number; cancelled: number; failed: number; totalMs: number } {
		return { ...this.renderStats };
	}

	hasMountedPage(pageIndex: number): boolean {
		return this.mounted.has(pageIndex) || this.pump.busyPage === pageIndex;
	}

	/** 几何变了(页宽 / 缩放 / 页面尺寸): 索引整体作废。滚动不会让它失效。 */
	private invalidatePageIndex(): void {
		this.pageIndex.invalidate();
	}

	private visibleRange(buffer: number): [number, number] {
		const index = this.ensurePageIndex();
		const last = this.slots.length - 1;
		if (!index) {
			return [0, Math.min(last, buffer)];
		}
		const top = this.scroll.scrollTop;
		const range = index.rangeFor(top, top + this.scroll.clientHeight);
		if (!range) {
			return [0, Math.min(last, buffer)];
		}
		return [Math.max(0, range[0] - buffer), Math.min(last, range[1] + buffer)];
	}

	private scheduleEnsure(): void {
		if (this.ensureTimer) {
			return;
		}
		this.ensureTimer = setTimeout(() => {
			this.ensureTimer = null;
			// request() 先取消已经离开窗口的在飞任务,再泵 —— 当前页因此不必
			// 排在一个卡住的旧任务后面 (2.8.0 第一批)。
			this.pump.request();
		}, 60);
	}

	/**
	 * Render what the reader is looking at, one page at a time, nearest first.
	 * Between pages the priorities are recomputed, so a fast scroll does not
	 * queue up a wake of stale work. Pages far outside the window release
	 * their canvases — with several supersampled canvases per page, an
	 * unbounded list is an out-of-memory crash on a long paper.
	 */
	private async renderSlot(page: number, signal: AbortSignal): Promise<PageRenderResult> {
		const slot = this.slots[page];
		if (!slot || !this.pageRenderer) {
			return false;
		}
		this.slotRenderSeq[page] = ++this.slotToken[page]!;
		this.slotDirty[page] = false;
		this.renderStats.started++;
		const startedAt = Date.now();
		try {
			return await this.pageRenderer(page, slot, this.slotWidthFor(page), signal);
		}
		catch (e) {
			this.renderStats.failed++;
			logger.debug(MODULE, `page ${page + 1} render failed`, e);
			return false;
		}
		finally {
			this.renderStats.totalMs += Date.now() - startedAt;
		}
	}

	/**
	 * 一页渲染结束后回写槽状态。被取消的任务**不写状态**,只把槽标脏:它的
	 * 结果没有意义(渲染器在取消后不提交 DOM),但这一页仍然欠一次重建。
	 */
	private commitRender(page: number, result: PageRenderResult, aborted: boolean): void {
		if (this.slotToken[page] !== this.slotRenderSeq[page] || this.viewKind !== 'page') {
			return; // superseded while rendering
		}
		if (aborted) {
			this.renderStats.cancelled++;
			this.slotDirty[page] = true;
			return;
		}
		if (result !== false) {
			this.renderStats.committed++;
		}
		const next = nextSlotState(result, this.slotDegradeTries[page] ?? 0, Date.now());
		if (result !== false) {
			this.mounted.add(page); // 槽里现在有内容,回收时要看它
		}
		this.slotState[page] = next.state;
		this.slotDirty[page] = next.dirty;
		this.slotRetryAt[page] = next.retryAt;
		this.slotDegradeTries[page] = next.tries;
		if (result !== false) {
			this.applyCompareState();
		}
	}

	private releaseFarSlots(): void {
		const [first, last] = this.visibleRange(2);
		// 只看已挂载的页 (2.8.0 第二批): 此前每趟泵送结束都要把整篇文档扫一遍,
		// 500 页的文档里 496 页本来就是空的。先收集再改 DOM —— 读写不交错。
		const release: number[] = [];
		for (const i of this.mounted) {
			if (i < first || i > last) {
				release.push(i);
			}
		}
		for (const i of release) {
			if (this.slotState[i] !== 'empty') {
				this.slotToken[i]!++;
				this.slotState[i] = 'empty';
				this.slotDirty[i] = false;
				// 槽被回收 = 下次进入是一次全新的重建,降级预算随之复位。
				this.slotDegradeTries[i] = 0;
				this.slotRenderedRevision[i] = 0;
				this.slotPartialAt[i] = 0;
				this.slots[i]!.replaceChildren(this.makeGhost(i));
			}
			this.mounted.delete(i);
		}
	}

	/**
	 * The reader moved to another page. The fraction-level scroll sync handles
	 * following; this only records the position and nudges rendering priority.
	 */
	setCurrentPage(pageIndex: number): void {
		if (this.currentPage === pageIndex) {
			return;
		}
		this.currentPage = pageIndex;
		if (this.viewKind === 'page') {
			this.scheduleEnsure();
		}
	}

	/**
	 * A page's translation state changed. Only completion is worth a rebuild:
	 * re-rendering on every intermediate state would repaint the original page
	 * over and over while the provider streams in.
	 */
	refreshPage(pageIndex: number, options: { resetDegrade?: boolean } = {}): void {
		if (this.viewKind !== 'page' || !this.slots[pageIndex]) {
			return;
		}
		this.slotDirty[pageIndex] = true;
		this.slotRetryAt[pageIndex] = 0;
		if (options.resetDegrade !== false) {
			this.slotDegradeTries[pageIndex] = 0;
		}
		this.scheduleEnsure();
	}

	/**
	 * 同步滚动: mirror the reader's position — page AND the fraction within
	 * it. This is what keeps 原文第 2 页 from sitting beside 译文第 1 页: the
	 * pane follows the document position continuously, not per page.
	 */
	setPdfScrollFraction(pageIndex: number, fraction: number): void {
		if (this.viewKind !== 'page') {
			return;
		}
		const slot = this.slots[pageIndex];
		if (!slot) {
			return;
		}
		const target = slot.offsetTop + fraction * slot.offsetHeight - 6;
		const max = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
		this.suppressScrollUntil = Date.now() + 300;
		this.scroll.scrollTop = Math.max(0, Math.min(target, max));
		this.scheduleEnsure();
	}

	/**
	 * 显示原文对照 — hide the masks so the original text shows through the
	 * rebuilt pages, for a direct read against the source.
	 */
	private applyCompareState(): void {
		this.pageHost?.querySelectorAll('.pm-repage').forEach((page) => {
			page.setAttribute('data-pm-compare', String(this.compareOriginal));
		});
	}

	renderPage(state: PageTranslationState): void {
		if (this.viewKind === 'page') {
			const revision = state.translationRevision ?? 0;
			if (state.status === 'done') {
				// 终态无条件重建,并记下最终修订号 —— 之后同一修订的重复通知
				// 不会再触发一次重建。
				this.slotRenderedRevision[state.pageIndex] = revision;
				this.refreshPage(state.pageIndex);
				return;
			}
			// 增量显示 (2.7.10 起,2.8.2 改用修订号): 途中也画,但要过
			// shouldRenderPartial 的三道闸,否则整页在译完前一直是原文。
			const [first, last] = this.visibleRange(0);
			const decided = shouldRenderPartial({
				status: state.status,
				revision,
				rendered: this.slotRenderedRevision[state.pageIndex] ?? 0,
				lastAt: this.slotPartialAt[state.pageIndex] ?? 0,
				now: Date.now(),
				visible: state.pageIndex >= first && state.pageIndex <= last
			});
			if (decided) {
				this.slotRenderedRevision[state.pageIndex] = revision;
				this.slotPartialAt[state.pageIndex] = Date.now();
				// 降级预算不复位: 半成品重建每 500 ms 最多一次,不能让它把
				// 确定性失败页的重试预算刷回去。
				this.refreshPage(state.pageIndex, { resetDegrade: false });
			}
			return;
		}
		const section = this.ensurePageSection(state.pageIndex);
		switch (state.status) {
			case 'extracting':
			case 'translating':
				section.status.replaceChildren(
					this.el('span', 'pm-bilingual-spinner'),
					this.doc.createTextNode(this.strings.statusTranslating.replace('%n%', String(state.pageIndex + 1)))
				);
				section.status.classList.remove('pm-error');
				break;
			case 'done':
				section.status.textContent = '';
				section.status.classList.remove('pm-error');
				break;
			case 'no-text-layer':
				section.status.textContent = this.strings.noTextLayer;
				section.status.classList.add('pm-error');
				break;
			case 'error':
				section.status.textContent = `${this.strings.statusError}: ${state.error?.message ?? ''}`;
				section.status.classList.add('pm-error');
				break;
			default:
				section.status.textContent = '';
		}
		this.renderBlocks(section, state);
	}

	/** Incremental update — existing nodes are patched, never rebuilt. */
	private renderBlocks(section: PageSection, state: PageTranslationState): void {
		const existing = new Map<string, HTMLElement>();
		for (const child of Array.from(section.blocksHost.children)) {
			const id = child.getAttribute('data-pm-block');
			if (id) {
				existing.set(id, child as HTMLElement);
			}
		}
		for (const block of state.blocks) {
			// preserve 块 (2.0.8, 审核 P2-5): 不译参考文献/表格数据单元格是
			// **有意保留原文**的块 —— 它们永远没有译文,渲染出来只会是一张
			// 永远转圈的「翻译中」卡片。文章流里直接跳过(strict 页面视图里
			// 它们以原文墨迹形式自然存在,不经过这里)。
			if (block.translationMode === 'preserve') {
				continue;
			}
			// 样式标记只在 strict 渲染器里成为 <b>/<i>;文本面板剥掉 (styleRuns.ts)。
			const raw = state.translations.get(block.id);
			const translated = raw === undefined ? undefined : stripStyleMarkers(raw);
			let node = existing.get(block.id);
			if (!node) {
				node = this.el('div', 'pm-block');
				node.setAttribute('data-pm-block', block.id);
				node.setAttribute('data-pm-type', block.type);
				node.setAttribute('data-pm-page', String(block.pageIndex));
				// Standalone equations get the demo's .formula-card treatment
				if (this.looksLikeStandaloneFormula(block)) {
					node.setAttribute('data-pm-formula', 'true');
				}
				const original = this.el('p', 'pm-block-original', block.sourceText);
				const text = this.el('p', 'pm-block-text');
				const mini = this.el('button', 'pm-mini-explain', `✦ ${this.strings.explain}`);
				mini.setAttribute('title', this.strings.explain);
				mini.addEventListener('click', (event) => {
					event.stopPropagation();
					this.highlightBlock(block.id);
					this.callbacks.onExplainBlock(block.pageIndex, block.id);
				});
				node.append(original, text, mini);
				node.addEventListener('click', () => {
					this.highlightBlock(block.id);
					this.callbacks.onBlockClick(block.pageIndex, block.id);
				});
				section.blocksHost.append(node);
			}
			const textEl = node.querySelector('.pm-block-text') as HTMLElement | null;
			if (!textEl) {
				continue;
			}
			if (translated !== undefined) {
				if (textEl.textContent !== translated) {
					textEl.textContent = translated; // SAFE: text node only
				}
				node.removeAttribute('data-pm-pending');
			}
			else if (!node.hasAttribute('data-pm-pending')) {
				node.setAttribute('data-pm-pending', 'true');
				textEl.replaceChildren(this.el('span', 'pm-pending', this.strings.pending));
			}
		}
	}

	/** A short paragraph that is essentially one equation. */
	private looksLikeStandaloneFormula(block: SourceBlock): boolean {
		if (block.type !== 'paragraph' && block.type !== 'unknown') {
			return false;
		}
		const text = block.sourceText.trim();
		return text.length > 0 && text.length <= 160 && isFormulaRun(text);
	}

	highlightBlock(blockId: string): void {
		if (this.selectedBlockId) {
			this.articleHost.querySelector(`[data-pm-block="${CSS.escape(this.selectedBlockId)}"]`)?.classList.remove('pm-focused');
		}
		this.selectedBlockId = blockId;
		this.articleHost.querySelector(`[data-pm-block="${CSS.escape(blockId)}"]`)?.classList.add('pm-focused');
	}

	getSelectedBlockId(): string | null {
		return this.selectedBlockId;
	}

	getSelectionText(): string {
		const selection = this.doc.defaultView?.getSelection?.();
		const text = selection ? selection.toString() : '';
		return text.trim() ? text : '';
	}

	scrollToPage(pageIndex: number): void {
		if (this.viewKind === 'page') {
			this.setPdfScrollFraction(pageIndex, 0);
			this.setCurrentPage(pageIndex);
			return;
		}
		this.pages.get(pageIndex)?.marker.scrollIntoView({ block: 'start' });
	}

	scrollToBlock(blockId: string): void {
		this.articleHost.querySelector(`[data-pm-block="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: 'center' });
	}

	/**
	 * 查看保留原文: scroll to `pageIndex` and briefly flash the segments whose
	 * translation could not be placed — the strict `[data-pm-unfit]` boxes in
	 * page view, or the still-pending blocks in article view. Returns true only
	 * if at least one segment was VISIBLY flashed (P2-19).
	 */
	revealKeptOriginal(pageIndex: number): boolean {
		this.scrollToPage(pageIndex);
		const scope = this.articleHost;
		const kept = Array.from(
			scope.querySelectorAll(
				`[data-pm-page="${pageIndex}"] [data-pm-unfit="true"],`
				+ ` [data-pm-page="${pageIndex}"][data-pm-unfit="true"],`
				+ ` [data-pm-page="${pageIndex}"][data-pm-pending="true"]`
			)
		) as HTMLElement[];
		if (!kept.length) {
			return false;
		}
		let flashed = 0;
		for (const node of kept) {
			// P2-19 (2.0.5): unfit 节点是 visibility:hidden 的译文 div —— 加
			// 动画类描的是隐藏节点,用户什么也看不到。改为按其几何画独立的
			// 可见标记层;仍然可见的节点 (article view 的 pending 块) 继续用
			// 原动画类。
			if (node.getAttribute('data-pm-unfit') === 'true') {
				if (flashKeptIndicator(node)) {
					flashed++;
				}
				continue;
			}
			node.classList.remove('pm-kept-flash');
			// Force reflow so re-adding the class restarts the animation.
			void node.offsetWidth;
			node.classList.add('pm-kept-flash');
			this.doc.defaultView?.setTimeout(() => node.classList.remove('pm-kept-flash'), 2000);
			flashed++;
		}
		if (flashed > 0) {
			kept[0]?.scrollIntoView({ block: 'center' });
		}
		return flashed > 0;
	}

	private handleScroll(): void {
		const rect = this.scroll.getBoundingClientRect();
		let best: number | null = null;
		if (this.viewKind === 'page') {
			// Full-document list: keep the window rendered, and tell the
			// session which page leads the viewport — unless this scroll is
			// the echo of our own 同步滚动 write.
			this.scheduleEnsure();
			if (Date.now() < this.suppressScrollUntil) {
				return;
			}
			const anchor = this.scroll.scrollTop + this.scroll.clientHeight * 0.35;
			for (let i = 0; i < this.slots.length; i++) {
				const slot = this.slots[i]!;
				if (slot.offsetTop <= anchor && slot.offsetTop + slot.offsetHeight > anchor) {
					best = i;
					break;
				}
			}
			if (best !== null && best !== this.currentPage) {
				this.currentPage = best;
				this.callbacks.onScrolledToPage(best);
			}
			return;
		}
		const sections: [number, HTMLElement][] =
			[...this.pages.entries()].map(([p, s]) => [p, s.blocksHost] as [number, HTMLElement]);
		for (const [pageIndex, hostEl] of sections) {
			const hostRect = hostEl.getBoundingClientRect();
			if (hostRect.bottom > rect.top + 20 && hostRect.top < rect.bottom) {
				best = best === null ? pageIndex : Math.min(best, pageIndex);
			}
		}
		// 仅页号变化时回调 (2.0.9, 审核 P2-15),与 page 分支同规则: 此前文章流
		// 的每个 scroll 事件都无条件回调 → 同步滚动链路对 PDF 连发 navigate,
		// 即使页号没变 —— 左侧被反复钉回该页起始位置,滚动面板时持续抖动回跳。
		if (best !== null && best !== this.currentPage) {
			this.currentPage = best;
			this.callbacks.onScrolledToPage(best);
		}
	}

	getPageText(_pageIndex: number, blocks: SourceBlock[], translations: Map<string, string>, mode: 'plain' | 'both'): string {
		const lines: string[] = [];
		for (const block of blocks) {
			const raw = translations.get(block.id);
			if (raw === undefined) {
				continue;
			}
			const t = stripStyleMarkers(raw);
			if (mode === 'both') {
				lines.push(block.sourceText, t, '');
			}
			else {
				lines.push(t, '');
			}
		}
		return lines.join('\n').trim();
	}

	destroy(): void {
		if (this.scrollHandler) {
			this.scroll.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		if (this.keyHandler) {
			this.doc.removeEventListener('keydown', this.keyHandler);
			this.keyHandler = null;
		}
		if (this.explainKeyHandler) {
			this.doc.removeEventListener('keydown', this.explainKeyHandler, true);
			this.explainKeyHandler = null;
		}
		if (this.resizeTimer) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (this.ensureTimer) {
			clearTimeout(this.ensureTimer);
			this.ensureTimer = null;
		}
		this.closeBarMenu();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		// 面板销毁: 在飞的重建立刻取消,别让它在一个已经拆掉的槽上收尾。
		this.pump.cancelAll();
		this.pageRenderer = null;
		this.host.replaceChildren();
		this.pages.clear();
		this.pageHost = null;
	}
}
