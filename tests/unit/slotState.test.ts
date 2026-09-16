/**
 * 整页对照槽状态机 (2.5.2) —— "往回翻译文消失"的根因回归。
 *
 * pumpRenders 只重排 slotState === 'empty' 或 slotDirty 的槽,而 slotDirty
 * 只在 manager 通知 done 时置位、已 done 的页永不再通知。所以任何被写成
 * 终态的结果就等于"这一页这辈子不会再重建"。'degraded' 必须自愈。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextSlotState, shouldRenderPartial, MIN_INTERVAL_MS } from '../../src/ui/translationPane';

const NOW = 1_700_000_000_000;

test("'translated' 是终态,且清空降级预算", () => {
	const d = nextSlotState('translated', 2, NOW);
	assert.equal(d.state, 'translated');
	assert.equal(d.dirty, false);
	assert.equal(d.retryAt, 0);
	assert.equal(d.tries, 0, '成功一次就把预算还回去');
});

test("'original'(本就没有译文的页)是终态", () => {
	const d = nextSlotState('original', 0, NOW);
	assert.equal(d.state, 'original');
	assert.equal(d.dirty, false, '纯图/扫描页反复重建毫无意义');
	assert.equal(d.retryAt, 0);
});

test('false 保持 ghost 并退避重试', () => {
	const d = nextSlotState(false, 0, NOW);
	assert.equal(d.state, 'empty');
	assert.equal(d.retryAt, NOW + 2500);
});

test("'degraded' 画原文但必须排进重试 —— 绝不当终态", () => {
	const first = nextSlotState('degraded', 0, NOW);
	assert.equal(first.state, 'original', '先把原文画上,总比空白强');
	assert.equal(first.dirty, true, '这一条就是修复本体');
	assert.equal(first.retryAt, NOW + 1200);
	assert.equal(first.tries, 1);

	// 退避递增
	const second = nextSlotState('degraded', first.tries, NOW);
	assert.equal(second.dirty, true);
	assert.equal(second.retryAt, NOW + 2400);
	const third = nextSlotState('degraded', second.tries, NOW);
	assert.equal(third.dirty, true);
	assert.equal(third.retryAt, NOW + 3600);
});

test('确定性失败在 3 次后停手,不永久空转', () => {
	const d = nextSlotState('degraded', 3, NOW);
	assert.equal(d.state, 'original');
	assert.equal(d.dirty, false, '第 4 次不再排队');
	assert.equal(d.retryAt, 0);
	assert.equal(d.tries, 4);
});

test('一次降级后重建成功,预算复位', () => {
	const failed = nextSlotState('degraded', 0, NOW);
	const ok = nextSlotState('translated', failed.tries, NOW);
	assert.equal(ok.state, 'translated');
	assert.equal(ok.tries, 0);
});

// ---- 增量显示 (2.7.10 起;2.8.2 改为修订号驱动) ------------------------------

test("'partial' 是半成品页: 画上去但不是终态,不排重试、不动降级预算", () => {
	const d = nextSlotState('partial', 2, NOW);
	assert.equal(d.state, 'translated', '半成品页确实画上了译文');
	assert.equal(d.dirty, false, '不自排重试 —— 下一批到达时由 renderPage 置脏');
	assert.equal(d.retryAt, 0);
	assert.equal(d.tries, 2, '降级预算原样保留,不被半成品重建刷回 0');
});

test('shouldRenderPartial: 可见 + 修订号前进 + 距上次够久,三道闸各自把关 (2.8.2)', () => {
	const base = { status: 'translating' as const, revision: 3, rendered: 0, lastAt: 0, now: NOW, visible: true };
	assert.equal(shouldRenderPartial(base), true, '有新译文、页面可见、还没画过 → 画');

	assert.equal(shouldRenderPartial({ ...base, visible: false }), false,
		'后台页只更新数据,不立即排版');
	assert.equal(shouldRenderPartial({ ...base, rendered: 3 }), false,
		'同一修订版本只渲染一次 —— 重复通知不该再重建');
	assert.equal(shouldRenderPartial({ ...base, rendered: 4 }), false,
		'修订号倒退(乱序通知)也不画');
	assert.equal(shouldRenderPartial({ ...base, rendered: 2 }), true, '修订号前进就画');
	assert.equal(shouldRenderPartial({ ...base, lastAt: NOW - MIN_INTERVAL_MS + 1 }), false, '距上次太近');
	assert.equal(shouldRenderPartial({ ...base, lastAt: NOW - MIN_INTERVAL_MS }), true, '隔够了就画');
	assert.equal(MIN_INTERVAL_MS, 500, '可见页每 500 ms 最多刷新一次');

	// done 是终态,由无条件重建那条路走,绝不从这里出去。
	for (const status of ['idle', 'extracting', 'done', 'error', 'no-text-layer'] as const) {
		assert.equal(shouldRenderPartial({ ...base, status }), false, `${status} 不走增量`);
	}
});

test('最后一个块一直不来时,前面已完成的块照样能显示 (2.8.2 第三批)', () => {
	// 33 块的页,3 个批次。前两批到手(修订号 1、2),最后一批永远不来。
	let now = NOW;
	let rendered = 0;
	let lastAt = 0;
	const paint = (revision: number): boolean => {
		const yes = shouldRenderPartial({ status: 'translating', revision, rendered, lastAt, now, visible: true });
		if (yes) {
			rendered = revision;
			lastAt = now;
		}
		return yes;
	};
	assert.equal(paint(1), true, '第一批就画 —— 用户不必等满整页');
	now += 200;
	assert.equal(paint(2), false, '200 ms 内不重画');
	now += 300;
	assert.equal(paint(2), true, '够 500 ms 了,第二批画上');
	now += 5000;
	assert.equal(paint(2), false, '最后一批不来,修订号不动,就不再空转重建');
	assert.equal(rendered, 2, '已完成的两批停在画面上,不会被撤回');
});
test('readerSession 的半成品重建不结算、不报统计 (结构性回归闸, 2.7.10)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const start = src.indexOf("const partial = !!(state && (state.status === 'translating'");
	assert.ok(start > 0, '找不到 partial 判定');
	const body = src.slice(start, src.indexOf("return partial ? 'partial' : 'translated';", start));
	// 半成品页对着一个还在长的页面压缩重试会白花请求,报排版统计会误报数字。
	const settle = body.indexOf('settleStrictPage(');
	assert.ok(body.indexOf('if (partial)', settle) < body.indexOf('this.reportPlacement(', settle),
		'partial 闸必须在 reportPlacement / resolveStrictUnfit 之前');
	// 2.8.2: 跳过的只有压缩重试与统计入账 —— 墨迹闸与跨块碰撞检查照跑,
	// 否则半成品页可能带着叠印显示出去。
	assert.ok(/this\.auditPartialGeometry\(pageIndex, element\);\s*\n\s*return;/.test(body),
		'半成品页必须先跑几何审计再返回');
	const audit = src.slice(src.indexOf('private auditPartialGeometry('), src.indexOf('private reportPlacement('));
	assert.ok(/auditStrictGeometry\(element\)/.test(audit), '审计必须真的跑');
	assert.ok(!/geometryAudits\.set/.test(audit), '半成品的审计数字不进诊断');
	assert.ok(!/resolveStrictUnfit|strictPageStats/.test(audit), '半成品不压缩重试、不取统计');
});

test('renderPage 的页视图真的走增量分支,且 done 仍无条件重建 (结构性回归闸, 2.7.10)', () => {
	const src = readFileSync(join(process.cwd(), 'src/ui/translationPane.ts'), 'utf8');
	const start = src.indexOf('\trenderPage(state: PageTranslationState): void {');
	assert.ok(start > 0, '找不到 renderPage');
	const body = src.slice(start, src.indexOf('const section = this.ensurePageSection(', start));
	assert.ok(/if \(state\.status === 'done'\)[\s\S]*?this\.refreshPage\(state\.pageIndex\);/.test(body),
		'done 必须仍然无条件重建');
	assert.ok(/shouldRenderPartial\(\{[\s\S]*?visible: state\.pageIndex >= first && state\.pageIndex <= last/.test(body),
		'途中必须过 shouldRenderPartial,可见性来自 visibleRange');
	assert.ok(/resetDegrade: false/.test(body), '半成品重建不得复位降级预算');
	assert.ok(body.indexOf('this.slotPartialAt[state.pageIndex] = Date.now();') > 0,
		'画过之后要记下时刻,否则节流闸永远放行');
	// 2.8.2: 修订号驱动 —— done 也要记下最终修订号,否则同一修订的重复通知
	// 会再触发一次整页重建。
	assert.ok(/revision: state\.translationRevision \?\? 0|const revision = state\.translationRevision \?\? 0;/.test(body),
		'必须读页状态上的 translationRevision');
	const doneBranch = body.slice(body.indexOf("if (state.status === 'done')"), body.indexOf('const [first, last]'));
	assert.ok(/this\.slotRenderedRevision\[state\.pageIndex\] = revision;/.test(doneBranch),
		'done 分支要记下最终修订号');
});

test('渲染期间保留上一版页面: 不先清空、不先画遮罩 (结构性回归闸, 2.8.2 第三批)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const start = src.indexOf('private async renderDocPage(');
	const body = src.slice(start, src.indexOf('private auditPartialGeometry('));
	// 唯一的两处 replaceChildren 都在结果**已经建好**之后;整个 renderDocPage
	// 里不得出现"先把槽清掉再慢慢建"的写法。
	assert.ok(!/slot\.replaceChildren\(\)/.test(body), '不得先清空槽');
	assert.ok(!/slot\.replaceChildren\(this\.makeGhost/.test(body), '渲染期间不得先换成 ghost');
	const built = body.indexOf('if (built) {');
	assert.ok(built > 0 && built < body.indexOf('slot.replaceChildren(applyFit(built.element))'),
		'先建好新页面,再一次性替换 —— 旧页面在此之前一直留在屏幕上');
});
