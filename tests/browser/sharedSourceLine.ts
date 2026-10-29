import { buildStrictPage, probeStrictPlacement } from '../../src/ui/strictPageReplacement';
import type { SourceBlock } from '../../src/types/models';
import type { PixelBox } from '../../src/ui/translatedPageView';

/** Real DOM/font/canvas regression: one paragraph falls back while the next
 * starts at the other end of their shared source line. Safe subtraction leaves
 * just one lower band; returning to the union rectangle would overprint TAIL A.
 */
export function checkSharedSourceLine(): void {
 const pageWidth = 360, pageHeight = 300;
 const linesA = [
  {left:60,top:80,width:140,height:10,text:'First source paragraph.'},
  {left:60,top:92,width:140,height:10,text:'Continues on a shared line.'},
  {left:60,top:104,width:70,height:10,text:'TAIL A'}
 ];
 const linesB = [
  {left:170,top:104,width:30,height:10,text:'B'},
  ...[116,128,140,152].map(top => ({left:60,top,width:140,height:10,text:'Continuation source text.'}))
 ];
 const block = (id: string, order: number, lines: typeof linesA): SourceBlock => ({
  id, order, pageIndex:0, type:'paragraph', fontSize:10, column:0,
  sourceText:lines.map(l => l.text).join(' '),
  boundingBox:{x:60,y:lines[0]!.top,width:140,height:lines.at(-1)!.top+10-lines[0]!.top},
  lineRectsPdf:lines.map(l => [l.left,pageHeight-l.top-l.height,l.left+l.width,pageHeight-l.top])
 });
 const a = block('prior-fragment', 0, linesA), b = block('continuation-fragment', 1, linesB);
 for (const scale of [.75,1,1.5]) for (const aFails of [true,false]) {
  const source=document.createElement('canvas');source.width=pageWidth*scale*2;source.height=pageHeight*scale*2;
  const ctx=source.getContext('2d')!;ctx.scale(scale*2,scale*2);
  ctx.fillStyle='white';ctx.fillRect(0,0,pageWidth,pageHeight);
  ctx.fillStyle='black';ctx.font='10px Arial';ctx.textBaseline='top';
  for (const line of [...linesA,...linesB]) ctx.fillText(line.text,line.left,line.top,line.width);
  const translatedA=aFails ? '这段过长译文故意无法放入空间，必须完整回退原文。'.repeat(300) : '独立前段译文。';
  const translatedB='完整后续译文，保留所有内容。';
  const built=buildStrictPage(document,{pageIndex:0,blocks:[a,b],translations:new Map([[a.id,translatedA],[b.id,translatedB]]),
   render:{canvas:source,viewportWidth:pageWidth*scale,viewportHeight:pageHeight*scale,scale,toViewport:(x,y)=>[x*scale,(pageHeight-y)*scale]}})!;
  document.body.append(built.element);const page=built.element as any;
  const pending=page.pmSettleStrict(true);
  if (pending.some((p:{id:string}) => p.id===b.id)) throw Error('Short continuation failed to fit at '+scale);
  if (aFails && !pending.some((p:{id:string}) => p.id===a.id)) throw Error('Overlong source fixture did not exercise fallback');
  page.pmRevert(pending.map((p:{id:string}) => p.id));
  const nodeA=built.element.querySelector(`[data-pm-block="${a.id}"]`) as HTMLElement;
  const nodeB=built.element.querySelector(`[data-pm-block="${b.id}"]`) as HTMLElement;
  const mask=built.element.querySelector('.pm-repage-mask') as HTMLCanvasElement;
  const base=built.element.querySelector('.pm-repage-canvas') as HTMLCanvasElement;
  const sample=(canvas:HTMLCanvasElement,region:PixelBox):Uint8ClampedArray => {
   const ratio=canvas.width/(pageWidth*scale);
   return canvas.getContext('2d')!.getImageData(Math.floor(region.left*scale*ratio),Math.floor(region.top*scale*ratio),
    Math.floor(region.width*scale*ratio),Math.floor(region.height*scale*ratio)).data;
  };
  const sourceVisible=():void => {
   for (const line of linesA) {
    const alpha=sample(mask,line);
    if (alpha.some((v,i) => i%4===3 && v!==0)) throw Error('A fallback source line was masked at '+scale);
    const pixels=sample(base,line);
    if (!pixels.some((v,i) => i%4!==3 && v<100)) throw Error('A fallback source bitmap lost its ink');
   }
  };
  const continuationSafe=():void => {
   const probe=probeStrictPlacement(built.element,false)!.find(p => p.id===b.id)!;
   if (probe.state!=='committed' || nodeB.style.visibility==='hidden' || nodeB.textContent!==translatedB) throw Error('Continuation was hidden or truncated');
   // Inspect all actual DOM text fragments, rather than accepting a zero audit
   // count (that audit deliberately tolerates pre-existing source-box overlap).
   const origin=built.element.getBoundingClientRect();
   const pieces=[...nodeB.querySelectorAll('.pm-flow-piece')] as HTMLElement[];
   if (pieces.length!==1 || pieces[0]!.textContent!==translatedB) throw Error('The single surviving safe flow band was discarded');
   const clip=pieces[0]!.getBoundingClientRect();
   if (clip.top-origin.top < 116*scale-.1 || getComputedStyle(pieces[0]!).overflow!=='hidden') throw Error('Continuation text escaped its lower safe band at '+scale);
   const walker=document.createTreeWalker(pieces[0]!,NodeFilter.SHOW_TEXT);
   let textNode:Node|null, glyphs=0;
   while ((textNode=walker.nextNode())) {
    const range=document.createRange();range.selectNodeContents(textNode);
    for (const r of range.getClientRects()) {
     if (!r.width || !r.height) continue;
     glyphs++;
     // A font's CSS em box may extend above its visible ink. The piece's
     // overflow clip is the real upper bound on what can be painted.
     if (Math.max(r.top,clip.top)-origin.top < 116*scale-.1) throw Error('Visible continuation entered the preceding source line');
    }
   }
   if (!glyphs) throw Error('The committed continuation has no measured text');
   if (nodeA.textContent!==translatedA || !nodeA.title.startsWith(a.sourceText+'\n\n')) throw Error('Source or retained full translation was changed');
  };
  continuationSafe();
  if (aFails) sourceVisible();
  // A successful neighbour may later be reverted; B's source reservation and
  // placement must remain safe instead of relying on A also being translated.
  page.pmRevert([a.id]);sourceVisible();continuationSafe();
  page.pmPeek([b.id],true);
  if (nodeB.style.visibility!=='hidden') throw Error('Peek failed to reveal the continuation source');
  sourceVisible();
  page.pmPeek([b.id],false);sourceVisible();continuationSafe();
  if (page.pmGeometryAudit().violations) throw Error('Shared-source fixture introduced new overlap');
  built.element.remove();
 }
 // Empty safe bands must remain empty through the title-specific last-resort
 // annex path; moving the parent while retaining old flow coordinates would
 // otherwise evade the original source reservation.
 for (const scale of [.75,1,1.5]) {
  const source=document.createElement('canvas');source.width=pageWidth*scale*2;source.height=pageHeight*scale*2;
  const ctx=source.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,source.width,source.height);
  const title:SourceBlock={id:'fully-blocked-title',order:0,pageIndex:0,type:'title',sourceText:'A blocked heading',fontSize:18,
   boundingBox:{x:40,y:60,width:140,height:20},lineRectsPdf:[[40,220,180,240]]};
  const keep:SourceBlock={id:'preserved-neighbour',order:1,pageIndex:0,type:'paragraph',sourceText:'This source region must remain visible.',fontSize:10,
   translationMode:'preserve',preserveReason:'structure-ambiguous',boundingBox:{x:40,y:60,width:140,height:20},lineRectsPdf:[[40,220,180,240]]};
  const built=buildStrictPage(document,{pageIndex:0,blocks:[title,keep],translations:new Map([[title.id,'受阻标题']]),
   render:{canvas:source,viewportWidth:pageWidth*scale,viewportHeight:pageHeight*scale,scale,toViewport:(x,y)=>[x*scale,(pageHeight-y)*scale]}})!;
  document.body.append(built.element);const page=built.element as any;
  const pending=page.pmSettleStrict(true);
  if (!pending.some((p:{id:string}) => p.id===title.id)) throw Error('Fully blocked title was not rejected');
  page.pmRevert(pending.map((p:{id:string}) => p.id));
  const node=built.element.querySelector(`[data-pm-block="${title.id}"]`) as HTMLElement;
  const probe=probeStrictPlacement(built.element,false)!.find(p => p.id===title.id)!;
  if (node.style.visibility!=='hidden' || node.hasAttribute('data-pm-annex') || probe.state!=='abandoned') throw Error('Fully blocked title escaped through annex placement');
  const mask=built.element.querySelector('.pm-repage-mask') as HTMLCanvasElement;
  const pixels=mask.getContext('2d')!.getImageData(0,0,mask.width,mask.height).data;
  if (pixels.some((v,i) => i%4===3 && v!==0)) throw Error('Rejected blocked title painted a mask');
  built.element.remove();
 }
 // Paragraph ownership must not reserve the empty right-hand side of a short
 // independent label as if it were another full-width explanatory line.
 for (const scale of [.75,1,1.5]) {
  const source=document.createElement('canvas');source.width=pageWidth*scale*2;source.height=pageHeight*scale*2;
  const ctx=source.getContext('2d')!;ctx.scale(scale*2,scale*2);ctx.fillStyle='white';ctx.fillRect(0,0,pageWidth,pageHeight);
  const explanation=[40,52,64].map(top => ({left:40,top,width:195,height:8}));
  const label={left:46,top:80,width:16,height:8};
  const pdf=(line:PixelBox):[number,number,number,number] => [line.left,pageHeight-line.top-line.height,line.left+line.width,pageHeight-line.top];
  const kept:SourceBlock={id:'explanation-with-independent-label',order:0,pageIndex:0,type:'paragraph',fontSize:8,
   sourceText:'Detailed source explanation continues across three lines.\n\nCOR',translationMode:'preserve',preserveReason:'structure-ambiguous',
   boundingBox:{x:40,y:40,width:195,height:48},lineRectsPdf:[...explanation.map(pdf),pdf(label)],
   regionParagraphs:[{lineRectsPdf:explanation.map(pdf),fontSize:8},{lineRectsPdf:[pdf(label)],fontSize:8}]};
  const heading:SourceBlock={id:'heading-beside-independent-label',order:1,pageIndex:0,type:'heading',fontSize:8,
   sourceText:'Recommendations',boundingBox:{x:110,y:80,width:63,height:8},lineRectsPdf:[[110,212,173,220]]};
  ctx.fillStyle='black';ctx.font='8px Arial';ctx.textBaseline='top';
  for(const line of explanation)ctx.fillText('Detailed source explanation.',line.left,line.top,line.width);
  ctx.fillText('COR',label.left,label.top,label.width);ctx.fillText(heading.sourceText,110,80,63);
  const built=buildStrictPage(document,{pageIndex:0,blocks:[kept,heading],translations:new Map([[heading.id,'建议']]),
   render:{canvas:source,viewportWidth:pageWidth*scale,viewportHeight:pageHeight*scale,scale,toViewport:(x,y)=>[x*scale,(pageHeight-y)*scale]}})!;
  document.body.append(built.element);const page=built.element as any;
  const pending=page.pmSettleStrict(true);page.pmRevert(pending.map((p:{id:string})=>p.id));
  const node=built.element.querySelector(`[data-pm-block="${heading.id}"]`) as HTMLElement;
  const probe=probeStrictPlacement(built.element,false)!.find(p=>p.id===heading.id)!;
  if(probe.state!=='committed' || node.style.visibility==='hidden' || node.textContent!=='建议')throw Error('Independent label reserved another heading\'s empty source area at '+scale);
  const origin=built.element.getBoundingClientRect(),placed=node.getBoundingClientRect();
  if(placed.left-origin.left<110*scale-.1 || placed.right-origin.left>173*scale+.1)throw Error('Translated heading moved into its preserved left label');
  const mask=built.element.querySelector('.pm-repage-mask') as HTMLCanvasElement;
  const ratio=mask.width/pageWidth;
  for(const line of [...explanation,label]) {
   const pixels=mask.getContext('2d')!.getImageData(Math.floor(line.left*ratio),Math.floor(line.top*ratio),Math.floor(line.width*ratio),Math.floor(line.height*ratio)).data;
   if(pixels.some((v,i)=>i%4===3&&v!==0))throw Error('Independent explanatory paragraph or label was masked');
  }
  if(page.pmGeometryAudit().violations)throw Error('Independent-label placement overlaps');
  built.element.remove();
 }
}
