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
	const http = (globalThis as Record<string, any>).Zotero?.HTTP;
	const response = await http.request('GET', fontURL, {
		responseType: 'arraybuffer',
		timeout: 30000,
		successCodes: false,
		logBodyLength: 0
	});
	const buffer = response?.response as ArrayBuffer;
	if (!buffer || buffer.byteLength < 1000) {
		throw new PaperMirrorError('UNKNOWN', `内置字体加载失败 (${fontURL})。`, { retryable: false });
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

/** Which blocks get replaced in the generated file — body text only. */
function isReplaceable(block: SourceBlock, translation: string | undefined): boolean {
	if (translation === undefined || !translation.trim()) {
		return false;
	}
	if (block.isReference || !block.lineRectsPdf?.length) {
		return false;
	}
	if (block.type !== 'paragraph' && block.type !== 'caption' && block.type !== 'list') {
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
	const glyphCheck = (fontkit as unknown as { create(b: Uint8Array): { hasGlyphForCodePoint(cp: number): boolean } }).create(fontBytes);
	const sanitize = (text: string): string => {
		let out = '';
		for (const ch of text) {
			out += glyphCheck.hasGlyphForCodePoint(ch.codePointAt(0)!) ? ch : '〓';
		}
		return out;
	};

	const measure = (text: string, size: number): number => font.widthOfTextAtSize(text, size);
	const pageList = doc.getPages();
	let keptOriginal = 0;
	let done = 0;

	for (const [pageIndex, data] of pages) {
		const page = pageList[pageIndex];
		if (!page) {
			continue;
		}
		for (const block of data.blocks) {
			const translation = data.translations.get(block.id);
			if (!isReplaceable(block, translation)) {
				continue;
			}
			const rects = block.lineRectsPdf!;
			// 1. typeset FIRST — the mask is painted only after the translation is
			//    known to fit. 顺序是 LO-1 修复的核心 (2.2.8): 旧实现先涂白再排版,
			//    排不下也只画带「…」的截断译文 —— 原文已被涂掉,段落尾部在导出文件
			//    里**永久丢失**。现在放不下(最小字号仍溢出)就整块跳过: 不涂白、
			//    不画截断,原文完整保留 —— 与阅读器严格替换同一条铁律「宁保原文,
			//    不毁内容」。
			const union = rects.reduce(
				(acc, r) => [Math.min(acc[0], r[0]), Math.min(acc[1], r[1]), Math.max(acc[2], r[2]), Math.max(acc[3], r[3])],
				[Infinity, Infinity, -Infinity, -Infinity]
			);
			const boxWidth = union[2]! - union[0]!;
			const boxHeight = union[3]! - union[1]!;
			const sourceSize = block.fontSize && block.fontSize > 0 ? block.fontSize : 10;
			const layout = layoutBlock(sanitize(stripStyleMarkers(translation!)), boxWidth, boxHeight, sourceSize, measure);
			if (layout.overflow) {
				keptOriginal++;
				continue; // 放不下 → 保留原文,绝不涂白截断
			}
			// 2. the translation fits — NOW paint out the original lines.
			for (const [x1, y1, x2, y2] of rects) {
				page.drawRectangle({
					x: x1 - MASK_PAD,
					y: y1 - MASK_PAD,
					width: (x2 - x1) + MASK_PAD * 2,
					height: (y2 - y1) + MASK_PAD * 2,
					color: WHITE
				});
			}
			// First baseline: ascent ≈ 0.86 em below the box top.
			let baseline = union[3]! - layout.fontSize * 0.86;
			for (const line of layout.lines) {
				if (baseline < union[1]! - layout.fontSize * 0.2) {
					break;
				}
				try {
					page.drawText(line, {
						x: union[0]!,
						y: baseline,
						size: layout.fontSize,
						font,
						color: INK
					});
				}
				catch (e) {
					// A glyph outside the font (rare symbol): drop it, keep going.
					logger.debug(MODULE, 'drawText failed for one line', e);
				}
				baseline -= layout.lineHeight;
			}
		}
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
