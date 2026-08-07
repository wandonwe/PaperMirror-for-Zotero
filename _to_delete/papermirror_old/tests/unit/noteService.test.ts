import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHTML, buildNoteHTML } from '../../src/notes/noteService';

test('escapeHTML neutralizes markup (no script execution in notes)', () => {
	const out = escapeHTML('<img src=x onerror=alert(1)> & "quotes"');
	assert.ok(!out.includes('<img'));
	assert.ok(out.includes('&lt;img'));
	assert.ok(out.includes('&amp;'));
	assert.ok(out.includes('&quot;'));
});

test('buildNoteHTML places original in blockquote and translation after', () => {
	const html = buildNoteHTML({
		originalText: 'This study aims to...',
		translatedText: '本研究旨在……',
		documentTitle: 'A Paper',
		pageNumber: 6,
		attachmentURI: 'zotero://open-pdf/library/items/ABCD'
	});
	assert.match(html, /<blockquote>[\s\S]*This study aims/);
	assert.match(html, /本研究旨在……/);
	assert.match(html, /第 6 页|p\. 6/);
	assert.match(html, /zotero:\/\/open-pdf/);
});

test('buildNoteHTML escapes malicious document titles', () => {
	const html = buildNoteHTML({
		originalText: 'x',
		translatedText: 'y',
		documentTitle: '<script>alert(1)</script>',
		pageNumber: 1
	});
	assert.ok(!html.includes('<script>'));
});
