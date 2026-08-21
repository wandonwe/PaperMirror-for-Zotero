import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * sweepStaleCacheFiles 删除范围 (2.0.4, 审核 P2-13):
 * 只有「内容确认无效」的文件可删 —— schemaVersion 不匹配,或 JSON 解析失败
 * (SyntaxError)。I/O 层面的瞬时读失败(文件被占用/权限抖动/网盘同步)必须
 * 保留文件: 旧实现在 catch 里一律删除,启动时一次磁盘抖动就把整个缓存清空,
 * 代价是所有文档全量重译。
 *
 * 注意: sweep 每进程只跑一次 (sweepDone),因此所有场景放进同一次扫描。
 */

interface FileSpec {
	/** JSON 内容 (读取成功时返回) */
	content?: unknown;
	/** 读取时抛出的错误 */
	throwError?: Error;
}

function installIO(dirs: Record<string, Record<string, FileSpec>>): {
	removed: string[];
	teardown: () => void;
} {
	const removed: string[] = [];
	const root = '/data/bilingual-reader/cache';
	const lookup = (path: string): FileSpec | undefined => {
		for (const [dir, files] of Object.entries(dirs)) {
			for (const [name, spec] of Object.entries(files)) {
				if (path === `${root}/${dir}/${name}`) {
					return spec;
				}
			}
		}
		return undefined;
	};
	(globalThis as Record<string, any>).IOUtils = {
		exists: async (p: string) => p === root || !!lookup(p) || Object.keys(dirs).some(d => p === `${root}/${d}`),
		getChildren: async (p: string) => {
			if (p === root) {
				return Object.keys(dirs).map(d => `${root}/${d}`);
			}
			const dirName = p.slice(root.length + 1);
			const files = dirs[dirName];
			if (!files) {
				throw new Error('ENOTDIR');
			}
			return Object.keys(files).map(f => `${p}/${f}`);
		},
		readJSON: async (p: string) => {
			const spec = lookup(p);
			if (!spec) {
				throw new Error('ENOENT');
			}
			if (spec.throwError) {
				throw spec.throwError;
			}
			return JSON.parse(JSON.stringify(spec.content));
		},
		remove: async (p: string) => { removed.push(p); },
		writeJSON: async () => {},
		makeDirectory: async () => {},
		stat: async () => ({ type: 'regular', size: 0 })
	};
	(globalThis as Record<string, any>).PathUtils = {
		join: (...parts: string[]) => parts.join('/'),
		parent: (p: string) => p.split('/').slice(0, -1).join('/'),
		filename: (p: string) => p.split('/').pop() ?? p
	};
	(globalThis as Record<string, any>).Zotero = { DataDirectory: { dir: '/data' } };
	return {
		removed,
		teardown: () => {
			delete (globalThis as Record<string, any>).IOUtils;
			delete (globalThis as Record<string, any>).PathUtils;
			delete (globalThis as Record<string, any>).Zotero;
		}
	};
}

test('sweep 只删内容确认无效的文件;瞬时读失败的文件必须保留', async () => {
	const transientError = new Error('NS_ERROR_FILE_IS_LOCKED');
	const syntaxError = new SyntaxError('Unexpected end of JSON input');
	const io = installIO({
		'ATT1-hash1': {
			// 1) 旧 schema → 删
			'page-0_stale.json': { content: { schemaVersion: 1, translations: [] } },
			// 2) 当前 schema → 留
			'page-1_current.json': { content: { schemaVersion: (await import('../../src/cache/cacheSchema')).CACHE_SCHEMA_VERSION, translations: [] } },
			// 3) 瞬时 I/O 失败 → 必须保留 (旧实现在这里误删)
			'page-2_locked.json': { throwError: transientError },
			// 4) JSON 损坏 (SyntaxError) → 内容确认坏了,删
			'page-3_corrupt.json': { throwError: syntaxError },
			// 5) 非 json 文件 → 跳过
			'page-4_partial.json.tmp': { content: {} }
		}
	});
	try {
		const { sweepStaleCacheFiles } = await import('../../src/cache/cacheManager');
		const removedCount = await sweepStaleCacheFiles();
		assert.equal(removedCount, 2, '恰好删除 stale + corrupt 两个文件');
		const names = io.removed.map(p => p.split('/').pop());
		assert.ok(names.includes('page-0_stale.json'), '旧 schema 文件应删除');
		assert.ok(names.includes('page-3_corrupt.json'), '损坏 JSON 应删除');
		assert.ok(!names.includes('page-2_locked.json'), '瞬时读失败的文件绝不能删 —— 内容可能是完好的当前缓存');
		assert.ok(!names.includes('page-1_current.json'), '当前 schema 文件应保留');
		assert.ok(!names.includes('page-4_partial.json.tmp'), '非 .json 文件不在扫描范围');
	}
	finally {
		io.teardown();
	}
});
