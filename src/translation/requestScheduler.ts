/**
 * Request scheduler: priority queue with a GLOBAL page-task cap, PER-LANE caps
 * (a lane = one provider), a reserved foreground slot for the visible page,
 * retry with exponential backoff, cancellation, stale-task dropping, and
 * per-lane adaptive throttling (429 → halve, timeout → −1, success → slow +1).
 * Pure module (unit-tested with injected timers).
 *
 * Lanes are why a provider POOL actually multiplies throughput: each provider's
 * pages run in their own lane up to that provider's own cap, concurrently with
 * the other lanes, instead of everything sharing one global number keyed off the
 * main provider. A job with no lane ('') is unconstrained per-lane and behaves
 * exactly as the old single-cap scheduler.
 */

import { PaperMirrorError } from '../types/models';

export interface SchedulerOptions {
	maxConcurrent: number;
	maxRetries: number;
	baseDelayMs: number;
	delayFn?: (ms: number) => Promise<void>;
	/**
	 * Global slots reserved for foreground jobs. Background jobs may occupy at
	 * most `maxConcurrent - reservedForeground` slots at once, so at least this
	 * many are ALWAYS free for a foreground (current-page) job. Default 0.
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
	/** The provider lane this job belongs to; '' = no per-lane constraint. */
	lane: string;
	/** Per-job retry ceiling; falls back to the scheduler-wide maxRetries. */
	maxRetries?: number;
}

export class RequestScheduler {
	private options: SchedulerOptions;
	private reservedForeground: number;
	private queue: Job<unknown>[] = [];
	private active = new Map<string, Job<unknown>>();
	private delayFn: (ms: number) => Promise<void>;
	private disposed = false;
	/** Adaptive floor per lane (429/timeout can drop no lower). */
	private laneCapMin = new Map<string, number>();
	/** Configured per-lane page cap ceiling (sustained success grows toward it). */
	private laneCapMax = new Map<string, number>();
	/** Current per-lane cap, after adaptive throttling. */
	private laneCapCur = new Map<string, number>();
	/** Consecutive successes per lane, for slow recovery. */
	private laneSuccess = new Map<string, number>();
	/** The lane that owns the visible page — it keeps one slot for foreground. */
	private foregroundLane: string | null = null;

	constructor(options?: Partial<SchedulerOptions>) {
		this.options = {
			maxConcurrent: options?.maxConcurrent ?? 2,
			maxRetries: options?.maxRetries ?? 3,
			baseDelayMs: options?.baseDelayMs ?? 1000,
			delayFn: options?.delayFn,
			reservedForeground: options?.reservedForeground ?? 0
		};
		this.reservedForeground = this.clampReserve(this.options.reservedForeground ?? 0);
		this.delayFn = this.options.delayFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	}

