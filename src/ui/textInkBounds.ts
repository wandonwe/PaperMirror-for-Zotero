/** Scroll height includes font whitespace; clipping must instead protect glyph ink. */
export interface VerticalBounds { top: number; bottom: number }
export interface InkMetrics {
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

/**
 * Where clip-relative upright coordinates sit on the device pixel grid:
 * absolute = origin + sign * relative, in CSS px; `ratio` is devicePixelRatio.
 */
export interface DeviceAxis { origin: number; sign: 1 | -1; ratio: number }

const toAbs = (v: number, axis: DeviceAxis): number => axis.origin + axis.sign * v;
const toRel = (v: number, axis: DeviceAxis): number => axis.sign * (v - axis.origin);
const validRatio = (r: number): number => (r > 0 && Number.isFinite(r) ? r : 1);

/**
 * Glyph ink as it is rasterised (4.8), not only its outline. Measured in Zotero
 * (Gecko 140, macOS, DPR 2): the text baseline is rounded to a whole device
 * pixel, and every device row the outline enters receives anti-aliased ink.
 * The exact outline alone let 47 of 343 committed blocks lose their bottom
 * pixel row behind overflow:hidden. Returns undefined when metrics cannot be
 * trusted; callers then keep the conservative DOM bounds.
 */
export function rasterInkBounds(rect: VerticalBounds, metrics: InkMetrics | undefined, axis: DeviceAxis): VerticalBounds | undefined {
 const outline = inkVerticalBounds(rect, metrics);
 if (!metrics || outline === rect) return undefined;
 const ratio = validRatio(axis.ratio), eps = 1e-3;
 const baseline = toAbs(rect.bottom - metrics.fontBoundingBoxDescent, axis);
 const snapped = Math.floor(baseline * ratio + 0.5) / ratio;
 const shift = toRel(snapped, axis) - toRel(baseline, axis);
 const a = toAbs(outline.top + shift, axis), b = toAbs(outline.bottom + shift, axis);
 const lo = Math.floor(Math.min(a, b) * ratio + eps) / ratio, hi = Math.ceil(Math.max(a, b) * ratio - eps) / ratio;
 const r1 = toRel(lo, axis), r2 = toRel(hi, axis);
 return { top: Math.min(r1, r2), bottom: Math.max(r1, r2) };
}

/** overflow:hidden clips on whole device pixels: round both clip edges to the grid (pure). */
export function rasterClipBounds(clip: VerticalBounds, axis: DeviceAxis): VerticalBounds {
 const ratio = validRatio(axis.ratio);
 const a = Math.round(toAbs(clip.top, axis) * ratio) / ratio, b = Math.round(toAbs(clip.bottom, axis) * ratio) / ratio;
 const r1 = toRel(a, axis), r2 = toRel(b, axis);
 return { top: Math.min(r1, r2), bottom: Math.max(r1, r2) };
}

/** Device axis for a node turned by a whole-page quarter rotation (pure). */
export function deviceAxisFor(clip: VerticalBounds & {left:number;right:number}, rotation: number, ratio: number): DeviceAxis {
 return rotation === 90 ? { origin: clip.right, sign: -1, ratio }
  : rotation === 180 ? { origin: clip.bottom, sign: -1, ratio }
   : rotation === 270 ? { origin: clip.left, sign: 1, ratio }
    : { origin: clip.top, sign: 1, ratio };
}

export function verticalInkFits(ink: VerticalBounds, box: VerticalBounds): boolean {
 return ink.top >= box.top - 0.01 && ink.bottom <= box.bottom + 0.01;
}

/** Undo a whole-page quarter turn before applying horizontal-font metrics. */
export function uprightVerticalBounds(
 rect: VerticalBounds & {left:number;right:number},
 clip: VerticalBounds & {left:number;right:number},
 rotation:number
):VerticalBounds {
 return rotation===90 ? {top:clip.right-rect.right,bottom:clip.right-rect.left}
  : rotation===180 ? {top:clip.bottom-rect.bottom,bottom:clip.bottom-rect.top}
   : rotation===270 ? {top:rect.left-clip.left,bottom:rect.right-clip.left}
    : {top:rect.top-clip.top,bottom:rect.bottom-clip.top};
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
  const clientClip = node.getBoundingClientRect();
  const rotation=Number(node.closest?.('[data-pm-page-turn]')?.getAttribute('data-pm-page-turn') ?? 0);
  const clip=uprightVerticalBounds(clientClip,clientClip,rotation);
  const upright=(rect:DOMRect):VerticalBounds=>uprightVerticalBounds(rect,clientClip,rotation);
  const axis=deviceAxisFor(clientClip,rotation,doc.defaultView?.devicePixelRatio || 1);
  const rasterClip=rasterClipBounds(clip,axis);
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
    if (rects.every(rect => rect.width <= 0 || verticalInkFits(upright(rect), clip))) return true;
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
     const box = upright(rect);
     // Both contracts must hold: the 4.7 outline check (unchanged in every
     // engine) and the device-raster check that Gecko actually paints.
     const ink = inkVerticalBounds(box,metrics);
     const raster = rasterInkBounds(box,metrics,axis);
     const outlineFits = verticalInkFits(ink,clip), rasterFits = !raster || verticalInkFits(raster,rasterClip);
     if (outlineFits && rasterFits) return true;
     const top = Math.max(clip.top-ink.top, raster ? rasterClip.top-raster.top : 0);
     const bottom = Math.max(ink.bottom-clip.bottom, raster ? raster.bottom-rasterClip.bottom : 0);
     failures.set(node,{offset:offsets[start]!,topOverflow:Math.max(0,top),bottomOverflow:Math.max(0,bottom),
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
