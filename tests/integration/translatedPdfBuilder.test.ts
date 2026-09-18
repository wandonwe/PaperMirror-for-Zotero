import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFPage } from 'pdf-lib';
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


test('all replacement masks precede all translated text on a page', async () => {
 const restore = installZoteroHttpStub();
 const { PDFPage } = await import('pdf-lib');
 const events: string[] = [];
 const rectangle = PDFPage.prototype.drawRectangle;
 const text = PDFPage.prototype.drawText;
 PDFPage.prototype.drawRectangle = function (...args) { events.push('mask'); return rectangle.apply(this, args); };
 PDFPage.prototype.drawText = function (...args) { events.push('text'); return text.apply(this, args); };
 try {
  setFontSource('resource://test/NotoSansSC-PM.ttf');
  const blocks = [block('upper', [50, 700, 250, 720], 'The upper source paragraph.'),
                  block('lower', [50, 670, 250, 690], 'The lower source paragraph.')];
  await buildTranslatedPdf(await makeSourcePdf(), new Map([[0, { blocks,
   translations: new Map([['upper', '上方译文 gypq'], ['lower', '下方译文']]) }]]), { dual: false });
  assert.ok(events.includes('text'));
  assert.ok(events.lastIndexOf('mask') < events.indexOf('text'), 'a later mask must never erase translated glyphs');
 } finally {
  PDFPage.prototype.drawRectangle = rectangle;
  PDFPage.prototype.drawText = text;
  restore();
 }
});

test('a fragmented source block must not paint translation onto a neighbouring source line', async () => {
 const restore = installZoteroHttpStub();
 try {
  setFontSource('resource://test/NotoSansSC-PM.ttf');
  const fragment = block('fragment', [200, 700, 300, 710], 'A fragmented source paragraph.');
  fragment.lineRectsPdf!.push([50, 680, 300, 690]);
  const neighbour = block('neighbour', [50, 700, 120, 710], 'Preserved nearby label.');
  const built = await buildTranslatedPdf(await makeSourcePdf(), new Map([[0, { blocks: [fragment, neighbour],
   translations: new Map([['fragment', '这行译文不得占用左侧邻居原文的位置。']]) }]]), { dual: false });
  assert.equal(built.keptOriginal, 1);
 } finally { restore(); }
});

test('unresolved formula placeholders retain original instead of exporting broken glyphs', async () => {
 const restore = installZoteroHttpStub();
 try {
  setFontSource('resource://test/NotoSansSC-PM.ttf');
  const b = block('formula', [50, 700, 300, 720], 'Test P = 0.01 for the original formula.');
  const built = await buildTranslatedPdf(await makeSourcePdf(), new Map([[0, { blocks: [b],
   translations: new Map([['formula', '检验结果：⟦PM0⟧']]) }]]), { dual: false });
  assert.equal(built.keptOriginal, 1);
 } finally { restore(); }
});

async function makeLegacySymbolPdf(fontName = 'ABCDEF+AdvP4C4E74'): Promise<Uint8Array> {
 const doc = await PDFDocument.create();
 const page = doc.addPage([612, 792]);
 const font = doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: fontName,
  Encoding: { Type: 'Encoding', Differences: [2, 'C6', 'C0', 121, 'y', 188, 'onequarter'] } });
 page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { Legacy: doc.context.register(font) } }));
 return doc.save();
}

test('verified legacy symbol font repairs signed statistics without discarding translated paragraphs', async () => {
 const restore = installZoteroHttpStub();
 const draw = PDFPage.prototype.drawText;
 const drawn: string[] = [];
 PDFPage.prototype.drawText = function (text, options) { drawn.push(text); return draw.call(this, text, options); };
 try {
  setFontSource('resource://test/NotoSansSC-PM.ttf');
  const b = block('stats', [50, 600, 550, 750], 'Coefficient: \u00030.523; P ¼ 0.015. CI: \u00030.58 to 2.58.');
  const built = await buildTranslatedPdf(await makeLegacySymbolPdf(), new Map([[0, { blocks: [b],
   translations: new Map([['stats', '系数：\u00030.523；P ¼ 0.015。置信区间：\u00030.58 至 2.58。第二段照常翻译。']]) }]]), { dual: false });
  assert.equal(built.keptOriginal, 0);
  assert.match(drawn.join(''), /−0\.523/);
  assert.match(drawn.join(''), /−0\.58/);
  assert.match(drawn.join(''), /P = 0\.015/);
  assert.match(drawn.join(''), /第二段/);
  assert.doesNotMatch(drawn.join(''), /[\u0003¼〓]/);
 } finally { PDFPage.prototype.drawText = draw; restore(); }
});

