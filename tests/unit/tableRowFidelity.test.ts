import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structureTableCells } from '../../src/reader/tableStructure';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
import type { SourceBlock } from '../../src/types/models';

/**
 * 夹具 B:三列逐行记录(指南/政策清单表)。
 *
 * 真机表现(用户截图 2,Table 2 "Guidelines, Policies, and Statements Relevant
 * to the Management of AIS"):第一列多行文档标题在译文里连续堆到上方,年份与
 * 缩写列仍逐行留在原位,下面出现大量空白格。
 *
 * 复现出来的根因与"中文比较长"无关,是**行归属**在抽取期就错了:
 *
 *   `mergeContinuationRows` 判断"这一行是不是上一行的折行续行"时,要求续行
 *   以**小写字母或续行标点**开头(CONTINUATION_START)。这条判据对散文成立,
 *   对**文献标题**完全失效 —— 标题是 Title Case,"Cardiovascular Disease"、
 *   "Acute Ischemic Stroke"、"Aortic Disease" 条条大写开头。于是每一条多行
 *   标题的第二行都被判成**新的一行**,7 条记录变成 12 行,年份与缩写还留在
 *   各自原来的行上,标题与它们彻底错位。
 *
 * 只有行距足够松(记录间距 > 0.8em)时,列内分组才恰好把折行圈在一起、掩盖了
 * 这条判据的失效 —— 期刊表格恰恰是紧排的。
 *
 * 这里锁的是**记录完整性**:每条标题必须和它自己的年份、缩写同属一行。
 */

const FONT = 9;
const line = (id: string, left: number, top: number, width: number, text: string): SourceBlock => ({
	id, pageIndex: 0, order: 0, type: 'paragraph', sourceText: text, fontSize: FONT,
	boundingBox: { x: left, y: top, width, height: FONT }
});

/** 三列记录表:第一列多行 Title Case 标题,第二列年份,第三列缩写。 */
function guidelineTable(recordGap: number): { blocks: SourceBlock[]; records: [string[], string, string][] } {
	const records: [string[], string, string][] = [
		[['2019 ACC/AHA Guideline on the Primary Prevention of', 'Cardiovascular Disease'], '2019', 'N/A'],
		[['Guidelines for the Early Management of Patients With', 'Acute Ischemic Stroke'], '2018', 'AIS'],
		[['2020 Guideline for the Management of Patients With', 'Spontaneous Intracerebral Hemorrhage'], '2020', 'ICH'],
		[['Guidelines for the Prevention of Stroke in Patients With', 'Stroke and Transient Ischemic Attack'], '2021', 'TIA'],
		[['2022 Guideline for the Diagnosis and Management of', 'Aortic Disease'], '2022', 'N/A']
	];
	const caption = line('cap', 60, 80, 420, 'Table 2. Guidelines, Policies, and Statements Relevant to the Management of AIS');
	caption.type = 'table';
	const blocks: SourceBlock[] = [
		caption,
		line('h0', 60, 100, 80, 'Document Title'),
		line('h1', 330, 100, 70, 'Year Published'),
		line('h2', 430, 100, 120, 'Abbreviation Used')
	];
	let y = 118;
	records.forEach(([titleLines, year, abbr], r) => {
		const startY = y;
		titleLines.forEach((t, i) => {
			blocks.push(line(`t${r}-${i}`, 60, y, 255, t));
			y += 11;
		});
		blocks.push(line(`y${r}`, 330, startY, 24, year));
		blocks.push(line(`a${r}`, 430, startY, 30, abbr));
		y += recordGap;
	});
	blocks.forEach((b, i) => { b.order = i; });
	return { blocks, records };
}

interface Cell { id: string; row: number; col: number; text: string }

function cellsOf(blocks: SourceBlock[]): Cell[] {
	return structureTableCells(blocks, 0, FONT)
		.filter(b => /-table-\d+-r\d+-c\d+/.test(b.id))
		.map(b => {
			const m = /-r(\d+)-c(\d+)/.exec(b.id)!;
			return { id: b.id, row: Number(m[1]), col: Number(m[2]), text: b.sourceText };
		});
}

