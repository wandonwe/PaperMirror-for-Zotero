/** Session-local, bounded shared translations of complete source sentences. */
import { PaperMirrorError, type GlossaryRule, type PlaceholderEntry, type TranslationRequest, type TranslationResponse } from '../types/models';
import { planContinuationRequest } from './continuationRequest';
import { PlaceholderRegistry } from './placeholderRegistry';
import { fnv1a64 } from '../cache/cacheSchema';
import { technicalUnitIssue } from './technicalUnits';
import { numericPowerIssue } from './numericPowers';
import * as logger from '../utils/logger';

type Block = TranslationRequest['blocks'][number];
type Usage = NonNullable<TranslationResponse['usage']>;
type RawTranslator = (request: TranslationRequest, signal: AbortSignal) => Promise<TranslationResponse>;
type Options = {
	noTranslate?: string[];
	glossary?: GlossaryRule[];
	readUnit?(key: string): Promise<string[] | null>;
	writeUnit?(key: string, rawTranslations: string[]): Promise<void>;
	onProgress?(): void;
};
type Group = { source: string; parts: Block[] };
type UnitResult = { texts: string[]; usage?: Usage; fromDisk?: boolean };
type Entry = {
	key: string; promise: Promise<UnitResult>; controller: AbortController; waiters: number;
	state: 'pending' | 'fulfilled'; owner: symbol; usageDelivered: boolean;
	callers: Map<symbol, { translateRaw: RawTranslator; signal: AbortSignal; pageIndex?: number }>;
};

const MAX_UNITS = 256;
const TOKEN = /⟦PM\d+⟧/g;
const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
const canonical = (text: string): string => text.replace(/⟦\/?[bi]⟧/g, '').trim().replace(/\s+/g, ' ');
const cancelled = (): PaperMirrorError => new PaperMirrorError('CANCELLED', 'cancelled');
const invalid = (): PaperMirrorError => new PaperMirrorError('BAD_RESPONSE', 'Incomplete shared sentence translation');

function progress(options: Options): void {
	try { options.onProgress?.(); } catch { /* Observers cannot invalidate translated content. */ }
}

function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

function rawText(block: Block): string {
	if (typeof block.rawText === 'string') return block.rawText;
	const entries = new Map((block.protectedLiterals ?? []).map(p => [p.token, p.original]));
	return block.text.replace(TOKEN, token => {
		const original = entries.get(token);
		if (original === undefined) throw invalid();
		return original;
	});
}

function stripInternal(request: TranslationRequest): TranslationRequest {
	let changed = false;
	const blocks = request.blocks.map(block => {
		if (block.rawText === undefined && block.sourceText === undefined && block.protectedLiterals === undefined) return block;
		changed = true;
		const { rawText: _raw, sourceText: _source, protectedLiterals: _literals, ...sent } = block;
		return sent;
	});
	return changed ? { ...request, blocks } : request;
}

function groupUnits(blocks: Block[]): Group[] {
	const groups = new Map<string, Block[]>();
	for (const block of blocks) {
		if (!block.continuationUnit) continue;
		const group = groups.get(block.continuationUnit.id) ?? [];
		group.push(block); groups.set(block.continuationUnit.id, group);
	}
	return [...groups.values()].map(parts => {
		parts.sort((a, b) => a.continuationUnit!.partIndex - b.continuationUnit!.partIndex);
		const unit = parts[0]!.continuationUnit!;
		if (unit.parts < 2 || unit.parts > 3 || parts.length !== unit.parts
			|| parts.some((part, index) => part.continuationUnit!.parts !== unit.parts
				|| part.continuationUnit!.partIndex !== index
				|| canonical(part.continuationUnit!.source) !== canonical(unit.source))) throw invalid();
		const source = parts.map(rawText).join(' ');
		if (canonical(source) !== canonical(unit.source)) throw invalid();
		return { source, parts };
	});
}

