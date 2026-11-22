/**
 * 按页状态账本 (5.0 结构层重构第 4 步)。
 *
 * ReaderSession 原来用 14 个以页码为键的 Map / Set 各记一点状态(渲染令牌、压缩
 * 在飞 / 被挡回、已翻译、排版统计、排版键、探针、放弃的块、几何复核、图片框、
 * 提示已显示、导出钉住、引擎轮换偏移……),清理散在十几处、彼此不一致:
 * 有的按页删,有的只整体清,有的从不释放。压缩的"在飞 / 被挡回"两个集合加一个
 * 令牌比较,先后出过三个缺陷(P1-6 标记泄漏、P2-10 丢失唤醒、5.0 胶囊停在
 * 「正在适配」),还藏着第四个:压缩递归时,上一轮的 finally 会清掉下一轮的在飞
 * 标记。
 *
 * 这里每页一条记录,是这些状态的唯一来源:
 *   - 旧代码照常用 Map / Set 的接口(`view` / `flag`),行为不变;
 *   - 生命周期操作有名字(`resetPlacement` / `resetCompress` / `dispose` …),
 *     清理不再各写各的;
 *   - 压缩是一台显式的小状态机:idle → pending(第 n 代)→ idle,`end` 只释放
 *     自己那一代,被挡回的渲染只在真正空闲时接力。
 */

/** 压缩期间被挡回的那次渲染(最新一次胜出),压缩收尾时接力。 */
export interface DeferredRender<E, U> {
	element: E;
	unfit: U[];
	token: number;
}

type CompressState<E, U> =
	| { kind: 'idle' }
	| { kind: 'pending'; generation: number; deferred: DeferredRender<E, U> | null };

interface PageRecord<E, U> {
	compress: CompressState<E, U>;
	fields: Map<string, unknown>;
	flags: Set<string>;
}

/** Map 接口的子集 —— ReaderSession 用到的那些。 */
export interface PageMapView<V> extends Iterable<[number, V]> {
	get(page: number): V | undefined;
	set(page: number, value: V): PageMapView<V>;
	has(page: number): boolean;
	delete(page: number): boolean;
	clear(): void;
	keys(): IterableIterator<number>;
	values(): IterableIterator<V>;
	entries(): IterableIterator<[number, V]>;
	readonly size: number;
}

/** Set 接口的子集。 */
export interface PageSetView extends Iterable<number> {
	has(page: number): boolean;
	add(page: number): PageSetView;
	delete(page: number): boolean;
	clear(): void;
	values(): IterableIterator<number>;
	readonly size: number;
}

/** 排版相关的字段:页面内容一变,这些都作废。 */
export const PLACEMENT_FIELDS = ['placementStats', 'placementProbe', 'abandonedBlocks', 'geometryAudits'] as const;

export class PageLedger<E = unknown, U = unknown> {
	private readonly pages = new Map<number, PageRecord<E, U>>();
	private generation = 0;

	private record(page: number): PageRecord<E, U> {
		let r = this.pages.get(page);
		if (!r) {
			r = { compress: { kind: 'idle' }, fields: new Map(), flags: new Set() };
			this.pages.set(page, r);
		}
		return r;
	}

	// ---- Map / Set views (behaviour-identical stand-ins for the old fields) ----

	view<V>(field: string): PageMapView<V> {
		const ledger = this;
		const pagesWith = function* (): IterableIterator<[number, V]> {
			for (const [page, r] of ledger.pages) if (r.fields.has(field)) yield [page, r.fields.get(field) as V];
		};
		const view: PageMapView<V> = {
			get: page => ledger.pages.get(page)?.fields.get(field) as V | undefined,
			set: (page, value) => { ledger.record(page).fields.set(field, value); return view; },
			has: page => !!ledger.pages.get(page)?.fields.has(field),
			delete: page => !!ledger.pages.get(page)?.fields.delete(field),
			clear: () => { for (const r of ledger.pages.values()) r.fields.delete(field); },
			keys: function* () { for (const [page] of pagesWith()) yield page; },
			values: function* () { for (const [, v] of pagesWith()) yield v; },
			entries: pagesWith,
			[Symbol.iterator]: pagesWith,
			get size() { let n = 0; for (const r of ledger.pages.values()) if (r.fields.has(field)) n++; return n; }
		};
		return view;
	}

