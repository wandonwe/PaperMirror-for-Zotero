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
	const out = [...prose, ...structured.filter(b => b.translationMode !== undefined)];
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
	const cells = structureTableCells(blocks, 0, FONT).filter(b => b.translationMode !== undefined);
	assert.equal(cells.length, 0,
		'若这条开始失败,说明已经能识别这类表了 —— 那是好事,请连同夹具A的断言一起更新');
});