test('unknown fonts and unmatched numeric controls are not guessed or deleted', async () => {
 const restore = installZoteroHttpStub();
 try {
  setFontSource('resource://test/NotoSansSC-PM.ttf');
  for (const [fontName, translated] of [
   ['UnknownFont', '系数：\u00030.523'],
   ['ABCDEF+AdvP4C4E74', '系数：\u00030.999'],
   ['ABCDEF+AdvP4C4E74', '未知符号：\u0002']
  ]) {
   const b = block('stats', [50, 600, 550, 750], 'Coefficient: \u00030.523; P ¼ 0.015.');
   const built = await buildTranslatedPdf(await makeLegacySymbolPdf(fontName), new Map([[0, { blocks: [b],
    translations: new Map([['stats', translated!]]) }]]), { dual: false });
   assert.equal(built.keptOriginal, 1);
  }
 } finally { restore(); }
});

test('literal fractions remain fractions even on a page using the legacy symbol font', async () => {
 const restore = installZoteroHttpStub();
 const draw = PDFPage.prototype.drawText;
 const drawn: string[] = [];
 PDFPage.prototype.drawText = function (text, options) { drawn.push(text); return draw.call(this, text, options); };
 try {
  setFontSource('resource://test/NotoSansSC-PM.ttf');
  const b = block('fraction', [50, 600, 550, 750], 'Use ¼ of the sample.');
  const built = await buildTranslatedPdf(await makeLegacySymbolPdf(), new Map([[0, { blocks: [b],
   translations: new Map([['fraction', '使用样本的 ¼。']]) }]]), { dual: false });
  assert.equal(built.keptOriginal, 0);
  assert.match(drawn.join(''), /¼/);
 } finally { PDFPage.prototype.drawText = draw; restore(); }
});

test('cached collapsed forest-plot cells preserve the whole panel without white masks', async () => {
 const restore = installZoteroHttpStub();
 const rectangle = PDFPage.prototype.drawRectangle;
 const draw = PDFPage.prototype.drawText;
 const masks: number[] = [];
 const drawn: string[] = [];
 PDFPage.prototype.drawRectangle = function (options) { masks.push(options?.y ?? 0); return rectangle.call(this, options); };
 PDFPage.prototype.drawText = function (text, options) { drawn.push(text); return draw.call(this, text, options); };
 try {
  setFontSource('resource://test/NotoSansSC-PM.ttf');
  const header = { ...block('header', [50, 700, 550, 712], 'Author (Year) N Correlation Weight (95% CI)'), tableId: 'panel', tableRow: 0 };
  const body = { ...block('labels', [50, 670, 250, 680], 'Smith (2021) 21 Lee (2018) 35 Jones (2020) 40 Random effects model Heterogeneity: I2 = 64%'), tableId: 'panel', tableRow: 1 };
  body.lineRectsPdf = [670, 650, 630, 610, 590].map(y => [50, y, 250, y + 10]);
  const caption = block('caption', [50, 450, 550, 480], 'Meta-analysis of correlation and bias.');
  const built = await buildTranslatedPdf(await makeSourcePdf(), new Map([[0, { blocks: [header, body, caption],
   translations: new Map([['header', '作者 年份 样本量 权重'], ['labels', '多项研究被错误合并成的一整段译文。'], ['caption', '相关性与偏差的荟萃分析。']]) }]]), { dual: false });
  assert.equal(built.keptOriginal, 2);
  assert.deepEqual(drawn, ['相关性与偏差的荟萃分析。']);
  assert.ok(masks.every(y => y < 500), 'no replacement mask may touch the forest panel');
 } finally { PDFPage.prototype.drawRectangle = rectangle; PDFPage.prototype.drawText = draw; restore(); }
});
