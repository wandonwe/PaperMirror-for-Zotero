import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutWidthFits, fitOverflow} from '../../src/ui/strictPageReplacement';

test('Bae p21 at → 于 cannot be committed inside a narrower horizontal clip',()=>{
 // Repeated Zotero 10.0.9 / DPR2 evidence from public 4.9.0: original box
 // 5.6333313px, 6.48px text, scrollWidth 7, four clipped pixels at each phase.
 // The two repeated focused captures also measured clientWidth 6 (not inferred).
 const boxWidth=5.633331298828125,scrollWidth=7;
 assert.equal(fitOverflow(scrollWidth,9,boxWidth,7.9000091552734375),'none','legacy coarse prefilter alone accepted the clipped glyph');
 assert.equal(layoutWidthFits(scrollWidth,Math.round(boxWidth)),false);
 // All-font-box candidate used 6.95px text and still had scrollWidth 7.
 assert.equal(layoutWidthFits(7,6),false);
});

test('one extra layout pixel is overflow at every box width, including small flow pieces',()=>{
 for(const width of [1,6,9,18,56,183,450]){
  assert.equal(layoutWidthFits(width,width),true);
  assert.equal(layoutWidthFits(width+1,width),false);
  assert.equal(layoutWidthFits(Math.max(0,width-1),width),true);
 }
});

test('fractional box rounding is not counted twice as horizontal allowance',()=>{
 for(const actualWidth of [5.4,5.6333313,9.2666626,18.7000122,55.6166687]){
  const clientWidth=Math.round(actualWidth);
  assert.equal(layoutWidthFits(clientWidth,clientWidth),true);
  assert.equal(layoutWidthFits(clientWidth+1,clientWidth),false);
 }
});

test('invalid or non-layout width readings cannot authorize a fit',()=>{
 for(const [scroll,client] of [[NaN,6],[7,NaN],[Infinity,6],[7,Infinity],[-1,6],[0,-1],[6.4,6],[6,6.4]])assert.equal(layoutWidthFits(scroll!,client!),false);
 assert.equal(layoutWidthFits(0,0),true);
});
