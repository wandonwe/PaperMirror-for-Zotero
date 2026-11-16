// Browser gate: real layout and real text rasterisation of the placement code.
//
//   node scripts/browser-gate.mjs [--browser firefox|chromium] [--dpr 2]
//        [--bleed 0.0625] [--tie 0.05] [--no-pixels] [--out DIR]
//        [--min-committed N] [--max-clipped-pixels N]   fail below / above these
//
// Zotero is built on Firefox, so Firefox is the engine whose numbers count;
// Chromium rounds canvas text metrics differently and is kept for comparison.
// Needs Playwright with the chosen browser installed (not a project dependency):
//   npm i --no-save playwright && npx playwright install --with-deps firefox
//
// Three results, printed as `GATE <name> <json>` lines and written to --out:
//   matrix  blocks shown for each real-translation fixture at three zoom levels
//   pixels  for every shown block, pixels that overflow:hidden removes, at four
//           sub-pixel phases (the same comparison scripts/zotero/ink-clip-check.js
//           makes inside Zotero: clipped vs. unclipped, luminance difference > 64)
//   suite   every tests/browser check, reported one by one
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const browserName = opt('browser', 'firefox'), dpr = Number(opt('dpr', '2'));
const tuning = { bleed: Number(opt('bleed', '0')), tie: Number(opt('tie', '0')) };
const root = fileURLToPath(new URL('..', import.meta.url));
const out = opt('out', join(root, 'output', 'browser-gate'));
const withPixels = !args.includes('--no-pixels');
const PHASES = [0, 0.25, 0.5, 0.75], THRESHOLD = 64, HALO = 3;

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install --with-deps ' + browserName); process.exit(2); }

/** Minimal PNG reader (8-bit RGB/RGBA, non-interlaced), enough for Playwright screenshots. Returns luminance. */
function luminance(png) {
	let pos = 8, width = 0, height = 0, channels = 4; const idat = [];
	while (pos < png.length) {
		const length = png.readUInt32BE(pos), type = png.toString('latin1', pos + 4, pos + 8), data = png.subarray(pos + 8, pos + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0); height = data.readUInt32BE(4);
			if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6) || data[12] !== 0) throw new Error('unsupported PNG');
			channels = data[9] === 6 ? 4 : 3;
		} else if (type === 'IDAT') idat.push(data);
		pos += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, lum = new Uint8Array(width * height);
	let previous = new Uint8Array(stride), line = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)], offset = y * (stride + 1) + 1;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? line[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
			let value = raw[offset + x];
			if (filter === 1) value += a; else if (filter === 2) value += b; else if (filter === 3) value += (a + b) >> 1;
			else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			line[x] = value & 255;
		}
		for (let x = 0; x < width; x++) lum[y * width + x] = Math.round(0.2126 * line[x * channels] + 0.7152 * line[x * channels + 1] + 0.0722 * line[x * channels + 2]);
		[previous, line] = [line, previous];
	}
	return { width, height, lum };
}

async function open(entry, extraScript = '') {
	const tmp = mkdtempSync(join(tmpdir(), 'pm-gate-'));
	await build({ entryPoints: [join(root, entry)], bundle: true, platform: 'browser', format: 'iife', outfile: join(tmp, 'gate.js'), loader: { '.css': 'text', '.svg': 'text' }, logLevel: 'error' });
	const data = name => 'data:image/png;base64,' + readFileSync(join(root, 'tests/fixtures/regression', name)).toString('base64');
	const images = Object.fromEntries([35, 40, 27, 22, 38, 19].map(p => [p, data(`${p === 19 ? 'bae2010' : p === 22 ? 'serruys2021' : 'stroke2026'}-p${p}-visual.png`)]));
	writeFileSync(join(tmp, 'gate.html'), '<!doctype html><meta charset="utf-8"><style>' + readFileSync(join(root, 'src/ui/styles/translationPane.css'), 'utf8') + '</style><script>'
		+ `window.escPanelImage=${JSON.stringify(data('esc2024-p8-panels.png'))};window.captionFixtureImage=${JSON.stringify(data('simohamed2021-p4.png'))};`
		+ `window.realTranslationImages=${JSON.stringify(images)};window.pmGateTuning=${JSON.stringify(tuning)};${extraScript}</script><script defer src="gate.js"></script>`);
	const browser = await playwright[browserName].launch();
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dpr });
	const errors = []; page.on('pageerror', e => errors.push(e.message));
	await page.goto('file://' + join(tmp, 'gate.html'));
	await page.waitForSelector('#result[data-pass]', { state: 'attached', timeout: 900000 });
	const pass = await page.getAttribute('#result', 'data-pass'), text = await page.textContent('#result');
	return { browser, page, pass: pass === 'true', text, errors };
}

