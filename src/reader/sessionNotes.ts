/**
 * Saving to Zotero notes and the learned-term glossary: saving a selection as
 * a note, previewing and saving learned terms (with undo), copying the terms as
 * TSV and copying an explanation.
 *
 * Moved out of readerSession.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, using the session through a view
 * over the instance (only the members listed as writable are assigned).
 */
import { buildAttachmentSelectURI, explanationToPlainText, saveTranslationNote } from '../notes/noteService';
import { parseGlossaryJSON, serializeGlossary, dedupeLearnedTerms } from '../translation/glossary';
import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { getPref, setPref } from '../utils/prefs';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderSession } from './readerSession';

const MODULE = 'readerSession';

/** What these functions use of the ReaderSession (5.1: a view over the instance, see ReaderSession.notesView; only the non-readonly members are written). */
export interface SessionNotesView {
	readonly flashNotice: ReaderSession['flashNotice'];
	glossaryUndo: ReaderSession['glossaryUndo'];
	readonly lastExplanation: ReaderSession['lastExplanation'];
	readonly manager: ReaderSession['manager'];
	readonly pane: ReaderSession['pane'];
	readonly pushFailure: ReaderSession['pushFailure'];
	readonly reader: ReaderSession['reader'];
	readonly saveSelectionToNote: ReaderSession['saveSelectionToNote'];
	readonly previewSaveLearnedTerms: ReaderSession['previewSaveLearnedTerms'];
	readonly copyTermsTsv: ReaderSession['copyTermsTsv'];
	readonly copyExplanation: ReaderSession['copyExplanation'];
}

export async function saveSelectionToNote(ctx: SessionNotesView): Promise<void> {
	if (!ctx.pane || !ctx.manager) {
		return;
	}
	const item = adapter.getReaderItem(ctx.reader);
	if (!item) {
		return;
	}
	const page = adapter.getCurrentPageIndex(ctx.reader);
	const state = ctx.manager.getPageState(page);
	if (!state) {
		return;
	}
	// Selection in pane, or the highlighted block, or the whole page
	const selection = ctx.pane.getSelectionText();
	let original = '';
	let translated = '';
	const selectedId = ctx.pane.getSelectedBlockId();
	if (selection) {
		translated = selection;
		original = adapter.getSelectedText(ctx.reader) || (selectedId
			? state.blocks.find(b => b.id === selectedId)?.sourceText ?? ''
			: '');
	}
	else if (selectedId) {
		const block = state.blocks.find(b => b.id === selectedId);
		original = block?.sourceText ?? '';
		translated = state.translations.get(selectedId) ?? '';
	}
	else {
		original = state.blocks.map(b => b.sourceText).join('\n\n');
		translated = ctx.pane.getPageText(page, state.blocks, state.translations, 'plain');
	}
	if (!translated) {
		return;
	}
	const noteID = await saveTranslationNote(item, {
		originalText: original,
		translatedText: translated,
		documentTitle: item.getDisplayTitle?.() ?? '',
		pageNumber: page + 1,
		attachmentURI: buildAttachmentSelectURI(item)
	});
	if (noteID) {
		ctx.flashNotice(getString('papermirror-toast-saved'));
	}
	else {
		ctx.pushFailure(getString('papermirror-status-error'));
	}
}

/** Copy the current deep explanation as plain text. */
export function copyExplanation(ctx: SessionNotesView): void {
	if (!ctx.pane || !ctx.lastExplanation) {
		return;
	}
	const item = adapter.getReaderItem(ctx.reader);
	const text = explanationToPlainText({
		passage: ctx.lastExplanation.passage,
		sections: ctx.lastExplanation.sections,
		documentTitle: item?.getDisplayTitle?.() ?? '',
		pageNumber: ctx.lastExplanation.pageNumber
	});
	try {
		Components.classes['@mozilla.org/widget/clipboardhelper;1']
			.getService(Components.interfaces.nsIClipboardHelper)
			.copyString(text);
		ctx.flashNotice(getString('papermirror-toast-copied'));
	}
	catch (e) {
		logger.warn(MODULE, 'Clipboard copy failed', e);
	}
}

export function copyTermsTsv(ctx: SessionNotesView, terms: { source: string; target: string }[]): void {
	try {
		const tsv = terms.map(t => `${t.source}\t${t.target}`).join('\n');
		Components.classes['@mozilla.org/widget/clipboardhelper;1']
			.getService(Components.interfaces.nsIClipboardHelper)
			.copyString(tsv);
		ctx.flashNotice(`已复制 ${terms.length} 条术语对照(TSV)`);
	}
	catch (e) {
		logger.warn(MODULE, 'term table copy failed', e);
	}
}

