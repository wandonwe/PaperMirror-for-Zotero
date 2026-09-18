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

/** Per-render canvas; read current font metrics so late font loads cannot leave stale bounds. */
export function createTextInkGuard(doc: Document): (node: HTMLElement) => boolean {
 const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement;
 const ctx = canvas.getContext('2d');
 return (node: HTMLElement): boolean => {
  const clip = node.getBoundingClientRect();
  const walker = doc.createTreeWalker(node, 4 /* SHOW_TEXT */);
  const range = doc.createRange();
  let text: Node | null;
  while ((text = walker.nextNode())) {
   if (!text.textContent?.trim()) continue;
   const style = doc.defaultView?.getComputedStyle(text.parentElement!);
   let metrics: InkMetrics | undefined;
   if (ctx && style) {
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
     ctx.font = font;
     ctx.textBaseline = 'alphabetic';
     const measured = ctx.measureText(text.textContent.replace(/\s+/g, ' '));
     metrics = {
      fontBoundingBoxAscent: measured.fontBoundingBoxAscent,
      fontBoundingBoxDescent: measured.fontBoundingBoxDescent,
      actualBoundingBoxAscent: measured.actualBoundingBoxAscent,
      actualBoundingBoxDescent: measured.actualBoundingBoxDescent
     };
   }
   range.selectNodeContents(text);
   // Each wrapped line has its own rectangle. Bold/italic runs keep their own metrics.
   for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0 && !verticalInkFits(inkVerticalBounds(rect, metrics), clip)) return false;
   }
  }
  return true;
 };
}
