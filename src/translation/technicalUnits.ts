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
function equal(a:Map<string,number>,b:Map<string,number>):boolean {
 return a.size===b.size && [...a].every(([key,count])=>b.get(key)===count);
}
/** Validate restored/plain output, including cached translations. Never guess
 * a repair when a source contains both energy and voltage units. */
export function technicalUnitIssue(source:string,translated:string):'technical-unit'|'technical-unit-value'|null {
 source=stripStyleMarkers(source);translated=stripStyleMarkers(translated);
 const original=inventory(source);
 if(!original.size)return null;
 if(!equal(original,inventory(translated)))return 'technical-unit';
 const values=measuredValues(source);
 // Only unit-qualified numeric values are compared; ordinary translated
 // numbers, words and hyphens are outside this unit-integrity contract.
 if(values.size && !equal(values,measuredValues(translated)))return 'technical-unit-value';
 return null;
}
