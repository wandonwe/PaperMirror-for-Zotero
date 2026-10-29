import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {SourceBlock} from '../../src/types/models';
import {repairBodyColumnOwnership} from '../../src/reader/bodyColumnContinuity';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {coalesceRegions} from '../../src/reader/regionCoalescer';

// Real Kitagawa physical p8 source fragments after extraction, before assigning
// body ownership. The fixture retains PDF line coordinates, not a font/paper rule.
const realFragments:SourceBlock[] = [
 {
  "id": "page-7-region-14",
  "pageIndex": 7,
  "order": 35,
  "type": "paragraph",
  "sourceText": "The receiver-operating characteristic curve and corresponding area under the curve describing the diagnostic performance of coronary computed tomography angiography (CTA) alone and combined CTA plus dynamic computed tomography perfusion (CTP) with relative myocardial blood flow to identify hemodynamically significant coronary artery disease as defined by invasive coronary angiography with fractional flow reserve at (A) the patient level and (B) the vessel level. Adding CTP to coronary CTA significantly increased the area under the curve at both the patient and vessel levels.",
  "boundingBox": {
   "x": 86.6834,
   "y": 491.46900800000003,
   "width": 431.26309632000005,
   "height": 36.203456639999956
  },
  "lineRectsPdf": [
   [
    86.6834,
    276.17659199999997,
    510.6977072,
    282.50299199999995
   ],
   [
    86.6834,
    266.25553152,
    506.59187360000004,
    272.58193151999996
   ],
   [
    86.6834,
    256.27753343999996,
    517.94649632,
    262.60393343999993
   ],
   [
    86.68340000000006,
    246.29953536,
    500.5552227200002,
    252.62593536
   ]
  ],
  "fontSize": 6.5,
  "column": -1,
  "readingIndex": 35
 },
 {
  "id": "page-7-region-15",
  "pageIndex": 7,
  "order": 36,
  "type": "paragraph",
  "sourceText": "presented in Supplemental Table 4. Thirty-two patients with positive CTA were correctly reclassified as negative by CTP, and 16 patients with positive CTA who had hemodynamically significant CAD on ICA were incorrectly reclassified as negative by CTP. CTA and ICA findings in these 16 patients are summarized in Supplemental Table 5. The sensitivity, specificity,",
  "boundingBox": {
   "x": 109.75662789999994,
   "y": 561.70092,
   "width": 206.23794729999997,
   "height": 79.4375085
  },
  "lineRectsPdf": [
   [
    109.7574,
    204.55008,
    315.95365389999984,
    212.27108
   ],
   [
    109.7581721,
    192.5879347,
    315.97141220000003,
    200.3089347
   ],
   [
    109.75739999999999,
    180.6257894,
    315.93280720000007,
    188.3467894
   ],
   [
    109.75739999999999,
    168.6636441,
    315.94747709999984,
    176.3846441
   ],
   [
    109.75662789999996,
    156.7014988,
    315.99457519999993,
    164.4224988
   ],
   [
    109.75662789999994,
    144.7393535,
    315.9497934,
    152.4603535
   ],
   [
    109.75662789999996,
    132.8335715,
    315.9551980999999,
    140.5545715
   ]
  ],
  "fontSize": 7.5,
  "column": -1,
  "readingIndex": 36
 },
 {
  "id": "page-7-region-16",
  "pageIndex": 7,
  "order": 37,
  "type": "paragraph",
  "sourceText": "(95% CI: 61%-82%), 75% (95% CI: 65%-84%), 73% (95% CI: 65%-81%), 74% (95% CI: 66%-81%), and 74% (95% CI: 66%-80%), respectively, with a significant improvement in specificity (P < 0.001) and accuracy (P < 0.001) and a significant decrease in sensitivity (P < 0.001). Continuous net reclassification improvement and",
  "boundingBox": {
   "x": 327.9088502999999,
   "y": 561.70092,
   "width": 206.25493350000022,
   "height": 79.43750850000004
  },
  "lineRectsPdf": [
   [
    327.90962239999993,
    204.55007999999998,
    534.1614675000002,
    212.27107999999998
   ],
   [
    327.90962239999993,
    192.58793469999998,
    534.1081926,
    200.30893469999998
   ],
   [
    327.90962239999993,
    180.62578939999997,
    534.1622396,
    188.34678939999998
   ],
   [
    327.9088502999999,
    168.66364409999997,
    534.1637838000001,
    176.38464409999997
   ],
   [
    327.9088502999999,
    156.70149879999997,
    534.1491138999999,
    164.42249879999997
   ],
   [
    327.9088503,
    144.73935349999996,
    534.1274950999999,
    152.46035349999997
   ],
   [
    327.9096224,
    132.83357149999998,
    379.9931721,
    140.55457149999998
   ],
   [
    394.61597400000005,
    132.83357149999998,
    408.90908920000004,
    140.55457149999998
   ]
  ],
  "fontSize": 7.5,
  "column": -1,
  "readingIndex": 37
 },
 {
  "id": "page-7-region-17",
  "pageIndex": 7,
  "order": 38,
  "type": "paragraph",
  "sourceText": "integrated",
  "boundingBox": {
   "x": 423.5859381,
   "y": 633.4174285,
   "width": 39.79789449999993,
   "height": 7.721000000000004
  },
  "lineRectsPdf": [
   [
    423.5859381,
    132.83357149999998,
    463.38383259999995,
    140.55457149999998
   ]
  ],
  "fontSize": 7.5,
  "column": -1,
  "readingIndex": 38
 },
 {
  "id": "page-7-region-18",
  "pageIndex": 7,
  "order": 39,
  "type": "paragraph",
  "sourceText": "discrimination",
  "boundingBox": {
   "x": 478.00354609999994,
   "y": 633.4174285,
   "width": 56.09846969999995,
   "height": 7.721000000000004
  },
  "lineRectsPdf": [
   [
    478.00354609999994,
    132.83357149999998,
    534.1020157999999,
    140.55457149999998
   ]
  ],
  "fontSize": 7.5,
  "column": -1,
  "readingIndex": 39
 },
 {
  "id": "page-7-region-19",
  "pageIndex": 7,
  "order": 40,
  "type": "paragraph",
  "sourceText": "positive and negative predictive values, and accuracy of CTA alone with a fixed cutoff (≥50% stenosis) were 93% (95% CI: 85%-98%), 36% (95% CI: 25%-47%), 58% (95% CI: 53%-62%), 85% (95% CI: 70%-93%), and 64%",
  "boundingBox": {
   "x": 109.75585579999992,
   "y": 645.3795738,
   "width": 206.22559369999996,
   "height": 43.60743590000004
  },
  "lineRectsPdf": [
   [
    109.75662789999996,
    120.8714262,
    315.9497934000001,
    128.5924262
   ],
   [
    109.75662789999996,
    108.9092809,
    315.9814494999999,
    116.6302809
   ],
   [
    109.75585579999992,
    96.9471356,
    315.9212256999996,
    104.6681356
   ],
   [
    109.75585579999992,
    84.98499029999999,
    315.95828649999964,
    92.7059903
   ]
  ],
  "fontSize": 7.5,
  "column": 0,
  "readingIndex": 40
 },
 {
  "id": "page-7-region-20",
  "pageIndex": 7,
  "order": 41,
  "type": "paragraph",
  "sourceText": "improvement were 0.289 (95% CI: 0.014-0.564; P = 0.039) and 0.029 (95% CI: -0.015 to 0.072; P = 0.192), respectively, when comparing combined CTA and CTP to CTA alone. The percentage of patients",
  "boundingBox": {
   "x": 327.9096224,
   "y": 645.3795738,
   "width": 206.2919943000004,
   "height": 43.60743590000004
  },
  "lineRectsPdf": [
   [
    327.9096224,
    120.87142619999997,
    534.1830862999998,
    128.59242619999998
   ],
   [
    327.9096224,
    108.90928089999997,
    534.1313556000001,
    116.63028089999997
   ],
   [
    327.9096224,
    96.94713559999997,
    534.2016167000004,
    104.66813559999997
   ],
   [
    327.9096224,
    84.98499029999996,
    534.1213182999996,
    92.70599029999997
   ]
  ],
  "fontSize": 7.5,
  "column": 1,
  "readingIndex": 41
 },
 {
  "id": "page-7-region-21",
  "pageIndex": 7,
  "order": 42,
  "type": "paragraph",
  "sourceText": "(95% CI: 56%-71%). When relative MBF was added to CTA with a cutoff of 0.68, these values were 72%",
  "boundingBox": {
   "x": 109.75585579999992,
   "y": 693.228155,
   "width": 206.2340867999997,
   "height": 19.6831453
  },
  "lineRectsPdf": [
   [
    109.75585579999992,
    73.02284499999999,
    315.9899425999996,
    80.743845
   ],
   [
    109.75585579999992,
    61.060699699999994,
    315.9443886999999,
    68.78169969999999
   ]
  ],
  "fontSize": 7.5,
  "column": -1,
  "readingIndex": 42
 },
 {
  "id": "page-7-region-22",
  "pageIndex": 7,
  "order": 43,
  "type": "paragraph",
  "sourceText": "with CAD whose probability of CAD increased by adding the results of CTP to CTA was 34.2% (26/76),",
  "boundingBox": {
   "x": 327.9096224,
   "y": 693.228155,
   "width": 206.22945420000042,
   "height": 19.6831453
  },
  "lineRectsPdf": [
   [
    327.9096224,
    73.02284499999996,
    534.1228625000003,
    80.74384499999996
   ],
   [
    327.9096224,
    61.060699699999965,
    534.1390766000004,
    68.78169969999996
   ]
  ],
  "fontSize": 7.5,
  "column": -1,
  "readingIndex": 43
 }
];
function block(id:string,column:number,x:number,y:number,w=200,h=10):SourceBlock {
 return {id,pageIndex:0,order:0,type:'paragraph',sourceText:'A complete body sentence for this column.',fontSize:10,column,
  boundingBox:{x,y,width:w,height:h},lineRectsPdf:[[x,800-y-h,x+w,800-y]]};
}
function simple() {return [block('left',0,40,100),block('right',1,260,100),block('lost',-1,40,120)];}
function copy<T>(x:T):T {return JSON.parse(JSON.stringify(x));}
function changed(input:SourceBlock[]) {return repairBodyColumnOwnership(input).filter((b,i)=>b.column!==input[i]!.column);}
function transform(input:SourceBlock[],scale:number,dx:number,dy:number):SourceBlock[] {
 return input.map(b=>({...b,fontSize:b.fontSize!*scale,
  lineRectsPdf:b.lineRectsPdf?.map(r=>[r[0]*scale+dx,r[1]*scale+dy,r[2]*scale+dx,r[3]*scale+dy]),
  boundingBox:b.boundingBox?{x:b.boundingBox.x*scale+dx,y:b.boundingBox.y*scale-dy,width:b.boundingBox.width*scale,height:b.boundingBox.height*scale}:undefined}));
}

