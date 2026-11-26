/**
 * Explaining a selected passage: the explanation request with its cache and
 * privacy checks, and the automatic explanation watcher (selection and
 * double-click on the original page).
 *
 * Moved out of readerSession.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, using the session through a view
 * over the instance (only the members listed as writable are assigned).
 */
import { sourceBlockAtPoint } from './sourceBlockAtPoint';
import { hashSourceTexts } from '../cache/cacheSchema';
import { getProvider } from '../translation/providers/registry';
import { canExplain, explainText, parseExplanationSections } from '../translation/explainer';
import { PaperMirrorError } from '../types/models';
import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { getPref, registerPrefObserver } from '../utils/prefs';
import * as adapter from './zoteroReaderAdapter';
import { watchAutoExplainSelection } from './autoExplainSelection';
import type { ReaderSession } from './readerSession';

const MODULE = 'readerSession';

/** What these functions use of the ReaderSession (5.1: a view over the instance, see ReaderSession.explanationsView; only the non-readonly members are written). */
export interface SessionExplanationsView {
	readonly assertProviderEndpointAllowed: ReaderSession['assertProviderEndpointAllowed'];
	autoExplainPrefObserver: ReaderSession['autoExplainPrefObserver'];
	readonly destroyed: ReaderSession['destroyed'];
	disposeAutoExplain: ReaderSession['disposeAutoExplain'];
	disposeOriginalDoubleClick: ReaderSession['disposeOriginalDoubleClick'];
	readonly explainCache: ReaderSession['explainCache'];
	explanationIsAutomatic: ReaderSession['explanationIsAutomatic'];
	explanationRequest: ReaderSession['explanationRequest'];
	readonly isWindowHidden: ReaderSession['isWindowHidden'];
	lastExplanation: ReaderSession['lastExplanation'];
	localOnlyPrefObserver: ReaderSession['localOnlyPrefObserver'];
	readonly manager: ReaderSession['manager'];
	readonly pane: ReaderSession['pane'];
	readonly providerEndpointAllowed: ReaderSession['providerEndpointAllowed'];
	readonly providerSettings: ReaderSession['providerSettings'];
	readonly reader: ReaderSession['reader'];
	readonly resolveLanguages: ReaderSession['resolveLanguages'];
	readonly viewMode: ReaderSession['viewMode'];
	readonly explainSelection: ReaderSession['explainSelection'];
	readonly watchAutomaticExplanation: ReaderSession['watchAutomaticExplanation'];
}

/**
 * 选中句子解析 (Read Frog-style analysis): explain the current PDF
 * selection — or the highlighted block — using the configured LLM.
 */
export function watchAutomaticExplanation(ctx: SessionExplanationsView): void {
	// This policy also applies to manual explanations, even when the native
	// PDF selection document is temporarily unavailable.
	try {
		ctx.localOnlyPrefObserver = registerPrefObserver('localOnlyMode', () => {
			ctx.explanationRequest?.abort();
			ctx.explanationRequest = null;
			ctx.pane?.hideExplanation();
		});
	}
	catch { /* The policy is checked again before dispatch and response commit. */ }
	const doc = adapter.getOriginalSelectionDocument(ctx.reader);
	if (!doc) return;
	ctx.pane?.setExplanationDismissDocument(doc);
	const cancelAutomatic = () => {
		if (ctx.explanationIsAutomatic) {
			ctx.explanationRequest?.abort();
			ctx.explanationRequest = null;
			ctx.pane?.hideExplanation();
		}
	};
	ctx.disposeAutoExplain = watchAutoExplainSelection({
		document: doc,
		readText: () => adapter.getOriginalSelectedText(ctx.reader),
		enabled: () => !ctx.destroyed && !ctx.isWindowHidden()
			&& getPref<boolean>('privacyNoticeAccepted', false)
			&& getPref<boolean>('autoExplainSelection', true),
		onChange: cancelAutomatic,
		onSelection: text => { void ctx.explainSelection(text, true); }
	});
	// Hover-to-peek hides translated nodes, so native PDF text receives the
	// double click. Resolve the paragraph geometrically instead of using
	// PDF.js's word selection.
	const doubleClick = (event: MouseEvent) => {
		if (ctx.viewMode !== 'overlay' || ctx.destroyed) return;
		const target = event.target as Element | null;
		if (!target?.closest?.('.textLayer')) return;
		const pageElement = target.closest('.page');
		const pageIndex = Number(pageElement?.getAttribute('data-page-number')) - 1;
		if (!Number.isInteger(pageIndex) || pageIndex < 0) return;
		const view = adapter.getPageView(ctx.reader, pageIndex);
		const blocks = ctx.manager?.getPageState(pageIndex)?.blocks;
		if (!view || !blocks) return;
		const rect = view.div.getBoundingClientRect();
		const block = sourceBlockAtPoint(blocks, event.clientX - rect.left - view.div.clientLeft,
			event.clientY - rect.top - view.div.clientTop, view.toCss);
		if (!block?.sourceText.trim()) return;
		void ctx.explainSelection(block.sourceText);
	};
	doc.addEventListener('dblclick', doubleClick, true);
	ctx.disposeOriginalDoubleClick = () => doc.removeEventListener('dblclick', doubleClick, true);
	try {
		ctx.autoExplainPrefObserver = registerPrefObserver('autoExplainSelection', value => {
			if (!value) cancelAutomatic();
		});
	}
	catch { /* The trigger still reads the preference before every request. */ }
}

