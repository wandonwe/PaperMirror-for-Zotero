/** Pure, side-effect-free helpers for the XPI release gate (verify-xpi.mjs).
 * Kept separate so tests can import them without triggering the CLI entry. */

import { basename } from 'node:path';

/**
 * Allow-list of every file the XPI may contain (directory entries — trailing
 * `/` — are always allowed). A blacklist can only catch debris we thought of;
 * shipping a plugin that carries an API key, a `.map` exposing sources, or a
 * stray `.ts`/`.env` is a real leak. Anything not matched here fails the gate,
 * so a new asset type is a deliberate one-line change, not a silent inclusion.
 */
export const ALLOWED = [
	// Top-level required + entry points
	/^LICENSE$/,
	/^THIRD-PARTY-NOTICES\.md$/,
	/^manifest\.json$/,
	/^bootstrap\.js$/,
	/^prefs\.js$/,
	// Bundle + preferences UI
	/^content\/index\.js$/,
	/^content\/preferences\.js$/,
	/^content\/preferences\.xhtml$/,
	/^content\/[^/]+\.css$/,
	// Bundled assets
	/^content\/fonts\/[^/]+\.(ttf|otf|woff2?)$/,
	/^content\/icons\/[^/]+\.(svg|png|webp)$/,
	// Localisation
	/^locale\/[A-Za-z-]+\/[^/]+\.ftl$/
];

/** Debris patterns that must never appear (macOS junk, build markers). */
export function forbiddenEntries(entries) {
	return entries.filter(entry =>
		/(^|\/)\.DS_Store$/.test(entry) || /(^|\/)\._/.test(entry) || entry === '.built');
}

/** Every non-directory entry that is NOT on the allow-list. */
export function disallowedEntries(entries) {
	return entries.filter(entry => !entry.endsWith('/') && !ALLOWED.some(re => re.test(entry)));
}

/** Required top-level entries missing from the archive. */
export function missingRequired(entries) {
	return ['manifest.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md'].filter(r => !entries.includes(r));
}

/** Dotted-numeric version compare (with dash-separated prerelease parts). */
export function semverCompare(a, b) {
	const parse = (v) => v.split(/[.-]/).map(x => (/^\d+$/.test(x) ? Number(x) : x));
	const pa = parse(a);
	const pb = parse(b);
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = pa[i];
		const y = pb[i];
		if (x === y) continue;
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (typeof x === 'number' && typeof y === 'number') return x - y;
		return String(x) < String(y) ? -1 : 1;
	}
	return 0;
}

export function versionFromName(name) {
	const m = /^zotero-bilingual-reader-(.+)\.xpi$/.exec(basename(name));
	return m ? m[1] : '';
}
