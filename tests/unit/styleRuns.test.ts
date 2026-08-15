import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStyleRuns, insertStyleMarkers, finalizeStyleMarkers, parseStyledSegments, stripStyleMarkers } from '../../src/reader/styleRuns';
import { PlaceholderRegistry } from '../../src/translation/placeholderRegistry';
import { stripProtectable } from '../../src/reader/formulaGuard';
import type { PdfChar } from '../../src/types/models';

function charsOf(spec: { text: string; font?: string }[]): PdfChar[] {
	const out: PdfChar[] = [];
	for (const part of spec) {
		for (const c of part.text) {
			out.push({ c, fontName: part.font ?? 'ABCDEF+TimesNewRoman', fontSize: 10 } as unknown as PdfChar);
		}
	}
	return out;
}

test('detectStyleRuns: bold/italic spans vs a regular dominant style', () => {
	const chars = charsOf([
		{ text: 'The species ' },
		{ text: 'E. coli', font: 'ABCDEF+Times-Italic' },
		{ text: ' shows a ' },
		{ text: 'significant', font: 'ABCDEF+Times-Bold' },
		{ text: ' effect in all trials of the study.' }
	]);
	const runs = detectStyleRuns(chars);
	assert.deepEqual(runs, [
		{ text: 'E. coli', style: 'i' },
		{ text: 'significant', style: 'b' }
	]);
	// 整段同样式 → 不算段内跨度(块级样式另有通道)。
	assert.deepEqual(detectStyleRuns(charsOf([{ text: 'All bold heading', font: 'X+Arial-Bold' }])), []);
});

test('insert + finalize + parse: intact pairs become styled segments', () => {
	const marked = insertStyleMarkers('The species E. coli shows X.', [{ text: 'E. coli', style: 'i' }]);
	assert.equal(marked, 'The species ⟦i⟧E. coli⟦/i⟧ shows X.');
	const finalized = finalizeStyleMarkers('该物种 ⟦i⟧大肠杆菌⟦/i⟧ 显示 X。');
	const segments = parseStyledSegments(finalized);
	assert.deepEqual(segments, [
		{ text: '该物种 ', style: null },
		{ text: '大肠杆菌', style: 'i' },
		{ text: ' 显示 X。', style: null }
	]);
});

test('degrade-safe: broken/interleaved/unclosed pairs strip to plain text, never reject', () => {
	assert.equal(finalizeStyleMarkers('译文 ⟦b⟧粗体没关'), '译文 粗体没关');
	assert.equal(finalizeStyleMarkers('译文 ⟦b⟧交⟦i⟧错⟦/b⟧对⟦/i⟧'), '译文 交错对');
	assert.equal(finalizeStyleMarkers('孤立关闭 ⟦/i⟧ 也剥'), '孤立关闭  也剥');
	assert.equal(finalizeStyleMarkers('空对 ⟦b⟧⟦/b⟧ 剥掉'), '空对  剥掉');
	// parse 防御:不配对输入回退为单个纯文本段。
	assert.deepEqual(parseStyledSegments('⟦b⟧未闭合'), [{ text: '未闭合', style: null }]);
});

test('registry end-to-end: style pair survives protect → translate → restore; formula masking cannot break it', () => {
	const reg = PlaceholderRegistry.protect(
		'The significant term with $E=mc^2$ holds.',
		[],
		[{ text: 'significant', style: 'b' }]
	);
	assert.ok(reg.text.includes('⟦b⟧significant⟦/b⟧'), reg.text);
	// 模型把对儿保留在译文对应词上:
	const translated = reg.text.replace('The ', '该 ').replace('significant', '显著').replace(' holds.', ' 成立。');
	const restored = reg.restore(translated);
	assert.ok(restored.includes('⟦b⟧显著⟦/b⟧'), restored);
	assert.ok(restored.includes('$E=mc^2$'), restored);
	// 模型丢了关闭标记 → restore 后降级为纯文本(公式仍还原)。
	const broken = reg.restore(translated.replace('⟦/b⟧', ''));
	assert.ok(!broken.includes('⟦'), broken);
	assert.ok(broken.includes('$E=mc^2$'), broken);
});

test('quality checks never see style markers: stripProtectable removes them', () => {
	const prose = stripProtectable('该 ⟦b⟧显著⟦/b⟧ 项与 ⟦PM0⟧ 成立。');
	assert.ok(!prose.includes('⟦'), prose);
	assert.equal(stripStyleMarkers('无标记文本'), '无标记文本');
});
