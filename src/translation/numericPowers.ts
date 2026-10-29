import {stripStyleMarkers} from '../reader/styleRuns';
/** Raised numeric powers with an explicit Unicode source signal. Never infer
 * powers from plain digit concatenations or word-following citation markers. */
const POWER = String.raw`(?<![A-Za-z_\d.])(?:[-+−]\s*)?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+`;
const pattern = () => new RegExp(POWER,'g');
export function protectNumericPowers(text:string,mask:(literal:string)=>string):string {
 return text.replace(pattern(),mask);
}
export function isNumericPowerLiteral(text:string):boolean {
 const match=pattern().exec(text);return !!match && match.index===0 && match[0].length===text.length;
}
export function numericPowerIssue(source:string,translated:string):'numeric-power'|null {
 source=stripStyleMarkers(source);translated=stripStyleMarkers(translated);
 const before=source.match(pattern())??[];
 if(!before.length)return null;
 const after=translated.match(pattern())??[];
 // Exact Unicode powers are source content, unlike translated prose. Repeated
 // entries retain their multiplicity; reordered clauses remain acceptable.
 return JSON.stringify(before.sort())===JSON.stringify(after.sort())?null:'numeric-power';
}
