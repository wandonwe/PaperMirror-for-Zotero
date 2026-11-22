import test from 'node:test';
import assert from 'node:assert/strict';
import type { SourceBlock } from '../../src/types/models';
import { buildContinuityContexts } from '../../src/translation/sourceContinuity';
import { buildDocumentStyle, isFurnitureLine, type StylePage } from '../../src/reader/documentStyle';
import { structureSpanPage } from '../../src/reader/pagePipeline';
import { extractPanelTitles } from '../../src/reader/panelTitles';
import { TranslationManager, type TranslationDeps } from '../../src/translation/translationManager';
import type { TranslationRequest, TranslationResponse } from '../../src/types/models';
import { looksTranslated } from '../../src/translation/translationValidation';
import { entryNumberOf, groupIntoLines, groupIntoParagraphs, lineText, type SpanItem } from '../../src/reader/spanBlockBuilder';

const SIZE = 8;
function linesOf(texts: string[], widths: number[] = []): SpanItem[] {
	return texts.map((text, i) => ({ text, rect: [72, 700 - i * 10, 72 + (widths[i] ?? 230), 700 - i * 10 + SIZE] as [number, number, number, number], fontSize: SIZE }));
}
const paragraphsOf = (texts: string[], widths: number[] = [], referencePage = true): string[] =>
	groupIntoParagraphs(groupIntoLines(linesOf(texts, widths), 612, 792), 612, 792, [], null, { referencePage })
		.map(p => p.map(lineText).join(' '));

test('5.0 r22: entryNumberOf reads list labels, not tails or years', () => {
	assert.equal(entryNumberOf('521. Carotid Stenting Guidelines Committee: an Intercollegiate'), 521);
	assert.equal(entryNumberOf('[12] Smith J, Brown K.'), 12);
	assert.equal(entryNumberOf('93. doi: 10.1007/s00330-020-1'), null, 'tail line');
	assert.equal(entryNumberOf('2011;54:832–836. doi: 10.1016/j.jvs'), null);
	assert.equal(entryNumberOf('2019. Radiology 291:1'), null, 'a year is not a label');
});

test('5.0 r22 (2852 p74): the next number starts the next entry whatever follows it', () => {
	// Synthetic, in the shape of an AHA reference column: every line fills the
	// column, and none of the new entries starts "Surname AB,".
	const paras = paragraphsOf([
		'520. Ricotta JJ, Aburahma A, Ascher E. Updated guidelines for the management of',
		'extracranial carotid disease. J Vasc Surg. 2011;54:832–836. doi: 10.1016/j.jvs.2011.07.004',
		'521. Carotid Stenting Guidelines Committee: an Intercollegiate Committee. Guidelines for',
		'patient selection and performance of carotid artery stenting. Intern Med J. 2011;41:344–347.',
		'522. MasdeuJC,IrimiaP,AsenbaumS,BogousslavskyJ. Guidelines on the use of imaging in',
		'neurology. Eur J Neurol. 2006;13:1271–1283. doi: 10.1111/j.1468-1331.2006.01507.x',
		'523. Deleted in proof.',
		'524. de Bruijn SF, Agema WR, Lammers GJ. Transesophageal echocardiography is superior to',
		'transthoracic echocardiography. Stroke. 2006;37:2531–2534.'
	], [230, 230, 230, 230, 230, 230, 80, 230, 150]);
	assert.deepEqual(paras.map(p => p.slice(0, 4)), ['520.', '521.', '522.', '523.', '524.']);
});

test('5.0 r22 (2852 p74): a mis-set label does not derail the sequence', () => {
	const paras = paragraphsOf([
		'535. Gaudron M, Bonnaud I, Ros A. Diagnostic and therapeutic value of echocardiography during',
		'the acute phase of ischemic stroke. J Stroke Cerebrovasc Dis. 2014;23:2105–2109.',
		'532. Kim SJ, Choe YH, Park SJ. Routine cardiac evaluation in patients with ischaemic stroke.',
		'Eur J Neurol. 2012;19:317–323. doi: 10.1111/j.1468-1331.2011.03505.x',
		'533. Deleted in proof.'
	], [230, 230, 230, 230, 80]);
	assert.equal(paras.length, 3);
	assert.ok(paras[2]!.startsWith('533. Deleted'));
});

