/**
 * 段内样式跨度 — 参照 BabelDOC `il_translator.py::RichTextPlaceholder`
 * (https://github.com/funstory-ai/BabelDOC, AGPL-3.0,与本项目同协议)的
 * 成对占位符思想:粗体/斜体跨度用成对 token 夹住穿过翻译,译后按对恢复
 * 为样式。完整致谢见 THIRD-PARTY-NOTICES.md。
 *
 * 降级安全是硬约束:样式是装饰,不是内容——模型弄丢/弄破一对 token 时,
 * 一律剥掉全部标记回到无样式文本,绝不因样式拒绝译文、绝不烧重试。
 *
 * Pure module — no DOM, unit-testable.
 */

import type { PdfChar } from '../types/models';

export interface StyleRun {
	text: string;
	style: 'b' | 'i';
}

/** 成对标记。字符集合与 ⟦PMn⟧ 同族,TOKEN_RE (⟦PM\d+⟧) 不会误匹配。 */
export const STYLE_OPEN: Record<'b' | 'i', string> = { b: '⟦b⟧', i: '⟦i⟧' };
export const STYLE_CLOSE: Record<'b' | 'i', string> = { b: '⟦/b⟧', i: '⟦/i⟧' };
export const STYLE_MARK_RE = /⟦\/?[bi]⟧/g;

/** 剥掉全部样式标记(所有"消费文本"的路径统一用它,渲染器除外)。 */
export function stripStyleMarkers(text: string): string {
	return text.includes('⟦') ? text.replace(STYLE_MARK_RE, '') : text;
}

function styleOf(fontName: string | undefined): 'b' | 'i' | null {
	if (!fontName) {
		return null;
	}
	// Bold 优先: "BoldItalic" 按粗体处理(嵌套对儿只会放大丢对概率)。
	if (/bold|black|heavy|semibold/i.test(fontName)) {
		return 'b';
	}
	if (/italic|oblique/i.test(fontName)) {
		return 'i';
	}
	return null;
}

/**
 * 从段落字符序列找出与主导样式不同的粗/斜体 RUN。
 * 保守过滤:≥2 个字母、≤60 字符(超长跨度多半是检测错误)、每段 ≤6 个;
 * 整段同样式不算(那是块级样式,标题加粗已有渲染通道)。
 */
export function detectStyleRuns(chars: PdfChar[]): StyleRun[] {
	if (chars.length < 4) {
		return [];
	}
	const styles = chars.map(c => styleOf(c.fontName));
	const counts = { b: 0, i: 0, n: 0 };
	for (const s of styles) {
		counts[s ?? 'n']++;
	}
	const dominant: 'b' | 'i' | null =
		counts.b > chars.length * 0.6 ? 'b' : counts.i > chars.length * 0.6 ? 'i' : null;
	const runs: StyleRun[] = [];
	let start = -1;
	let current: 'b' | 'i' | null = null;
	const emit = (from: number, to: number, style: 'b' | 'i'): void => {
		let text = '';
		for (let k = from; k <= to; k++) {
			text += chars[k]!.c ?? '';
			if (chars[k]!.spaceAfter && k < to) {
				text += ' ';
			}
		}
		text = text.trim();
		const letters = (text.match(/[A-Za-z一-鿿]/g) ?? []).length;
		if (letters >= 2 && text.length <= 60 && runs.length < 6) {
			runs.push({ text, style });
		}
	};
	for (let i = 0; i < chars.length; i++) {
		const s = styles[i] === dominant ? null : styles[i]!;
		// 空格不断开 RUN(样式字体的空格常回落到基础字体)。
		const bridging = s === null && current !== null && (chars[i]!.c ?? '') === ' '
			&& i + 1 < chars.length && (styles[i + 1] === current || (styles[i + 1] ?? null) !== dominant && styles[i + 1] === current);
		if (s === current || bridging) {
			continue;
		}
		if (current !== null && start >= 0) {
			emit(start, i - 1, current);
		}
		current = s;
		start = s !== null ? i : -1;
	}
	if (current !== null && start >= 0) {
		emit(start, chars.length - 1, current);
	}
	// 去重(同一术语多次出现按一次处理;标记插入只包第一处)。
	const seen = new Set<string>();
	return runs.filter(r => !seen.has(r.style + r.text) && seen.add(r.style + r.text) !== undefined);
}

