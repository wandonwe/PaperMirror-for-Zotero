import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectFormulas, restoreFormulas, placeholdersIntact, isFormulaRun } from '../../src/reader/formulaGuard';

test('isFormulaRun detects symbol-dense math', () => {
	assert.equal(isFormulaRun('y = βx + ε'), true);
	assert.equal(isFormulaRun('∑_{i=1}^{n} x_i'), true);
	assert.equal(isFormulaRun('This is an ordinary English sentence.'), false);
});

test('protect + restore round-trips a LaTeX span', () => {
	const input = 'We model $E = mc^2$ in the paper.';
	const { text, placeholders } = protectFormulas(input);
	assert.equal(placeholders.length, 1);
	assert.ok(!text.includes('mc^2'));
	const translated = text.replace('We model', '我们建模').replace('in the paper', '于论文中');
	const restored = restoreFormulas(translated, placeholders);
	assert.ok(restored.includes('$E = mc^2$'));
});

test('placeholdersIntact detects a dropped token', () => {
	const { placeholders } = protectFormulas('value $x = 1$ here');
	assert.equal(placeholdersIntact('translated without token', placeholders), false);
	assert.equal(placeholdersIntact(`translated ${placeholders[0]!.token}`, placeholders), true);
});

test('ordinary prose is untouched', () => {
	const input = 'The overall survival was 24 months (95% CI: 18-30).';
	const { text, placeholders } = protectFormulas(input);
	// CI notation may or may not be captured; text must still restore identically
	assert.equal(restoreFormulas(text, placeholders), input);
});

// ---------------------------------------------------------------------------
// 0.9.24 批次1: 引用标记/统计量保护 + 清单校验 + 散文视图 (参照 retain-pdf)
// ---------------------------------------------------------------------------

import { stripProtectable, verifyPlaceholders } from '../../src/reader/formulaGuard';

test('citations and statistics are masked and round-trip byte-identical', () => {
	const input = 'The odds ratio was 0.82 (95% CI: 0.71–0.94, p = 0.003) with n = 342 across sites [12,15-18], mean 34.2 ± 5.1.';
	const { text, placeholders } = protectFormulas(input);
	assert.ok(placeholders.length >= 4, `expected ≥4 placeholders, got ${placeholders.length}`);
	assert.ok(!text.includes('p = 0.003'));
	assert.ok(!text.includes('[12,15-18]'));
	assert.ok(!text.includes('±'));
	assert.equal(restoreFormulas(text, placeholders), input);
});

test('stripProtectable leaves prose only — stats do not count as Latin words', () => {
	const stripped = stripProtectable('比值比为 0.82(95% CI: 0.71–0.94,p = 0.003),n = 342 [12]。');
	assert.ok(!/CI/.test(stripped));
	assert.ok(!/342/.test(stripped));
});

test('verifyPlaceholders flags lost and invented tokens, accepts bare form', () => {
	const { text, placeholders } = protectFormulas('We test $x=1$ and $y=2$ here.');
	assert.equal(placeholders.length, 2);
	const t0 = placeholders[0]!.token;
	// all present → ok
	assert.equal(verifyPlaceholders(`译文 ${t0} 与 ${placeholders[1]!.token}`, placeholders).ok, true);
	// one lost → missing
	const lost = verifyPlaceholders(`译文只有 ${t0}`, placeholders);
	assert.equal(lost.ok, false);
	assert.equal(lost.missing.length, 1);
	// bare "PMn" form counts as present
	const bare = placeholders[1]!.token.replace('⟦', '').replace('⟧', '');
	assert.equal(verifyPlaceholders(`译文 ${t0} 与 ${bare}`, placeholders).ok, true);
	// invented token → unexpected
	const invented = verifyPlaceholders(`译文 ${t0} ${placeholders[1]!.token} ⟦PM7⟧`, placeholders);
	assert.equal(invented.ok, false);
	assert.deepEqual(invented.unexpected, ['⟦PM7⟧']);
	void text;
});

test('user do-not-translate literals are masked via extraLiterals', () => {
	const { text, placeholders } = protectFormulas(
		'The RetainNet model outperforms baselines.', ['RetainNet']
	);
	assert.ok(!text.includes('RetainNet'));
	const restored = restoreFormulas(text.replace('The', '该').replace('model outperforms baselines.', '模型优于基线。'), placeholders);
	assert.ok(restored.includes('RetainNet'));
});

// ---------------------------------------------------------------------------
// 1.0.2 审核 P1: 裸占位符前缀碰撞 —— PM1 不得吃掉 PM10
// ---------------------------------------------------------------------------

test('bare-token fallback respects digit boundaries (PM1 vs PM10)', () => {
	// 11 formulas → tokens ⟦PM0⟧…⟦PM10⟧.
	const source = Array.from({ length: 11 }, (_, i) => `$f_{${i}}=${i}$`).join(' and ');
	const { placeholders } = protectFormulas(source);
	assert.equal(placeholders.length, 11);
	// Translation kept every bracket token EXCEPT PM1, and PM10 came back BARE.
	const translated = '结果 ' + placeholders
		.filter((_, i) => i !== 1)
		.map((p, idx) => (idx === placeholders.length - 2 ? 'PM10' : p.token))
		.join(' 与 ');
	const report = verifyPlaceholders(translated, placeholders);
	assert.ok(report.missing.includes('⟦PM1⟧'), 'PM1 truly missing — PM10 must not satisfy it');
	assert.ok(!report.missing.includes('⟦PM10⟧'), 'bare PM10 counts as present');
	// Restore must map bare PM10 to formula #10 intact — never original1 + "0".
	const restored = restoreFormulas(translated, placeholders);
	assert.ok(restored.includes('$f_{10}=10$'), `PM10 restored correctly: ${restored}`);
	assert.ok(!restored.includes('$f_{1}=1$0'), 'PM10 must not be torn into original1+"0"');
});