test('real short two-column prose band recovers six full-width mislabels without changing content or geometry',()=>{
 const input=copy(realFragments),before=copy(input),result=repairBodyColumnOwnership(input);
 const expected=new Map([['page-7-region-15',0],['page-7-region-16',1],['page-7-region-17',1],['page-7-region-18',1],['page-7-region-21',0],['page-7-region-22',1]]);
 assert.equal(result.filter((b,i)=>b.column!==input[i]!.column).length,6);
 for(let i=0;i<result.length;i++) {
  const a=input[i]!,b=result[i]!;assert.equal(b.column,expected.get(b.id)??a.column);
  assert.deepEqual({...b,column:a.column},a);assert.equal(b.id,a.id);
 }
 assert.deepEqual(input,before);assert.equal(result[0]!.column,-1,'genuinely wide figure description stays wide');
});

for(const scale of [0.75,1,1.5])test(`column evidence is scale/translation independent (${scale})`,()=>{
 const result=repairBodyColumnOwnership(transform(copy(realFragments),scale,23,-17));
 assert.deepEqual(result.map(b=>b.column),[-1,0,1,1,1,0,1,0,1]);
});

test('page finalization reconstructs the complete five-metric sentence in the left column',()=>{
 const input=copy(realFragments),result=finalizePageRegions(input,774);
 const left=result.find(b=>b.sourceText.includes('The sensitivity, specificity,'))!;
 const right=result.find(b=>b.sourceText.includes('integrated discrimination improvement'))!;
 assert.ok(left);assert.ok(right);assert.equal(left.column,0);assert.equal(right.column,1);
 assert.ok(left.sourceText.includes('The sensitivity, specificity, positive and negative predictive values, and accuracy'));
 assert.ok(left.sourceText.includes('were 93%'));assert.ok(left.sourceText.includes('and 64% (95% CI: 56%-71%)'));
 assert.ok(!left.sourceText.includes('P = 0.039'));
 assert.ok(!right.sourceText.includes('positive and negative predictive values'));
 assert.deepEqual(left.memberIds,['page-7-region-15','page-7-region-19','page-7-region-21']);
 assert.deepEqual(right.memberIds,['page-7-region-16','page-7-region-17','page-7-region-18','page-7-region-20','page-7-region-22']);
 for(const b of input)for(const r of b.lineRectsPdf??[]) {
  assert.equal(result.flatMap(x=>x.lineRectsPdf??[]).filter(x=>x.every((v,i)=>v===r[i])).length,1);
 }
});

