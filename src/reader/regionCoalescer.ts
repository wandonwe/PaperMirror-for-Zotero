/**
 * Region coalescing — the pass between block extraction and translation.
 *
 * Extraction sometimes shreds a visual region into fragments: a structured
 * abstract becomes a dozen one-line "paragraphs", each translated in
 * isolation, each typeset in isolation — broken sentences on the way in,
 * scattered boxes on the way out. This pass rebuilds the SEMANTIC unit first:
 * consecutive body blocks that sit in the same column, at the same type size,
 * with only line-spacing between them, are one region. The region is
 * translated as one block (whole sentences, coherent terminology) and
 * typeset into its own union bounding box.
 *
 * Paragraph roles survive by construction: a genuine paragraph boundary
 * (blank line, or a role lead-in like "Methods and Results—" following a
 * finished sentence) joins with "\n\n", so the translator sees — and the
 * typesetter re-renders — the Background / Methods / Conclusions / Key Words
 * structure instead of one run-on wall.
 *
 * Pure logic, no DOM — fully unit-testable.
 */

import type { SourceBlock } from '../types/models';
import { obstacleBetween } from './figureBarriers';

type Rect = [number, number, number, number];

/** Providers cap request sizes; a region never exceeds this many characters. */
const MAX_REGION_CHARS = 2600;

/** Body types that may merge. Headings/titles/captions/tables never do. */
function isBodyBlock(block: SourceBlock): boolean {
	return (block.type === 'paragraph' || block.type === 'list')
		&& !block.isReference
		&& !!block.lineRectsPdf?.length;
}

/** A caption fragment must not be the START of a different figure/table. */
const FIGURE_LABEL_RE = /^(figure|fig\.?|table|图|表|圖)\s*\d+/i;

function unionRect(rects: Rect[]): Rect {
	let x1 = Infinity;
	let y1 = Infinity;
	let x2 = -Infinity;
	let y2 = -Infinity;
	for (const r of rects) {
		x1 = Math.min(x1, r[0]);
		y1 = Math.min(y1, r[1]);
		x2 = Math.max(x2, r[2]);
		y2 = Math.max(y2, r[3]);
	}
	return [x1, y1, x2, y2];
}

/** Same column: x-overlap covers ≥55% of the wider box. */
function sameColumn(a: Rect, b: Rect): boolean {
	const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	const wider = Math.max(a[2] - a[0], b[2] - b[0]);
	return wider > 0 && overlap / wider >= 0.55;
}

/**
 * Sentence-terminal punctuation only. A colon or semicolon means the clause
 * CONTINUES ("the following:", "…sharpness;") — counting them as sentence ends
 * inserted paragraph breaks mid-sentence, the same contradiction fixed in
 * paragraphHeuristics.
 */
function endsSentence(text: string): boolean {
	return /[.!?。！？][)\]"'”’]?\s*$/.test(text.trim());
}

/** "word-" → next fragment continues the same word. */
function endsHyphenated(text: string): boolean {
	return /[A-Za-z]-$/.test(text.trim());
}

export function canMerge(a: SourceBlock, b: SourceBlock, obstacles: Rect[] = []): boolean {
	if (!isBodyBlock(a) || !isBodyBlock(b)) {
		return false;
	}
	// The COLUMN STAMP is authoritative when both sides carry one (audit: three
	// inconsistent geometric "same column" tests coexisted while the computed
	// block.column was ignored — one bad union rect then poisoned every later
	// geometric test on the page). Stamps don't mutate when regions grow, so
	// this check stays correct after any number of merges.
	if (typeof a.column === 'number' && typeof b.column === 'number'
		&& a.column >= 0 && b.column >= 0 && a.column !== b.column) {
		return false;
	}
	const ra = unionRect(a.lineRectsPdf as Rect[]);
	const rb = unionRect(b.lineRectsPdf as Rect[]);
	if (!sameColumn(ra, rb)) {
		return false;
	}
	// 边框硬屏障: a figure between the two regions separates them for good.
	if (obstacleBetween(ra, rb, obstacles)) {
		return false;
	}
	// b must sit BELOW a (PDF y grows upward): a's bottom edge above b's top.
	const gap = ra[1] - rb[3];
	const em = Math.max(a.fontSize ?? 10, 6);
	if (gap < -em * 0.6 || gap > em * 1.9) {
		return false;
	}
	// A type-size jump marks a boundary (a caption, a sidebar, a footnote).
	const fa = a.fontSize ?? 0;
	const fb = b.fontSize ?? 0;
	if (fa > 0 && fb > 0 && Math.abs(fa - fb) > Math.max(fa, fb) * 0.16) {
		return false;
	}
	if ((a.sourceText.length + b.sourceText.length) > MAX_REGION_CHARS) {
		return false;
	}
	return true;
}

