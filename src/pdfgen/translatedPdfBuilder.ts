import { preserveCollapsedPlotPanels } from '../reader/compositePlotGuard';
/**
 * In-plugin translated-PDF builder — no external service, no Python.
 *
 * Takes the ORIGINAL PDF bytes plus the per-page blocks/translations the
 * session already produced, and writes the translation back into a real PDF
 * with pdf-lib: each translated body paragraph is first TYPESET into its own
 * box at the source point size (shrinking only when it genuinely runs longer);
 * only when it fits are the original line rects painted over in white (the
 * print page is white — the dark look in the reader is just the viewer theme)
 * and the translation drawn. A block that cannot fit even at the minimum size
 * KEEPS THE ORIGINAL (LO-1, 2.2.8) — never whitewashed-and-truncated, so the
 * exported file never loses content. Headings, titles, figures, tables,
 * references and metadata stay untouched, so the page's frame is the original's.
 *
 * CJK text needs a CJK font: a build-time GB2312 subset of Noto Sans SC
 * (~2.2 MB, the 6763 common hanzi + Latin/Greek/punctuation) ships inside the
 * XPI and is embedded whole. pdf-lib's RUNTIME subsetting is broken for this
 * font family (glyphs silently drop — verified), so it is deliberately OFF;
 * the build-time subset keeps the cost at ~1.4 MB per generated PDF. A
 * character outside the subset is replaced by 〓 rather than vanishing.
 *
 * The BabelDOC local-service path remains available as an optional advanced
 * mode for full layout re-flow; this builder is the zero-dependency default.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { SourceBlock } from '../types/models';
import { PaperMirrorError } from '../types/models';
import { isMetadataBlock } from '../reader/metaFilter';
import * as logger from '../utils/logger';
import { layoutBlock } from './textWrap';
import { stripStyleMarkers } from '../reader/styleRuns';
import { hasLegacyStatSymbols, repairLegacyStatSymbols } from './legacyPdfSymbols';

const MODULE = 'translatedPdfBuilder';

let fontURL: string | null = null;
let fontBytesCache: Uint8Array | null = null;

/** Called once at startup with rootURI so the bundled font can be loaded. */
export function setFontSource(url: string): void {
	fontURL = url;
	fontBytesCache = null;
}

async function loadFontBytes(): Promise<Uint8Array> {
	if (fontBytesCache) {
		return fontBytesCache;
	}
	if (!fontURL) {
		throw new PaperMirrorError('UNKNOWN', '内置字体未初始化。', { retryable: false });
	}
	// 双通道加载 (2.3.8): rootURI 可能是 file:// 或 jar:file://…!/ —— Zotero.HTTP
	// 对非 http(s) URL 的行为随版本有差异,失败就换 fetch 再试一条,两条都失败
	// 才报错(错误会显示在导出胶囊里,不再静默)。
	let buffer: ArrayBuffer | null = null;
	let lastError = '';
	try {
		const http = (globalThis as Record<string, any>).Zotero?.HTTP;
		const response = await http.request('GET', fontURL, {
			responseType: 'arraybuffer',
			timeout: 30000,
			successCodes: false,
			logBodyLength: 0
		});
		buffer = (response?.response as ArrayBuffer) ?? null;
	}
	catch (e) {
		lastError = String(e);
	}
	if (!buffer || buffer.byteLength < 1000) {
		try {
			const fetchFn = (globalThis as Record<string, any>).fetch as ((url: string) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>) | undefined;
			if (fetchFn) {
				buffer = await (await fetchFn(fontURL)).arrayBuffer();
			}
		}
		catch (e) {
			lastError = String(e);
		}
	}
	if (!buffer || buffer.byteLength < 1000) {
		throw new PaperMirrorError('UNKNOWN', `内置字体加载失败 (${fontURL})${lastError ? ` — ${lastError}` : ''}。`, { retryable: false });
	}
	fontBytesCache = new Uint8Array(buffer);
	return fontBytesCache;
}

export interface PageTranslationData {
	blocks: SourceBlock[];
	translations: Map<string, string>;
}

export interface BuildPdfOptions {
	/** Also produce the interleaved 原文/译文 dual PDF. */
	dual: boolean;
	onProgress?: (done: number, total: number) => void;
}

