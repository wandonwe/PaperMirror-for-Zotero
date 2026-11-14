import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isJournalFurniture, isRunningHeadOrFoot, type Rect} from '../../src/reader/metaFilter';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {TranslationManager, type TranslationDeps} from '../../src/translation/translationManager';
import type {SourceBlock} from '../../src/types/models';

const locator = 'Radiology: Volume 256: Number 1—July 2010';
const baeFooter: Rect = [408.335,57.389,581.990,64.389];

test('complete journal locators just beyond the old eight-percent margin are furniture', () => {
	assert.equal(isRunningHeadOrFoot(baeFooter,783,1,locator),false,'the actual Bae footer is outside the old band');
	for (const text of [locator, `radiology.rsna.org n ${locator}`, `${locator} ■ radiology.rsna.org`,
		`40 radiology.rsna.org ▪ ${locator}`, `${locator} ■ radiology.rsna.org 40`,
		'Journal of Examples: Volume 12: Issue 3—March 2025',
		'Imaging Research: Vol. 42; No. 7–Sep. 2024']) {
		assert.ok(isJournalFurniture(text,baeFooter,783),text);
	}
});

test('journal furniture recognition is invariant to page scale and accepts headers', () => {
	for (const scale of [0.5,1,2]) {
		assert.ok(isJournalFurniture(locator,baeFooter.map(x=>x*scale) as Rect,783*scale));
		assert.ok(isJournalFurniture(locator,[40,735,400,745].map(x=>x*scale) as Rect,783*scale));
	}
});

test('margin location, complete locator grammar and bounded height are all required', () => {
	for (const text of ['Radiology', 'Volume 256', 'radiology.rsna.org',
		'The volume was measured in July 2010.',
		`The report cited ${locator} and other sources.`,
		`“${locator}” was printed on the cover.`,
		'Radiology: Volume 256: Number 1',
		'Volume CT dose index was 2.48 mGy in the patient.',
		`${locator} We measured the blood volume.`]) assert.ok(!isJournalFurniture(text,baeFooter,783),text);
	assert.ok(!isJournalFurniture(locator,[40,300,400,310],783),'same wording inside body stays translatable');
	assert.ok(!isJournalFurniture(locator,[40,10,400,70],783),'a multi-line body extent cannot be furniture');
	for (const height of [0,-1,NaN,Infinity]) assert.ok(!isJournalFurniture(locator,baeFooter,height));
	assert.ok(!isJournalFurniture(locator,[40,30,40,40],783));
});

function bae(page: number): SourceBlock[] {
	const dump=JSON.parse(readFileSync(`tests/fixtures/regression/bae2010-p${page}.json`,'utf8'));
	return finalizePageRegions(buildBlocksFromSpans(dump.items,{
		pageIndex:page-1,pageWidth:dump.pageWidth,pageHeight:dump.pageHeight,includeReferences:true
	}).blocks,dump.pageHeight);
}

test('real Bae pages keep the complete footer and ink geometry but do not translate it', () => {
	for (const page of [9,19]) {
		const blocks=bae(page);
		const footer=blocks.find(b=>b.sourceText.includes(locator));
		assert.ok(footer,`Bae page ${page}: footer must survive extraction`);
		assert.equal(footer.sourceText,`radiology.rsna.org n ${locator}`);
		assert.equal(footer.translationMode,'preserve');
		assert.equal(footer.preserveReason,'running-head');
		assert.equal(footer.sourceRegion?.kind,'page-furniture');
		assert.equal(footer.lineRectsPdf?.length,1);
		assert.ok((footer.boundingBox?.height ?? 0)>0);
		assert.ok(blocks.some(b=>b.translationMode!=='preserve' && b.sourceText.length>200),'body remains translatable');
		assert.equal(blocks.filter(b=>b.sourceText.includes('radiology.rsna.org')).length,1,'no duplicate footer or body merge');
	}
});

test('explicit journal locators override title classification without suppressing article titles', () => {
	const items: SpanItem[] = [
		{text:'Assessment of blood volume',rect:[50,748,400,768],fontSize:20},
		{text:'The study examined contrast enhancement in patients.',rect:[50,600,400,610],fontSize:10},
		{text:locator,rect:[50,65,500,80],fontSize:15}
	];
	const blocks=buildBlocksFromSpans(items,{pageIndex:0,pageWidth:600,pageHeight:840}).blocks;
	assert.equal(blocks.find(b=>b.sourceText===locator)?.translationMode,'preserve');
	assert.notEqual(blocks.find(b=>b.sourceText==='Assessment of blood volume')?.translationMode,'preserve');
});

test('translation manager excludes the real journal footer from every provider request', async () => {
	const blocks=bae(19);
	const footer=blocks.find(b=>b.sourceText.includes(locator))!;
	const body=blocks.find(b=>b.sourceText.startsWith('clinical images'))!;
	assert.ok(body);
	const requested: string[]=[];
	const deps: TranslationDeps = {
		extractPage:async()=>[body,footer],
		translateRequest:async request=>{
			requested.push(...request.blocks.map(b=>b.id));
			assert.ok(request.blocks.every(b=>!b.text.includes('radiology.rsna.org') && !b.text.includes('Volume 256')));
			return {translations:request.blocks.map(b=>({id:b.id,translatedText:'临床影像检查可帮助评估对比增强。'}))};
		},
		readCache:async()=>null,writeCache:async()=>{},getLanguages:()=>({source:'en',target:'zh-CN'}),
		getDocumentTitle:()=>'',getGlossary:()=>[],useContext:()=>false,pageCount:()=>1
	};
	const manager=new TranslationManager(deps,{onPageUpdate:()=>{}},{prefetch:false,delayFn:async()=>{}});
	try {
		await manager.ensurePage(0,10);
		assert.ok(requested.includes(body.id),'the control paragraph does reach the mock provider');
		assert.ok(!requested.includes(footer.id));
		assert.ok(manager.getPageState(0)?.blocks.some(b=>b.id===footer.id),'preserved geometry remains in page state');
	} finally {manager.dispose();}
});
