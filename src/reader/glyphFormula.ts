/**
 * 字形级公式判定 — 移植自 PDFMathTranslate (pdf2zh) `converter.py::vflag`
 * (https://github.com/PDFMathTranslate/PDFMathTranslate, AGPL-3.0) 与
 * BabelDOC `document_il/utils/formular_helper.py`
 * (https://github.com/funstory-ai/BabelDOC, AGPL-3.0) 的可移植部分。
 * 完整致谢见 THIRD-PARTY-NOTICES.md。
 *
 * 思路:公式不该靠"拼好文本后的正则"去猜——字符层的证据(数学字体名、
 * Unicode 码位类别、相对字号的角标、括号配平)是三个参照项目共同验证过的
 * 高精度判据。本模块在 char 提取路径上把公式 RUN 找出来,交给 formulaGuard
 * 作为字面量占位符掩蔽;span 路径(无字体名)保留原有文本正则兜底。
 *
 * Pure module — no DOM, unit-testable.
 */

import type { PdfChar } from '../types/models';

/**
 * 数学/易碎字体名 (pdf2zh vflag 原样): LaTeX 族 (CM 非 Roman、MS.M、XY、MT、
 * BL、RM、EU、LA、RS、LINE、LCIRCLE、TeX-、rsfs、txsy、wasy、stmary) 与
 * Mono/Code/Ital/Sym/Math 族。字体名先截掉子集前缀 (ABCDEF+CMMI10 → CMMI10)。
 */
const MATH_FONT_RE = /^(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)/;

export function isMathFontName(fontName: string | undefined): boolean {
	if (!fontName) {
		return false;
	}
	const name = fontName.split('+').pop() ?? fontName;
	return MATH_FONT_RE.test(name);
}

/**
 * 公式码位 (pdf2zh: unicodedata.category ∈ {Lm,Mn,Sk,Sm,Zl,Zp,Zs} + 希腊区;
 * BabelDOC 去掉 Lm、加 Co 私有区)。TS 无 unicodedata,用显式区间近似:
 * 组合附标(Mn)、修饰符(Lm/Sk)、希腊、字母式符号、箭头、数学运算符、
 * 杂项数学符号 A/B、补充运算符、上下标区、私有区。空格不算(pdf2zh 同)。
 */
export function isFormulaCodepoint(ch: string): boolean {
	if (!ch || ch === ' ') {
		return false;
	}
	const cp = ch.codePointAt(0)!;
	// ASCII/Latin-1 数学符号 (pdf2zh 靠 unicodedata 类别 Sm/Sk 捕捉的常用字符:
	// = < > + | ~ ^ ± × ÷ ¬ 与 Latin-1 上标 ¹²³): TS 无 unicodedata,显式列出。
	if ('=<>+|~^±×÷¬'.includes(ch) || cp === 0x00B9 || cp === 0x00B2 || cp === 0x00B3) {
		return true;
	}
	return (cp >= 0x0300 && cp <= 0x036F)   // combining marks (Mn)
		|| (cp >= 0x02B0 && cp <= 0x02FF)   // modifier letters (Lm/Sk)
		|| (cp >= 0x0370 && cp <= 0x03FF)   // Greek
		|| (cp >= 0x2070 && cp <= 0x209F)   // super/subscripts
		|| (cp >= 0x2100 && cp <= 0x214F)   // letterlike symbols
		|| (cp >= 0x2190 && cp <= 0x21FF)   // arrows
		|| (cp >= 0x2200 && cp <= 0x22FF)   // mathematical operators (Sm)
		|| (cp >= 0x27C0 && cp <= 0x27EF)   // misc math symbols A
		|| (cp >= 0x2980 && cp <= 0x29FF)   // misc math symbols B
		|| (cp >= 0x2A00 && cp <= 0x2AFF)   // supplemental operators
		|| (cp >= 0xE000 && cp <= 0xF8FF)   // private use (BabelDOC "Co")
		|| ch.startsWith('(cid:');          // undecoded glyph (both projects)
}

/** 角标判定阈值 (pdf2zh 原样注释: 0.76 角标与 0.799 大写之间取 0.79). */
const SUBSCRIPT_RATIO = 0.79;

