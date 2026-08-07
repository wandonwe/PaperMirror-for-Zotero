/**
 * Request scheduler: max-2 concurrency, retry with exponential backoff,
 * cancellation, and stale-task dropping. Pure module (unit-tested with
 * injected timers).
 */

import { PaperMirrorError } from '../types/models';

export interface SchedulerOptions {
	maxConcurrent: number;
	maxRetries: number;
	baseDelayMs: number;
	delayFn?: (ms: number) => Promise<void>;
}

interface Job<T> {
	key: string;
	priority: number;
	run: (signal: AbortSignal) => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	controller: AbortController;
	attempts: number;
}

export class RequestScheduler {
	private options: SchedulerOptions;
	private queue: Job<unknown>[] = [];
	private active = new Map<string, Job<unknown>>();
	private delayFn: (ms: number) => Promise<void>;
	private disposed = false;

	constructor(options?: Partial<SchedulerOptions>) {
		this.options = {
			maxConcurrent: options?.maxConcurrent ?? 2,
			maxRetries: options?.maxRetries ?? 3,
			baseDelayMs: options?.baseDelayMs ?? 1000,
			delayFn: options?.delayFn
		};
		this.delayFn = this.options.delayFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	get activeCount(): number {
		return this.active.size;
	}

	isScheduled(key: string): boolean {
		return this.active.has(key) || this.queue.some(job => job.key === key);
	}

	/**
	 * Enqueue a job. If a job with the same key is already queued or running,
	 * the existing promise semantics are preserved by rejecting the duplicate.
	 */
	enqueue<T>(key: string, priority: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.disposed) {
			return Promise.reject(new PaperMirrorError('CANCELLED', 'Scheduler disposed.'));
		}
		if (this.isScheduled(key)) {
			return Promise.reject(new PaperMirrorError('CANCELLED', `Duplicate job: ${key}`, { retryable: false }));
		}
		return new Promise<T>((resolve, reject) => {
			const job: Job<T> = {
				key,
				priority,
				run,
				resolve,
				reject,
				controller: new AbortController(),
				attempts: 0
			};
			this.queue.push(job as Job<unknown>);
			this.queue.sort((a, b) => b.priority - a.priority);
			this.pump();
		});
	}

	/** Cancel a queued or running job. */
	cancel(key: string): void {
		const queued = this.queue.findIndex(job => job.key === key);
		if (queued !== -1) {
			const [job] = this.queue.splice(queued, 1);
			job!.reject(new PaperMirrorError('CANCELLED', 'Translation was cancelled.'));
			return;
		}
		const activeJob = this.active.get(key);
		if (activeJob) {
			activeJob.controller.abort();
		}
	}

	/** Cancel queued jobs not in the keep-set (fast page flipping). */
	cancelExcept(keep: Set<string>): void {
		const stale = this.queue.filter(job => !keep.has(job.key));
		this.queue = this.queue.filter(job => keep.has(job.key));
		for (const job of stale) {
			job.reject(new PaperMirrorError('CANCELLED', 'Superseded by navigation.'));
		}
		for (const [key, job] of this.active) {
			if (!keep.has(key)) {
				job.controller.abort();
			}
		}
	}

	cancelAll(): void {
		const queued = this.queue.splice(0);
		for (const job of queued) {
			job.reject(new PaperMirrorError('CANCELLED', 'Translation was cancelled.'));
		}
		for (const job of this.active.values()) {
			job.controller.abort();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.cancelAll();
	}

	private pump(): void {
		while (!this.disposed && this.active.size < this.options.maxConcurrent && this.queue.length) {
			const job = this.queue.shift()!;
			this.active.set(job.key, job);
			void this.execute(job);
		}
	}

	private async execute(job: Job<unknown>): Promise<void> {
		try {
			for (;;) {
				job.attempts++;
				try {
					const result = await job.run(job.controller.signal);
					job.resolve(result);
					return;
				}
				catch (e) {
					const error = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
					const cancelled = job.controller.signal.aborted || error.code === 'CANCELLED';
					if (cancelled || !error.retryable || job.attempts > this.options.maxRetries) {
						job.reject(cancelled ? new PaperMirrorError('CANCELLED', 'Translation was cancelled.') : error);
						return;
					}
					// Exponential backoff with jitter: base * 2^(attempt-1)
					const delay = this.options.baseDelayMs * Math.pow(2, job.attempts - 1)
						* (0.75 + Math.random() * 0.5);
					await this.delayFn(delay);
					if (job.controller.signal.aborted || this.disposed) {
						job.reject(new PaperMirrorError('CANCELLED', 'Translation was cancelled.'));
						return;
					}
				}
			}
		}
		finally {
			this.active.delete(job.key);
			this.pump();
		}
	}
}
