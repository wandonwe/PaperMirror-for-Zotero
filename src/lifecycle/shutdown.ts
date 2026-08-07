/**
 * Shutdown registry: every module registers a disposer; shutdown() runs them
 * all (LIFO), guaranteeing listeners/timers/requests/observers are released
 * and the reader DOM is restored without restarting Zotero.
 */

import * as logger from '../utils/logger';
import { clearSecrets } from '../security/logSanitizer';
import { disposeL10n } from '../utils/l10n';

const MODULE = 'shutdown';

type Disposer = () => void | Promise<void>;

const disposers: Disposer[] = [];

export function addDisposer(disposer: Disposer): void {
	disposers.push(disposer);
}

export async function shutdown(): Promise<void> {
	while (disposers.length) {
		const disposer = disposers.pop()!;
		try {
			await disposer();
		}
		catch (e) {
			logger.warn(MODULE, 'Disposer failed', e);
		}
	}
	disposeL10n();
	clearSecrets();
	logger.info(MODULE, 'PaperMirror shut down cleanly');
}
