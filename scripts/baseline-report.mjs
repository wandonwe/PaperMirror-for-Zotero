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

/** 枚举计数表 → "temperature:3 thinking:1";空表显示 —。 */
function countStr(counts) {
	const e = Object.entries(counts ?? {});
	return e.length ? e.map(([k, v]) => `${k}:${v}`).join(' ') : '—';
}

function countSum(counts) {
	return Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
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
	/**
	 * 时延不能求和 (2.8.5): "23 页的首字时间加起来是 6.8 秒"没有任何意义 ——
	 * 用户等的是**某一页**的首字。时延列一律给 "中位/最大",一眼看得出
	 * "大多数页多快" 与 "最糟的一页多慢"。
	 */
	const latency = (sel) => {
		const values = pages.map(p => (p.metrics ? sel(p.metrics) : undefined))
			.filter(v => typeof v === 'number').sort((a, b) => a - b);
		if (!values.length) {
			return 'n/a';
		}
		const p50 = values[Math.floor((values.length - 1) / 2)];
		return `${p50}/${values[values.length - 1]}`;
	};
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
		// 2.3.7 口径: preserve 块是**有意**保留(数据单元格保护),单列、不算失败。
		preserved: blocks.filter(b => b.state === 'preserved').length,
		keptOriginal: blocks.filter(b => b.state !== 'translated' && b.state !== 'preserved').length,
		placed,
		keptPlace: kept,
		placeRate: (placed + kept) ? `${(placed / (placed + kept) * 100).toFixed(1)}%` : 'n/a',
		geoViolations: audits.reduce((n, a) => n + (a.violations ?? 0), 0),
		// LO-7 / LO-10 (2.4.0 / 2.4.6): 大标题另置成功次数、因未建模墨迹被拒的扩展次数。
		annexed: placement.reduce((n, p) => n + (p.annexed ?? 0), 0),
		inkBlocked: placement.reduce((n, p) => n + (p.inkBlocked ?? 0), 0),
		// 用量统计 (2.3.9): 旧诊断没有 usage 段时显示 n/a。
		pageHitRate: d.usage?.pageCacheLookups
			? `${(d.usage.pageCacheFullHits / d.usage.pageCacheLookups * 100).toFixed(0)}%` : 'n/a',
		segHitRate: d.usage?.segmentLookups
			? `${(d.usage.segmentHits / d.usage.segmentLookups * 100).toFixed(0)}%` : 'n/a',
		prefetchWaste: d.usage ? `${d.usage.prefetchedUnviewed ?? 0}/${d.usage.prefetchedPages ?? 0}` : 'n/a',
		// 2.7.0 (审核 B-1/F-2/A-2): 排版放弃块(块表已联表)、token 用量、排版量测耗时。
		unplaced: blocks.filter(b => b.state === 'unplaced').length,
		inTokens: d.usage?.inputTokens ?? 0,
		outTokens: d.usage?.outputTokens ?? 0,
		cachedPct: d.usage?.inputTokens ? `${(d.usage.cachedInputTokens / d.usage.inputTokens * 100).toFixed(0)}%` : 'n/a',
		tokPerPage: d.usage?.inputTokens && pages.length
			? Math.round((d.usage.inputTokens + d.usage.outputTokens) / pages.length) : 0,
		layoutMs: placement.reduce((n, p) => n + (p.layoutMs ?? 0), 0),
		// 2.7.7 (外部审核 第一批): 真实 HTTP 尝试 / 每逻辑批次的尝试数 / 校验失败。
		// requests 仍是逻辑批次 (预算闸口径),旧诊断无这两个字段时显示 n/a。
		httpAttempts: d.usage?.httpAttempts ?? 'n/a',
		attemptsPerBatch: typeof d.usage?.httpAttempts === 'number' && m(x => x.requests)
			? (d.usage.httpAttempts / m(x => x.requests)).toFixed(2) : 'n/a',
		validationFailures: d.usage?.validationFailures ?? 'n/a',
		// 2.7.9: 多出来的尝试的去向 —— 参数自愈 / 白发的失败尝试,枚举计数。
		// 恒等式: httpAttempts ≈ 响应 (usageReports + usageMissing) + heals + errs。
		// 2.8.4 (性能第五批): 时序三段与写盘/渲染计量 —— 先量再改的那组数字。
		// 中位/最大,不是求和。
		queuedMs: latency(x => x.queuedMs),
		extractMs: latency(x => x.extractMs),
		firstTextMs: latency(x => x.firstTextMs),
		pageDoneMs: latency(x => x.durationMs),
		hotPages: d.usage?.hotPages ?? 'n/a',
		renderCancelled: d.render?.cancelled ?? 'n/a',
		renderMs: d.render?.totalMs ?? 'n/a',
		cacheWriteMs: d.cacheWrites ? d.cacheWrites.pageMs + d.cacheWrites.segmentMs : 'n/a',
		cacheWriteKB: d.cacheWrites
			? Math.round((d.cacheWrites.pageBytes + d.cacheWrites.segmentBytes) / 1024) : 'n/a',
		segFlushKB: d.cacheWrites?.segmentFlushes
			? Math.round(d.cacheWrites.segmentBytes / d.cacheWrites.segmentFlushes / 1024) : 'n/a',
		paramHeals: countStr(d.usage?.paramHeals),
		attemptErrors: countStr(d.usage?.attemptErrors),
		unexplained: typeof d.usage?.httpAttempts === 'number'
			? d.usage.httpAttempts - (d.usage.usageReports ?? 0) - (d.usage.usageMissing ?? 0)
				- countSum(d.usage?.paramHeals) - countSum(d.usage?.attemptErrors)
			: 'n/a'
	});
	// 放弃原因分布 (2.7.0): 从联表后的块表读,枚举串无文本。
	const reasons = {};
	for (const b of blocks) {
		if (b.state === 'unplaced') {
			reasons[b.abandonReason ?? 'unknown'] = (reasons[b.abandonReason ?? 'unknown'] ?? 0) + 1;
		}
	}
	if (Object.keys(reasons).length) {
		rows[rows.length - 1].abandonReasons = reasons;
	}
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
	preserved: sum('preserved'),
	keptOriginal: sum('keptOriginal'),
	placed: sum('placed'),
	keptPlace: sum('keptPlace'),
	placeRate: (sum('placed') + sum('keptPlace'))
		? `${(sum('placed') / (sum('placed') + sum('keptPlace')) * 100).toFixed(1)}%` : 'n/a',
	geoViolations: sum('geoViolations'),
	annexed: sum('annexed'),
	inkBlocked: sum('inkBlocked'),
	pageHitRate: '—',
	segHitRate: '—',
	prefetchWaste: '—',
	unplaced: sum('unplaced'),
	inTokens: sum('inTokens'),
	outTokens: sum('outTokens'),
	cachedPct: '—',
	tokPerPage: sum('pages') ? Math.round((sum('inTokens') + sum('outTokens')) / sum('pages')) : 0,
	layoutMs: sum('layoutMs'),
	httpAttempts: sum('httpAttempts'),
	attemptsPerBatch: sum('requests') ? (sum('httpAttempts') / sum('requests')).toFixed(2) : '—',
	validationFailures: sum('validationFailures'),
	queuedMs: '—',
	extractMs: '—',
	firstTextMs: '—',
	pageDoneMs: '—',
	hotPages: '—',
	renderCancelled: sum('renderCancelled'),
	renderMs: sum('renderMs'),
	cacheWriteMs: sum('cacheWriteMs'),
	cacheWriteKB: sum('cacheWriteKB'),
	segFlushKB: '—',
	paramHeals: '—',
	attemptErrors: '—',
	unexplained: sum('unexplained')
};

