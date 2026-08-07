/**
 * Throttle/debounce helpers with cancellation support. Pure module.
 */

export interface Cancellable {
	cancel(): void;
}

export function debounce<A extends unknown[]>(
	fn: (...args: A) => void,
	delayMs: number,
	setTimeoutImpl: typeof setTimeout = setTimeout,
	clearTimeoutImpl: typeof clearTimeout = clearTimeout
): ((...args: A) => void) & Cancellable {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const wrapped = (...args: A): void => {
		if (timer !== null) {
			clearTimeoutImpl(timer);
		}
		timer = setTimeoutImpl(() => {
			timer = null;
			fn(...args);
		}, delayMs);
	};
	wrapped.cancel = () => {
		if (timer !== null) {
			clearTimeoutImpl(timer);
			timer = null;
		}
	};
	return wrapped;
}

export function throttle<A extends unknown[]>(
	fn: (...args: A) => void,
	waitMs: number,
	now: () => number = () => Date.now(),
	setTimeoutImpl: typeof setTimeout = setTimeout,
	clearTimeoutImpl: typeof clearTimeout = clearTimeout
): ((...args: A) => void) & Cancellable {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingArgs: A | null = null;
	const invoke = (): void => {
		last = now();
		timer = null;
		if (pendingArgs) {
			const args = pendingArgs;
			pendingArgs = null;
			fn(...args);
		}
	};
	const wrapped = (...args: A): void => {
		pendingArgs = args;
		const elapsed = now() - last;
		if (elapsed >= waitMs && timer === null) {
			invoke();
		}
		else if (timer === null) {
			timer = setTimeoutImpl(invoke, Math.max(0, waitMs - elapsed));
		}
	};
	wrapped.cancel = () => {
		if (timer !== null) {
			clearTimeoutImpl(timer);
			timer = null;
		}
		pendingArgs = null;
	};
	return wrapped;
}
