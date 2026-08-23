/**
 * Text wrapping & fitting for the in-plugin translated-PDF builder.
 * Pure logic — the font is abstracted to a measure function, so this is fully
 * unit-testable without pdf-lib.
 */

export interface WrapOptions {
	/** Smallest font size before giving up and clipping. */
	minSize?: number;
	/** Line height as a multiple of the font size. */
	leading?: number;
}

export interface WrapResult {
	lines: string[];
	fontSize: number;
	/** Line advance in the same unit as fontSize. */
	lineHeight: number;
	/** True when even minSize could not fit everything into the box. */
	overflow: boolean;
}

/** Width of `text` at `size`, in PDF units. */
export type Measure = (text: string, size: number) => number;

/**
 * Tokenise for wrapping: Latin words (with attached digits/punctuation) are
 * atomic and never split; CJK breaks between any two characters; whitespace
 * is its own token so it can be dropped at line starts.
 */
export function tokenize(text: string): string[] {
	return text.match(/[A-Za-z0-9]+(?:[''\-.,;:%)\]}»""]*)?|\s+|./gsu) ?? [];
}

/**
 * CJK 标点禁则 (2.3.4, 第四批 item6 · LO-4) — pure。
 * 行首禁则: 收尾标点(。,、;:?!)】》」』…等)不得顶行首 → 悬挂到上一行行尾
 * (可微越界,典型中文排版做法);行尾禁则: 起始标点((【《「『)不得吊行尾 →
 * 下移到下一行行首。每行至多迁移 2 个字符,防病态循环;迁空的行被删除,行数只
 * 减不增 —— 已通过高度检查的排版应用禁则后仍然适配。
 */
const KINSOKU_NO_START = new Set('。,、;:?!)〉》」』】〕…‰′″℃·—－,.;:!?)]}%~');
const KINSOKU_NO_END = new Set('(〈《「『【〔([{');

export function applyKinsoku(lines: string[]): string[] {
	const out = [...lines];
	for (let i = 1; i < out.length; i++) {
		// 行首禁则: 把顶行首的收尾标点悬挂到上一行(至多 2 个)。
		let moved = 0;
		while (moved < 2 && out[i]!.length > 0 && KINSOKU_NO_START.has(out[i]![0]!)) {
			out[i - 1] = out[i - 1]! + out[i]![0]!;
			out[i] = out[i]!.slice(1);
			moved++;
		}
		// 行尾禁则: 上一行行尾的起始标点下移到本行行首(至多 2 个)。
		moved = 0;
		while (moved < 2 && out[i - 1]!.length > 1 && KINSOKU_NO_END.has(out[i - 1]![out[i - 1]!.length - 1]!)) {
			out[i] = out[i - 1]![out[i - 1]!.length - 1]! + out[i]!;
			out[i - 1] = out[i - 1]!.slice(0, -1);
			moved++;
		}
	}
	return out.filter(l => l.length > 0);
}

/** Greedy wrap at a fixed size. Returns null if any single token exceeds the width. */
export function wrapAt(text: string, size: number, maxWidth: number, measure: Measure): string[] | null {
	const lines: string[] = [];
	let line = '';
	for (const token of tokenize(text)) {
		if (/^\s+$/.test(token)) {
			if (line) {
				line += ' ';
			}
			continue;
		}
		const candidate = line + token;
		if (measure(candidate, size) <= maxWidth) {
			line = candidate;
			continue;
		}
		if (!line) {
			// A single token wider than the box (a long URL, a formula token):
			// hard-split it rather than failing the whole block.
			let piece = '';
			for (const ch of token) {
				if (measure(piece + ch, size) > maxWidth && piece) {
					lines.push(piece);
					piece = ch;
				}
				else {
					piece += ch;
				}
			}
			line = piece;
			continue;
		}
		lines.push(line.trimEnd());
		line = token;
	}
	if (line.trim()) {
		lines.push(line.trimEnd());
	}
	// CJK 标点禁则 (LO-4): 「。,)」不顶行首、「(《「」不吊行尾。
	return applyKinsoku(lines);
}

/**
 * Fit `text` into a box: start at the source's own size and step down until
 * the wrapped lines fit the height. 与原文字号一致 by construction — shrink
 * only happens when the translation is genuinely longer than the original.
 */
export function layoutBlock(
	text: string,
	boxWidth: number,
	boxHeight: number,
	startSize: number,
	measure: Measure,
	options?: WrapOptions
): WrapResult {
	const minSize = options?.minSize ?? 5;
	const leading = options?.leading ?? 1.32;
	const trimmed = text.replace(/\s+/g, ' ').trim();
	if (!trimmed || boxWidth <= 1 || boxHeight <= 1) {
		return { lines: [], fontSize: startSize, lineHeight: startSize * leading, overflow: false };
	}
	let size = Math.max(minSize, startSize);
	for (;;) {
		const lines = wrapAt(trimmed, size, boxWidth, measure) ?? [];
		const needed = lines.length * size * leading;
		if (needed <= boxHeight + size * 0.35) {
			return { lines, fontSize: size, lineHeight: size * leading, overflow: false };
		}
		if (size <= minSize) {
			// Clip: keep as many lines as fit, mark the loss.
			const keep = Math.max(1, Math.floor((boxHeight + size * 0.35) / (size * leading)));
			const kept = lines.slice(0, keep);
			if (kept.length && kept.length < lines.length) {
				kept[kept.length - 1] = `${kept[kept.length - 1]}…`;
			}
			return { lines: kept, fontSize: size, lineHeight: size * leading, overflow: true };
		}
		size = Math.max(minSize, size * 0.92);
	}
}
