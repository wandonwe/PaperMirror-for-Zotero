/**
 * 失效声明扫描。
 *
 * 起因：`.pm-bar-action { background: var(--pm-accent); color: #fff }` 写在
 * 第 1233 行，但真实渲染是透明背景 + 正文色。原因是第 135 行的
 * `.pm-bilingual-pane button { background: none; color: inherit }` ——
 * 类型选择器让它的特指度是 0,1,1，压过单类名的 0,1,0。
 *
 * 这个脚本把同一类问题一次找全：对每个 button 上的 pm- 类，
 * 造一个真实元素，比较「规则里写了什么」与「实际算出来是什么」。
 */
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { readFileSync } from 'node:fs';

const css = readFileSync('/root/pm/src/ui/styles/translationPane.css', 'utf8');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('about:blank');

const result = await page.evaluate(text => {
	const style = document.createElement('style');
	style.textContent = text;
	document.head.appendChild(style);

	const pane = document.createElement('div');
	pane.className = 'pm-bilingual-pane';
	pane.setAttribute('data-pm-theme', 'light');
	document.body.appendChild(pane);

	// 只看代码里真正建成 <button> 的那些类 —— 别的组合现实中不存在
	const BUTTON_CLASSES = new Set([
		'pm-bar-action', 'pm-chip', 'pm-chip-lang', 'pm-chip-provider',
		'pm-icon-button', 'pm-card-close', 'pm-mini-explain',
		'pm-side-toggle', 'pm-footer-button'
	]);
	const candidates = [];
	for (const rule of style.sheet.cssRules) {
		if (!rule.selectorText) continue;
		for (const sel of rule.selectorText.split(',').map(s => s.trim())) {
			if (!/^\.pm-[a-z0-9-]+$/.test(sel)) continue;
			if (!BUTTON_CLASSES.has(sel.slice(1))) continue;
			const bg = rule.style.getPropertyValue('background') || rule.style.getPropertyValue('background-color');
			const col = rule.style.getPropertyValue('color');
			if (!bg && !col) continue;
			candidates.push({ sel, cls: sel.slice(1), bg, col });
		}
	}

	const dead = [];
	for (const c of candidates) {
		for (const tag of ['button']) {
			const el = document.createElement(tag);
			el.className = c.cls;
			el.textContent = 'x';
			pane.appendChild(el);
			const cs = getComputedStyle(el);
			const gotBg = cs.backgroundColor;
			const gotCol = cs.color;
			// 规则写了非 none 的背景，实际却是完全透明 → 被压掉了
			const bgDead = c.bg && !/^none$/.test(c.bg.trim()) && gotBg === 'rgba(0, 0, 0, 0)';
			// 规则写了具体颜色，实际却继承了窗格正文色 → 被压掉了
			const colDead = c.col && !/inherit/.test(c.col) && gotCol === 'rgb(29, 35, 47)' && !/var\(--pm-ink\)/.test(c.col);
			if (tag === 'button' && (bgDead || colDead)) {
				dead.push({ sel: c.sel, declaredBg: c.bg || null, declaredColor: c.col || null, computedBg: gotBg, computedColor: gotCol });
			}
			el.remove();
		}
	}
	return { scanned: candidates.length, dead };
}, css);

console.log(`扫描了 ${result.scanned} 条单类名着色规则`);
console.log(`其中在 <button> 上失效的：${result.dead.length}\n`);
for (const d of result.dead) {
	console.log(`${d.sel}`);
	if (d.declaredBg) console.log(`   写的 background: ${d.declaredBg}   实际: ${d.computedBg}`);
	if (d.declaredColor) console.log(`   写的 color:      ${d.declaredColor}   实际: ${d.computedColor}`);
}
await browser.close();