test('夹具B 紧排三列记录表:每条标题与它的年份、缩写同属一行 (2.12.3)', () => {
	// 记录间距 4px < 0.8em —— 期刊表格的常见紧排。
	const { blocks, records } = guidelineTable(4);
	const cells = cellsOf(blocks);
	assert.ok(cells.length > 0, '表格必须被识别出来');

	// 每条记录的年份所在行,必须同时有该记录的完整标题。
	for (const [titleLines, year] of records) {
		const yearCell = cells.find(c => c.text.trim() === year && c.col > 0);
		assert.ok(yearCell, `年份 ${year} 必须在某个格里`);
		const sameRow = cells.filter(c => c.row === yearCell!.row);
		const titleCell = sameRow.find(c => c.col === 0);
		assert.ok(titleCell, `年份 ${year} 所在行必须有第一列标题格(实际该行只有 ${sameRow.map(c => 'c' + c.col).join(',')})`);
		for (const part of titleLines) {
			assert.ok(titleCell!.text.includes(part),
				`标题的每一行都要留在同一格里;缺 "${part.slice(0, 28)}…"(该格实为 "${titleCell!.text.slice(0, 50)}…")`);
		}
	}
});

test('夹具B 行数等于记录数:折行不得各自成行 (2.12.3)', () => {
	const { blocks, records } = guidelineTable(4);
	const cells = cellsOf(blocks);
	const rowCount = new Set(cells.map(c => c.row)).size;
	// 表头 1 行 + 记录数。多出来的行只可能来自折行被当成新记录。
	assert.equal(rowCount, records.length + 1,
		`应为 ${records.length + 1} 行(表头+${records.length} 条记录),实得 ${rowCount} 行 —— 多出的行是折行被误判成新记录`);
});

test('夹具B 松排时同样正确(松紧两种行距结论必须一致, 2.12.3)', () => {
	// 松排本来就是对的;和紧排一起锁住,防止"修好紧排、弄坏松排"。
	const { blocks, records } = guidelineTable(12);
	const cells = cellsOf(blocks);
	const rowCount = new Set(cells.map(c => c.row)).size;
	assert.equal(rowCount, records.length + 1, `松排行数也必须是 ${records.length + 1}`);
});

test('真正缺列的新记录不会被当成折行并回上一行 (2.12.3 反向锁)', () => {
	// 这条防的是修复过头:一条**真实**记录即使缺了第三列,只要它自己带了年份
	// (与上一行同样的"记录证据"),就绝不能被并进上一行。
	const caption = line('cap', 60, 80, 420, 'Table 2. Guidelines, Policies, and Statements Relevant to the Management of AIS');
	caption.type = 'table';
	const blocks: SourceBlock[] = [
		caption,
		line('h0', 60, 100, 80, 'Document Title'),
		line('h1', 330, 100, 70, 'Year Published'),
		line('t0', 60, 118, 255, 'First Guideline on Something Important'),
		line('y0', 330, 118, 24, '2019'),
		// 紧跟着的第二条记录:自带年份,只是标题短。间距同样很小。
		line('t1', 60, 133, 255, 'Second Guideline on Another Topic'),
		line('y1', 330, 133, 24, '2020'),
		line('t2', 60, 148, 255, 'Third Guideline on Yet Another Topic'),
		line('y2', 330, 148, 24, '2021')
	];
	blocks.forEach((b, i) => { b.order = i; });
	const cells = cellsOf(blocks);
	const years = ['2019', '2020', '2021'];
	const rowsUsed = new Set<number>();
	for (const y of years) {
		const c = cells.find(x => x.text.trim() === y);
		assert.ok(c, `年份 ${y} 必须还在`);
		rowsUsed.add(c!.row);
	}
	assert.equal(rowsUsed.size, 3, '三条各自带年份的记录必须是三行,不能被并成一行');
});

