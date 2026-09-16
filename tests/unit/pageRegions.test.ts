import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assignPageRegions,finalizePageRegions} from '../../src/reader/pageRegions';
import {validatePageIR} from '../../src/ir/documentIR';
import type {SourceBlock} from '../../src/types/models';
function block(id:string,column:number,r:[number,number,number,number],text='Natural language to translate.'):SourceBlock {
 return {id,pageIndex:0,type:'paragraph',sourceText:text,column,readingIndex:0,lineRectsPdf:[r],boundingBox:{x:r[0],y:800-r[3],width:r[2]-r[0],height:r[3]-r[1]}} as SourceBlock;
}
test('page ownership separates columns and footer without changing translation policy',()=>{
 const input=[block('left',0,[40,600,200,620]),block('right',1,[220,600,380,620]),block('footer',0,[40,20,200,30],'Radiology: Volume 256')];
 const result=assignPageRegions(input,800);
 assert.deepEqual(result.map(b=>b.sourceRegion?.kind),['body-column','body-column','page-furniture']);
 assert.equal(new Set(result.map(b=>b.sourceRegion!.id)).size,3);
 assert.deepEqual(result.map(b=>b.sourceText),input.map(b=>b.sourceText));
 assert.ok(result.every(b=>b.translationMode===undefined));
 assert.ok(input.every(b=>!b.sourceRegion));
 const poisoned=result.map((b,i)=>({...b,readingIndex:i}));
 poisoned[1]!.sourceRegion=poisoned[0]!.sourceRegion;
 assert.ok(validatePageIR({pageIndex:0,blocks:poisoned}).some(v=>v.invariant==='region-consistency'));
});
test('caption partitions body ownership above and below a spanning figure',()=>{
 const above=block('above',0,[40,700,200,720]);
 const below=block('below',0,[40,500,200,520]);
 const caption={...block('cap',-1,[40,550,380,580],'Figure 1: a caption.'),type:'caption' as const};
 const result=assignPageRegions([above,caption,below],800);
 assert.notEqual(result[0]!.sourceRegion!.id,result[2]!.sourceRegion!.id);
 assert.equal(result[1]!.sourceRegion!.kind,'caption');
});
test('table ownership uses exact cell bounds and never groups adjacent cells',()=>{
 const cells=[0,1].map(col=>({...block(`cell${col}`,0,[40+col*100,600,130+col*100,610]),tableId:'table',tableRow:0,tableCol:col,tableRectPdf:[40+col*100,590,140+col*100,620] as [number,number,number,number],translationMode:'translate' as const}));
 const result=finalizePageRegions(cells,800);
 assert.equal(result.length,2);
 for(const b of result){assert.equal(b.sourceRegion!.kind,'table-cell');assert.deepEqual(b.sourceRegion!.boundsPdf,b.tableRectPdf);assert.equal(b.translationMode,'translate');}
 assert.notEqual(result[0]!.sourceRegion!.id,result[1]!.sourceRegion!.id);
});