/**
 * The separator between two merged fragments.
 *
 * A fragment that ends mid-sentence continues with a space (or joins directly
 * after a hyphenated line break); a finished sentence followed by a new
 * fragment is a PARAGRAPH boundary and keeps "\n\n", which is what carries
 * the Background / Methods / Conclusions structure through translation.
 */
export function separatorBetween(a: SourceBlock, b: SourceBlock): string {
	if (endsHyphenated(a.sourceText)) {
		return '';
	}
	if (!endsSentence(a.sourceText)) {
		return ' ';
	}
	// Both finished sentences and a visible line of spacing → new paragraph.
	const ra = unionRect(a.lineRectsPdf as Rect[]);
	const rb = unionRect(b.lineRectsPdf as Rect[]);
	const gap = ra[1] - rb[3];
	const em = Math.max(a.fontSize ?? 10, 6);
	return gap > em * 0.55 ? '\n\n' : ' ';
}

function mergeTwo(a: SourceBlock, b: SourceBlock): SourceBlock {
	const sep = separatorBetween(a, b);
	const joined = sep === '' && endsHyphenated(a.sourceText)
		? a.sourceText.trim().replace(/-$/, '') + b.sourceText.trim()
		: `${a.sourceText.trim()}${sep}${b.sourceText.trim()}`;
	// 段落组几何 (regionParagraphs): 记录每个**源段落组**的行盒,好在排版时按
	// `\n\n` 把译文拆回各段自己的盒子,而不是把整段译文塞进区域的高联合盒
	// (那会把 Purpose/Methods/Results/Conclusion 式结构化摘要塌成顶部一坨、
	// 下方分节留空)。组的边界 = `\n\n` 分隔:sep==='\n\n' 时 b 另起一组,否则
	// b 续到上一组。b 恒为单块(coalesce 逐块累积),故 b 的行盒即其自身行盒。
	const aGroups: NonNullable<SourceBlock['regionParagraphs']> = a.regionParagraphs
		?? [{ lineRectsPdf: [...((a.lineRectsPdf ?? []) as Rect[])], fontSize: a.fontSize }];
	const bLines = [...((b.lineRectsPdf ?? []) as Rect[])];
	let regionParagraphs: NonNullable<SourceBlock['regionParagraphs']>;
	if (sep === '\n\n') {
		regionParagraphs = [...aGroups, { lineRectsPdf: bLines, fontSize: b.fontSize }];
	}
	else {
		const lastIdx = aGroups.length - 1;
		regionParagraphs = aGroups.map((g, i) => i === lastIdx
			? { lineRectsPdf: [...g.lineRectsPdf, ...bLines], fontSize: g.fontSize }
			: g);
	}
	return {
		...a,
		sourceText: joined,
		regionParagraphs,
		// Provenance: the group keeps the ids of every fragment it absorbed —
		// merging must not lose the source relationship.
		memberIds: [...(a.memberIds ?? [a.id]), ...(b.memberIds ?? [b.id])],
		// 字形级公式字面量随合并累积 (glyphFormula, pdf2zh/BabelDOC 移植) —
		// 丢了它们,掩蔽就退化回文本正则。
		...((a.formulaRuns?.length || b.formulaRuns?.length)
			? { formulaRuns: [...new Set([...(a.formulaRuns ?? []), ...(b.formulaRuns ?? [])])] }
			: {}),
		// 样式跨度同理随合并累积 (styleRuns, BabelDOC RichTextPlaceholder 思想)。
		...((a.styleRuns?.length || b.styleRuns?.length)
			? { styleRuns: [...(a.styleRuns ?? []), ...(b.styleRuns ?? [])].filter((r, i, all) => all.findIndex(x => x.text === r.text && x.style === r.style) === i) }
			: {}),
		// Representative size follows the LONGER text, not blindly the first
		// fragment — fragment one may carry a drop cap or lead-in styling.
		fontSize: (b.sourceText.length > a.sourceText.length ? b.fontSize : a.fontSize) ?? a.fontSize,
		lineRectsPdf: [...(a.lineRectsPdf ?? []), ...(b.lineRectsPdf ?? [])],
		boundingBox: a.boundingBox && b.boundingBox
			? {
				x: Math.min(a.boundingBox.x, b.boundingBox.x),
				y: Math.min(a.boundingBox.y, b.boundingBox.y),
				width: Math.max(a.boundingBox.x + a.boundingBox.width, b.boundingBox.x + b.boundingBox.width)
					- Math.min(a.boundingBox.x, b.boundingBox.x),
				height: Math.max(a.boundingBox.y + a.boundingBox.height, b.boundingBox.y + b.boundingBox.height)
					- Math.min(a.boundingBox.y, b.boundingBox.y)
			}
			: a.boundingBox ?? b.boundingBox
	};
}

