/**
 * Shutdown registry: every module registers a disposer; shutdown() runs them
 * all (LIFO), guaranteeing listeners/timers/requests/observers are released
 * and the reader DOM is restored without restarting Zotero.
 */

import * as logger from '../utils/logger';
import { clearSecrets } from '../security/logSanitizer';
import { clearKeyCache } from '../security/credentialStore';
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
	// 明文密钥缓存一并清 (2.1.1, 审核 P3-B): clearSecrets 只清 logSanitizer 的
	// 已知密钥集,凭据库的会话缓存(keyCache)另在 credentialStore,不清则明文
	// 密钥会残留到停用/卸载后(未重启 Zotero 时)。
	clearKeyCache();
	logger.info(MODULE, 'PaperMirror shut down cleanly');
}