function matchingGlossary(request: TranslationRequest, source: string, options: Options): GlossaryRule[] {
	const haystack = canonical(source).toLowerCase(), seen = new Set<string>();
	return [...(options.glossary ?? []), ...(request.glossary ?? [])].filter(rule => {
		const key = rule.source.trim().toLowerCase();
		if (!key || seen.has(key) || !haystack.includes(key)) return false;
		seen.add(key); return true;
	});
}

function unitKey(group: Group, request: TranslationRequest, glossary: GlossaryRule[], options: Options, namespace?: string): string {
	return 'continuation-unit-v3:' + fnv1a64(JSON.stringify(['PaperMirror.shared-sentence.v3', namespace ?? null,
		request.sourceLanguage, request.targetLanguage, canonical(group.source),
		group.parts.map(part => canonical(rawText(part))),
		// An explicit stable configuration namespace covers user glossary changes
		// without treating evolving document-memory suggestions as a new sentence.
		namespace === undefined ? glossary.map(r => [r.source, r.target, r.mode]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : null,
		namespace === undefined ? [...(options.noTranslate ?? [])].sort() : null]));
}

function numericInventory(text: string): string {
	return JSON.stringify((canonical(text).match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d+(?:[.,]\d+)*(?:[eE][+−-]?\d+)?/g) ?? []).sort());
}

type IntegrityReason = 'part-count' | 'empty-or-invalid-text' | 'raw-placeholder-residue'
	| 'numeric-inventory' | 'technical-unit' | 'technical-unit-value' | 'numeric-power'
	| 'placeholder-reencode' | 'placeholder-validation';

function validateRawTexts(group: Group, registries: PlaceholderRegistry[], texts: unknown, warnFresh = false): texts is string[] {
	const reject = (reason: IntegrityReason, partIndex: number): false => {
		if (warnFresh) logger.warn('continuationUnitStore', `unit-integrity:${reason};partIndex:${partIndex}`);
		return false;
	};
	if (!Array.isArray(texts) || texts.length !== group.parts.length) return reject('part-count', -1);
	return texts.every((text, index) => {
		if (typeof text !== 'string' || !text.trim()) return reject('empty-or-invalid-text', index);
		if (/⟦PM\d+⟧/.test(text)) return reject('raw-placeholder-residue', index);
		const source = rawText(group.parts[index]!);
		if (numericInventory(source) !== numericInventory(text)) return reject('numeric-inventory', index);
		const technical = technicalUnitIssue(source, text);
		if (technical) return reject(technical, index);
		if (numericPowerIssue(source, text)) return reject('numeric-power', index);
		const registry = registries[index]!;
		try {
			const encoded = encodeForCaller(text, { id: '', type: 'paragraph', text: registry.text, protectedLiterals: registry.entries });
			return registry.ok(encoded) || reject('placeholder-validation', index);
		}
		catch { return reject('placeholder-reencode', index); }
	});
}