/**
 * A SHARD: a fragment extraction should never have made a block of — a bare
 * citation marker "(5,6).", a superscript run, or the torn-off tail of a
 * sentence ("ated light is isolated…"). Left alone, shards either translate
 * as gibberish or fall below the replacement size threshold and survive as
 * English crumbs inside a Chinese paragraph.
 */
export function isShard(block: SourceBlock): boolean {
	if (!isBodyBlock(block)) {
		return false;
	}
	const t = block.sourceText.trim();
	if (!t) {
		return false;
	}
	// Bare citation/reference markers.
	if (/^[[(]?\d+(\s*[,–—-]\s*\d+)*[\])]?[.,]?$/.test(t)) {
		return true;
	}
	// Tiny fragments of any kind.
	if (t.length <= 12) {
		return true;
	}
	// A torn-off continuation: starts lowercase mid-word/mid-sentence. LENGTH
	// IS NOT A REJECTION CRITERION — "least as robust, if not better, than
	// CT-based algorithms given…" is 70+ characters and is still unmistakably
	// the middle of someone else's sentence (an English paragraph never opens
	// in lowercase). The old ≤60 cap left exactly these long fragments as
	// independent blocks: translated alone, measured alone, stranded in
	// English inside a Chinese paragraph.
	return /^[a-z]/.test(t);
}

/**
 * Absorption is deliberately LOOSER than canMerge: a shard belongs to its
 * neighbour even when the font drifted (superscripts) or the gap is odd —
 * geometry only has to say "same column, adjacent-ish".
 */
export function canAbsorb(host: SourceBlock, shard: SourceBlock, obstacles: Rect[] = []): boolean {
	if (!isBodyBlock(host) || !host.lineRectsPdf?.length || !shard.lineRectsPdf?.length) {
		return false;
	}
	// Column stamps are authoritative here too — the 40% overlap test failed
	// open across the gutter once a host's union rect had grown full-width.
	if (typeof host.column === 'number' && typeof shard.column === 'number'
		&& host.column >= 0 && shard.column >= 0 && host.column !== shard.column) {
		return false;
	}
	const rh = unionRect(host.lineRectsPdf as Rect[]);
	const rs = unionRect(shard.lineRectsPdf as Rect[]);
	if (obstacleBetween(rh, rs, obstacles)) {
		return false;
	}
	// Same column at a relaxed 40%, or the shard sits inside the host's span.
	const overlap = Math.min(rh[2], rs[2]) - Math.max(rh[0], rs[0]);
	const narrower = Math.min(rh[2] - rh[0], rs[2] - rs[0]);
	if (narrower > 0 && overlap / narrower < 0.4) {
		return false;
	}
	const em = Math.max(host.fontSize ?? 10, 6);
	// Vertically adjacent or overlapping, up to 3em apart either way.
	const gap = Math.max(rh[1] - rs[3], rs[1] - rh[3]);
	// Length must not be a hard rejection for absorption: refusing strands the
	// continuation as a guaranteed-English fragment, which is strictly worse
	// than a somewhat oversized request. Bounded at 1.5× the region cap so a
	// pathological page can't build an unbounded block.
	if ((host.sourceText.length + shard.sourceText.length) > MAX_REGION_CHARS * 1.5) {
		return false;
	}
	return gap <= em * 3;
}

