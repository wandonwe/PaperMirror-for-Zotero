/**
 * 真实世界性能基线汇总 (2.3.6, 优化计划 第五批):
 *
 *   node scripts/baseline-report.mjs 诊断1.json 诊断2.json …
 *
 * 输入是插件「更多 ⋯ → 诊断」复制出的诊断 JSON(每篇文档一份,先在 Zotero 里
 * 顺序读完/翻完再导出)。输出每篇 + 合计的基线表:
 *   页数 / 请求数 / 请求/页 / 逐块补救 / 429 / 超时 / 段落缓存命中 /
 *   页均耗时 ms / 块级: 已译 / 保留原文(keepOrigin+untranslated) / 排版:
 *   placed / kept / 排版成功率 / 几何违例
 * 并写出 baseline-report.md(与终端同内容,Markdown 表格,可直接入 docs)。
 * 纯 JSON 聚合 —— 不含任何原文/译文文本(诊断 JSON 本身即脱敏)。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2);
if (!files.length) {
	console.error('用法: node scripts/baseline-report.mjs <诊断.json> [更多…]');
	process.exit(1);
}

const rows = [];
for (const f of files) {
	let d;
	try {
		d = JSON.parse(readFileSync(f, 'utf8'));
	}
	catch (e) {
		console.error(`跳过 ${f}: ${e.message}`);
		continue;
	}
	const pages = Array.isArray(d.pages) ? d.pages : [];
	const m = (sel) => pages.reduce((n, p) => n + (p.metrics ? (sel(p.metrics) ?? 0) : 0), 0);
	const blocks = pages.flatMap(p => p.blocks ?? []);
	const placement = Array.isArray(d.placement) ? d.placement : [];
	const placed = placement.reduce((n, p) => n + (p.placed ?? p.committed ?? 0), 0);
	const kept = placement.reduce((n, p) => n + (p.kept ?? ((p.abandoned ?? 0) + (p.untranslated ?? 0) + (p.tableFailed ?? 0))), 0);
	const audits = Array.isArray(d.geometryAudits) ? d.geometryAudits : [];
	const durSum = m(x => x.durationMs);
	const durPages = pages.filter(p => p.metrics?.durationMs).length;
	rows.push({
		doc: basename(f).replace(/\.json$/, '').slice(0, 32),
		pages: pages.length,
		requests: m(x => x.requests),
		reqPerPage: pages.length ? (m(x => x.requests) / pages.length).toFixed(2) : '0',
		salvage: m(x => x.salvage),
		rate429: m(x => x.rateLimited),
		timeouts: m(x => x.timeouts),
		segHits: m(x => x.segmentHits),
		avgPageMs: durPages ? Math.round(durSum / durPages) : 0,
		translated: blocks.filter(b => b.state === 'translated').length,
		keptOriginal: blocks.filter(b => b.state !== 'translated').length,
		placed,
		keptPlace: kept,
		placeRate: (placed + kept) ? `${(placed / (placed + kept) * 100).toFixed(1)}%` : 'n/a',
		geoViolations: audits.reduce((n, a) => n + (a.violations ?? 0), 0)
	});
}

if (!rows.length) {
	console.error('没有可用的诊断 JSON。');
	process.exit(1);
}

const sum = (k) => rows.reduce((n, r) => n + (typeof r[k] === 'number' ? r[k] : 0), 0);
const totals = {
	doc: `合计 (${rows.length} 篇)`,
	pages: sum('pages'),
	requests: sum('requests'),
	reqPerPage: sum('pages') ? (sum('requests') / sum('pages')).toFixed(2) : '0',
	salvage: sum('salvage'),
	rate429: sum('rate429'),
	timeouts: sum('timeouts'),
	segHits: sum('segHits'),
	avgPageMs: rows.length ? Math.round(rows.reduce((n, r) => n + r.avgPageMs, 0) / rows.length) : 0,
	translated: sum('translated'),
	keptOriginal: sum('keptOriginal'),
	placed: sum('placed'),
	keptPlace: sum('keptPlace'),
	placeRate: (sum('placed') + sum('keptPlace'))
		? `${(sum('placed') / (sum('placed') + sum('keptPlace')) * 100).toFixed(1)}%` : 'n/a',
	geoViolations: sum('geoViolations')
};

console.table([...rows, totals]);

const headers = ['doc', 'pages', 'requests', 'reqPerPage', 'salvage', 'rate429', 'timeouts', 'segHits', 'avgPageMs', 'translated', 'keptOriginal', 'placed', 'keptPlace', 'placeRate', 'geoViolations'];
const md = [
	'# 性能基线报告(真实世界)',
	'',
	`基于 ${rows.length} 篇文档的诊断 JSON 汇总。指标口径见 docs/reviews/性能基线-操作指南.md。`,
	'',
	`| ${headers.join(' | ')} |`,
	`| ${headers.map(() => '---').join(' | ')} |`,
	...[...rows, totals].map(r => `| ${headers.map(h => r[h]).join(' | ')} |`)
].join('\n');
writeFileSync('baseline-report.md', md + '\n');
console.log('\n已写出 baseline-report.md');
