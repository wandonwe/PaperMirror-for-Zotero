import {TranslationPane} from '../../src/ui/translationPane';

/** Real DOM / iframe regression for the release's floating analysis surface. */
export function checkExplanationSurface():void {
 const host=document.createElement('div');
 host.className='pm-bilingual-pane';
 host.style.cssText='position:relative;width:800px;height:600px';
 host.setAttribute('data-pm-theme','dark');
 const overlay=document.createElement('div');
 overlay.className='pm-bilingual-pane pm-explanation-overlay-host';
 overlay.style.cssText='position:relative;width:800px;height:600px';
 const frame=document.createElement('iframe');
 // about:blank is same-origin and creates a separate, real event document.
 frame.src='about:blank';
 document.body.append(host,overlay,frame);
 const pdf=frame.contentDocument;
 if(!pdf)throw Error('Analysis regression: PDF iframe document unavailable');
 let dismissed=0,copied=0,saved=0;
 let request=new AbortController();
 const pane=Object.assign(Object.create(TranslationPane.prototype),{
  doc:document,host,explanationHost:host,explanationDismissDocuments:[],disposeExplanationOutside:null,
  strings:{explainTitle:'深度解析',explainSubtitle:'原文解析',close:'关闭',explainCopy:'复制',explainSave:'保存笔记'},
  callbacks:{
   onDismissExplanation:()=>{dismissed++;request.abort();},
   onCopyExplanation:()=>{copied++;},
   onSaveExplanationNote:()=>{saved++;}
  }
 });
 const check=(ok:unknown,message:string):void=>{if(!ok)throw Error('Analysis regression: '+message);};
 const card=():HTMLElement|null=>(host.querySelector('.pm-explain-card')??overlay.querySelector('.pm-explain-card')) as HTMLElement|null;
 const pointer=(target:Element):void=>{target.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));};
 const escape=(doc:Document):void=>{doc.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));};
 const show=():void=>pane.showExplanation({passage:'A complete source paragraph.',sections:[{label:'整体翻译',text:'整段原文的解析结果。'}]});
 try {
  pane.setExplanationDismissDocument(pdf);
  show();
  const first=card();
  check(first,'showExplanation creates a floating card');
  check(first!.querySelector('.pm-explain-passage')?.textContent==='A complete source paragraph.','passage stays complete');
  const actions=first!.querySelectorAll<HTMLButtonElement>('.pm-explain-actions button');
  pointer(actions[0]!);actions[0]!.click();
  pointer(actions[1]!);actions[1]!.click();
  pointer(first!.querySelector('.pm-explain-section')!);
  check(card()===first && dismissed===0 && copied===1 && saved===1,'internal text/copy/save clicks must not dismiss');

  // Moving the same DOM card preserves content, theme, and dismiss handlers.
  pane.setExplanationHost(overlay);
  check(overlay.contains(first) && !host.contains(first),'mode switch moves only the existing card');
  check(overlay.getAttribute('data-pm-theme')==='dark','overlay inherits the reader theme');
  frame.contentWindow?.focus();
  escape(pdf);
  check(!card() && dismissed===1 && request.signal.aborted,'Escape in the focused PDF iframe dismisses and cancels');
  escape(document);escape(pdf);
  check(dismissed===1,'closed card releases main and iframe keyboard listeners');

  request=new AbortController();show();
  pointer(pdf.body);
  check(!card() && dismissed===2 && request.signal.aborted,'outside pointerdown in the PDF iframe dismisses');

  request=new AbortController();show();
  pointer(host);
  check(!card() && dismissed===3 && request.signal.aborted,'outside pointerdown in the main document dismisses');

  request=new AbortController();show();
  card()!.querySelector<HTMLButtonElement>('.pm-card-close')!.click();
  check(!card() && dismissed===4 && request.signal.aborted,'the close button shares cancellation behavior');

  show();
  pane.hideExplanation();
  escape(pdf);pointer(pdf.body);
  check(!card() && dismissed===4,'programmatic cleanup removes handlers without dismissing a newer selection');
 } finally {
  pane.hideExplanation();
  host.remove();overlay.remove();frame.remove();
 }
}
