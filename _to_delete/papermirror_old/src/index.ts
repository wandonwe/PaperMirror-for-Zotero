/**
 * Bundle entry point. bootstrap.js loads the compiled bundle and calls
 * these lifecycle hooks.
 */

import { startup as runStartup, type StartupParams } from './lifecycle/startup';
import { addDisposer, shutdown as runShutdown } from './lifecycle/shutdown';
import { disposeAllWindows, onMainWindowLoad, onMainWindowUnload } from './lifecycle/windowManager';
import * as logger from './utils/logger';

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