test('input order cannot change locally proved ownership',()=>{
 const input=copy(realFragments).reverse(),result=repairBodyColumnOwnership(input);
 const owners=new Map(repairBodyColumnOwnership(copy(realFragments)).map(b=>[b.id,b.column]));
 for(const b of result)assert.equal(b.column,owners.get(b.id));
});

test('no unknown column leaves an established two-column page untouched',()=>{
 const input=simple().slice(0,2);assert.equal(repairBodyColumnOwnership(input),input);
});

test('one column is insufficient evidence',()=>{const input=simple().filter(b=>b.id!=='right');assert.equal(repairBodyColumnOwnership(input),input);});
test('anchors on different pages cannot form a pair',()=>{const input=simple();input[1]!.pageIndex=1;assert.equal(changed(input).length,0);});
test('candidate on a different page is not repaired',()=>{const input=simple();input[2]!.pageIndex=1;assert.equal(changed(input).length,0);});
test('vertically separate paragraphs are not a pair of columns',()=>{const input=simple();input[1]=block('right',1,260,200);assert.equal(changed(input).length,0);});
test('strongly different column widths are ambiguous',()=>{const input=simple();input[1]=block('right',1,260,100,90);assert.equal(changed(input).length,0);});
test('very wide gutters do not attach a distant sidebar',()=>{const input=simple();input[1]=block('right',1,440,100);assert.equal(changed(input).length,0);});
test('a genuinely spanning body paragraph remains spanning',()=>{const input=simple();input[2]=block('wide',-1,40,120,420);assert.equal(changed(input).length,0);});
test('distant body fragment does not inherit a column',()=>{const input=simple();input[2]=block('lost',-1,40,220);assert.equal(changed(input).length,0);});
test('matching font size is required',()=>{const input=simple();input[2]!.fontSize=8;assert.equal(changed(input).length,0);});
test('unmeasured or malformed geometry fails closed',()=>{
 for(const mutation of [(b:SourceBlock)=>{b.fontSize=undefined;},(b:SourceBlock)=>{b.lineRectsPdf=[];},(b:SourceBlock)=>{b.lineRectsPdf=[[40,660,NaN,670]];}]) {
  const input=simple();mutation(input[2]!);assert.equal(changed(input).length,0);
 }
});

