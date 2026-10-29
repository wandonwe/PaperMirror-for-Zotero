import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaceholderEntry, TranslationRequest, TranslationResponse } from '../../src/types/models';
import { ContinuationUnitStore } from '../../src/translation/continuationUnitStore';
import { recentProblems } from '../../src/utils/logger';

type Raw = (request: TranslationRequest, signal: AbortSignal) => Promise<TranslationResponse>;
const signal = (): AbortSignal => new AbortController().signal;
const usage = { inputTokens: 10, outputTokens: 6, cachedInputTokens: 2 };
function request(id: string, text: string, before = '', after = '', literals: PlaceholderEntry[] = []): TranslationRequest {
	const raw = text.replace(/⟦PM\d+⟧/g, token => literals.find(entry => entry.token === token)!.original);
	return { sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 'Independent fixture', pageIndex: 0, previousContext: '',
		blocks: [{ id, type: 'paragraph', text, sourceText: raw, protectedLiterals: literals,
			...((before || after) ? { continuationContext: { before, after } } : {}) }] };
}
function pair(left = 'Baseline measurements were recorded before treatment', right = 'and/or another agent was administered.'): [TranslationRequest, TranslationRequest] {
	return [request('left', left, '', right), { ...request('right', right, left), pageIndex: 1 }];
}
const echo = (payload: TranslationRequest): TranslationResponse => ({ translations: payload.blocks.map(b => ({ id: b.id, translatedText: b.text })), usage });
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
const cancelled = (error: unknown): boolean => (error as { code?: string }).code === 'CANCELLED';