export interface BuiltPdfs {
	monoBytes: Uint8Array;
	dualBytes: Uint8Array | null;
	/**
	 * Blocks whose translation could not fit even at the minimum font size and
	 * therefore KEPT THE ORIGINAL text (2.2.8, LO-1) — nothing was painted over,
	 * nothing was truncated. The old behaviour (whitewash the original, then draw
	 * a "…"-clipped translation) silently destroyed the paragraph tail in the
	 * exported file.
	 */
	keptOriginal: number;
}

/** Which blocks get replaced in the generated file — body text AND headings. */
function isReplaceable(block: SourceBlock, translation: string | undefined): boolean {
	if (translation === undefined || !translation.trim()) {
		return false;
	}
	if (block.isReference || !block.lineRectsPdf?.length) {
		return false;
	}
	// 标题可译 (2.3.4, 第四批 item6 · LO-5): 此前导出一律跳过 heading/title,
	// 交付 PDF 节标题全英文、与阅读器不一致。现在放行 —— LO-1 的「放不下保留
	// 原文」兜底让超长标题译文绝不会截断,封面大字标题放不下就原样保留。
	if (block.type !== 'paragraph' && block.type !== 'caption' && block.type !== 'list'
		&& block.type !== 'heading' && block.type !== 'title') {
		return false;
	}
	// Cached translations of blocks the metadata filter has since learned to
	// exclude must not end up in the generated file either.
	if (isMetadataBlock(block.sourceText)) {
		return false;
	}
	const [x1, y1, x2, y2] = block.lineRectsPdf.reduce(
		(acc, r) => [Math.min(acc[0], r[0]), Math.min(acc[1], r[1]), Math.max(acc[2], r[2]), Math.max(acc[3], r[3])],
		[Infinity, Infinity, -Infinity, -Infinity]
	);
	return x2 - x1 >= 36 && y2 - y1 >= 7 && block.sourceText.trim().length >= 6;
}

const MASK_PAD = 1.2;
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.09, 0.1, 0.12);

/** [minX, minY, maxX, maxY] union of a block's line rects (PDF user space, y 向上). */
export function unionOfRects(rects: [number, number, number, number][]): [number, number, number, number] {
	return rects.reduce(
		(acc, r) => [Math.min(acc[0], r[0]), Math.min(acc[1], r[1]), Math.max(acc[2], r[2]), Math.max(acc[3], r[3])],
		[Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number]
	);
}

/**
 * 导出扩边测量 (2.3.4, 第四批 item6 · LO-6) — pure。阅读器算法3的 PDF 坐标版
 * (y 向上,「向下扩」= 压低 minY): 右扩以版面 95% 为界、下扩以页高 5% 为界,
 * 被任何邻块 union 盒的最近边截断(3pt 边距);上限右 ≤0.6×宽、下 ≤max(2.8×字号,
 * 0.5×高)。此前导出没有扩边阶梯,略长段直接一路缩到 5pt 近不可读,右/下留白
 * 却弃之不用。
 */
export function exportExpansionAllowance(
	box: [number, number, number, number],
	blockers: [number, number, number, number][],
	pageW: number,
	pageH: number,
	fontSize: number
): { right: number; down: number } {
	let right = Math.max(0, pageW * 0.95 - box[2]);
	let down = Math.max(0, box[1] - pageH * 0.05);
	for (const o of blockers) {
		// 垂直向重叠的邻块,且其延伸超过我的右缘 → 截断右扩(已重叠者截为 0)。
		const vOverlap = Math.min(box[3], o[3]) - Math.max(box[1], o[1]);
		if (vOverlap > 2 && o[2] > box[2] - 1) {
			right = Math.min(right, o[0] - box[2] - 3);
		}
		// 水平向重叠的邻块,且其延伸低于我的下缘 → 截断下扩。
		const hOverlap = Math.min(box[2], o[2]) - Math.max(box[0], o[0]);
		if (hOverlap > 2 && o[1] < box[1] + 1) {
			down = Math.min(down, box[1] - o[3] - 3);
		}
	}
	right = Math.max(0, Math.min(right, (box[2] - box[0]) * 0.6));
	down = Math.max(0, Math.min(down, Math.max(fontSize * 2.8, (box[3] - box[1]) * 0.5)));
	return { right, down };
}