/** Encode only this caller's protected literals, using its own PM numbers. */
function encodeForCaller(text: string, block: Block): string {
	const entries = new Map<string, string>();
	for (const entry of block.protectedLiterals ?? []) {
		const prior = entries.get(entry.token);
		if (prior !== undefined && prior !== entry.original) throw invalid();
		entries.set(entry.token, entry.original);
	}
	const needed = new Map<string, string[]>();
	for (const token of block.text.match(TOKEN) ?? []) {
		const original = entries.get(token);
		if (!original) throw invalid();
		const list = needed.get(original) ?? []; list.push(token); needed.set(original, list);
	}
	if (!needed.size) return text;
	const originals = [...needed.keys()].sort((a, b) => b.length - a.length);
	const pattern = new RegExp(originals.map(original => original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
	let extra = false;
	const encoded = text.replace(pattern, original => {
		const token = needed.get(original)?.shift();
		if (!token) { extra = true; return original; }
		return token;
	});
	if (extra || [...needed.values()].some(list => list.length)) throw invalid();
	return encoded;
}

export class ContinuationUnitStore {
	private units = new Map<string, Entry>();
	private lifecycle = new AbortController();
	private generation = 0;

	clear(): void {
		this.generation++;
		this.lifecycle.abort(); this.lifecycle = new AbortController();
		for (const entry of this.units.values()) entry.controller.abort();
		this.units.clear();
	}

	/** One child call; each translate invocation awaits its children serially.
	 * Independent logical requests keep the host request gate's concurrency. */
	private enqueue(request: TranslationRequest, translateRaw: RawTranslator, signal: AbortSignal, generation: number): Promise<TranslationResponse> {
		const lifetime = this.lifecycle.signal;
		const task = Promise.resolve().then(async () => {
			checkSignal(signal);
			if (lifetime.aborted || generation !== this.generation) throw cancelled();
			const controller = new AbortController();
			const abort = (): void => controller.abort();
			signal.addEventListener('abort', abort, { once: true });
			lifetime.addEventListener('abort', abort, { once: true });
			try {
				checkSignal(signal);
				const response = await translateRaw(stripInternal(request), controller.signal);
				if (controller.signal.aborted || generation !== this.generation) throw cancelled();
				return response;
			}
			finally {
				signal.removeEventListener('abort', abort); lifetime.removeEventListener('abort', abort);
			}
		});
		return task;
	}

	private prune(): void {
		for (const [key, entry] of this.units) {
			if (this.units.size < MAX_UNITS) break;
			if (entry.state === 'fulfilled') this.units.delete(key);
		}
		if (this.units.size >= MAX_UNITS) throw invalid();
	}

	private entry(group: Group, request: TranslationRequest, translateRaw: RawTranslator, owner: symbol, callerSignal: AbortSignal, namespace: string | undefined, options: Options): Entry {
		const glossary = matchingGlossary(request, group.source, options);
		const key = unitKey(group, request, glossary, options, namespace);
		const prior = this.units.get(key);
		if (prior && !prior.controller.signal.aborted) {
			if (prior.state === 'pending') prior.callers.set(owner, { translateRaw, signal: callerSignal, pageIndex: request.pageIndex });
			this.units.delete(key); this.units.set(key, prior); return prior;
		}
		if (prior) this.units.delete(key);
		this.prune();
		const registries = group.parts.map(part => PlaceholderRegistry.protect(rawText(part),
			[...(options.noTranslate ?? []), ...(part.protectedLiterals ?? []).map(entry => entry.original),
				...(rawText(part).match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g) ?? [])].filter(Boolean)));
		const unitRequest: TranslationRequest = {
			...request, plain: false, previousContext: '', moduleContext: undefined, glossary,
			blocks: group.parts.map((part, index) => ({
				id: `__pm_shared_part_${index}`, type: part.type, text: registries[index]!.text,
				continuationUnit: { id: '__pm_shared_sentence', partIndex: index, parts: group.parts.length, source: group.source }
			}))
		};
		const controller = new AbortController(), generation = this.generation;
		const entry: Entry = { key, promise: undefined as unknown as Promise<UnitResult>, controller,
			waiters: 0, state: 'pending', owner, usageDelivered: false,
			callers: new Map([[owner, { translateRaw, signal: callerSignal, pageIndex: request.pageIndex }]]) };
		entry.promise = (async (): Promise<UnitResult> => {
			const saved = await options.readUnit?.(key).catch(() => null);
			checkSignal(controller.signal);
			if (generation !== this.generation) throw cancelled();
			if (validateRawTexts(group, registries, saved)) {
				entry.state = 'fulfilled'; entry.callers.clear(); return { texts: [...saved], fromDisk: true };
			}
			const execute: RawTranslator = (payload, activeSignal) => {
				const live = [...entry.callers].find(([, caller]) => !caller.signal.aborted);
				if (!live) throw cancelled();
				entry.owner = live[0];
				return live[1].translateRaw({ ...payload, pageIndex: live[1].pageIndex }, activeSignal);
			};
			const response = await this.enqueue(unitRequest, execute, controller.signal, generation);
			const texts = unitRequest.blocks.map((part, index) => {
				const rows = response.translations.filter(row => row.id === part.id);
				if (rows.length !== 1 || !rows[0]!.translatedText?.trim() || !registries[index]!.ok(rows[0]!.translatedText)) throw invalid();
				return registries[index]!.restore(rows[0]!.translatedText);
			});
			if (!validateRawTexts(group, registries, texts, true)) throw invalid();
			checkSignal(controller.signal);
			if (generation !== this.generation) throw cancelled();
			// A production caller persists the entire verified unit before any
			// parent-page translation can become durable on its own.
			await options.writeUnit?.(key, [...texts]);
			checkSignal(controller.signal);
			if (generation !== this.generation) throw cancelled();
			entry.state = 'fulfilled';
			entry.callers.clear();
			return { texts, usage: response.usage };
		})().catch(error => {
			if (this.units.get(key) === entry) this.units.delete(key);
			throw error;
		});
		void entry.promise.catch(() => undefined);
		this.units.set(key, entry);
		return entry;
	}

	private wait(entry: Entry, signal: AbortSignal, owner: symbol): Promise<UnitResult> {
		checkSignal(signal); entry.waiters++;
		return new Promise((resolve, reject) => {
			let released = false;
			const release = (): void => {
				if (released) return;
				released = true; entry.waiters--; entry.callers.delete(owner);
				signal.removeEventListener('abort', abort); entry.controller.signal.removeEventListener('abort', abort);
			};
			const abort = (): void => {
				release();
				if (!entry.waiters && entry.state === 'pending') {
					entry.controller.abort();
					if (this.units.get(entry.key) === entry) this.units.delete(entry.key);
				}
				reject(cancelled());
			};
			signal.addEventListener('abort', abort, { once: true });
			entry.controller.signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted || entry.controller.signal.aborted) { abort(); return; }
			entry.promise.then(value => { if (signal.aborted) abort(); else { release(); resolve(value); } }, error => { release(); reject(error); });
		});
	}

	async translate(request: TranslationRequest, translateRaw: RawTranslator, signal: AbortSignal, namespace?: string, options: Options = {}): Promise<TranslationResponse> {
		checkSignal(signal);
		const plan = planContinuationRequest(request), groups = groupUnits(plan.request.blocks);
		if (!groups.length) {
			const response = await this.enqueue(plan.request, translateRaw, signal, this.generation);
			progress(options); return plan.restore(response);
		}
		const owner = Symbol('sentence caller'), generation = this.generation;
		let freshRawCalls = 0, usageMissing = false;
		const usage = zeroUsage();
		const freshTranslate: RawTranslator = async (payload, activeSignal) => {
			freshRawCalls++; return translateRaw(payload, activeSignal);
		};
		const addUsage = (value: Usage | undefined): void => {
			if (!value) { usageMissing = true; return; }
			usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens; usage.cachedInputTokens += value.cachedInputTokens;
		};
		const translated: TranslationResponse['translations'] = [];
		for (const group of groups) {
			checkSignal(signal);
			if (generation !== this.generation) throw cancelled();
			const entry = this.entry(group, plan.request, freshTranslate, owner, signal, namespace, options);
			const result = await this.wait(entry, signal, owner);
			progress(options);
			if (entry.owner === owner && !entry.usageDelivered) { entry.usageDelivered = true; if (!result.fromDisk) addUsage(result.usage); }
			try {
				for (const [index, part] of group.parts.entries()) translated.push({ id: part.id, translatedText: encodeForCaller(result.texts[index]!, part) });
			}
			catch (error) { if (this.units.get(entry.key) === entry) this.units.delete(entry.key); throw error; }
		}
		const ordinary = plan.request.blocks.filter(block => !block.continuationUnit);
		if (ordinary.length) {
			const response = await this.enqueue({ ...plan.request, blocks: ordinary }, freshTranslate, signal, generation);
			progress(options);
			translated.push(...response.translations); addUsage(response.usage);
		}
		checkSignal(signal);
		if (generation !== this.generation) throw cancelled();
		return plan.restore({ translations: translated,
			...(freshRawCalls === 0 ? { cacheOnly: true, usage: zeroUsage() } : { usage: usageMissing ? undefined : usage }) });
	}
}
