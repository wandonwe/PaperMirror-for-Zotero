/**
 * Make the two sides of a layout-split source sentence actual translation
 * units, rather than optional understanding-only context. This changes only a
 * provider payload: display/source blocks and their geometries remain intact.
 */
import type { PlaceholderEntry, TranslationRequest, TranslationResponse } from '../types/models';

type Block = TranslationRequest['blocks'][number];
type Unit = NonNullable<Block['continuationUnit']>;
type VisibleChar = { char: string; end: number; depth: number };
type Stop = { end: number; safe: boolean };
type ParentPlan = { parent: Block; targetIds: string[]; requiredIds: string[]; separators: string[] };
type Part = { role: 'head' | 'middle' | 'tail' | 'whole'; text: string; start: number; end: number };
type RawPart = { rawText: string; protectedLiterals: PlaceholderEntry[] };

const MAX_FLAT_BLOCKS = 64;
const MAX_EXTRA_CHARS = 16000;
const MAX_CONTEXT_CHARS = 1800;
const MAX_UNIT_CHARS = 4800;
const CLOSERS = /[)\]}'"”’»」』⁰¹²³⁴⁵⁶⁷⁸⁹\uFFFC]/;
const SENTENCE_STARTER = /^(?:A|An|The|This|That|These|Those|It|We|They|He|She|Our|However|Therefore|Furthermore|Moreover|Nevertheless|In|For|After|Before|When|No|Neither|All|There|Both|Each|Results|Methods|Conclusions?|Discussion)\b/;

