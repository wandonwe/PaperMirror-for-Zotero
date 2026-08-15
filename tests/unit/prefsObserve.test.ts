import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeBoolPref } from '../../src/utils/prefs';

// 1.1.10:「诊断」按钮的显隐契约 —— 用一个最小 Zotero.Prefs 桩验证
// observeBoolPref 的三件事: 初始按当前偏好、变化时回调、清理时反注册。

type Handler = (value: unknown) => void;

function installFakePrefs(initial: boolean) {
	const NS = 'bilingualReader.';
	const store: Record<string, unknown> = { [NS + 'debugLogging']: initial };
	const observers = new Map<symbol, { key: string; handler: Handler }>();
	(globalThis as Record<string, any>).Zotero = {
		Prefs: {
			get: (k: string) => store[k],
			set: (k: string, v: unknown) => { store[k] = v; },
			registerObserver: (k: string, handler: Handler) => {
				const id = Symbol('obs');
				observers.set(id, { key: k, handler });
				return id;
			},
			unregisterObserver: (id: symbol) => { observers.delete(id); }
		}
	};
	return {
		observerCount: () => observers.size,
		// simulate a pref flip: update store + fire observers on that key
		flip: (v: boolean) => {
			store[NS + 'debugLogging'] = v;
			for (const { key, handler } of observers.values()) {
				if (key === NS + 'debugLogging') handler(v);
			}
		},
		teardown: () => { delete (globalThis as Record<string, any>).Zotero; }
	};
}

test('observeBoolPref: 初始按当前偏好调用一次', () => {
	const onFalse = installFakePrefs(false);
	const seen: boolean[] = [];
	const stop = observeBoolPref('debugLogging', on => seen.push(on));
	assert.deepEqual(seen, [false], '调试关 → 初始隐藏');
	stop(); onFalse.teardown();

	const onTrue = installFakePrefs(true);
	const seen2: boolean[] = [];
	const stop2 = observeBoolPref('debugLogging', on => seen2.push(on));
	assert.deepEqual(seen2, [true], '调试开 → 初始显示');
	stop2(); onTrue.teardown();
});

test('observeBoolPref: 偏好翻转时实时回调 (按钮随开关显隐)', () => {
	const p = installFakePrefs(false);
	const seen: boolean[] = [];
	const stop = observeBoolPref('debugLogging', on => seen.push(on));
	p.flip(true);
	p.flip(false);
	assert.deepEqual(seen, [false, true, false], '初始 + 两次翻转都到达');
	stop(); p.teardown();
});

test('observeBoolPref: 清理后反注册, 之后的翻转不再回调', () => {
	const p = installFakePrefs(true);
	const seen: boolean[] = [];
	const stop = observeBoolPref('debugLogging', on => seen.push(on));
	assert.equal(p.observerCount(), 1, '注册了一个观察者');
	stop();
	assert.equal(p.observerCount(), 0, '清理后观察者已反注册');
	p.flip(false); // 已清理 —— 不该再有回调
	assert.deepEqual(seen, [true], '清理后不再收到回调');
	p.teardown();
});

test('observeBoolPref: registerObserver 抛错时降级为一次性读取, 不冒泡', () => {
	(globalThis as Record<string, any>).Zotero = {
		Prefs: {
			get: () => true,
			registerObserver: () => { throw new Error('no observer API'); },
			unregisterObserver: () => {}
		}
	};
	const seen: boolean[] = [];
	let stop: () => void = () => {};
	assert.doesNotThrow(() => { stop = observeBoolPref('debugLogging', on => seen.push(on)); });
	assert.deepEqual(seen, [true], '至少初始读取生效');
	assert.doesNotThrow(() => stop(), '清理在无观察者时也安全');
	delete (globalThis as Record<string, any>).Zotero;
});
