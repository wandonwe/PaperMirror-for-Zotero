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

function uninstall(_data, _reason) {}
