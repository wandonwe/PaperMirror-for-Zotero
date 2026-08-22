import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * P2-A (2.1.1): 缓存文件里是整篇论文的译文明文。写文件后必须收到 0600、建目录
 * 后收到 0700,以防同机其他本地账户读走。收紧是尽力而为 —— setPermissions 不
 * 存在(旧平台)或抛错(Windows)都不得让缓存写入失败。
 */

function installIO(): {
	perms: { path: string; mode: number }[];
	files: Map<string, unknown>;
	teardown: () => void;
	setPermissionsThrows: boolean;
} {
	const files = new Map<string, unknown>();
	const perms: { path: string; mode: number }[] = [];
	const state = { setPermissionsThrows: false };
	(globalThis as Record<string, any>).IOUtils = {
		exists: async (p: string) => files.has(p),
		readJSON: async (p: string) => {
			if (!files.has(p)) { throw new Error('ENOENT'); }
			return JSON.parse(JSON.stringify(files.get(p)));
		},
		writeJSON: async (p: string, data: unknown) => { files.set(p, JSON.parse(JSON.stringify(data))); },
		makeDirectory: async () => {},
		remove: async (p: string) => { files.delete(p); },
		getChildren: async () => [],
		stat: async () => ({ type: 'regular', size: 0 }),
		setPermissions: async (path: string, mode: number) => {
			if (state.setPermissionsThrows) { throw new Error('EPERM (windows/NTFS)'); }
			perms.push({ path, mode });
		}
	};
	(globalThis as Record<string, any>).PathUtils = {
		join: (...parts: string[]) => parts.join('/'),
		parent: (p: string) => p.split('/').slice(0, -1).join('/'),
		filename: (p: string) => p.split('/').pop() ?? p
	};
	(globalThis as Record<string, any>).Zotero = { DataDirectory: { dir: '/data' } };
	return {
		perms,
		files,
		get setPermissionsThrows() { return state.setPermissionsThrows; },
		set setPermissionsThrows(v: boolean) { state.setPermissionsThrows = v; },
		teardown: () => {
			delete (globalThis as Record<string, any>).IOUtils;
			delete (globalThis as Record<string, any>).PathUtils;
			delete (globalThis as Record<string, any>).Zotero;
		}
	} as any;
}

const PAGE_PARTS = {
	attachmentKey: 'PK', fileHash: 'PH', pageIndex: 0, sourceLanguage: 'en', targetLanguage: 'zh',
	provider: 'openai', model: 'm', promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g',
	noTranslateHash: 'n', settingsHash: 's', sourceTextHash: 'sth'
};

const SEG_PARTS = {
	attachmentKey: 'PK', fileHash: 'PH', provider: 'openai', model: 'm',
	promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n', settingsHash: 's'
};

test('writePage: 文件收到 0600、目录收到 0700', async () => {
	const io = installIO();
	try {
		const { writePage } = await import('../../src/cache/cacheManager');
		await writePage(PAGE_PARTS, [{ id: 'b1', sourceText: 'x', translatedText: '译' } as any]);
		const filePerm = io.perms.find((e: any) => e.path.endsWith('.json'));
		const dirPerm = io.perms.find((e: any) => !e.path.endsWith('.json'));
		assert.ok(filePerm, '缓存文件必须被收紧权限');
		assert.equal(filePerm.mode, 0o600);
		assert.ok(dirPerm, '缓存目录必须被收紧权限');
		assert.equal(dirPerm.mode, 0o700);
	}
	finally { io.teardown(); }
});

test('writeSegments: 文件收到 0600、目录收到 0700', async () => {
	const io = installIO();
	try {
		const { writeSegments } = await import('../../src/cache/cacheManager');
		await writeSegments(SEG_PARTS, [{ hash: 'seg', translatedText: '译' }]);
		const filePerm = io.perms.find((e: any) => e.path.endsWith('.json'));
		const dirPerm = io.perms.find((e: any) => !e.path.endsWith('.json'));
		assert.equal(filePerm?.mode, 0o600);
		assert.equal(dirPerm?.mode, 0o700);
	}
	finally { io.teardown(); }
});

test('setPermissions 抛错(Windows/NTFS)不得让缓存写入失败', async () => {
	const io = installIO();
	io.setPermissionsThrows = true;
	try {
		const { writePage, readPage } = await import('../../src/cache/cacheManager');
		await writePage(PAGE_PARTS, [{ id: 'b1', sourceText: 'x', translatedText: '译' } as any]);
		const out = await readPage(PAGE_PARTS);
		assert.ok(out && out.length === 1, '权限收紧失败时,内容仍必须正常写入并可读回');
	}
	finally { io.teardown(); }
});
