/**
 * 页位置索引 (2.8.0 第二批: 可见页定位不再遍历整篇文档)。
 *
 * `visibleRange` 此前每次调用都从第 0 页开始逐页读 `offsetTop / offsetHeight`
 * 找可见范围 —— 而它在滚动、翻页、译文到达、每渲染完一页之后都会被调用。
 * 500 页的文档,一次普通滚动就是 500 次布局读取,而且每次读取都可能触发
 * 强制同步布局。
 *
 * 这里把几何**读一次、存起来**: 建索引时一趟批量读完所有槽的位置(读与写不
 * 交错),之后每次定位都是纯二分,一次 DOM 读取都不做。索引在几何真的变了
 * (页宽、缩放、页面尺寸)时整体作废重建 —— 滚动不会让它失效。
 *
 * 位置来自**实测**而不是按页高推算: 混合纸张、横向页、页间距、页码标签的
 * 高度全都自然包含在内,不必假设整篇页面等高。
 */

/**
 * 视口矩形顶边 → **滚动容器内容坐标** (2.9.8) — pure。
 *
 * 面板里所有涉及位置的代码原本都在做同一件事:拿 `slot.offsetTop` 当成一个
 * `scrollTop` 值用。可 `offsetTop` 量的是"到**定位祖先**的距离" —— 而
 * `.pm-scroll` / `.pm-article-host` / `.pm-repage-host` 都没有定位,定位祖先一路
 * 落到 `.pm-bilingual-pane`,于是 `offsetTop` 里**含着标题栏那一行**,
 * 而 `scrollTop` 是从滚动容器自己的内容顶边算的。两把尺子,零点差一个标题栏。
 *
 * 同一个错误同时污染了四处:同步落点、反向判当前页、可见窗口、渲染决策。
 * 矩形差换算**按构造正确**:不依赖任何祖先是否定位、有没有 padding、border
 * 或 transform。做成一个纯函数,四处就只能共用这一份口径。
 */
export function toScrollTop(elementRectTop: number, scrollRectTop: number, scrollTop: number): number {
	return elementRectTop - scrollRectTop + scrollTop;
}

/**
 * 锚点(页 + 页内比例)→ 落点 (2.9.8) — pure。
 *
 * **没有任何常数补偿。** 旧实现末尾挂着一个 `- 6`,那是照着上面那个零点偏差手调
 * 出来的:既说不出 6 从哪来,也补不对(标题栏远不止 6px)。零点对齐之后它没有
 * 存在的理由 —— 真要有视觉留白,也该来自某个说得出名字的 UI 元素。
 */
export function anchorScrollTarget(slotTop: number, slotHeight: number, fraction: number): number {
	return slotTop + fraction * slotHeight;
}

/** 落点 → 锚点里的页内比例 (2.9.8) — pure。零高度的槽不产出 NaN。 */
export function anchorFractionOf(scrollTop: number, slotTop: number, slotHeight: number): number {
	return slotHeight > 0 ? (scrollTop - slotTop) / slotHeight : 0;
}

export interface PageOffsetIndexStats {
	/** 建这一份索引时读了多少次几何 —— 单测用它断言"滚动不再逐页读取"。 */
	reads: number;
}

export class PageOffsetIndex {
	/** 每页顶边(非递减)。 */
	private readonly tops: number[];
	/** 每页底边。 */
	private readonly bottoms: number[];
	readonly stats: PageOffsetIndexStats;

	private constructor(tops: number[], bottoms: number[], stats: PageOffsetIndexStats) {
		this.tops = tops;
		this.bottoms = bottoms;
		this.stats = stats;
	}

	get length(): number {
		return this.tops.length;
	}

	/**
	 * 一趟批量读完所有页的位置。measure 只在这里调用 —— 调用方保证这一趟里
	 * 不写 DOM,读写不交错就不会反复触发强制同步布局。
	 */
	static build(count: number, measure: (page: number) => { top: number; height: number }): PageOffsetIndex {
		const tops: number[] = new Array(count);
		const bottoms: number[] = new Array(count);
		const stats: PageOffsetIndexStats = { reads: 0 };
		let previousTop = -Infinity;
		for (let page = 0; page < count; page++) {
			const box = measure(page);
			stats.reads++;
			// 顶边必须非递减,二分才成立。还没排版的槽会报 0 —— 用前一页的顶边
			// 兜住,它随后会因为几何变化被整体重建,不会长期停在错的位置上。
			const top = Math.max(box.top, previousTop);
			previousTop = top;
			tops[page] = top;
			bottoms[page] = top + Math.max(0, box.height);
		}
		return new PageOffsetIndex(tops, bottoms, stats);
	}

	/** 直接用位置数组建索引(单测与纯计算用)。 */
	static fromBoxes(boxes: { top: number; height: number }[]): PageOffsetIndex {
		return PageOffsetIndex.build(boxes.length, page => boxes[page]!);
	}

	/**
	 * 视口 [top, bottom) 覆盖到的首末页,闭区间;整篇都不相交时返回 null。
	 * 纯二分,不读任何 DOM。
	 */
	rangeFor(top: number, bottom: number): [number, number] | null {
		if (!this.tops.length || bottom <= top) {
			return null;
		}
		// 第一个 bottoms[i] > top 的 i。bottoms 与 tops 同为非递减。
		const first = lowerBound(this.bottoms, top);
		if (first >= this.tops.length) {
			return null;
		}
		// 最后一个 tops[i] < bottom 的 i。
		const last = lowerBound(this.tops, bottom - 1e-9) - 1;
		if (last < first) {
			return null;
		}
		return [first, last];
	}
}

/** 第一个 values[i] > probe 的下标(values 非递减)。 */
function lowerBound(values: number[], probe: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (values[mid]! > probe) {
			hi = mid;
		}
		else {
			lo = mid + 1;
		}
	}
	return lo;
}

/**
 * 索引缓存 (2.8.0 第二批)。把"建一次、用很多次"这条性能不变量做成可测的东西:
 * `builds` 计的是**真正读几何的次数**。滚动只调 `get`,它必须一次都不涨;
 * 只有几何变了(`invalidate`)或页数变了才允许重建。
 */
export class CachedPageIndex {
	private index: PageOffsetIndex | null = null;
	/** 真正重建的次数 —— 单测据此断言滚动期间零重建。 */
	builds = 0;

	get(count: number, measure: (page: number) => { top: number; height: number }): PageOffsetIndex | null {
		if (count <= 0) {
			return null;
		}
		if (this.index && this.index.length === count) {
			return this.index;
		}
		this.builds++;
		this.index = PageOffsetIndex.build(count, measure);
		return this.index;
	}

	invalidate(): void {
		this.index = null;
	}
}
