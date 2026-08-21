import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 段落缓存写入串行化 (1.3.0, 审核 P1): 并发 writeSegments 曾是
 * 读旧文件 → 合并 → 原子覆盖 —— 两个页面同时读到 {x},后写者覆盖先写者的
 * 合并结果。现在同一路径的写排队执行,两次并发写的条目必须全部存活。
 * 用带人为延迟的假 IOUtils 重现旧竞态窗口。
 */

function installIO(): { files: Map<string, unknown>; teardown: () => void; readDelayMs: number } {
	const files = new Map<string, unknown>();
	const state = { readDelayMs: 0 };
	const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
	(globalThis as Record<string, any>).IOUtils = {
		exists: async (p: string) => files.has(p),
		readJSON: async (p: string) => {
			await delay(state.readDelayMs); // 竞态窗口: 读到旧内容后让出事件循环
			if (!files.has(p)) {
				throw new Error('ENOENT');
			}
			return JSON.parse(JSON.stringify(files.get(p)));
		},
		writeJSON: async (p: string, data: unknown) => { await delay(1); files.set(p, JSON.parse(JSON.stringify(data))); },
		makeDirectory: async () => {},
		remove: async (p: string) => { files.delete(p); },
		getChildren: async () => [],
		stat: async () => ({ type: 'regular', size: 0 })
	};
	(globalThis as Record<string, any>).PathUtils = {
		join: (...parts: string[]) => parts.join('/'),
		parent: (p: string) => p.split('/').slice(0, -1).join('/'),
		filename: (p: string) => p.split('/').pop() ?? p
	};
	(globalThis as Record<string, any>).Zotero = { DataDirectory: { dir: '/data' } };
	return {
		files,
		get readDelayMs() { return state.readDelayMs; },
		set readDelayMs(v: number) { state.readDelayMs = v; },
		teardown: () => {
			delete (globalThis as Record<string, any>).IOUtils;
			delete (globalThis as Record<string, any>).PathUtils;
			delete (globalThis as Record<string, any>).Zotero;
		}
	} as any;
}

test('并发 writeSegments 不再互相覆盖: 两个页面的段落全部存活', async () => {
	const io = installIO();
	io.readDelayMs = 10; // 制造旧竞态的交错窗口
	try {
		const { writeSegments, readSegments } = await import('../../src/cache/cacheManager');
		const parts = {
			attachmentKey: 'K1', fileHash: 'H1', provider: 'openai', model: 'm',
			promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n'
		};
		// 两个"页面"同时写入不同的段落 —— 旧实现里后写者会覆盖先写者
		await Promise.all([
			writeSegments(parts, [{ hash: 'seg-a', translatedText: '甲' }]),
			writeSegments(parts, [{ hash: 'seg-b', translatedText: '乙' }])
		]);
		const out = await readSegments(parts, ['seg-a', 'seg-b']);
		assert.equal(out.get('seg-a'), '甲', '先写者的段落必须存活');
		assert.equal(out.get('seg-b'), '乙', '后写者的段落必须存活');
	}
	finally { io.teardown(); }
});

test('高并发 8 路写全部存活', async () => {
	const io = installIO();
	io.readDelayMs = 3;
	try {
		const { writeSegments, readSegments } = await import('../../src/cache/cacheManager');
		const parts = {
			attachmentKey: 'K2', fileHash: 'H2', provider: 'openai', model: 'm',
			promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n'
		};
		await Promise.all(Array.from({ length: 8 }, (_, i) =>
			writeSegments(parts, [{ hash: `s${i}`, translatedText: `译${i}` }])));
		const out = await readSegments(parts, Array.from({ length: 8 }, (_, i) => `s${i}`));
		assert.equal(out.size, 8, '8 路并发写一个不丢');
	}
	finally { io.teardown(); }
});
