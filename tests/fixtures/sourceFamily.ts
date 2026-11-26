import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 5.1: the four largest source files were split into modules without changing
 * behaviour. Tests that read source text to guard a rule ("timings are numbers
 * only", "'table' is produced in one place") read the whole family, so the
 * rule keeps applying wherever the code now lives.
 */
export const SOURCE_FAMILIES: Record<string, string[]> = {
	'src/reader/spanBlockBuilder.ts': ['src/reader/spanLines.ts', 'src/reader/spanParagraphs.ts'],
	'src/reader/paragraphHeuristics.ts': ['src/reader/columnGeometry.ts'],
	'src/translation/translationManager.ts': ['src/translation/translationManagerTypes.ts', 'src/translation/chunkRecovery.ts'],
	'src/reader/readerSession.ts': ['src/reader/sessionExports.ts']
};

/** The file's text followed by the text of the modules split out of it. */
export function readSource(path: string): string {
	return [path, ...(SOURCE_FAMILIES[path] ?? [])].map(p => readFileSync(join(process.cwd(), p), 'utf8')).join('\n');
}