/**
 * 图注行碎片归位 (1.1.8) — 判据全部是几何与版式的,不看内容。
 *
 * 成因(Horst 2024 语料实测): `groupIntoParagraphs` 把「相对本栏左边距的
 * 缩进」当作硬断段信号 (paragraphHeuristics.shouldBreak)。期刊图注整体内缩
 * 排版 —— 第 4 页图 4 题注从 x=81 起排、第 5 页图 6 题注从 x=162 起排,而
 * 页面左边距是 x=48 —— 于是题注的每一行都被判成「新段落的首行」,首行之后
 * 全部断开。断开之后的碎片不以 "Figure N" 开头,classify 归成 paragraph,而
 * isBodyBlock 又规定 caption 永不参与合并 —— 同一条题注就此变成
 * 1 个 caption + 若干 paragraph,各自送翻译、各自排版、各自撑开,在图下方
 * 互相压印。第 5 页图 6 的题注被切成 4 块 (125/258/382/126 字符,
 * y 304.9–372.9),正是用户看到的那片压印。
 *
 * 几何审计看不见它: 拆出来的行盒本来就互相重叠,「只报新增侵入」的规则
 * (layoutSafety) 因此豁免了整片区域。所以修复必须落在这里 —— 从源头把一条
 * 题注还原成一块 —— 而不是放宽审计。
 *
 * 不要求碎片在阅读序里紧邻: 第 5 页的正文块 (block-5) 就插在图注碎片
 * 之间,所以这里对整页扫描,每轮取「紧贴在 host 下方」的那一块。
 */