test('表内小节子标题不得被并进上一行 (2.12.3 行距尺)', () => {
	// nejm-defuse3-p7 Table 2 的真实形状:数据行之间夹着只占第一列的**小节
	// 子标题**("Safety outcomes — no. (%)"、"Imaging outcomes**")。它和折行
	// 一样"只占第一列",列覆盖证据分不开 —— 分得开的是行距:实测折行与上一行
	// 的间隙 1.0,而每一条真行(含子标题)都是 5.8,两者却都远小于 em*0.8=8.0。
	// 所以续行必须贴着**表格自己最紧的那种间隙**,不是贴着一个绝对常数。
	const cap = line('cap', 60, 60, 400, 'Table 2. Clinical and Imaging Outcomes.');
	cap.type = 'table';
	const blocks: SourceBlock[] = [cap,
		line('h1', 300, 80, 90, 'Endovascular Therapy'),
		line('h2', 420, 80, 80, 'Medical Therapy'),
		// 一条带折行的长标签:折行间隙 1(紧贴)
		line('L1a', 60, 100, 220, 'Primary efficacy outcome: median score on modified'),
		line('L1b', 60, 110, 220, 'Rankin scale at 90 days (IQR)'),
		line('v1a', 300, 100, 50, '3 (1-4)'),
		line('v1b', 420, 100, 50, '4 (3-6)'),
		// 真行:间隙 6
		line('L2', 60, 125, 220, 'Death at 90 days'),
		line('v2a', 300, 125, 50, '13 (14)'),
		line('v2b', 420, 125, 50, '23 (26)'),
		// **小节子标题**:只占第一列,间隙同样是 6 —— 不是折行
		line('S1', 60, 140, 220, 'Imaging outcomes'),
		// 之后继续是真行
		line('L3', 60, 155, 220, 'Median infarct volume at 24 hr'),
		line('v3a', 300, 155, 50, '35 (18-82)'),
		line('v3b', 420, 155, 50, '41 (25-106)')
	];
	blocks.forEach((b, i) => { b.order = i; });
	const cells = cellsOf(blocks);
	const sub = cells.find(c => c.text.includes('Imaging outcomes'));
	assert.ok(sub, '子标题必须还在');
	assert.equal(sub!.text.replace(/\s+/g, ' ').trim(), 'Imaging outcomes',
		`子标题必须独占一格,不能被并进上一行(实为 "${sub!.text.slice(0, 60)}")`);
	// 而同一张表里的折行必须并回去 —— 同一把尺,两个方向都要对。
	const wrapped = cells.find(c => c.text.includes('Primary efficacy outcome'));
	assert.ok(wrapped, '长标签必须还在');
	assert.ok(wrapped!.text.includes('Rankin scale at 90 days'),
		`折行必须并回同一格(实为 "${wrapped!.text.slice(0, 70)}")`);
	assert.ok(!wrapped!.text.includes('Death at 90 days'), '并回去的只能是折行,不能把下一条真行也吞掉');
});

test('行首必须跨 ≥2 列:同一列里的并排碎片不算一行 (2.12.3)', () => {
	// 一个格子内部被切成同基线的几个碎片(词被分成多个 span)是常事。
	// 行首的硬几何是"**不同列**在同一顶边开始";若只数成员个数,一个格子内部
	// 的三个碎片就能伪造出一个行首,把上面那一格拦腰切开。
	const cap = line('cap', 60, 60, 400, 'Table 4. Fragmented Cell Case');
	cap.type = 'table';
	const blocks: SourceBlock[] = [cap,
		line('h0', 60, 80, 120, 'Characteristic'),
		line('h1', 300, 80, 60, 'Value'),
		line('r1L', 60, 100, 120, 'Body mass index'),
		line('r1V', 300, 100, 60, '24.1'),
		// 第二行的第一列被切成三个同基线碎片,全在同一列带内
		line('r2a', 60, 120, 38, 'Age'), line('r2b', 100, 120, 18, '(y)'), line('r2c', 120, 120, 10, '*'),
		line('r2V', 300, 120, 60, '58.3'),
		line('r3L', 60, 140, 120, 'Female sex'),
		line('r3V', 300, 140, 60, '41 (45)')
	];
	blocks.forEach((b, i) => { b.order = i; });
	const cells = cellsOf(blocks);
	const rows = new Set(cells.map(c => c.row)).size;
	assert.equal(rows, 4, `表头 + 3 条记录 = 4 行,实得 ${rows} 行`);
	const age = cells.find(c => c.text.includes('Age'));
	assert.ok(age, 'Age 行必须在');
	const sameRow = cells.filter(c => c.row === age!.row);
	assert.ok(sameRow.some(c => c.text.includes('58.3')), 'Age 与它的取值必须同一行');
});

/**
 * 夹具 A:五列独立列表(截图 1,Table 5 "Contraindication by Type of Imaging
 * Modality and Stress Protocol")。
 *
 * 这张表的正文区**没有横线**,五列各是一份独立条目清单,条目数与长度都不同。
 * 它和夹具 B 是相反方向的风险:B 怕该合的没合,A 怕**不该配行的被强行配行**。
 * 不同列里高度相近的条目之间不存在任何逻辑关系,把它们凑成一行就是凭空捏造
 * 记录。这里锁住:列归属不串、每列条目数不丢,以及"不同列的条目不因为顶边
 * 接近就被并进同一个格"。
 */
