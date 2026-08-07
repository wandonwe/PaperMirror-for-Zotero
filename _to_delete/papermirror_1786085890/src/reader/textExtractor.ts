/**
 * Per-page text extraction: adapter (getPageData) -> blockBuilder, with the
 * PDFWorker plain-text path as fallback, and a no-text-layer detector.
 */

import type { SourceBlock } from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { buildBlocks, buildBlocksFromPlainText, medianFontSize } from './blockBuilder';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'textExtractor';

export class TextExtractor {
	private reader: ReaderLike;
	private includeReferences: boolean;
	private referencesStartedByPage = new Map<number, boolean>();
	private fallbackPages: string[] | null = null;
	private bodyFontSize = 0;

	constructor(reader: ReaderLike, options: { includeReferences: boolean }) {
		this.reader = reader;
		this.includeReferences = options.includeReferences;
	}

	setIncludeReferences(include: boolean): void {
		if (this.includeReferences !== include) {
			this.includeReferences = include;
		}
	}

	private referencesAlreadyStarted(pageIndex: number): boolean {
		for (const [page, started] of this.referencesStartedByPage) {
			if (page < pageIndex && started) {
				return true;
			}
		}
		return false;
	}

	async extractPage(pageIndex: number): Promise<SourceBlock[]> {
		// Primary path: fork getPageData with coordinates
		try {
			const { pageData, pageWidth, pageHeight } = await adapter.getPageData(this.reader, pageIndex);
			if (!pageData.chars.length) {
				// Either an image-only page or a scanned PDF. Distinguish by
				// checking a couple of other pages.
				const scanned = await this.looksScanned(pageIndex);
				if (scanned) {
					throw new PaperMirrorError('NO_TEXT_LAYER', 'This PDF has no text layer and needs OCR.');
				}
				return [];
			}
			const result = buildBlocks(pageData.chars, {
				pageIndex,
				pageWidth,
				pageHeight,
				bodyFontSize: this.bodyFontSize || undefined,
				includeReferences: this.includeReferences,
				referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex)
			});
			this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
			return result.blocks;
		}
		catch (e) {
			if (e instanceof PaperMirrorError && (e.code === 'NO_TEXT_LAYER' || e.code === 'PDF_ENCRYPTED')) {
				throw e;
			}
			logger.warn(MODULE, `getPageData path failed for page ${pageIndex}; trying PDFWorker fallback`, e);
		}

		// Fallback path: PDFWorker full text split by page
		const itemID = this.reader.itemID;
		if (!itemID) {
			throw new PaperMirrorError('EXTRACTION_FAILED', 'No attachment item for this reader.');
		}
		if (!this.fallbackPages) {
			this.fallbackPages = await adapter.getFullTextPages(itemID);
		}
		const pageText = this.fallbackPages[pageIndex] ?? '';
		if (!pageText.trim()) {
			if ((this.fallbackPages.join('').trim().length) === 0) {
				throw new PaperMirrorError('NO_TEXT_LAYER', 'This PDF has no text layer and needs OCR.');
			}
			return [];
		}
		const result = buildBlocksFromPlainText(pageText, pageIndex, {
			includeReferences: this.includeReferences,
			referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex)
		});
		this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
		return result.blocks;
	}

	/** Sample up to 3 pages; if all are char-empty, treat as scanned. */
	private async looksScanned(originPage: number): Promise<boolean> {
		const count = adapter.getPageCount(this.reader);
		const samples = [0, Math.floor(count / 2), count - 1]
			.filter(p => p >= 0 && p < count && p !== originPage)
			.slice(0, 2);
		for (const page of samples) {
			try {
				const { pageData } = await adapter.getPageData(this.reader, page);
				if (pageData.chars.length > 10) {
					return false;
				}
			}
			catch {
				// treat as empty
			}
		}
		return true;
	}

	/** Establish the document body font size from the first pages (lazy). */
	async prime(): Promise<void> {
		if (this.bodyFontSize > 0) {
			return;
		}
		try {
			const { pageData, pageWidth, pageHeight } = await adapter.getPageData(this.reader, adapter.getCurrentPageIndex(this.reader));
			const result = buildBlocks(pageData.chars, { pageIndex: 0, pageWidth, pageHeight });
			void result;
			// medianFontSize over paragraphs is embedded in buildBlocks; keep a
			// simple estimate here from raw chars:
			const sizes = pageData.chars
				.filter(c => typeof c.fontSize === 'number' && !c.ignorable)
				.map(c => c.fontSize as number)
				.sort((a, b) => a - b);
			if (sizes.length) {
				this.bodyFontSize = sizes[Math.floor(sizes.length / 2)] ?? 0;
			}
		}
		catch {
			// priming is best-effort
		}
	}
}

export { medianFontSize };
