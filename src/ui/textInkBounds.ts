/** Scroll height includes font whitespace; clipping must instead protect glyph ink. */
export interface VerticalBounds { top: number; bottom: number }
interface InkMetrics {
 fontBoundingBoxAscent: number;
 fontBoundingBoxDescent: number;
 actualBoundingBoxAscent: number;
 actualBoundingBoxDescent: number;
}

export function inkVerticalBounds(rect: VerticalBounds, metrics?: InkMetrics): VerticalBounds {
 if (!metrics || !Object.values(metrics).every(Number.isFinite)) return rect;
 const fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
 // A fallback font or CSS transform may use different metrics. Do not guess its baseline.
 if (fontHeight <= 0 || Math.abs(fontHeight - (rect.bottom - rect.top)) > 1) return rect;
 const baseline = rect.bottom - metrics.fontBoundingBoxDescent;
 return { top: baseline - metrics.actualBoundingBoxAscent, bottom: baseline + metrics.actualBoundingBoxDescent };
}

export function verticalInkFits(ink: VerticalBounds, box: VerticalBounds): boolean {
 return ink.top >= box.top - 0.01 && ink.bottom <= box.bottom + 0.01;
}

export interface InkFailure {
 offset: number; topOverflow: number; bottomOverflow: number;
 rectTop: number; rectBottom: number; clipHeight: number;
 font: string; metricsAvailable: boolean;
}
export type TextInkGuard = ((node: HTMLElement) => boolean) & { failure(node: HTMLElement): InkFailure | undefined };

/** A bounded top inset keeps negative font leading inside the original clip.
 * Never enlarge the box, and roll back if the complete text no longer fits. */
export function insetTextInk(node: HTMLElement, guard: TextInkGuard, maxInset: number, sizeFits: () => boolean): boolean {
 const failure = guard.failure(node);
 if (!failure || failure.topOverflow <= 0 || failure.topOverflow > maxInset) return false;
 const padding = node.style.paddingTop, sizing = node.style.boxSizing;
 node.style.boxSizing = 'border-box';
 node.style.paddingTop = `${Math.ceil((failure.topOverflow + 0.02) * 100) / 100}px`;
 if (sizeFits() && guard(node)) return true;
 node.style.paddingTop = padding; node.style.boxSizing = sizing;
 return false;
}

/** Per-render canvas; read current font metrics so late font loads cannot leave stale bounds. */
export function createTextInkGuard(doc: Document): TextInkGuard {
 const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement;
 const ctx = canvas.getContext('2d');
 const failures = new WeakMap<HTMLElement, InkFailure>();
 const guard = (node: HTMLElement): boolean => {
  failures.delete(node);
  const clip = node.getBoundingClientRect();
  const walker = doc.createTreeWalker(node, 4 /* SHOW_TEXT */);
  const range = doc.createRange();
  let text: Node | null;
  while ((text = walker.nextNode())) {
   if (!text.textContent?.trim()) continue;
   const style = doc.defaultView?.getComputedStyle(text.parentElement!);
   if (ctx && style) {
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
   }
   const glyphs = Array.from(text.textContent ?? '');
   const offsets = [0];
   for (const glyph of glyphs) offsets.push(offsets[offsets.length-1]! + glyph.length);
   // Subdivide only ranges whose DOM bounds cross the clip. Interior lines
   // require no per-glyph layout reads; mixed fallback metrics stay local.
   const fitsRange = (start: number, end: number): boolean => {
    if (start === end) return true;
    range.setStart(text!, offsets[start]!); range.setEnd(text!, offsets[end]!);
    const rects = Array.from(range.getClientRects());
    if (rects.every(rect => rect.width <= 0 || verticalInkFits(rect, clip))) return true;
    if (end-start > 1) {
     const mid = Math.floor((start+end)/2);
     return fitsRange(start,mid) && fitsRange(mid,end);
    }
    const glyph = glyphs[start]!;
    if (!glyph.trim()) return true;
    let metrics: InkMetrics | undefined;
    if (ctx && style) {
     const m = ctx.measureText(glyph);
     metrics = {fontBoundingBoxAscent:m.fontBoundingBoxAscent,fontBoundingBoxDescent:m.fontBoundingBoxDescent,
      actualBoundingBoxAscent:m.actualBoundingBoxAscent,actualBoundingBoxDescent:m.actualBoundingBoxDescent};
    }
    return rects.every(rect => {
     if (rect.width <= 0) return true;
     const ink = inkVerticalBounds(rect,metrics);
     if (verticalInkFits(ink,clip)) return true;
     failures.set(node,{offset:offsets[start]!,topOverflow:Math.max(0,clip.top-ink.top),bottomOverflow:Math.max(0,ink.bottom-clip.bottom),
      rectTop:ink.top-clip.top,rectBottom:ink.bottom-clip.top,clipHeight:clip.bottom-clip.top,font:ctx?.font ?? '',
      metricsAvailable:!!metrics && Object.values(metrics).every(Number.isFinite)});
     return false;
    });
   };
   if (!fitsRange(0,glyphs.length)) return false;
  }
  return true;
 };
 return Object.assign(guard, {failure:(node:HTMLElement)=>failures.get(node)});
}
