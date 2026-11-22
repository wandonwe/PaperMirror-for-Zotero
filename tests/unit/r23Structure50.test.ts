import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentStyle, type StylePage } from '../../src/reader/documentStyle';
import { structureSpanPage } from '../../src/reader/pagePipeline';
import { isRunningHeadOrFoot } from '../../src/reader/metaFilter';
import { looksLikeIndexPage, looksLikeReferencePage, startsReferenceEntry } from '../../src/reader/referenceDetect';
import { crossesLineGutter, entryNumberOf, groupIntoLines, groupIntoParagraphs, lineText, type SpanItem } from '../../src/reader/spanBlockBuilder';

// All fixtures are synthetic: shapes measured on the r23 papers, invented text.

test('5.0 r23: entry starts — undotted labels, particles, glued initials, initials first', () => {
	for (const t of [
		'1 van Dalen KJ, van der Berg J, Kapper LJ, et al: Diffusion',   // Karger, no period
		'20 Bogart J, Regal F, Maeder P, et al: The',
		'12 De Cock LJ, van Velde SJ, Fowler M,',
		'1. de CastroSM, BuschOR, van GulikTM, ObertopH. Incidence',      // initials glued by the PDF
		'3. SmitsFJ, van SantenHC, BessemerMG, et al. Management of',
		'4. NakaK,MoriY,IkenaN,etal.Managementof',
		'2. Reid-LombardKM, FarrellMB,',
		'[17] R. F. Ahlwede and G. Duke. Identification via channels.',  // initials first
		'[27] R. B. Ashe. Information Theory. Interscience, 1965.',
		'[28] J. Acz´el and Z. Dar´oczy. On Measures of Information.'
	]) assert.ok(startsReferenceEntry(t), t);
	for (const t of [
		'3 The CT Coronary Analysis workflow',   // a numbered running head
		'2 Patients were enrolled in 2019',
		'1. A. Method of choice',
		'2. The patients were',
		'115 consecutive patients. Stroke 1994'
	]) assert.ok(!startsReferenceEntry(t), t);
	assert.equal(entryNumberOf('20 Bogart J, Regal F, Maeder P, et al: The'), 20);
	assert.equal(entryNumberOf('3 The CT Coronary Analysis workflow'), null);
});

test('5.0 r23 (3007): a year glued to the journal still counts for a reference page', () => {
	const lines = [
		'1. de CastroSM, BuschOR, van GulikTM. Incidence of leakage. Br J Surg2005;92(9):1117–1123.',
		'2. Reid-LombardKM, FarrellMB, CrippaS, et al. Leakage after surgery. J Gastro Surg2007;11:1451–1458.',
		'3. SmitsFJ, van SantenHC, BessemerMG, et al. Severe fistula. JAMA Surg2017;152(6):540–548.',
		'4. NakaK,MoriY,IkenaN,etal.Managementof fistula. Surgery2021;169(4):708–720.',
		'5. TarvoT, SirenJ, KokkoA. Effect of hydrocortisone. JAMA Surg2020;155(4):291–298.'
	];
	assert.ok(looksLikeReferencePage(lines));
});

test('5.0 r23 (2845 p9): a column edge at 216.8 under a gutter voted at 217 still splits — a glyph run with no gap does not', () => {
	const gutter = { x: 217, top: 470 };
	assert.ok(crossesLineGutter(204.1, 216.8, gutter, 5, 8.25), 'rounded gutter, 12.7pt gap');
	assert.ok(!crossesLineGutter(216.5, 216.6, gutter, 5, 8.25), '"42" + "–85)" in one cell');
});

test('5.0 r23 (2845 p9): a three-column list under a two-column body keeps its columns', () => {
	const items: SpanItem[] = [];
	const cols: Array<[number, number]> = [[46.6, 55.3], [216.9, 229.6], [391.2, 403.9]];
	const entry = (n: number, k: number): string[] => [
		`${n} Author${n} AB, Other${n} CD, et al: A title that`,
		`runs onto a second line of entry ${n} here, and`,
		`ends. Stroke 19${10 + n};${n}:1–9.`
	];
	cols.forEach(([labelX, textX], c) => {
		for (let e = 0; e < 3; e++) {
			const n = c * 10 + e + 1;
			entry(n, e).forEach((text, k) => {
				const y = 465 - (e * 3 + k) * 9.5;
				items.push({ text, rect: [k === 0 ? labelX : textX, y, textX + 149, y + 8.25], fontSize: 8.25 });
			});
		}
	});
	const lines = groupIntoLines(items, 595, 794);
	assert.ok(lines.every(l => !/ 11 Author11| 21 Author21/.test(lineText(l))), 'no line runs from one column into the next');
	const starts = lines.map(lineText).filter(t => /^\d+ Author/.test(t));
	assert.equal(starts.length, 9);
});

