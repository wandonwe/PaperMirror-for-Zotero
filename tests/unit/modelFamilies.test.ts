import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpt6MinimumEffort, gpt6Tier, isGlm53, isGptOss, isKimiK26, isKimiK3 } from '../../src/translation/providers/modelFamilies';

test('型号家族识别', () => {
	for (const m of ['kimi-k3', 'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', ' KIMI-K3 ']) assert.equal(isKimiK3(m), true, m);
	for (const m of ['kimi-k2.6', 'kimi-k30', 'moonshot-v1-8k']) assert.equal(isKimiK3(m), false, m);
	assert.equal(isKimiK26('kimi-k2.6'), true); assert.equal(isKimiK26('kimi-k2.60'), false);
	assert.equal(isGlm53('glm-5.3-flashx'), true); assert.equal(isGlm53('glm-5.31'), false);
	assert.equal(gpt6Tier('gpt-6.2-sol'), 'sol'); assert.equal(gpt6Tier('openai/gpt-6-luna'), 'luna');
	assert.equal(gpt6Tier('gpt-5.6-luna'), null); assert.equal(gpt6Tier('gpt-60-luna'), null);
	assert.equal(gpt6MinimumEffort('terra'), 'none'); assert.equal(gpt6MinimumEffort('astra'), 'low');
	assert.equal(isGptOss('openai/gpt-oss-20b'), true); assert.equal(isGptOss('gpt-oss-20b'), false);
});
