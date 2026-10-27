/**
 * 已完成页的内存保留 (2.8.3 第四批)。
 *
 * 这里钉的是"什么绝不能被卸掉":没翻完的、译文还没落盘的、正在用的、离当前页
 * 太近的。宁可停在上限之上,也不丢一份没落盘的译文。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TranslationManager, type TranslationDeps } from '../../src/translation/translationManager';
import { pagesToEvict, RETAIN_LIMIT, KEEP_RADIUS, type RetainCandidate } from '../../src/translation/pageRetention';

function page(pageIndex: number, over: Partial<RetainCandidate> = {}): RetainCandidate {
	return {
		pageIndex,
		status: 'done',
		cached: true,
		inUse: false,
		touchedAt: pageIndex,
		evicted: false,
		...over
	};
}

/** n 页全部"可淘汰",最近用到的序号 = 页码。 */
function manyPages(n: number, over: Partial<RetainCandidate> = {}): RetainCandidate[] {
	return Array.from({ length: n }, (_, i) => page(i, over));
}

test('没超上限就一页都不卸 (2.8.3 第四批)', () => {
	assert.deepEqual(pagesToEvict(manyPages(RETAIN_LIMIT), 100), [], '刚好到上限');
	// 远低于上限: "超出量"是负数,少一道闸就会被 slice(0, 负数) 反过来当成
	// "从末尾切掉几个"——把该留的页全卸了。
	assert.deepEqual(pagesToEvict(manyPages(3), 100), [], '远低于上限');
	assert.deepEqual(pagesToEvict(manyPages(RETAIN_LIMIT - 1), 100), [], '差一页到上限');
	assert.deepEqual(pagesToEvict([], 0), [], '一页都没有');
});

test('超了就卸最久没用到的,只卸超出的那几页 (2.8.3 第四批)', () => {
	// 25 页,上限 20 → 只卸 5 页;当前页 100(离所有页都远)。
	const evicted = pagesToEvict(manyPages(25), 100);
	assert.equal(evicted.length, 5, '只卸超出上限的那几页,不是一次清空');
	assert.deepEqual(evicted, [0, 1, 2, 3, 4], '最久没用到的先卸');

	// touchedAt 才是判据,不是页码。把第 0 页刚用过,它就该留下。
	const pages = manyPages(25);
	pages[0]!.touchedAt = 999;
	assert.deepEqual(pagesToEvict(pages, 100), [1, 2, 3, 4, 5], '刚用过的页留下');
});

test('四条保护: 没翻完 / 没落盘 / 正在用 / 离当前页太近 —— 一条都不许破 (2.8.3 第四批)', () => {
	const guarded: [string, Partial<RetainCandidate>][] = [
		['没翻完', { status: 'translating' }],
		['正在抽取', { status: 'extracting' }],
		['出错了', { status: 'error' }],
		['译文没落盘', { cached: false }],
		['正在渲染 / 仍挂在面板上', { inUse: true }]
	];
	for (const [why, over] of guarded) {
		const pages = manyPages(30).map((p, i) => (i < 25 ? { ...p, ...over } : p));
		const evicted = pagesToEvict(pages, 100);
		for (let i = 0; i < 25; i++) {
			assert.ok(!evicted.includes(i), `${why}: 第 ${i} 页绝不能被卸`);
		}
		// 受保护的页不够卸时,持有量就停在上限之上 —— 不强行淘汰。
		assert.equal(evicted.length, 5, `${why}: 只能从剩下的页里卸,卸不满也不硬卸`);
	}
});

test('当前页前后各 2 页受保护,第 3 页起才可卸 (2.8.3 第四批)', () => {
	const pages = manyPages(30);
	const current = 10;
	const evicted = pagesToEvict(pages, current);
	for (let d = -KEEP_RADIUS; d <= KEEP_RADIUS; d++) {
		assert.ok(!evicted.includes(current + d), `第 ${current + d} 页在保护半径内`);
	}
	assert.equal(KEEP_RADIUS, 2);
	assert.equal(RETAIN_LIMIT, 20);
	// 保护半径之外的最冷页照卸。
	assert.ok(evicted.includes(0));
});

test('已经卸过的页不占容量、不重复卸 (2.8.3 第四批)', () => {
	// 100 页里 90 页早已卸过 —— 持有量只有 10,低于上限,不该再动谁。
	const pages = manyPages(100).map((p, i) => (i < 90 ? { ...p, evicted: true } : p));
	assert.deepEqual(pagesToEvict(pages, 500), [], '轻量状态不算持有完整内容');

	// 持有 25 页(其中 5 页已卸)→ 超出 0 页,还是不动。
	const mixed = manyPages(25).map((p, i) => (i < 5 ? { ...p, evicted: true } : p));
	assert.deepEqual(pagesToEvict(mixed, 500), []);
});

test('可淘汰的页不足时,持有量就停在上限之上 —— 绝不硬卸 (2.8.3 第四批)', () => {
	// 40 页全都没落盘: 一页都卸不了,哪怕远超上限。
	const pages = manyPages(40, { cached: false });
	assert.deepEqual(pagesToEvict(pages, 500), [],
		'没落盘的译文是唯一的一份 —— 宁可多占内存');
});

// ---- 接线的结构闸 -----------------------------------------------------------

