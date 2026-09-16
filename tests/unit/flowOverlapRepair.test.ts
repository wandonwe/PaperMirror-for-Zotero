import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceFlowRegions, auditPlacedBoxes, violationStillPresent, flowText } from '../../src/ui/layoutSafety';
import type { PixelBox } from '../../src/ui/translatedPageView';
const fixtures=JSON.parse(readFileSync('tests/fixtures/regression/cadrads2022-flow-overlap.json','utf8')) as {id:string;fontPx:number;lines:PixelBox[]}[];
const overlap=(a:PixelBox,b:PixelBox)=>Math.max(0,Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top));
for(const fixture of fixtures) test(`CAD-RADS ${fixture.id}: flow owns each area once and covers source lines`,()=>{
 const regions=sourceFlowRegions(fixture.lines,fixture.fontPx);
 for(let i=0;i<regions.length;i++) for(let j=i+1;j<regions.length;j++) assert.ok(overlap(regions[i]!,regions[j]!)<1e-6);
 for(const line of fixture.lines) assert.ok(Math.abs(regions.reduce((s,r)=>s+overlap(line,r),0)-line.width*line.height)<1e-6);
 const placed=regions.map(box=>({id:fixture.id,box,originalBox:{...box,width:0,height:0}}));
 assert.deepEqual(auditPlacedBoxes(placed,{images:[],preserved:[]},594,783),[]);
 const text='完整译文🙂'.repeat(10);
 assert.equal(flowText(text,regions,(t,r)=>Array.from(t).length<=Math.floor(r.width*r.height/100))?.join(''),text);
});
test('multi-region recheck compares distinct regions, including every counterpart',()=>{
 const box={left:0,top:0,width:100,height:100};
 const a={id:'a',box,originalBox:{...box,width:0,height:0}};
 const b={...a,box:{...box,left:50}};
 const obstacles={images:[],preserved:[]};
 const v={id:'a',otherId:'a',kind:'overlap' as const,area:5000};
 assert.equal(violationStillPresent(v,[a,b],obstacles,500,500),true);
 assert.equal(violationStillPresent(v,[a],obstacles,500,500),false);
 assert.equal(violationStillPresent(v,[a,{...b,box:{...box,left:150}}],obstacles,500,500),false);
 assert.equal(violationStillPresent({...v,otherId:'b'},[a,{...b,id:'b',box:{...box,left:150}},{...b,id:'b'}],obstacles,500,500),true);
});
