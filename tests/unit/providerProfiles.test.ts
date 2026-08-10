import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseProviderProfiles,
	serializeProviderProfiles,
	profileFor,
	effectiveProviderConfig,
	migrateLegacyGlobals
} from '../../src/translation/providerProfiles';

test('parseProviderProfiles: tolerates junk, keeps only known string fields', () => {
	assert.deepEqual(parseProviderProfiles(undefined), {});
	assert.deepEqual(parseProviderProfiles(''), {});
	assert.deepEqual(parseProviderProfiles('not json'), {});
	assert.deepEqual(parseProviderProfiles('[]'), {});
	const parsed = parseProviderProfiles(JSON.stringify({
		openai: { apiBaseUrl: 'https://x', model: 'gpt-5-mini', customModel: 'm', junk: 1 },
		bad: 42,
		gemini: { model: 123 }
	}));
	assert.deepEqual(parsed.openai, { apiBaseUrl: 'https://x', model: 'gpt-5-mini', customModel: 'm' });
	assert.equal(parsed.bad, undefined);
	assert.deepEqual(parsed.gemini, {}); // non-string model dropped
});

test('serialize + parse round-trips', () => {
	const map = { openai: { model: 'gpt-5-mini' }, gemini: { apiBaseUrl: 'https://g' } };
	assert.deepEqual(parseProviderProfiles(serializeProviderProfiles(map)), map);
});

test('profileFor returns an empty object for an unknown provider', () => {
	assert.deepEqual(profileFor({}, 'openai'), {});
});

test('effectiveProviderConfig trims and defaults to empty (→ provider default)', () => {
	const map = { openai: { apiBaseUrl: '  https://x  ', model: '  gpt-5-mini ' } };
	assert.deepEqual(effectiveProviderConfig(map, 'openai'), { apiBaseURL: 'https://x', model: 'gpt-5-mini' });
	assert.deepEqual(effectiveProviderConfig(map, 'gemini'), { apiBaseURL: '', model: '' });
});

test('migration folds legacy globals into the CURRENT provider only', () => {
	const { profiles, changed } = migrateLegacyGlobals({}, {
		provider: 'openai',
		apiBaseURL: 'https://api.openai.com/v1',
		model: 'gpt-4o'
	});
	assert.equal(changed, true);
	assert.deepEqual(profiles.openai, { apiBaseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
	// Never touches any other provider — that global sharing was the bug.
	assert.equal(profiles.gemini, undefined);
});

test('migration never overwrites a profile field the new pane already set', () => {
	const existing = { openai: { model: 'gpt-5-mini' } };
	const { profiles, changed } = migrateLegacyGlobals(existing, {
		provider: 'openai',
		apiBaseURL: 'https://legacy',
		model: 'gpt-4o'
	});
	assert.equal(changed, true);
	// model already set → kept; only the missing base URL is filled.
	assert.deepEqual(profiles.openai, { model: 'gpt-5-mini', apiBaseUrl: 'https://legacy' });
});

test('migration is a no-op when there is nothing to migrate', () => {
	const { changed } = migrateLegacyGlobals({}, { provider: 'openai', apiBaseURL: '', model: '  ' });
	assert.equal(changed, false);
});