test('network, segment-hit, paragraph retry and compression only permit eviction after successful persistence', async () => {
 for (const path of ['network','segments','paragraph','compression'] as const) for (const saved of [false,true]) {
  let requests=0,writes=0;
  const deps: TranslationDeps = {
   extractPage: async pageIndex=>[{id:`b${pageIndex}`,pageIndex,order:0,type:'paragraph',sourceText:'A complete source paragraph.'}],
   readCache:async()=>null,
   ...(path==='segments'?{readSegments:async(_page:number,hashes:string[])=>new Map(hashes.map(hash=>[hash,'Traduction stockée.']))}:{}),
   writeCache:async(pageIndex)=>{if(pageIndex!==0)return true;writes++;return writes===1 && (path==='paragraph'||path==='compression')?true:saved;},
   translateRequest:async request=>{requests++;return {translations:request.blocks.map(b=>({id:b.id,
    translatedText:path==='compression' && requests>1?'Courte.':'Une traduction complète dans la mémoire.'}))};},
   getLanguages:()=>({source:'en',target:'fr'}),getDocumentTitle:()=>'',getGlossary:()=>[],useContext:()=>false,pageCount:()=>10
  };
  const manager=new TranslationManager(deps,{onPageUpdate:()=>{}},{prefetch:false,retainLimit:1});
  try {
   await manager.ensurePage(0,10);
   if(path==='paragraph')assert.equal(await manager.retranslateBlock(0,'b0'),true);
   if(path==='compression')assert.equal((await manager.compressBlocks(0,[{id:'b0',maxChars:10}])).get('b0'),'Courte.');
   assert.equal(writes,path==='paragraph'||path==='compression'?2:1,path);
   assert.equal(manager.getPageState(0)?.cached,saved,path);
   if(path==='segments')assert.equal(requests,0,'an all-segment cache hit needs no provider request');
   await manager.ensurePage(5,10);manager.setCurrentPage(5);
   assert.equal(manager.getPageState(0)?.evicted===true,saved,`${path}: only durable content can be evicted`);
   assert.equal(manager.getPageState(0)?.translations.size,saved?0:1,`${path}: failed storage retains its unique translation`);
  } finally {manager.dispose();}
 }
});

test('a complete page-cache hit remains durable without issuing a new request or rewriting the cache',async()=>{
 let requests=0,writes=0;
 const deps:TranslationDeps={extractPage:async()=>[{id:'b0',pageIndex:0,order:0,type:'paragraph',sourceText:'A complete source paragraph.'}],
  readCache:async()=>[{id:'b0',translatedText:'Traduction déjà enregistrée.'}],writeCache:async()=>{writes++;return false;},
  translateRequest:async()=>{requests++;return {translations:[]};},getLanguages:()=>({source:'en',target:'fr'}),
  getDocumentTitle:()=>'',getGlossary:()=>[],useContext:()=>false,pageCount:()=>1};
 const manager=new TranslationManager(deps,{onPageUpdate:()=>{}},{prefetch:false});
 try {await manager.ensurePage(0,10);assert.equal(manager.getPageState(0)?.cached,true);assert.equal(requests,0);assert.equal(writes,0);}
 finally {manager.dispose();}
});

test('被卸过的页必须能重新装载,且淘汰只在翻页时做 (结构性回归闸, 2.8.3)', () => {
	const src = readFileSync(join(process.cwd(), 'src/translation/translationManager.ts'), 'utf8');
	assert.ok(/existing\.status === 'done' \|\| existing\.status === 'translating'\)\s*\n\s*&& existing\.evicted !== true/.test(src),
		'ensurePage 对被卸过的已完成页不能早退 —— 否则翻回去只剩原文');
	const evict = src.slice(src.indexOf('private evictColdPages()'), src.indexOf('private pageInUse('));
	assert.ok(/state\.blocks = \[\];[\s\S]*?state\.translations = new Map\(\);/.test(evict),
		'卸的是完整内容');
	assert.ok(!/this\.pages\.delete/.test(evict),
		'轻量状态要留着 —— 诊断导出不该因为省内存少掉几页');
	assert.ok(/state\.evicted = true;/.test(evict));
	const inUse = src.slice(src.indexOf('private pageInUse('), src.indexOf('private pageInUse(') + 400);
	assert.ok(/catch \{\s*\n\s*return true;/.test(inUse),
		'问不出"在不在用"时必须当作在用 —— 宁可多占内存,不冒丢译文的险');
});

test('宿主把"在用"接上了面板与当前阅读页 (结构性回归闸, 2.8.3)', () => {
	const session = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	assert.ok(/isPageInUse: \(pageIndex: number\) =>[\s\S]*?adapter\.getCurrentPageIndex\(this\.reader\)[\s\S]*?this\.pane\?\.hasMountedPage\(pageIndex\)/.test(session),
		'当前阅读页与面板上挂着的页都算在用');
	const pane = readFileSync(join(process.cwd(), 'src/ui/translationPane.ts'), 'utf8');
	assert.ok(/hasMountedPage\(pageIndex: number\): boolean \{\s*\n\s*return this\.mounted\.has\(pageIndex\) \|\| this\.pump\.busyPage === pageIndex;/.test(pane),
		'挂着的页与正在重建的页都算在用');
});