test('5.0 r23 (3363 / 3007): the line under a labelled entry is its hanging indent, not a new paragraph', () => {
	const items: SpanItem[] = [
		{ text: 'Disclosures of conflicts of interest: none of the authors reports a relevant relationship.', rect: [315, 147, 558, 154.5], fontSize: 7.5 },
		{ text: 'References', rect: [315, 130, 360, 138], fontSize: 8 },
		{ text: '1. Fursen DM, LiMar GM, O’Dell MC, Hernan MA, Sensak', rect: [323, 120, 558, 127.5], fontSize: 7.5 },
		{ text: 'WF. Bariatric imaging: challenges and solutions. RadioGraphics 2016;36(4):1076–1086.', rect: [331, 111, 540, 118.5], fontSize: 7.5 },
		{ text: '2. Thom MA, Jacob MC, Jensen CT, Wagner NA, Ahmad M,', rect: [323, 102, 558, 109.5], fontSize: 7.5 },
		{ text: 'Layman RR. Quantifying the performance of enhanced radiation output,', rect: [331, 93, 558, 100.5], fontSize: 7.5 }
	];
	const paras = groupIntoParagraphs(groupIntoLines(items, 612, 792), 612, 792, [], null, { referencePage: true, paragraphIndent: 12, bodyFontSize: 10 })
		.map(p => p.map(lineText).join(' '));
	const entries = paras.filter(p => /^\d\./.test(p));
	assert.equal(entries.length, 2);
	assert.ok(/^1\..*RadioGraphics/.test(entries[0]!) && /^2\..*Layman RR/.test(entries[1]!), 'each entry keeps its continuation');
});

test('5.0 r23 (3363 p2): an entry at the column foot is content, not a running foot', () => {
	const rect: [number, number, number, number] = [323, 32, 558, 49];
	assert.ok(!isRunningHeadOrFoot(rect, 792, 2, '2. Thom MA, Jacob MC, Jensen CT, Wagner NA, Ahmad M, Layman RR. Quantifying the performance of enhanced radiation output,'));
	assert.ok(!isRunningHeadOrFoot(rect, 792, 1, '(reference reconstruction and six reconstructions). The investigator measured noise, SNR,'));
	assert.ok(isRunningHeadOrFoot([300, 30, 540, 38], 792, 1, 'Radiology: Volume 321: Number 1—October 2026'), 'a real foot stays furniture');
});

/** A book bibliography page: "BIBLIOGRAPHY" running head, initials-first entries. */
function bibliographyPage(i: number, first: number): StylePage {
	const items: SpanItem[] = [{ text: 'BIBLIOGRAPHY', rect: [200, 640, 290, 650], fontSize: 9 }];
	for (let k = 0; k < 10; k++) {
		const n = first + k;
		const y = 600 - k * 40;
		const name = 'Writer' + String.fromCharCode(97 + (n % 26)) + String.fromCharCode(97 + ((n * 7) % 26));
		items.push({ text: `[${n}] R. F. ${name} and G. Other. A study of channels number ${n}. IEEE Trans. Inf. Theory,`, rect: [60, y, 400, y + 10], fontSize: 10 });
		items.push({ text: `pages ${n}–${n + 9}, Sept. 19${50 + (n % 49)}.`, rect: [80, y - 12, 220, y - 2], fontSize: 10 });
	}
	return { items, pageWidth: 432, pageHeight: 648 };
}
function proseBookPage(): StylePage {
	const items: SpanItem[] = [];
	for (let k = 0; k < 30; k++) items.push({ text: `This is body prose line ${k} of a chapter about information and its measures.`, rect: [60, 600 - k * 14, 400, 610 - k * 14], fontSize: 11 });
	return { items, pageWidth: 432, pageHeight: 648 };
}

test('5.0 r23 (3200): a bibliography whose running head repeats "BIBLIOGRAPHY" is one range, every page a list', () => {
	const pages = [...Array.from({ length: 6 }, proseBookPage), ...[0, 1, 2, 3].map(i => bibliographyPage(i, 1 + i * 10))];
	const style = buildDocumentStyle(pages);
	assert.deepEqual(style.referenceRanges, [[6, 9]]);
	const blocks = structureSpanPage(pages[8]!, {
		pageIndex: 8, includeReferences: true, referencesAlreadyStarted: true, referencesStartHere: false, bodyFontSize: style.bodyFontSize
	}).blocks;
	const entries = blocks.filter(b => /^\[\d+\]/.test(b.sourceText));
	assert.equal(entries.length, 10);
	assert.ok(entries.every(b => b.isReference && /19\d\d\.$/.test(b.sourceText)), 'each entry keeps its tail line');
});