export async function buildTranslatedPdf(
	sourceBytes: Uint8Array,
	pages: Map<number, PageTranslationData>,
	options: BuildPdfOptions
): Promise<BuiltPdfs> {
	const fontBytes = await loadFontBytes();

	const doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false, updateMetadata: false });
	doc.registerFontkit(fontkit as never);
	// subset:false is LOAD-BEARING — see the header comment.
	const font = await doc.embedFont(fontBytes, { subset: false });
	const glyphCheck = (fontkit as unknown as { create(b: Uint8Array): { hasGlyphForCodePoint(cp: number): boolean;
		unitsPerEm: number;
		layout(text: string): {
			glyphs: { bbox: { minY: number; maxY: number } }[];
			positions: { yOffset: number }[];
		}
	} }).create(fontBytes);
	const sanitize = (text: string): string => {
		let out = '';
		for (const ch of text) {
			// 空白不查字形 (3.0.3, Goenka 2016 p1 导出实证): 区域合并把段落边界记成
			// `\n\n`,而字体里没有换行符的字形 —— 每个换行都被换成了「〓」,导出页上
			// 摘要的每个分节前都多出两个方块。空白原样保留,交给 layoutBlock 折叠。
			out += /\s/.test(ch) || glyphCheck.hasGlyphForCodePoint(ch.codePointAt(0)!) ? ch : '〓';
		}
		return out;
	};

	const measure = (text: string, size: number): number => font.widthOfTextAtSize(text, size);
	const verticalMetrics = (text: string, size: number): { ascent: number; descent: number } => {
		const run = glyphCheck.layout(text);
		let top = 0, bottom = 0;
		run.glyphs.forEach((glyph, i) => {
			const offset = run.positions[i]?.yOffset ?? 0;
			top = Math.max(top, glyph.bbox.maxY + offset);
			bottom = Math.min(bottom, glyph.bbox.minY + offset);
		});
		return { ascent: top * size / glyphCheck.unitsPerEm, descent: -bottom * size / glyphCheck.unitsPerEm };
	};
	const pageList = doc.getPages();
	let keptOriginal = 0;
	let done = 0;

	for (const [pageIndex, data] of pages) {
		const page = pageList[pageIndex];
		if (!page) {
			continue;
		}
		const pageSize = page.getSize();
		const legacyStatSymbols = hasLegacyStatSymbols(page);
		// 扩边阶梯的遮挡物 (LO-6): 本页所有**其它**有几何的块的 union 盒(参考
		// 文献/表格/元数据也算 —— 它们的墨迹留在页面上,不得压)。
		const blockerOf = new Map<string, [number, number, number, number]>();
		for (const b of data.blocks) {
			if (b.lineRectsPdf?.length) {
				blockerOf.set(b.id, unionOfRects(b.lineRectsPdf));
			}
		}
		const masks: (() => void)[] = [];
		const textDraws: (() => void)[] = [];
		for (const block of preserveCollapsedPlotPanels(data.blocks)) {
			const cachedTranslation = data.translations.get(block.id);
			const translation = cachedTranslation === undefined ? undefined
				: repairLegacyStatSymbols(cachedTranslation, block.sourceText, legacyStatSymbols);
			if (block.preserveReason === 'composite-plot-collapsed-rows') {
				if (translation?.trim()) keptOriginal++;
				continue;
			}
			if (!isReplaceable(block, translation)) {
				continue;
			}
			if (/⟦PM\d+⟧|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(translation!)) {
				keptOriginal++;
				continue; // Do not paint unresolved placeholders/control glyphs over valid source content.
			}
			const rects = block.lineRectsPdf!;
			// 1. typeset FIRST — the mask is painted only after the translation is
			//    known to fit. 顺序是 LO-1 修复的核心 (2.2.8): 旧实现先涂白再排版,
			//    排不下也只画带「…」的截断译文 —— 原文已被涂掉,段落尾部在导出文件
			//    里**永久丢失**。现在放不下(最小字号仍溢出)就整块跳过: 不涂白、
			//    不画截断,原文完整保留 —— 与阅读器严格替换同一条铁律「宁保原文,
			//    不毁内容」。
			const union = unionOfRects(rects);
			const boxWidth = union[2] - union[0];
			const boxHeight = union[3] - union[1];
			const sourceSize = block.fontSize && block.fontSize > 0 ? block.fontSize : 10;
			const text = sanitize(stripStyleMarkers(translation!));
			// 扩边阶梯 (2.3.4, item6 · LO-6): 原盒原字号 → 右扩 → 下扩 → 双向
			// (全程不缩字) → 最大扩展 + 缩字 —— 与阅读器同序「先无损、后有损」。
			// 此前没有阶梯,略长段直接一路缩到 5pt 近不可读,留白弃之不用。
			const blockers = [...blockerOf.entries()].filter(([id]) => id !== block.id).map(([, b]) => b);
			const grow = exportExpansionAllowance(union, blockers, pageSize.width, pageSize.height, sourceSize);
			const steps: { w: number; h: number; shrink: boolean }[] = [
				{ w: boxWidth, h: boxHeight, shrink: false }
			];
			if (grow.right > 2) {
				steps.push({ w: boxWidth + grow.right, h: boxHeight, shrink: false });
			}
			if (grow.down > 2) {
				steps.push({ w: boxWidth, h: boxHeight + grow.down, shrink: false });
			}
			if (grow.right > 2 && grow.down > 2) {
				steps.push({ w: boxWidth + grow.right, h: boxHeight + grow.down, shrink: false });
			}
			steps.push({ w: boxWidth + Math.max(0, grow.right), h: boxHeight + Math.max(0, grow.down), shrink: true });
			let layout: ReturnType<typeof layoutBlock> | null = null;
			for (const step of steps) {
				const attempt = layoutBlock(text, step.w, step.h, sourceSize, measure,
					{ verticalMetrics, ...(step.shrink ? {} : { minSize: sourceSize }) });
				const clearOfSource = !attempt.overflow && attempt.lines.every((line, index) => {
					const baseline = union[3] - attempt.baselineOffsets[index]!;
					const ink = verticalMetrics(line, attempt.fontSize);
					const right = union[0] + measure(line, attempt.fontSize);
					return data.blocks.every(other => other.id === block.id || !(other.lineRectsPdf ?? []).some(r =>
						Math.min(right, r[2]) - Math.max(union[0], r[0]) > 0.01
						&& Math.min(baseline + ink.ascent, r[3]) - Math.max(baseline - ink.descent, r[1]) > 0.01));
				});
				if (clearOfSource) {
					layout = attempt;
					break;
				}
			}
			if (!layout) {
				keptOriginal++;
				continue; // 最大扩展+缩字仍放不下 → 保留原文,绝不涂白截断 (LO-1)
			}
			// Defer painting: a later block mask must never erase earlier glyphs.
			const fitted = layout;
			masks.push(() => {
				for (const [x1, y1, x2, y2] of rects) {
					page.drawRectangle({
						x: x1 - MASK_PAD,
						y: y1 - MASK_PAD,
						width: (x2 - x1) + MASK_PAD * 2,
						height: (y2 - y1) + MASK_PAD * 2,
						color: WHITE
					});
				}
			});
			textDraws.push(() => {
				for (const [index, line] of fitted.lines.entries()) {
					const baseline = union[3] - fitted.baselineOffsets[index]!;
					try {
						page.drawText(line, {
							x: union[0]!,
							y: baseline,
							size: fitted.fontSize,
							font,
							color: INK
						});
					}
					catch (e) {
						// A glyph outside the font (rare symbol): drop it, keep going.
						logger.debug(MODULE, 'drawText failed for one line', e);
					}
				}
			});
		}
		for (const paint of masks) paint();
		for (const draw of textDraws) draw();
		done++;
		options.onProgress?.(done, pages.size);
	}

	const monoBytes = await doc.save({ useObjectStreams: true });

	let dualBytes: Uint8Array | null = null;
	if (options.dual) {
		try {
			const original = await PDFDocument.load(sourceBytes, { updateMetadata: false });
			const mono = await PDFDocument.load(monoBytes, { updateMetadata: false });
			const dual = await PDFDocument.create();
			const count = Math.min(original.getPageCount(), mono.getPageCount());
			for (let i = 0; i < count; i++) {
				const [originalPage] = await dual.copyPages(original, [i]);
				const [monoPage] = await dual.copyPages(mono, [i]);
				dual.addPage(originalPage!);
				dual.addPage(monoPage!);
			}
			dualBytes = await dual.save({ useObjectStreams: true });
		}
		catch (e) {
			logger.warn(MODULE, 'Dual PDF assembly failed; returning mono only', e);
		}
	}

	return { monoBytes, dualBytes, keptOriginal };
}