/**
 * 「术语」名称与行为统一 (2.3.1, 计划 第四批 item3 · WF-8): 不再只复制 TSV,
 * 而是**预览并保存到词汇表** —— 与既有词汇表去重、确认框预览、保存为
 * 'suggested'(参考,不强制模型)、支持一键撤销;「编辑」在设置页词汇表
 * 编辑器闭环。确认框如实提示: 词汇表是译文身份的一部分(glossaryHash 入
 * 缓存键),保存会使本篇已缓存译文在下次打开时按新术语重译。
 * 「仅复制 TSV」保留为确认框第二按钮(旧行为不丢)。
 */
export function previewSaveLearnedTerms(ctx: SessionNotesView): void {
	const terms = ctx.manager?.learnedTerms() ?? [];
	if (!terms.length) {
		ctx.flashNotice('本篇尚未学得术语对(翻译几页后再试)');
		return;
	}
	const existingJson = getPref<string>('glossaryGlobal', '[]');
	const existing = parseGlossaryJSON(existingJson);
	// 去重: 先对既有词汇表,再对本篇自身(纯函数,单测覆盖)。
	const fresh = dedupeLearnedTerms(existing, terms);
	const prompt = (Services as unknown as {
		prompt?: {
			confirm(parent: unknown, title: string, text: string): boolean;
			confirmEx?(parent: unknown, title: string, text: string, flags: number,
				b0: string | null, b1: string | null, b2: string | null,
				check: string | null, state: { value: boolean }): number;
		};
	}).prompt;
	const win = (Zotero as unknown as { getMainWindow?(): unknown }).getMainWindow?.() ?? null;
	if (!fresh.length) {
		// 全部已在词汇表 → 提供撤销上次保存(若有)。
		if (ctx.glossaryUndo && prompt?.confirm) {
			const undo = ctx.glossaryUndo;
			if (prompt.confirm(win, '术语已全部在词汇表中',
				`本篇学得的 ${terms.length} 条术语已全部在词汇表中。撤销上次保存的 ${undo.added} 条?`)) {
				setPref('glossaryGlobal', undo.json);
				ctx.glossaryUndo = null;
				ctx.flashNotice(`已撤销上次保存的 ${undo.added} 条术语`);
			}
		}
		else {
			ctx.flashNotice(`本篇学得的 ${terms.length} 条术语已全部在词汇表中(设置 → 词汇表可编辑)`);
		}
		return;
	}
	const PREVIEW_MAX = 12;
	const previewLines = fresh.slice(0, PREVIEW_MAX).map(t => `${t.source} → ${t.target}`);
	if (fresh.length > PREVIEW_MAX) {
		previewLines.push(`…等共 ${fresh.length} 条`);
	}
	const text = `本篇新学得 ${fresh.length} 条术语(已与词汇表现有 ${existing.length} 条去重):\n\n`
		+ previewLines.join('\n')
		+ '\n\n保存为「参考」术语(不强制模型);可在设置 → 词汇表中编辑,再点一次「术语」可撤销。'
		+ '\n注意:词汇表变化会使本篇已缓存译文在下次打开时按新术语重译。';
	let choice = 0; // 0=保存 1=仅复制TSV 2=取消
	try {
		if (prompt?.confirmEx) {
			// STD flags: (BUTTON_TITLE_IS_STRING=127) 每键位 <<0/8/16。
			const IS_STRING = 127;
			choice = prompt.confirmEx(win, '保存术语到词汇表', text,
				IS_STRING | (IS_STRING << 8) | (IS_STRING << 16),
				'保存到词汇表', '仅复制 TSV', '取消', null, { value: false });
		}
		else if (prompt?.confirm) {
			choice = prompt.confirm(win, '保存术语到词汇表', text) ? 0 : 2;
		}
	}
	catch {
		choice = 2; // 无法弹框时不做破坏性动作
	}
	if (choice === 1) {
		ctx.copyTermsTsv(terms);
		return;
	}
	if (choice !== 0) {
		return;
	}
	ctx.glossaryUndo = { json: existingJson, added: fresh.length };
	const merged = [...existing, ...fresh.map(t => ({ source: t.source, target: t.target, mode: 'suggested' as const }))];
	setPref('glossaryGlobal', serializeGlossary(merged));
	ctx.flashNotice(`已保存 ${fresh.length} 条术语到词汇表(设置中可编辑;再点「术语」可撤销)`);
}