export async function explainSelection(ctx: SessionExplanationsView, explicitText?: string, automatic = false): Promise<void> {
	if (!ctx.pane || ctx.destroyed || !getPref<boolean>('privacyNoticeAccepted', false)) {
		return;
	}
	if (!automatic) ctx.disposeAutoExplain?.suppressCurrentSelection();
	ctx.explanationRequest?.abort();
	const request = new AbortController();
	ctx.explanationRequest = request;
	ctx.explanationIsAutomatic = automatic;
	let endpointStillAllowed = () => true;
	const live = () => !ctx.destroyed && !request.signal.aborted
		&& ctx.explanationRequest === request && !!ctx.pane && endpointStillAllowed()
		&& (!automatic || (getPref<boolean>('autoExplainSelection', true)
			&& !ctx.isWindowHidden() && adapter.getOriginalSelectedText(ctx.reader).trim() === text));
	// 1. Resolve the passage: explicit text > PDF selection > selected block
	let text = (explicitText ?? '').trim() || adapter.getSelectedText(ctx.reader).trim();
	let context = '';
	const page = adapter.getCurrentPageIndex(ctx.reader);
	const state = ctx.manager?.getPageState(page);
	const selectedId = ctx.pane.getSelectedBlockId();
	if (!text && selectedId && state) {
		text = state.blocks.find(b => b.id === selectedId)?.sourceText ?? '';
	}
	if (!text) {
		ctx.pane.showExplanation({ error: getString('papermirror-explain-no-selection') });
		return;
	}
	if (state) {
		context = state.blocks.map(b => b.sourceText).join('\n').slice(0, 600);
	}
	// 2. Resolve an LLM-capable provider
	try {
		const settings = await ctx.providerSettings();
		if (!live()) return;
		const provider = getProvider(settings.providerId);
		if (!canExplain(provider)) {
			if (!automatic) ctx.pane.showExplanation({ passage: text, error: getString('papermirror-explain-needs-llm') });
			return;
		}
		if (automatic && provider.requiresApiKey && !settings.apiKey) return;
		// Automatic selections stay quiet when the configured cloud endpoint
		// is disallowed. A manual action explains the policy in its card.
		if (automatic && !ctx.providerEndpointAllowed(settings, provider.defaultBaseURL)) return;
		ctx.assertProviderEndpointAllowed(settings, provider.defaultBaseURL);
		endpointStillAllowed = () => ctx.providerEndpointAllowed(settings, provider.defaultBaseURL);
		// 3. Run — 讲解缓存 (2.3.5, 第四批 item7 · API-8): 同段落+同引擎/模型/语言
		// 的解析在会话内缓存,重复选中/误触零请求(重读一段是常态,按次计费)。
		ctx.pane.showExplanation({ passage: text, loading: true });
		const { target } = ctx.resolveLanguages(text);
		const cacheKey = hashSourceTexts([text, settings.providerId, settings.model ?? '', target]);
		const cached = ctx.explainCache.get(cacheKey);
		if (cached) {
			ctx.lastExplanation = { passage: text, sections: cached, pageNumber: page + 1 };
			ctx.pane.showExplanation({ passage: text, sections: cached });
			return;
		}
		const item = adapter.getReaderItem(ctx.reader);
		const result = await explainText(provider, settings, {
			text,
			targetLanguage: target,
			documentTitle: item?.getDisplayTitle?.() ?? '',
			context,
			signal: request.signal
		});
		if (!live()) return;
		const sections = parseExplanationSections(result);
		ctx.explainCache.set(cacheKey, sections);
		ctx.lastExplanation = { passage: text, sections, pageNumber: page + 1 };
		ctx.pane.showExplanation({ passage: text, sections });
	}
	catch (e) {
		if (!live()) return;
		const error = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
		const message = error.code === 'NO_API_KEY'
			? getString('papermirror-error-no-api-key')
			: error.message;
		ctx.pane.showExplanation({ error: message });
		logger.warn(MODULE, 'explainSelection failed', e);
	}
}
