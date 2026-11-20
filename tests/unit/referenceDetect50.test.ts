import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeReferencePage, looksLikeReferenceText, isReferenceTailLine, startsReferenceEntry } from '../../src/reader/referenceDetect';
import { looksLikeListStart } from '../../src/reader/paragraphHeuristics';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';

// Synthetic entries in the shape of the 联网校验 3384 p10 continuation page.
const ENTRIES = [
	'25. Mahoney OM, Kinsey T. Overhang of the femoral component in total knee arthroplasty. J Bone Joint Surg Am. (2010) 92:1115–21.',
	'26. Yokhana SS, Hamilton DA, Stine SA, Stimson LN. The prevalence of posterolateral tibial overhang. J Orthop. (2020) 23:1–6.',
	'27. Abdullah MR, Goharian A, Wahit MU. Biomechanical and bioactivity concepts of polyetheretherketone. Mater Res. (2015) 103:689.',
	'28. Kurtz SM. Chemical and Radiation Stability of PEEK. Amsterdam: Elsevier Inc. (2012) 60:75–9.',
	'29. Gibon E, Mouton A, Passeron D, Le Strat V. Doctor, what does my knee arthroplasty weigh? J Arthroplasty. (2014) 29:2091–4.',
	'30. Moore DJ, Freeman MA, Revell PA. Can a total knee replacement prosthesis be made entirely of polymers? J Arthroplasty. (1998) 13:388–95.'
];

test('numbered author–initials entries with years make a reference page', () => {
	assert.equal(looksLikeReferencePage(ENTRIES), true);
	assert.equal(looksLikeReferenceText(ENTRIES.join(' ')), true);
	assert.equal(startsReferenceEntry('[12] J. Smith, A. Brown, Imaging of …'), true);
	assert.equal(startsReferenceEntry('15. Rajendran K, Petersilka M, Henning A, et al. First clinical'), true);
});

test('a numbered methods list or prose is not a reference page', () => {
	const steps = [
		'1. Using the dual energy CT treatment monitoring can be done more precisely in 2016.',
		'2. Contrast enhancement can be quantified without prior native images.',
		'3. Patients benefit from a more accurate treatment monitoring.',
		'4. Remove the sample and record the weight.',
		'5. Repeat the measurement in 2019 and 2020.'
	];
	assert.equal(looksLikeReferencePage(steps), false);
	assert.equal(looksLikeReferenceText(steps.join(' ')), false);
});

test('"93. doi: …" continues the entry above instead of starting item 93', () => {
	assert.equal(isReferenceTailLine('93. doi: 10.1007/s11999-016-4989-7'), true);
	assert.equal(isReferenceTailLine('4. https://doi.org/10.1016/j.arth.2014.07.012'), true);
	assert.equal(isReferenceTailLine('29. Gibon E, Mouton A'), false);
	assert.equal(looksLikeListStart('93. doi: 10.1007/s11999-016-4989-7'), false);
	assert.equal(looksLikeListStart('29. Gibon E, Mouton A'), true);
});

const SIZE = 7.5;
function word(text: string, x: number, top: number): SpanItem {
	return { text, rect: [x, top - SIZE, x + text.length * SIZE * 0.5, top], fontSize: SIZE };
}
/** A justified line: words spread so every gap is the same, wider than 1.6em. */
function justified(words: string[], left: number, right: number, top: number): SpanItem[] {
	const widths = words.map(w => w.length * SIZE * 0.5);
	const gap = (right - left - widths.reduce((a, b) => a + b, 0)) / (words.length - 1);
	let x = left;
	return words.map((w, i) => { const it = word(w, x, top); x += widths[i]! + gap; return it; });
}

test('a reference continuation page (heading on an earlier, unextracted page) keeps entries apart and whole', () => {
	const items: SpanItem[] = [];
	let top = 700;
	for (const entry of ENTRIES) {
		// Each entry as three lines in the left column: label line, a heavily
		// justified middle line (gaps ~1.7em), a short last line.
		const words = entry.split(' ');
		const third = Math.ceil(words.length / 3);
		items.push(...justified(words.slice(0, third), 45, 290, top));
		items.push(...justified(words.slice(third, third * 2).length > 1 ? words.slice(third, third * 2) : ['x', 'y'], 59, 290, top - 9.5));
		let x = 59;
		for (const w of words.slice(third * 2)) { items.push(word(w, x, top - 19)); x += w.length * SIZE * 0.5 + 2; }
		top -= 30;
	}
	const { blocks } = buildBlocksFromSpans(items, { pageIndex: 9, pageWidth: 595, pageHeight: 842, includeReferences: true, referencesAlreadyStarted: false, imageRectsPdf: [] });
	const text = blocks.filter(b => b.translationMode !== 'preserve');
	assert.ok(text.every(b => b.isReference), 'content marks the page as references');
	for (const n of ['25.', '26.', '27.', '28.', '29.', '30.']) {
		const owner = text.filter(b => b.sourceText.includes(`${n} `));
		assert.equal(owner.length, 1, `entry ${n} is one block`);
	}
	// No entry is cut into word-gap "columns": every block starts with its label.
	assert.ok(text.every(b => /^\d{2}\. /.test(b.sourceText)), text.map(b => b.sourceText.slice(0, 20)).join(' | '));
});

