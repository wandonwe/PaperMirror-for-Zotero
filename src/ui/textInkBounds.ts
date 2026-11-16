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

/** Canvas reference size for font boxes; whole-pixel rounding is then <0.4%. */
export const FONT_BOX_REFERENCE_PX = 256;

/**
 * The font box layout actually used (4.9), or undefined when it cannot be
 * proven. Measured in Zotero (Gecko 140): layout rounds the ascent and the
 * descent UP to whole device pixels separately, while canvas reports each
 * rounded up to whole CSS pixels. At 12.2px that is 14+5=19 on canvas against
 * a 17.5px line box, more than the 1px consistency tolerance, so every block
 * at such a size fell back to the DOM box and failed on its first line.
 * `ascent`/`descent` are the unrounded values (reference size, scaled); the
 * result is accepted only when it reproduces the laid-out height exactly.
 */
export function deviceFontBox(ascent: number, descent: number, rectHeight: number, ratio: number): { ascent: number; descent: number } | undefined {
 if (![ascent, descent, rectHeight, ratio].every(Number.isFinite) || ascent <= 0 || descent < 0 || rectHeight <= 0 || ratio <= 0) return undefined;
 const eps = 1e-3;
 // Only a layout that itself sits on the device grid can be matched this way.
 if (Math.abs(rectHeight * ratio - Math.round(rectHeight * ratio)) > 0.02) return undefined;
 const a = Math.ceil(ascent * ratio - eps) / ratio, d = Math.ceil(descent * ratio - eps) / ratio;
 return Math.abs(a + d - rectHeight) <= 0.02 ? { ascent: a, descent: d } : undefined;
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
/**
 * Two measured vertical misses the model above does not cover (Zotero 10.0.9,
 * Gecko 140, macOS, DPR 2), kept as optional parameters and NOT enabled:
 *
 *  - `bleed`: a superscript whose outline top lay 0.03 device px inside a row
 *    still painted the row above at 27% intensity (Bongartz 2015 p6, phases
 *    0.25 and 0.375).
 *  - `tie`: a one-line title whose clip edge lay 0.04 device px from a half
 *    pixel lost its bottom row at phase 0.375 only (Bae 2010 p22).
 *
 * With bleed 0.0625 and tie 0.05 both readings disappear on device and the
 * sampled pages lose no block, but the Chromium gates, whose canvas metrics
 * put ink exactly on pixel boundaries, drop from 409 to 196 committed blocks.
 * Enabling them needs a way to tell the two engines apart first.
 */
export const INK_BLEED_DEVICE_PX = 0.0625;
export const RASTER_TIE_DEVICE_PX = 0.05;
/** What the guard actually applies. Zero in production; the browser gate sets it to measure the effect in Firefox. */
export const rasterGuardTuning = { bleed: 0, tie: 0 };
const snaps = (value: number, tie: number): number[] => {
 const base = Math.floor(value + 0.5), frac = value + 0.5 - base;
 return tie > 0 && frac < tie ? [base, base - 1] : tie > 0 && frac > 1 - tie ? [base, base + 1] : [base];
};

export function rasterInkBounds(rect: VerticalBounds, metrics: InkMetrics | undefined, axis: DeviceAxis, bleed = 0, tie = 0): VerticalBounds | undefined {
 const outline = inkVerticalBounds(rect, metrics);
 if (!metrics || outline === rect) return undefined;
 const ratio = validRatio(axis.ratio), eps = 1e-3;
 // Canvas font boxes are whole pixels while layout may use half pixels (in
 // Zotero a 15px heading measured 16+6 on canvas and 21.5 in layout). The
 // difference may sit above or below the baseline, so keep both readings.
 let top = Infinity, bottom = -Infinity;
 for (const baselineRel of [rect.bottom - metrics.fontBoundingBoxDescent, rect.top + metrics.fontBoundingBoxAscent]) {
  const baseline = toAbs(baselineRel, axis);
  for (const device of snaps(baseline * ratio, tie)) {
   const rel = toRel(device / ratio, axis);
   const a = toAbs(rel - metrics.actualBoundingBoxAscent, axis), b = toAbs(rel + metrics.actualBoundingBoxDescent, axis);
   const lo = Math.floor(Math.min(a, b) * ratio - bleed + eps) / ratio, hi = Math.ceil(Math.max(a, b) * ratio + bleed - eps) / ratio;
   const r1 = toRel(lo, axis), r2 = toRel(hi, axis);
   top = Math.min(top, r1, r2); bottom = Math.max(bottom, r1, r2);
  }
 }
 return { top, bottom };
}

/** Sub-pixel phases a scrolled pane can place the page at, in device pixels. */
const RASTER_PHASES = [0, .125, .25, .375, .5, .625, .75, .875];

/**
 * Worst raster overflow over every sub-pixel phase (pure). Scrolling moves the
 * page across the device grid continuously, so where the baseline and the clip
 * edge round to changes with the scroll position; a placement must hold at all
 * of them. Returns undefined when metrics cannot be trusted, else the largest
 * top and bottom overflow in CSS px (0 = fits at every phase).
 */
export function rasterOverflowAllPhases(rect: VerticalBounds, metrics: InkMetrics | undefined, clip: VerticalBounds, axis: DeviceAxis, bleed = 0, tie = 0): VerticalBounds | undefined {
 const ratio = validRatio(axis.ratio);
 let top = 0, bottom = 0;
 for (const phase of RASTER_PHASES) {
  const shifted = { ...axis, origin: axis.origin + phase / ratio };
  const ink = rasterInkBounds(rect, metrics, shifted, bleed, tie);
  if (!ink) return undefined;
  const limit = rasterClipBounds(clip, shifted, tie);
  top = Math.max(top, limit.top - ink.top); bottom = Math.max(bottom, ink.bottom - limit.bottom);
 }
 return { top: Math.max(0, top), bottom: Math.max(0, bottom) };
}

/** overflow:hidden clips on whole device pixels: round both clip edges to the grid (pure). */
export function rasterClipBounds(clip: VerticalBounds, axis: DeviceAxis, tie = 0): VerticalBounds {
 const ratio = validRatio(axis.ratio);
 // Near a rounding tie keep the tighter edge on each side.
 let top = -Infinity, bottom = Infinity;
 for (const a of snaps(toAbs(clip.top, axis) * ratio, tie)) for (const b of snaps(toAbs(clip.bottom, axis) * ratio, tie)) {
  const r1 = toRel(a / ratio, axis), r2 = toRel(b / ratio, axis);
  top = Math.max(top, Math.min(r1, r2)); bottom = Math.min(bottom, Math.max(r1, r2));
 }
 return { top, bottom };
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

/** Painted intensity (0-255) from which a pixel counts as ink. The on-device
 * audit counts a pixel as lost at a quarter of the text contrast. */
export const SIDE_INK_ALPHA = 64;
/** Device pixels of side overflow that stay invisible (4.10): less than half
 * of the first painted column. */
export const SIDE_OVERHANG_TOLERANCE_DEVICE_PX = 0.5;

/**
 * Glyphs designed inside their em box: CJK ideographs, kana, hangul and their
 * full-width punctuation never hang over the side of their advance box. Canvas
 * outline bounds cannot decide this (in Zotero they report 0.3-0.7px on BOTH
 * sides of such glyphs), so only the others are rasterised (4.10, pure).
 */
export function mayOverhangSide(glyph: string): boolean {
 const c = glyph.codePointAt(0) ?? 0;
 return !((c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xF900 && c <= 0xFAFF)
  || (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFFEF) || (c >= 0x20000 && c <= 0x3FFFF));
}

/**
 * Columns of painted ink outside a glyph's advance box (4.10, pure): `alpha`
 * is a width x height alpha map with the origin at column `origin` and the
 * advance ending at column `end`. Returns whole device columns on each side.
 */
export function paintedSideOverhang(alpha: ArrayLike<number>, width: number, height: number, origin: number, end: number, threshold = SIDE_INK_ALPHA): { left: number; right: number } {
 let first = width, last = -1;
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  if (alpha[y * width + x]! >= threshold) { if (x < first) first = x; if (x > last) last = x; }
 }
 return last < 0 ? { left: 0, right: 0 } : { left: Math.max(0, origin - first), right: Math.max(0, last + 1 - end) };
}

/**
 * Ink a glyph paints outside the clip's side edges (4.10, pure). `inkLeft`
 * and `inkRight` are the outline edges in CSS px; the clip is rounded to the
 * device grid as overflow:hidden does. Returns the overflow on each side in
 * CSS px, zero when it stays within the invisible tolerance. No sub-pixel
 * phases: a page scrolls vertically, and its horizontal position only changes
 * with a relayout, which runs this check again.
 */
export function horizontalInkOverflow(inkLeft: number, inkRight: number, clipLeft: number, clipRight: number, ratio: number): { left: number; right: number } {
 const r = validRatio(ratio);
 const left = Math.round(clipLeft * r) - inkLeft * r, right = inkRight * r - Math.round(clipRight * r);
 return { left: left > SIDE_OVERHANG_TOLERANCE_DEVICE_PX ? left / r : 0, right: right > SIDE_OVERHANG_TOLERANCE_DEVICE_PX ? right / r : 0 };
}

export interface InkFailure {
 /** Side overflow in CSS px (4.10); vertical overflow is zero for a purely horizontal failure. */
 leftOverflow?: number; rightOverflow?: number;
 /** Diagnostics for a side failure: the glyph, its own overhang and where its advance box sits in the clip. */
 side?: { glyph: string; ownLeft: number; ownRight: number; boxLeft: number; boxRight: number; clipWidth: number };
 offset: number; topOverflow: number; bottomOverflow: number;
 rectTop: number; rectBottom: number; clipHeight: number;
 font: string; metricsAvailable: boolean;
}
/** A bounded side inset moves a line-start or line-end glyph's overhang inside
 * the original clip. Never enlarge the box; roll back unless the complete text
 * still fits and every check passes with the narrower line. */
export function insetSideInk(node: HTMLElement, guard: TextInkGuard, maxInset: number, sizeFits: () => boolean): boolean {
 const failure = guard.failure(node);
 const left = failure?.leftOverflow ?? 0, right = failure?.rightOverflow ?? 0;
 if (!failure || failure.topOverflow > 0 || failure.bottomOverflow > 0 || (left <= 0 && right <= 0) || left > maxInset || right > maxInset) return false;
 const saved = [node.style.paddingLeft, node.style.paddingRight, node.style.boxSizing];
 node.style.boxSizing = 'border-box';
 if (left > 0) node.style.paddingLeft = `${Math.ceil((left + 0.02) * 100) / 100}px`;
 if (right > 0) node.style.paddingRight = `${Math.ceil((right + 0.02) * 100) / 100}px`;
 if (sizeFits() && guard(node)) return true;
 [node.style.paddingLeft, node.style.paddingRight, node.style.boxSizing] = saved as [string, string, string];
 return false;
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
 const overhangs = new Map<string, { left: number; right: number }>();
 // Paint the glyph and read where its ink really is. Any failure (no canvas,
 // a test double, a tainted read) leaves the glyph unchecked, as before 4.10.
 let sideCanvas: HTMLCanvasElement | undefined, sideCtx: CanvasRenderingContext2D | null | undefined;
 const paintedOverhang = (glyph: string, font: string, ratio: number): { left: number; right: number } => {
  try {
   sideCanvas ??= doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement;
   sideCtx ??= sideCanvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
   if (!sideCtx || typeof sideCtx.fillText !== 'function' || typeof sideCtx.getImageData !== 'function') return { left: 0, right: 0 };
   sideCtx.font = font;
   const size = parseFloat(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '0');
   const advance = sideCtx.measureText(glyph).width;
   if (!(size > 0) || !Number.isFinite(advance)) return { left: 0, right: 0 };
   const pad = Math.ceil(size * ratio), width = Math.ceil(advance * ratio) + pad * 2, height = Math.ceil(size * ratio * 3);
   sideCanvas.width = width; sideCanvas.height = height;
   sideCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
   sideCtx.font = font; sideCtx.textBaseline = 'alphabetic'; sideCtx.fillStyle = '#000';
   sideCtx.fillText(glyph, pad / ratio, (size * 2 * ratio) / ratio);
   const data = sideCtx.getImageData(0, 0, width, height).data, alpha = new Uint8Array(width * height);
   for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]!;
   const cols = paintedSideOverhang(alpha, width, height, pad, pad + Math.round(advance * ratio));
   return { left: cols.left / ratio, right: cols.right / ratio };
  } catch { return { left: 0, right: 0 }; }
 };
 const guard = (node: HTMLElement): boolean => {
  failures.delete(node);
  const clientClip = node.getBoundingClientRect();
  const rotation=Number(node.closest?.('[data-pm-page-turn]')?.getAttribute('data-pm-page-turn') ?? 0);
  const clip=uprightVerticalBounds(clientClip,clientClip,rotation);
  const upright=(rect:DOMRect):VerticalBounds=>uprightVerticalBounds(rect,clientClip,rotation);
  const axis=deviceAxisFor(clientClip,rotation,doc.defaultView?.devicePixelRatio || 1);
  const walker = doc.createTreeWalker(node, 4 /* SHOW_TEXT */);
  const range = doc.createRange();
  const worst: { left: number; right: number; at?: { offset: number; rectTop: number; rectBottom: number; font: string; side: NonNullable<InkFailure['side']> } } = { left: 0, right: 0 };
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
    let measured: InkMetrics | undefined;
    let reference: { ascent: number; descent: number } | undefined;
    if (ctx && style) {
     const m = ctx.measureText(glyph);
     measured = {fontBoundingBoxAscent:m.fontBoundingBoxAscent,fontBoundingBoxDescent:m.fontBoundingBoxDescent,
      actualBoundingBoxAscent:m.actualBoundingBoxAscent,actualBoundingBoxDescent:m.actualBoundingBoxDescent};
     const fontPx = parseFloat(style.fontSize);
     if (Number.isFinite(fontPx) && fontPx > 0) {
      const realFont = ctx.font;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${FONT_BOX_REFERENCE_PX}px ${style.fontFamily}`;
      const r = ctx.measureText(glyph), k = fontPx / FONT_BOX_REFERENCE_PX;
      reference = { ascent: r.fontBoundingBoxAscent * k, descent: r.fontBoundingBoxDescent * k };
      ctx.font = realFont;
     }
    }
    return rects.every(rect => {
     if (rect.width <= 0) return true;
     const box = upright(rect);
     // A canvas font box consistent with layout keeps the 4.8 check untouched.
     // Only when it is not (and 4.8 fell back to the DOM box) is the font box
     // layout provably used substituted. Substituting it everywhere passed six
     // more blocks on device but gave one unconfirmed 1 px reading; not taken.
     const consistent = !!measured && Math.abs(measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent - (box.bottom - box.top)) <= 1;
     const exact = measured && reference && !consistent ? deviceFontBox(reference.ascent, reference.descent, box.bottom - box.top, axis.ratio) : undefined;
     const metrics = measured && exact ? {...measured, fontBoundingBoxAscent: exact.ascent, fontBoundingBoxDescent: exact.descent} : measured;
     // Both contracts must hold: the 4.7 outline check (unchanged in every
     // engine) and the device-raster check that Gecko actually paints.
     const ink = inkVerticalBounds(box,metrics);
     const raster = rasterOverflowAllPhases(box,metrics,clip,axis,rasterGuardTuning.bleed,rasterGuardTuning.tie);
     const outlineFits = verticalInkFits(ink,clip);
     const rasterFits = !raster || (raster.top <= 0.01 && raster.bottom <= 0.01);
     if (outlineFits && rasterFits) return true;
     const top = Math.max(clip.top-ink.top, raster ? raster.top : 0);
     const bottom = Math.max(ink.bottom-clip.bottom, raster ? raster.bottom : 0);
     failures.set(node,{offset:offsets[start]!,topOverflow:Math.max(0,top),bottomOverflow:Math.max(0,bottom),
      rectTop:ink.top-clip.top,rectBottom:ink.bottom-clip.top,clipHeight:clip.bottom-clip.top,font:ctx?.font ?? '',
      metricsAvailable:!!metrics && Object.values(metrics).every(Number.isFinite)});
     return false;
    });
   };
   if (!fitsRange(0,glyphs.length)) return false;
   // Side overhang (4.10). Only glyphs painted outside their advance box can
   // be cut by the side edges, and CJK glyphs never are, so translated text
   // costs one cached rasterisation per distinct Latin or symbol character.
   // Whole-page rotations keep the previous behaviour: their side edges are
   // the vertical edges checked above.
   if (ctx && style && rotation === 0) {
    const ratio = doc.defaultView?.devicePixelRatio || 1;
    for (let i = 0; i < glyphs.length; i++) {
     const glyph = glyphs[i]!;
     if (!glyph.trim()) continue;
     if (!mayOverhangSide(glyph)) continue;
     const key = ratio + '\u0000' + ctx.font + '\u0000' + glyph;
     let side = overhangs.get(key);
     if (!side) { side = paintedOverhang(glyph, ctx.font, ratio); overhangs.set(key, side); }
     if (!side.left && !side.right) continue;
     range.setStart(text, offsets[i]!); range.setEnd(text, offsets[i+1]!);
     for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0) continue;
      const over = horizontalInkOverflow(rect.left - side.left, rect.right + side.right, clientClip.left, clientClip.right, ratio);
      if (over.left <= worst.left && over.right <= worst.right) continue;
      if (!worst.left && !worst.right) worst.at = {offset:offsets[i]!,rectTop:rect.top-clientClip.top,rectBottom:rect.bottom-clientClip.top,font:ctx.font,
       side:{glyph,ownLeft:side.left,ownRight:side.right,boxLeft:rect.left-clientClip.left,boxRight:rect.right-clientClip.left,clipWidth:clientClip.right-clientClip.left}};
      worst.left = Math.max(worst.left, over.left); worst.right = Math.max(worst.right, over.right);
     }
    }
   }
  }
  if (worst.at) {
   // Report the largest overhang on each side so one inset can cure them all.
   failures.set(node,{...worst.at,topOverflow:0,bottomOverflow:0,leftOverflow:worst.left,rightOverflow:worst.right,
    clipHeight:clientClip.bottom-clientClip.top,metricsAvailable:true});
   return false;
  }
  return true;
 };
 return Object.assign(guard, {failure:(node:HTMLElement)=>failures.get(node)});
}
