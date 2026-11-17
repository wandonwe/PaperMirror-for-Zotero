// Browser gate: every tests/browser check, each reported separately so one failure does not hide the rest.
import {checkFooterContinuation} from '../footerContinuation';
import {checkTitledAbbreviations} from '../titledAbbreviations';
import {checkWatermarkBackground} from '../watermarkBackground';
import {checkLegacyEncodedPanels,checkArchivedBlanksteinFailures} from '../legacyEncodedPanels';
import {checkSourceMaskExpansion} from '../sourceMaskExpansion';
import {checkBottomParagraphExpansion} from '../bottomParagraphExpansion';
import {checkSplitParagraphExpansion} from '../splitParagraphExpansion';
import {checkSharedSourceLine} from '../sharedSourceLine';
import {checkFigureCaptionMask} from '../figureCaptionMask';
import {checkEscPanels} from '../escPanels';
import {checkTwoColumnTable} from '../twoColumnTable';
import {checkDescriptiveTable} from '../descriptiveTable';
import {checkLeeTypography} from '../leeTypography';
import {checkDisplayFormula} from '../displayFormula';
import {checkToolbar} from '../toolbar';
import { checkRealTranslations } from '../realTranslations';
import { checkRecommendationTables } from '../recommendationTables';
import { checkAbbreviationTable } from '../abbreviationTable';
import flowFixtures from '../../fixtures/regression/cadrads2022-flow-overlap.json';
import { checkImageCaption } from '../imageCaption';
import { checkScroll } from '../scrollSync';
import { buildStrictPage } from '../../../src/ui/strictPageReplacement';
const result=document.createElement('pre');result.id='result';document.body.append(result);
const R:any[]=[];(window as any).R=R;
async function run() {
try{
 try{ checkSharedSourceLine(); R.push({n:'checkSharedSourceLine',ok:true}); }catch(e){R.push({n:'checkSharedSourceLine',ok:false,e:String(e).slice(0,600)});}
 try{ checkFigureCaptionMask(); R.push({n:'checkFigureCaptionMask',ok:true}); }catch(e){R.push({n:'checkFigureCaptionMask',ok:false,e:String(e).slice(0,600)});}
 try{ checkSplitParagraphExpansion(); R.push({n:'checkSplitParagraphExpansion',ok:true}); }catch(e){R.push({n:'checkSplitParagraphExpansion',ok:false,e:String(e).slice(0,600)});}
 try{ checkBottomParagraphExpansion(); R.push({n:'checkBottomParagraphExpansion',ok:true}); }catch(e){R.push({n:'checkBottomParagraphExpansion',ok:false,e:String(e).slice(0,600)});}
 try{ await checkSourceMaskExpansion(); R.push({n:'checkSourceMaskExpansion',ok:true}); }catch(e){R.push({n:'checkSourceMaskExpansion',ok:false,e:String(e).slice(0,600)});}
 try{ await checkLegacyEncodedPanels(); R.push({n:'checkLegacyEncodedPanels',ok:true}); }catch(e){R.push({n:'checkLegacyEncodedPanels',ok:false,e:String(e).slice(0,600)});}
 try{ await checkArchivedBlanksteinFailures(); R.push({n:'checkArchivedBlanksteinFailures',ok:true}); }catch(e){R.push({n:'checkArchivedBlanksteinFailures',ok:false,e:String(e).slice(0,600)});}
 try{ await checkFooterContinuation(); R.push({n:'checkFooterContinuation',ok:true}); }catch(e){R.push({n:'checkFooterContinuation',ok:false,e:String(e).slice(0,600)});}
 try{ await checkTitledAbbreviations(); R.push({n:'checkTitledAbbreviations',ok:true}); }catch(e){R.push({n:'checkTitledAbbreviations',ok:false,e:String(e).slice(0,600)});}
 try{ await checkWatermarkBackground(); R.push({n:'checkWatermarkBackground',ok:true}); }catch(e){R.push({n:'checkWatermarkBackground',ok:false,e:String(e).slice(0,600)});}
 try{ await checkEscPanels((window as any).escPanelImage); R.push({n:'checkEscPanels',ok:true}); }catch(e){R.push({n:'checkEscPanels',ok:false,e:String(e).slice(0,600)});}
 try{ checkDescriptiveTable(); R.push({n:'checkDescriptiveTable',ok:true}); }catch(e){R.push({n:'checkDescriptiveTable',ok:false,e:String(e).slice(0,600)});}
 try{ checkTwoColumnTable(); R.push({n:'checkTwoColumnTable',ok:true}); }catch(e){R.push({n:'checkTwoColumnTable',ok:false,e:String(e).slice(0,600)});}
 try{ checkLeeTypography(); R.push({n:'checkLeeTypography',ok:true}); }catch(e){R.push({n:'checkLeeTypography',ok:false,e:String(e).slice(0,600)});}
 try{ checkDisplayFormula(); R.push({n:'checkDisplayFormula',ok:true}); }catch(e){R.push({n:'checkDisplayFormula',ok:false,e:String(e).slice(0,600)});}
 try{ checkToolbar(); R.push({n:'checkToolbar',ok:true}); }catch(e){R.push({n:'checkToolbar',ok:false,e:String(e).slice(0,600)});}
 try{ await checkImageCaption(); R.push({n:'checkImageCaption',ok:true}); }catch(e){R.push({n:'checkImageCaption',ok:false,e:String(e).slice(0,600)});}
 try{ checkScroll(); R.push({n:'checkScroll',ok:true}); }catch(e){R.push({n:'checkScroll',ok:false,e:String(e).slice(0,600)});}
 try{ checkAbbreviationTable(); R.push({n:'checkAbbreviationTable',ok:true}); }catch(e){R.push({n:'checkAbbreviationTable',ok:false,e:String(e).slice(0,600)});}
 try{ checkRecommendationTables(); R.push({n:'checkRecommendationTables',ok:true}); }catch(e){R.push({n:'checkRecommendationTables',ok:false,e:String(e).slice(0,600)});}
 try{ await checkRealTranslations(); R.push({n:'checkRealTranslations',ok:true}); }catch(e){R.push({n:'checkRealTranslations',ok:false,e:String(e).slice(0,600)});}
 try{
 for(const fixture of flowFixtures) {
  const canvas=document.createElement('canvas');canvas.width=594;canvas.height=783;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,594,783);
  const text='列表正文完整翻译，不得重复叠加。'.repeat(4);
  const rendered=buildStrictPage(document,{pageIndex:0,blocks:[{id:fixture.id,pageIndex:0,order:0,type:'paragraph',sourceText:'A complete paragraph followed by list markers and their descriptions.',fontSize:fixture.fontPx,lineRectsPdf:fixture.lines.map(l=>[l.left,783-l.top-l.height,l.left+l.width,783-l.top])}],translations:new Map([[fixture.id,text]]),render:{canvas,viewportWidth:594,viewportHeight:783,scale:1,toViewport:(x,y)=>[x,783-y]}})!;
  document.body.append(rendered.element);
  const page=rendered.element as any;
  const pending=page.pmSettleStrict(true);
  const still=page.pmShrinkFit(pending.map((b:any)=>b.id));
  const node=rendered.element.querySelector('[data-pm-block]') as HTMLElement;
  const audit=page.pmGeometryAudit();
  if(still.length || node.textContent!==text || node.style.visibility==='hidden' || audit.violations || audit.adjusted) throw Error('CAD-RADS list flow failed: '+fixture.id+JSON.stringify(audit));
 }

 const canvas=document.createElement('canvas');canvas.width=300;canvas.height=300;
 const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,300,300);ctx.fillStyle='red';ctx.fillRect(0,0,100,100);
 const lines:[number,number,number,number][]=[];
 for(let top=0;top<200;top+=12) lines.push([top<100?100:0,300-top-10,200,300-top]);
 const text='完整译文测试不得遗漏'.repeat(22);
 const markup='⟦b⟧'+text.slice(0,20)+'⟦/b⟧'+text.slice(20);
 const rendered=buildStrictPage(document,{pageIndex:0,blocks:[{id:'wrap',pageIndex:0,order:0,type:'paragraph',sourceText:'A complete source paragraph wraps around the image and continues below it.',lineRectsPdf:lines,fontSize:10}],translations:new Map([['wrap',markup]]),imageRectsPdf:[[0,200,100,300]],render:{canvas,viewportWidth:300,viewportHeight:300,scale:1,toViewport:(x,y)=>[x,300-y]}})!;
 document.body.append(rendered.element);
 const page=rendered.element as any;
 const unfit=page.pmSettleStrict(true);
 const node=rendered.element.querySelector('[data-pm-block="wrap"]')!;
 const pieces=[...node.querySelectorAll('.pm-flow-piece')];
 const same=node.textContent===text;
 const styled=node.querySelectorAll('b').length>0;
 const noOverlap=pieces.every(p=>{const b=(p as HTMLElement);const x=parseFloat(b.style.left),y=parseFloat(b.style.top);return x>=100 || y>=100;});
 const audit=page.pmGeometryAudit();
 const output={unfit,pieces:pieces.length,same,styled,noOverlap,audit,visible:(node as HTMLElement).style.visibility};
 result.textContent=JSON.stringify(output);
 if(unfit.length||pieces.length<2||!same||!styled||!noOverlap||audit.violations) throw Error('Flow rendering failed');
 // A retry must reflow atomically and keep the full text even on failure.
 const long='长段落'.repeat(2000);
 const overflow=buildStrictPage(document,{pageIndex:0,blocks:[{id:'overflow',pageIndex:0,order:0,type:'paragraph',sourceText:'A long source paragraph around an image.',lineRectsPdf:lines,fontSize:10}],translations:new Map([['overflow',long]]),imageRectsPdf:[[0,200,100,300]],render:{canvas,viewportWidth:300,viewportHeight:300,scale:1,toViewport:(x,y)=>[x,300-y]}})!;
 document.body.append(overflow.element);
 const unplaced=(overflow.element as any).pmSettleStrict(true);
 const hidden=overflow.element.querySelector('[data-pm-block="overflow"]') as HTMLElement;
 if(unplaced.length!==1 || hidden.textContent!==long || hidden.style.visibility!=='hidden') throw Error('Overflow lost text or committed partially');
 const noUpdates=page.pmApplyCompressed(new Map());
 if(noUpdates.length || node.textContent!==text) throw Error('Committed flow changed');
 for (const scale of [0.75, 1, 1.5]) {
  const cell=buildStrictPage(document,{pageIndex:0,blocks:[{id:'page-0-table-0-r1-c0',pageIndex:0,order:0,type:'paragraph',sourceText:'Age (y)',fontSize:9,tableRow:1,tableCol:0,tableGeometry:'inferred',boundingBox:{x:54.5,y:100,width:25.1,height:9},lineRectsPdf:[[54.5,191,79.6,200]],tableContentRectPdf:[54.5,190,148,200]}],translations:new Map([['page-0-table-0-r1-c0','年龄（岁）']]),render:{canvas,viewportWidth:300*scale,viewportHeight:300*scale,scale,toViewport:(x,y)=>[x*scale,(300-y)*scale]}})!;
  document.body.append(cell.element);
  const initial=(cell.element as any).pmSettleStrict(true);
  const still=(cell.element as any).pmShrinkFit(initial.map((b:any)=>b.id));
  if(still.length) throw Error('Inferred age cell failed at zoom '+scale);
 }
 R.push({n:'inlineTail',ok:true});}catch(e){R.push({n:'inlineTail',ok:false,e:String(e).slice(0,600)});}
 result.textContent=JSON.stringify(R);result.setAttribute('data-pass','true');
} catch(e) {result.textContent=JSON.stringify(R)+' ERROR '+String(e);result.setAttribute('data-pass','false');}

}
void run();
