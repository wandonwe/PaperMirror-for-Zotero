/**
 * Free Google Translate engine (no API key), ported from
 * old-immersive-translate's googleService:
 *   POST https://translate.googleapis.com/translate_a/t
 *        ?anno=3&client=te&v=1.0&format=html&sl=<sl>&tl=<tl>&tk=<tk>
 *   body: &q=<escaped>&q=<escaped>…   (one q per block; response array is
 *   aligned with q order)
 *
 * tk is calcGoogleTk over the concatenation of the exact q strings sent.
 * Note: this endpoint may be unreachable from mainland China; Bing Free is
 * provided for that case.
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import {
	calcGoogleTk,
	cleanGoogleAnnotatedText,
	escapeHTML,
	mapGoogleLang,
	splitLongText
} from './freeEngineUtils';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';

const BASE = 'https://translate.googleapis.com';
const PATH = '/translate_a/t?anno=3&client=te&v=1.0&format=html';
/** Per-POST budget, matching old-immersive-translate's request splitting. */
const BATCH_CHAR_LIMIT = 1600;

interface Piece {
	blockId: string;
	pieceIndex: number;
	q: string; // escaped text actually sent
}

function buildPieces(blocks: TranslationRequest['blocks']): Piece[] {
	const pieces: Piece[] = [];
	for (const block of blocks) {
		const parts = splitLongText(block.text, BATCH_CHAR_LIMIT);
		parts.forEach((part, pieceIndex) => {
			pieces.push({ blockId: block.id, pieceIndex, q: escapeHTML(part) });
		});
	}
	return pieces;
}

function batchPieces(pieces: Piece[]): Piece[][] {
	const batches: Piece[][] = [];
	let current: Piece[] = [];
	let size = 0;
	for (const piece of pieces) {
		if (current.length && size + piece.q.length > BATCH_CHAR_LIMIT) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(piece);
		size += piece.q.length;
	}
	if (current.length) {
		batches.push(current);
	}
	return batches;
}

/** Response entries: string | [text] | [text, detectedLang]. */
export function parseGoogleEntries(json: unknown, expected: number): string[] {
	let entries: unknown[];
	if (typeof json === 'string') {
		entries = [json];
	}
	else if (Array.isArray(json)) {
		// A single-q request may return ["text"] or [["text","lang"]]
		entries = json;
		if (expected === 1 && entries.length !== 1) {
			entries = [json];
		}
	}
	else {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Google response shape.');
	}
	if (entries.length !== expected) {
		throw new PaperMirrorError('BAD_RESPONSE', `Google returned ${entries.length} results for ${expected} inputs.`);
	}
	return entries.map((entry) => {
		if (typeof entry === 'string') {
			return entry;
		}
		if (Array.isArray(entry) && typeof entry[0] === 'string') {
			return entry[0];
		}
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Google response entry.');
	});
}

async function translateBatch(
	batch: Piece[],
	sl: string,
	tl: string,
	settings: ProviderSettings,
	signal: AbortSignal | undefined
): Promise<Map<string, string[]>> {
	const tk = calcGoogleTk(batch.map(p => p.q).join(''));
	const base = (settings.apiBaseURL || BASE).replace(/\/+$/, '');
	const url = `${base}${PATH}&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&tk=${tk}`;
	const rawBody = batch.map(p => `&q=${encodeURIComponent(p.q)}`).join('');
	const { json } = await requestJSON(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		rawBody,
		timeoutMs: settings.timeoutMs,
		signal
	});
	const texts = parseGoogleEntries(json, batch.length);
	const byBlock = new Map<string, string[]>();
	batch.forEach((piece, i) => {
		const cleaned = cleanGoogleAnnotatedText(texts[i] ?? '');
		const list = byBlock.get(piece.blockId) ?? [];
		list[piece.pieceIndex] = cleaned;
		byBlock.set(piece.blockId, list);
	});
	return byBlock;
}

export const googleFreeProvider: TranslationProvider = {
	id: 'google-free',
	displayName: 'Google Translate (free, no key)',
	defaultBaseURL: BASE,
	defaultModel: '',
	requiresApiKey: false,

	async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
		try {
			const started = Date.now();
			const result = await translateBatch(
				[{ blockId: 't', pieceIndex: 0, q: escapeHTML('Hello world') }],
				'en', 'zh-CN', settings, undefined
			);
			const text = result.get('t')?.[0] ?? '';
			return { ok: text.length > 0, httpStatus: 200, modelAvailable: true, elapsedMs: Date.now() - started };
		}
		catch (e) {
			const err = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			return { ok: false, message: err.code, httpStatus: err.httpStatus };
		}
	},

	async translate(request: TranslationRequest, settings: ProviderSettings, options: TranslateOptions): Promise<TranslationResponse> {
		const sl = mapGoogleLang(request.sourceLanguage || 'auto');
		const tl = mapGoogleLang(request.targetLanguage);
		const pieces = buildPieces(request.blocks);
		const merged = new Map<string, string[]>();
		for (const batch of batchPieces(pieces)) {
			if (options.signal?.aborted) {
				throw new PaperMirrorError('CANCELLED', 'Cancelled.');
			}
			const result = await translateBatch(batch, sl, tl, settings, options.signal);
			for (const [blockId, parts] of result) {
				const list = merged.get(blockId) ?? [];
				parts.forEach((part, i) => {
					if (part !== undefined) {
						list[i] = part;
					}
				});
				merged.set(blockId, list);
			}
		}
		return {
			translations: request.blocks
				.filter(b => merged.has(b.id))
				.map(b => ({
					id: b.id,
					translatedText: (merged.get(b.id) ?? []).join(' ').trim()
				}))
		};
	}
};
