/**
 * Synthetic char-stream fixtures modeling the integration document types
 * required by the spec (single column, two column, Chinese, mixed, formulas,
 * captions, references). Used by tests/integration.
 */

import type { PdfChar } from '../../src/types/models';

export interface Token {
	text: string;
	x: number;
	y: number;
	size?: number;
	font?: string;
	br?: 'line' | 'para' | 'space';
	cjk?: boolean;
}

export function toChars(tokens: Token[]): PdfChar[] {
	const out: PdfChar[] = [];
	for (const token of tokens) {
		const glyphs = [...token.text];
		glyphs.forEach((g, i) => {
			const last = i === glyphs.length - 1;
			out.push({
				c: g,
				rect: [token.x + i * 5, token.y, token.x + i * 5 + 5, token.y + (token.size ?? 10)],
				fontSize: token.size ?? 10,
				fontName: token.font ?? 'Body',
				spaceAfter: !last ? false : token.br === 'space',
				lineBreakAfter: last && token.br === 'line',
				paragraphBreakAfter: last && token.br === 'para'
			});
		});
	}
	return out;
}

export const englishSingleColumn: PdfChar[] = toChars([
	{ text: 'Abstract', x: 50, y: 740, size: 14, font: 'Bold', br: 'para' },
	{ text: 'This retrospective study aims to evaluate the overall survival of', x: 50, y: 710, br: 'line' },
	{ text: 'patients using radiomics features extracted from CT images.', x: 50, y: 698, br: 'para' },
	{ text: 'Methods', x: 50, y: 660, size: 12, font: 'Bold', br: 'para' },
	{ text: 'We retrospectively enrolled 128 patients between 2015 and 2020.', x: 50, y: 632, br: 'para' }
]);

export const englishTwoColumn: PdfChar[] = toChars([
	{ text: 'Left column first paragraph with enough length to be body text here.', x: 50, y: 700, br: 'para' },
	{ text: 'Right column first paragraph with enough length to be body text here.', x: 320, y: 700, br: 'para' },
	{ text: 'Left column second paragraph continues down the left side of page.', x: 50, y: 640, br: 'para' },
	{ text: 'Right column second paragraph continues down the right side too.', x: 320, y: 640, br: 'para' }
]);

export const chinesePaper: PdfChar[] = toChars([
	{ text: '摘要', x: 50, y: 740, size: 14, font: 'Bold', br: 'para' },
	{ text: '本研究旨在回顾性评估影像组学特征对患者总生存期的预测价值。', x: 50, y: 710, br: 'para' },
	{ text: '方法', x: 50, y: 670, size: 12, font: 'Bold', br: 'para' },
	{ text: '我们回顾性纳入了二零一五年至二零二零年间的一百二十八名患者。', x: 50, y: 640, br: 'para' }
]);

export const mixedLanguage: PdfChar[] = toChars([
	{ text: '我们使用 radiomics 影像组学方法预测 overall survival 总生存期。', x: 50, y: 700, br: 'para' },
	{ text: 'The hazard ratio (HR) was 1.42 with 95% CI 1.10-1.83.', x: 50, y: 660, br: 'para' }
]);

export const withFormula: PdfChar[] = toChars([
	{ text: 'The linear predictor is defined as $y = \\beta_0 + \\beta_1 x_1$ for each patient.', x: 50, y: 700, br: 'para' },
	{ text: 'We minimized the loss L = 1/n Σ (y_i − ŷ_i)^2 during training.', x: 50, y: 660, br: 'para' }
]);

export const withCaption: PdfChar[] = toChars([
	{ text: 'Figure 1. Kaplan-Meier survival curves stratified by risk group.', x: 50, y: 300, size: 9, br: 'para' },
	{ text: 'Table 2. Baseline characteristics of the study cohort.', x: 50, y: 260, size: 9, br: 'para' }
]);

export const withReferences: PdfChar[] = toChars([
	{ text: 'In conclusion, radiomics provides prognostic value for survival prediction.', x: 50, y: 400, br: 'para' },
	{ text: 'References', x: 50, y: 360, size: 12, font: 'Bold', br: 'para' },
	{ text: '1. Smith J, Doe A. Radiomics in oncology. Nature Reviews 2019;5:112-130.', x: 50, y: 330, br: 'para' },
	{ text: '2. Lee K. Survival modeling. Journal of Clinical Oncology 2020;8:44-59.', x: 50, y: 315, br: 'para' }
]);

/** Empty char stream — models a scanned (image-only) page. */
export const scannedPage: PdfChar[] = [];
