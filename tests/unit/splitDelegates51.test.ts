import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveEnglishResidue, type RecoveryContext } from '../../src/translation/chunkRecovery';

// 5.1: methods moved out of translationManager.ts and readerSession.ts left a
// one-line delegate behind ("/** Moved to x.ts (5.1). */"). The first pass
// dropped the last parameter of resolveEnglishResidue (canSpend, after an
// arrow-typed parameter): residue repair would have ignored the page's request
// budget. The compiler cannot see a dropped optional argument.

const paramNames = (text: string): string[] => {
	const out: string[] = [];
	let depth = 0, cur = '';
	for (const ch of text.replace(/=>/g, '  ')) {
		if ('(<[{'.includes(ch)) depth++;
		if (')>]}'.includes(ch)) depth--;
		if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out.map(p => p.trim()).filter(Boolean).map(p => /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p)![1]!);
};

test('5.1: every moved method\'s delegate forwards all of its parameters, in order', () => {
	let checked = 0;
	for (const file of ['src/translation/translationManager.ts', 'src/reader/readerSession.ts']) {
		const lines = readFileSync(file, 'utf8').split('\n');
		lines.forEach((line, i) => {
			if (!line.trim().startsWith('/** Moved to ')) return;
			let j = i + 1, sig = '';
			while (!lines[j]!.startsWith('\t\treturn ')) sig += lines[j++] + '\n';
			const ret = lines[j]!;
			const name = /return (\w+)\(/.exec(ret)![1]!;
			const open = sig.indexOf('(', sig.indexOf(name));
			let depth = 1, k = open + 1;
			for (; depth; k++) { if (sig[k] === '(') depth++; else if (sig[k] === ')') depth--; }
			const params = paramNames(sig.slice(open + 1, k - 1));
			const args = ret.slice(ret.indexOf('(') + 1, ret.lastIndexOf(')')).split(',').map(a => a.trim()).slice(1);
			assert.deepEqual(args, params, `${file}: ${name} must forward ${params.join(', ')}`);
			checked++;
		});
	}
	assert.ok(checked >= 40, `expected the moved methods' delegates, found ${checked}`);
});

test('5.1: English-residue repair stops when the page budget is spent', async () => {
	let requests = 0;
	const ctx: RecoveryContext = {
		request: async () => { throw new Error('unused'); },
		documentTitle: () => '', glossaryFor: () => [], literalsFor: () => [], notify: () => {}
	};
	const state = { pageIndex: 0, translations: new Map([['a', '这是 an untranslated English clause here 的句子']]) } as never;
	const blocks = [{ id: 'a', sourceText: 'This is an untranslated English clause here in the sentence.', type: 'paragraph' }] as never;
	await resolveEnglishResidue(ctx, state, blocks, [], 'en', 'zh-CN', new AbortController().signal,
		async () => { requests++; return { translations: [] }; }, () => false);
	assert.equal(requests, 0, 'no request once canSpend() says the budget is gone');
});
