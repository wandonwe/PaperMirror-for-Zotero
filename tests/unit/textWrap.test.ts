import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutBlock, tokenize, wrapAt, applyKinsoku, type Measure } from '../../src/pdfgen/textWrap';

/** Fake metrics: CJK glyph = 1em, Latin/digit = 0.5em, space = 0.3em. */
const measure: Measure = (text, size) => {
	let width = 0;
	for (const ch of text) {
		if (/[一-鿿，。；：（）]/u.test(ch)) {
			width += size;
		}
		else if (ch === ' ') {
			width += size * 0.3;
		}
		else {
			width += size * 0.5;
		}
	}
	return width;
};

test('tokenize keeps Latin words atomic and CJK per-character', () => {
	const tokens = tokenize('CCTA 是一线检查 first-line');
	assert.ok(tokens.includes('CCTA'));
	assert.ok(tokens.includes('是') && tokens.includes('一'));
	assert.ok(tokens.some(t => t.startsWith('first')));
});

test('wrapAt never splits a Latin word across lines', () => {
	const lines = wrapAt('the CCTA examination shows atherosclerosis', 10, 80, measure)!;
	for (const line of lines) {
		// every Latin token in every line is intact (appears in the source)
		for (const word of line.split(/\s+/)) {
			assert.ok('the CCTA examination shows atherosclerosis'.includes(word), word);
		}
	}
});

test('wrapAt hard-splits a single over-wide token instead of failing', () => {
	const lines = wrapAt('https://doi.org/10.1016/j.ejrad.2023.111008', 10, 60, measure)!;
	assert.ok(lines.length > 1);
	assert.equal(lines.join(''), 'https://doi.org/10.1016/j.ejrad.2023.111008');
});

test('layoutBlock keeps the source size when the translation fits', () => {
	// Box: 200 wide, 40 tall; 10pt CJK line of 12 chars = 120 wide → fits.
	const result = layoutBlock('这是一个很短的译文段落。', 200, 40, 10, measure);
	assert.equal(result.fontSize, 10, '与原文字号一致');
	assert.equal(result.overflow, false);
});

test('layoutBlock shrinks only when the translation runs longer', () => {
	const long = '这是一个非常长的译文段落，'.repeat(8);
	const result = layoutBlock(long, 200, 40, 10, measure);
	assert.ok(result.fontSize < 10);
	assert.equal(result.overflow, false);
	assert.ok(result.lines.length * result.lineHeight <= 40 + result.fontSize * 0.35);
});

test('layoutBlock clips with an ellipsis at the minimum size', () => {
	const enormous = '内容。'.repeat(400);
	const result = layoutBlock(enormous, 100, 20, 10, measure, { minSize: 6 });
	assert.equal(result.overflow, true);
	assert.equal(result.fontSize, 6);
	assert.ok(result.lines[result.lines.length - 1]!.endsWith('…'));
});

test('layoutBlock tolerates empty text and degenerate boxes', () => {
	assert.deepEqual(layoutBlock('', 100, 50, 10, measure).lines, []);
	assert.deepEqual(layoutBlock('文字', 0, 0, 10, measure).lines, []);
});

// ---- 2.3.4 (第四批 item6 · LO-4): CJK 标点禁则 ------------------------------

test('applyKinsoku: 收尾标点不顶行首(悬挂到上一行)', () => {
	assert.deepEqual(applyKinsoku(['这是第一行', '。第二行继续']), ['这是第一行。', '第二行继续']);
	// 连续两个收尾标点也一并悬挂(上限 2)。
	assert.deepEqual(applyKinsoku(['结尾', '。」后文']), ['结尾。」', '后文']);
});

test('applyKinsoku: 起始标点不吊行尾(下移到下一行)', () => {
	assert.deepEqual(applyKinsoku(['前文见(', '图1)']), ['前文见', '(图1)']);
});

test('applyKinsoku: 迁空的行被删除,行数只减不增', () => {
	const out = applyKinsoku(['正文', '。']);
	assert.deepEqual(out, ['正文。']);
	assert.ok(out.length <= 2);
});

test('wrapAt 集成禁则: 句号不再顶行首', () => {
	const measure: Measure = (text, size) => text.length * size; // 等宽假度量
	// 宽 50 / 字号 10 → 每行 5 字。「四字词语。」会把句号切到下一行 → 禁则悬挂回来。
	const lines = wrapAt('四字词语。后续内容继续', 10, 50, measure)!;
	assert.ok(lines[0]!.endsWith('。'), `句号应悬挂在首行行尾, got: ${JSON.stringify(lines)}`);
	assert.ok(lines.every(l => !'。,、;:?!)」'.includes(l[0]!)), '任何行都不得以收尾标点开头');
});

// ---- 2.3.4 (item6 · LO-6): 导出扩边测量 -------------------------------------

import { exportExpansionAllowance, unionOfRects } from '../../src/pdfgen/translatedPdfBuilder';

test('exportExpansionAllowance: 右扩被邻块近边截断,下扩受页界与上限约束 (PDF y 向上)', () => {
	const box: [number, number, number, number] = [100, 600, 200, 640]; // 宽100 高40
	// 右侧邻块 x 从 260 起,与 box 垂直向重叠 → 右扩 = 260-200-3 = 57 → 上限 0.6×100=60 → 57。
	const blockers: [number, number, number, number][] = [[260, 590, 320, 650]];
	const { right, down } = exportExpansionAllowance(box, blockers, 612, 792, 10);
	assert.equal(right, 57);
	// 下方无邻块 → 受上限 max(2.8×10, 0.5×40) = 28。
	assert.ok(Math.abs(down - 28) < 0.01, `down=${down}`);
});

test('exportExpansionAllowance: 下方邻块截断下扩,已重叠者截为 0', () => {
	const box: [number, number, number, number] = [100, 600, 200, 640];
	// 下方邻块顶边 y=580,与 box 水平向重叠 → 下扩 = 600-580-3 = 17。
	const below = exportExpansionAllowance(box, [[100, 540, 200, 580]], 612, 792, 10);
	assert.equal(below.down, 17);
	// 已与右侧重叠的邻块 → 右扩钳为 0,不为负。
	const overlapped = exportExpansionAllowance(box, [[150, 600, 260, 640]], 612, 792, 10);
	assert.equal(overlapped.right, 0);
});

test('unionOfRects 取多行矩形的包围盒', () => {
	assert.deepEqual(unionOfRects([[10, 20, 100, 30], [12, 8, 90, 18]]), [10, 8, 100, 30]);
});