/** A two-column book index page. */
function indexPage(): SpanItem[] {
	const left = ['trace, 279, 547', 'transition matrix, 77, 92, 98, 144, 190', 'doubly stochastic, 83, 88, 190',
		'transmitter, 266, 294, 296, 299, 515,', '517–519, 546, 573, 574, 588, 601,', '611', 'Treasury bonds, 614', 'tree,', 'code, 107',
		'Huffman, 124', 'random, 89', 'triangle inequality, 20, 369', 'Trofimo, V.K., 706', 'Trotter, M., xxiii', 'Tsang, C.W., xxiii', 'turbo codes, 3, 205, 215'];
	const right = ['Ullmann, J.D., 704', 'uncertainty, 5, 6, 11, 13, 15, 20, 22, 24, 31,', '53, 83, 89, 170, 517, 518, 593', 'uniform distribution, 5, 30, 43',
		'Unix, 443', 'Urbank, R., 702, 712', 'V.90, 273', 'Vajd, I., 716', 'Valian, L.G., 717', 'variance, xx, 36, 37, 64', 'Venn diagram, 23, 47, 50, 213',
		'video, 218', 'vitamins, xx', 'vocabulary, 561', 'volume, 67, 149, 244–247', 'Voronoi partition, 303'];
	const items: SpanItem[] = [{ text: 'INDEX', rect: [332, 614, 356, 622], fontSize: 8 }];
	const indent = (t: string): number => /^\d/.test(t) ? 18 : /^(code|Huffman|random|doubly)/.test(t) ? 9 : 0;
	left.forEach((t, k) => items.push({ text: t, rect: [54 + indent(t), 590 - k * 11, 54 + indent(t) + t.length * 4, 598 - k * 11], fontSize: 8 }));
	right.forEach((t, k) => items.push({ text: t, rect: [227 + indent(t), 590 - k * 11, 227 + indent(t) + t.length * 4, 598 - k * 11], fontSize: 8 }));
	return items;
}

test('5.0 r23 (3200): a book index is a list of entries, not a table', () => {
	const items = indexPage();
	const lines = groupIntoLines(items, 432, 648);
	assert.ok(looksLikeIndexPage(lines.map(lineText)));
	assert.ok(!looksLikeIndexPage(['This is ordinary prose.', 'Another sentence of the body, 12']));
	const blocks = structureSpanPage({ items, pageWidth: 432, pageHeight: 648 }, { pageIndex: 772, includeReferences: true, referencesAlreadyStarted: false, bodyFontSize: 8 }).blocks;
	assert.ok(!blocks.some(b => b.tableId), 'no table cells');
	assert.ok(blocks.some(b => b.sourceText === 'transmitter, 266, 294, 296, 299, 515, 517–519, 546, 573, 574, 588, 601, 611'), 'a wrapped locator line stays with its entry');
	assert.ok(blocks.some(b => b.sourceText === 'Treasury bonds, 614'), 'the next entry is its own block');
	assert.ok(!blocks.some(b => /Trofimo.*Trotter/.test(b.sourceText)), 'entries are not welded together');
});

test('5.0 r23 (3276 p7): an abbreviation list keeps each term with its expansion, one row per block', () => {
	const rows: Array<[string, string]> = [['CI', 'Confidence interval'], ['CT', 'Computed tomography'], ['CTA', 'CT angiography'],
		['IPH', 'Intraplaque haemorrhage'], ['PCCT', 'Photon counting CT'], ['ROI', 'Region of interest']];
	const items: SpanItem[] = [{ text: 'Abbreviations', rect: [304.7, 160.2, 350.4, 167.7], fontSize: 7.5 }];
	rows.forEach(([term, expansion], k) => {
		const y = 151.2 - k * 9;
		items.push({ text: term, rect: [304.7, y, 304.7 + term.length * 4, y + 7.5], fontSize: 7.5 });
		items.push({ text: expansion, rect: [331.2, y, 331.2 + expansion.length * 3.6, y + 7.5], fontSize: 7.5 });
		// a body line of the other column on the same baseline
		items.push({ text: `left column body text on row ${k} continues here as ordinary prose`, rect: [56.7, y, 290.5, y + 7.5], fontSize: 9.8 });
	});
	const blocks = structureSpanPage({ items, pageWidth: 595, pageHeight: 794 }, { pageIndex: 6, includeReferences: true, referencesAlreadyStarted: false, bodyFontSize: 9.8 }).blocks;
	for (const [term, expansion] of rows) assert.ok(blocks.some(b => b.sourceText === `${term} ${expansion}`), `${term} row`);
});

test('5.0 r23: a table row label beside numbers is not an abbreviation row', () => {
	const items: SpanItem[] = [];
	[['CP', '1.09 (0.9-1.3)', '0.21'], ['NCP', '1.3 (1.1-1.4)', '0.03'], ['LAP', '3.75 (1.43-9.79)', '0.01'], ['PR', '5.25 (2.17-12.69)', '0.002']].forEach(([a, b, c], k) => {
		const y = 500 - k * 12;
		items.push({ text: a!, rect: [100, y, 115, y + 8], fontSize: 8 });
		items.push({ text: b!, rect: [140, y, 200, y + 8], fontSize: 8 });
		items.push({ text: c!, rect: [230, y, 250, y + 8], fontSize: 8 });
	});
	const texts = groupIntoLines(items, 612, 792).map(lineText);
	assert.ok(!texts.some(t => /^CP 1\.09/.test(t)));
});
