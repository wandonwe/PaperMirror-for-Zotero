/**
 * Tiny insertion-order LRU cache (2.2.5, 计划 第三批 item6 · PF-4).
 *
 * 用 Map 的插入顺序即最近使用顺序: `get` 命中后把该键移到队尾(最近),`set`
 * 超容量时淘汰队首(最久未用)。纯数据结构,无 DOM/平台依赖,单元测试直接覆盖。
 * `onEvict` 让持有者在条目被淘汰/清空时释放底层资源(如 canvas 位图)。
 *
 * 计权 (2.5.3): 传 `weigh` 后 capacity 就不再是「条数」而是「权重总量」。
 * 页底图正需要这个 —— 按条数计容只能按**最坏**的一张来定上限(整页
 * ~3.2M 像素),于是窄栏、小页那种一张只有几十万像素的情形也只敢存 4 张,
 * 回看时白白重新 rasterize。按像素计容,内存上界不变而条数随实际大小浮动。
 */
export class LruCache<V> {
	private readonly map = new Map<string, V>();
	/** 当前权重总量(不计权时等于条数)。 */
	private total = 0;

	constructor(
		private readonly capacity: number,
		private readonly onEvict?: (key: string, value: V) => void,
		private readonly weigh?: (value: V) => number
	) {}

	private weightOf(value: V): number {
		if (!this.weigh) {
			return 1;
		}
		const w = this.weigh(value);
		return Number.isFinite(w) && w > 0 ? w : 1;
	}

	/** 命中返回值并标记为最近使用;未命中返回 undefined。 */
	get(key: string): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) {
			return undefined;
		}
		// 移到队尾 = 最近使用。
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	has(key: string): boolean {
		return this.map.has(key);
	}

	/** 写入(或刷新)一个键,超容量则淘汰最久未用者(触发 onEvict)。 */
	set(key: string, value: V): void {
		const previous = this.map.get(key);
		if (previous !== undefined) {
			this.total -= this.weightOf(previous);
			this.map.delete(key);
		}
		this.map.set(key, value);
		this.total += this.weightOf(value);
		// 至少留一条: 单条就超预算时淘汰它等于缓存永远为空,反而每次都重算。
		while (this.total > this.capacity && this.map.size > 1) {
			const oldest = this.map.keys().next().value as string | undefined;
			if (oldest === undefined) {
				break;
			}
			const evicted = this.map.get(oldest);
			this.map.delete(oldest);
			if (evicted !== undefined) {
				this.total -= this.weightOf(evicted);
				this.onEvict?.(oldest, evicted);
			}
		}
	}

	/** 清空(对每个残留条目触发 onEvict,便于释放资源)。 */
	clear(): void {
		if (this.onEvict) {
			for (const [k, v] of this.map) {
				this.onEvict(k, v);
			}
		}
		this.map.clear();
		this.total = 0;
	}

	/** 当前权重总量 —— 仅供测试/诊断。 */
	get weight(): number {
		return this.total;
	}

	get size(): number {
		return this.map.size;
	}

	/** 当前键,最久未用在前 —— 仅供测试/诊断。 */
	keys(): string[] {
		return [...this.map.keys()];
	}
}
