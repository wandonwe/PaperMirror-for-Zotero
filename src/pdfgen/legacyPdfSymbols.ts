import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFPage } from 'pdf-lib';

/**
 * This legacy publisher font has an incomplete ToUnicode table: /C0 (code 3)
 * renders a minus and /onequarter (188) renders an equals sign. These are NOT
 * universal mappings for control characters or fractions. Require the font and
 * its encoding signature, then require the same numeric token in the source.
 * Unknown encodings remain subject to the caller's preserve-original guard.
 */
export function hasLegacyStatSymbols(page: PDFPage): boolean {
	const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
	if (!(fonts instanceof PDFDict)) return false;
	return fonts.entries().some(([, ref]) => {
		const font = page.doc.context.lookup(ref);
		if (!(font instanceof PDFDict)) return false;
		const name = font.lookup(PDFName.of('BaseFont'));
		if (!(name instanceof PDFName) || !/^(?:[A-Z]{6}\+)?AdvP4C4E74$/.test(name.decodeText())) return false;
		const encoding = font.lookup(PDFName.of('Encoding'));
		if (!(encoding instanceof PDFDict)) return false;
		const differences = encoding.lookup(PDFName.of('Differences'));
		if (!(differences instanceof PDFArray)) return false;
		const names = new Map<number, string>();
		let code = -1;
		for (let i = 0; i < differences.size(); i++) {
			const entry = differences.lookup(i);
			if (entry instanceof PDFNumber) code = entry.asNumber();
			else if (entry instanceof PDFName && code >= 0) names.set(code++, entry.decodeText());
		}
		return names.get(2) === 'C6' && names.get(3) === 'C0' && names.get(188) === 'onequarter';
	});
}

/** Repair only source-attested statistical tokens; never drop unknown controls. */
export function repairLegacyStatSymbols(translation: string, source: string, verifiedFont: boolean): string {
	if (!verifiedFont) return translation;
	const number = String.raw`(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+−-]?\d+)?(?!\d|\.\d)`;
	const negative = new RegExp(String.raw`\u0003\s*(${number})`, 'gu');
	const sourceNegatives = new Set([...source.matchAll(negative)].map(m => m[1]));
	let text = translation.replace(negative, (token, value: string) => sourceNegatives.has(value) ? `−${value}` : token);
	// Limit the misleading fraction glyph to a source-attested P-value. A real
	// fraction elsewhere, including in this same paragraph, must stay untouched.
	const equality = new RegExp(String.raw`\b[Pp](?:\s+for\s+difference)?\s*¼\s*(${number})`, 'gu');
	const sourcePValues = new Set([...source.matchAll(equality)].map(m => m[1]));
	text = text.replace(equality, (token, value: string) => sourcePValues.has(value) ? token.replace('¼', '=') : token);
	return text;
}
