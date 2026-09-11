/**
 * 现状取证：用项目真实的 translationPane.css 与真实 DOM 结构渲染窗格，
 * 在代表性宽度/主题下截图并测量。
 *
 * 这是模拟预览，不是真机集成验证：它证明的是样式与布局本身的行为，
 * 不证明与 Zotero 阅读器的集成、同步或翻译流程。
 */
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'shots');
mkdirSync(outDir, { recursive: true });

const CASES = [
	{ name: 'light-720', width: 720, theme: 'light', status: '正在翻译第 3 页…' },
	{ name: 'light-520', width: 520, theme: 'light', status: '正在翻译第 3 页…' },
	{ name: 'light-420', width: 420, theme: 'light', status: '正在翻译第 3 页…' },
	{ name: 'light-390', width: 390, theme: 'light', status: '正在翻译第 3 页…' },
	{ name: 'dark-720', width: 720, theme: 'dark', status: '正在翻译第 3 页…' },
	{ name: 'dark-520', width: 520, theme: 'dark', status: '正在翻译第 3 页…' },
	{ name: 'light-error', width: 720, theme: 'light', status: 'API Key 被拒绝,请在设置中检查。', statusError: true },
	{ name: 'light-pending', width: 720, theme: 'light', status: '正在翻译第 3 页…', pending: true },
	{ name: 'light-longprovider', width: 720, theme: 'light', provider: 'Azure OpenAI (gpt-4o-mini)', status: '正在翻译第 3 页…' }
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const report = [];
for (const c of CASES) {
	const page = await browser.newPage({ viewport: { width: c.width, height: 720 }, deviceScaleFactor: 2 });
	await page.goto('file://' + resolve(here, 'pane.html'));
	await page.evaluate(o => window.render(o), c);
	await page.waitForTimeout(120);
	const m = await page.evaluate(() => {
		const bar = document.querySelector('.pm-bar');
		const pane = document.querySelector('.pm-bilingual-pane');
		const header = document.querySelector('.pm-header');
		const scroll = document.querySelector('.pm-scroll');
		const kids = [...bar.children].map(k => {
			const r = k.getBoundingClientRect();
			return { cls: k.className || k.tagName, left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
		});
		const paneR = pane.getBoundingClientRect();
		const clipped = kids.filter(k => k.right > Math.round(paneR.right) + 0.5 || k.left < Math.round(paneR.left) - 0.5);
		const cs = getComputedStyle(scroll);
		return {
			paneW: Math.round(paneR.width),
			barScrollW: bar.scrollWidth,
			barClientW: bar.clientWidth,
			overflowPx: bar.scrollWidth - bar.clientWidth,
			headerH: Math.round(header.getBoundingClientRect().height),
			clipped: clipped.map(k => k.cls),
			scrollBehavior: cs.scrollBehavior,
			scrollPadLeft: cs.paddingLeft,
			headerPadLeft: getComputedStyle(header).paddingLeft,
			docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
		};
	});
	report.push({ case: c.name, ...m });
	await page.screenshot({ path: resolve(outDir, c.name + '.png'), fullPage: false });
	await page.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
