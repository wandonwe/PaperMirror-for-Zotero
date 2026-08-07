/**
 * Main-window lifecycle: injects/removes per-window artifacts (the shared
 * stylesheet) when Zotero main windows open and close.
 */

import { ensureStyleInjected, removeInjectedStyle } from '../reader/splitView';
import * as logger from '../utils/logger';

const MODULE = 'windowManager';

const knownWindows = new Set<Window>();

export function onMainWindowLoad(window: Window): void {
	try {
		knownWindows.add(window);
		ensureStyleInjected(window.document);
	}
	catch (e) {
		logger.warn(MODULE, 'onMainWindowLoad failed', e);
	}
}

export function onMainWindowUnload(window: Window): void {
	knownWindows.delete(window);
}

export function disposeAllWindows(): void {
	for (const window of knownWindows) {
		try {
			removeInjectedStyle(window.document);
		}
		catch {
			// window may be gone
		}
	}
	knownWindows.clear();
	// Also clean the current main window if it never went through load hook
	const win = Zotero.getMainWindow();
	if (win) {
		try {
			removeInjectedStyle(win.document);
		}
		catch {
			// ignore
		}
	}
}
