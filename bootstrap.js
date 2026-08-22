/**
 * PaperMirror for Zotero — bootstrap entry.
 *
 * Zotero 9/10 load this file into a per-plugin sandbox that already provides
 * `Zotero`, `Services`, `ChromeUtils`, `IOUtils`, `PathUtils`, `setTimeout`,
 * `fetch`, etc. (see zotero/zotero chrome/content/zotero/xpcom/plugins.js).
 *
 * The real implementation lives in content/index.js (an esbuild bundle of the
 * TypeScript sources). This file only wires lifecycle hooks to the bundle so
 * that all logic is testable and type-checked.
 */

/* global Zotero, Services */

var PaperMirror = null;

function _log(msg) {
	if (typeof Zotero !== 'undefined') {
		Zotero.debug('[PaperMirror bootstrap] ' + msg);
	}
}

function install(_data, _reason) {}

async function startup({ id, version, rootURI }, reason) {
	try {
		// Load the bundle into this sandbox. The bundle assigns the plugin
		// object to `PaperMirror` on the load target (this scope).
		Services.scriptloader.loadSubScript(rootURI + 'content/index.js', this);
		PaperMirror = this.PaperMirrorBundle;
		if (!PaperMirror) {
			throw new Error('content/index.js did not export PaperMirrorBundle');
		}
		await PaperMirror.startup({ id, version, rootURI }, reason);
	}
	catch (e) {
		_log('startup failed: ' + (e && e.message ? e.message + '\n' + e.stack : e));
		throw e;
	}
}

async function onMainWindowLoad({ window }, _reason) {
	try {
		if (PaperMirror) {
			await PaperMirror.onMainWindowLoad(window);
		}
	}
	catch (e) {
		_log('onMainWindowLoad failed: ' + e);
	}
}

async function onMainWindowUnload({ window }, _reason) {
	try {
		if (PaperMirror) {
			await PaperMirror.onMainWindowUnload(window);
		}
	}
	catch (e) {
		_log('onMainWindowUnload failed: ' + e);
	}
}

async function shutdown(_data, reason) {
	try {
		if (PaperMirror) {
			await PaperMirror.shutdown(reason);
		}
	}
	catch (e) {
		_log('shutdown failed: ' + e);
	}
	finally {
		PaperMirror = null;
	}
}

// 卸载清理 (2.1.1, 审核 P3-C): 插件被**卸载**时清掉会外流/驻留的隐私残留 ——
// 明文回退密钥、系统凭据库里的 API Key、以及缓存目录里的整篇论文译文。
//
// 只在 reason === ADDON_UNINSTALL(6)时执行 —— 停用(4)、升级(7)、降级(8)、
// 应用退出(2)都**不**清,否则升级会误删用户密钥与缓存。宁可漏清(残留)也
// 绝不误清(毁数据),故判定从严;拿不准的 reason 直接返回。
//
// 全程重度 try/catch: 清理的任何失败都不得中断卸载。同步项(prefs、Login
// Manager)先做,保证即使异步被打断也已落地;缓存目录异步删最后。
var ADDON_UNINSTALL = 6;

function _cleanupPrefsAndLogins() {
	// 明文回退密钥 + 其余全部本插件 pref: 删整个 branch(含 apiKeyFallback)。
	try {
		if (typeof Services !== 'undefined' && Services.prefs) {
			Services.prefs.getBranch('extensions.zotero.bilingualReader.').deleteBranch('');
		}
	}
	catch (e) {
		_log('uninstall: pref cleanup failed: ' + e);
	}
	// 系统凭据库里的 API Key(origin=chrome://zotero-bilingual-reader)。
	try {
		if (typeof Services !== 'undefined' && Services.logins) {
			var ORIGIN = 'chrome://zotero-bilingual-reader';
			var all = Services.logins.getAllLogins();
			for (var i = 0; i < all.length; i++) {
				if (all[i] && all[i].origin === ORIGIN) {
					try { Services.logins.removeLogin(all[i]); }
					catch (inner) { _log('uninstall: removeLogin failed: ' + inner); }
				}
			}
		}
	}
	catch (e) {
		_log('uninstall: login cleanup failed: ' + e);
	}
}

async function _cleanupCacheDir() {
	try {
		if (typeof Zotero !== 'undefined' && Zotero.DataDirectory && typeof IOUtils !== 'undefined') {
			var dir = PathUtils.join(Zotero.DataDirectory.dir, 'bilingual-reader');
			await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
		}
	}
	catch (e) {
		_log('uninstall: cache cleanup failed: ' + e);
	}
}

function uninstall(_data, reason) {
	try {
		if (reason !== ADDON_UNINSTALL) {
			return;
		}
		_cleanupPrefsAndLogins();
		void _cleanupCacheDir();
	}
	catch (e) {
		_log('uninstall cleanup failed: ' + e);
	}
}
