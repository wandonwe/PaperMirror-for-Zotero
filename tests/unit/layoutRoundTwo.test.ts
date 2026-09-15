import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSafeRegions, flowText, auditPlacedBoxes } from '../../src/ui/layoutSafety';
import { isPureTableValue, inferredCellBox, structureTableCells } from '../../src/reader/tableStructure';
import { detectTableRegions } from '../../src/reader/tableGuard';

test('statistical language never becomes value-only content',()=>{
 for(const text of ['0.40, 0.80) at EID CT','0.84) at PCD CT. Bland-','of agreement: −60.3%','Mean ± SD: 37.7 ± 28.5 Median: 31.8','Lesions with ≥30%']) assert.equal(isPureTableValue(text),false,text);
 for(const text of ['59.5 (45.7–63.9)','18–78','16 (64)','P < .001']) assert.equal(isPureTableValue(text),true,text);
});
test('one-column wrapped statistics do not seed a table without row partners',()=>{
 const items=['0.40, 0.80) at EID CT','and 0.69 (95% CI: 0.45,','0.84) at PCD CT. Bland-','of agreement: −60.3%','to 46.7%) for EID CT','and −10.3% (95% limits'].map((text,i)=>({id:String(i),type:'paragraph',text,box:{left:450,top:578+i*12,width:96,height:10}}));
 const guard=detectTableRegions(items,10);
 assert.equal(guard.regions.length,0);
 assert.equal(guard.excluded.size,0);
});
test('inferred cells get row whitespace without crossing next column or row',()=>{
 const age={id:'age',memberIds:['a'],row:1,col:0,kind:'text' as const,text:'Age (y)',box:{left:54.5,top:325.2,width:25.1,height:9}};
 const value={...age,id:'value',col:1,text:'59.5',box:{left:150,top:325.2,width:30,height:9}};
 const next={...age,id:'next',row:2,box:{left:63.5,top:336.7,width:26.8,height:9}};
 const box=inferredCellBox(age,{cells:[age,value,next],region:{left:54,top:300,width:200,height:100},rowCount:3,colCount:2},9);
 assert.ok(box.width>25.1);assert.ok(box.left+box.width<150);assert.ok(box.top+box.height<336.7);
});
test('wrap flow keeps all characters and never occupies the image',()=>{
 const box={left:0,top:0,width:200,height:200},image={left:0,top:0,width:100,height:100};
 const regions=imageSafeRegions(box,[image]);
 assert.equal(regions.reduce((s,r)=>s+r.width*r.height,0),30000);
 assert.deepEqual(auditPlacedBoxes(regions.map((r,i)=>({id:String(i),box:r,originalBox:r})),{images:[image],preserved:[]},300,300),[]);
 const text='完整译文🙂0123456789'.repeat(5);
 const parts=flowText(text,regions,(t,b)=>Array.from(t).length<=b.width*b.height/300);
 assert.ok(parts);assert.equal(parts.join(''),text);
 assert.equal(flowText(text,regions,()=>false),null);
});

test('reference rejection reasons survive diagnostic export without response text',async()=>{
 const {referenceRejectReason}=await import('../../src/translation/translationManager');
 const {digestRows,diagnosticRows}=await import('../../src/translation/pageBlockDigest');
 const source='Photon-counting CT review.';
 const reason=referenceRejectReason(source,source,'salvage-validator');
 assert.equal(reason,'salvage-validator:reference-echo');
 const rows=diagnosticRows(digestRows({blocks:[{id:'r',pageIndex:0,order:0,type:'list',sourceText:source}],translations:new Map(),keepOrigin:new Map([['r','unrecovered']]),rejectReasons:new Map([['r',reason]]),rejectHistory:new Map([['r',['validator:reference-echo',reason]]])}));
 assert.deepEqual(rows[0]?.rejectHistory,['validator:reference-echo',reason]);
 assert.equal(JSON.stringify(rows).includes(source),false);
});

test('source bands retain the wide continuation below a vector figure',async()=>{
 const {sourceFlowRegions}=await import('../../src/ui/layoutSafety');
 const lines=[{left:450,top:50,width:96,height:10},{left:462,top:62,width:84,height:10},{left:450,top:74,width:96,height:10},{left:306,top:86,width:240,height:10},{left:306,top:98,width:180,height:10}];
 const bands=sourceFlowRegions(lines,10);
 assert.deepEqual(bands,[{left:450,top:50,width:96,height:34},{left:306,top:86,width:240,height:22}]);
 assert.equal(flowText('字'.repeat(70),bands,(t,b)=>t.length<=Math.floor(b.width*b.height/100))?.join(''),'字'.repeat(70));
});

test('explicit PDF page height overrides an ambiguous source anchor',()=>{
 const block={id:'a',pageIndex:0,order:0,type:'paragraph' as const,sourceText:'Clinical findings',fontSize:10,boundingBox:{x:5,y:5,width:40,height:10},lineRectsPdf:[[5,785,45,795] as [number,number,number,number]]};
 const grid={columns:[0,100,200],rows:[0,50,100],region:{left:0,top:0,width:200,height:100}};
 const cells=structureTableCells([block],0,10,[],grid,true,1000);
 assert.deepEqual(cells[0]?.tableRectPdf,[0,950,100,1000]);
});
