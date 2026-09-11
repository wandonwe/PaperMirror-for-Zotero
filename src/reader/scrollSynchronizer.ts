/**
 * Bidirectional page/paragraph synchronization between the PDF view and the
 * translation pane. The loop-guard core is pure and unit-tested; DOM wiring
 * lives in translationPane/splitView.
 *
 * Anchors are (pageIndex, blockId). Guard: while one side is applying a
 * sync-originated change, echoes from the other side are suppressed for a
 * cooldown window.
 */

export type SyncSide = 'pdf' | 'pane';

/**
 * 回声抑制窗口的**唯一来源** (2.9.8)。
 *
 * 此前面板用 300 ms、这里用 400 ms,各写各的。中间那 100 ms 里面板已经不再把
 * 自己的回声当回声,而 SyncGuard 还在压制 —— 两边对"现在谁说了算"的判断不一致,
 * 正是双向同步最容易打架的那种缝。两处现在读同一个常量。
 */
export const SYNC_ECHO_MS = 400;

export interface SyncGuardOptions {
	cooldownMs: number;
	now?: () => number;
}

export class SyncGuard {
	private cooldownMs: number;
	private now: () => number;
	private suppressUntil: Partial<Record<SyncSide, number>> = {};

	constructor(options?: Partial<SyncGuardOptions>) {
		this.cooldownMs = options?.cooldownMs ?? SYNC_ECHO_MS;
		this.now = options?.now ?? (() => Date.now());
	}

	/**
	 * Record that we are about to programmatically move `target`.
	 * Events coming FROM `target` during the cooldown are echoes: ignore them.
	 */
	willMove(target: SyncSide): void {
		this.suppressUntil[target] = this.now() + this.cooldownMs;
	}

	/** Should a user-scroll event from `source` be propagated to the other side? */
	shouldPropagate(source: SyncSide): boolean {
		const until = this.suppressUntil[source];
		if (until !== undefined && this.now() < until) {
			return false;
		}
		return true;
	}

	reset(): void {
		this.suppressUntil = {};
	}
}

export interface SyncController {
	enabled: boolean;
	guard: SyncGuard;
	/** Move the pane to a page (called when the PDF page changes). */
	onPdfPageChanged(pageIndex: number): void;
	/** Move the PDF to a page (called when the pane scrolls / block clicked). */
	onPaneNavigated(pageIndex: number, blockId?: string): void;
}

export function createSyncController(handlers: {
	scrollPaneToPage(pageIndex: number): void;
	navigatePdfToPage(pageIndex: number, blockId?: string): void;
}, guard?: SyncGuard): SyncController {
	const g = guard ?? new SyncGuard();
	return {
		enabled: true,
		guard: g,
		onPdfPageChanged(pageIndex: number): void {
			if (!this.enabled || !g.shouldPropagate('pdf')) {
				return;
			}
			g.willMove('pane');
			handlers.scrollPaneToPage(pageIndex);
		},
		onPaneNavigated(pageIndex: number, blockId?: string): void {
			if (!this.enabled || !g.shouldPropagate('pane')) {
				return;
			}
			g.willMove('pdf');
			handlers.navigatePdfToPage(pageIndex, blockId);
		}
	};
}