function modalityTable(): { blocks: SourceBlock[]; columns: string[][] } {
	const columns: string[][] = [
		['Unstable angina', 'Acute MI within 2 days', 'Uncontrolled arrhythmia'],
		['Severe pulmonary hypertension', 'Known allergy to tracer'],
		['Poor acoustic window', 'Severe obesity', 'Recent chest surgery', 'Unstable vital signs'],
		['Implanted pacemaker', 'Severe claustrophobia'],
		['Renal insufficiency', 'Iodinated contrast allergy', 'Irregular heart rhythm']
	];
	const headers = ['Exercise ECG', 'Stress Nuclear', 'Stress Echocardiography', 'Stress CMR', 'CCTA'];
	const cap = line('cap', 50, 60, 500, 'Table 5. Contraindication by Type of Imaging Modality and Stress Protocol');
	cap.type = 'table';
	const blocks: SourceBlock[] = [cap];
	headers.forEach((h, c) => blocks.push(line(`h${c}`, 50 + c * 100, 80, 92, h)));
	// 每列条目自上而下排,各列节奏不同(条目数不同、间距不同)——这正是关键:
	// 列与列之间没有共同的行。
	columns.forEach((items, c) => {
		let y = 100;
		items.forEach((t, i) => {
			blocks.push(line(`c${c}i${i}`, 50 + c * 100, y, 92, t));
			y += 22 + c * 3; // 各列节奏刻意不同
		});
	});
	blocks.forEach((b, i) => { b.order = i; });
	return { blocks, columns };
}


test('夹具A 五列独立清单:条目不丢、不跨列串格 (2.12.3)', () => {
	// 走**完整**路径(表格识别 + 散文合并),因为这张表今天走的正是散文那条。
	const { blocks, columns } = modalityTable();
	const structured = structureTableCells(blocks, 0, FONT);
	const prose = coalesceRegions(structured.filter(b => b.translationMode === undefined), []);
	const out = [...prose, ...structured.filter(b => b.translationMode !== undefined && /-c\d+$/.test(b.id))];
	const texts = out.map(b => b.sourceText.replace(/\s+/g, ' '));

	for (const [c, items] of columns.entries()) {
		for (const t of items) {
			assert.ok(texts.some(x => x.includes(t)), `第 ${c + 1} 列的条目 "${t}" 不能丢`);
		}
	}
	// 关键:任何一个块都不得同时含有**不同列**的条目。
	// 五列清单里不同列的条目之间没有任何逻辑关系,凑到一起就是凭空捏造记录。
	for (const t of texts) {
		const owners = new Set<number>();
		columns.forEach((items, c) => { if (items.some(x => t.includes(x))) { owners.add(c); } });
		assert.ok(owners.size <= 1,
			`一个块里混进了第 ${[...owners].map(n => n + 1).join('、')} 列的条目: "${t.slice(0, 70)}"`);
	}
	// 表头同样不得与正文条目并块。
	for (const t of texts) {
		const hasHeader = /Exercise ECG|Stress Nuclear|Stress CMR|CCTA/.test(t);
		const hasItem = columns.flat().some(x => t.includes(x));
		assert.ok(!(hasHeader && hasItem), `表头与正文条目并进了同一个块: "${t.slice(0, 70)}"`);
	}
});

test('夹具A 已知缺口:无横线、无数值的五列清单目前不被识别为表 (2.12.3 记录在案)', () => {
	// 这条不是"期望这样",是**如实记录当前能力边界**,免得下次有人以为修好了。
	//
	// textGridValid 要求"≥3 处跨列顶边对齐"才认一张文本表 —— 而五列各自独立的
	// 清单按定义就没有共同行(各列条目数与长度都不同)。于是这张表走散文路径:
	// 每个条目各自翻译、各自就地摆放。条目不会串格(上一条已锁),但**列内的
	// 条目顺序与层级、列容器本身、底部跨列说明都没有被建模**。
	//
	// 要真正支持它,需要的是横线/竖线这类**边框证据**(见模块顶部:本文件是
	// 纯文字几何,不读 PDF 绘图指令),或者一条"标题锚定 + 多列短条目纵向
	// 清单"的新识别路径。两者都不在本次范围内。
	const { blocks } = modalityTable();
	const cells = structureTableCells(blocks, 0, FONT).filter(b => b.translationMode !== undefined && /-c\d+$/.test(b.id));
	assert.equal(cells.length, 0,
		'若这条开始失败,说明已经能识别这类表了 —— 那是好事,请连同夹具A的断言一起更新');
});

// ---- 真机边框路径 ---------------------------------------------------------