/** A label column: "13." at x 307, entry text at x 325, continuation lines under the text. */
function labelColumn(): SpanItem[] {
	const rows: Array<[string | null, string, number]> = [
		['13.', 'Schumacher HR Jr, Becker MA, Palo WA, et al. Tophaceous gout: quantitative', 230],
		[null, 'evaluation by direct physical measurement. J Rheumatol 2005;32:2368–72.', 200],
		['14.', 'Report of the United Nations Scientific Committee on the Effects of Atomic', 230],
		[null, 'Radiation to the General Assembly, 2000. (accessed 4 August 2008).', 190],
		['15.', 'Dalbeth N, Schauer C, Macdonald P, et al. Methods of tophus assessment in', 230],
		[null, 'clinical trials of chronic gout. Ann Rheum Dis 2011;70:597–604.', 180]
	];
	const out: SpanItem[] = [];
	rows.forEach(([label, text, w], i) => {
		const y = 730 - i * 9;
		if (label) out.push({ text: label, rect: [307, y, 316, y + 7.5], fontSize: 7.5 });
		out.push({ text, rect: [325, y, 325 + w, y + 7.5], fontSize: 7.5 });
	});
	return out;
}

test('5.0 r22 (3036 p5): a hanging label column rejoins its entries on a reference list', () => {
	const lines = groupIntoLines(labelColumn(), 612, 792, true);
	const paras = groupIntoParagraphs(lines, 612, 792, [], null, { referencePage: true }).map(p => p.map(lineText).join(' '));
	assert.equal(paras.length, 3, paras.join('\n'));
	assert.ok(paras[0]!.startsWith('13. Schumacher'));
	assert.ok(paras[1]!.startsWith('14. Report of the United Nations'), 'organisation entry keeps its own number');
	assert.ok(paras[2]!.startsWith('15. Dalbeth'));
});

test('5.0 r22 (3322 p12): a word set sideways on the edge tab does not bridge two rows', () => {
	const items: SpanItem[] = [
		{ text: 'ARTICLE', rect: [19.6, 658.1, 30.6, 687.4], fontSize: 11 },
		{ text: '2022;146:687–698. doi: 10.1161/CIRCULATIONAHA.121.057793', rect: [65.5, 680.3, 266.9, 687.3], fontSize: 7 },
		{ text: '16.', rect: [51.2, 671.3, 60.5, 678.3], fontSize: 7 },
		{ text: 'Harper C, Mafham M, Herrington W, Staplin N, Stevens W.', rect: [65.5, 671.3, 283.5, 678.3], fontSize: 7 }
	];
	const texts = groupIntoLines(items, 612, 792, true).map(lineText);
	assert.ok(texts.some(t => t.startsWith('16. Harper C')), texts.join(' | '));
	assert.ok(!texts.some(t => t.includes('ARTICLE')));
});

// ---- reference entries wrap across columns (2852 p74 entry 530) ----

function ref(id: string, sourceText: string, column: number, y: number, isReference = true): SourceBlock {
	const x = column === 1 ? 315 : 50;
	const box = { x, y, width: 250, height: 18 };
	return { id, sourceText, pageIndex: 74, column, order: 0, type: 'paragraph', fontSize: 8, isReference,
		boundingBox: box, lineRectsPdf: [[x, 800 - y - 9, x + 250, 800 - y], [x, 800 - y - 18, x + 250, 800 - y - 9]] };
}

test('5.0 r22 (2852 p74): an entry wrapping into the next column keeps its tail as context', () => {
	const head = ref('530', '530. Katsanos AH, Giannopoulos S, Frogoudaki A, et al. The diagnostic yield of transesophageal echocardiography in patients', 0, 740);
	const tail = ref('tail', 'with cryptogenic cerebral ischaemia: a meta-analysis. Eur J Neurol. 2016;23:569–579. doi: 10.1111/ene.12897', 1, 60);
	const next = ref('531', '531. Gaudron M, Bonnaud I, Ros A. Diagnostic and therapeutic value of echocardiography. J Stroke Cerebrovasc Dis. 2014;23:2105–2109.', 1, 80);
	const ctx = buildContinuityContexts([head, tail, next]);
	assert.equal(ctx.get('tail')?.before, '530. Katsanos AH, Giannopoulos S, Frogoudaki A, et al. The diagnostic yield of transesophageal echocardiography in patients'.replace(/^.*\. /, ''));
	assert.ok(ctx.get('530')?.after.startsWith('with cryptogenic cerebral ischaemia'));
	assert.equal(ctx.get('531'), undefined, 'the next numbered entry is not a continuation of the DOI before it');
});

test('5.0 r22: an entry never links to body text, nor body to an entry', () => {
	const bodyTail = ref('body', 'Detailed protocols are listed in the supplementary material of', 0, 740, false);
	const entry = ref('e', 'with cryptogenic cerebral ischaemia: a meta-analysis. Eur J Neurol. 2016;23:569–579.', 1, 60);
	assert.equal(buildContinuityContexts([bodyTail, entry]).size, 0);
});

// ---- page furniture repeated across the document (3036 foot, 2852 "e345", 3165 nav) ----

