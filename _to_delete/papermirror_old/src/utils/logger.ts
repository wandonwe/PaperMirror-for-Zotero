/**
 * Central logger. Every message passes through the log sanitizer.
 * Debug messages are emitted only when the debugLogging pref is on.
 * Full document text / translations are never logged by default.
 */

import { sanitize } from '../security/logSanitizer';

const PREFIX = '[PaperMirror]';

let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
	debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
	return debugEnabled;
}

function emit(level: 'debug' | 'warn' | 'error', module: string, message: string, extra?: unknown): void {
	const time = new Date().toISOString();
	let line = `${PREFIX} ${time} [${module}] ${message}`;
	if (extra !== undefined) {
		line += ' :: ' + sanitize(extra);
	}
	line = sanitize(line);
	try {
		if (typeof Zotero !== 'undefined') {
			if (level === 'error') {
				Zotero.logError(line);
			}
			else {
				Zotero.debug(line, level === 'warn' ? 2 : 5);
			}
		}
	}
	catch {
		// Logging must never throw
	}
}

export function debug(module: string, message: string, extra?: unknown): void {
	if (!debugEnabled) {
		return;
	}
	emit('debug', module, message, extra);
}

export function info(module: string, message: string, extra?: unknown): void {
	emit('debug', module, message, extra);
}

export function warn(module: string, message: string, extra?: unknown): void {
	emit('warn', module, message, extra);
}

export function error(module: string, message: string, extra?: unknown): void {
	emit('error', module, message, extra);
}