test('Powers 2019 p4 真机页:按边框建格,标题/年份/缩写各归其行 (2.12.4)', async () => {
	const { readFileSync } = await import('node:fs');
	const { buildBlocksFromSpans } = await import('../../src/reader/spanBlockBuilder');
	const { orderBlocksForReading } = await import('../../src/reader/readingOrder');
	const { buildGridTableModel, cellPreserveEvidence } = await import('../../src/reader/tableStructure');
	const { borderGrid } = await import('../../src/reader/tableBorders');
	const d = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.spans.json', 'utf8'));
	const e = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.edges.json', 'utf8'));
	const grid = borderGrid(e.segments, { pageHeight: e.pageHeight })!;
	const r = buildBlocksFromSpans(d.items, { pageIndex: 0, pageHeight: d.pageHeight, pageWidth: d.pageWidth });
	const blocks = orderBlocksForReading(r.blocks).filter(b => b.boundingBox);
	const members = blocks.map(b => ({
		id: b.id, text: b.sourceText, fontSize: b.fontSize,
		box: { left: b.boundingBox!.x, top: b.boundingBox!.y, width: b.boundingBox!.width, height: b.boundingBox!.height }
	}));
	const model = buildGridTableModel(0, 0, grid, members, cellPreserveEvidence(blocks.map(b => b.sourceText), []))!;
	assert.ok(model, '这一页画着完整网格');
	assert.equal(model.colCount, 3);
	assert.equal(model.rowCount, 18, '1 表头 + 17 条记录');

	// 逐条核对(真值由 pdfplumber 按边框独立切表得到,抄进来作常量)。
	const expect: [number, string, string][] = [
		[1, '2009', 'N/A'], [2, '2011', 'N/A'], [3, '2013', '2013 AIS Guidelines'],
		[4, '2013', '2013 Stroke Systems of Care'], [5, '2014', 'N/A'], [6, '2014', '2014 Brain Swelling'],
		[7, '2014', '2014 Palliative Care'], [8, '2014', '2014 Secondary Prevention'], [9, '2014', 'N/A'],
		[10, '2015', '2015 CPR/ECC'], [11, '2015', '2015 Endovascular'], [12, '2015', '2015 IV Alteplase'],
		[13, '2016', '2016 Rehab Guidelines'], [14, '2017', 'N/A'], [15, '2017', 'N/A']
	];
	const at = (row: number, col: number): string =>
		(model.cells.find(c => c.row === row && c.col === col)?.text ?? '').replace(/\s+/g, ' ').trim();
	for (const [row, year, abbr] of expect) {
		assert.equal(at(row, 1), year, `第 ${row} 行的年份`);
		assert.equal(at(row, 2), abbr, `第 ${row} 行的缩写`);
		assert.ok(at(row, 0).length > 20, `第 ${row} 行必须有文献标题(实得 "${at(row, 0).slice(0, 30)}")`);
	}
	// 每个格的盒子由**格线**围出,不是文字外接框 —— 译文排在格子里。
	const c = model.cells.find(x => x.row === 1 && x.col === 0)!;
	assert.ok(Math.abs(c.box.left - grid.columns[0]!) < 0.01 && Math.abs(c.box.width - (grid.columns[1]! - grid.columns[0]!)) < 0.01,
		'格盒必须等于格线围出的那一格');
});

test('已知缺口:最后两行的年份在建块阶段就丢了,网格救不回来 (2.12.4 记录在案)', async () => {
	// 如实记录能力边界:"2018" 这两个 span 在 PDF 里确实存在(top=499/534,
	// 正落在第 16、17 行带内),但 buildBlocksFromSpans 没把它们产出成块 ——
	// 网格只能决定"已有的块归哪一格",救不回压根没进来的文字。
	// 要补,得用网格反过来约束建块(跨格的块必须拆开),那是下一步。
	const { readFileSync } = await import('node:fs');
	const d = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.spans.json', 'utf8'));
	const years = d.items.filter((it: { text: string }) => String(it.text).trim() === '2018');
	assert.equal(years.length, 2, '原始 span 里确实有两个 2018');
});

test('按网格建格:归属看文字框中心,不看左上角 (2.12.4)', async () => {
	const { buildGridTableModel } = await import('../../src/reader/tableStructure');
	const grid = { columns: [0, 100, 200], rows: [0, 50, 100], region: { left: 0, top: 0, width: 200, height: 100 } };
	// 这一块的左上角在第 1 列第 1 行,但它的**主体**在第 2 列第 2 行。
	// 贴着格线起笔的字很常见,按左上角判会让它整格跑到邻格去。
	const members = [{ id: 'a', box: { left: 98, top: 48, width: 60, height: 30 }, text: 'Body of the cell' }];
	const model = buildGridTableModel(0, 0, grid, members)!;
	assert.equal(model.cells.length, 1);
	assert.equal(model.cells[0]!.row, 1, '应按中心落在第 2 行');
	assert.equal(model.cells[0]!.col, 1, '应按中心落在第 2 列');
});