/** Pixels that overflow:hidden removes from each shown block, at each sub-pixel phase. */
async function clippedPixels(page) {
	const clipped = new Map();
	const pages = await page.$$eval('[data-gate-page]', nodes => nodes.map(n => n.getAttribute('data-gate-page')));
	let blocksChecked = 0;
	for (const phase of PHASES) {
		// Shift the layout by a fraction of a device pixel, as a scroll position does.
		await page.evaluate(top => { document.getElementById('real-translation-gallery').style.marginTop = top + 'px'; }, phase / dpr);
		for (const name of pages) {
			const info = await page.evaluate(name => {
				const el = document.querySelector(`[data-gate-page="${name}"]`), r = el.getBoundingClientRect();
				const blocks = [...el.querySelectorAll('.pm-repage-block')].filter(n => n.style.visibility !== 'hidden' && getComputedStyle(n).visibility !== 'hidden' && n.textContent)
					.map(n => { const b = n.getBoundingClientRect(); return { id: n.getAttribute('data-pm-block'), text: (n.textContent || '').slice(0, 24), x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; });
				return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, blocks };
			}, name);
			if (!info.blocks.length) continue;
			if (phase === 0) blocksChecked += info.blocks.length;
			const clip = { x: Math.floor(info.x) - 4, y: Math.floor(info.y) - 4, width: Math.ceil(info.w) + 8, height: Math.ceil(info.h) + 8 };
			if (clip.x < 0) { clip.width += clip.x; clip.x = 0; } if (clip.y < 0) { clip.height += clip.y; clip.y = 0; }
			const shot = async () => luminance(await page.screenshot({ clip, fullPage: true, scale: 'device' }));
			const setOverflow = value => page.evaluate(([name, value]) => {
				for (const n of document.querySelectorAll(`[data-gate-page="${name}"] .pm-repage-block, [data-gate-page="${name}"] .pm-flow-piece`)) {
					if (value === null) { n.style.overflow = n.dataset.gateOverflow ?? ''; delete n.dataset.gateOverflow; }
					else { n.dataset.gateOverflow = n.style.overflow; n.style.overflow = value; }
				}
			}, [name, value]);
			const hidden = await shot();
			await setOverflow('visible');
			const visible = await shot();
			await setOverflow(null);
			if (hidden.lum.length !== visible.lum.length) throw new Error('screenshot size changed for ' + name);
			for (let i = 0; i < hidden.lum.length; i++) {
				if (Math.abs(hidden.lum[i] - visible.lum[i]) <= THRESHOLD) continue;
				const px = clip.x + ((i % hidden.width) + 0.5) / dpr, py = clip.y + (Math.floor(i / hidden.width) + 0.5) / dpr;
				const block = info.blocks.find(b => px >= b.x - HALO && px <= b.x + b.w + HALO && py >= b.y - HALO && py <= b.y + b.h + HALO);
				const key = name + ' ' + (block ? block.id : '(outside any block)');
				const entry = clipped.get(key) ?? { page: name, id: block?.id, text: block?.text, perPhase: PHASES.map(() => 0), box: block && [block.w, block.h].map(v => Math.round(v * 100) / 100), at: [] };
				entry.perPhase[PHASES.indexOf(phase)]++;
				// Where the lost pixel is, relative to the block's box (CSS px): which edge, and how far along it.
				if (block && entry.at.length < 6) entry.at.push({ phase, x: Math.round((px - block.x) * 100) / 100, y: Math.round((py - block.y) * 100) / 100, difference: Math.abs(hidden.lum[i] - visible.lum[i]) });
				clipped.set(key, entry);
			}
		}
	}
	await page.evaluate(() => { document.getElementById('real-translation-gallery').style.marginTop = ''; });
	const blocks = [...clipped.values()];
	return { phases: PHASES, blocksChecked, clippedBlocks: blocks.length, clippedPixels: blocks.reduce((s, b) => s + Math.max(...b.perPhase), 0), blocks };
}

