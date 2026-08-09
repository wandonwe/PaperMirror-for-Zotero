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
	/**
	 * Slots reserved for foreground jobs. Background jobs may occupy at most
	 * `maxConcurrent - reservedForeground` slots at once, so at least this many
	 * slots are ALWAYS free for a foreground job (the current visible page) to
	 * start immediately — background prefetch can never fill every slot and make
	 * the page the reader is looking at wait. Default 0 = no reservation (every
	 * job competes purely on priority, the original behaviour).
	 */
	reservedForeground?: number;
}

interface Job<T> {
	key: string;
	priority: number;
	run: (signal: AbortSignal) => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	controller: AbortController;
	attempts: number;
	/** Foreground jobs (current page) may use reserved slots; background can't. */
	foreground: boolean;
}

export class RequestScheduler {
	private options: SchedulerOptions;
	private reservedForeground: number;
	private queue: Job<unknown>[] = [];
	private active = new Map<string, Job<unknown>>();
	private delayFn: (ms: number) => Promise<void>;
	private disposed = false;

	constructor(options?: Partial<SchedulerOptions>) {
		this.options = {
			maxConcurrent: options?.maxConcurrent ?? 2,
			maxRetries: options?.maxRetries ?? 3,
			baseDelayMs: options?.baseDelayMs ?? 1000,
			delayFn: options?.delayFn,
			reservedForeground: options?.reservedForeground ?? 0
		};
		// Never reserve so much that background can never run, nor more than exist.
		this.reservedForeground = Math.max(0, Math.min(this.options.reservedForeground ?? 0, this.options.maxConcurrent - 1));
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

	/** True only when the job is WAITING in the queue (not yet running). */
	isQueued(key: string): boolean {
		return this.queue.some(job => job.key === key);
	}

	/**
	 * Raise a still-queued job's priority (and optionally mark it foreground),
	 * then re-sort and re-pump. This is how a page that was enqueued as a
	 * low-priority background prefetch becomes the high-priority foreground
	 * current page the instant the reader navigates to it — WITHOUT a duplicate
	 * enqueue (which would reject) and without waiting for it to reach the head
	 * on its own. No-op if the job already started or was never queued.
	 */
	promote(key: string, priority: number, foreground?: boolean): void {
		const job = this.queue.find(j => j.key === key);
		if (!job) {
			return;
		}
		job.priority = Math.max(job.priority, priority);
		if (foreground) {
			job.foreground = true;
		}
		this.queue.sort((a, b) => b.priority - a.priority);
		this.pump();
	}

	/**
	 * Enqueue a job. If a job with the same key is already queued or running,
	 * the existing promise semantics are preserved by rejecting the duplicate.
	 */
	enqueue<T>(key: string, priority: number, run: (signal: AbortSignal) => Promise<T>, opts?: { foreground?: boolean }): Promise<T> {
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
				attempts: 0,
				foreground: opts?.foreground ?? false
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
		if (this.disposed) {
			return;
		}
		// Background jobs may occupy at most this many slots, leaving the rest
		// always free for a foreground (current-page) job.
		const bgCap = this.options.maxConcurrent - this.reservedForeground;
		// Scan the priority-sorted queue and start every ELIGIBLE job. A
		// background job is skipped (not removed) while background is at its cap,
		// so a lower-priority foreground job behind it can still start into a
		// reserved slot. Freed slots re-pump from the top when a job finishes.
		let i = 0;
		while (i < this.queue.length && this.active.size < this.options.maxConcurrent) {
			const job = this.queue[i]!;
			if (!job.foreground && this.countActiveBackground() >= bgCap) {
				i++; // background is full → leave this one queued, look further down
				continue;
			}
			this.queue.splice(i, 1);
			this.active.set(job.key, job);
			void this.execute(job);
			// A slot was consumed; re-scan from the top (do not advance i).
		}
	}

	private countActiveBackground(): number {
		let n = 0;
		for (const job of this.active.values()) {
			if (!job.foreground) {
				n++;
			}
		}
		return n;
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