/**
 * 在一个段落的字符序列上标记公式 RUN,返回应整体保护的字面量列表。
 *
 * 判定 (pdf2zh A 段解析循环的可移植子集):
 *  - 数学字体 / 公式码位 → 公式字符;
 *  - 同段中字号 < 段基准字号 × 0.79(且段落已有 ≥2 个正文字符,避开首字下沉)
 *    → 角标,并入公式;
 *  - 公式 RUN 内的 "(" 使配对的 ")" 保持在公式内(括号配平 vbkt);
 *  - RUN 间的单个空格桥接("y = x" 不断开)。
 *
 * 后处理 (BabelDOC): 纯数字/逗号的"公式"不保护(那是可保留的数据,交给
 * 引用/统计正则);过短且无强证据的 RUN 丢弃,避免把 "n" 这类单字母当字面量
 * 掩蔽而误伤全文。
 */
export function detectGlyphFormulaRuns(chars: PdfChar[], baseFontSize: number): string[] {
	if (!chars.length) {
		return [];
	}
	const flags = new Array<boolean>(chars.length).fill(false);
	const strong = new Array<boolean>(chars.length).fill(false); // font/codepoint evidence
	let bodySeen = 0;
	let bracketDepth = 0;
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!;
		const text = ch.c ?? '';
		let isFormula = false;
		let isStrong = false;
		if (isMathFontName(ch.fontName) || isFormulaCodepoint(text)) {
			isFormula = true;
			isStrong = true;
		}
		else if (
			baseFontSize > 0
			&& typeof ch.fontSize === 'number' && ch.fontSize > 0
			&& ch.fontSize < baseFontSize * SUBSCRIPT_RATIO
			&& bodySeen >= 2
			&& text.trim() !== ''
		) {
			isFormula = true; // 角标 (pdf2zh 条件 2)
		}
		// 括号配平 (pdf2zh vbkt): 公式内的 "(" 拉着配对 ")" 一起留在公式里。
		const prevInRun = i > 0 && flags[i - 1];
		if (!isFormula && prevInRun) {
			if (text === '(') {
				isFormula = true;
				bracketDepth++;
			}
			else if (text === ')' && bracketDepth > 0) {
				isFormula = true;
				bracketDepth--;
			}
		}
		else if (isFormula && text === '(') {
			bracketDepth++;
		}
		else if (isFormula && text === ')' && bracketDepth > 0) {
			bracketDepth--;
		}
		if (!prevInRun && !isFormula) {
			bracketDepth = 0;
		}
		flags[i] = isFormula;
		strong[i] = isFormula && isStrong;
		if (!isFormula && text.trim() !== '') {
			bodySeen++;
		}
	}
	// 单空格桥接: 公式-空格-公式 视为一个 RUN。
	for (let i = 1; i < chars.length - 1; i++) {
		if (!flags[i] && (chars[i]!.c ?? '') === ' ' && flags[i - 1] && flags[i + 1]) {
			flags[i] = true;
		}
	}
	// 提取 RUN → 字面量。
	const runs: string[] = [];
	let start = -1;
	const emit = (from: number, to: number): void => {
		let text = '';
		let hasStrong = false;
		for (let k = from; k <= to; k++) {
			text += chars[k]!.c ?? '';
			if (chars[k]!.spaceAfter && k < to) {
				text += ' ';
			}
			hasStrong = hasStrong || strong[k]!;
		}
		text = text.trim();
		if (text.length < 2) {
			return; // 单字符字面量掩蔽会误伤全文同字符
		}
		// BabelDOC 后处理: 纯数字/逗号/空格/句点是数据不是公式。
		if (/^[\d\s,.]+$/.test(text)) {
			return;
		}
		// 无强证据(仅角标推断)且很短 → 交给文本正则,不用字面量掩蔽。
		if (!hasStrong && text.length < 4) {
			return;
		}
		runs.push(text);
	};
	for (let i = 0; i < chars.length; i++) {
		if (flags[i] && start < 0) {
			start = i;
		}
		else if (!flags[i] && start >= 0) {
			emit(start, i - 1);
			start = -1;
		}
	}
	if (start >= 0) {
		emit(start, chars.length - 1);
	}
	// 去重(字面量掩蔽本身替换所有出现)。
	return [...new Set(runs)];
}
