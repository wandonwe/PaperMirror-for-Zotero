/**
 * Shared data model types for PaperMirror.
 */

export type BlockType
	= 'title'
	| 'heading'
	| 'paragraph'
	| 'list'
	| 'caption'
	| 'table'
	| 'unknown';

export interface BoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SourceBlock {
	id: string;
	pageIndex: number;
	order: number;
	type: BlockType;
	sourceText: string;
	boundingBox?: BoundingBox;
	/**
	 * Per-line rects in RAW PDF coordinates [x1, y1, x2, y2] (origin
	 * bottom-left), in reading order. Used by the on-page overlay, which needs
	 * sub-paragraph precision: a paragraph wrapping across columns yields lines
	 * in two different x ranges and must not be covered by one big box.
	 */
	lineRectsPdf?: [number, number, number, number][];
	/**
	 * Dominant font size of the source paragraph, in PDF points. The
	 * page-reconstruction view types the translation at this size so the
	 * rebuilt page keeps the original's typographic hierarchy.
	 */
	fontSize?: number;
	/**
	 * Which text column this block sits in (0-based, left to right). -1 marks a
	 * full-width block that spans the gutter (title, abstract). Semantic modules
	 * never cross columns, so this is how module grouping stays column-safe.
	 */
	column?: number;
	/**
	 * The semantic module this block belongs to (see reader/layoutModules). A
	 * module groups a heading with its following paragraphs for TRANSLATION
	 * CONTEXT only — every block still carries its own id, rect and translation,
	 * and is replaced in place independently.
	 */
	moduleId?: string;
	/**
	 * When this block is a coalesced semantic paragraph group, the ids of the
	 * original extraction fragments it was built from (reading order). The
	 * group is the atomic unit for translation, measurement and commit; this
	 * preserves the provenance instead of losing it in the merge.
	 */
	memberIds?: string[];
	/** Placeholders that must be restored after translation (formulas etc.). */
	placeholders?: PlaceholderEntry[];
	/** True when this block belongs to the references section. */
	isReference?: boolean;
}

export interface PlaceholderEntry {
	token: string;
	original: string;
}

export interface TranslatedBlock {
	id: string;
	translatedText: string;
}

export type LanguageCode = 'en' | 'zh-CN' | 'zh-TW' | 'auto' | string;

export interface TranslationRequest {
	/** Page this request belongs to — the provider pool shards on it. */
	pageIndex?: number;
	sourceLanguage: LanguageCode;
	targetLanguage: LanguageCode;
	documentTitle: string;
	previousContext: string;
	/**
	 * Section heading these blocks fall under, when a module was split across
	 * requests. Understanding-only: the model must NOT translate or return it.
	 */
	moduleContext?: string;
	blocks: {
		id: string;
		type: BlockType;
		text: string;
		/**
		 * Layout budget: the translation must fit roughly this many
		 * target-language characters (strict in-place replacement re-requests
		 * an over-long translation with this set). Absent = unconstrained.
		 */
		charBudget?: number;
	}[];
	glossary?: GlossaryRule[];
	/**
	 * 纯文本兜底模式 (参照 retain-pdf plain_text_retry): single-block request
	 * whose answer is the bare translation, no JSON envelope. Used as the LAST
	 * step of the repair chain — JSON/id mishandling cannot fail it.
	 */
	plain?: boolean;
}

export interface TranslationResponse {
	translations: TranslatedBlock[];
}

export interface TranslationProgress {
	completed: number;
	total: number;
}

export interface ValidationResult {
	ok: boolean;
	message?: string;
	httpStatus?: number;
	modelAvailable?: boolean;
	elapsedMs?: number;
}

export interface GlossaryRule {
	source: string;
	target: string;
	/** 'required': model must use it; 'suggested': for reference only. */
	mode: 'required' | 'suggested';
}

export interface ProviderSettings {
	providerId: string;
	apiBaseURL: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	customPrompt?: string;
	// ---- advanced, per-provider, all opt-in (unset = request unchanged) ------
	/** Custom request path appended to the Base URL (e.g. /v1/chat/completions). */
	apiPath?: string;
	/** Reasoning/thinking effort: '' | minimal | low | medium | high | xhigh. */
	reasoning?: string;
	/** Max output tokens; 0/undefined = provider default (batch: keep unset). */
	maxOutputTokens?: number;
	/** Sampling temperature; undefined = provider default. */
	temperature?: number;
}

export type PaperMirrorErrorCode
	= 'NO_API_KEY'
	| 'INVALID_API_KEY'
	| 'INVALID_MODEL'
	| 'NETWORK'
	| 'TIMEOUT'
	| 'RATE_LIMITED'
	| 'QUOTA_EXCEEDED'
	| 'BAD_RESPONSE'
	| 'NO_TEXT_LAYER'
	| 'PDF_ENCRYPTED'
	| 'EXTRACTION_FAILED'
	| 'READER_API_CHANGED'
	| 'CACHE_CORRUPT'
	| 'CANCELLED'
	| 'HTTP_INSECURE'
	| 'UNKNOWN';

export class PaperMirrorError extends Error {
	code: PaperMirrorErrorCode;
	httpStatus?: number;
	retryable: boolean;

	constructor(code: PaperMirrorErrorCode, message: string, options?: { httpStatus?: number; retryable?: boolean; cause?: unknown }) {
		super(message);
		this.name = 'PaperMirrorError';
		this.code = code;
		this.httpStatus = options?.httpStatus;
		this.retryable = options?.retryable ?? (code === 'NETWORK' || code === 'TIMEOUT' || code === 'RATE_LIMITED');
	}
}

/** Character record from Zotero's PDF.js fork (pdfDocument.getPageData). */
export interface PdfChar {
	c: string;
	rect: [number, number, number, number];
	fontName?: string;
	fontSize?: number;
	ignorable?: boolean;
	isolated?: boolean;
	spaceAfter?: boolean;
	lineBreakAfter?: boolean;
	paragraphBreakAfter?: boolean;
	rotation?: number;
}

export interface PageData {
	chars: PdfChar[];
	/** [x1, y1, x2, y2] page media/view box, PDF units. */
	viewBox?: [number, number, number, number];
	pageLabel?: string;
}
