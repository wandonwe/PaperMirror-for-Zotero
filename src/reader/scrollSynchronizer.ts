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

export interface SyncGuardOptions {
	cooldownMs: number;
	now?: () => number;
}

export class SyncGuard {
	private cooldownMs: number;
	private now: () => number;
	private suppressUntil: Partial<Record<SyncSide, number>> = {};

	constructor(options?: Partial<SyncGuardOptions>) {
		this.cooldownMs = options?.cooldownMs ?? 400;
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
