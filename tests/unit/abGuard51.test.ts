import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// 5.1 (device check 11-26): Zotero restarted twice during an A/B run and stayed
// in local-only mode with add-on auto-update off. The guard file lets the next
// run put the prefs back.

const source = readFileSync(resolve('scripts/zotero/ab-guard.js'), 'utf8');
const LOCAL_ONLY = 'extensions.zotero.bilingualReader.localOnlyMode', AUTO_UPDATE = 'extensions.update.enabled';
const FILE = '/out/pm-ab-guard.json';

function device(initial: { localOnly: boolean; autoUpdate: boolean }) {
	const files = new Map<string, string>();
	const prefs = new Map<string, unknown>([[LOCAL_ONLY, initial.localOnly]]);
	const system = new Map<string, boolean>([[AUTO_UPDATE, initial.autoUpdate]]);
	const env = {
		Zotero: {
			File: { putContentsAsync: async (p: string, t: string) => { files.set(p, t); }, getContentsAsync: async (p: string) => files.get(p)! },
			Prefs: { get: (k: string) => prefs.get(k), set: (k: string, v: unknown) => { prefs.set(k, v); }, clear: (k: string) => { prefs.delete(k); } }
		},
		Services: { prefs: { getBoolPref: (k: string, d: boolean) => system.get(k) ?? d, setBoolPref: (k: string, v: boolean) => { system.set(k, v); } } },
		IOUtils: { exists: async (p: string) => files.has(p), remove: async (p: string) => { files.delete(p); } }
	};
	const guard = () => (runInNewContext(source, {}) as (file: string, e: typeof env) => any)(FILE, env);
	// What acceptance-ab.js does to the prefs while it runs.
	const audit = (stepPrefs: Record<string, unknown> = {}) => {
		prefs.set(LOCAL_ONLY, true); system.set(AUTO_UPDATE, false);
		for (const [k, v] of Object.entries(stepPrefs)) prefs.set(k, v);
	};
	return { files, prefs, system, guard, audit };
}

test('5.1: a run that Zotero quit in the middle of is undone by the next run', async () => {
	const d = device({ localOnly: false, autoUpdate: true });
	const first = d.guard();
	assert.equal(await first.recover(), null, 'nothing to undo on a clean start');
	await first.arm('ab51');
	await first.stepPrefs(['extensions.zotero.bilingualReader.debugDocumentStyleDelayMs']);
	d.audit({ 'extensions.zotero.bilingualReader.debugDocumentStyleDelayMs': 9000 });
	// Zotero quits here: no finally block, no disarm.

	const next = d.guard();
	const recovered = await next.recover();
	assert.equal(recovered.tag, 'ab51');
	assert.equal(d.prefs.get(LOCAL_ONLY), false, 'local-only mode back off');
	assert.equal(d.system.get(AUTO_UPDATE), true, 'auto-update back on');
	assert.equal(d.prefs.has('extensions.zotero.bilingualReader.debugDocumentStyleDelayMs'), false, 'step pref cleared');
	assert.equal(d.files.has(FILE), false);
	// And the new run now records the real previous values, not the stuck ones.
	const armed = await next.arm('ab51b');
	assert.deepEqual([armed.localOnly, armed.autoUpdate], [false, true]);
});

test('5.1: a run that finished leaves nothing behind; an unreadable guard file is still removed', async () => {
	const d = device({ localOnly: true, autoUpdate: false });
	const g = d.guard();
	await g.arm('ab51');
	d.audit();
	await g.disarm();
	assert.equal(d.files.has(FILE), false);
	assert.equal(await d.guard().recover(), null);
	assert.equal(d.prefs.get(LOCAL_ONLY), true, 'a user who keeps local-only mode on is not switched off');

	d.files.set(FILE, '{not json');
	assert.equal(JSON.stringify(await d.guard().recover()), '{"unreadable":true}');
	assert.equal(d.files.has(FILE), false);
});

test('5.1: acceptance-ab.js recovers before it reads the previous values, arms before changing them, and disarms after restoring', () => {
	const ab = readFileSync(resolve('scripts/zotero/acceptance-ab.js'), 'utf8');
	const at = (s: string) => { const i = ab.indexOf(s); assert.ok(i >= 0, s); return i; };
	assert.ok(at('guard.recover()') < at('prev = Zotero.Prefs.get(PREF, true)'));
	assert.ok(at('guard.arm(cfg.tag)') < at('Zotero.Prefs.set(PREF, true, true)'));
	assert.ok(at('guard.stepPrefs(') < at('Zotero.Prefs.set(k, v, true)'));
	assert.ok(at('Zotero.Prefs.set(PREF, prev, true)') < at('guard.disarm()'));
});

test('5.1: prime-cache.js restores local-only mode and auto-update in its finally block and hands over to the A/B only after a clean prime', () => {
	const prime = readFileSync(resolve('scripts/zotero/prime-cache.js'), 'utf8');
	const at = (s: string) => { const i = prime.indexOf(s); assert.ok(i >= 0, s); return i; };
	assert.ok(at('prev = Zotero.Prefs.get(PREF, true)') < at('Zotero.Prefs.set(PREF, false, true)'));
	assert.ok(at('finally {') < at('Zotero.Prefs.set(PREF, prev, true)'));
	assert.ok(at('Zotero.Prefs.set(PREF, prev, true)') < at("cfg.prime.then === 'ab' && !out.errors.length"));
	assert.doesNotThrow(() => new Function(prime));
});
