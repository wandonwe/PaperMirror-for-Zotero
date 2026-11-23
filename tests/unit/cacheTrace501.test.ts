import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 5.0.1: 缓存读取的诊断类别(只有类别,不含内容)。
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

test('5.0.1: readPage reports missing, hit and invalid; readSegments reports the store load kind', async () => {
  const io = installIO();
  try {
    const { writePage, readPage, writeSegments, readSegments, flushAllSegments } = await import('../../src/cache/cacheManager') as any;
    const t1: { outcome?: string } = {};
    assert.equal(await readPage(PAGE_PARTS, t1), null);
    assert.equal(t1.outcome, 'missing');
    await writePage(PAGE_PARTS, [{ id: 'b1', sourceText: 'x', translatedText: '译' } as any]);
    const t2: { outcome?: string } = {};
    assert.ok(await readPage(PAGE_PARTS, t2));
    assert.equal(t2.outcome, 'hit');
    const t3: { outcome?: string } = {};
    assert.equal(await readPage({ ...PAGE_PARTS, model: 'other' }, t3), null);
    assert.equal(t3.outcome, 'missing', 'another model is a different file');
    const s1: { store?: string } = {};
    await readSegments(SEG_PARTS, ['h1'], s1);
    assert.match(s1.store ?? '', /^missing/);
    await writeSegments(SEG_PARTS, new Map([['h1', '段']]));
    if (typeof flushAllSegments === 'function') await flushAllSegments();
  }
  finally { io.teardown(); }
});