test('按网格建格:落在网格外的块不得被强行塞进表里 (2.12.4)', async () => {
	const { buildGridTableModel } = await import('../../src/reader/tableStructure');
	const grid = { columns: [0, 100, 200], rows: [0, 50, 100], region: { left: 0, top: 0, width: 200, height: 100 } };
	const members = [
		{ id: 'in', box: { left: 10, top: 10, width: 60, height: 20 }, text: 'Inside the grid' },
		// 表外的正文块:x 在网格右边很远。强行塞进来就等于把正文冻进表格。
		{ id: 'out', box: { left: 400, top: 10, width: 120, height: 20 }, text: 'Body prose outside' }
	];
	const model = buildGridTableModel(0, 0, grid, members)!;
	assert.equal(model.cells.length, 1, '只应产出网格内那一个格');
	assert.deepEqual(model.cells[0]!.memberIds, ['in']);
	assert.ok(!model.cells.some(c => c.text.includes('outside')), '表外的正文绝不能进格');
});

test('接线后的真机页:边框网格接管,Document Title 列回到表里 (2.12.5)', async () => {
	// 真机 2.12.4 导出确认过:这一页的表格模型只有 2 列(年份、缩写),
	// 整个 Document Title 列在表外,那些标题以普通块散落在 x=53。
	// 接上边框后,structureTableCells 必须给出 3 列、每条记录同行。
	const { readFileSync } = await import('node:fs');
	const { buildBlocksFromSpans } = await import('../../src/reader/spanBlockBuilder');
	const { orderBlocksForReading } = await import('../../src/reader/readingOrder');
	const { structureTableCells } = await import('../../src/reader/tableStructure');
	const { borderGrid } = await import('../../src/reader/tableBorders');
	const d = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.spans.json', 'utf8'));
	const e = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.edges.json', 'utf8'));
	const grid = borderGrid(e.segments, { pageHeight: e.pageHeight });
	const r = buildBlocksFromSpans(d.items, { pageIndex: 0, pageHeight: d.pageHeight, pageWidth: d.pageWidth });
	const blocks = orderBlocksForReading(r.blocks);

	// 不给网格 = 2.12.4 的行为:第一列整列不在表里。
	const without = structureTableCells(blocks, 0, 9).filter(b => b.translationMode !== undefined && /-c\d+$/.test(b.id));
	const colsWithout = new Set(without.map(b => /-c(\d+)$/.exec(b.id)?.[1]));
	assert.equal(colsWithout.size, 2, `不给网格时应仍是 2 列(实得 ${colsWithout.size})—— 这条锁住"问题确实存在"`);

	// 给网格 = 边框接管。
	const cells = structureTableCells(blocks, 0, 9, [], grid, true).filter(b => b.translationMode !== undefined && /-c\d+$/.test(b.id));
	const rows = new Map<number, Map<number, string>>();
	for (const b of cells) {
		const m = /-r(\d+)-c(\d+)/.exec(b.id);
		if (m) {
			const row = rows.get(Number(m[1])) ?? new Map<number, string>();
			row.set(Number(m[2]), b.sourceText.replace(/\s+/g, ' ').trim());
			rows.set(Number(m[1]), row);
		}
	}
	const colsWith = new Set(cells.map(b => /-c(\d+)$/.exec(b.id)?.[1]));
	assert.equal(colsWith.size, 3, `给网格后必须是 3 列(实得 ${colsWith.size})`);

	// 逐条核对(真值由 pdfplumber 按边框独立切表得到)。最后两行的年份在建块
	// 阶段就丢了(见下一条用例),所以这里核对前 15 条。
	const expect: [number, string, string][] = [
		[1, '2009', 'N/A'], [2, '2011', 'N/A'], [3, '2013', '2013 AIS Guidelines'],
		[4, '2013', '2013 Stroke Systems of Care'], [5, '2014', 'N/A'], [6, '2014', '2014 Brain Swelling'],
		[7, '2014', '2014 Palliative Care'], [8, '2014', '2014 Secondary Prevention'], [9, '2014', 'N/A'],
		[10, '2015', '2015 CPR/ECC'], [11, '2015', '2015 Endovascular'], [12, '2015', '2015 IV Alteplase'],
		[13, '2016', '2016 Rehab Guidelines'], [14, '2017', 'N/A'], [15, '2017', 'N/A']
	];
	for (const [row, year, abbr] of expect) {
		const r2 = rows.get(row);
		assert.ok(r2, `第 ${row} 行必须存在`);
		assert.equal(r2!.get(1), year, `第 ${row} 行的年份`);
		assert.equal(r2!.get(2), abbr, `第 ${row} 行的缩写`);
		assert.ok((r2!.get(0) ?? '').length > 20, `第 ${row} 行必须有文献标题(实得 "${(r2!.get(0) ?? '').slice(0, 30)}")`);
	}
});

