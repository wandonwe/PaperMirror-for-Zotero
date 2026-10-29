import fontkit, { type Font } from '@pdf-lib/fontkit';
import {
	PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream,
	decodePDFRawStream
} from 'pdf-lib';
import { parsedDocument } from './legacyTextEncoding';
import { relationFromGlyphPath } from './symbolFontSemantics';

// The browser entry exports the factory on its default object; Node's CJS
// entry also has a named export, which must not hide a browser build failure.
const createFont = (fontkit as unknown as {create(data: Uint8Array): Font}).create;

export interface SymbolGlyphObservation {
	fontName: string;
	originalCharCode: number;
	unicode: string;
}

const MAX_FONT_BYTES = 2 * 1024 * 1024;
const MAX_GLYPHS = 8192;
const candidateUnicode = new Set(['$', '¼']);
const fontKey = PDFName.of('Font');
const baseFontKey = PDFName.of('BaseFont');
const subtypeKey = PDFName.of('Subtype');

/** A read-only sfnt envelope lets fontkit read an original Type1C CFF table.
 * It is never installed as a browser font, and its CFF bytes stay unchanged. */
export function wrapRawCff(raw: Uint8Array): Uint8Array {
	if (raw.length < 4 || raw.length > MAX_FONT_BYTES || raw[0] !== 1
		|| raw[2]! < 4 || raw[2]! > raw.length || raw[3]! < 1 || raw[3]! > 4) {
		throw new RangeError('Unsupported embedded CFF data');
	}
	const paddedLength = Math.ceil(raw.length / 4) * 4;
	const wrapped = new Uint8Array(28 + paddedLength);
	const view = new DataView(wrapped.buffer);
	wrapped.set([0x4f, 0x54, 0x54, 0x4f]); // OTTO
	view.setUint16(4, 1);
	view.setUint16(6, 16);
	wrapped.set([0x43, 0x46, 0x46, 0x20], 12); // CFF table
	view.setUint32(20, 28);
	view.setUint32(24, raw.length);
	wrapped.set(raw, 28);
	let checksum = 0;
	for (let offset = 28; offset < wrapped.length; offset += 4) {
		checksum = (checksum + view.getUint32(offset)) >>> 0;
	}
	view.setUint32(16, checksum);
	return wrapped;
}

interface CffFont {
	isCIDFont?: boolean;
	topDict: { CharStrings?: unknown[]; FDSelect?: unknown; CharstringType?: number; FontMatrix?: unknown };
	getGlyphName: (gid: number) => string | null;
}

interface EmbeddedFont {
	font: ReturnType<typeof createFont>;
	gids: Map<string, number | null>;
	relations: Map<number, string | undefined>;
}

const parsedFonts = new WeakMap<PDFDict, EmbeddedFont | null>();
const pageResources = new WeakMap<PDFDocument, Map<number, Map<string, PDFDict | null>>>();

/** Names connect PDF.js observations to resources; duplicate names never vote. */
function fontsForPage(pdf: PDFDocument, pageIndex: number): Map<string, PDFDict | null> {
	let pages = pageResources.get(pdf);
	if (!pages) {
		pages = new Map();
		pageResources.set(pdf, pages);
	}
	const cached = pages.get(pageIndex);
	if (cached) return cached;
	const result = new Map<string, PDFDict | null>();
	const visited = new Set<PDFDict>();
	let resourceCount = 0;
	const collect = (resources: PDFDict, depth: number): void => {
		if (visited.has(resources)) return;
		if (depth > 8 || ++resourceCount > 128) throw new RangeError('Resource traversal limit');
		visited.add(resources);
		const fonts = resources.lookup(fontKey);
		if (fonts instanceof PDFDict) {
			for (const [, ref] of fonts.entries()) {
				const font = pdf.context.lookup(ref);
				if (!(font instanceof PDFDict)) continue;
				const base = font.lookup(baseFontKey);
				if (!(base instanceof PDFName)) continue;
				const name = base.decodeText();
				if (!result.has(name)) result.set(name, font);
				else if (result.get(name) !== font) result.set(name, null);
			}
		}
		const objects = resources.lookup(PDFName.of('XObject'));
		if (!(objects instanceof PDFDict)) return;
		for (const [, ref] of objects.entries()) {
			const object = pdf.context.lookup(ref);
			if (!(object instanceof PDFRawStream)
				|| object.dict.lookup(subtypeKey)?.toString() !== '/Form') continue;
			const nested = object.dict.lookup(PDFName.of('Resources'));
			if (nested instanceof PDFDict) collect(nested, depth + 1);
		}
	};
	try {
		const resources = pdf.getPage(pageIndex).node.Resources();
		if (resources) collect(resources, 0);
	} catch {
		// A partial traversal cannot establish that a resource name is unique.
		result.clear();
	}
	pages.set(pageIndex, result);
	return result;
}