/**
 * 在原文中给样式 RUN 包上成对标记(翻译请求侧)。只包与其它标记不重叠的
 * 第一处出现;找不到原样出现(去连字符/空白归一改写过)就跳过——宁缺毋滥。
 */
export function insertStyleMarkers(text: string, runs: StyleRun[] | undefined): string {
	if (!runs?.length) {
		return text;
	}
	let out = text;
	for (const run of [...runs].sort((a, b) => b.text.length - a.text.length)) {
		const at = out.indexOf(run.text);
		if (at < 0) {
			continue;
		}
		// 不嵌套:落点已在任何标记内/本身含标记就跳过。
		const before = out.slice(0, at);
		const opens = (before.match(STYLE_MARK_RE) ?? []).length;
		if (opens % 2 === 1 || run.text.includes('⟦')) {
			continue;
		}
		out = before + STYLE_OPEN[run.style] + run.text + STYLE_CLOSE[run.style] + out.slice(at + run.text.length);
	}
	return out;
}

/**
 * 译后成对校验(降级安全):栈式检查配对与嵌套;任何不配对/交错/空对 →
 * 剥掉全部标记返回纯文本。校验必须在占位符 restore 之后跑(掩蔽可能临时
 * 拆散一对,restore 会原样放回)。
 */
export function finalizeStyleMarkers(text: string): string {
	if (!text.includes('⟦')) {
		return text;
	}
	const marks = text.match(STYLE_MARK_RE) ?? [];
	if (!marks.length) {
		return text;
	}
	const stack: string[] = [];
	for (const m of marks) {
		if (!m.startsWith('⟦/')) {
			if (stack.length) {
				return stripStyleMarkers(text); // 不支持嵌套 → 剥
			}
			stack.push(m[1]!); // 'b' | 'i'
		}
		else {
			if (stack.pop() !== m[2]) {
				return stripStyleMarkers(text);
			}
		}
	}
	if (stack.length) {
		return stripStyleMarkers(text);
	}
	// 空对(⟦b⟧⟦/b⟧)剥掉。
	return text.replace(/⟦([bi])⟧\s*⟦\/\1⟧/g, '');
}

export interface StyledSegment {
	text: string;
	style: 'b' | 'i' | null;
}

/**
 * 渲染侧解析:标记文本 → 顺序分段(样式为 null 的是普通文本)。输入应当
 * 已过 finalizeStyleMarkers;防御起见,解析途中发现不配对仍回退为整段纯
 * 文本单段。消费方用 createElement + textContent 构建,不经 innerHTML。
 */
export function parseStyledSegments(text: string): StyledSegment[] {
	if (!text.includes('⟦')) {
		return [{ text, style: null }];
	}
	const segments: StyledSegment[] = [];
	let current: 'b' | 'i' | null = null;
	let buf = '';
	const parts = text.split(/(⟦\/?[bi]⟧)/);
	for (const part of parts) {
		if (part === '⟦b⟧' || part === '⟦i⟧') {
			if (current !== null) {
				return [{ text: stripStyleMarkers(text), style: null }];
			}
			if (buf) {
				segments.push({ text: buf, style: null });
			}
			buf = '';
			current = part === '⟦b⟧' ? 'b' : 'i';
		}
		else if (part === '⟦/b⟧' || part === '⟦/i⟧') {
			if (current !== (part === '⟦/b⟧' ? 'b' : 'i')) {
				return [{ text: stripStyleMarkers(text), style: null }];
			}
			if (buf) {
				segments.push({ text: buf, style: current });
			}
			buf = '';
			current = null;
		}
		else if (part) {
			buf += part;
		}
	}
	if (current !== null) {
		return [{ text: stripStyleMarkers(text), style: null }];
	}
	if (buf) {
		segments.push({ text: buf, style: null });
	}
	return segments;
}