export function canMergeCaption(host: SourceBlock, next: SourceBlock, obstacles: Rect[] = []): boolean {
	// 只有 caption 能当宿主;只有 paragraph/list 会是题注尾巴的误分类形态。
	if (host.type !== 'caption') {
		return false;
	}
	if (next.type !== 'paragraph' && next.type !== 'list') {
		return false;
	}
	if (!host.lineRectsPdf?.length || !next.lineRectsPdf?.length) {
		return false;
	}
	// "Figure 7:" 是下一张图的题注,不是这张的续行。
	if (FIGURE_LABEL_RE.test(next.sourceText.trim())) {
		return false;
	}
	// 列戳同样是权威的(与 canMerge 一致): 只在两侧都有真列号时才否决。
	if (typeof host.column === 'number' && typeof next.column === 'number'
		&& host.column >= 0 && next.column >= 0 && host.column !== next.column) {
		return false;
	}
	const rh = unionRect(host.lineRectsPdf as Rect[]);
	const rn = unionRect(next.lineRectsPdf as Rect[]);
	if (obstacleBetween(rh, rn, obstacles)) {
		return false;
	}
	const em = Math.max(host.fontSize ?? 8, 6);
	// 续行必须落在题注自己的横向跨度之内(容 1em 的排版抖动) —— 题注内缩
	// 排版,正文栏起点在它左边,这一条就挡住了图下方的正文。
	if (rn[0] < rh[0] - em || rn[2] > rh[2] + em) {
		return false;
	}
	// 用较窄的一方做分母: 题注的最后一行天然比首行短(第 4 页图 5 的尾行只有
	// 145pt 宽,而题注满宽 498pt —— 按较宽方算会误判成"不同列")。
	const overlap = Math.min(rh[2], rn[2]) - Math.max(rh[0], rn[0]);
	const narrower = Math.min(rh[2] - rh[0], rn[2] - rn[0]);
	if (!(narrower > 0) || overlap / narrower < 0.6) {
		return false;
	}
	// 必须紧接在下方 (PDF y 向上): 行距量级,不是段间距。
	const gap = rh[1] - rn[3];
	if (gap < -em * 1.2 || gap > em * 1.9) {
		return false;
	}
	// 字号必须一致 —— 期刊正文 10pt、图注 8pt,差 20%,这一条是挡住"图注吞掉
	// 下方正文"的主力。
	const fh = host.fontSize ?? 0;
	const fn = next.fontSize ?? 0;
	if (fh > 0 && fn > 0 && Math.abs(fh - fn) > Math.max(fh, fn) * 0.16) {
		return false;
	}
	// 字号恰好相同的版式里的最后一道闸: 题注已经写完一个句子时,候选必须
	// 自己是句中开头(小写/左括号),否则它多半是图下方另起的正文段。
	if (endsSentence(host.sourceText) && !/^[a-z([]/.test(next.sourceText.trim())) {
		return false;
	}
	return (host.sourceText.length + next.sourceText.length) <= MAX_REGION_CHARS;
}

/**
 * Coalesce a page's blocks into regions. Order is preserved; only
 * consecutive-in-reading-order body blocks merge, so a heading between two
 * paragraphs always splits them. Shards then get a second, looser pass:
 * anything that should never have been its own block is absorbed into the
 * nearest adjacent body region (previous first, next as fallback).
 */
export function coalesceRegions(blocks: SourceBlock[], obstacles: Rect[] = []): SourceBlock[] {
	const out: SourceBlock[] = [];
	for (const block of blocks) {
		const last = out[out.length - 1];
		if (last && canMerge(last, block, obstacles)) {
			out[out.length - 1] = mergeTwo(last, block);
		}
		else {
			out.push({ ...block });
		}
	}
	// 图注归位。必须跑在 shard 吸收之前 —— 题注的碎片又短又常以小写开头
	// (第 4 页 "was 0.59 mGy and effective dose was 0.46 mSv."、第 5 页
	// "counting detector scans (Flash + ultrahigh resolution…"), isShard 会
	// 把它们判成碎片、canAbsorb(不看字号)再把它们塞进图下方的正文段落里:
	// 题注文字污染正文,正文块的盒子还被拉到题注行上。先归位,shard 那一遍
	// 就看不到它们了。
	for (let i = 0; i < out.length; i++) {
		if (out[i]!.type !== 'caption') {
			continue;
		}
		for (;;) {
			// 每轮取「最靠上的合格候选」= 紧贴在 host 当前底边下方的那一块,
			// 这样多行题注按版面顺序一行一行长回去。
			let best = -1;
			let bestTop = -Infinity;
			for (let j = 0; j < out.length; j++) {
				if (j === i || !canMergeCaption(out[i]!, out[j]!, obstacles)) {
					continue;
				}
				const top = unionRect(out[j]!.lineRectsPdf as Rect[])[3];
				if (top > bestTop) {
					bestTop = top;
					best = j;
				}
			}
			if (best < 0) {
				break;
			}
			// 候选一定在 host 下方 (canMergeCaption 的 gap 判据), 所以
			// host+候选 的文本顺序总是对的, 与数组下标先后无关。
			out[i] = mergeTwo(out[i]!, out[best]!);
			out.splice(best, 1);
			if (best < i) {
				i--;
			}
		}
	}
	// Shard absorption. Backward into the previous region reads naturally
	// (citations follow the text they cite); forward is the fallback.
	for (let i = out.length - 1; i >= 0; i--) {
		const shard = out[i]!;
		if (!isShard(shard)) {
			continue;
		}
		const prev = out[i - 1];
		const next = out[i + 1];
		if (prev && canAbsorb(prev, shard, obstacles)) {
			out[i - 1] = mergeTwo(prev, shard);
			out.splice(i, 1);
		}
		else if (next && canAbsorb(next, shard, obstacles)) {
			out[i + 1] = mergeTwo(shard, next);
			out.splice(i, 1);
		}
	}
	// Re-number so ids stay unique and ordered after merging.
	return out.map((block, index) => ({
		...block,
		id: `page-${block.pageIndex}-region-${index}`,
		order: index
	}));
}
