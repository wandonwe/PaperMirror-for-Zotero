/** Only simple, filled relation and square-marker glyphs are recognized. Font names, apparent
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

/** 校验 r24 (3023, RSNA "Universal Greek with Math Pi"): a math font that
 * draws "<", ">", "+", "−", "×" in the slots of ",", ".", "1", "2", "3" — the
 * text layer reads "P , .001" and "120 3 0.2". One filled contour, recognized
 * from its outline only: a chevron, a bar, or a cross (upright or diagonal). */
export function operatorFromGlyphPath(commands: readonly GlyphPathCommand[]): '<' | '>' | '−' | '+' | '×' | undefined {
 const contours = contoursFrom(commands);
 if (!contours || contours.length !== 1) return undefined;
 const c = contours[0]!, b = box(c);
 if (!(b.width > 0 && b.height > 0)) return undefined;
 if (chevron(c, b, true)) return '>';
 if (chevron(c, b, false)) return '<';
 if (bar(c, b)) return '−';
 if (cross(c.points)) return '+';
 const r = Math.SQRT1_2;
 if (cross(c.points.map(([x, y]) => [x * r - y * r, x * r + y * r] as Point))) return '×';
 return undefined;
}
/** Twelve corners, every edge axis-aligned, four equal arms around a square core. */
function cross(input: Point[]): boolean {
 const points = input.slice();
 const same = (a: Point, z: Point): boolean => Math.abs(a[0] - z[0]) < 1e-6 && Math.abs(a[1] - z[1]) < 1e-6;
 if (points.length === 13 && same(points[0]!, points[12]!)) points.pop();
 if (points.length !== 12) return false;
 const c: Contour = {points, curves: [], curved: false};
 const b = box(c);
 if (!(b.width > 0 && b.height > 0) || Math.min(b.width, b.height) / Math.max(b.width, b.height) < .85) return false;
 const eps = Math.max(b.width, b.height) * .02;
 for (let i = 0; i < 12; i++) {
  const a = points[i]!, z = points[(i + 1) % 12]!;
  if (Math.abs(a[0] - z[0]) > eps && Math.abs(a[1] - z[1]) > eps) return false;
 }
 // Arms: the distinct x and y coordinates are the box edges and the core edges.
 const xs = [...new Set(points.map(p => Math.round(p[0] / eps)))].sort((m, n) => m - n);
 const ys = [...new Set(points.map(p => Math.round(p[1] / eps)))].sort((m, n) => m - n);
 if (xs.length !== 4 || ys.length !== 4) return false;
 const fill = area(c) / (b.width * b.height);
 if (fill < .1 || fill > .6) return false;
 const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
 const coreX = (xs[2]! - xs[1]!) * eps, coreY = (ys[2]! - ys[1]!) * eps;
 return Math.abs((xs[1]! + xs[2]!) * eps / 2 - cx) <= b.width * .06 && Math.abs((ys[1]! + ys[2]!) * eps / 2 - cy) <= b.height * .06
  && coreX <= b.width * .35 && coreY <= b.height * .35 && Math.abs(coreX - coreY) <= Math.max(coreX, coreY) * .25;
}

/** A solid square has one four-corner, axis-aligned contour. A hollow box,
 * letter, diamond, malformed/retraced outline or curved shape is not evidence
 * of a square bullet. Units, position, contour start and winding are irrelevant. */
export function squareBulletFromGlyphPath(commands: readonly GlyphPathCommand[]): '▪' | undefined {
 const contours = contoursFrom(commands);
 if (!contours || contours.length !== 1) return undefined;
 const c = contours[0]!, b = box(c);
 if (c.curved || b.width <= 0 || b.height <= 0 || Math.min(b.width, b.height) / Math.max(b.width, b.height) < .99) return undefined;
 const points = c.points.slice();
 const same = (a: Point, z: Point): boolean => a[0] === z[0] && a[1] === z[1];
 if (points.length === 5 && same(points[0]!, points[4]!)) points.pop();
 if (points.length !== 4 || new Set(points.map(p => `${p[0]},${p[1]}`)).size !== 4) return undefined;
 const eps = Math.max(b.width, b.height) * 1e-6;
 if (!points.every((p, i) => {
  const z = points[(i + 1) % points.length]!;
  return (Math.abs(p[0] - b.left) <= eps || Math.abs(p[0] - b.right) <= eps)
   && (Math.abs(p[1] - b.bottom) <= eps || Math.abs(p[1] - b.top) <= eps)
   && (Math.abs(z[0] - p[0]) <= eps || Math.abs(z[1] - p[1]) <= eps);
 })) return undefined;
 return Math.abs(area(c) / (b.width * b.height) - 1) <= 1e-6 ? '▪' : undefined;
}

/** Avoid original-font reads for ordinary words containing the letter n.
 * A font-separated marker is a standalone n in text-content / DOM spans;
 * per-character reader data still reaches this with its individual n. */
export function hasSymbolCandidate(text: string): boolean {
 return /[$¼]|(?:^|\s)n(?:\s|$)/.test(text) || OPERATOR_SLOT_RUN.test(text);
}
/** A math-font operator arrives as its own text run: "," "." "1" "2" "3" alone. */
const OPERATOR_SLOT_RUN = /^\s*[,.123]\s*$/;
/** Characters whose slot a math font may fill with an operator glyph. */
export const OPERATOR_SLOTS = new Set([',', '.', '1', '2', '3']);

/** A map is already bound to a verified font and unambiguous source glyph.
 * Printable characters are never guessed from their context. */
export function repairSymbolText(text: string, repairs: ReadonlyMap<string, string>): string {
 return repairs.size ? text.replace(/[$¼n,.123]/g, c => repairs.get(c) ?? c) : text;
}
