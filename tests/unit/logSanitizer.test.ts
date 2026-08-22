import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, sanitizeHeaders, registerSecret, registerUrlCredentials, clearSecrets } from '../../src/security/logSanitizer';

test('redacts Anthropic-style keys', () => {
	const out = sanitize('using key sk-ant-abcdef0123456789 now');
	assert.ok(!out.includes('sk-ant-abcdef0123456789'));
	assert.ok(out.includes('[REDACTED]'));
});

test('redacts OpenAI-style bearer tokens', () => {
	const out = sanitize('Authorization: Bearer sk-abcdef0123456789ABCDEF');
	assert.ok(!out.includes('sk-abcdef0123456789ABCDEF'));
});

test('redacts x-api-key header value but keeps the name', () => {
	const out = sanitize('x-api-key: verysecretvalue12345');
	assert.ok(!out.includes('verysecretvalue12345'));
});

test('redacts a registered runtime secret and DeepL uuid', () => {
	clearSecrets();
	registerSecret('MY-CUSTOM-SECRET-TOKEN');
	const out = sanitize('key=MY-CUSTOM-SECRET-TOKEN and 12345678-1234-1234-1234-123456789abc:fx');
	assert.ok(!out.includes('MY-CUSTOM-SECRET-TOKEN'));
	assert.ok(!out.includes('123456789abc'));
	clearSecrets();
});

test('sanitizeHeaders drops every value', () => {
	const out = sanitizeHeaders({ Authorization: 'Bearer x', 'Content-Type': 'application/json' });
	assert.equal(out.Authorization, '[REDACTED]');
	assert.equal(out['Content-Type'], '[REDACTED]');
});

test('sanitize handles Error objects', () => {
	const out = sanitize(new Error('boom sk-ant-secret000000000'));
	assert.ok(!out.includes('sk-ant-secret000000000'));
});

// ---- 2.1.0 安全批次: S1 / S5 / S6 -------------------------------------------

test('S1: URL 内密钥 (?key= 形式) 被脱敏,参数名保留 (Gemini ?key=AIza…)', () => {
	clearSecrets();
	const out = sanitize('base URL: https://x.com/v1?key=AIzaSyD1234567890abcdefghij1234567890abc');
	assert.ok(!out.includes('AIzaSyD1234567890abcdefghij1234567890abc'), 'URL 内密钥必须脱敏');
	assert.ok(out.includes('key='), '参数名保留便于阅读');
	// 裸 key= 与其后的 & 分隔
	const out2 = sanitize('endpoint https://gw/v1?key=supersecretvalue123&x=1');
	assert.ok(!out2.includes('supersecretvalue123'));
	assert.ok(out2.includes('&x=1'), '只吞值,不越过分隔符');
	clearSecrets();
});

test('S1: AIza / gsk_ / 智谱 裸形态(网关回显)被脱敏', () => {
	clearSecrets();
	assert.ok(!sanitize('echoed AIzaSyD1234567890abcdefghij1234567890abc').includes('AIzaSyD1234567890abcdefghij1234567890abc'));
	assert.ok(!sanitize('echoed gsk_ABCDEFabcdef1234567890ABCDEFabcdef1234').includes('gsk_ABCDEF'));
	assert.ok(!sanitize('id 0123456789abcdef0123456789abcdef.AbCdEfGh here').includes('0123456789abcdef0123456789abcdef.AbCdEfGh'));
	clearSecrets();
});

test('S1: registerUrlCredentials 让裸形态的 URL 密钥后续也被精确替换', () => {
	clearSecrets();
	registerUrlCredentials('https://gw/v1?key=urlsecretvalue999&token=another12345');
	assert.ok(!sanitize('gateway said your urlsecretvalue999 is bad').includes('urlsecretvalue999'));
	assert.ok(!sanitize('token another12345 rejected').includes('another12345'));
	clearSecrets();
});

test('S5: 重叠密钥先替换最长的,不留残余后缀', () => {
	clearSecrets();
	registerSecret('sk-live-abcd1234');           // 短的先注册
	registerSecret('sk-live-abcd1234efgh5678ijkl'); // 完整的后注册
	const out = sanitize('token sk-live-abcd1234efgh5678ijkl end');
	assert.ok(!out.includes('efgh5678ijkl'), '长密钥后半段绝不能裸露');
	clearSecrets();
});

test('S6: 非 Bearer 的 Authorization scheme 值被整段脱敏', () => {
	clearSecrets();
	assert.ok(!sanitize('Authorization: DeepL-Auth-Key not-a-uuid-plain-key-12345').includes('not-a-uuid-plain-key-12345'));
	assert.ok(!sanitize('Api-Key: myplainkey1234 tail').includes('myplainkey1234'));
	// Bearer 仍正常
	assert.ok(!sanitize('Authorization: Bearer abcdefgh12345678').includes('abcdefgh12345678'));
	clearSecrets();
});

test('registerSecret 下限 8: 短串不再当密钥(诊断不自毁)', () => {
	clearSecrets();
	registerSecret('test'); // 4 字符,应被忽略
	assert.equal(sanitize('latest protest test'), 'latest protest test', '短串不得把日志打成碎片');
	registerSecret('longenoughsecret'); // 16 字符,应生效
	assert.ok(!sanitize('here is longenoughsecret ok').includes('longenoughsecret'));
	clearSecrets();
});