function readEmbeddedFont(fontDict: PDFDict): EmbeddedFont | undefined {
	if (parsedFonts.has(fontDict)) return parsedFonts.get(fontDict) ?? undefined;
	parsedFonts.set(fontDict, null);
	try {
		if (fontDict.lookup(subtypeKey)?.toString() !== '/Type1') return undefined;
		const descriptor = fontDict.lookup(PDFName.of('FontDescriptor'));
		if (!(descriptor instanceof PDFDict)) return undefined;
		const stream = descriptor.lookup(PDFName.of('FontFile3'));
		if (!(stream instanceof PDFRawStream)
			|| stream.dict.lookup(subtypeKey)?.toString() !== '/Type1C'
			|| stream.contents.length > MAX_FONT_BYTES) return undefined;
		const raw = decodePDFRawStream(stream).decode();
		const font = createFont(wrapRawCff(raw));
		// fontkit exposes the original CFF directory but omits it from its d.ts.
		const cff = (font as unknown as { 'CFF '?: CffFont })['CFF '];
		const count = cff?.topDict.CharStrings?.length;
		if (!cff || cff.isCIDFont || cff.topDict.FDSelect
			|| cff.topDict.CharstringType !== 2 || !count || count > MAX_GLYPHS) return undefined;
		// Classification uses the untransformed outline. Only orientation-
		// preserving uniform scales and translations keep that evidence valid.
		// fontkit supplies the CFF default when FontMatrix was omitted.
		const matrix = cff.topDict.FontMatrix;
		if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)
			|| matrix[0] <= 0 || matrix[0] !== matrix[3] || matrix[1] !== 0 || matrix[2] !== 0) return undefined;
		const gids = new Map<string, number | null>();
		for (let gid = 1; gid < count; gid++) {
			const name = cff.getGlyphName(gid);
			if (name) gids.set(name, gids.has(name) ? null : gid);
		}
		const parsed = { font, gids, relations: new Map<number, string | undefined>() };
		parsedFonts.set(fontDict, parsed);
		return parsed;
	} catch {
		return undefined;
	}
}

/** PDF Encoding selects a glyph; its misleading name is not its meaning.
 * Only the two required WinAnsi slots are known here. Explicit Differences
 * remain usable with an otherwise unknown or absent base encoding. */
function encodedGlyphName(font: PDFDict, code: number): string | undefined {
	if (!Number.isInteger(code) || code < 0 || code > 255) return undefined;
	const encoding = font.lookup(PDFName.of('Encoding'));
	let base: string | undefined;
	if (encoding instanceof PDFName) base = encoding.decodeText();
	else if (encoding instanceof PDFDict) {
		const baseName = encoding.lookup(PDFName.of('BaseEncoding'));
		if (baseName instanceof PDFName) base = baseName.decodeText();
		const differences = encoding.lookup(PDFName.of('Differences'));
		if (differences instanceof PDFArray) {
			let current = -1;
			let match: string | undefined;
			let matched = false;
			for (let index = 0; index < differences.size(); index++) {
				const value = differences.lookup(index);
				if (value instanceof PDFNumber) current = value.asNumber();
				else if (value instanceof PDFName && Number.isInteger(current) && current >= 0 && current <= 255) {
					if (current === code) {
						if (matched) return undefined;
						match = value.decodeText();
						matched = true;
					}
					current++;
				} else return undefined;
			}
			if (matched) return match;
		}
	}
	if (base !== 'WinAnsiEncoding') return undefined;
	return code === 36 ? 'dollar' : code === 188 ? 'onequarter' : undefined;
}

function relationForCode(fontDict: PDFDict, parsed: EmbeddedFont, code: number): { gid: number; relation: string } | undefined {
	const name = encodedGlyphName(fontDict, code);
	const gid = name ? parsed.gids.get(name) : undefined;
	if (gid === undefined || gid === null) return undefined;
	if (!parsed.relations.has(gid)) {
		try {
			const path = parsed.font.getGlyph(gid).path as unknown as {
				commands: Parameters<typeof relationFromGlyphPath>[0];
			};
			parsed.relations.set(gid, relationFromGlyphPath(path.commands) ?? undefined);
		} catch {
			parsed.relations.set(gid, undefined);
		}
	}
	const relation = parsed.relations.get(gid);
	return relation ? { gid, relation } : undefined;
}

/** Repair only an observed printable character whose original embedded glyph
 * has one unambiguous relation shape. Missing evidence always leaves it alone. */
export async function embeddedSymbolRepairs(
	doc: object & { getData?: () => Promise<Uint8Array> },
	pageIndex: number,
	observations: readonly SymbolGlyphObservation[]
): Promise<Map<string, Map<string, string>>> {
	const result = new Map<string, Map<string, string>>();
	if (!doc.getData || !Number.isInteger(pageIndex) || pageIndex < 0) return result;
	const groups = new Map<string, Map<string, Set<number>>>();
	for (const observation of observations) {
		if (!candidateUnicode.has(observation.unicode) || !observation.fontName) continue;
		let byUnicode = groups.get(observation.fontName);
		if (!byUnicode) { byUnicode = new Map(); groups.set(observation.fontName, byUnicode); }
		let codes = byUnicode.get(observation.unicode);
		if (!codes) { codes = new Set(); byUnicode.set(observation.unicode, codes); }
		codes.add(observation.originalCharCode);
	}
	if (!groups.size) return result;
	try {
		const pdf = await parsedDocument(doc);
		const resources = fontsForPage(pdf, pageIndex);
		for (const [fontName, byUnicode] of groups) {
			const fontDict = resources.get(fontName);
			if (!fontDict) continue;
			const font = readEmbeddedFont(fontDict);
			if (!font) continue;
			for (const [unicode, codes] of byUnicode) {
				let identified: { gid: number; relation: string } | undefined;
				let ambiguous = false;
				for (const code of codes) {
					const current = relationForCode(fontDict, font, code);
					if (!current || (identified && (identified.gid !== current.gid || identified.relation !== current.relation))) {
						ambiguous = true;
						break;
					}
					identified = current;
				}
				if (!ambiguous && identified) {
					let repairs = result.get(fontName);
					if (!repairs) { repairs = new Map(); result.set(fontName, repairs); }
					repairs.set(unicode, identified.relation);
				}
			}
		}
	} catch {
		// Original-font access is optional; it cannot break the text extraction.
	}
	return result;
}
