import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../../src/util/lru';

test('get returns stored value and miss returns undefined', () => {
	const c = new LruCache<number>(3);
	c.set('a', 1);
	assert.equal(c.get('a'), 1);
	assert.equal(c.get('nope'), undefined);
});

test('evicts the least-recently-used past capacity, oldest first', () => {
	const evicted: string[] = [];
	const c = new LruCache<number>(2, (k) => evicted.push(k));
	c.set('a', 1);
	c.set('b', 2);
	c.set('c', 3); // over capacity → evict 'a'
	assert.deepEqual(evicted, ['a']);
	assert.equal(c.get('a'), undefined, 'evicted key is gone');
	assert.deepEqual(c.keys(), ['b', 'c']);
});

test('get refreshes recency so the touched key survives eviction', () => {
	const evicted: string[] = [];
	const c = new LruCache<number>(2, (k) => evicted.push(k));
	c.set('a', 1);
	c.set('b', 2);
	assert.equal(c.get('a'), 1); // 'a' now most-recent → 'b' is oldest
	c.set('c', 3); // evicts 'b', not 'a'
	assert.deepEqual(evicted, ['b']);
	assert.equal(c.get('a'), 1, 'recently-used key stayed');
	assert.equal(c.get('c'), 3);
});

test('re-setting an existing key refreshes it without growing size or evicting', () => {
	const evicted: string[] = [];
	const c = new LruCache<number>(2, (k) => evicted.push(k));
	c.set('a', 1);
	c.set('b', 2);
	c.set('a', 11); // update + refresh recency; size stays 2
	assert.equal(c.size, 2);
	assert.deepEqual(evicted, [], 'no eviction on in-place update');
	assert.equal(c.get('a'), 11);
	c.set('c', 3); // 'b' is oldest now → evicted
	assert.deepEqual(evicted, ['b']);
});

test('clear empties the cache and evicts every remaining entry (resource release)', () => {
	const released: string[] = [];
	const c = new LruCache<{ n: number }>(4, (k) => released.push(k));
	c.set('a', { n: 1 });
	c.set('b', { n: 2 });
	c.clear();
	assert.equal(c.size, 0);
	assert.deepEqual(released.sort(), ['a', 'b']);
	assert.equal(c.get('a'), undefined);
});

test('a burst of same-key hits keeps size at 1 (revisit/zoom-back reuse)', () => {
	const c = new LruCache<string>(6);
	for (let i = 0; i < 20; i++) {
		if (!c.get('7@840')) {
			c.set('7@840', 'bitmap');
		}
	}
	assert.equal(c.size, 1, 'repeated revisits of one (page,width) never grow the cache');
});

// ---- 按权重计容 (2.5.3) -----------------------------------------------------

test('计权时 capacity 是权重总量,不是条数', () => {
	const evicted: string[] = [];
	const cache = new LruCache<{ px: number }>(
		100,
		(k) => { evicted.push(k); },
		(v) => v.px
	);
	cache.set('a', { px: 40 });
	cache.set('b', { px: 40 });
	assert.equal(cache.size, 2);
	assert.equal(cache.weight, 80);
	cache.set('c', { px: 40 }); // 120 > 100 → 淘汰最久未用的 a
	assert.deepEqual(evicted, ['a']);
	assert.equal(cache.size, 2);
	assert.equal(cache.weight, 80);
	// 小条目能存更多 —— 这正是按像素计容的意义
	cache.set('d', { px: 5 });
	cache.set('e', { px: 5 });
	assert.equal(cache.size, 4);
	assert.deepEqual(cache.keys(), ['b', 'c', 'd', 'e']);
});

test('计权时 get 命中同样保命', () => {
	const evicted: string[] = [];
	const cache = new LruCache<{ px: number }>(100, (k) => { evicted.push(k); }, (v) => v.px);
	cache.set('a', { px: 40 });
	cache.set('b', { px: 40 });
	cache.get('a'); // a 变成最近使用
	cache.set('c', { px: 40 });
	assert.deepEqual(evicted, ['b'], '被淘汰的应是 b,不是 a');
});

test('刷新同一个键要按新权重重新计账', () => {
	const cache = new LruCache<{ px: number }>(100, undefined, (v) => v.px);
	cache.set('a', { px: 90 });
	cache.set('a', { px: 10 });
	assert.equal(cache.weight, 10, '旧权重必须先扣掉,否则总量只增不减');
	cache.set('b', { px: 80 });
	assert.equal(cache.size, 2, '账算对了才不会误淘汰');
});

test('单条就超预算时也要留住它,否则缓存等于永远为空', () => {
	const evicted: string[] = [];
	const cache = new LruCache<{ px: number }>(100, (k) => { evicted.push(k); }, (v) => v.px);
	cache.set('huge', { px: 500 });
	assert.equal(cache.size, 1);
	assert.deepEqual(evicted, []);
	cache.set('next', { px: 10 });
	assert.deepEqual(evicted, ['huge'], '下一次写入把它挤走,但不是自己挤走自己');
	assert.equal(cache.size, 1);
});

test('clear 归零权重账,并对每条触发 onEvict', () => {
	const evicted: string[] = [];
	const cache = new LruCache<{ px: number }>(100, (k) => { evicted.push(k); }, (v) => v.px);
	cache.set('a', { px: 30 });
	cache.set('b', { px: 30 });
	cache.clear();
	assert.deepEqual(evicted.sort(), ['a', 'b']);
	assert.equal(cache.weight, 0);
	cache.set('c', { px: 90 });
	assert.equal(cache.size, 1, '清空后账没归零的话这里会立刻误淘汰');
});

test('不传 weigh 时行为与旧版逐字一致(按条数)', () => {
	const cache = new LruCache<number>(2);
	cache.set('a', 1);
	cache.set('b', 2);
	cache.set('c', 3);
	assert.deepEqual(cache.keys(), ['b', 'c']);
	assert.equal(cache.weight, 2);
});
