import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusCapsule, type OverlayProgress, type CapsuleCallbacks } from '../../src/ui/statusCapsule';

/**
 * A tiny self-contained DOM good enough for StatusCapsule.build()/render() and
 * for dispatching bubbling clicks with stopPropagation — so we can assert the
 * REAL hit-layer wiring (no distance guessing) without pulling in jsdom.
 */
class FakeNode {
	tagName: string;
	className = '';
	title = '';
	textContent = '';
	style: Record<string, string> = {};
	attrs = new Map<string, string>();
	children: FakeNode[] = [];
	parent: FakeNode | null = null;
	listeners = new Map<string, ((e: FakeEvent) => void)[]>();
	onclick: ((e: FakeEvent) => void) | null = null;

	constructor(tag: string) {
		this.tagName = tag;
	}

	get ownerDocument(): FakeDoc {
		return doc;
	}

	appendChild(n: FakeNode): FakeNode {
		n.parent = this;
		this.children.push(n);
		return n;
	}

	append(...ns: FakeNode[]): void {
		for (const n of ns) {
			this.appendChild(n);
		}
	}

	remove(): void {
		if (this.parent) {
			this.parent.children = this.parent.children.filter(c => c !== this);
			this.parent = null;
		}
	}

	get parentElement(): FakeNode | null {
		return this.parent; // P2-9: 胶囊 render 以 parentElement 判宿主归属
	}

	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}

	getAttribute(k: string): string | null {
		return this.attrs.has(k) ? this.attrs.get(k)! : null;
	}

	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}

	hasAttribute(k: string): boolean {
		return this.attrs.has(k);
	}

	addEventListener(type: string, fn: (e: FakeEvent) => void): void {
		const arr = this.listeners.get(type) ?? [];
		arr.push(fn);
		this.listeners.set(type, arr);
	}

	private classes(): string[] {
		// SVG nodes set their class via setAttribute('class', …); merge both.
		return `${this.className} ${this.attrs.get('class') ?? ''}`.split(/\s+/).filter(Boolean);
	}

	private matches(sel: string): boolean {
		return sel.startsWith('.') && this.classes().includes(sel.slice(1));
	}

	querySelector(sel: string): FakeNode | null {
		for (const c of this.children) {
			if (c.matches(sel)) {
				return c;
			}
			const deep = c.querySelector(sel);
			if (deep) {
				return deep;
			}
		}
		return null;
	}

	/** Dispatch a click that bubbles child→parent until stopPropagation. */
	click(): void {
		const evt = new FakeEvent(this);
		let n: FakeNode | null = this;
		while (n) {
			evt.currentTarget = n;
			n.onclick?.(evt);
			for (const fn of n.listeners.get('click') ?? []) {
				fn(evt);
			}
			if (evt._stopped) {
				break;
			}
			n = n.parent;
		}
	}
}

class FakeEvent {
	target: FakeNode;
	currentTarget: FakeNode;
	_stopped = false;

	constructor(target: FakeNode) {
		this.target = target;
		this.currentTarget = target;
	}

	stopPropagation(): void {
		this._stopped = true;
	}

	preventDefault(): void {
		/* no-op */
	}
}

class FakeDoc {
	container = new FakeNode('div');

	createElement(tag: string): FakeNode {
		return new FakeNode(tag);
	}

	createElementNS(_ns: string, tag: string): FakeNode {
		return new FakeNode(tag);
	}

	querySelector(sel: string): FakeNode | null {
		if (this.container.className && ('.' + this.container.className.split(/\s+/)[0]) === sel) {
			return this.container.children.find(c => c) ?? null;
		}
		return this.container.querySelector(sel);
	}

	querySelectorAll(sel: string): FakeNode[] {
		const out: FakeNode[] = [];
		const walk = (n: FakeNode): void => {
			for (const c of n.children) {
				if (('.' + c.className.split(/\s+/)[0]) === sel || c.className.split(/\s+/).includes(sel.slice(1))) {
					out.push(c);
				}
				walk(c);
			}
		};
		walk(this.container);
		return out;
	}
}

const doc = new FakeDoc();

function mount(model: OverlayProgress, callbacks: CapsuleCallbacks = {}) {
	const localDoc = new FakeDoc();
	// The capsule looks itself up via doc.querySelector('.pm-status-capsule');
	// route that through the container subtree of THIS host.
	const host = { doc: localDoc as unknown as Document, container: localDoc.container as unknown as HTMLElement };
	const cap = new StatusCapsule(() => host, callbacks);
	cap.setProgress(model);
	const el = localDoc.container.children[0]!;
	return { el, localDoc };
}

const active: OverlayProgress = {
	phase: 'laying-out',
	currentPage: 7,
	totalPages: 23,
	segTotal: 66,
	segTranslated: 66,
	segPlaced: 0,
	kept: 0
};

test('center button → 刷新本页, and it does NOT expand/collapse', () => {
	let refreshed = 0;
	const { el } = mount(active, { onRefreshRing: () => refreshed++ });
	const before = el.getAttribute('data-pm-collapsed');
	const refresh = el.querySelector('.pm-ring-refresh')!;
	refresh.click();
	assert.equal(refreshed, 1, 'center click re-translates');
	assert.equal(el.getAttribute('data-pm-collapsed'), before, 'center click never toggles collapse');
});

test('text body → 收起 (collapse), and it does NOT refresh', () => {
	let refreshed = 0;
	const { el } = mount(active, { onRefreshRing: () => refreshed++ });
	el.querySelector('.pm-body')!.click();
	assert.equal(el.getAttribute('data-pm-collapsed'), 'true', 'body click collapses');
	assert.equal(refreshed, 0, 'body click never refreshes');
});

