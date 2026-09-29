import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verticalExpansionCandidates, probeStrictPlacement} from '../../src/ui/strictPageReplacement';
test('vertical expansion includes small available space without crossing its budget or widening columns',()=>{
 for(const down of [0,.3,1,3.9,20,1000]) {
  const candidates=verticalExpansionCandidates(200,40,down,10);
  assert.ok(candidates.length<=33);
  if(!down){assert.deepEqual(candidates,[]);continue;}
  assert.deepEqual(candidates.at(-1),[200,40+down]);
  let previous=40;
  for(const [width,height] of candidates){assert.equal(width,200);assert.ok(height>previous && height<=40+down);previous=height;}
 }
});
test('placement probe forwards the lightweight mode to the renderer',()=>{
 let sampled:boolean|undefined;
 const e={pmProbe:(value:boolean)=>{sampled=value;return [];}} as unknown as HTMLElement;
 assert.deepEqual(probeStrictPlacement(e,false),[]);assert.equal(sampled,false);
 probeStrictPlacement(e);assert.equal(sampled,true);
});
