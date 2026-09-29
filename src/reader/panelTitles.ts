import type {SpanItem} from './spanBlockBuilder';
import type {SourceBlock} from '../types/models';
type Rect=[number,number,number,number];
/** A separate numbered badge and an indented, same-size title form two paint
 * regions. Keep their backgrounds and line wrapping independent. */
export function extractPanelTitles(items:SpanItem[],pageIndex:number,height:number):{blocks:SourceBlock[];rest:SpanItem[]} {
 const used=new Set<SpanItem>(),blocks:SourceBlock[]=[];
 const union=(parts:SpanItem[]):Rect=>[Math.min(...parts.map(i=>i.rect[0])),Math.min(...parts.map(i=>i.rect[1])),Math.max(...parts.map(i=>i.rect[2])),Math.max(...parts.map(i=>i.rect[3]))];
 for(const label of items.filter(i=>/^(?:Table|Figure)\s+\d+$/.test(i.text.trim()))) {
  const em=label.fontSize||8;
  const first=items.filter(i=>i!==label&&!used.has(i)&&i.text.trim().length>15&&i.rect[0]>=label.rect[2]+em*.8&&i.rect[0]-label.rect[2]<em*3
   &&Math.abs(i.rect[3]-label.rect[3])<=em*.65&&Math.abs((i.fontSize||em)-em)<em*.1).sort((a,b)=>b.rect[3]-a.rect[3]||a.rect[0]-b.rect[0])[0];
  if(!first)continue;
  if(/^Table/.test(label.text)&&Math.abs(first.rect[3]-label.rect[3])<em*.3) {
   // Same-baseline badges require a numeric table beneath them. Plain inline
   // captions use the established path (including descriptive guideline tables).
   const numbers=items.filter(i=>i.rect[3]<label.rect[1] && label.rect[1]-i.rect[3]<em*12
    && i.rect[0]>label.rect[0] && i.rect[2]<label.rect[0]+em*32
    && /^[-−+±\d\s.%()–]+$/.test(i.text.trim()) && /\d/.test(i.text));
   if(numbers.length<8)continue;
  }
  const title=items.filter(i=>!used.has(i)&&i.rect[0]>=first.rect[0]-.2&&i.rect[3]<=first.rect[3]+.1&&first.rect[3]-i.rect[3]<em*1.5
   &&Math.abs((i.fontSize||em)-em)<em*.1&&i.rect[0]<first.rect[0]+em*24);
  if(!title.includes(first))continue;
  title.sort((a,b)=>Math.abs(a.rect[3]-b.rect[3])<em*.3?a.rect[0]-b.rect[0]:b.rect[3]-a.rect[3]);
  const all=union([label,...title]),id=`page-${pageIndex}-panel-title-${blocks.length}`;
  for(const [part,parts] of [[0,[label]],[1,title]] as [number,SpanItem[]][]) {
   const rect=union(parts);parts.forEach(i=>used.add(i));
   blocks.push({id:`${id}-${part}`,pageIndex,order:blocks.length,type:part===0&&/^Table/.test(label.text)?'table':'caption',
    sourceText:parts.map(i=>i.text.trim()).join(' '),fontSize:em,lineRectsPdf:parts.map(i=>i.rect),
    boundingBox:{x:rect[0],y:height-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},
    sourceRegion:{id,kind:'caption',boundsPdf:all,evidence:'label-aligned-lines'}});
  }
 }
 return {blocks,rest:items.filter(i=>!used.has(i))};
}
