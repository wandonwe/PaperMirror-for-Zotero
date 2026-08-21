import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSplitView } from '../../src/reader/splitView';

/**
 * P1-7 (2.0.2): applyRatio 的「版面未就绪」重试此前是裸 setTimeout —— 没有句柄、
 * 没有计数、不看 destroyed。Zotero 隐藏非选中标签的容器,隐藏元素宽度恒为 0,
 * 于是重试链永不终止;而会话每 350ms 调一次 refreshLayout → applyRatio,
 * **每 350ms 新增一条 20Hz 链**且互不取消(后台几分钟即每秒上万次强制重排),
 * destroy() 后残链还会把阅读器重新钉死在 50% 宽。
 *
 * 这里用最小 DOM shim 驱动真实实现,断言:单链、有上限、destroy 后不再动 DOM。
 */

// ---- 最小 DOM shim ----------------------------------------------------------
let timerSeq = 1;
const timers = new Map<number, () => void>();

function makeEl(doc: any, width: () => number): any {
	const el: any = {
		ownerDocument: doc,
		className: '', id: '',
		children: [] as any[],
		_styles: new Map<string, string>(),
		style: {} as any,
		getBoundingClientRect: () => ({ width: width(), height: 100, top: 0, left: 0 }),
		getAttribute: () => '',
		setAttribute: () => {},
		removeAttribute: () => {},
		appendChild: (c: any) => { el.children.push(c); return c; },
		after: (...nodes: any[]) => { el.children.push(...nodes); },
		remove: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		querySelector: () => null,
		contains: () => true
	};
	// style: 记录 setProperty 调用次数,用来验证 destroy 后不再改 DOM
	el.style = new Proxy({
		setProperty: (k: string, v: string) => { el._styles.set(k, v); el._setPropertyCalls = (el._setPropertyCalls ?? 0) + 1; },
		getPropertyValue: (k: string) => el._styles.get(k) ?? '',
		removeProperty: (k: string) => { el._styles.delete(k); }
	} as any, {
		get: (t: any, p: string) => (p in t ? t[p] : (el._styles.get(p) ?? '')),
		set: (_t: any, p: string, v: any) => { el._styles.set(p, String(v)); return true; }
	});
	return el;
}

function setup(containerWidth: () => number) {
	timers.clear();
	const doc: any = {
		getElementById: () => ({ remove: () => {} }),   // 样式已注入,跳过
		createElementNS: (_ns: string, _tag: string) => makeEl(doc, () => 0),
		documentElement: { appendChild: () => {} },
		defaultView: {
			setTimeout: (fn: () => void) => { const id = timerSeq++; timers.set(id, fn); return id; },
			clearTimeout: (id: number) => { timers.delete(id); }
		}
	};
	(globalThis as any).clearTimeout = (id: number) => { timers.delete(id); };
	const container = makeEl(doc, containerWidth);
	const browser = makeEl(doc, () => 0);
	return { doc, container, browser };
}

/** 跑完当前所有到期定时器一轮(模拟 50ms 过去)。 */
function tick(): void {
	const due = [...timers.entries()];
    for (const [id, fn] of due) { timers.delete(id); fn(); }
}

test('容器不可见(宽度 0)时: 重试链始终只有一条, 不随调用次数增殖', () => {
	const { container, browser } = setup(() => 0);
	const split = createSplitView(container as any, browser as any);
	split.setPaneVisible?.(true);
	// 模拟会话轮询:反复调 setRatio(等价于 refreshLayout 触发的 applyRatio)
	for (let i = 0; i < 20; i++) {
		split.setRatio(50);
		tick();
	}
	assert.ok(timers.size <= 1, `任何时刻至多一条待定重试, 实际 ${timers.size}`);
	split.destroy();
});

test('重试有上限: 容器长期不可见时链会自行终止', () => {
	const { container, browser } = setup(() => 0);
	const split = createSplitView(container as any, browser as any);
	split.setPaneVisible?.(true);
	split.setRatio(50);
	// 只让链自己跑,不再外部触发
	for (let i = 0; i < 200 && timers.size; i++) {
		tick();
	}
	assert.equal(timers.size, 0, '超过上限后必须停下,而不是永远自续');
	split.destroy();
});

test('destroy() 之后残留重试不再改动 DOM', () => {
	const { container, browser } = setup(() => 0);
	const split = createSplitView(container as any, browser as any);
	split.setPaneVisible?.(true);
	split.setRatio(50);
	const pending = [...timers.values()];
	split.destroy();
	const before = (browser as any)._setPropertyCalls ?? 0;
	// 即使有残链被执行(或 destroy 未能清掉的),也不得再钉死宽度
	for (const fn of pending) { fn(); }
	const after = (browser as any)._setPropertyCalls ?? 0;
	assert.equal(after, before, 'destroy 后不得再对 browser 设置 !important 宽度');
});

test('容器可见时正常钉宽, 且不产生重试链', () => {
	const { container, browser } = setup(() => 1200);
	const split = createSplitView(container as any, browser as any);
	split.setPaneVisible?.(true);
	split.setRatio(50);
	assert.equal(timers.size, 0, '版面就绪时不该有重试');
	assert.ok((browser as any)._styles.get('width'), '应已钉住宽度');
	split.destroy();
});
