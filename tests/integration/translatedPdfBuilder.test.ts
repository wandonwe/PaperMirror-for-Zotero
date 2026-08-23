import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { setFontSource, buildTranslatedPdf } from '../../src/pdfgen/translatedPdfBuilder';
import type { SourceBlock } from '../../src/types/models';

/**
 * LO-1 (2.2.8): 导出 PDF「放不下保留原文」。旧实现先涂白原文、再排版,最小字号
 * 仍放不下时只画带「…」的截断译文 —— 段落尾部在导出文件里永久丢失。现在放不下
 * 的块整块跳过(不涂白、不画截断),原文完整保留,keptOriginal 如实计数。
 * 真 pdf-lib + 真内置字体的集成测试(Zotero.HTTP 以本地文件桩替)。
 */

// esbuild 把测试打包到 build/tests/ 下执行,import.meta 路径会漂移;测试进程的
// cwd 是仓库根(scripts/test.mjs spawnSync 继承),用 cwd 锚定字体路径。
const fontBytes = readFileSync(resolve(process.cwd(), 'assets/fonts/NotoSansSC-PM.ttf'));

function installZoteroHttpStub(): () => void {
	(globalThis as Record<string, any>).Zotero = {
		HTTP: {
			request: async () => ({ response: fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) })
		}
	};
	return () => { delete (globalThis as Record<string, any>).Zotero; };
}

function block(id: string, rect: [number, number, number, number], sourceText: string, fontSize = 10): SourceBlock {
	return { id, pageIndex: 0, order: 0, type: 'paragraph', sourceText, lineRectsPdf: [rect], fontSize };
}

async function makeSourcePdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([612, 792]);
	return doc.save();
}

test('LO-1: 放不下的块保留原文(keptOriginal 计数),放得下的正常替换', async () => {
	const restore = installZoteroHttpStub();
	try {
		setFontSource('resource://test/NotoSansSC-PM.ttf');
		const sourceBytes = await makeSourcePdf();
		const fits = block('b-fit', [50, 700, 550, 750], 'A short paragraph of source text.');
		// 40×8pt 的小盒(过准入门槛: 宽≥36、高≥7)装 400 字译文 —— 最小字号也放不下。
		const impossible = block('b-impossible', [50, 600, 90, 608], 'Another source paragraph here.');
		const translations = new Map<string, string>([
			['b-fit', '一段很短的译文。'],
			['b-impossible', '译文'.repeat(200)]
		]);
		const built = await buildTranslatedPdf(sourceBytes, new Map([[0, { blocks: [fits, impossible], translations }]]), { dual: true });
		assert.equal(built.keptOriginal, 1, '放不下的那一块保留原文并计数');
		// 产出的 PDF 均有效可再解析。
		const mono = await PDFDocument.load(built.monoBytes);
		assert.equal(mono.getPageCount(), 1);
		assert.ok(built.dualBytes, 'dual PDF assembled');
		const dual = await PDFDocument.load(built.dualBytes!);
		assert.equal(dual.getPageCount(), 2, 'dual = 原文页 + 译文页');
	}
	finally { restore(); }
});

test('LO-1: 全部放得下时 keptOriginal 为 0', async () => {
	const restore = installZoteroHttpStub();
	try {
		setFontSource('resource://test/NotoSansSC-PM.ttf');
		const sourceBytes = await makeSourcePdf();
		const b = block('b-1', [50, 700, 550, 760], 'A comfortably sized source paragraph.');
		const built = await buildTranslatedPdf(
			sourceBytes,
			new Map([[0, { blocks: [b], translations: new Map([['b-1', '宽裕盒子里的一段译文。']]) }]]),
			{ dual: false }
		);
		assert.equal(built.keptOriginal, 0);
		assert.equal(built.dualBytes, null);
		const mono = await PDFDocument.load(built.monoBytes);
		assert.equal(mono.getPageCount(), 1);
	}
	finally { restore(); }
});
