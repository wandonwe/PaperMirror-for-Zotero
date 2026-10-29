/** Only simple, filled relation glyphs are recognized. Font names, apparent
 * Unicode and surrounding prose are not evidence of what a PDF actually draws. */
export interface GlyphPathCommand { command: string; args: number[] }
type Point = [number, number];
type Contour = { points: Point[]; curves: Point[][]; curved: boolean };
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

function contoursFrom(commands: readonly GlyphPathCommand[]): Contour[] | undefined {
 if (!commands.length || commands.length > 128) return undefined;
 const contours: Contour[] = [];
 let current: Contour | undefined;
 for (const {command, args} of commands) {
  if (!Array.isArray(args) || !args.every(Number.isFinite)) return undefined;
  if (command === 'moveTo' && args.length === 2 && !current) {
   current = {points: [[args[0]!, args[1]!]], curves: [], curved: false};
  } else if (command === 'lineTo' && args.length === 2 && current) {
   current.points.push([args[0]!, args[1]!]);
  } else if ((command === 'bezierCurveTo' || command === 'quadraticCurveTo') && current
    && args.length === (command === 'bezierCurveTo' ? 6 : 4)) {
   current.curved = true;
   const curve: Point[] = [current.points[current.points.length - 1]!];
   for (let i = 0; i < args.length; i += 2) curve.push([args[i]!, args[i + 1]!]);
   current.curves.push(curve);
   for (let i = 0; i < args.length; i += 2) current.points.push([args[i]!, args[i + 1]!]);
  } else if (command === 'closePath' && !args.length && current && current.points.length >= 4) {
   contours.push(current); current = undefined;
  } else return undefined;
 }
 return current ? undefined : contours;
}
function box(c: Contour): Box {
 const xs = c.points.map(p => p[0]), ys = c.points.map(p => p[1]);
 const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
 return {left, right, bottom, top, width: right - left, height: top - bottom};
}
function area(c: Contour): number {
 return Math.abs(c.points.reduce((sum, a, i) => {
  const b = c.points[(i + 1) % c.points.length]!;
  return sum + a[0] * b[1] - b[0] * a[1];
 }, 0)) / 2;
}
function bar(c: Contour, b: Box): boolean {
 if (!(b.width > 0 && b.height > 0 && b.height / b.width >= .015 && b.height / b.width <= .12)) return false;
 const fillRatio = area(c) / (b.width * b.height);
 if (fillRatio < .75 || fillRatio > 1.05) return false;
 // Rounded ends are allowed; waves spanning the glyph are not equal bars.
 if (!c.curves.every(ps => ps.every(p => p[0] <= b.left + b.width * .12)
   || ps.every(p => p[0] >= b.right - b.width * .12))) return false;
 let longEdges = 0;
 for (let i = 0; i < c.points.length; i++) {
  const a = c.points[i]!, z = c.points[(i + 1) % c.points.length]!;
  if (Math.abs(z[0] - a[0]) >= b.width * .75 && Math.abs(z[1] - a[1]) <= b.height * .12) longEdges++;
 }
 return longEdges >= 2;
}
function aligned(a: Box, b: Box): boolean {
 const w = Math.max(a.width, b.width);
 return Math.min(a.width, b.width) / w >= .88 && Math.abs(a.left - b.left) <= w * .06 && Math.abs(a.right - b.right) <= w * .06;
}
function distance(p: Point, a: Point, b: Point): number {
 const dx = b[0] - a[0], dy = b[1] - a[1];
 const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
 return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function chevron(c: Contour, b: Box, right: boolean): boolean {
 if (c.curved || c.points.length < 6 || c.points.length > 12 || b.height / b.width < .35 || b.height / b.width > 1.1) return false;
 const fillRatio = area(c) / (b.width * b.height);
 if (fillRatio < .03 || fillRatio > .4) return false;
 const outerX = right ? b.left : b.right, tipX = right ? b.right : b.left;
 const outer = c.points.filter(p => Math.abs(p[0] - outerX) <= b.width * .08);
 const tips = c.points.filter(p => Math.abs(p[0] - tipX) <= b.width * .08);
 const middle = (b.top + b.bottom) / 2;
 const upper = outer.filter(p => p[1] > middle), lower = outer.filter(p => p[1] < middle);
 if (upper.length < 2 || lower.length < 2 || tips.length < 2) return false;
 const avgY = (ps: Point[]) => ps.reduce((s, p) => s + p[1], 0) / ps.length;
 const topY = avgY(upper), bottomY = avgY(lower), tipY = avgY(tips);
 if (topY - bottomY < b.height * .7 || Math.abs(tipY - middle) > b.height * .15
   || Math.max(...tips.map(p => p[1])) - Math.min(...tips.map(p => p[1])) > b.height * .25) return false;
 const tolerance = Math.min(b.width * .075, b.height * .14);
 return c.points.every(p => Math.min(distance(p, [outerX, topY], [tipX, tipY]), distance(p, [outerX, bottomY], [tipX, tipY])) <= tolerance);
}

export function relationFromGlyphPath(commands: readonly GlyphPathCommand[]): '=' | '≥' | '≤' | undefined {
 const contours = contoursFrom(commands);
 if (!contours || contours.length !== 2) return undefined;
 const sorted = contours.map(c => ({c, b: box(c)})).sort((a, b) => a.b.bottom - b.b.bottom);
 const lower = sorted[0]!, upper = sorted[1]!;
 if (!bar(lower.c, lower.b) || !aligned(lower.b, upper.b)) return undefined;
 const gap = upper.b.bottom - lower.b.top;
 if (gap < lower.b.height * .6 || gap > lower.b.width * .65) return undefined;
 if (bar(upper.c, upper.b) && Math.min(lower.b.height, upper.b.height) / Math.max(lower.b.height, upper.b.height) >= .7) return '=';
 if (chevron(upper.c, upper.b, true)) return '≥';
 if (chevron(upper.c, upper.b, false)) return '≤';
 return undefined;
}

/** A map is already bound to a verified font and unambiguous source glyph.
 * Printable currency/fraction characters are never guessed from their context. */
export function repairSymbolText(text: string, repairs: ReadonlyMap<string, string>): string {
 return text.replace(/[$¼]/g, c => repairs.get(c) ?? c);
}
