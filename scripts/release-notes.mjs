#!/usr/bin/env node
/**
 * Extract one version's section from CHANGELOG.md into release-notes.md, so
 * the GitHub Release shows the real, human-written notes for that version
 * (with the auto-generated commit list appended below them by the workflow).
 *
 * Usage: node scripts/release-notes.mjs <version>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

const escaped = version.replace(/\./g, '\\.');
const match = changelog.match(new RegExp(`## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`));
const body = match ? match[1].trim() : `See CHANGELOG.md for v${version}.`;
writeFileSync(join(root, 'release-notes.md'), body + '\n');
console.log(`release-notes.md → v${version} (${body.length} chars)`);
