/**
 * Saving translations as Zotero child notes (spec 4.8).
 * Note HTML is built exclusively from escaped text — no remote HTML executes.
 */

import * as logger from '../utils/logger';
import { stripStyleMarkers } from '../reader/styleRuns';

const MODULE = 'noteService';

export function escapeHTML(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export interface NotePayload {
	originalText: string;
	translatedText: string;
	documentTitle: string;
	pageNumber: number; // 1-based, for display
	attachmentURI?: string;
}

export function buildNoteHTML(payload: NotePayload): string {
	const source = payload.attachmentURI
		? `<a href="${escapeHTML(payload.attachmentURI)}">${escapeHTML(payload.documentTitle)}</a>`
		: escapeHTML(payload.documentTitle);
	return [
		'<blockquote>',
		`<p>${escapeHTML(payload.originalText)}</p>`,
		'</blockquote>',
		`<p>${escapeHTML(stripStyleMarkers(payload.translatedText))}</p>`,
		`<p>来源 / Source: ${source}, 第 ${payload.pageNumber} 页 / p. ${payload.pageNumber}</p>`
	].join('\n');
}

/**
 * Create a child note under the attachment's parent item (or the attachment
 * itself when it has no parent).
 */
export async function saveTranslationNote(attachmentItem: ZoteroItem, payload: NotePayload): Promise<number | null> {
	try {
		const note = new Zotero.Item('note');
		note.libraryID = attachmentItem.libraryID;
		const parentID = attachmentItem.parentItemID ?? attachmentItem.parentID;
		if (parentID) {
			note.parentID = parentID;
		}
		note.setNote(buildNoteHTML(payload));
		const id = await note.saveTx();
		logger.info(MODULE, `Saved translation note ${id}`);
		return id;
	}
	catch (e) {
		logger.error(MODULE, 'Failed to save note', e);
		return null;
	}
}

export interface ExplanationNotePayload {
	passage: string;
	sections: { label: string; text: string }[];
	documentTitle: string;
	pageNumber: number;
	attachmentURI?: string;
}

/** Render a deep-explanation result as note HTML (all values escaped). */
export function buildExplanationNoteHTML(payload: ExplanationNotePayload): string {
	const source = payload.attachmentURI
		? `<a href="${escapeHTML(payload.attachmentURI)}">${escapeHTML(payload.documentTitle)}</a>`
		: escapeHTML(payload.documentTitle);
	const parts: string[] = [
		'<blockquote>',
		`<p>${escapeHTML(payload.passage)}</p>`,
		'</blockquote>'
	];
	for (const section of payload.sections) {
		if (section.label) {
			parts.push(`<p><strong>${escapeHTML(section.label)}</strong></p>`);
		}
		parts.push(`<p>${escapeHTML(section.text)}</p>`);
	}
	parts.push(`<p>来源 / Source: ${source}, 第 ${payload.pageNumber} 页 / p. ${payload.pageNumber}</p>`);
	return parts.join('\n');
}

/** Plain-text rendering of an explanation (clipboard). */
export function explanationToPlainText(payload: ExplanationNotePayload): string {
	const lines: string[] = [payload.passage, ''];
	for (const section of payload.sections) {
		lines.push(section.label ? `【${section.label}】` : '', section.text, '');
	}
	return lines.filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n').trim();
}

/** Create a child note holding a deep explanation. */
export async function saveExplanationNote(attachmentItem: ZoteroItem, payload: ExplanationNotePayload): Promise<number | null> {
	try {
		const note = new Zotero.Item('note');
		note.libraryID = attachmentItem.libraryID;
		const parentID = attachmentItem.parentItemID ?? attachmentItem.parentID;
		if (parentID) {
			note.parentID = parentID;
		}
		note.setNote(buildExplanationNoteHTML(payload));
		const id = await note.saveTx();
		logger.info(MODULE, `Saved explanation note ${id}`);
		return id;
	}
	catch (e) {
		logger.error(MODULE, 'Failed to save explanation note', e);
		return null;
	}
}

export function buildAttachmentSelectURI(attachmentItem: ZoteroItem): string {
	// zotero://open-pdf/library/items/KEY?page=N is handled by Zotero
	return `zotero://open-pdf/library/items/${attachmentItem.key}`;
}
