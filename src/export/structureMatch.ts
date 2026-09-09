/**
 * 结构一致性检查 (2.8.7, 导出方案 P2 · 方案 §1)。
 *
 * ## 这个模块要诚实地回答什么
 *
 * spans **没有被留存**:`buildBlocksFromSpans` 消费完就只留结构块,原始 spans 当场
 * 丢弃。所以语料导出时的 spans 只能**重新解析**,拿不出翻译当时的那一份。
 *
 * 于是唯一能做的是:用**与翻译相同的流水线**把结构重建一遍,和留存的结构块比对,
 * 然后**如实说出比对的效力边界**:
 *
 *   `matched` —— 有可靠对照,且逐项比对全等。**它只说明"用同样的流水线重建出了
 *                 同样的结构",不等于"这就是当时那份 spans"。**
 *   `mismatched` —— 有可靠对照,但比对不等;附 `mismatchKinds` 分类计数。
 *   `unverifiable` —— 原始结构已被淘汰/从未留存,**或对照本身不可信**。
 *
 * ## 为什么"对照本身不可信"是独立的一档
 *
 * 抽取的输入里有四项是跨页累积或会中途改变的:
 *
 *   - `bodyFontSize`: 文档级正文字号的**滚动估计**,随读过的页不断修正;
 *   - `referencesAlreadyStarted`: 跨页累积,单页孤立重解析时前文状态未必一致;
 *   - `includeReferences` / `noTranslate`: 用户首选项,**可中途改**;
 *   - 抽取路径: 运行时择路(含 `(cid:` 未解码比例的启发式),重解析可能走上另一条。
 *
 * 任何一项已知变化,结论**必须**是 `unverifiable` —— 这时哪怕逐项比对全等,也只是
 * 碰巧,不许写 `matched`。这条闸由 `inputsChanged` 显式传入,不靠这里猜。
 *
 * ## 比对哪些字段
 *
 * 不止 id 与原文哈希:`type` · `boundingBox`(带容差,容差写进文件)· `readingIndex` ·
 * `column` · `tableRow`/`tableCol` · `translationMode` · 原文哈希。只比 id + 哈希会
 * 放过"文字一样但被切到了另一栏/另一行"这类真正会毁掉语料的差异。
 */

import type { SourceBlock } from '../types/models';
import { hashSourceTexts } from '../cache/cacheSchema';

export type StructureMatch =
	/**
	 * **导出的就是翻译当时用的那份结构**(还在内存里,没被淘汰)—— 不是重建的近似,
	 * 所以没有"要不要核对"这个问题,译文按块 id 对齐是天然成立的。
	 *
	 * 这一档是 2.8.12 真机验证补上的: 原方案假定结构只能靠重解析,漏了"内存里
	 * 就躺着原件"这条最短路径 —— 而重解析在文本层路径的文档上导出时根本走不通
	 * (文本层只对当前渲染着的那几页存在)。它比 `matched` 强: matched 说的是
	 * "重建出了一样的东西",这一档说的是"这就是那个东西"。
	 */
	| 'as-translated'
	| 'matched' | 'mismatched' | 'unverifiable';

/** 对照不可信的原因枚举 —— 与方案 §1.2 的四项输入一一对应。 */
export type UnverifiableReason =
	| 'no-stored-structure'
	/** 重解析拿不到任何块(文本层只对渲染着的页存在)—— 没东西可比。 */
	| 're-extraction-unavailable'
	| 'body-font-size-changed'
	| 'references-state-unknown'
	| 'prefs-changed'
	| 'extract-path-changed';

/** 抽取输入快照(与 `TextExtractor.ExtractInputs` 同形,这里不依赖 reader 模块)。 */
export interface ExtractInputsLike {
	path?: string;
	bodyFontSize: number;
	includeReferences: boolean;
	referencesAlreadyStarted: boolean;
	noTranslateHash: string;
}

/**
 * 抽取当时 vs 此刻 —— 哪些输入变了。**非空即不可核。**
 *
 * `then` 缺失(这一页从没抽过、或抽取快照没留下)同样算不可核: 不知道当时用的是
 * 什么,就没资格说"重建出来的和当时一样"。
 */
export function changedExtractInputs(
	then: ExtractInputsLike | undefined | null,
	now: Omit<ExtractInputsLike, 'path'> & { path?: string }
): UnverifiableReason[] {
	if (!then) {
		return ['no-stored-structure'];
	}
	const reasons: UnverifiableReason[] = [];
	if (then.bodyFontSize !== now.bodyFontSize) {
		reasons.push('body-font-size-changed');
	}
	if (then.referencesAlreadyStarted !== now.referencesAlreadyStarted) {
		reasons.push('references-state-unknown');
	}
	if (then.includeReferences !== now.includeReferences || then.noTranslateHash !== now.noTranslateHash) {
		reasons.push('prefs-changed');
	}
	// 路径只在两边都知道时才比: 此刻走哪条要等重解析跑完才知道,调用方拿到后再传。
	if (then.path && now.path && then.path !== now.path) {
		reasons.push('extract-path-changed');
	}
	return reasons;
}

export interface MismatchKinds {
	/** 有差异的块数(不是差异项数)。 */
	count: number;
	type: number;
	box: number;
	readingOrder: number;
	tableCell: number;
	translationMode: number;
	text: number;
	/** 留存里有、重建里没有。 */
	missing: number;
	/** 重建里多出来的。 */
	extra: number;
}

