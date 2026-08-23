/**
 * Tiny insertion-order LRU cache (2.2.5, 计划 第三批 item6 · PF-4).
 *
 * 用 Map 的插入顺序即最近使用顺序: `get` 命中后把该键移到队尾(最近),`set`
 * 超容量时淘汰队首(最久未用)。纯数据结构,无 DOM/平台依赖,单元测试直接覆盖。
 * `onEvict` 让持有者在条目被淘汰/清空时释放底层资源(如 canvas 位图)。
 */
export class LruCache<V> {
	private readonly map = new Map<string, V>();

	constructor(
		private readonly capacity: number,
		private readonly onEvict?: (key: string, value: V) => void
	) {}

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
		if (this.map.has(key)) {
			this.map.delete(key);
		}
		this.map.set(key, value);
		while (this.map.size > this.capacity) {
			const oldest = this.map.keys().next().value as string | undefined;
			if (oldest === undefined) {
				break;
			}
			const evicted = this.map.get(oldest);
			this.map.delete(oldest);
			if (evicted !== undefined) {
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
	}

	get size(): number {
		return this.map.size;
	}

	/** 当前键,最久未用在前 —— 仅供测试/诊断。 */
	keys(): string[] {
		return [...this.map.keys()];
	}
}
