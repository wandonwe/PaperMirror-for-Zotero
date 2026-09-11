import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const out = [];
for (const width of [1100, 900, 800, 720, 640, 560, 520, 460, 420, 390]) {
	const page = await browser.newPage({ viewport: { width, height: 700 } });
	await page.goto('file://' + resolve(here, 'pane.html'));
	await page.evaluate(() => window.render({ theme: 'light', status: '正在翻译第 3 页…' }));
	await page.waitForTimeout(60);
	const m = await page.evaluate(() => {
		const bar = document.querySelector('.pm-bar');
		const pane = document.querySelector('.pm-bilingual-pane');
		const paneR = pane.getBoundingClientRect();
		const q = s => document.querySelector(s);
		const w = s => { const e = q(s); return e ? Math.round(e.getBoundingClientRect().width) : null; };
		const truncated = s => {
			const e = q(s);
			if (!e) return null;
			return e.scrollWidth > e.clientWidth + 1;
		};
		const clipped = [...bar.children].filter(k => k.getBoundingClientRect().right > paneR.right + 0.5).length;
		return {
			langW: w('.pm-chip-lang'), langCut: truncated('.pm-chip-lang'),
			provW: w('.pm-chip-provider'), provNameCut: truncated('.pm-provider-name'),
			spacerW: w('.pm-bar-spacer'),
			barOverflow: bar.scrollWidth - bar.clientWidth,
			clippedCount: clipped,
			actionW: w('.pm-bar-action'),
			actionBg: getComputedStyle(q('.pm-bar-action')).backgroundColor,
			actionColor: getComputedStyle(q('.pm-bar-action')).color,
			iconBtn: (() => { const r = q('.pm-icon-button').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
			switchFont: getComputedStyle(q('.pm-switch-label')).fontSize,
			switchTabIndex: q('.pm-switch-label').tabIndex,
			switchAriaChecked: q('.pm-switch-label').getAttribute('aria-checked')
		};
	});
	out.push({ width, ...m });
	await page.close();
}
await browser.close();
console.table(out);