	private clampReserve(n: number): number {
		return Math.max(0, Math.min(n, this.options.maxConcurrent - 1));
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	get activeCount(): number {
		return this.active.size;
	}

	/** Live per-lane cap (after adaptive throttling), for tests/telemetry. */
	laneCap(lane: string): number {
		return this.laneCapCur.get(lane) ?? Infinity;
	}

	isScheduled(key: string): boolean {
		return this.active.has(key) || this.queue.some(job => job.key === key);
	}

	/** True only when the job is WAITING in the queue (not yet running). */
	isQueued(key: string): boolean {
		return this.queue.some(job => job.key === key);
	}

	/** Set the GLOBAL concurrent page-task cap. */
	setGlobalMax(n: number): void {
		this.options.maxConcurrent = Math.max(1, Math.floor(n));
		this.reservedForeground = this.clampReserve(this.reservedForeground);
		this.pump();
	}

	/**
	 * Configure per-lane (per-provider) page caps. Each lane may be a fixed number
	 * (min=1, initial=max=n) or a BAND {min, initial, max} — auto mode uses a band
	 * so sustained success grows the lane from `initial` toward `max` while a 429
	 * drops it toward `min`. Lanes not listed are unconstrained.
	 */
	configureLanes(caps: Record<string, number | { min: number; initial: number; max: number }>): void {
		this.laneCapMin.clear();
		this.laneCapMax.clear();
		this.laneCapCur.clear();
		this.laneSuccess.clear();
		for (const [lane, spec] of Object.entries(caps)) {
			const band = typeof spec === 'number' ? { min: 1, initial: spec, max: spec } : spec;
			const max = Math.max(1, Math.floor(band.max));
			const min = Math.max(1, Math.min(Math.floor(band.min), max));
			const initial = Math.max(min, Math.min(Math.floor(band.initial), max));
			this.laneCapMin.set(lane, min);
			this.laneCapMax.set(lane, max);
			this.laneCapCur.set(lane, initial);
		}
		this.pump();
	}

	/** The lane of the visible page keeps one slot free for its foreground job. */
	setForegroundLane(lane: string | null): void {
		this.foregroundLane = lane;
		this.pump();
	}

	/**
	 * Raise a still-queued job's priority (and optionally mark it foreground),
	 * then re-sort and re-pump. This is how a page enqueued as a low-priority
	 * background prefetch becomes the high-priority foreground current page the
	 * instant the reader navigates to it. No-op if already started/never queued.
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
	enqueue<T>(key: string, priority: number, run: (signal: AbortSignal) => Promise<T>, opts?: { foreground?: boolean; lane?: string; maxRetries?: number }): Promise<T> {
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
				foreground: opts?.foreground ?? false,
				lane: opts?.lane ?? '',
				maxRetries: opts?.maxRetries
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

	private laneCapOf(lane: string): number {
		return this.laneCapCur.get(lane) ?? Infinity;
	}

	private activeInLane(lane: string): number {
		let n = 0;
		for (const job of this.active.values()) {
			if (job.lane === lane) {
				n++;
			}
		}
		return n;
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

	private pump(): void {
		if (this.disposed) {
			return;
		}
		const bgGlobalCap = this.options.maxConcurrent - this.reservedForeground;
		// Scan the priority-sorted queue and start every ELIGIBLE job. Ineligible
		// jobs are SKIPPED (not removed) so a lower-priority job on a lane that
		// DOES have room can still start — this is what lets other providers'
		// pages run while the current page's lane is busy. Freed slots re-pump.
		let i = 0;
		while (i < this.queue.length && this.active.size < this.options.maxConcurrent) {
			const job = this.queue[i]!;
			if (!this.canStart(job)) {
				i++;
				continue;
			}
			this.queue.splice(i, 1);
			this.active.set(job.key, job);
			void this.execute(job);
			// A slot/lane was consumed; re-scan from the top (do not advance i).
		}
	}

	private canStart(job: Job<unknown>): boolean {
		// Per-lane cap.
		const laneActive = this.activeInLane(job.lane);
		if (laneActive >= this.laneCapOf(job.lane)) {
			return false;
		}
		if (!job.foreground) {
			// Global background reserve — keep foreground slots free.
			if (this.countActiveBackground() >= bgOr(this.options.maxConcurrent - this.reservedForeground)) {
				return false;
			}
			// Per-lane foreground reserve: the visible page's lane keeps ONE slot
			// free so the current page can always start, even amid same-lane
			// prefetch. Only applies when the lane has a finite cap.
			if (job.lane && job.lane === this.foregroundLane) {
				const cap = this.laneCapOf(job.lane);
				if (Number.isFinite(cap) && laneActive >= cap - 1) {
					return false;
				}
			}
		}
		return true;
	}

	// --- per-lane adaptive throttling ---------------------------------------

	private penalizeLane(lane: string, kind: 'rate' | 'timeout'): void {
		if (!lane || !this.laneCapMax.has(lane)) {
			return;
		}
		const cur = this.laneCapCur.get(lane) ?? this.laneCapMax.get(lane)!;
		const floor = this.laneCapMin.get(lane) ?? 1;
		const next = kind === 'rate' ? Math.floor(cur / 2) : cur - 1;
		this.laneCapCur.set(lane, Math.max(floor, next));
		this.laneSuccess.set(lane, 0);
	}

	private rewardLane(lane: string): void {
		if (!lane || !this.laneCapMax.has(lane)) {
			return;
		}
		const max = this.laneCapMax.get(lane)!;
		const cur = this.laneCapCur.get(lane) ?? max;
		if (cur >= max) {
			return;
		}
		// Recover one slot only after a run of clean successes, so we don't
		// immediately re-provoke the limit we just backed off from.
		const streak = (this.laneSuccess.get(lane) ?? 0) + 1;
		if (streak >= 5) {
			this.laneCapCur.set(lane, Math.min(max, cur + 1));
			this.laneSuccess.set(lane, 0);
		}
		else {
			this.laneSuccess.set(lane, streak);
		}
	}

	private async execute(job: Job<unknown>): Promise<void> {
		try {
			for (;;) {
				job.attempts++;
				try {
					const result = await job.run(job.controller.signal);
					this.rewardLane(job.lane);
					job.resolve(result);
					return;
				}
				catch (e) {
					const error = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
					const cancelled = job.controller.signal.aborted || error.code === 'CANCELLED';
					// Adaptive: only the erroring lane is throttled, never the pool.
					if (!cancelled) {
						if (error.code === 'RATE_LIMITED') {
							this.penalizeLane(job.lane, 'rate');
						}
						else if (error.code === 'TIMEOUT') {
							this.penalizeLane(job.lane, 'timeout');
						}
					}
					const retryCap = job.maxRetries ?? this.options.maxRetries;
					if (cancelled || !error.retryable || job.attempts > retryCap) {
						job.reject(cancelled ? new PaperMirrorError('CANCELLED', 'Translation was cancelled.') : error);
						return;
					}
					// Honour Retry-After when the error carries one; else exponential
					// backoff with jitter: base * 2^(attempt-1).
					const retryAfter = (error as PaperMirrorError & { retryAfterMs?: number }).retryAfterMs;
					const delay = typeof retryAfter === 'number' && retryAfter > 0
						? retryAfter
						: this.options.baseDelayMs * Math.pow(2, job.attempts - 1) * (0.75 + Math.random() * 0.5);
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

/** Guard: a background cap can never drop below 1 or nothing ever prefetches. */
function bgOr(n: number): number {
	return Math.max(1, n);
}
