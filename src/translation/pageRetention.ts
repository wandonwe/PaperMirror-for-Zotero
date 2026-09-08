/**
 * 已完成页的内容保留策略 (2.8.3 第四批: 限制已完成页面的内存保留)。
 *
 * `TranslationManager.pages` 此前只增不减: 一篇 300 页的文档读到底,300 页的
 * `blocks`(每块带 `lineRectsPdf` 行矩形数组)与 `translations` 全都留在内存里,
 * 而其中绝大多数早已滚出视野、也早已可靠落进页面缓存。
 *
 * 这里只做一件事: 决定**哪几页可以卸掉完整内容**。页状态本身(状态、页级
 * 指标、诊断)是轻量的,继续留着 —— 分开管理的正是"轻量页面状态"与"完整
 * 页面内容"。
 *
 * 四条保护,任何一条成立就绝不淘汰:
 *   1. 没翻完(`status !== 'done'`)—— 正在翻译的页当然不能卸;
 *   2. 译文还没可靠落进页面缓存(`cached === false`)—— **卸掉就是丢掉唯一
 *      的一份译文**。有未译块或 keepOrigin 的页按设计不写页面缓存,于是它们
 *      永远不会被淘汰,这是对的;
 *   3. 正在被渲染 / 仍挂在面板上(`inUse`);
 *   4. 落在当前页前后 `keepRadius` 页之内。
 *
 * 卸载是可逆的: 用户翻回去时 `ensurePage` 重新抽取该页并读页面缓存,零 API
 * 请求 —— 这正是"只淘汰 cached 页"这条闸的意义。
 */

/** 同时持有完整内容的已完成页上限。真实长文档实测后再调。 */
export const RETAIN_LIMIT = 20;
/** 当前页前后各保留几页的完整内容。 */
export const KEEP_RADIUS = 2;

export interface RetainCandidate {
	pageIndex: number;
	/** 只有 'done' 的页才可能被淘汰。 */
	status: string;
	/** 译文已可靠落进页面缓存。 */
	cached: boolean;
	/** 正在渲染,或仍挂在面板上。 */
	inUse: boolean;
	/** 最近一次被用到的序号(越大越新)。 */
	touchedAt: number;
	/** 已经卸过内容 —— 不再占容量,也不必再卸一次。 */
	evicted: boolean;
}

export interface RetentionOptions {
	limit?: number;
	keepRadius?: number;
}

/**
 * 返回该卸掉完整内容的页,**最久没用到的排在前面**。纯函数。
 *
 * 受保护的页不会被强行淘汰: 如果可淘汰的页不够,持有量就停在上限之上 ——
 * 宁可多占内存,也不丢一份没落盘的译文。
 */
export function pagesToEvict(
	pages: RetainCandidate[],
	currentPage: number,
	options: RetentionOptions = {}
): number[] {
	const limit = options.limit ?? RETAIN_LIMIT;
	const keepRadius = options.keepRadius ?? KEEP_RADIUS;
	const holding = pages.filter(p => !p.evicted);
	const excess = holding.length - limit;
	if (excess <= 0) {
		return [];
	}
	return holding
		.filter(p => p.status === 'done'
			&& p.cached
			&& !p.inUse
			&& Math.abs(p.pageIndex - currentPage) > keepRadius)
		.sort((a, b) => a.touchedAt - b.touchedAt || a.pageIndex - b.pageIndex)
		.slice(0, excess)
		.map(p => p.pageIndex);
}