mkdirSync(out, { recursive: true });
const tag = `${browserName}-dpr${dpr}` + (tuning.bleed || tuning.tie ? `-bleed${tuning.bleed}-tie${tuning.tie}` : '');
const report = { browser: browserName, dpr, tuning };
{
	const { browser, page, pass, text, errors } = await open('tests/browser/gate/matrixEntry.ts');
	report.version = browser.version();
	if (pass) {
		const rows = JSON.parse(text);
		report.matrix = { scenes: rows.length, committed: rows.reduce((s, r) => s + (r.stats.committed ?? 0), 0), belowMinimum: rows.filter(r => r.fail).length,
			inkBlocked: rows.reduce((s, r) => s + (r.stats.inkBlocked ?? 0), 0), rows: rows.map(r => ({ page: r.page, scale: r.scale, minimum: r.minimum, committed: r.stats.committed, fail: r.fail })),
			unplaced: rows.filter(r => r.unplaced.length).map(r => `${r.page}@${Math.round(r.scale * 100) / 100} ` + r.unplaced.map(u => `${u.id}:${u.reason}`).join(' ')) };
		writeFileSync(join(out, `matrix-${tag}.json`), JSON.stringify(rows));
		if (withPixels) { report.pixels = await clippedPixels(page); writeFileSync(join(out, `pixels-${tag}.json`), JSON.stringify(report.pixels)); }
	} else report.matrix = { error: text.slice(0, 600), pageErrors: errors.slice(0, 5) };
	await browser.close();
}
{
	const { browser, text, errors } = await open('tests/browser/gate/suiteEntry.ts');
	try { const rows = JSON.parse(text.replace(/ ERROR .*$/s, '')); report.suite = { checks: rows.length, failed: rows.filter(r => !r.ok).map(r => ({ name: r.n, error: String(r.e).slice(0, 200) })) }; }
	catch { report.suite = { error: text.slice(0, 600), pageErrors: errors.slice(0, 5) }; }
	await browser.close();
}
writeFileSync(join(out, `report-${tag}.json`), JSON.stringify(report, null, 1));
const { rows, unplaced: _unplaced, ...matrix } = report.matrix ?? {};
console.log(`GATE engine ${JSON.stringify({ browser: browserName, version: report.version, dpr, tuning })}`);
console.log(`GATE matrix ${JSON.stringify(matrix)}`);
if (rows) console.log(`GATE matrix-rows ${JSON.stringify(rows.map(r => `${r.page}@${Math.round(r.scale * 100) / 100}:${r.committed}/${r.minimum}${r.fail ? '!' : ''}`))}`);
if (report.matrix?.unplaced) for (const u of report.matrix.unplaced) console.log(`GATE unplaced ${u}`);
if (report.pixels) { const { blocks, ...pixels } = report.pixels; console.log(`GATE pixels ${JSON.stringify(pixels)}`); for (const b of blocks.slice(0, 40)) console.log(`GATE clipped ${JSON.stringify(b)}`); }
console.log(`GATE suite ${JSON.stringify(report.suite)}`);
// Enforced only where asked: the numbers depend on the engine and its fonts.
const minCommitted = opt('min-committed'), maxClipped = opt('max-clipped-pixels'), failures = [];
if (minCommitted !== undefined && !(report.matrix?.committed >= Number(minCommitted))) failures.push(`committed ${report.matrix?.committed} < ${minCommitted}`);
if (maxClipped !== undefined && !(report.pixels?.clippedPixels <= Number(maxClipped))) failures.push(`clipped pixels ${report.pixels?.clippedPixels} > ${maxClipped}`);
if (failures.length) { console.error('GATE FAILED ' + failures.join('; ')); process.exit(1); }
