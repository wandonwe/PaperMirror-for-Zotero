import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 段落库解析缓存 + 条目上限 (2.5.3, PF-5) —— 「越往后翻越慢」的根因回归。
 *
 * readSegments 原来每页都把**整份**共享段落库 readJSON 一遍，只为解析出这一页
 * 那二十来个 hash；而 2.3.5 之后这份库跨论文只增不减(全仓没有任何 prune)。
 * 第 N 页读的是已含前 N−1 页的库 → 单篇内 O(N²)，常数还由读过的所有论文带入。
 */

/** 单调递增的假 mtime —— 跨用例不复用。 */
let mtimeClock = 5_000;

interface FakeIO {
	files: Map<string, unknown>;
	meta: Map<string, { size: number; lastModified: number }>;
	reads: () => number;
	bumpMtime: () => void;
	teardown: () => void;
}

function installIO(): FakeIO {
	const files = new Map<string, unknown>();
	const meta = new Map<string, { size: number; lastModified: number }>();
	let reads = 0;
	(globalThis as Record<string, any>).IOUtils = {
		exists: async (p: string) => files.has(p),
		readJSON: async (p: string) => {
			if (!files.has(p)) {
				throw new Error('ENOENT');
			}
			reads++;
			return JSON.parse(JSON.stringify(files.get(p)));
		},
		writeJSON: async (p: string, data: unknown) => {
			files.set(p, JSON.parse(JSON.stringify(data)));
			meta.set(p, { size: JSON.stringify(data).length, lastModified: ++mtimeClock });
		},
		makeDirectory: async () => {},
		remove: async (p: string, opts?: { recursive?: boolean }) => {
			files.delete(p);
			meta.delete(p);
			if (opts?.recursive) {
				for (const key of [...files.keys()]) {
					if (key.startsWith(p + '/')) {
						files.delete(key);
						meta.delete(key);
					}
				}
			}
		},
		getChildren: async () => [],
		stat: async (p: string) => {
			const m = meta.get(p);
			if (!m) {
				throw new Error('ENOENT');
			}
			return { type: 'regular', size: m.size, lastModified: m.lastModified };
		}
	};
	(globalThis as Record<string, any>).PathUtils = {
		join: (...parts: string[]) => parts.join('/'),
		parent: (p: string) => p.split('/').slice(0, -1).join('/'),
		filename: (p: string) => p.split('/').pop() ?? p
	};
	(globalThis as Record<string, any>).Zotero = { DataDirectory: { dir: '/data' } };
	return {
		files,
		meta,
		reads: () => reads,
		bumpMtime: () => {
			for (const [p, m] of meta) {
				meta.set(p, { size: m.size, lastModified: (mtimeClock += 100) });
			}
		},
		teardown: () => {
			delete (globalThis as Record<string, any>).IOUtils;
			delete (globalThis as Record<string, any>).PathUtils;
			delete (globalThis as Record<string, any>).Zotero;
		}
	};
}

function partsFor(key: string): any {
	return {
		attachmentKey: key, fileHash: 'H', provider: 'openai', model: 'm',
		promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n', settingsHash: 's'
	};
}

test('连读 20 页只解析一次整库 —— 这正是「越往后越慢」的来源', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments, setSegmentFlushDelayMs } = await import('../../src/cache/cacheManager');
		setSegmentFlushDelayMs(0);
		const parts = partsFor('K-perf');
		await writeSegments(parts, Array.from({ length: 50 }, (_, i) => ({
			hash: `seg-${i}`, translatedText: `译文 ${i}`
		})));
		const before = io.reads();
		for (let page = 0; page < 20; page++) {
			const out = await readSegments(parts, [`seg-${page}`, `seg-${page + 1}`]);
			assert.equal(out.get(`seg-${page}`), `译文 ${page}`, '命中缓存不等于读到旧数据');
		}
		assert.equal(io.reads() - before, 0, '写盘后缓存就是权威版本，20 页 0 次 parse');
	}
	finally { io.teardown(); }
});

test('文件被外部改动 → 指纹失效，老实重读', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments, setSegmentFlushDelayMs } = await import('../../src/cache/cacheManager');
		setSegmentFlushDelayMs(0);
		const parts = partsFor('K-stale');
		await writeSegments(parts, [{ hash: 'x', translatedText: '一' }]);
		await readSegments(parts, ['x']);
		const before = io.reads();
		io.bumpMtime(); // 别的进程/窗口写过这个文件
		const out = await readSegments(parts, ['x']);
		assert.equal(out.get('x'), '一');
		assert.equal(io.reads() - before, 1, '指纹不符必须真读盘，绝不拿陈旧内容顶数');
	}
	finally { io.teardown(); }
});

test('stat 拿不到指纹时退化为每次重读，绝不假定缓存有效', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments, setSegmentFlushDelayMs } = await import('../../src/cache/cacheManager');
		setSegmentFlushDelayMs(0);
		const parts = partsFor('K-nostat');
		await writeSegments(parts, [{ hash: 'y', translatedText: '二' }]);
		// 老版本 / 异常平台: stat 不给 lastModified
		(globalThis as Record<string, any>).IOUtils.stat = async () => ({ type: 'regular', size: 0 });
		const before = io.reads();
		await readSegments(parts, ['y']);
		await readSegments(parts, ['y']);
		assert.equal(io.reads() - before, 2, '无法证明有效就每次重读 —— 慢一点也不能错');
	}
	finally { io.teardown(); }
});