test('opposite display fragments share one actual translation of all sentence parts', async () => {
	const store = new ContinuationUnitStore(), [left, right] = pair(); let calls = 0;
	const raw: Raw = async payload => {
		calls++; assert.equal(payload.blocks.length, 2);
		return { translations: payload.blocks.map((b, i) => ({ id: b.id, translatedText: i ? '并/或给予另一药物之前测量基线指标。' : '在给予治疗' })), usage };
	};
	const a = await store.translate(left, raw, signal()), b = await store.translate(right, raw, signal());
	assert.equal(calls, 1);
	assert.equal(a.translations[0]!.translatedText + b.translations[0]!.translatedText, '在给予治疗并/或给予另一药物之前测量基线指标。');
	assert.deepEqual(a.usage, usage); assert.deepEqual(b.usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
	assert.equal(b.cacheOnly, true); assert.notEqual(a.cacheOnly, true);
});

test('concurrent opposite requests share one promise and count fresh usage once', async () => {
	const store = new ContinuationUnitStore(), [left, right] = pair(); let calls = 0;
	const raw: Raw = async payload => { calls++; await Promise.resolve(); return echo(payload); };
	const results = await Promise.all([store.translate(left, raw, signal()), store.translate(right, raw, signal())]);
	assert.equal(calls, 1);
	assert.equal(results.reduce((n, r) => n + r.usage!.inputTokens, 0), 10);
	assert.equal(results.filter(r => r.cacheOnly).length, 1);
});

test('raw source identity survives different parent IDs, page indexes and PM numbering', async () => {
	const store = new ContinuationUnitStore(); let calls = 0;
	const leftRaw = 'The mean dose was 3 mGy before', rightRaw = 'the baseline acquisition.';
	const first = request('first', 'The mean dose was ⟦PM8⟧ before', '', rightRaw, [{ token: '⟦PM8⟧', original: '3 mGy' }]);
	const second = { ...request('different-page-id', 'The mean dose was ⟦PM0⟧ before', '', rightRaw, [{ token: '⟦PM0⟧', original: '3 mGy' }]), pageIndex: 10 };
	const raw: Raw = async payload => { calls++; assert.ok(payload.blocks.some(b => b.continuationUnit?.source === `${leftRaw} ${rightRaw}`)); return echo(payload); };
	assert.match((await store.translate(first, raw, signal())).translations[0]!.translatedText, /⟦PM8⟧/);
	const restored = await store.translate(second, raw, signal());
	assert.equal(restored.translations[0]!.translatedText, second.blocks[0]!.text);
	assert.equal(restored.cacheOnly, true); assert.equal(calls, 1);
});

test('known style markers do not create a second semantic source identity', async () => {
	const store = new ContinuationUnitStore(); let calls = 0;
	const [styled] = pair('⟦b⟧Baseline measurements⟦/b⟧ were recorded before treatment');
	const [plain] = pair();
	const raw: Raw = async payload => { calls++; return echo(payload); };
	await store.translate(styled, raw, signal());
	await store.translate(plain, raw, signal());
	assert.equal(calls, 1);
});

test('unit re-protection and provider dispatch never leak internal provenance fields', async () => {
	const store = new ContinuationUnitStore();
	const left = request('left', 'The mean dose was ⟦PM8⟧ before', '', 'the baseline acquisition.', [{ token: '⟦PM8⟧', original: '33 mGy' }]);
	await store.translate(left, async payload => {
		assert.equal(payload.plain, false);
		for (const part of payload.blocks) {
			assert.equal('rawText' in part, false); assert.equal('sourceText' in part, false); assert.equal('protectedLiterals' in part, false);
			assert.equal(part.continuationContext, undefined);
		}
		assert.match(payload.blocks[0]!.text, /⟦PM\d+⟧/);
		assert.ok(!payload.blocks[0]!.text.includes('33'));
		return echo(payload);
	}, signal());
});

test('ordinary and middle parts use the ordinary batch while unit calls remain at most three parts', async () => {
	const store = new ContinuationUnitStore(); let unitCalls = 0, normalCalls = 0;
	const req = request('parent', 'the first result. A middle result was complete. The last result was not', 'The study included', 'detected.');
	req.blocks.push({ id: 'ordinary', type: 'paragraph', text: 'An ordinary paragraph.' });
	const result = await store.translate(req, async payload => {
		if (payload.blocks[0]!.continuationUnit) { unitCalls++; assert.ok(payload.blocks.length <= 3); }
		else { normalCalls++; assert.equal(payload.blocks.length, 2); }
		return echo(payload);
	}, signal());
	assert.equal(unitCalls, 2); assert.equal(normalCalls, 1);
	assert.deepEqual(result.translations.map(t => t.id), ['parent', 'ordinary']);
	assert.equal(result.usage!.inputTokens, 30);
});

test('one logical request never starts concurrent unit/middle raw calls', async () => {
	const store = new ContinuationUnitStore(); let active = 0, maxActive = 0;
	const raw: Raw = async payload => { active++; maxActive = Math.max(active, maxActive); await Promise.resolve(); active--; return echo(payload); };
	await store.translate(request('parent', 'the first result. A middle result was complete. The last result was not', 'The study included', 'detected.'), raw, signal());
	assert.equal(maxActive, 1);
});

test('stable namespace shares evolving document suggestions but explicit configuration changes isolate units', async () => {
	const store = new ContinuationUnitStore(), [left, right] = pair(); let calls = 0;
	left.glossary = [{ source: 'measurements', target: '测量', mode: 'suggested' }];
	right.glossary = [{ source: 'measurements', target: '测量指标', mode: 'suggested' }];
	const raw: Raw = async payload => { calls++; return echo(payload); };
	await store.translate(left, raw, signal(), 'settings-a');
	await store.translate(right, raw, signal(), 'settings-a'); assert.equal(calls, 1);
	await store.translate(right, raw, signal(), 'settings-b'); assert.equal(calls, 2);
	const separate = new ContinuationUnitStore(); calls = 0;
	await separate.translate(left, raw, signal()); await separate.translate(right, raw, signal()); assert.equal(calls, 2);
});

test('full configured glossary and no-translate rules also cover the borrowed sentence side', async () => {
	const store = new ContinuationUnitStore(), [left] = pair('The finding was compared with', 'RetainWord in the independent cohort.');
	await store.translate(left, async payload => {
		assert.equal(payload.glossary?.[0]?.target, '独立队列');
		assert.ok(!payload.blocks[1]!.text.includes('RetainWord'));
		return echo(payload);
	}, signal(), 'settings', { noTranslate: ['RetainWord'], glossary: [{ source: 'independent cohort', target: '独立队列', mode: 'required' }] });
});

test('complete unit persistence restores the opposite page in a new store with zero HTTP calls', async () => {
	const disk = new Map<string, string[]>(); let calls = 0;
	const options = { readUnit: async (key: string) => disk.get(key) ?? null, writeUnit: async (key: string, texts: string[]) => { disk.set(key, texts); } };
	const [left, right] = pair(); const raw: Raw = async payload => { calls++; return echo(payload); };
	await new ContinuationUnitStore().translate(left, raw, signal(), 'stable-settings', options);
	const hit = await new ContinuationUnitStore().translate(right, raw, signal(), 'stable-settings', options);
	assert.equal(calls, 1); assert.equal(disk.size, 1); assert.equal(hit.cacheOnly, true);
	assert.deepEqual(hit.usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
	const key = [...disk.keys()][0]!;
	assert.match(key, /^continuation-unit-v3:[a-f0-9]{16}$/); assert.ok(!/left|right|PM|page|provider/.test(key));
});

test('corrupt persisted arrays, PM residue and altered numbers/units are cache misses', async () => {
	const [left] = pair('The mean dose was 33 mGy before', 'the baseline acquisition.');
	for (const saved of [['incomplete'], ['The mean dose was 34 mGy before', 'the baseline acquisition.'],
		['The mean dose was 33 keV before', 'the baseline acquisition.'], ['⟦PM0⟧', 'the baseline acquisition.']]) {
		let calls = 0;
		await new ContinuationUnitStore().translate(left, async payload => { calls++; return echo(payload); }, signal(), 'settings', { readUnit: async () => saved });
		assert.equal(calls, 1, JSON.stringify(saved));
	}
});

test('fresh unit numeric/placeholder corruption cannot become shared or durable content', async () => {
	const store = new ContinuationUnitStore(), [left] = pair('The mean dose was 33 mGy before', 'the baseline acquisition.'); let writes = 0, calls = 0;
	const raw: Raw = async payload => { calls++; return { translations: payload.blocks.map(b => ({ id: b.id, translatedText: b.text.replace(/⟦PM\d+⟧/g, '34') })) }; };
	const options = { writeUnit: async () => { writes++; } };
	await assert.rejects(store.translate(left, raw, signal(), 'settings', options));
	await assert.rejects(store.translate(left, raw, signal(), 'settings', options));
	assert.equal(calls, 2); assert.equal(writes, 0);
});

test('all unit parts must be unique and nonempty before sharing or persistence', async () => {
	for (const mode of ['missing', 'duplicate', 'empty']) {
		const store = new ContinuationUnitStore(), [left] = pair(); let writes = 0;
		await assert.rejects(store.translate(left, async payload => {
			const out = echo(payload);
			if (mode === 'missing') out.translations.pop();
			if (mode === 'duplicate') out.translations.push(out.translations[0]!);
			if (mode === 'empty') out.translations[0]!.translatedText = '';
			return out;
		}, signal(), 'settings', { writeUnit: async () => { writes++; } }));
		assert.equal(writes, 0, mode);
	}
});

test('unit write completes before any parent response and write failure is not a durable success', async () => {
	const started = deferred<void>(), finish = deferred<void>(), [left] = pair(); let settled = false;
	const pending = new ContinuationUnitStore().translate(left, async payload => echo(payload), signal(), 'settings', {
		writeUnit: async () => { started.resolve(); await finish.promise; }
	}).then(value => { settled = true; return value; });
	await started.promise; assert.equal(settled, false); finish.resolve(); await pending;
	const store = new ContinuationUnitStore(); let calls = 0;
	const options = { writeUnit: async () => { throw new Error('disk unavailable'); } };
	for (let i = 0; i < 2; i++) await assert.rejects(store.translate(left, async payload => { calls++; return echo(payload); }, signal(), 'settings', options));
	assert.equal(calls, 2);
});

test('one cancelled waiter cannot cancel a shared call still needed by another page', async () => {
	const store = new ContinuationUnitStore(), [left, right] = pair(), a = new AbortController(), b = new AbortController();
	const started = deferred<void>(), finish = deferred<TranslationResponse>(); let payload!: TranslationRequest, active!: AbortSignal, calls = 0;
	const raw: Raw = async (request, sig) => { calls++; payload = request; active = sig; started.resolve(); return finish.promise; };
	const first = store.translate(left, raw, a.signal); await started.promise;
	const second = store.translate(right, raw, b.signal); a.abort(); await assert.rejects(first, cancelled);
	assert.equal(active.aborted, false); finish.resolve(echo(payload));
	assert.equal((await second).cacheOnly, true); assert.equal(calls, 1);
});

test('owner cancellation during lookup transfers execution and usage hooks to a still-live shared waiter', async () => {
	const store = new ContinuationUnitStore(), [left, right] = pair(), a = new AbortController(), b = new AbortController();
	const lookup = deferred<string[] | null>();
	const options = { readUnit: () => lookup.promise };
	let aCalls = 0, bCalls = 0;
	const first = store.translate(left, async payload => { aCalls++; return echo(payload); }, a.signal, 'settings', options);
	const second = store.translate(right, async payload => { bCalls++; assert.equal(payload.pageIndex, 1); return echo(payload); }, b.signal, 'settings', options);
	a.abort(); await assert.rejects(first, cancelled); lookup.resolve(null);
	const result = await second; assert.equal(aCalls, 0); assert.equal(bCalls, 1); assert.notEqual(result.cacheOnly, true); assert.deepEqual(result.usage, usage);
});

test('progress observers see each completed/cached unit and each ordinary batch', async () => {
	const store = new ContinuationUnitStore(); let completed = 0, calls = 0;
	const req = request('parent', 'the first result. A middle result was complete. The last result was not', 'The study included', 'detected.');
	const raw: Raw = async payload => { calls++; return echo(payload); };
	const options = { onProgress: () => { completed++; } };
	await store.translate(req, raw, signal(), 'settings', options);
	assert.equal(completed, 3); assert.equal(calls, 3);
	await store.translate(req, raw, signal(), 'settings', options);
	assert.equal(completed, 6); assert.equal(calls, 4);
	await store.translate(req, raw, signal(), 'settings', { onProgress: () => { throw new Error('observer'); } });
});

test('clear cancels pending units immediately and an ignored late response cannot refill the store', async () => {
	const store = new ContinuationUnitStore(), [left] = pair(), started = deferred<void>(), finish = deferred<TranslationResponse>(); let payload!: TranslationRequest;
	const first = store.translate(left, async req => { payload = req; started.resolve(); return finish.promise; }, signal());
	await started.promise; store.clear(); await assert.rejects(first, cancelled); finish.resolve(echo(payload));
	let calls = 0;
	await store.translate(left, async req => { calls++; return echo(req); }, signal()); assert.equal(calls, 1);
});

test('cancellation during a disk lookup cannot cause a late raw request', async () => {
	const store = new ContinuationUnitStore(), [left] = pair(), controller = new AbortController(), lookup = deferred<string[] | null>(); let calls = 0;
	const pending = store.translate(left, async req => { calls++; return echo(req); }, controller.signal, 'settings', { readUnit: () => lookup.promise });
	controller.abort(); await assert.rejects(pending, cancelled); lookup.resolve(null);
	await store.translate(request('ordinary', 'An ordinary paragraph.'), async req => echo(req), signal()); assert.equal(calls, 0);
});

test('memory retention is bounded to 256 units and the oldest complete unit is evicted', async () => {
	const store = new ContinuationUnitStore(); let calls = 0;
	const raw: Raw = async req => { calls++; return echo(req); };
	for (let i = 0; i < 257; i++) await store.translate(pair(`The observation ${i} occurred before`)[0], raw, signal());
	assert.equal(calls, 257);
	await store.translate(pair('The observation 0 occurred before')[0], raw, signal()); assert.equal(calls, 258);
	await store.translate(pair('The observation 256 occurred before')[1], raw, signal()); assert.equal(calls, 258);
});

test('ordinary identity responses retain usage and strip only internal source fields', async () => {
	const req = request('ordinary', 'An ordinary paragraph.'); let received!: TranslationResponse;
	const result = await new ContinuationUnitStore().translate(req, async payload => {
		assert.equal('protectedLiterals' in payload.blocks[0]!, false);
		assert.equal('sourceText' in payload.blocks[0]!, false);
		received = echo(payload); return received;
	}, signal());
	assert.equal(result, received);
});

test('fresh unit integrity rejection logs only an enum and part index, never source/translation/numeric content', async () => {
	const [left] = pair('All 172 completed the examination without complications before', 'the independent acquisition.');
	const before = recentProblems().length;
	await assert.rejects(new ContinuationUnitStore().translate(left, async payload => ({
		translations: payload.blocks.map((part, index) => ({ id: part.id,
			translatedText: index ? '独立采集。' : '所有人完成检查，且未出现并发症。' }))
	}), signal()));
	const added = recentProblems().slice(before).filter(line => line.includes('[continuationUnitStore]'));
	assert.equal(added.length, 1);
	assert.equal(added[0]!.split('[continuationUnitStore] ')[1], 'unit-integrity:numeric-inventory;partIndex:0');
});

test('invalid persisted unit content remains a silent cache miss', async () => {
	const [left] = pair('All 172 completed the examination before', 'the independent acquisition.');
	const before = recentProblems().filter(line => line.includes('[continuationUnitStore]')).length;
	await new ContinuationUnitStore().translate(left, async payload => echo(payload), signal(), 'settings', {
		readUnit: async () => ['All completed the examination before', 'the independent acquisition.']
	});
	assert.equal(recentProblems().filter(line => line.includes('[continuationUnitStore]')).length, before);
});
