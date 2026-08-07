/**
 * Saving translations as Zotero child notes (spec 4.8).
 * Note HTML is built exclusively from escaped text — no remote HTML executes.
 */

import * as logger from '../utils/logger';

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
		`<p>${escapeHTML(payload.translatedText)}</p>`,
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

export function buildAttachmentSelectURI(attachmentItem: ZoteroItem): string {
	// zotero://open-pdf/library/items/KEY?page=N is handled by Zotero
	return `zotero://open-pdf/library/items/${attachmentItem.key}`;
}
