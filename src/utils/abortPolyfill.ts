/**
 * AbortController polyfill for the Zotero plugin sandbox.
 *
 * Zotero 9's plugin sandbox (chrome/content/zotero/xpcom/plugins.js,
 * wantGlobalProperties) exposes fetch/XMLHttpRequest/Blob/… but NOT
 * AbortController/AbortSignal. Our cancellation plumbing only needs the
 * cooperative subset (aborted flag + 'abort' event), and the HTTP layer uses
 * XMLHttpRequest (not fetch), so a small pure-JS implementation is fully
 * sufficient — it never has to be a "real" DOM AbortSignal.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

class PMAbortSignal {
	aborted = false;
	reason: unknown = undefined;
	onabort: ((event: unknown) => void) | null = null;
	private listeners = new Set<(event: unknown) => void>();

	addEventListener(type: string, listener: (event: unknown) => void, _options?: unknown): void {
		if (type === 'abort') {
			this.listeners.add(listener);
		}
	}

	removeEventListener(type: string, listener: (event: unknown) => void, _options?: unknown): void {
		if (type === 'abort') {
			this.listeners.delete(listener);
		}
	}

	throwIfAborted(): void {
		if (this.aborted) {
			throw this.reason ?? new Error('The operation was aborted');
		}
	}

	/** @internal */
	_fire(reason: unknown): void {
		if (this.aborted) {
			return;
		}
		this.aborted = true;
		this.reason = reason ?? new Error('The operation was aborted');
		const event = { type: 'abort', target: this };
		try {
			this.onabort?.(event);
		}
		catch {
			// listener errors must not break abort
		}
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			}
			catch {
				// ignore
			}
		}
		this.listeners.clear();
	}
}

class PMAbortController {
	signal = new PMAbortSignal();

	abort(reason?: unknown): void {
		this.signal._fire(reason);
	}
}

/**
 * Install the polyfill into the current global scope when the platform does
 * not provide AbortController. Idempotent; a native implementation is never
 * overwritten.
 */
export function installAbortPolyfill(): void {
	const g = globalThis as any;
	if (typeof g.AbortController === 'undefined') {
		g.AbortController = PMAbortController;
		g.AbortSignal = PMAbortSignal;
	}
}

export { PMAbortController, PMAbortSignal };