test('清除全部缓存后不得再命中解析缓存', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments, clearAll, setSegmentFlushDelayMs } = await import('../../src/cache/cacheManager');
		setSegmentFlushDelayMs(0);
		const parts = partsFor('K-clear');
		await writeSegments(parts, [{ hash: 'z', translatedText: '三' }]);
		assert.equal((await readSegments(parts, ['z'])).get('z'), '三');
		await clearAll();
		const out = await readSegments(parts, ['z']);
		assert.equal(out.has('z'), false, '文件已删，内存里那份也必须跟着作废');
	}
	finally { io.teardown(); }
});

test('条目上限: 超出时按插入序淘汰最旧的', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments, setSegmentFlushDelayMs, setMaxSegmentEntries } =
			await import('../../src/cache/cacheManager');
		setSegmentFlushDelayMs(0);
		setMaxSegmentEntries(5);
		try {
			const parts = partsFor('K-cap');
			for (let i = 1; i <= 5; i++) {
				await writeSegments(parts, [{ hash: `s${i}`, translatedText: `译${i}` }]);
			}
			await writeSegments(parts, [
				{ hash: 's6', translatedText: '译6' },
				{ hash: 's7', translatedText: '译7' }
			]);
			const out = await readSegments(parts, ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
			assert.equal(out.size, 5, '库被裁到上限');
			assert.equal(out.has('s1'), false, '最旧的先走');
			assert.equal(out.has('s2'), false);
			assert.equal(out.get('s7'), '译7', '刚写入的必须活着');
		}
		finally { setMaxSegmentEntries(20000); }
	}
	finally { io.teardown(); }
});

test('读命中会把条目移到末尾 —— 常用样板句不会被淘汰掉', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments, setSegmentFlushDelayMs, setMaxSegmentEntries } =
			await import('../../src/cache/cacheManager');
		setSegmentFlushDelayMs(0);
		setMaxSegmentEntries(5);
		try {
			const parts = partsFor('K-lru');
			for (let i = 1; i <= 5; i++) {
				await writeSegments(parts, [{ hash: `s${i}`, translatedText: `译${i}` }]);
			}
			// s1 是最旧的 —— 但读一次就该把它挪到末尾。
			assert.equal((await readSegments(parts, ['s1'])).get('s1'), '译1');
			await writeSegments(parts, [
				{ hash: 's6', translatedText: '译6' },
				{ hash: 's7', translatedText: '译7' }
			]);
			const out = await readSegments(parts, ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
			assert.equal(out.get('s1'), '译1', '刚被命中过的条目必须留下 —— 这就是近似 LRU 的全部意义');
			assert.equal(out.has('s2'), false, '真正最旧的两条出局');
			assert.equal(out.has('s3'), false);
			assert.equal(out.size, 5);
		}
		finally { setMaxSegmentEntries(20000); }
	}
	finally { io.teardown(); }
});

test('复写一条老段落会刷新它的位置，不会被当成最旧的淘汰', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments, setSegmentFlushDelayMs, setMaxSegmentEntries } =
			await import('../../src/cache/cacheManager');
		setSegmentFlushDelayMs(0);
		setMaxSegmentEntries(4);
		try {
			const parts = partsFor('K-rewrite');
			for (let i = 1; i <= 4; i++) {
				await writeSegments(parts, [{ hash: `s${i}`, translatedText: `译${i}` }]);
			}
			await writeSegments(parts, [{ hash: 's1', translatedText: '译1-新' }]);
			await writeSegments(parts, [{ hash: 's5', translatedText: '译5' }]);
			const out = await readSegments(parts, ['s1', 's2', 's3', 's4', 's5']);
			assert.equal(out.get('s1'), '译1-新', '复写过的条目位置刷新，活了下来');
			assert.equal(out.has('s2'), false, '此时最旧的是 s2');
			assert.equal(out.size, 4);
		}
		finally { setMaxSegmentEntries(20000); }
	}
	finally { io.teardown(); }
});

test('stat 拿不到指纹时留下一条警告,且只留一条 (2.5.9)', async () => {
	// 整个解析缓存都建立在 stat 能给出 size + lastModified 之上。任一缺失,
	// 连刚解析好的库都会被丢掉 —— 每页整库重解析,2.5.3 修掉的 O(N²) 原样复活,
	// 而此前一行日志都没有,只表现为"莫名其妙又变慢了"。
	const io = installIO();
	try {
		const { writeSegments, readSegments, setSegmentFlushDelayMs, resetStatStampWarning } =
			await import('../../src/cache/cacheManager');
		const logger = await import('../../src/utils/logger');
		setSegmentFlushDelayMs(0);
		resetStatStampWarning();
		const before = logger.recentProblems().length;
		const parts = partsFor('K-warn');
		await writeSegments(parts, [{ hash: 'h', translatedText: '译' }]);
		// 老版本 / 异常平台: stat 不给 lastModified
		(globalThis as Record<string, any>).IOUtils.stat = async () => ({ type: 'regular', size: 0 });
		await readSegments(parts, ['h']);
		await readSegments(parts, ['h']);
		await readSegments(parts, ['h']);
		const added = logger.recentProblems().slice(before);
		const warnings = added.filter(l => l.includes('re-parse the whole store'));
		assert.equal(warnings.length, 1, '要留记号,但只留一条 —— 不刷屏');
		resetStatStampWarning();
	}
	finally { io.teardown(); }
});