test('没有边框的页面行为逐字节不变 (2.12.5 惰性保证)', async () => {
	// 这是整条路的安全性所在:绝大多数页面没有表格线,borderGrid 返回 null,
	// structureTableCells 走原路。传 null 与不传必须产出完全一样的结果。
	const { readFileSync } = await import('node:fs');
	const { buildBlocksFromSpans } = await import('../../src/reader/spanBlockBuilder');
	const { orderBlocksForReading } = await import('../../src/reader/readingOrder');
	const { structureTableCells } = await import('../../src/reader/tableStructure');
	for (const name of ['nejm-defuse3-p7', 'chen2023-p10', 'wu2026-p6']) {
		const d = JSON.parse(readFileSync(`tests/fixtures/layout/${name}.spans.json`, 'utf8'));
		const r = buildBlocksFromSpans(d.items, { pageIndex: 0, pageHeight: d.pageHeight, pageWidth: d.pageWidth });
		const blocks = orderBlocksForReading(r.blocks);
		const a = structureTableCells(blocks, 0, 10);
		const b = structureTableCells(blocks, 0, 10, [], null);
		assert.deepEqual(b.map(x => x.id), a.map(x => x.id), `${name}: 传 null 不得改变任何东西`);
		assert.deepEqual(b.map(x => x.sourceText), a.map(x => x.sourceText), `${name}: 文本也必须一致`);
	}
});

test('接线的四条约束:阈值、剩余块、格盒来源、data 保留原文 (2.12.5)', async () => {
	const { readFileSync } = await import('node:fs');
	const { buildBlocksFromSpans } = await import('../../src/reader/spanBlockBuilder');
	const { orderBlocksForReading } = await import('../../src/reader/readingOrder');
	const { structureTableCells } = await import('../../src/reader/tableStructure');
	const { borderGrid } = await import('../../src/reader/tableBorders');
	const d = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.spans.json', 'utf8'));
	const e = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.edges.json', 'utf8'));
	const grid = borderGrid(e.segments, { pageHeight: e.pageHeight })!;
	const r = buildBlocksFromSpans(d.items, { pageIndex: 0, pageHeight: d.pageHeight, pageWidth: d.pageWidth });
	const blocks = orderBlocksForReading(r.blocks);
	const out = structureTableCells(blocks, 0, 9, [], grid, true);
	const cells = out.filter(b => b.translationMode !== undefined && /-c\d+$/.test(b.id));

	// (a) 格盒必须来自**格线**,不是文字外接框 —— 译文排在格子里。
	const c = cells.find(b => /-r1-c0$/.test(b.id))!;
	assert.ok(c, 'r1c0 必须存在');
	assert.ok(Math.abs(c.boundingBox!.x - grid.columns[0]!) < 0.01,
		`格盒左沿应等于列线 ${grid.columns[0]!.toFixed(1)},实得 ${c.boundingBox!.x.toFixed(1)}`);
	assert.ok(Math.abs(c.boundingBox!.width - (grid.columns[1]! - grid.columns[0]!)) < 0.01, '格宽应等于列宽');

	// (b) 年份与 N/A 这类短格必须 preserve —— 不能拿去翻译。
	const year = cells.find(b => b.sourceText.trim() === '2009');
	assert.ok(year, '年份格必须存在');
	assert.equal(year!.translationMode, 'preserve', '纯数字年份必须保留原文');

	// (c) 网格之外的块仍要走文字几何 —— 这一页的表标题不在网格里,
	//     它必须仍以 table 类型的普通块留在输出里,没被吞掉也没被丢掉。
	const caption = out.find(b => b.sourceText.startsWith('Table 2.'));
	assert.ok(caption, '表标题必须仍在输出里');
	assert.equal(caption!.translationMode, undefined, '表标题不是格,应作普通块');

	// (d) 网格里块太少就不算表 —— 一条装饰线框住半句话不能变成表格。
	const sparse = blocks.filter(b => (b.boundingBox?.y ?? 0) < 100).slice(0, 3);
	const sparseOut = structureTableCells(sparse, 0, 9, [], grid, true);
	assert.ok(!sparseOut.some(b => /-r\d+-c\d+/.test(b.id)),
		'网格内只有寥寥几个块时不得建表');
});

