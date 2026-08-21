import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * P2-20 (2.0.5): activeReader/activeSession 曾硬绑 Zotero.getMainWindow() ——
 * 多主窗下它不保证是用户正在操作的窗口,clearCurrentCache 这类入口可能作用
 * 到另一个窗口那篇文档。现在优先选持有焦点的主窗口;无主窗口有焦点时退回
 * getMainWindow()(旧行为)。
 */

function makeWin(tabID: string, hasFocus: boolean): any {
	return {
		document: { hasFocus: () => hasFocus },
		Zotero_Tabs: { selectedID: tabID }
	};
}

async function makeController(winA: any, winB: any): Promise<any> {
	(globalThis as Record<string, any>).Zotero = {
		getMainWindow: () => winA,
		getMainWindows: () => [winA, winB]
	};
	const { ReaderToolbarController } = await import('../../src/reader/readerToolbar');
	return new ReaderToolbarController('test@local') as any;
}

test('有焦点的主窗口优先: 活动会话来自用户所在的窗口,不是 getMainWindow', async () => {
	const winA = makeWin('tab-a', false); // getMainWindow 返回它,但没有焦点
	const winB = makeWin('tab-b', true);  // 用户真正在操作的窗口
	const ctl = await makeController(winA, winB);
	const sessionA = { id: 'A' };
	const sessionB = { id: 'B' };
	ctl.sessions.set('tab-a', sessionA);
	ctl.sessions.set('tab-b', sessionB);
	assert.equal(ctl.activeSession(), sessionB, '必须解析到持焦点窗口的会话');
	delete (globalThis as Record<string, any>).Zotero;
});

test('无主窗口持有焦点 (如从设置窗口调用) → 退回 getMainWindow 旧行为', async () => {
	const winA = makeWin('tab-a', false);
	const winB = makeWin('tab-b', false);
	const ctl = await makeController(winA, winB);
	const sessionA = { id: 'A' };
	ctl.sessions.set('tab-a', sessionA);
	ctl.sessions.set('tab-b', { id: 'B' });
	assert.equal(ctl.activeSession(), sessionA);
	delete (globalThis as Record<string, any>).Zotero;
});

test('窗口枚举/焦点查询抛错不致崩溃,仍能退回 getMainWindow', async () => {
	const winA = makeWin('tab-a', false);
	const broken = { document: { hasFocus: () => { throw new Error('window torn down'); } }, Zotero_Tabs: {} };
	const ctl = await makeController(winA, broken);
	const sessionA = { id: 'A' };
	ctl.sessions.set('tab-a', sessionA);
	assert.equal(ctl.activeSession(), sessionA);
	delete (globalThis as Record<string, any>).Zotero;
});
