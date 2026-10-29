import {TranslationPane} from '../../src/ui/translationPane';

/** The analysis surface stays inside the reader; only its body scrolls. */
export function checkControlAlignment():void {
 const check=(ok:unknown,message:string):void=>{if(!ok)throw Error('Control alignment: '+message);};
 for(const width of [390,520,900])for(const height of [200,600])for(const theme of ['light','dark'])for(const english of [false,true]) {
  const host=document.createElement('div');host.className='pm-bilingual-pane';
  host.style.cssText=`position:relative;width:${width}px;height:${height}px`;
  host.setAttribute('data-pm-theme',theme);document.body.append(host);
  const strings=english
   ? {explainTitle:'Deep explanation',explainSubtitle:'Based on your selected sentence',close:'Close',explainCopy:'Copy explanation',explainSave:'Save explanation'}
   : {explainTitle:'深度解析',explainSubtitle:'基于你选中的句子',close:'关闭',explainCopy:'复制解析',explainSave:'保存解析'};
  const pane=Object.assign(Object.create(TranslationPane.prototype),{
   doc:document,host,explanationHost:host,explanationDismissDocuments:[],disposeExplanationOutside:null,
   strings,callbacks:{onCopyExplanation:()=>{},onSaveExplanationNote:()=>{},onDismissExplanation:()=>{}}
  });
  try {
   pane.showExplanation({loading:true});
   const card=host.querySelector<HTMLElement>('.pm-explain-card')!;
   const actions=card.querySelector<HTMLElement>('.pm-explain-actions')!;
   const close=card.querySelector<HTMLButtonElement>('.pm-card-close')!;
   check(actions.hidden && actions.getBoundingClientRect().height===0,'loading state reveals actions');
   pane.showExplanation({error:'Service unavailable'});
   check(actions.hidden && actions.getBoundingClientRect().height===0,'error state reveals actions');
   pane.showExplanation({passage:'A source paragraph with a very long title that must truncate without moving the close button.'.repeat(4),
    sections:Array.from({length:8},(_,i)=>({label:`${i+1}. ${strings.explainTitle}`,text:'完整解析内容，不裁切文字。Detailed explanation remains readable. '.repeat(15)}))});
   const rect=card.getBoundingClientRect(),parent=host.getBoundingClientRect();
   const head=card.querySelector<HTMLElement>('.pm-card-head')!,grid=card.querySelector<HTMLElement>('.pm-explain-grid')!;
   check(!actions.hidden && actions.getBoundingClientRect().height>=30,'completed state hides actions');
   check(rect.height<=Math.min(Math.max(parent.height*.55,180),parent.height-24)+.1,'card includes padding outside maximum height');
   check(rect.left>=parent.left && rect.right<=parent.right && rect.bottom<=parent.bottom,'card crosses reader boundary');
   check(grid.scrollHeight>grid.clientHeight,'long explanation does not have a body scroll surface');
   grid.scrollTop=grid.scrollHeight;
   check(card.scrollTop===0,'reading the body scrolls header out of view');
   check(close.getAttribute('aria-label')===strings.close,'close button lacks a readable name');
   const cr=close.getBoundingClientRect(),hr=head.getBoundingClientRect();
   check(cr.width===28 && cr.height===28 && cr.top>=rect.top && cr.bottom<=rect.bottom,'close button is not aligned inside card');
   check(Math.abs(cr.top+cr.height/2-(hr.top+hr.height/2))<.1,'card header controls have different center lines');
   check(grid.getBoundingClientRect().bottom<=actions.getBoundingClientRect().top+.1,'body overlaps fixed actions');
   for(const button of actions.querySelectorAll('button')) {
    const r=button.getBoundingClientRect();
    check(r.left>=rect.left && r.right<=rect.right && r.bottom<=rect.bottom,'footer button crosses card boundary');
   }
  } finally {pane.hideExplanation();host.remove();}
 }
}
