/**
 * Bundle entry point. bootstrap.js loads the compiled bundle and calls
 * these lifecycle hooks.
 */

import { startup as runStartup, toolbarController, type StartupParams } from './lifecycle/startup';
import { addDisposer, shutdown as runShutdown } from './lifecycle/shutdown';
import { disposeAllWindows, onMainWindowLoad, onMainWindowUnload } from './lifecycle/windowManager';
import { installAbortPolyfill } from './utils/abortPolyfill';
import * as logger from './utils/logger';

// The plugin sandbox has no AbortController — install the polyfill as early
// as possible (idempotent; never overwrites a native implementation).
installAbortPolyfill();

const api = {
	async startup(params: StartupParams, _reason: number): Promise<void> {
		try {
			await runStartup(params);
			addDisposer(() => disposeAllWindows());
			const win = Zotero.getMainWindow();
			if (win) {
				onMainWindowLoad(win);
			}
		}
		catch (e) {
			logger.error('index', 'startup failed', e);
			throw e;
		}
	},

	async onMainWindowLoad(window: Window): Promise<void> {
		onMainWindowLoad(window);
	},

	async onMainWindowUnload(window: Window): Promise<void> {
		// P2-17 (2.0.4): 属于该窗口的 ReaderSession 必须随窗口销毁 —— 关窗口
		// 不触发 tab close notifier,此前这些会话(定时器、in-flight 请求、
		// DOM 引用)整个泄漏。
		try {
			toolbarController?.disposeWindow(window);
		}
		catch (e) {
			logger.error('index', 'disposeWindow failed', e);
		}
		onMainWindowUnload(window);
	},

	async shutdown(_reason: number): Promise<void> {
		await runShutdown();
	}
};

// Expose on the bootstrap sandbox scope.
declare const globalThis: Record<string, unknown>;
globalThis.PaperMirrorBundle = api;

export type PaperMirrorAPI = typeof api;
