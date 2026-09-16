import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSafeBox, auditPlacedBoxes, boxNewlyViolates, violationStillPresent } from '../../src/ui/layoutSafety';
import { pixelBox } from '../../src/ui/translatedPageView';
import { classifyContent } from '../../src/reader/metaFilter';
import { looksTranslated } from '../../src/translation/translationManager';
import { structureTableCells } from '../../src/reader/tableStructure';
import type { SourceBlock } from '../../src/types/models';
import type { PageRender } from '../../src/reader/zoteroReaderAdapter';

test('wrap image overlap cannot inherit immunity from the source union box', () => {
 const box={left:0,top:0,width:200,height:200};
 const images=[{left:100,top:100,width:100,height:100}];
 const placed={id:'wrap',box,originalBox:box};
 const obstacles={images,preserved:[]};
 const violations=auditPlacedBoxes([placed],obstacles,600,800);
 assert.equal(violations[0]?.kind,'occludes-image');
 assert.equal(boxNewlyViolates(placed,[],obstacles,600,800),true);
 assert.equal(violationStillPresent(violations[0]!,[placed],obstacles,600,800),true);
 const safe=imageSafeBox(box,images)!;
 assert.equal(safe.width*safe.height,20000);
 assert.deepEqual(auditPlacedBoxes([{...placed,box:safe}],obstacles,600,800),[]);
 assert.equal(imageSafeBox(box,[box]),null);
});
test('identifier fragments preserve identifiers without discarding their explanation',()=>{
 for(const text of ['Data Availability: https://example.org/data','Contact us at help@example.org'])
  assert.equal(classifyContent(text).decision,'translate');
 assert.equal(classifyContent('https://example.org/data').decision,'preserve');
 assert.equal(classifyContent('alexios@cardiov.ox.ac.uk').decision,'preserve');
 const title='Deep learning for automated detection of pulmonary nodules';
 assert.equal(looksTranslated(title,title,'zh',{isReference:true}),false);
 assert.equal(looksTranslated('IEEE Trans Med Imaging 2012;31:','IEEE Trans Med Imaging 2012;31:','zh',{isReference:true}),true);
});
test('multiple tables retain separate cell IDs and PDF bounds through rendering',()=>{
 const grids=[0,200].map(top=>({columns:[0,100,200],rows:[top,top+50,top+100],region:{left:0,top,width:200,height:100}}));
 const blocks:SourceBlock[]=grids.flatMap((g,t)=>[0,1].map(col=>({id:`t${t}c${col}`,pageIndex:0,order:t*2+col,type:'paragraph',sourceText:'Clinical findings',boundingBox:{x:col*100+5,y:g.region.top+5,width:40,height:10},lineRectsPdf:[[col*100+5,800-g.region.top-15,col*100+45,800-g.region.top-5]],fontSize:10})));
 const cells=structureTableCells(blocks,0,10,[],grids);
 assert.equal(cells.length,4);
 assert.equal(new Set(cells.map(b=>b.id)).size,4);
 const first=cells.find(b=>b.id==='page-0-table-0-r0-c0')!;
 assert.deepEqual(first.tableRectPdf,[0,750,100,800]);
 const render={scale:2,toViewport:(x:number,y:number)=>[2*x,2*(800-y)]} as PageRender;
 assert.deepEqual(pixelBox(first,render,1),{left:0,top:0,width:200,height:100});
 const rotated={scale:1,toViewport:(x:number,y:number)=>[y,x]} as PageRender;
 assert.deepEqual(pixelBox(first,rotated,1),{left:750,top:0,width:50,height:100});
});

test('local missing border produces a merged cell, preserving its full width', async()=>{
 const {borderGrid}=await import('../../src/reader/tableBorders');
 // Three rows; only the first row is merged. Internal vertical edge covers 2/3.
 const grid=borderGrid([[0,100,200,100],[0,200,200,200],[0,300,200,300],[0,400,200,400],
 [0,100,0,400],[200,100,200,400],[100,100,100,300]],{pageHeight:800})!;
 assert.ok(grid.spans?.some(s=>s.row===0&&s.col===0&&s.colSpan===2&&s.rowSpan===1));
 const blocks:SourceBlock[]=[{id:'heading',pageIndex:0,order:0,type:'paragraph',sourceText:'Combined clinical recommendations',boundingBox:{x:5,y:410,width:190,height:15},lineRectsPdf:[[5,375,195,390]],fontSize:10}];
 const cells=structureTableCells(blocks,0,10,[],grid);
 assert.equal(cells[0]?.tableColSpan,2);
 assert.deepEqual(cells[0]?.tableRectPdf,[0,300,200,400]);
});

// 验证补锁 (2026-09-15): "禁止跨格扩展" 与 "格内遮罩不碰格线" 此前没有任何测试 ——
// 把扩边禁令整个删掉,1334 项测试照样全绿。
test('table cells never expand and their masks stay inside the cell (structural lock)', async () => {
	const { readFileSync } = await import('node:fs');
	const { join } = await import('node:path');
	const src = readFileSync(join(process.cwd(), 'src/ui/strictPageReplacement.ts'), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	assert.match(src, /item\.node\.hasAttribute\('data-pm-cell'\) \? \{ right: 0, down: 0 \} : computeExpansionAllowance\(/,
		'单元格的扩边余量必须恒为 0 —— 跨格扩展是排版禁令');
	assert.match(src, /const inset = block\.tableRectPdf \? Math\.min\(pxPerPoint, whole\.width \/ 4, whole\.height \/ 4\) : 0;/,
		'格内遮罩要向内缩 inset,不能盖到格线');
	assert.match(src, /if \(isTableCellBlock\(block\) && block\.boundingBox\) \{\s*replaceable\.push\(block\);\s*continue;/,
		'提取期已定格的单元格直接进排版,不再二次猜结构');
});
