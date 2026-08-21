import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flashKeptIndicator } from '../../src/ui/strictPageReplacement';

/**
 * P2-19 (2.0.5): 「查看保留原文」曾直接给 `visibility:hidden` 的译文 div
 * 描边/加动画类 —— 隐藏节点连 outline 带背景一起不可见,用户什么也看不到;
 * 函数还返回 true 屏蔽了回退路径。flashKeptIndicator 改为按被指示节点的
 * 几何画一个**独立的可见标记层**,无法定位时返回 null 让调用方走回退。
 */

interface FakeEl {
	tag: string;
	className: string;
	style: Record<string, string>;
	children: FakeEl[];
	parentElement: FakeEl | null;
	offsetParent: FakeEl | null;
	offsetLeft: number;
	offsetTop: number;
	offsetWidth: number;
	offsetHeight: number;
	isConnected: boolean;
	ownerDocument: any;
	appendChild(child: FakeEl): void;
	remove(): void;
}

function makeDoc(): { doc: any; makeEl: (tag: string) => FakeEl } {
	const doc: any = {};
	const makeEl = (tag: string): FakeEl => {
		const el: FakeEl = {
			tag, className: '', style: {}, children: [],
			parentElement: null, offsetParent: null,
			offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0,
			isConnected: true, ownerDocument: doc,
			appendChild(child: FakeEl) {
				this.children.push(child);
				child.parentElement = this;
			},
			remove() {
				const p = this.parentElement;
				if (p) {
					p.children.splice(p.children.indexOf(this), 1);
					this.parentElement = null;
				}
			}
		};
		return el;
	};
	doc.createElementNS = (_ns: string, tag: string) => makeEl(tag);
	doc.defaultView = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };
	return { doc, makeEl };
}

function makeHiddenUnfitNode(): { node: FakeEl; host: FakeEl } {
	const { makeEl } = makeDoc();
	const host = makeEl('div');
	const node = makeEl('div');
	host.appendChild(node);
	node.offsetParent = host;
	node.offsetLeft = 40; node.offsetTop = 300;
	node.offsetWidth = 220; node.offsetHeight = 36;
	node.style['visibility'] = 'hidden'; // 保留原文块的真实状态
	return { node, host };
}

test('隐藏的 unfit 节点 → 在宿主里画出同几何的独立可见标记', () => {
	const { node, host } = makeHiddenUnfitNode();
	const marker = flashKeptIndicator(node as unknown as HTMLElement, 30);
	assert.ok(marker, '必须画出标记');
	const m = marker as unknown as FakeEl;
	assert.notEqual(m, node as unknown, '标记是独立元素,不是隐藏节点本身');
	assert.equal(m.parentElement, host, '标记挂在 offsetParent 里');
	assert.equal(m.style['left'], '40px');
	assert.equal(m.style['top'], '300px');
	assert.equal(m.style['width'], '220px');
	assert.equal(m.style['height'], '36px');
	assert.equal(m.style['visibility'] ?? '', '', '标记自身不得继承 hidden');
	assert.ok(m.style['outline']!.includes('solid'), '有可见描边');
	assert.ok(m.style['background'], '有可见底色');
	assert.equal(m.style['pointer-events'] ?? m.style['pointerEvents'], 'none', '不拦截阅读器交互');
});

test('标记限时自动移除', async () => {
	const { node, host } = makeHiddenUnfitNode();
	flashKeptIndicator(node as unknown as HTMLElement, 20);
	assert.equal(host.children.length, 2, 'flash 期间标记在场');
	await new Promise(r => setTimeout(r, 60));
	assert.equal(host.children.length, 1, '到时必须移除,不留常驻遮挡');
});

test('无法定位 (节点已脱离文档/无宿主) → 返回 null 供调用方走回退路径', () => {
	const { node } = makeHiddenUnfitNode();
	node.isConnected = false;
	assert.equal(flashKeptIndicator(node as unknown as HTMLElement, 20), null);
	const orphan = makeDoc().makeEl('div'); // 无 parent、无 offsetParent
	assert.equal(flashKeptIndicator(orphan as unknown as HTMLElement, 20), null);
});
