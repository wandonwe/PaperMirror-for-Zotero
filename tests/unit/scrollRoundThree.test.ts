import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncGuard, createSyncController } from '../../src/reader/scrollSynchronizer';
import { sourceFlowRegions } from '../../src/ui/layoutSafety';

test('explicit input changes scroll ownership within the echo window',()=>{
 const g=new SyncGuard({now:()=>100});
 g.willMove('pane'); assert.equal(g.shouldPropagate('pane'),false);
 g.takeControl('pane'); assert.equal(g.shouldPropagate('pane'),true); assert.equal(g.shouldPropagate('pdf'),false);
 g.takeControl('pdf'); assert.equal(g.shouldPropagate('pdf'),true); assert.equal(g.shouldPropagate('pane'),false);
});
test('two-column source flows down each column, not across alternating rows',()=>{
 const lines=[];
 for(let top=0;top<120;top+=12) for(const left of [0,160]) lines.push({left,top,width:140,height:10});
 assert.deepEqual(sourceFlowRegions(lines,10),[{left:0,top:0,width:140,height:118},{left:160,top:0,width:140,height:118}]);
});
test('a real full-width line prevents an invented column gutter',()=>{
 const lines=[{left:0,top:0,width:300,height:10},{left:0,top:12,width:300,height:10},{left:0,top:24,width:80,height:10}];
 assert.deepEqual(sourceFlowRegions(lines,10),[{left:0,top:0,width:300,height:34}]);
});

test('runtime page 6 geometry forms two vertical columns',async()=>{
 const {readFileSync}=await import('node:fs');
 const lines=JSON.parse(readFileSync('tests/fixtures/regression/20260915-page6-column-lines.json','utf8'));
 const regions=sourceFlowRegions(lines,12);
 assert.equal(regions.length,2);
 assert.ok(regions[0]!.left+regions[0]!.width < regions[1]!.left);
 assert.ok(regions.every(r=>r.height>150));
});

test('continuous anchors propagate within a page in both directions without echo',()=>{
 const seen:string[]=[];
 const controller=createSyncController({scrollPaneToPage:()=>{},navigatePdfToPage:()=>{},
  scrollPaneToPosition:(p,f)=>seen.push(`pane:${p}:${f}`),scrollPdfToPosition:(p,f)=>seen.push(`pdf:${p}:${f}`)});
 controller.onPdfPositionChanged(6,0.2);controller.onPdfPositionChanged(6,0.4);
 controller.onPanePositionChanged(6,0.4); // echo
 assert.deepEqual(seen,['pane:6:0.2','pane:6:0.4']);
 controller.guard.takeControl('pane');
 controller.onPanePositionChanged(6,0.5);controller.onPanePositionChanged(6,0.7);
 controller.onPdfPositionChanged(6,0.7); // echo
 assert.deepEqual(seen.slice(2),['pdf:6:0.5','pdf:6:0.7']);
 controller.enabled=false;controller.guard.reset();controller.onPdfPositionChanged(7,0.1);controller.onPanePositionChanged(7,0.1);
 assert.equal(seen.length,4);
});