for(const kind of ['caption','table','heading','title'] as const)test(`${kind} cannot be repaired as prose`,()=>{
 const input=simple();input[2]!.type=kind;assert.equal(changed(input).length,0);
});
for(const prop of ['tableId','tableRow','tableCol','isReference','preserveReason','imageTextRegionPdf','translationMode','sourceRegion'] as const)test(`${prop} ownership is protected`,()=>{
 const input=simple();Object.assign(input[2]!,{[prop]:({tableId:'table',tableRow:0,tableCol:0,isReference:true,preserveReason:'running-head',imageTextRegionPdf:[40,670,240,680],translationMode:'preserve',sourceRegion:{id:'explicit',kind:'body-column',boundsPdf:[40,670,240,680],evidence:'column-geometry'}})[prop]});
 assert.equal(changed(input).length,0);
});

test('headings and explicit drawn rules interrupt column recovery',()=>{
 const input=simple();input[2]=block('lost',-1,40,140);
 const barrier={...block('heading',-1,40,120,420),type:'heading' as const};
 assert.equal(changed([...input,barrier]).length,0);
 assert.equal(repairBodyColumnOwnership(input,[[40,675,460,676]]),input);
});

test('a wide prose separator also interrupts recovery',()=>{
 const input=simple();input[2]=block('lost',-1,40,140);
 const barrier=block('wide',-1,40,120,420);
 assert.equal(changed([...input,barrier]).length,0);
});

