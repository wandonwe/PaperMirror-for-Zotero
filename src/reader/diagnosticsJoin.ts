/**
 * 诊断口径联表 (2.7.0, 审核 B-1) — pure。
 *
 * translationManager.exportDiagnostics 的 blocks[].state 按"有译文即 translated"
 * 计,排版阶段放弃的块(译了、从未显示)也报 translated —— 两篇真实诊断里
 * 21 个整段英文残留在块表上全是 translated,只有 placement.abandoned 的计数
 * 知道它们存在。这里把 strict 页的放弃清单并进块表: state → 'unplaced',
 * 附 abandonReason 枚举串。段落拆分块 id 形如 `<region>::pN`,按前缀归到区域。
 * 只碰 state/abandonReason 两个字段,其余原样。
 */

export interface DiagnosticsBlockRow {
	id: string;
	state: string;
	[key: string]: unknown;
}

export interface DiagnosticsPageRow {
	page: number;
	blocks?: DiagnosticsBlockRow[];
	[key: string]: unknown;
}

export interface AbandonedRow {
	id: string;
	reason: string;
}

export function joinPlacementOutcome(
	pages: DiagnosticsPageRow[],
	abandonedByPageIndex: Map<number, AbandonedRow[]>
): DiagnosticsPageRow[] {
	return pages.map((page) => {
		const abandoned = abandonedByPageIndex.get(page.page - 1);
		if (!abandoned?.length || !page.blocks?.length) {
			return page;
		}
		const reasonOf = new Map<string, string>();
		for (const a of abandoned) {
			// 拆分块 (`region::p1`) 归到区域 id;区域已有原因时保留第一条。
			const regionId = a.id.split('::')[0]!;
			if (!reasonOf.has(regionId)) {
				reasonOf.set(regionId, a.reason);
			}
		}
		return {
			...page,
			blocks: page.blocks.map((b) => {
				const reason = reasonOf.get(b.id);
				return reason !== undefined && b.state === 'translated'
					? { ...b, state: 'unplaced', abandonReason: reason }
					: b;
			})
		};
	});
}
