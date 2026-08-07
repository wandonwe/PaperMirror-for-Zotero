/**
 * Plugin startup: initialize logging, localization, toolbar controller and
 * the preferences pane. Registers every disposer with the shutdown registry.
 */

import * as cacheManager from '../cache/cacheManager';
import { ReaderToolbarController } from '../reader/readerToolbar';
import { deleteApiKey, getApiKey, setApiKey } from '../security/credentialStore';
import { getProvider, listProviders } from '../translation/providers/registry';
import { parseGlossaryJSON, parseGlossaryLines, serializeGlossary, serializeGlossaryLines } from '../translation/glossary';
import type { ProviderSettings, ValidationResult } from '../types/models';
import { getString, initL10n } from '../utils/l10n';
import { installAbortPolyfill } from '../utils/abortPolyfill';
import * as logger from '../utils/logger';
import { getPref, registerPrefObserver, setPref, unregisterPrefObserver } from '../utils/prefs';
import { addDisposer } from './shutdown';

const MODULE = 'startup';

export interface StartupParams {
	id: string;
	version: string;
	rootURI: string;
}

export let toolbarController: ReaderToolbarController | null = null;

export async function startup(params: StartupParams): Promise<void> {
	// The Zotero plugin sandbox lacks AbortController; install our
	// cooperative-cancellation polyfill before anything can request one.
	installAbortPolyfill();

	await Zotero.initializationPromise;
	await Zotero.uiReadyPromise;

	logger.setDebugEnabled(getPref<boolean>('debugLogging', false));
	const prefObserver = registerPrefObserver('debugLogging', value => logger.setDebugEnabled(!!value));
	addDisposer(() => unregisterPrefObserver(prefObserver));

	initL10n();

	toolbarController = new ReaderToolbarController(params.id);
	toolbarController.init();
	addDisposer(() => {
		toolbarController?.dispose();
		toolbarController = null;
	});

	// Preferences pane
	try {
		const paneID = await Zotero.PreferencePanes.register({
			pluginID: params.id,
			id: 'papermirror-prefpane',
			src: params.rootURI + 'content/preferences.xhtml',
			scripts: [params.rootURI + 'content/preferences.js'],
			label: getString('papermirror-prefpane-label') === 'papermirror-prefpane-label'
				? 'PaperMirror'
				: getString('papermirror-prefpane-label'),
			image: params.rootURI + 'content/icons/icon48.png'
		});
		addDisposer(() => {
			try {
				Zotero.PreferencePanes.unregister(paneID);
			}
			catch {
				// unregistered automatically on shutdown anyway
			}
		});
	}
	catch (e) {
		logger.error(MODULE, 'Failed to register preferences pane', e);
	}

	// Public helper API for the preferences pane script (runs in the prefs
	// window, which has the Zotero global but not our sandbox scope).
	const publicAPI = {
		/** Toggle bilingual view on the current reader tab (manual entry). */
		toggle: () => toolbarController?.toggleCurrent() ?? Promise.resolve('Plugin not initialized.'),
		/** Overlay coordinate self-check (Run JavaScript): verifyOverlay() */
		verifyOverlay: () => toolbarController?.verifyOverlay() ?? 'Plugin not initialized.',
		/** Cycle 覆盖模式: 原文淡化 → 仅译文 → 悬停显示 */
		cycleOverlayMode: () => toolbarController?.cycleOverlayMode() ?? 'Plugin not initialized.',
		/** Clear cached translations for the document in the active reader tab. */
		clearCurrentCache: () => toolbarController?.clearCurrentCache() ?? Promise.resolve('Plugin not initialized.'),
		/** Environment self-check; run in Tools → Developer → Run JavaScript:
		 *    return await Zotero.PaperMirror.diagnose(); */
		diagnose: async (): Promise<string> => {
			const lines: string[] = [];
			lines.push(`PaperMirror ${params.version} on Zotero ${Zotero.version}`);
			lines.push(`AbortController: ${typeof (globalThis as Record<string, unknown>).AbortController}`);
			lines.push(`XMLHttpRequest: ${typeof (globalThis as Record<string, unknown>).XMLHttpRequest}`);
			try {
				const readers = Zotero.Reader._readers ?? [];
				lines.push(`Open readers: ${readers.length}`);
				for (const r of readers) {
					const hasContainer = !!(r as { _tabContainer?: unknown })._tabContainer;
					const type = (r as { type?: string }).type ?? '?';
					const hasCustomSections = !!(r as { _iframeWindow?: Window })._iframeWindow?.document?.querySelector?.('.toolbar .custom-sections');
					const hasButton = !!(r as { _iframeWindow?: Window })._iframeWindow?.document?.querySelector?.('.pm-bilingual-toolbar-toggle');
					lines.push(`  - tab=${(r as { tabID?: string }).tabID ?? 'window'} type=${type} tabContainer=${hasContainer} customSections=${hasCustomSections} button=${hasButton}`);
				}
			}
			catch (e) {
				lines.push(`Reader inspection failed: ${e instanceof Error ? e.message : e}`);
			}
			lines.push(`Active bilingual sessions: ${toolbarController?.sessionCount() ?? 0}`);

			// --- configuration ---
			const providerId = getPref<string>('provider', 'bing-free');
			const provider = getProvider(providerId);
			const apiKey = await getApiKey(providerId);
			lines.push(`Provider: ${providerId} (${provider.displayName})`);
			lines.push(`  base URL: ${getPref<string>('apiBaseURL', '') || '(default) ' + (provider.displayBaseURL || provider.defaultBaseURL)}`);
			lines.push(`  model: ${getPref<string>('model', '') || '(default) ' + (provider.defaultModel || 'n/a')}`);
			lines.push(`  API key configured: ${apiKey.length > 0}${provider.requiresApiKey ? '' : ' (not required)'}`);
			lines.push(`  languages: ${getPref<string>('sourceLanguage', 'auto')} → ${getPref<string>('targetLanguage', 'auto')}`);
			lines.push(`Privacy notice accepted: ${!!getPref<boolean>('privacyNoticeAccepted', false)}`);
			const httpImpl = (globalThis as Record<string, any>).Zotero?.HTTP;
			lines.push(`HTTP transport: ${typeof httpImpl?.request === 'function' ? 'Zotero.HTTP' : 'XMLHttpRequest fallback'}`);

			// --- live engine round-trip (the decisive check) ---
			try {
				const started = Date.now();
				const result = await provider.validateConfiguration({
					providerId,
					apiBaseURL: getPref<string>('apiBaseURL', ''),
					apiKey,
					model: getPref<string>('model', ''),
					timeoutMs: 20000,
					allowInsecureHTTP: getPref<boolean>('allowHTTPEndpoint', false)
				} as ProviderSettings);
				lines.push(result.ok
					? `Engine self-test: OK (HTTP ${result.httpStatus ?? 200}, ${result.elapsedMs ?? Date.now() - started} ms)`
					: `Engine self-test: FAILED — ${result.message ?? 'unknown'}${result.httpStatus ? ' (HTTP ' + result.httpStatus + ')' : ''}`);
			}
			catch (e) {
				lines.push(`Engine self-test: THREW — ${e instanceof Error ? e.message : String(e)}`);
			}
			return lines.join('\n');
		},
		listProviders: () => listProviders().map(p => ({
			id: p.id,
			displayName: p.displayName,
			defaultBaseURL: p.defaultBaseURL,
			displayBaseURL: p.displayBaseURL ?? p.defaultBaseURL,
			defaultModel: p.defaultModel,
			requiresApiKey: p.requiresApiKey
		})),
		getApiKey,
		setApiKey,
		deleteApiKey,
		async testConnection(): Promise<ValidationResult> {
			const providerId = getPref<string>('provider', 'bing-free');
			const provider = getProvider(providerId);
			const settings: ProviderSettings & { allowInsecureHTTP?: boolean } = {
				providerId,
				apiBaseURL: getPref<string>('apiBaseURL', ''),
				apiKey: await getApiKey(providerId),
				model: getPref<string>('model', ''),
				timeoutMs: getPref<number>('timeoutMs', 60000),
				allowInsecureHTTP: getPref<boolean>('allowHTTPEndpoint', false)
			};
			return provider.validateConfiguration(settings);
		},
		cache: {
			totalSizeBytes: () => cacheManager.totalSizeBytes(),
			clearAll: () => cacheManager.clearAll()
		},
		glossary: {
			getLinesText(): string {
				return serializeGlossaryLines(parseGlossaryJSON(getPref<string>('glossaryGlobal', '[]')));
			},
			setFromLinesText(text: string): number {
				const rules = parseGlossaryLines(text);
				setPref('glossaryGlobal', serializeGlossary(rules));
				return rules.length;
			},
			exportJSON(): string {
				return getPref<string>('glossaryGlobal', '[]');
			},
			importJSON(json: string): number {
				const rules = parseGlossaryJSON(json);
				setPref('glossaryGlobal', serializeGlossary(rules));
				return rules.length;
			}
		}
	};
	(Zotero as unknown as Record<string, unknown>).PaperMirror = publicAPI;
	addDisposer(() => {
		delete (Zotero as unknown as Record<string, unknown>).PaperMirror;
	});

	logger.info(MODULE, `PaperMirror ${params.version} started`);
}
