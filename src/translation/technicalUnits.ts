import {stripStyleMarkers} from '../reader/styleRuns';
/** High-risk technical unit labels stay case-sensitive and verbatim.
 * This bounded vocabulary avoids treating ordinary short words as SI units.
 * Energy (keV) and tube voltage (kVp) are different physical quantities.
 */
const LABELS = ['keV','MeV','GeV','eV','kVp','kV','mV',
 'cGy','mGy','μGy','µGy','Gy','mSv','μSv','µSv','Sv'] as const;
const escaped = LABELS.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
// Length labels are admitted only with an explicit Unicode numeric power.
// Plain m/cm/mm/um words and flattened cm2 model identifiers stay outside it.
const LENGTH_POWER = String.raw`(?:mm|cm|[µμu]m|m)[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+`;
const pattern = () => new RegExp(String.raw`(?<![A-Za-z_µμ])(?:(?:mGy|Gy)(?:\s*[·⋅×*]\s*|\s+)cm|${LENGTH_POWER}|${escaped})(?![A-Za-z_µμ])`,'g');
const canonical = (label:string) => label.replace(/[\s·⋅×*]+/g,'·').replace(/µ/g,'μ');

export function protectTechnicalUnits(text:string, mask:(label:string)=>string):string {
 return text.replace(pattern(),mask);
}
export function isTechnicalUnitLiteral(text:string):boolean {
 const match=pattern().exec(text);return !!match && match.index===0 && match[0].length===text.length;
}
function inventory(text:string):Map<string,number> {
 const result=new Map<string,number>();
 for(const match of text.matchAll(pattern())) {
  const unit=canonical(match[0]);result.set(unit,(result.get(unit)??0)+1);
 }
 return result;
}
function numberIdentity(text:string):string {
 const complete=text.trim();
 // Parse only full supported mantissas. Other adjacent numeric runs keep
 // their literal identity; never bind a trailing group such as 000 to zero.
 const supported=/^[-+−]?\s*(?:(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][-+−]?\d+)?$/;
 if(!supported.test(complete))return `raw:${complete}`;
 const raw=complete.replace(/[\s,]/g,'').replace(/−/g,'-');
 const parts=raw.match(/^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/);
 if(!parts)return raw;
 let digits=((parts[2]??'')+(parts[3]??'')).replace(/^0+/,'');
 if(!digits)return '0';
 let exponent=BigInt(parts[4]??'0')-BigInt((parts[3]??'').length);
 while(digits.endsWith('0')) {digits=digits.slice(0,-1);exponent++;}
 return `${parts[1]==='-'?'-':''}${digits}e${exponent}`;
}
function measuredValues(text:string):Map<string,number> {
 const result=new Map<string,number>();
 for(const match of text.matchAll(pattern())) {
  const number= text.slice(0,match.index).match(/((?:[-+−]\s*)?(?:\d|\.\d)[\d.,eE+−\-\s]*)\s*$/)?.[1];
  if(!number)continue;
  const key=`${numberIdentity(number)}:${canonical(match[0])}`;
  result.set(key,(result.get(key)??0)+1);
 }
 return result;
}
/** Validate restored/plain output, including cached translations. Never guess
 * a repair when a source contains both energy and voltage units. */
export function technicalUnitIssue(source:string,translated:string):'technical-unit'|'technical-unit-value'|null {
 source=stripStyleMarkers(source);translated=stripStyleMarkers(translated);
 const original=inventory(source);
 if(!original.size)return null;
 // 5.0 (校验 2638/3285: 1938/1860 字的段落整段留英文): 比较的是「有哪些
 // 单位」而不是「出现几次」。"40, 50 and 60 keV" 译成 "40 keV、50 keV 和
 // 60 keV" 单位次数变了,意思没变。真正的风险 —— keV↔kVp 互换、单位丢失、
 // 凭空多出原文没有的单位 —— 都还会被拦下。
 // 次数可以变多(把共用的单位分配到每个数值上),也可以变少(没带数值的
 // "keV level" 被译成「能级」—— 校验 2638: 651/1860 字的段落因此整段留英文);
 // 但不许一种变多、另一种同时变少: "low-keV" 被换成 "低kVp" 照样拦下。带数值
 // 的单位由下面的数值核对逐个守住。
 const translatedUnits=inventory(translated);
 if([...translatedUnits.keys()].some(u=>!original.has(u)))return 'technical-unit';
 const more=[...original].some(([u,n])=>(translatedUnits.get(u)??0)>n);
 const fewer=[...original].some(([u,n])=>(translatedUnits.get(u)??0)<n);
 if(more && fewer)return 'technical-unit';
 const values=measuredValues(source);
 // A unit that carries a value in the source must survive as that unit.
 if([...values.keys()].some(k=>!translatedUnits.has(splitKey(k)[1])))return 'technical-unit';
 // Only unit-qualified numeric values are compared; ordinary translated
 // numbers, words and hyphens are outside this unit-integrity contract.
 // Every source value keeps its unit; a value the translation attaches a
 // unit to must exist in the source and must not belong to another unit there.
 if(values.size) {
  const out=measuredValues(translated);
  if(![...values.keys()].every(k=>out.has(k)))return 'technical-unit-value';
  const sourceNumbers=new Set((source.match(/\d+(?:[.,]\d+)*/g)??[]).map(n=>numberIdentity(n)));
  // Owners include every number of a list that shares one unit ("40, 50 and
  // 60 keV" → 40, 50, 60 all keV), so "40 kVp" in the translation is caught.
  const owner=new Map<string,string>();
  const own=(n:string,u:string)=>owner.set(n,owner.has(n)&&owner.get(n)!==u?'*':u);
  for(const k of values.keys()){const [n,u]=splitKey(k);own(n,u);}
  for(const match of source.matchAll(pattern())) {
   const run=source.slice(Math.max(0,(match.index??0)-80),match.index).match(/(\d[\d.]*(?:\s*(?:,|，|、|;|and|or|to|–|-)\s*\d[\d.]*)*)\s*$/)?.[1];
   if(run)for(const n of run.match(/\d+(?:\.\d+)?/g)??[])own(numberIdentity(n),canonical(match[0]));
  }
  for(const k of out.keys()) {
   if(values.has(k))continue;
   const [n,u]=splitKey(k);
   if(!sourceNumbers.has(n) || (owner.has(n) && owner.get(n)!==u))return 'technical-unit-value';
  }
 }
 return null;
}
function splitKey(k:string):[string,string] {
 const i=k.lastIndexOf(':');return [k.slice(0,i),k.slice(i+1)];
}

/**
 * Text-free detail for a technical-unit rejection (5.0 diagnostics): unit
 * labels with source→translation counts, and how many unit-qualified values
 * the translation lost or gained. No source or translated prose.
 */
export function technicalUnitDetail(source:string,translated:string):string {
 source=stripStyleMarkers(source);translated=stripStyleMarkers(translated);
 const a=inventory(source),b=inventory(translated);
 const units=[...new Set([...a.keys(),...b.keys()])].map(u=>`${u}:${a.get(u)??0}>${b.get(u)??0}`);
 const va=measuredValues(source),vb=measuredValues(translated);
 const lost=[...va.keys()].filter(k=>!vb.has(k)).length, gained=[...vb.keys()].filter(k=>!va.has(k)).length;
 return `${units.join(',')};v-${lost}+${gained}`;
}
