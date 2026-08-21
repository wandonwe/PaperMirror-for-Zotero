import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * P2-17 (2.0.4): 多窗口场景下主窗口关闭不触发 tab close notifier —— 属于该
 * 窗口的 ReaderSession 此前整个泄漏。disposeWindow 必须:
 *  - 只销毁归属该窗口的会话(其余会话不受影响);
 *  - 连带清理 modes/lastTranslatedMode/busy 里同 key 的登记;
 *  - 归属判定失败 (getMainWindow 为 null) 的会话保守保留;
 *  - 单个会话 destroy 抛错不阻断其余会话的清理。
 */

interface FakeSession {
	getMainWindow: () => unknown;
	destroy: () => void;
	destroyed: boolean;
}

function makeSession(win: unknown, opts?: { throwOnDestroy?: boolean }): FakeSession {
	const s: FakeSession = {
		destroyed: false,
		getMainWindow: () => win,
		destroy: () => {
			if (opts?.throwOnDestroy) {
				s.destroyed = true;
				throw new Error('destroy blew up');
			}
			s.destroyed = true;
		}
	};
	return s;
}

async function makeController(): Promise<any> {
	(globalThis as Record<string, any>).Zotero = (globalThis as Record<string, any>).Zotero ?? {};
	const { ReaderToolbarController } = await import('../../src/reader/readerToolbar');
	// init() 不调用 —— disposeWindow 只依赖内部 Map,不需要 Zotero 事件系统。
	return new ReaderToolbarController('test@local') as any;
}

test('disposeWindow 只销毁归属该窗口的会话并清理全部登记', async () => {
	const ctl = await makeController();
	const winA = { name: 'A' };
	const winB = { name: 'B' };
	const sA1 = makeSession(winA);
	const sA2 = makeSession(winA);
	const sB = makeSession(winB);
	ctl.sessions.set('tab-a1', sA1);
	ctl.sessions.set('tab-a2', sA2);
	ctl.sessions.set('tab-b', sB);
	ctl.modes.set('tab-a1', 'split');
	ctl.modes.set('tab-b', 'overlay');
	ctl.lastTranslatedMode.set('tab-a1', 'split');
	ctl.busy.add('tab-a2');

	ctl.disposeWindow(winA);

	assert.equal(sA1.destroyed, true);
	assert.equal(sA2.destroyed, true);
	assert.equal(sB.destroyed, false, '别的窗口的会话不受影响');
	assert.equal(ctl.sessions.has('tab-a1'), false);
	assert.equal(ctl.sessions.has('tab-a2'), false);
	assert.equal(ctl.sessions.has('tab-b'), true);
	assert.equal(ctl.modes.has('tab-a1'), false, 'modes 登记必须连带清理');
	assert.equal(ctl.modes.get('tab-b'), 'overlay');
	assert.equal(ctl.lastTranslatedMode.has('tab-a1'), false);
	assert.equal(ctl.busy.has('tab-a2'), false);
});

test('归属判定失败的会话保守保留;destroy 抛错不阻断其余清理', async () => {
	const ctl = await makeController();
	const winA = { name: 'A' };
	const orphan = makeSession(null); // getMainWindow → null: 不能误杀
	const bad = makeSession(winA, { throwOnDestroy: true });
	const good = makeSession(winA);
	ctl.sessions.set('orphan', orphan);
	ctl.sessions.set('bad', bad);
	ctl.sessions.set('good', good);

	ctl.disposeWindow(winA);

	assert.equal(orphan.destroyed, false, '归属不明的会话不销毁');
	assert.equal(ctl.sessions.has('orphan'), true);
	assert.equal(bad.destroyed, true);
	assert.equal(ctl.sessions.has('bad'), false, '抛错的会话仍要从 Map 移除');
	assert.equal(good.destroyed, true, '前一个会话抛错不阻断后续销毁');
	assert.equal(ctl.sessions.has('good'), false);
});
