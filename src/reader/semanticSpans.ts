/**
 * Materialise positioned PDF runs without flattening raised numeric content.
 * Superscripts are source semantics: 1024² must not become the integer 10242.
 * Geometry records the raised position; this does not infer powers from words,
 * units, particular numbers, or a paper's title.
 */
export interface SemanticSpan {
 text: string;
 rect: readonly [number, number, number, number];
 fontSize?: number;
}
export interface SemanticJoinOptions {
 /** Main line size, used only for whitespace thresholds. */
 fontSize?: number;
 /** Horizontal gap in em above which ordinary runs need a space. */
 spaceThreshold?: number;
 /** Table extraction trims individual runs; normal PDF lines preserve them. */
 trimRuns?: boolean;
 /** Existing table gaps use the incoming run's size, prose uses line size. */
 gapFontSize?: 'line' | 'run';
 /** Normal lines join adjacent CJK glyphs; tables may preserve geometric gaps. */
 joinCJK?: boolean;
}
const SUPERSCRIPT: Record<string, string> = {
 '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹',
 '+':'⁺','-':'⁻','−':'⁻'
};
const size = (span: SemanticSpan): number => span.fontSize && span.fontSize > 0
 ? span.fontSize : Math.max(0, span.rect[3] - span.rect[1]);
const finite = (span: SemanticSpan): boolean => span.rect.every(Number.isFinite)
 && span.rect[2] > span.rect[0] && span.rect[3] > span.rect[1];
const numericPiece = (span: SemanticSpan): boolean => /^[0-9+−-]+$/.test(span.text.trim());
function lineSize(items: readonly SemanticSpan[]): number {
 const weights = new Map<number, number>();
 for (const span of items) {
  const font = Math.round(size(span) * 2) / 2;
  if (font > 0) weights.set(font, (weights.get(font) ?? 0) + span.text.trim().length);
 }
 return [...weights].sort((a,b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 10;
}

/** A short raised number may be split into several glyph runs by PDF.js. */
function numericClusters(items: readonly SemanticSpan[]): number[][] {
 const groups: number[][] = [];
 for (let index=0; index<items.length; index++) {
  const item=items[index]!;
  if (!finite(item) || !numericPiece(item)) continue;
  const last=groups.at(-1), previous=last ? items[last.at(-1)!]! : undefined;
  const font=size(item), previousFont=previous ? size(previous) : 0;
  if (last && last.at(-1) === index-1 && previous
   && Math.abs(font-previousFont) <= Math.max(font,previousFont)*.12
   && Math.abs(item.rect[1]-previous.rect[1]) <= Math.max(font,previousFont)*.2
   && item.rect[0]-previous.rect[2] <= Math.max(font,previousFont)*.35) last.push(index);
  else groups.push([index]);
 }
 return groups;
}

export function joinSemanticSpans(source: readonly SemanticSpan[], options: SemanticJoinOptions = {}): string {
 const items=source.slice().sort((a,b) => a.rect[0]-b.rect[0]);
 const raised=new Map<number,number>();
 for (const [groupId,indexes] of numericClusters(items).entries()) {
  const members=indexes.map(index=>items[index]!);
  const text=members.map(item=>item.text.trim()).join('');
  // Longer digit runs are not typical scripts and are left unchanged rather
  // than guessing how a badly segmented line should be interpreted.
  if (!/^[+−-]?\d{1,6}[+−-]?$/.test(text)) continue;
  const left=Math.min(...members.map(item=>item.rect[0])), right=Math.max(...members.map(item=>item.rect[2]));
  const bottom=Math.min(...members.map(item=>item.rect[1]));
  const font=Math.max(...members.map(size));
  const anchored=items.some((base,index) => {
   if (indexes.includes(index) || !finite(base) || !base.text.trim()) return false;
   const baseFont=size(base);
   if (!(font>0 && font <= baseFont*.86)) return false;
   const gap=Math.max(0,Math.max(left,base.rect[0])-Math.min(right,base.rect[2]));
   if (gap > baseFont*.65) return false;
   const rise=bottom-base.rect[1];
   // Raised scripts overlap the upper part of their own baseline. A smaller
   // normal-line digit or a number on the preceding line cannot qualify.
   return rise >= baseFont*.2 && rise <= baseFont*.85
    && bottom < base.rect[3]+baseFont*.3;
  });
  if (anchored) for (const index of indexes) raised.set(index,groupId);
 }
 const em=options.fontSize && options.fontSize>0 ? options.fontSize : lineSize(items);
 let out='';
 for (let index=0; index<items.length; index++) {
  const item=items[index]!, previous=items[index-1];
  const isRaised=raised.has(index);
  const raw=options.trimRuns ? item.text.trim() : item.text;
  const text=isRaised ? raw.replace(/[0-9+−-]/g,char=>SUPERSCRIPT[char]!) : raw;
  const sameScript=index>0 && isRaised && raised.get(index)===raised.get(index-1);
  const isCJKJoin=options.joinCJK!==false && /[一-鿿]$/.test(out) && /^[一-鿿]/.test(text);
  const gapFont=options.gapFontSize==='run' ? size(item) : em;
  if (previous && !sameScript && item.rect[0]-previous.rect[2] > gapFont*(options.spaceThreshold ?? .18)
   && !/\s$/.test(out) && !/^\s/.test(text) && !isCJKJoin) out+=' ';
  out+=text;
 }
 return out.replace(/\s+/g,' ').trim();
}