const abandonReasons = rows.map(r => r.abandonReasons).filter(Boolean);
for (const r of rows) {
	delete r.abandonReasons;
}
console.table([...rows, totals]);
if (abandonReasons.length) {
	console.log('放弃原因分布 (stage/overflow):');
	for (let i = 0; i < abandonReasons.length; i++) {
		console.log(`  ${rows[i].doc}:`, JSON.stringify(abandonReasons[i]));
	}
}

const headers = ['doc', 'pages', 'requests', 'reqPerPage', 'salvage', 'rate429', 'timeouts', 'segHits', 'avgPageMs', 'translated', 'preserved', 'keptOriginal', 'placed', 'keptPlace', 'placeRate', 'geoViolations', 'annexed', 'inkBlocked', 'pageHitRate', 'segHitRate', 'prefetchWaste', 'unplaced', 'inTokens', 'outTokens', 'cachedPct', 'tokPerPage', 'layoutMs', 'httpAttempts', 'attemptsPerBatch', 'validationFailures', 'paramHeals', 'attemptErrors', 'unexplained',
	'queuedMs', 'extractMs', 'firstTextMs', 'pageDoneMs', 'hotPages', 'renderCancelled', 'renderMs',
	'cacheWriteMs', 'cacheWriteKB', 'segFlushKB'];
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
