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
			promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n', settingsHash: 's'
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
			promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n', settingsHash: 's'
		};
		await Promise.all(Array.from({ length: 8 }, (_, i) =>
			writeSegments(parts, [{ hash: `s${i}`, translatedText: `译${i}` }])));
		const out = await readSegments(parts, Array.from({ length: 8 }, (_, i) => `s${i}`));
		assert.equal(out.size, 8, '8 路并发写一个不丢');
	}
	finally { io.teardown(); }
});

// ---- P2-1 (2.0.7): 合并基底读失败不得以空库覆盖 -----------------------------

test('合并基底瞬时读失败 → 放弃本次写,已有段落库不被截断', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments } = await import('../../src/cache/cacheManager');
		const parts = {
			attachmentKey: 'K9', fileHash: 'H9', provider: 'openai', model: 'm',
			promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n', settingsHash: 's'
		};
		// 建立既有库: 两条段落。
		await writeSegments(parts, [
			{ hash: 'old-1', translatedText: '既有译文一' },
			{ hash: 'old-2', translatedText: '既有译文二' }
		]);
		// 下一次合并写的基底读取瞬时失败 (文件被占用/网盘同步)。
		(globalThis as Record<string, any>).IOUtils.readJSON = async () => {
			throw new Error('NS_ERROR_FILE_IS_LOCKED');
		};
		await writeSegments(parts, [{ hash: 'new-3', translatedText: '新增译文三' }]);
		// 恢复读取,检查库内容。
		const files = io.files as Map<string, unknown>;
		(globalThis as Record<string, any>).IOUtils.readJSON = async (p: string) => {
			if (!files.has(p)) {
				throw new Error('ENOENT');
			}
			return JSON.parse(JSON.stringify(files.get(p)));
		};
		const out = await readSegments(parts, ['old-1', 'old-2', 'new-3']);
		assert.equal(out.get('old-1'), '既有译文一', '既有段落必须存活 —— 旧实现在这里被截断清空');
		assert.equal(out.get('old-2'), '既有译文二');
		assert.equal(out.has('new-3'), false, '本次合并被放弃 (少写几条好过丢整库)');
	}
	finally { io.teardown(); }
});

test('合并基底 JSON 确认损坏 (SyntaxError) → 允许以空库重建', async () => {
	const io = installIO();
	try {
		const { writeSegments, readSegments } = await import('../../src/cache/cacheManager');
		const parts = {
			attachmentKey: 'K10', fileHash: 'H10', provider: 'openai', model: 'm',
			promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n', settingsHash: 's'
		};
		await writeSegments(parts, [{ hash: 'a', translatedText: '旧' }]);
		const files = io.files as Map<string, unknown>;
		const restore = (globalThis as Record<string, any>).IOUtils.readJSON;
		(globalThis as Record<string, any>).IOUtils.readJSON = async () => {
			throw new SyntaxError('Unexpected end of JSON input');
		};
		await writeSegments(parts, [{ hash: 'b', translatedText: '重建' }]);
		(globalThis as Record<string, any>).IOUtils.readJSON = restore;
		void files;
		const out = await readSegments(parts, ['a', 'b']);
		assert.equal(out.has('a'), false, '损坏库被重建,旧条目不复存在');
		assert.equal(out.get('b'), '重建', '重建后的写入生效');
	}
	finally { io.teardown(); }
});