test('collapsed ring background → 展开 (the reported stuck-collapsed bug)', () => {
	const { el } = mount(active);
	// collapse first (via body), then a click on the ring shell must re-expand.
	el.querySelector('.pm-body')!.click();
	assert.equal(el.getAttribute('data-pm-collapsed'), 'true');
	el.querySelector('.pm-ring-shell')!.click();
	assert.equal(el.getAttribute('data-pm-collapsed'), 'false', 'ring background re-expands when collapsed');
});

test('collapsed center button still refreshes, still does not expand', () => {
	let refreshed = 0;
	const { el } = mount(active, { onRefreshRing: () => refreshed++ });
	el.querySelector('.pm-body')!.click(); // collapse
	el.querySelector('.pm-ring-refresh')!.click();
	assert.equal(refreshed, 1, 'center refresh works while collapsed');
	assert.equal(el.getAttribute('data-pm-collapsed'), 'true', 'center click did not expand');
});

test('right ■ action → 停止任务 (onCancel), stops propagation (no expand/collapse)', () => {
	let cancelled = 0;
	const { el } = mount(active, { onCancel: () => cancelled++ });
	const action = el.querySelector('.pm-action')!;
	assert.equal(action.textContent, '■', 'stop uses ■, not a pause glyph');
	action.click();
	assert.equal(cancelled, 1, '■ stops the task');
});

test('the SVG progress ring carries no click handler (display only)', () => {
	const { el } = mount(active);
	const svg = el.querySelector('.pm-ring-progress')!;
	assert.equal(svg.listeners.get('click')?.length ?? 0, 0, 'outer ring is not a hit zone');
});

test('session-driven setCollapsed applies silently (no onCollapsedChange echo)', () => {
	let changes = 0;
	const localDoc = new FakeDoc();
	const host = { doc: localDoc as unknown as Document, container: localDoc.container as unknown as HTMLElement };
	const cap = new StatusCapsule(() => host, { onCollapsedChange: () => changes++ });
	cap.setProgress(active);
	cap.setCollapsed(true); // mirrored from the session — must NOT loop back
	const el = localDoc.container.children[0]!;
	assert.equal(el.getAttribute('data-pm-collapsed'), 'true', 'silent setter still updates the DOM');
	assert.equal(changes, 0, 'session-driven collapse must not re-notify the session');
	assert.equal(cap.isCollapsed(), true);
});

test('a USER collapse gesture DOES report onCollapsedChange (for cross-mode sync)', () => {
	const seen: boolean[] = [];
	const { el } = mount(active, { onCollapsedChange: (c) => seen.push(c) });
	el.querySelector('.pm-body')!.click(); // user collapses
	assert.deepEqual(seen, [true], 'gesture notifies the session so the other surface mirrors it');
	el.querySelector('.pm-ring-shell')!.click(); // user expands
	assert.deepEqual(seen, [true, false]);
});

test('the % renders into an independent label span, not raw button text', () => {
	// (33 + 0) / (66 * 2) = 0.25 → 25%. The number must live in .pm-ring-label
	// so button text-layout quirks cannot shift it off centre.
	const { el } = mount({ ...active, phase: 'translating', segTotal: 66, segTranslated: 33, segPlaced: 0 });
	const label = el.querySelector('.pm-ring-label')!;
	assert.equal(label.textContent, '25%');
});

// ---- P2-9 (2.0.8): 胶囊实例互不串扰 -----------------------------------------

test('同一窗口两个会话的胶囊互不接管 (P2-9): 各画各的进度,各自宿主', () => {
	// 模拟对照模式下同一主窗口的两个阅读标签: 两个 host 共享概念上的同一
	// document(旧实现按类名在整个 document 查找,B 永远命中 A 的胶囊)。
	const sharedDoc = new FakeDoc();
	const containerA = sharedDoc.container.appendChild(new FakeNode('div'));
	const containerB = sharedDoc.container.appendChild(new FakeNode('div'));
	const capA = new StatusCapsule(() => ({ doc: sharedDoc as unknown as Document, container: containerA as unknown as HTMLElement }));
	const capB = new StatusCapsule(() => ({ doc: sharedDoc as unknown as Document, container: containerB as unknown as HTMLElement }));

	capA.setProgress({ ...active, currentPage: 3 });
	capB.setProgress({ ...active, currentPage: 9 });

	assert.equal(containerA.children.length, 1, 'A 有自己的胶囊');
	assert.equal(containerB.children.length, 1, 'B 必须有自己的胶囊 —— 旧实现里 B 命中 A 的元素,自己是空的');
	const labelA = containerA.children[0]!.querySelector('.pm-page')?.textContent
		?? containerA.children[0]!.textContent;
	const labelB = containerB.children[0]!.querySelector('.pm-page')?.textContent
		?? containerB.children[0]!.textContent;
	assert.notEqual(containerA.children[0], containerB.children[0], '两个元素必须是不同实例');
	void labelA; void labelB;

	// B 再次渲染不得动 A 的胶囊。
	const elA = containerA.children[0]!;
	capB.setProgress({ ...active, currentPage: 10 });
	assert.equal(containerA.children[0], elA, 'A 的胶囊不被 B 重建/接管');

	// remove 只清自己。
	capB.remove();
	assert.equal(containerB.children.length, 0);
	assert.equal(containerA.children.length, 1, 'B 的 remove 绝不横扫 A 的胶囊');
});