	flag(name: string): PageSetView {
		const ledger = this;
		const pagesWith = function* (): IterableIterator<number> {
			for (const [page, r] of ledger.pages) if (r.flags.has(name)) yield page;
		};
		const view: PageSetView = {
			has: page => !!ledger.pages.get(page)?.flags.has(name),
			add: page => { ledger.record(page).flags.add(name); return view; },
			delete: page => !!ledger.pages.get(page)?.flags.delete(name),
			clear: () => { for (const r of ledger.pages.values()) r.flags.delete(name); },
			values: pagesWith,
			[Symbol.iterator]: pagesWith,
			get size() { let n = 0; for (const r of ledger.pages.values()) if (r.flags.has(name)) n++; return n; }
		};
		return view;
	}

	// ---- Compress state machine ------------------------------------------------

	isCompressPending(page: number): boolean {
		return this.pages.get(page)?.compress.kind === 'pending';
	}

	/** idle → pending. Returns the generation, or 0 when one is already in flight. */
	beginCompress(page: number): number {
		const r = this.record(page);
		if (r.compress.kind === 'pending') return 0;
		r.compress = { kind: 'pending', generation: ++this.generation, deferred: null };
		return r.compress.generation;
	}

	/**
	 * pending(generation) → idle. Only that generation is released: a later
	 * compress started meanwhile keeps its flag. The render deferred while
	 * this one was in flight is returned once the page is really idle;
	 * otherwise it stays queued for whoever is in flight now.
	 */
	endCompress(page: number, generation: number): DeferredRender<E, U> | null {
		const r = this.pages.get(page);
		if (!r || r.compress.kind !== 'pending' || r.compress.generation !== generation) return null;
		const deferred = r.compress.deferred;
		r.compress = { kind: 'idle' };
		return deferred;
	}

	/**
	 * Release the in-flight flag early (the compress result is being applied and
	 * may start the next round) but keep the deferred render for the round that
	 * follows — or for this round's own `endCompress` if none starts.
	 */
	releaseCompress(page: number, generation: number): void {
		const r = this.pages.get(page);
		if (!r || r.compress.kind !== 'pending' || r.compress.generation !== generation) return;
		const deferred = r.compress.deferred;
		this.carried.set(page, deferred);
		r.compress = { kind: 'idle' };
	}

	/** Deferred renders carried across an early release, keyed by page. */
	private readonly carried = new Map<number, DeferredRender<E, U> | null>();

	/** Called right after beginCompress: a deferred render carried over from the previous round joins this one. */
	adoptCarried(page: number): void {
		const carried = this.carried.get(page);
		this.carried.delete(page);
		const r = this.pages.get(page);
		if (carried && r?.compress.kind === 'pending' && !r.compress.deferred) r.compress.deferred = carried;
	}

	/** After a round that released early: the carried render, if no new round took it. */
	takeCarried(page: number): DeferredRender<E, U> | null {
		const carried = this.carried.get(page) ?? null;
		this.carried.delete(page);
		return carried;
	}

	/** While pending: remember the newest render that was turned away. */
	deferRender(page: number, render: DeferredRender<E, U>): void {
		const r = this.pages.get(page);
		if (r?.compress.kind === 'pending') r.compress.deferred = render;
	}

	/** Drop compress state for one page (cancel, repair). */
	resetCompress(page: number): void {
		const r = this.pages.get(page);
		if (r) r.compress = { kind: 'idle' };
		this.carried.delete(page);
	}

	resetCompressAll(): void {
		for (const r of this.pages.values()) r.compress = { kind: 'idle' };
		this.carried.clear();
	}

	// ---- Lifecycle -------------------------------------------------------------

	/** Page content changed: every placement result for it is stale. */
	resetPlacement(page: number): void {
		const r = this.pages.get(page);
		if (r) for (const f of PLACEMENT_FIELDS) r.fields.delete(f);
	}

	resetPlacementAll(): void {
		for (const r of this.pages.values()) {
			for (const f of PLACEMENT_FIELDS) r.fields.delete(f);
			r.fields.delete('placementKeys');
		}
	}

	/** Session destroyed: release everything (elements included). */
	dispose(): void {
		this.pages.clear();
		this.carried.clear();
	}
}