function abbreviation(text: string, index: number, end: number): boolean {
	const after = text.slice(end).trimStart(), before = text.slice(0, index + 1);
	if (!after) return false;
	if (/^[A-Za-z]\./.test(text.slice(index + 1))) return true;
	if (/\b(?:i\.e|e\.g|viz|cf|vs|resp)\.$/i.test(before)) return true;
	if (/\b(?:figs?|eqs?|refs?|secs?|vols?|nos?|pp?|chaps?|arts?|apps?|suppl)\.$/i.test(before)
		&& /^[([]?(?:[A-Z]?\d|[IVX]+\b|[A-Z]\b)/.test(after)) return true;
	const name = !SENTENCE_STARTER.test(after)
		&& /^(?:(?:[A-Z]\.)\s*)*(?:[A-Z][\p{Ll}\p{M}'’\-]+|(?:van|von|de|del|da|di)\s+[A-Z][\p{Ll}\p{M}'’\-]+)/u.test(after);
	if (name && (/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)\.$/i.test(before) || /\b[A-Z]\.$/.test(before))) return true;
	return /^[\p{Ll}\p{N},;:]/u.test(after)
		&& (/\b(?:et\s+al|etc|approx|ca|Inc|Ltd|Co|Ph\.D|M\.D|B\.Sc|M\.Sc|D\.Phil)\.$/i.test(before)
			|| /(?:\b[A-Za-z]\.){2,}$/.test(before));
}

/** Map readable characters back to atomic PM tokens and balanced style tags. */
function visibleCharacters(text: string): VisibleChar[] | null {
	const out: VisibleChar[] = [];
	const stack: string[] = [];
	for (let i = 0; i < text.length;) {
		if (text[i] === '⟦') {
			const end = text.indexOf('⟧', i + 1);
			if (end < 0) return null;
			const token = text.slice(i, end + 1);
			if (/^⟦PM\d+⟧$/.test(token)) {
				out.push({ char: '\uFFFC', end: end + 1, depth: stack.length });
			}
			else if (/^⟦[bi]⟧$/.test(token)) {
				if (stack.length) return null; // Matches the existing non-nested style contract.
				stack.push(token[1]!);
			}
			else if (/^⟦\/[bi]⟧$/.test(token)) {
				if (stack.pop() !== token[2]) return null;
				const prior = out[out.length - 1];
				if (prior) { prior.end = end + 1; prior.depth = stack.length; }
			}
			else return null;
			i = end + 1;
			continue;
		}
		if (text[i] === '⟧') return null;
		out.push({ char: text[i]!, end: i + 1, depth: stack.length });
		i++;
	}
	return stack.length ? null : out;
}

function sentenceStops(text: string): Stop[] | null {
	const chars = visibleCharacters(text);
	if (!chars) return null;
	const visible = chars.map(c => c.char).join('');
	const out: Stop[] = [];
	for (let i = 0; i < chars.length; i++) {
		const char = visible[i]!;
		if (!/[.!?。！？]/.test(char)) continue;
		if (char === '.' && /\d/.test(visible[i - 1] ?? '') && /\d/.test(visible[i + 1] ?? '')) continue;
		let end = i + 1;
		while (end < chars.length && CLOSERS.test(visible[end]!)) end++;
		if (char === '.' && abbreviation(visible, i, end)) continue;
		if (end < chars.length && !/\s/.test(visible[end]!)) continue;
		const boundary = chars[end - 1]!;
		out.push({ end: boundary.end, safe: boundary.depth === 0 });
	}
	return out;
}

function splitParts(block: Block): Part[] | null {
	const context = block.continuationContext;
	if (!context || typeof context.before !== 'string' || typeof context.after !== 'string') return null;
	const before = context.before.trim(), after = context.after.trim();
	if ((!before && !after) || before.length > MAX_CONTEXT_CHARS || after.length > MAX_CONTEXT_CHARS) return null;
	if (!visibleCharacters(before) || !visibleCharacters(after)) return null;
	const stops = sentenceStops(block.text);
	if (!stops || !block.text.trim()) return null;
	if (before && !after && !stops.length) return null;
	if (after && !before && !stops.length) {
		const visible = visibleCharacters(block.text)!.map(c => c.char).join('').trim();
		if (/^[“‘"'(\[]*[\p{Ll}\p{N}\uFFFC]/u.test(visible)) return null;
	}
	const first = stops[0], last = stops[stops.length - 1];
	if ((before && first && !first.safe) || (after && last && !last.safe)) return null;
	// A supplied successor for an already finished source sentence is ambiguous.
	if (after && last && !block.text.slice(last.end).trim()) return null;
	if (before && after && !stops.length) return [{ role: 'whole', text: block.text.trim(), start: 0, end: block.text.length }];
	const headEnd = before ? first?.end ?? block.text.length : 0;
	const tailStart = after ? last?.end ?? 0 : block.text.length;
	if (headEnd > tailStart) return null;
	const parts: Part[] = [];
	const add = (role: Part['role'], start: number, end: number): void => {
		const text = block.text.slice(start, end).trim();
		if (text) parts.push({ role, text, start, end });
	};
	if (before) add('head', 0, headEnd);
	add('middle', headEnd, tailStart);
	if (after) add('tail', tailStart, block.text.length);
	return parts.length ? parts : null;
}

function weight(block: Block): number {
	return block.text.length + (block.continuationUnit?.source.length ?? 0)
		+ (block.continuationContext?.before.length ?? 0) + (block.continuationContext?.after.length ?? 0);
}

/** Restore this parent's token scope without consuming style tags or borrowing
 * another parent's PM numbering. No unresolved or ambiguous token may form a
 * shared sentence identity. Replacement is one-pass, so literal token-looking
 * text cannot accidentally be decoded recursively. */
function rawPart(text: string, entries: PlaceholderEntry[] | undefined): RawPart | null {
	const tokens = new Set(text.match(/⟦PM\d+⟧/g) ?? []);
	const byToken = new Map<string, PlaceholderEntry>();
	for (const entry of entries ?? []) {
		if (!tokens.has(entry.token)) continue;
		if (!/^⟦PM\d+⟧$/.test(entry.token) || typeof entry.original !== 'string'
			|| !entry.original || byToken.has(entry.token)) return null;
		byToken.set(entry.token, entry);
	}
	if ([...tokens].some(token => !byToken.has(token))) return null;
	const rawText = text.replace(/⟦PM\d+⟧/g, token => byToken.get(token)!.original);
	if (!visibleCharacters(rawText)) return null;
	return { rawText, protectedLiterals: [...byToken.values()].map(entry => ({ ...entry })) };
}

function identity(request: TranslationRequest): { request: TranslationRequest; restore(response: TranslationResponse): TranslationResponse } {
	return { request, restore: response => response };
}

/** Bounded, one-request planning; it does not call a provider or create retries. */
export function planContinuationRequest(request: TranslationRequest): {
	request: TranslationRequest;
	restore(response: TranslationResponse): TranslationResponse;
} {
	if (!request.blocks.some(b => b.continuationContext?.before || b.continuationContext?.after)
		|| request.blocks.some(b => b.continuationUnit) || request.blocks.length > MAX_FLAT_BLOCKS) return identity(request);
	const used = new Set(request.blocks.map(b => b.id));
	if (used.size !== request.blocks.length) return identity(request);
	let sequence = 0, unitSequence = 0;
	const allocate = (): string => {
		let id: string;
		do { id = `__pm_cont_${(sequence++).toString(36)}`; } while (used.has(id));
		used.add(id);
		return id;
	};
	const flat: Block[] = [];
	const plans = new Map<string, ParentPlan>();
 const deferred = new Set<string>();
	let count = request.blocks.length;
	let extra = 0;
	for (const block of request.blocks) {
		const parts = splitParts(block);
		if (!parts) { flat.push(block); continue; }
		const context = block.continuationContext!;
		const { charBudget, continuationContext: _context, continuationUnit: _unit,
			sourceText: _sourceText, rawText: _rawText, protectedLiterals: _protectedLiterals, ...base } = block;
		const expanded: Block[] = [];
		const targetIds: string[] = [], requiredIds: string[] = [], separators: string[] = [];
		let previousPart: Part | undefined;
		let safe = true;
		for (const part of parts) {
			const raw = rawPart(part.text, block.protectedLiterals);
			if (!raw) { safe = false; break; }
			const targetId = allocate();
			targetIds.push(targetId);
			if (previousPart) {
				const between = block.text.slice(previousPart.end, part.start)
					+ (block.text.slice(part.start, part.end).match(/^\s*/)?.[0] ?? '');
				separators.push(/\n\s*\n/.test(between) ? '\n\n' : ' ');
			}
			previousPart = part;
			if (part.role === 'middle') {
				const share = typeof charBudget === 'number' && Number.isFinite(charBudget) && charBudget > 0
					? Math.floor(charBudget * part.text.length / Math.max(1, block.text.length)) : undefined;
				const budget = share !== undefined && share >= 24 ? share : undefined;
				expanded.push({ ...base, id: targetId, text: part.text, ...raw, ...(budget === undefined ? {} : { charBudget: budget }) });
				requiredIds.push(targetId);
				continue;
			}
			const sourceParts: { id: string; text: string; rawText: string; protectedLiterals: PlaceholderEntry[] }[] = [];
			if (part.role === 'head' || part.role === 'whole') {
				const text = context.before.trim();
				sourceParts.push({ id: allocate(), text, rawText: text, protectedLiterals: [] });
			}
			sourceParts.push({ id: targetId, text: part.text, ...raw });
			if (part.role === 'tail' || part.role === 'whole') {
				const text = context.after.trim();
				sourceParts.push({ id: allocate(), text, rawText: text, protectedLiterals: [] });
			}
			const source = sourceParts.map(p => p.rawText).join(' ');
			if (source.length > MAX_UNIT_CHARS) { safe = false; break; }
			const unitId = `__pm_unit_${(unitSequence++).toString(36)}`;
			for (const [index, sourcePart] of sourceParts.entries()) {
				const unit: Unit = { id: unitId, partIndex: index, parts: sourceParts.length, source };
				expanded.push({ ...base, ...sourcePart, continuationUnit: unit });
				requiredIds.push(sourcePart.id);
			}
		}
		const growth = expanded.reduce((sum, b) => sum + weight(b), 0) - weight(block);
		if (!safe) {
			flat.push(block);
			continue;
		}
  if (count + expanded.length - 1 > MAX_FLAT_BLOCKS || extra + growth > MAX_EXTRA_CHARS) {
   // A crowded batch must not silently earn a context-only translation under
   // the joint-unit cache identity. Retry this parent in a smaller request.
   deferred.add(block.id); flat.push(block); continue;
  }
		count += expanded.length - 1;
		extra += growth;
		flat.push(...expanded);
		plans.set(block.id, { parent: block, targetIds, requiredIds, separators });
	}
	if (!plans.size && !deferred.size) return identity(request);
	const planned = plans.size ? { ...request, plain: false, blocks: flat } : request;
	return {
		request: planned,
		restore(response): TranslationResponse {
			const rows = new Map<string, typeof response.translations>();
			for (const row of response.translations) {
				const group = rows.get(row.id) ?? [];
				group.push(row);
				rows.set(row.id, group);
			}
			const translations: TranslationResponse['translations'] = [];
			for (const original of request.blocks) {
    if (deferred.has(original.id)) continue;
				const plan = plans.get(original.id);
				if (!plan) { translations.push(...(rows.get(original.id) ?? [])); continue; }
				// Every joint part, including the borrowed side, must actually have
				// been translated once. Incomplete units fall into the existing retry
				// chain; their target fragments must not masquerade as a full parent.
				if (!plan.requiredIds.every(id => rows.get(id)?.length === 1
					&& typeof rows.get(id)![0]!.translatedText === 'string' && rows.get(id)![0]!.translatedText.trim())) continue;
				const text = plan.targetIds.map((id, index) =>
					(index ? plan.separators[index - 1] : '') + rows.get(id)![0]!.translatedText.trim()).join('');
				if (text) translations.push({ id: original.id, translatedText: text });
			}
			return { ...response, translations };
		}
	};
}
