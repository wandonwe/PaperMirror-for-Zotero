/**
 * 提示词规则版本 (5.0 结构层重构第 3 步)。
 *
 * 过去提示词一改,只有两条路:整体升 PROMPT_VERSION(所有已缓存的页重新付费),
 * 或者不升(旧译文一直留着 —— 4.99.15 改了"人名保留原文",清了缓存仍看到
 * 「何娜英」)。这里给每条会改变译文的规则单独一个版本号,并说明它影响哪些块:
 *
 *   - 段落库的键 = 内容哈希 + **与本块相关、且版本 > 1 的规则戳**。与规则无关的块
 *     键不变,旧缓存照常命中;相关的块换键,旧译文自然不再被取到。
 *   - 页缓存逐行记下写入时的戳;读回时戳对不上的行丢弃,只重译那几块。
 *
 * 以后改哪条规则,就只升哪条的版本号。v1 = 规则引入前(旧缓存没有戳,即 v1)。
 */
import type { SourceBlock } from '../types/models';
import { looksLikePersonNames } from './translationValidation';

export const PROMPT_POLICIES = {
	/** v2 (4.99.7): 参考文献只译标题,作者、期刊、卷期页原样。 */
	references: 2,
	/** v2 (4.99.15): 人名保留原文拼写,不再音译。 */
	personNames: 2,
	/** v2 (5.1): 表格单元格带行 / 列标题作为语境,型号名原样保留。
	 *  v3 (5.1 真机): 原样返回的型号名不再被判为没翻、被兜底强译(v2 期间缓存的「阿尔法」作废)。
	 *  v4 (5.1 真机): 产品行里列出的名字作子行标签时也算型号名(3023 Force →「力」作废)。
	 *  v5 (5.1 四相位对比): 只保留扫描仪 / 设备 / 软件的型号名,药名等照常翻译(3098「Gefitinib」作废)。 */
	tableCells: 5
} as const;

export type PolicyName = keyof typeof PROMPT_POLICIES;

type PolicyBlock = Pick<SourceBlock, 'sourceText'> & { isReference?: boolean; tableId?: string; tableRow?: number };

const CONTACT = /\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+){0,3},\s*[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/u;
/** "Naying He¹, Youmin Zhang², …" — three or more capitalised names in a comma list. */
const BYLINE = /^(?:\s*\p{Lu}[\p{Ll}'’-]+(?:[\s-]\p{Lu}\.?)*(?:\s\p{Lu}[\p{Ll}'’-]+)+[\d⁰¹²³⁴⁵⁶⁷⁸⁹*†‡§,\s]*(?:,|\band\b)){3,}/u;

/**
 * 规则影响哪些块。人名规则只算"名字就是内容"的块(参考文献、联系人记录、
 * 作者署名行);正文里顺带提到的"Smith et al."不算 —— 那会让几乎每个带引用
 * 的段落都重译,代价远大于收益。
 */
const RELEVANT: Record<PolicyName, (b: PolicyBlock) => boolean> = {
	references: b => !!b.isReference,
	personNames: b => !!b.isReference || CONTACT.test(b.sourceText) || BYLINE.test(b.sourceText) || looksLikePersonNames(b.sourceText),
	// Structured cells below the header row: they are the ones that now get headers.
	tableCells: b => typeof b.tableId === 'string' && typeof b.tableRow === 'number' && b.tableRow > 0
};

/** 本块的规则戳:相关、且版本 > 1 的规则,如 "personNames2|references2";无关则为空串。 */
export function policyStampFor(block: PolicyBlock): string {
	return (Object.keys(PROMPT_POLICIES) as PolicyName[])
		.filter(p => PROMPT_POLICIES[p] > 1 && RELEVANT[p](block))
		.sort()
		.map(p => `${p}${PROMPT_POLICIES[p]}`)
		.join('|');
}
