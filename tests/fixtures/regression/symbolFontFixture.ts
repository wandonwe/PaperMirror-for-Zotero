import assert from 'node:assert/strict';
import { PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import outlines from './symbol-font-outline-cases.json';
import type { GlyphPathCommand } from '../../../src/reader/symbolFontSemantics';

// Tiny generated Type2/CFF programs contain only .notdef and test glyphs.
// Tests do not load installed fonts or a user's PDF from an absolute path.
function index(parts: number[][]): number[] {
 if (!parts.length) return [0, 0];
 const size = parts.reduce((sum, p) => sum + p.length, 0);
 const offSize = size + 1 > 65535 ? 4 : 2;
 const offsets: number[] = [];
 const put = (v: number): void => { for (let n = offSize - 1; n >= 0; n--) offsets.push((v >>> (n * 8)) & 255); };
 let offset = 1;
 put(offset);
 for (const part of parts) { offset += part.length; put(offset); }
 return [parts.length >>> 8, parts.length & 255, offSize, ...offsets, ...parts.flat()];
}
const integer = (v: number): number[] => [29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
function operand(v: number): number[] {
 assert.ok(Number.isInteger(v) && v >= -32768 && v <= 32767);
 if (v >= -107 && v <= 107) return [v + 139];
 return [28, (v >> 8) & 255, v & 255];
}
function charString(commands: readonly GlyphPathCommand[]): number[] {
 const bytes: number[] = [];
 let x = 0, y = 0;
 for (const command of commands) {
  const a = command.args.map(v => Math.round(v * 1000));
  if (command.command === 'closePath') continue; // Type2 closes before the next move/endchar.
  if (command.command === 'moveTo' || command.command === 'lineTo') {
   bytes.push(...operand(a[0]! - x), ...operand(a[1]! - y), command.command === 'moveTo' ? 21 : 5);
   [x, y] = [a[0]!, a[1]!];
  } else if (command.command === 'bezierCurveTo') {
   bytes.push(...operand(a[0]! - x), ...operand(a[1]! - y),
    ...operand(a[2]! - a[0]!), ...operand(a[3]! - a[1]!),
    ...operand(a[4]! - a[2]!), ...operand(a[5]! - a[3]!), 8);
   [x, y] = [a[4]!, a[5]!];
  } else assert.fail(`unsupported generated test command ${command.command}`);
 }
 return [...bytes, 14];
}
function dictReal(value: number): number[] {
 // CFF real operands use decimal nibbles. An overflowing exponent and an
 // invalid decimal exercise fontkit's non-finite FontMatrix results.
 const text = Number.isNaN(value) ? '.' : value === Infinity ? '1E999' : value === -Infinity ? '-1E999' : String(value).toUpperCase();
 const nibbles = text.match(/E-|./g)!.map(c => c === '.' ? 10 : c === 'E' ? 11 : c === 'E-' ? 12 : c === '-' ? 14 : Number(c));
 nibbles.push(15);
 if (nibbles.length % 2) nibbles.push(15);
 const bytes = [30];
 for (let i = 0; i < nibbles.length; i += 2) bytes.push((nibbles[i]! << 4) | nibbles[i + 1]!);
 return bytes;
}
export function cff(glyphs: { name: string; commands: readonly GlyphPathCommand[] }[], options: { fontMatrix?: readonly number[] } = {}): Uint8Array {
 const nameIndex = index([[...Buffer.from('GeneratedEvidence')]]);
 const strings = index(glyphs.map(g => [...Buffer.from(g.name)]));
 const charset = [0, ...glyphs.flatMap((_, i) => [(391 + i) >>> 8, (391 + i) & 255])];
 const charStrings = index([[14], ...glyphs.map(g => charString(g.commands))]);
 const matrix = options.fontMatrix ? [...options.fontMatrix.flatMap(dictReal), 12, 7] : [];
 const dict = (charsetOffset: number, charsOffset: number, privateOffset: number): number[] =>
  [...matrix, ...integer(charsetOffset), 15, ...integer(charsOffset), 17, ...integer(0), ...integer(privateOffset), 18];
 const prefixSize = 4 + nameIndex.length + index([dict(0, 0, 0)]).length + strings.length + 2;
 const charsOffset = prefixSize + charset.length;
 return Uint8Array.from([1, 0, 4, 4, ...nameIndex,
  ...index([dict(prefixSize, charsOffset, charsOffset + charStrings.length)]),
  ...strings, 0, 0, ...charset, ...charStrings]);
}

export const ge = outlines.positive.find(p => p.expected === '≥')!.commands;
export const eq = outlines.positive.find(p => p.expected === '=')!.commands;
export const ordinaryDollar = outlines.negative.find(p => p.rawUnicode === '$')!.commands;
export const evidenceCff = (): Uint8Array => cff([{ name: 'dollar', commands: ge }, { name: 'onequarter', commands: eq }]);
export type Encoding = string | { BaseEncoding?: string; Differences?: (number | string)[] };
export function font(pdf: PDFDocument, options: { name?: string; raw?: Uint8Array; encoding?: Encoding; subtype?: string; fileSubtype?: string } = {}): PDFRef {
 const stream = pdf.context.register(pdf.context.flateStream(options.raw ?? evidenceCff(), { Subtype: options.fileSubtype ?? 'Type1C' }));
 const descriptor = pdf.context.register(pdf.context.obj({ Type: 'FontDescriptor', FontName: options.name ?? 'TestFace', FontFile3: stream }));
 return pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: options.subtype ?? 'Type1', BaseFont: options.name ?? 'TestFace',
  Encoding: options.encoding ?? 'WinAnsiEncoding', FontDescriptor: descriptor }));
}
export async function source(pdf: PDFDocument): Promise<{ getData: () => Promise<Uint8Array>; reads: () => number }> {
 const bytes = await pdf.save();
 let reads = 0;
 return { getData: async () => { reads++; return bytes; }, reads: () => reads };
}
export async function oneFont(options: Parameters<typeof font>[1] = {}): Promise<Awaited<ReturnType<typeof source>>> {
 const pdf = await PDFDocument.create(), page = pdf.addPage();
 page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font(pdf, options) } }));
 return source(pdf);
}