test('conflicting valid column identities fail closed',()=>{
 const input=simple(),other=[{...input[0]!,id:'other-left',column:2},{...input[1]!,id:'other-right',column:3}];
 assert.equal(changed([...input,...other]).length,0);
});

test('cross-column sentence fragments retain separate geometric identities',()=>{
 const input=[{...block('a',0,40,700),sourceText:'There were no failed'}, {...block('b',1,260,100),sourceText:'acquisitions or intolerance.'}];
 const result=finalizePageRegions(input,800);assert.equal(result.length,2);
 assert.ok(result.some(b=>b.sourceText==='There were no failed'));
 assert.ok(result.some(b=>b.sourceText==='acquisitions or intolerance.'));
});

test('real narrow body tail rejoins a line-hyphenated word without losing source letters or lines',()=>{
 const fixture=JSON.parse(readFileSync('tests/fixtures/layout/radiology2023-p11.spans.json','utf8'));
 const raw=buildBlocksFromSpans(fixture.items,{pageIndex:0,pageWidth:fixture.pageWidth,pageHeight:fixture.pageHeight,includeReferences:false}).blocks;
 const structured=structureTableCells(orderBlocksForReading(raw),0,10);
 const before=coalesceRegions(structured.filter(b=>b.translationMode===undefined))
  .filter(b=>b.sourceText.includes('types of reconstruc-')||b.sourceText.startsWith('tions. Handling'));
 assert.equal(before.length,2);
 const result=finalizePageRegions(structured,fixture.pageHeight);
 const after=result.filter(b=>b.sourceText.includes('types of reconstructions. Handling'));
 assert.equal(after.length,1);assert.equal(after[0]!.column,0);
 assert.equal(after[0]!.sourceText.length,before.reduce((n,b)=>n+b.sourceText.length,0)-1,'only the line-break hyphen is removed');
 const inventory=(bs:SourceBlock[])=>bs.map(b=>b.sourceText).join('').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'');
 assert.equal(inventory(after),inventory(before));
 const rects=(bs:SourceBlock[])=>bs.flatMap(b=>b.lineRectsPdf??[]).map(r=>JSON.stringify(r)).sort();
 assert.deepEqual(rects(after),rects(before));
 assert.deepEqual(rects(result),rects(structured));
});
