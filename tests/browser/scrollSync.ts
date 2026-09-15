import { TranslationPane } from '../../src/ui/translationPane';
import { CachedPageIndex } from '../../src/ui/pageOffsetIndex';
import { getPageScrollFraction, setPageScrollFraction, getPageGap } from '../../src/reader/zoteroReaderAdapter';
import { SyncGuard, onScrollIntent, createSyncController } from '../../src/reader/scrollSynchronizer';

export function checkScroll(): void {
 const assert=(ok:unknown,message:string):void=>{if(!ok) throw Error(message);};
 const host=document.createElement('div');host.style.cssText='position:relative;padding-top:37px';document.body.append(host);
 const create=(border:number)=>{
  const scroll=document.createElement('div');scroll.style.cssText=`height:200px;width:350px;overflow:auto;border:${border}px solid black;scroll-behavior:smooth`;
  const stack=document.createElement('div');stack.style.position='relative';scroll.append(stack);host.append(scroll);
  const slots=Array.from({length:20},(_,i)=>{const el=document.createElement('div');el.style.cssText=`height:${i%2?900:600}px;width:300px;margin-bottom:8px`;stack.append(el);return el;});
  return {scroll,slots};
 };
 const pdf=create(3), paneDOM=create(0);
 const reader:any={_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfViewer:{container:pdf.scroll,getPageView:(n:number)=>({div:pdf.slots[n]})}}}}}};
 const pane:any=Object.create(TranslationPane.prototype);
 Object.assign(pane,{viewKind:'page',scroll:paneDOM.scroll,slots:paneDOM.slots,pageIndex:new CachedPageIndex(),currentPage:0,suppressScrollUntil:0,scheduleEnsure:()=>{}});
 const guard=new SyncGuard();let transmitted=0;
 const sync=createSyncController({scrollPaneToPage:()=>{},navigatePdfToPage:()=>{},
  scrollPaneToPosition:(page,fraction)=>pane.setPdfScrollFraction(page,fraction),
  scrollPdfToPosition:(page,fraction)=>{assert(setPageScrollFraction(reader,page,fraction),'PDF target failed');transmitted++;}
 },guard);
 pane.callbacks={onScrollPosition:(page:number,fraction:number)=>sync.onPanePositionChanged(page,fraction)};
 const dispose=onScrollIntent(paneDOM.scroll,()=>{pane.suppressScrollUntil=0;guard.takeControl('pane');});
 const pdfDispose=onScrollIntent(pdf.scroll,()=>guard.takeControl('pdf'));
 for(const page of [0,1,7,18]) for(const fraction of [0.12,0.61]) {
  pane.setPdfScrollFraction(page,fraction);
  pane.handleScroll();assert(transmitted===0,'programmatic pane scroll echoed');
  paneDOM.scroll.dispatchEvent(new WheelEvent('wheel'));
  pane.handleScroll();
  const actual=getPageScrollFraction(reader,page)!;
  assert(Math.abs(actual-fraction)*pdf.slots[page]!.clientHeight<1.1,`reverse scroll drift ${page}: ${actual}`);
  assert(!guard.shouldPropagate('pdf'),'reverse movement was not guarded');
  pdf.scroll.dispatchEvent(new WheelEvent('wheel'));
  assert(guard.shouldPropagate('pdf'),'PDF input did not take over');
  sync.onPdfPositionChanged(page,getPageScrollFraction(reader,page)!);
  const anchor=pane.readingAnchor();assert(anchor.pageIndex===page && Math.abs(anchor.fraction-fraction)<0.002,'round-trip drift');
  transmitted=0;
 }
 assert(getPageGap(reader,0)===8,'gap measurement');
 // Geometry changes keep a page anchor, without whole-document percentages.
 pdf.slots.forEach(el=>el.style.height=`${el.clientHeight*1.25}px`);
 paneDOM.slots.forEach(el=>el.style.height=`${el.clientHeight*1.25}px`);
 pane.pageIndex.invalidate();pane.setPdfScrollFraction(12,0.4);
 paneDOM.scroll.dispatchEvent(new WheelEvent('wheel'));pane.handleScroll();
 assert(Math.abs(getPageScrollFraction(reader,12)!-0.4)<0.002,'zoom drift');
 // Gap relayout preserves the same page/fraction, and width must not be capped.
 pane.pdfPageGap=8;const before=pane.readingAnchor();
 pane.setPdfPageGap(14);const after=pane.readingAnchor();
 assert(before.pageIndex===after.pageIndex && Math.abs(before.fraction-after.fraction)<0.002,'gap relayout drift');
 pane.docPageSizes=[{width:594,height:783}];pane.displayPxPerPoint=1.2;pane.host=host;
 assert(pane.slotWidthFor(0)===713,'pane independently shrank PDF scale');
 dispose();pdfDispose();host.remove();
}