import { referenceAuthorsChanged, referenceLeadSurnames, looksTranslated } from '../../src/translation/translationValidation';
import { buildSystemPrompt } from '../../src/translation/promptBuilder';

test('reference authors keep their source spelling; a transliterated byline is rejected', () => {
	const src = '36. Simsek ME, Akkaya M, Gursoy S, Isik C, Zahar A, Tarabichi S, et al. Posterolateral overhang affects patient quality of life after total knee arthroplasty. Arch Orthop Trauma Surg. (2018) 138:409–18. doi: 10.1007/s00402-017-2850-4';
	assert.deepEqual(referenceLeadSurnames(src), ['Simsek', 'Akkaya']);
	const transliterated = '36. 西姆谢克 ME，阿卡亚 M，古尔索伊 S，伊西克 C，扎哈尔 A，Tarabichi S 等。后外侧外悬影响全膝关节置换术后患者生活质量。《骨科档案》(2018) 138:409–18. doi: 10.1007/s00402-017-2850-4';
	const good = '36. Simsek ME, Akkaya M, Gursoy S, Isik C, Zahar A, Tarabichi S, et al. 后外侧悬出影响全膝关节置换术后患者的生活质量。Arch Orthop Trauma Surg. (2018) 138:409–18. doi: 10.1007/s00402-017-2850-4';
	assert.equal(referenceAuthorsChanged(src, transliterated), true);
	assert.equal(referenceAuthorsChanged(src, good), false);
	assert.equal(looksTranslated(src, transliterated, 'zh-CN', { isReference: true }), false);
	assert.equal(looksTranslated(src, good, 'zh-CN', { isReference: true }), true);
	// Initials-first style.
	assert.deepEqual(referenceLeadSurnames('[3] J.F. Geschwind, R. Salem, B.I. Carr, Yttrium-90 microspheres for the treatment of hepatocellular carcinoma, Gastroenterology 127 (2004) S194–S205.'), ['Geschwind', 'Salem']);
	// Not a reference entry: nothing to check.
	assert.deepEqual(referenceLeadSurnames('Smith and colleagues showed a benefit.'), []);
});

test('the reference prompt keeps authors and journals verbatim and overrides the naming rule', () => {
	const prompt = buildSystemPrompt({ blocks: [{ id: 'a', text: 'x' }], sourceLanguage: 'en', targetLanguage: 'zh-CN', referenceContent: true } as never);
	assert.match(prompt, /translate ONLY the article or book TITLE/);
	assert.match(prompt, /never transliterate or translate them/);
	assert.match(prompt, /overrides the general rule about names/);
});

test('table cells holding a domain or a bare journal locator may come back unchanged', () => {
	assert.equal(looksTranslated('uclouvain.be', 'uclouvain.be', 'zh-CN'), true);
	assert.equal(looksTranslated('Curr Opin Nephrol Hypertens. 2019;28:316-320. doi:10.', 'Curr Opin Nephrol Hypertens. 2019;28:316-320. doi:10.', 'zh-CN'), true);
	// Natural language still has to be translated.
	assert.equal(looksTranslated('No evidence of benefit', 'No evidence of benefit', 'zh-CN'), false);
	assert.equal(looksTranslated('Document Title', 'Document Title', 'zh-CN'), false);
});

test('a U+FFFD the source already had is not an invalid character in the translation', () => {
	const src = 'The tumour uptake was measured in � units of iodine concentration across all treated patients and lesions.';
	assert.equal(looksTranslated(src, '在所有接受治疗的患者和病灶中,以 � 单位测量肿瘤的碘浓度摄取。', 'zh-CN'), true);
	assert.equal(looksTranslated('Plain source sentence with several words in it for the test.', '这是一个�测试句子,包含若干词语用于测试。', 'zh-CN'), false);
});

test('5.0 校验 3332: an author cited by number in a table cell may stay as it is', () => {
	for (const cell of ['Cademartiri [44]', 'Rist [19]', 'Kim et al. [50]', 'Smith and Jones (2019)']) {
		assert.equal(looksTranslated(cell, cell, 'zh-CN'), true, cell);
	}
	assert.equal(looksTranslated('Contrast volume [ml]', 'Contrast volume [ml]', 'zh-CN'), false);
});

test('5.0 校验 2757 p10: a three-digit reference number starts a new entry', () => {
	assert.equal(looksLikeListStart('101. Strain WD, Chaturvedi N, Leggetter S, Nihoyannopoulos P,'), true);
	assert.equal(looksLikeListStart('120 patients were enrolled in the study.'), false);
});
