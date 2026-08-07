/**
 * Central logger. Every message passes through the log sanitizer.
 * Debug messages are emitted only when the debugLogging pref is on.
 * Full document text / translations are never logged by default.
 */

import { sanitize } from '../security/logSanitizer';

const PREFIX = '[PaperMirror]';

let debugEnabled = false;

/**
 * Ring buffer of the last warnings and errors, with stacks.
 *
 * A failure inside the reader session used to leave nothing behind but a
 * vanished pane: Zotero's own log needs debug output enabled ahead of time,
 * which nobody has when the thing first goes wrong. These survive in memory
 * and are readable at any moment via
 *     Zotero.PaperMirror.lastErrors()
 * in Tools → Developer → Run JavaScript.
 */
const RECENT_LIMIT = 40;
const recent: string[] = [];

function remember(level: string, module: string, message: string, extra?: unknown): void {
	try {
		let line = `${new Date().toISOString()} ${level.toUpperCase()} [${module}] ${message}`;
		if (extra !== undefined) {
			const stack = (extra as { stack?: string })?.stack;
			line += ' :: ' + sanitize(stack ? String(stack) : extra);
		}
		recent.push(sanitize(line));
		if (recent.length > RECENT_LIMIT) {
			recent.shift();
		}
	}
	catch {
		// diagnostics must never throw
	}
}

/** Newest last. Safe to show the user: everything here is sanitized. */
export function recentProblems(): string[] {
	return [...recent];
}

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
	remember('warn', module, message, extra);
	emit('warn', module, message, extra);
}

export function error(module: string, message: string, extra?: unknown): void {
	remember('error', module, message, extra);
	emit('error', module, message, extra);
}
