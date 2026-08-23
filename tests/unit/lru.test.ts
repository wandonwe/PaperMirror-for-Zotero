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