test('接线不丢内容,且网格之外的表仍由文字几何接手 (2.12.5)', async () => {
	const { readFileSync } = await import('node:fs');
	const { buildBlocksFromSpans } = await import('../../src/reader/spanBlockBuilder');
	const { orderBlocksForReading } = await import('../../src/reader/readingOrder');
	const { structureTableCells } = await import('../../src/reader/tableStructure');
	const { borderGrid } = await import('../../src/reader/tableBorders');
	const d = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.spans.json', 'utf8'));
	const e = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.edges.json', 'utf8'));
	const grid = borderGrid(e.segments, { pageHeight: e.pageHeight })!;
	const r = buildBlocksFromSpans(d.items, { pageIndex: 0, pageHeight: d.pageHeight, pageWidth: d.pageWidth });
	const blocks = orderBlocksForReading(r.blocks);

	// 在网格**下方**放一张纯文字几何能认出的数值小表(网格只到 y≈566)。
	const extra: SourceBlock[] = [];
	for (let row = 0; row < 4; row++) {
		extra.push(line(`x-l${row}`, 60, 620 + row * 18, 150, row === 0 ? 'Mortality' : `Clinical outcome ${row}`));
		extra.push(line(`x-a${row}`, 240, 620 + row * 18, 60, `${40 + row} ± 6`));
		extra.push(line(`x-b${row}`, 320, 620 + row * 18, 60, `${41 + row} ± 7`));
	}
	const all = [...blocks, ...extra];
	all.forEach((b, i) => { b.order = i; });
	const out = structureTableCells(all, 0, 9, [], grid, true);

	// (a) 内容守恒:每一个输入块的文字都必须仍能在输出里找到。
	const joined = out.map(b => b.sourceText.replace(/\s+/g, ' ')).join(' ⟂ ');
	for (const b of all) {
		const t = b.sourceText.replace(/\s+/g, ' ').trim();
		if (t.length < 4) { continue; }
		assert.ok(joined.includes(t.slice(0, 40)), `输入块的文字不能丢: "${t.slice(0, 40)}"`);
	}

	// (b) 网格之外的那张表必须仍被文字几何结构化成格。
	const outsideCells = out.filter(b => b.translationMode !== undefined && (b.boundingBox?.y ?? 0) > 600);
	assert.ok(outsideCells.length >= 4,
		`网格外的表也要成格,实得 ${outsideCells.length} 个 —— 剩余块没有走文字几何那条路`);
	assert.ok(outsideCells.some(b => b.sourceText.includes('Mortality')), '网格外表的行标签必须在格里');
});

test('网格默认不参与建格 —— 必须显式打开 (2.12.6)', async () => {
	// 2.12.5 把网格接进了建格却没有任何遥测,真机上一页只剩 3 个格时拿不出
	// 证据说明运行时算的是什么网格。现在默认只观测:传了网格但不传 useGrid,
	// 输出必须与压根不传网格**逐字节相同**。
	const { readFileSync } = await import('node:fs');
	const { buildBlocksFromSpans } = await import('../../src/reader/spanBlockBuilder');
	const { orderBlocksForReading } = await import('../../src/reader/readingOrder');
	const { structureTableCells } = await import('../../src/reader/tableStructure');
	const { borderGrid } = await import('../../src/reader/tableBorders');
	const d = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.spans.json', 'utf8'));
	const e = JSON.parse(readFileSync('tests/fixtures/layout/powers2019-p4-p1.edges.json', 'utf8'));
	const grid = borderGrid(e.segments, { pageHeight: e.pageHeight })!;
	const r = buildBlocksFromSpans(d.items, { pageIndex: 0, pageHeight: d.pageHeight, pageWidth: d.pageWidth });
	const blocks = orderBlocksForReading(r.blocks);
	const off = structureTableCells(blocks, 0, 9, [], grid);
	const none = structureTableCells(blocks, 0, 9);
	assert.deepEqual(off.map(b => b.id), none.map(b => b.id), '默认不开时必须与不传网格完全一致');
	// 而显式打开时,它确实会接管(3 列)。
	const on = structureTableCells(blocks, 0, 9, [], grid, true).filter(b => b.translationMode !== undefined && /-c\d+$/.test(b.id));
	const cols = new Set(on.map(b => /-c(\d+)$/.exec(b.id)?.[1]));
	assert.equal(cols.size, 3, '显式打开时边框接管,给出 3 列');
});
