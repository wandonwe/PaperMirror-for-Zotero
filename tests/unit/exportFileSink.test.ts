/**
 * 导出的落盘与保存位置 (2.8.8, 导出方案 P3)。
 *
 * 这一层没有算法,只有**规矩** —— 所以测试全都在钉规矩:
 *
 *   1. 保存对话框**取消 = 直接结束**:不写文件、不回落别的目录、不提示成功;
 *   2. 对话框拉不起来时返回 `no-picker`,**由调用方先问用户**,绝不自己挑地方写;
 *   3. **重名绝不覆盖**,包括用户在对话框里选中的已存在文件;
 *   4. 目标文件已存在就**拒绝追加** —— 追加到旧文件上会拼出两份内容;
 *   5. 失败要说得出阶段,半份文件顺手删掉(删不掉也没关系: 没有 result 行)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	FileJsonlSink, pickSavePath, uniquePathIn, ensureNoOverwrite, prepareTarget,
	revealFile, stageLabel, type FilePickerLike
} from '../../src/export/fileSink';
import { ExportStageError } from '../../src/export/jsonlWriter';
import { setPluginVersion, pluginVersion } from '../../src/export/pluginVersion';

// ---- 平台桩 ------------------------------------------------------------------

interface FakeFs {
	files: Map<string, string>;
	dirs: string[];
	writes: { path: string; mode?: string }[];
	removed: string[];
	failWriteAfter?: number;
}

function installFs(existing: string[] = []): FakeFs {
	const fs: FakeFs = { files: new Map(existing.map(p => [p, ''])), dirs: [], writes: [], removed: [] };
	(globalThis as Record<string, unknown>).IOUtils = {
		async write(path: string, data: Uint8Array, options?: { mode?: string }): Promise<number> {
			fs.writes.push({ path, mode: options?.mode });
			if (fs.failWriteAfter !== undefined && fs.writes.length > fs.failWriteAfter) {
				throw new Error('disk full');
			}
			fs.files.set(path, (fs.files.get(path) ?? '') + new TextDecoder().decode(data));
			return data.length;
		},
		async exists(path: string): Promise<boolean> {
			return fs.files.has(path);
		},
		async makeDirectory(path: string): Promise<void> {
			fs.dirs.push(path);
		},
		async remove(path: string): Promise<void> {
			fs.removed.push(path);
			fs.files.delete(path);
		}
	};
	(globalThis as Record<string, unknown>).PathUtils = {
		join: (...parts: string[]): string => parts.join('/'),
		parent: (path: string): string | null => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null)
	};
	return fs;
}

function fakePicker(over: Partial<FilePickerLike> = {}): FilePickerLike {
	return {
		modeSave: 1,
		returnCancel: 1,
		defaultString: '',
		file: { path: '/home/u/Downloads/PaperMirror_v2.8.8_diagnostics_x.jsonl' },
		init() {},
		appendFilter() {},
		open(cb: (r: number) => void) { cb(0); },
		...over
	} as FilePickerLike;
}

// ---- 1./2. 保存位置 ----------------------------------------------------------

test('对话框取消 = 直接结束,不写任何文件 (2.8.8 P3)', async () => {
	const fs = installFs();
	const target = await pickSavePath('a.jsonl', {
		window: null,
		defaultDir: '/home/u/Zotero',
		createPicker: () => fakePicker({ open: (cb) => cb(1) })  // returnCancel
	});
	assert.deepEqual(target, { kind: 'cancelled' },
		'用户点取消表达的是"我不要这个文件",不是"你随便找个地方放吧"');
	assert.equal(fs.writes.length, 0, '取消后一个字节都不该写');
});

test('选了文件但对象为空也算取消 —— 不拿空路径去写 (2.8.8 P3)', async () => {
	const target = await pickSavePath('a.jsonl', {
		window: null, createPicker: () => fakePicker({ file: null, open: (cb) => cb(0) })
	});
	assert.equal(target.kind, 'cancelled');
});

test('对话框拉不起来 → no-picker,绝不自己挑地方写 (2.8.8 P3)', async () => {
	for (const createPicker of [
		(): null => null,
		(): never => { throw new Error('no such component'); },
		(): FilePickerLike => fakePicker({ init() { throw new Error('cannot init in this window'); } })
	]) {
		const target = await pickSavePath('a.jsonl', { window: null, defaultDir: '/home/u/Zotero', createPicker });
		assert.deepEqual(target, { kind: 'no-picker', suggestedDir: '/home/u/Zotero' },
			'返回"没有对话框"让调用方去问用户,而不是在这里替他决定');
	}
});

test('选定的路径原样返回;备用目录只是"建议",不是已经写了 (2.8.8 P3)', async () => {
	const fs = installFs();
	const target = await pickSavePath('a.jsonl', { window: null, createPicker: () => fakePicker() });
	assert.equal(target.kind, 'picked');
	assert.equal(fs.writes.length, 0, '选好位置本身不写文件');
});

// ---- 3./4. 绝不覆盖 ----------------------------------------------------------

test('重名追加序号,绝不覆盖 (2.8.8 P3)', async () => {
	installFs(['/d/x.jsonl', '/d/x_2.jsonl']);
	assert.equal(await uniquePathIn('/d', 'x.jsonl'), '/d/x_3.jsonl');
	assert.equal(await uniquePathIn('/d', 'fresh.jsonl'), '/d/fresh.jsonl');
});

test('探测到上限也不覆盖,改带时间戳 (2.8.8 P3)', async () => {
	const taken = ['/d/x.jsonl', ...Array.from({ length: 5 }, (_, i) => `/d/x_${i + 2}.jsonl`)];
	installFs(taken);
	const path = await uniquePathIn('/d', 'x.jsonl', 3);
	assert.ok(!taken.includes(path), '撞不过就换名字,绝不落在已有文件上');
	assert.match(path, /^\/d\/x_\d{10,}\.jsonl$/);
});

test('用户在对话框里选中已存在的文件,也要避让 (2.8.8 P3)', async () => {
	installFs(['/d/x.jsonl']);
	assert.equal(await ensureNoOverwrite('/d/x.jsonl'), '/d/x_2.jsonl',
		'覆盖掉的可能是上一次导出的唯一一份证据');
	assert.equal(await ensureNoOverwrite('/d/new.jsonl'), '/d/new.jsonl');
});

test('目标文件已存在就拒绝追加 —— 拼出两份比不导出更糟 (2.8.8 P3)', async () => {
	installFs(['/d/x.jsonl']);
	await assert.rejects(() => prepareTarget('/d/x.jsonl'),
		(e: unknown) => e instanceof ExportStageError && e.stage === 'prepare');
	const fs = installFs();
	await prepareTarget('/d/fresh.jsonl');
	assert.deepEqual(fs.dirs, ['/d'], '先把目录建出来');
});

// ---- 5. 追加写与失败 ---------------------------------------------------------

test('逐行追加,不整份拼字符串 (2.8.8 P3)', async () => {
	const fs = installFs();
	const sink = new FileJsonlSink('/d/x.jsonl');
	await sink.append('{"a":1}\n');
	await sink.append('{"a":2}\n');
	assert.equal(fs.writes.length, 2, '两行两次 append');
	assert.ok(fs.writes.every(w => w.mode === 'append'), '必须是追加模式 —— 覆盖模式只会剩最后一行');
	assert.equal(fs.files.get('/d/x.jsonl'), '{"a":1}\n{"a":2}\n');
});

test('写失败不吞异常 —— 磁盘满了却提示成功比失败更坏 (2.8.8 P3)', async () => {
	const fs = installFs();
	fs.failWriteAfter = 1;
	const sink = new FileJsonlSink('/d/x.jsonl');
	await sink.append('{"a":1}\n');
	await assert.rejects(() => sink.append('{"a":2}\n'));
	// 半份文件清掉(best-effort)。
	await sink.discardPartial();
	assert.deepEqual(fs.removed, ['/d/x.jsonl']);
});

test('一行都没写过就不用清理 (2.8.8 P3)', async () => {
	const fs = installFs();
	await new FileJsonlSink('/d/x.jsonl').discardPartial();
	assert.deepEqual(fs.removed, [], '没写过的文件不该去删 —— 那可能是同名的别人的文件');
});

test('清理失败不抛 —— 文件里没有 result 行,读的人一眼看得出是半份 (2.8.8 P3)', async () => {
	installFs();
	const io = (globalThis as unknown as Record<string, object>).IOUtils;
	(globalThis as Record<string, unknown>).IOUtils = {
		...io,
		async remove(): Promise<void> { throw new Error('locked'); }
	};
	const sink = new FileJsonlSink('/d/x.jsonl');
	sink.started = true;
	await assert.doesNotReject(() => sink.discardPartial());
});

// ---- 显示文件与阶段名 --------------------------------------------------------

test('reveal 不可用或抛错都返回 false —— 不假装成功 (2.8.8 P3)', () => {
	const seen: string[] = [];
	assert.equal(revealFile('/d/x.jsonl', p => seen.push(p)), true);
	assert.deepEqual(seen, ['/d/x.jsonl']);
	assert.equal(revealFile('/d/x.jsonl'), false, 'Zotero.File.reveal 不一定存在');
	assert.equal(revealFile('/d/x.jsonl', () => { throw new Error('nope'); }), false);
});

test('四个阶段各有中文名 —— 失败提示要说得出卡在哪一步 (2.8.8 P3)', () => {
	assert.deepEqual(
		['prepare', 'summary', 'write-page', 'finalize'].map(stageLabel),
		['准备', '写入汇总', '写入页面数据', '收尾']);
});

// ---- 版本来源 ----------------------------------------------------------------

test('版本来自运行中的插件,没设过就是空串(内核据此拒绝导出) (2.8.8 P3)', () => {
	setPluginVersion('  2.8.8  ');
	assert.equal(pluginVersion(), '2.8.8');
	setPluginVersion('');
	assert.equal(pluginVersion(), '', '拿不到版本时宁可拒绝导出,也不写一份版本存疑的文件');
	setPluginVersion('2.8.8');
});

// ---- 结构闸 ------------------------------------------------------------------

test('startup 把运行中的版本喂进来,导出不读常量 (结构性回归闸, 2.8.8)', () => {
	const startup = readFileSync(join(process.cwd(), 'src/lifecycle/startup.ts'), 'utf8');
	assert.ok(/setPluginVersion\(params\.version\);/.test(startup),
		'版本必须来自 startup(params) —— 硬编码的版本会把排障引到另一份代码上');
});

test('导出流程的四条规矩都在代码里 (结构性回归闸, 2.8.8)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const body = src.slice(src.indexOf('private async runExport('), src.indexOf('private confirmCorpusPrivacy('));
	assert.ok(/if \(kind === 'corpus' && !this\.confirmCorpusPrivacy\(\)\) \{\s*\n\s*return;/.test(body),
		'语料必须先过隐私确认,不同意就直接结束');
	assert.ok(/await sink\.discardPartial\(\);/.test(body) && /导出失败\(\$\{stage\}\)/.test(body),
		'失败要报阶段并清掉半份文件,绝不提示成功');
	assert.ok(!/翻译成功|已完成/.test(body.slice(body.indexOf('catch'))), '失败分支里不许出现成功字样');
	assert.ok(/revealFile\(target, this\.revealFn\(\)\)/.test(body)
		&& /shown \? '' : ` —— \$\{target\}`/.test(body),
		'reveal 不可用时要把路径告诉用户');

	const save = src.slice(src.indexOf('private async resolveSavePath('), src.indexOf('private revealFn('));
	assert.ok(/target\.kind === 'cancelled'[\s\S]{0,120}return null;/.test(save),
		'取消即结束');
	assert.ok(/是否改为保存到 \$\{target\.suggestedDir\}/.test(save)
		&& /if \(!agreed\) \{[\s\S]{0,80}return null;/.test(save),
		'对话框不可用时必须先问,用户不同意就不写 —— 含全文的语料尤其不能默默落到别处');
	assert.ok(/return ensureNoOverwrite\(target\.path\);/.test(save), '选定路径也要避让重名');

	// 语料入口常驻菜单,不受调试日志影响。
	const pane = readFileSync(join(process.cwd(), 'src/ui/translationPane.ts'), 'utf8');
	const menu = pane.slice(pane.indexOf('private buildMoreButton()'), pane.indexOf('/** demo .switch-label'));
	const corpusFile = menu.indexOf('onExportCorpusFile');
	const debugGate = menu.indexOf("getPref<boolean>('debugLogging'");
	assert.ok(corpusFile > 0 && (debugGate < 0 || corpusFile < debugGate),
		'导出翻译语料必须在调试日志闸之前 —— 调试日志只决定探针是否采样,不该拦住语料导出');
});
