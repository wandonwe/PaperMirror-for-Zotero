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

// ---- deep-explanation notes -------------------------------------------------

test('buildExplanationNoteHTML escapes everything and keeps section order', async () => {
	const { buildExplanationNoteHTML } = await import('../../src/notes/noteService');
	const html = buildExplanationNoteHTML({
		passage: 'Instead of <b>a single</b> attention function…',
		sections: [
			{ label: '整体翻译', text: '我们发现投影 h 次更有益。' },
			{ label: '关键术语', text: 'linearly project = 线性投影' }
		],
		documentTitle: 'Attention Is All You Need',
		pageNumber: 6,
		attachmentURI: 'zotero://open-pdf/library/items/ABCD'
	});
	assert.ok(!html.includes('<b>a single</b>'), 'passage markup escaped');
	assert.ok(html.includes('&lt;b&gt;'));
	assert.ok(html.indexOf('整体翻译') < html.indexOf('关键术语'), 'section order preserved');
	assert.match(html, /第 6 页/);
	assert.match(html, /zotero:\/\/open-pdf/);
});

test('explanationToPlainText renders labeled blocks without blank runs', async () => {
	const { explanationToPlainText } = await import('../../src/notes/noteService');
	const text = explanationToPlainText({
		passage: '原句',
		sections: [
			{ label: '整体翻译', text: '译文' },
			{ label: '', text: '补充' }
		],
		documentTitle: 'T',
		pageNumber: 1
	});
	assert.match(text, /【整体翻译】/);
	assert.ok(!/\n\n\n/.test(text), 'no triple newlines');
	assert.ok(text.startsWith('原句'));
});