// ---------------------------------------------------------------------------
// 1.0.6 — 碰撞规避与幻觉变体归一 (参照 BabelDOC il_translator.py)

test('collision avoidance: source already containing ⟦PMn⟧ never gets a colliding token (1.0.6)', () => {
	const input = '如上节 ⟦PM1⟧ 所示,我们建模 $E = mc^2$ 于此。';
	const { text, placeholders } = protectFormulas(input);
	// The pre-existing literal is masked, and issued numbering starts ABOVE it.
	assert.ok(!text.includes('⟦PM1⟧'), `pre-existing token masked: ${text}`);
	assert.ok(placeholders.every(p => p.token !== '⟦PM1⟧'), 'never issue a colliding token');
	assert.ok(placeholders.some(p => p.original === '⟦PM1⟧'), 'pre-existing token protected as literal');
	// Round-trip: both the literal ⟦PM1⟧ and the formula come back verbatim.
	const restored = restoreFormulas(text, placeholders);
	assert.equal(restored, input);
	// Inventory check passes on a faithful translation (no phantom "unexpected").
	assert.equal(verifyPlaceholders(text, placeholders).ok, true);
});

test('hallucinated variants (【】, [], spaces, case, 全角数字) are normalized then verified/restored (1.0.6)', () => {
	const source = '$a=1$ then $b=2$ then $c=3$';
	const { placeholders } = protectFormulas(source);
	assert.equal(placeholders.length, 3); // ⟦PM0⟧ ⟦PM1⟧ ⟦PM2⟧
	const translated = '首先 【PM0】 其次 [pm 1] 最后 ⟦PM２⟧';
	const report = verifyPlaceholders(translated, placeholders);
	assert.equal(report.ok, true, JSON.stringify(report));
	const restored = restoreFormulas(translated, placeholders);
	assert.ok(restored.includes('$a=1$') && restored.includes('$b=2$') && restored.includes('$c=3$'), restored);
	assert.ok(!/PM\s*[0-9０-９]/.test(restored), `no residual variants: ${restored}`);
});

test('variant normalization is conservative: unissued numbers and duplicates left for residue rules (1.0.6)', () => {
	const { placeholders } = protectFormulas('$a=1$');
	// Unissued number → untouched (real hallucination, residue rules own it).
	const unissued = restoreFormulas('译文 ⟦PM0⟧ 与 【PM7】', placeholders);
	assert.ok(unissued.includes('【PM7】'), unissued);
	// Canonical already present → variant NOT normalized (would duplicate the formula).
	const dup = restoreFormulas('译文 ⟦PM0⟧ 与 [PM0]', placeholders);
	assert.equal((dup.match(/\$a=1\$/g) ?? []).length, 1, dup);
	assert.ok(dup.includes('[PM0]'), 'duplicate variant left as visible residue');
});


test('round-bracket numeric citations masked; overlapping neighbours block expansion (1.1.4)', async () => {
	const src = 'Outcomes occur in cardiomyopathies (2–4) and heart failure (1,5–7). See Smith et al. here.';
	const { text, placeholders } = protectFormulas(src);
	assert.ok(!/\(\d/.test(text), text);
	assert.ok(text.includes('Smith et al.'));
	assert.equal(restoreFormulas(text, placeholders), src);
	const { computeExpansionAllowance } = await import('../../src/ui/strictPageReplacement');
	// 邻居与本块已有 4px 重叠(drop cap 常态)→ 向下扩张必须为 0,不得穿过。
	const grow = computeExpansionAllowance(
		{ left: 50, top: 100, width: 200, height: 20 },
		[{ left: 50, top: 116, width: 200, height: 300 }],
		600, 800, 40);
	assert.equal(grow.down, 0, JSON.stringify(grow));
});

// ---- P3 (2.0.10): 裸占位符边界不吞 "PM2.5" 类真实文本 -----------------------

test('正文 "PM2.5" 不得满足 ⟦PM2⟧ 的裸形态: 丢失照实报告,restore 不撕正文', async () => {
	const { verifyPlaceholders, restoreFormulas } = await import('../../src/reader/formulaGuard');
	const placeholders = [
		{ token: '⟦PM1⟧', original: '$x^2$' },
		{ token: '⟦PM2⟧', original: '$\\beta_1$' }
	];
	// 模型把 ⟦PM2⟧ 弄丢了,但译文正文里有环境学常见字面量 "PM2.5"。
	const text = '空气中 PM2.5 浓度与 ⟦PM1⟧ 相关。';
	const verdict = verifyPlaceholders(text, placeholders as never);
	assert.ok(verdict.missing.includes('⟦PM2⟧'),
		'旧边界 (?!\\d) 不挡小数点 → "PM2.5" 误判 ⟦PM2⟧ 在场,重试被抑制');
	// restore 的裸回退不得把 "PM2.5" 的 "PM2" 前缀换成公式原文。
	const restored = restoreFormulas(text, placeholders as never);
	assert.ok(restored.includes('PM2.5'), `正文 PM2.5 必须原样存活,实际: ${restored}`);
	assert.ok(!restored.includes('$\\beta_1$.5'), '不得出现公式原文+".5" 的撕裂产物');
	// 真正的裸形态 (模型丢了括号) 照常回填。
	const bareText = '公式 PM2 出现在此。';
	const bareRestored = restoreFormulas(bareText, [placeholders[1]] as never);
	assert.ok(bareRestored.includes('$\\beta_1$'), '真实裸形态照常回填');
});
