/**
 * 跨页重复内容登记表 — 移植自 MinerU 的页眉页脚去重思路
 * (opendatalab/MinerU, Apache-2.0;完整致谢见 THIRD-PARTY-NOTICES.md)。
 *
 * `metaFilter.isRunningHeadOrFoot` 是**单页**判据:位置在页边带内 + 形状够短。
 * 它够用,但看不见最强的那个信号 —— 页眉页脚之所以是页眉页脚,是因为它
 * **在很多页上重复出现**。单页判据因此有个结构性盲区:落在带外(页边距大)、
 * 或超过 2 行 / 140 字的版权与许可声明块,形状测试一律放行,于是每页都当正文
 * 翻一遍。
 *
 * 本模块按文档累积「页边带内出现过什么文本、在哪些页出现过」,达到阈值即确认
 * 为版式家具。**纯附加、单向**:只把单页判据漏掉的丢掉,绝不把它已经丢掉的
 * 救回来 —— 救回方向需要在第 1 页就知道全文的重复情况,而逐页管线做不到,
 * 强行救会让早期页面把真页眉当正文翻译。
 *
 * 已知边界(逐页管线的固有代价):阈值要到第 N 页才跨过,前 N-1 页已经渲染,
 * 不回溯重排(回溯会造成已读页面闪变)。因此收益从第 N 页起生效,早期页面维持
 * 现状 —— 严格优于现在,不会更差。
 */

import type { Rect } from './metaFilter';

/**
 * 归一化:大小写、空白折叠,数字整段替换为 `#`。数字归一是关键 ——
 * 「J Med Phys 2024;51:88」逐页变化,只有抹掉数字才认得出是同一条刊脚;
 * 页码本身也因此自然并成一类。
 */
export function normalizeBoilerplate(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#');
}

/** 页边带内?沿用 isRunningHeadOrFoot 的坐标约定(PDF y 轴向上,rect=[x0,y0,x1,y1])。 */
export function inMarginBand(rect: Rect, pageHeight: number, bandRatio: number): boolean {
	if (pageHeight <= 0) {
		return false;
	}
	const band = pageHeight * bandRatio;
	return rect[1] > pageHeight - band || rect[3] < band;
}

/** 登记表对外的最小接口 —— 便于在单测里塞桩,也让 SpanBuildOptions 不依赖实现。 */
export interface RepeatObserver {
	observe(pageIndex: number, text: string, rect: Rect, pageHeight: number, type: string): void;
	isRepeated(text: string): boolean;
}

/**
 * 进登记表的门槛。数字归一带来一个副作用:「Table 1」「Table 2」「Table 3」会
 * 并成同一条 `table #`,三页一凑就被当成版式家具丢掉 —— 那是图表题注,丢了是
 * 真损失。两道闸各挡一半:归一后长度 < 10 的太短不进(题注编号正落在这里),
 * 题注/表格/标题类型一律不进。
 */
const MIN_NORMALIZED_LENGTH = 10;
const EXCLUDED_TYPES = new Set(['caption', 'table', 'title']);
/**
 * 带宽只比单页判据的 8% 略宽。曾取 0.15,被端到端测试当场证伪:页边距小的版式里
 * 正文首段就落在顶部 15% 带内,一旦它在几页上重复(测试夹具即如此)就会被当成
 * 家具丢掉 —— 正文一个都不能少,这是硬底线。0.12 只覆盖 8% 判据之外那一圈盲区,
 * 正文首段安全地在带外。
 *
 * 残余风险(如实记录):版心里逐页逐字相同的正文段不会被登记(带外),但若真有
 * 一段正文恰好落在这一圈窄带内并逐页重复,仍会被丢。真实排版里散文不会逐页
 * 逐字重复,故不再为此加更多闸 —— 加闸会同时挡掉本模块要抓的多行版权块。
 */
const BAND_RATIO = 0.12;
/** 需要在多少个**不同页**出现过才算确认。 */
const DEFAULT_THRESHOLD = 3;

export class RepeatRegistry implements RepeatObserver {
	private seen = new Map<string, Set<number>>();
	private threshold: number;

	constructor(threshold: number = DEFAULT_THRESHOLD) {
		this.threshold = Math.max(2, threshold);
	}

	observe(pageIndex: number, text: string, rect: Rect, pageHeight: number, type: string): void {
		if (EXCLUDED_TYPES.has(type) || !inMarginBand(rect, pageHeight, BAND_RATIO)) {
			return;
		}
		const key = normalizeBoilerplate(text);
		if (key.length < MIN_NORMALIZED_LENGTH) {
			return;
		}
		// 按**页**去重:同一页重排/重译多次不得把计数灌大,否则单页文档也能
		// 自己凑够阈值。
		let pages = this.seen.get(key);
		if (!pages) {
			pages = new Set<number>();
			this.seen.set(key, pages);
		}
		pages.add(pageIndex);
	}

	isRepeated(text: string): boolean {
		const key = normalizeBoilerplate(text);
		if (key.length < MIN_NORMALIZED_LENGTH) {
			return false;
		}
		return (this.seen.get(key)?.size ?? 0) >= this.threshold;
	}

	/** 诊断用:已确认的家具条数(不含文本本身)。 */
	confirmedCount(): number {
		let n = 0;
		for (const pages of this.seen.values()) {
			if (pages.size >= this.threshold) {
				n++;
			}
		}
		return n;
	}

	reset(): void {
		this.seen.clear();
	}
}