const FOOT = 'Choi HK, Burns LC, Shojania K, et al. Ann Rheum Dis (2012). doi:10.1136/annrheumdis-2011-200976';
function bodyPage(pageIndex: number, opts: { navShift?: number } = {}): StylePage {
	const items: SpanItem[] = [];
	const line = (text: string, x: number, y: number, w: number, size = 9): void => { items.push({ text, rect: [x, y, x + w, y + size], fontSize: size }); };
	line(`e${345 + pageIndex}`, 520, 740, 19, 8);
	// body: full-width lines of a single column, ending mid-sentence at the foot
	const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
	for (let i = 0; i < 20; i++) line(`Body sentence ${words[(i + pageIndex) % 12]} ${words[(i * 7 + pageIndex * 3) % 12]} continues across the whole measure of the column here`, 58, 700 - i * 11, 440);
	line('of agreement analysis (Bland and Altman). We compared the', 58, 480, 440);
	// even pages put the foot on the left, odd pages on the right
	line(FOOT, pageIndex % 2 ? 266 : 41, 13, 288, 7.5);
	// sidebar nav at x 771, "References" shifted down on some pages
	['Chapter Outline', 'Anatomy', 'Anatomical Variants', 'Diagnostic Imaging'].forEach((t, i) => line(t, 771, 418 - i * 31, 80, 10));
	line('References', 771, 168 - (opts.navShift ?? 0), 60, 10);
	return { items, pageWidth: 900, pageHeight: 792 };
}

test('5.0 r22: lines repeated at one spot across the document are page furniture', () => {
	const pages = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => bodyPage(i, { navShift: i >= 4 && i <= 8 ? 31 : 0 }));
	const style = buildDocumentStyle(pages);
	const keys = style.furniture.map(f => f.key);
	assert.ok(keys.includes('e#'), 'page number with a prefix');
	assert.ok(keys.includes('chapter outline') && keys.includes('anatomy'), 'sidebar nav');
	assert.ok(keys.some(k => k.startsWith('choi hk, burns lc')), 'a running foot that alternates sides');
	assert.ok(!keys.some(k => k.startsWith('body sentence')), 'body text varies from page to page');
	assert.ok(isFurnitureLine(style.furniture, 'References', [771, 137, 831, 147]), 'a nav item shifted down by an expanded chapter');
	assert.ok(!isFurnitureLine(style.furniture, 'References', [58, 300, 120, 310]), 'a real References heading in the body is not furniture');
});

test('5.0 r22: furniture never joins the body — foot, page number, sidebar heading', () => {
	const pages = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => bodyPage(i, { navShift: i >= 4 && i <= 8 ? 31 : 0 }));
	const style = buildDocumentStyle(pages);
	const blocks = structureSpanPage(pages[4]!, {
		pageIndex: 4, includeReferences: true, referencesAlreadyStarted: false, bodyFontSize: style.bodyFontSize,
		knownGutters: style.columnGutters, paragraphIndent: style.paragraphIndent, furniture: style.furniture
	}).blocks;
	assert.ok(!blocks.some(b => /We compared the.*Choi HK/.test(b.sourceText)), 'the foot is not glued to the last sentence');
	assert.ok(!blocks.some(b => /^e349\s+\S/.test(b.sourceText)), 'the page number is not absorbed into a paragraph');
	assert.ok(!blocks.some(b => b.isReference), 'the nav item "References" does not start a reference list');
});

// ---- inline caption label (3036 Figure 1–3) ----

test('5.0 r22 (3036): an inline caption whose lines return under "Figure 1" is not a panel title', () => {
	const it = (text: string, x0: number, y: number, x1: number): SpanItem => ({ text, rect: [x0, y, x1, y + 9], fontSize: 9 });
	const inline = [
		it('Figure 1', 42.4, 528.1, 71.7),
		it('Three material decomposition display algorithm of DECT', 80.7, 528.1, 271.2),
		it('scans for gout. This algorithm separates the chemical composition of', 42.4, 518.1, 277.3),
		it('compounds based on their differential attenuation of the 80 kV and', 42.4, 508.1, 268.8)
	];
	assert.equal(extractPanelTitles(inline, 1, 792).blocks.length, 0);
	// A real badge + indented title keeps its own region.
	const badge = [
		it('Figure 1', 42.4, 528.1, 71.7),
		it('Three material decomposition display algorithm of DECT', 80.7, 528.1, 271.2),
		it('scans for gout in the peripheral joints of the patient', 80.7, 518.1, 271.2)
	];
	assert.equal(extractPanelTitles(badge, 1, 792).blocks.length, 2);
});

// ---- compress keeps the reference rule (3036 p5 on 4.99.22) ----

