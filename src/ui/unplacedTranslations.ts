import { parseStyledSegments } from '../reader/styleRuns';
export interface UnplacedTranslation { source: string; translation: string; reason: string }
export function unplacedReason(reason: string): string {
 if (/image/.test(reason)) return '图片遮挡：原位置无法安全放置';
 if (/table/.test(reason)) return '表格边界或结构限制';
 if (/geometry|audit/.test(reason)) return '与其他页面元素冲突';
 if (/both/.test(reason)) return '可用宽度和高度不足';
 if (/width|horizontal/.test(reason)) return '可用宽度不足';
 if (/height|vertical/.test(reason)) return '可用高度不足';
 if (/shrink|compress|overflow|fit/.test(reason)) return '可用空间不足';
 return '原位置无法安全放置';
}
/** Separate reader UI: never inserted into the printable PDF page. */
export function showUnplacedTranslations(doc: Document, rows: UnplacedTranslation[], page: number): boolean {
 if (!rows.length) return false;
 doc.getElementById('pm-unplaced-translations')?.remove();
 const el = (tag: string): HTMLElement => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
 const panel=el('section'); panel.id='pm-unplaced-translations';panel.setAttribute('role','dialog');panel.setAttribute('aria-label',`第 ${page} 页未放置译文`);
 panel.style.cssText='position:fixed;z-index:2147483647;inset:10% 10% auto auto;width:min(640px,80vw);max-height:75vh;overflow:auto;padding:20px;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:10px;box-shadow:0 8px 40px #0006;';
 const focus=doc.activeElement as HTMLElement|null;
 const close=el('button');close.textContent='关闭';close.style.cssText='float:right;position:sticky;top:0';
 const dismiss=():void=>{panel.remove();focus?.focus();};close.addEventListener('click',dismiss);panel.append(close);
 panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();dismiss();}});
 const title=el('h2');title.textContent=`第 ${page} 页 · 完整译文`;panel.append(title);
 for (const row of rows) {
  const item=el('section'),why=el('p'),text=el('p'),source=el('details'),label=el('summary'),original=el('p');
  why.textContent=unplacedReason(row.reason);why.style.cssText='font-size:12px;opacity:.75';
  for(const part of parseStyledSegments(row.translation)){const span=el(part.style??'span');span.textContent=part.text;text.append(span);}
  text.style.cssText='white-space:pre-wrap;line-height:1.7;overflow-wrap:anywhere';
  label.textContent='查看对应原文';original.textContent=row.source;original.style.cssText=text.style.cssText;
  source.append(label,original);item.append(why,text,source);item.style.cssText='padding:12px 0;border-top:1px solid GrayText';panel.append(item);
 }
 (doc.body??doc.documentElement).append(panel);close.focus();return true;
}