export interface StructureCheckResult {
	structureMatch: StructureMatch;
	/** 比对了多少块(以留存侧计)。 */
	blocksCompared: number;
	mismatchKinds?: MismatchKinds;
	/** `unverifiable` 时必有,且可能不止一条。 */
	unverifiableReasons?: UnverifiableReason[];
	/** 坐标容差(px)—— 写进文件,读的人才知道"相等"是多相等。 */
	boxTolerancePx?: number;
}

/** 坐标容差: 重排/重解析带来的亚像素抖动不该报成结构变化。 */
export const BOX_TOLERANCE_PX = 0.5;

function boxOf(block: SourceBlock): [number, number, number, number] | null {
	const box = block.boundingBox;
	return box ? [box.x, box.y, box.x + box.width, box.y + box.height] : null;
}

function boxDiffers(a: SourceBlock, b: SourceBlock, tolerance: number): boolean {
	const left = boxOf(a);
	const right = boxOf(b);
	if (!left || !right) {
		// 一边有坐标一边没有 = 真的不同;两边都没有 = 没得比,不算差异。
		return !!left !== !!right;
	}
	return left.some((v, i) => Math.abs(v - right[i]!) > tolerance);
}

function emptyKinds(): MismatchKinds {
	return { count: 0, type: 0, box: 0, readingOrder: 0, tableCell: 0, translationMode: 0, text: 0, missing: 0, extra: 0 };
}

/** 单块原文哈希 —— 语料里不放哈希用来"代替原文",它只用于比对。 */
export function blockTextHash(block: SourceBlock): string {
	return hashSourceTexts([block.sourceText]);
}

/**
 * 比对留存结构与重建结构。
 *
 * @param stored 翻译当时留存的结构块;已被淘汰或从未留存时传 null/空数组
 * @param rebuilt 走完整流水线重新解析出的结构块
 * @param options.inputsChanged 已知变化的抽取输入 —— **非空即 unverifiable**
 */
export function checkStructure(
	stored: SourceBlock[] | null | undefined,
	rebuilt: SourceBlock[],
	options: { inputsChanged?: UnverifiableReason[]; boxTolerancePx?: number } = {}
): StructureCheckResult {
	const reasons = [...(options.inputsChanged ?? [])];
	if (!stored || !stored.length) {
		reasons.push('no-stored-structure');
	}
	if (reasons.length) {
		// 输入变了就算逐项全等也只是碰巧 —— 这里**不比对**,直接如实说不可核。
		return {
			structureMatch: 'unverifiable',
			blocksCompared: 0,
			unverifiableReasons: [...new Set(reasons)]
		};
	}

	const tolerance = options.boxTolerancePx ?? BOX_TOLERANCE_PX;
	const kinds = emptyKinds();
	const rebuiltById = new Map(rebuilt.map(b => [b.id, b]));
	const seen = new Set<string>();

	for (const block of stored!) {
		const other = rebuiltById.get(block.id);
		if (!other) {
			kinds.missing++;
			kinds.count++;
			continue;
		}
		seen.add(block.id);
		let differs = false;
		if (block.type !== other.type) {
			kinds.type++;
			differs = true;
		}
		if (boxDiffers(block, other, tolerance)) {
			kinds.box++;
			differs = true;
		}
		if ((block.readingIndex ?? block.order) !== (other.readingIndex ?? other.order)
			|| (block.column ?? null) !== (other.column ?? null)) {
			kinds.readingOrder++;
			differs = true;
		}
		if ((block.tableRow ?? null) !== (other.tableRow ?? null)
			|| (block.tableCol ?? null) !== (other.tableCol ?? null)) {
			kinds.tableCell++;
			differs = true;
		}
		if ((block.translationMode ?? null) !== (other.translationMode ?? null)) {
			kinds.translationMode++;
			differs = true;
		}
		if (blockTextHash(block) !== blockTextHash(other)) {
			kinds.text++;
			differs = true;
		}
		if (differs) {
			kinds.count++;
		}
	}
	kinds.extra = rebuilt.filter(b => !seen.has(b.id)).length;
	if (kinds.extra) {
		kinds.count += kinds.extra;
	}

	return kinds.count
		? { structureMatch: 'mismatched', blocksCompared: stored!.length, mismatchKinds: kinds, boxTolerancePx: tolerance }
		: { structureMatch: 'matched', blocksCompared: stored!.length, boxTolerancePx: tolerance };
}

/**
 * 这一页能不能贴译文。
 *
 * **不匹配时不得按块 id 强行关联缓存译文。** 块 id 形如 `page-N-region-M`,是**按位置
 * 生成的** —— 重建后的 `region-3` 可能根本不是当初那个 `region-3`,照 id 贴译文会
 * 产出一份"看起来对齐、其实错位"的语料,**比缺失更糟**:缺失看得出来,错位看不出来。
 */
export function mayAttachTranslations(check: StructureCheckResult): boolean {
	// `as-translated`: 导出的就是内存里那份原结构,译文与它同源同 id,对齐是
	// 定义上成立的 —— 比 `matched` 还硬。
	// `matched`: 重建结构逐项等同留存结构,可以贴。
	return check.structureMatch === 'as-translated' || check.structureMatch === 'matched';
}
