import {TranslationPane} from '../../src/ui/translationPane';
export function checkToolbar():void {
 const strings=new Proxy({syncScroll:'同步滚动',viewArticle:'完整文章流',viewPage:'整页对照',explainSelection:'解析',terms:'术语',close:'关闭',settings:'设置',more:'更多'} as any,{get:(o,k)=>o[k]??String(k)});
 for(const width of [900,744,640,520,390]) {
  const host=document.createElement('div');host.className='pm-bilingual-pane';host.style.cssText=`width:${width}px;height:300px;position:relative`;document.body.append(host);
  const pane=new TranslationPane(host,'test',strings,new Proxy({} as any,{get:()=>()=>{}}));
  pane.setLanguageCodes('en','zh-CN');pane.setLanguagePair('English','简体中文');
  pane.setProviderInfo('DeepSeek 深度求索 Very Long Engine Name','deepseek');
  const bar=host.querySelector('.pm-bar') as HTMLElement;
  const outer=bar.getBoundingClientRect();
  for(const button of bar.querySelectorAll('button')) {
   const rect=button.getBoundingClientRect();
   if(rect.width && (rect.right>outer.right+1 || rect.left<outer.left-1)) throw Error(`Toolbar clips button at ${width}: ${button.title} ${rect.right-outer.right} ${JSON.stringify([...bar.children].map(c=>({cl:c.className,w:c.getBoundingClientRect().width})))}`);
  }
  if(width<=860 && getComputedStyle(host.querySelector('.pm-provider-name')!).display!=='none')throw Error('Provider label uses window width instead of pane width');
  pane.destroy();host.remove();
 }
}