test('5.0 r22 (3036 p5): a compressed reference keeps authors and journal, and asks with the reference rule', async () => {
	const REF = '5. Choi MH, MacKenzie JD, Dalinka MK. Imaging features of crystal-induced arthropathy. Rheum Dis Clin North Am 2006;32:427–46.';
	const FULL = '5. Choi MH, MacKenzie JD, Dalinka MK. 晶体诱导性关节病的影像学特征。Rheum Dis Clin North Am 2006;32:427–46.';
	const block: SourceBlock = { id: 'r5', pageIndex: 5, order: 0, type: 'paragraph', sourceText: REF, isReference: true };
	const requests: TranslationRequest[] = [];
	let shorter = '5. 晶体性关节病影像学';
	const deps: TranslationDeps = {
		extractPage: async () => [block],
		translateRequest: async (r: TranslationRequest): Promise<TranslationResponse> => {
			requests.push(r);
			return { translations: r.blocks.map(b => ({ id: b.id, translatedText: requests.length === 1 ? FULL : shorter })) };
		},
		readCache: async () => null, writeCache: async () => {},
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }), getDocumentTitle: () => 't', getGlossary: () => [],
		useContext: () => true, pageCount: () => 6
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	try {
		await manager.ensurePage(5, 6);
		assert.equal(manager.getPageState(5)?.translations.get('r5'), FULL);
		assert.equal((await manager.compressBlocks(5, [{ id: 'r5', maxChars: 40 }])).size, 0, 'title-only shortening is refused');
		assert.equal(requests.at(-1)?.referenceContent, true, 'the compress request carries the reference rule');
		assert.equal(manager.getPageState(5)?.translations.get('r5'), FULL);
		shorter = '5. Choi MH, MacKenzie JD, Dalinka MK. 晶体诱导关节病影像特征。Rheum Dis Clin North Am 2006;32:427–46.';
		assert.equal((await manager.compressBlocks(5, [{ id: 'r5', maxChars: 90 }])).get('r5'), shorter, 'a shorter title with the entry intact is fine');
	} finally { manager.dispose(); }
});

// ---- reference acceptance judged on the part that was not copied (2852 p74) ----

test('5.0 r22 (2852 p74): a long author list does not sink a translated title', () => {
	const head = '530. Katsanos AH, Giannopoulos S, Frogoudaki A, Vrettou AR, Ikonomidis I, Paraskevaidis I, Zompola C, Vadikolias K, Boviatsis E, Parissis J, et al. The diagnostic yield of transesophageal echocardiography in patients';
	const authors = '530. Katsanos AH, Giannopoulos S, Frogoudaki A, Vrettou AR, Ikonomidis I, Paraskevaidis I, Zompola C, Vadikolias K, Boviatsis E, Parissis J, et al. ';
	assert.equal(looksTranslated(head, authors + '经食管超声心动图在患者中的诊断价值', 'zh-CN', { isReference: true }), true);
	assert.equal(looksTranslated(head, authors + '经食管 echocardiography in patients 的诊断价值', 'zh-CN', { isReference: true }), false, 'half the title left in English');
	assert.equal(looksTranslated(head, '530. 经食管超声心动图在患者中的诊断价值', 'zh-CN', { isReference: true }), false, 'authors dropped');
	const glued = '525. MasdeuJC,IrimiaP,AsenbaumS,BogousslavskyJ,BraininM,ChabriatH, Herholz K, Markus HS, Martínez-Vila E, Niederkorn K, et al; EFNS. EFNS guidelineonneuroimaginginacutestroke:reportofanEFNStaskforce.Eur J Neurol. 2006;13:1271–1283. doi: 10.1111/j.1468-1331.2006.01507.x';
	const spaced = '525. Masdeu JC, Irimia P, Asenbaum S, Bogousslavsky J, Brainin M, Chabriat H, Herholz K, Markus HS, Martínez-Vila E, Niederkorn K, et al; EFNS. EFNS急性卒中神经影像指南：EFNS工作组报告。Eur J Neurol. 2006;13:1271–1283. doi: 10.1111/j.1468-1331.2006.01507.x';
	assert.equal(looksTranslated(glued, spaced, 'zh-CN', { isReference: true }), true, 'glued initials may come back spaced');
});

test('5.0 r22 (3036 p2): a translation opening with a stand-in "（无）" is not accepted, even from cache', () => {
	const source = 'each index tophus using a computer automated procedure for inter-rater reproducibility. The same scans were scored twice for intra-rater reproducibility.';
	assert.equal(looksTranslated(source, '（无） 同一扫描重复评分两次以评估评定者内重复性。', 'zh-CN'), false);
	assert.equal(looksTranslated(source, '每个指标痛风石，以评估评定者间重复性。同一扫描重复评分两次以评估评定者内重复性。', 'zh-CN'), true);
	assert.equal(looksTranslated('(None) of the patients withdrew.', '（无）患者退出。', 'zh-CN'), true, 'the source itself opens that way');
});
