/**
 * Plugin startup: initialize logging, localization, toolbar controller and
 * the preferences pane. Registers every disposer with the shutdown registry.
 */

import * as cacheManager from '../cache/cacheManager';
import { ReaderToolbarController } from '../reader/readerToolbar';
import { deleteApiKey, getApiKey, setApiKey } from '../security/credentialStore';
import { getProvider, listProviders } from '../translation/providers/registry';
import {
	parseProviderProfiles,
	serializeProviderProfiles,
	effectiveProviderConfig,
	migrateLegacyGlobals
} from '../translation/providerProfiles';
import { catalogModelsFor, recommendedModelFor, providerNeedsModel } from '../translation/providers/modelCatalog';
import { parseGlossaryJSON, parseGlossaryLines, serializeGlossary, serializeGlossaryLines } from '../translation/glossary';
import type { ProviderSettings, ValidationResult } from '../types/models';
import { getString, initL10n } from '../utils/l10n';
import { installAbortPolyfill } from '../utils/abortPolyfill';
import { setFontSource } from '../pdfgen/translatedPdfBuilder';
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

/**
 * One-time migration to the overlay-renderer architecture.
 *
 * prefs.js defaults only apply to preferences that were never written, so a
 * profile that used the plugin before a default changes never sees the new one.
 * The default is 左右对照: 原版 PDF 在左, 版面级重排的整页译文在右 — reading a
 * paper means checking the translation against the original, and a mode that
 * hides the original cannot do that. 覆盖模式 stays one click away in the
 * toolbar menu, and whatever the reader picks afterwards sticks.
 */
function migrateToOverlayArchitecture(): void {
	// v5 (runs for everyone below it): the Gemini preset's old default model
	// was retired upstream — a stored auto-filled 'gemini-2.0-flash' now only
	// produces 404s, so clear it and let the new default apply.
	if (getPref<string>('model', '') === 'gemini-2.0-flash') {
		setPref('model', '');
	}
	if (getPref<number>('layoutMigration', 0) >= 4) {
		return;
	}
	try {
		if (getPref<number>('layoutMigration', 0) < 3) {
			setPref('viewMode', 'split');
			setPref('paneView', 'page');
		}
		// v4: 悬停看原文 + 原文淡化 become the defaults.
		setPref('overlayPeekHover', true);
		setPref('overlayDisplayMode', 'dim-original');
		setPref('layoutMigration', 4);
		logger.info(MODULE, 'Migrated reading defaults to the overlay architecture');
	}
	catch (e) {
		logger.warn(MODULE, 'Layout migration failed (harmless)', e);
	}
}

/**
 * One-time migration to per-provider config profiles (0.9.3).
 *
 * Before 0.9.3 the Base URL and model were single GLOBAL prefs. On first run we
 * fold whatever is in them into the CURRENTLY-SELECTED provider's profile only —
 * never into any other provider (that global-sharing was the cross-provider
 * bleed this release removes). The legacy prefs are left untouched; the engine
 * simply stops reading them.
 */
function migrateProviderConfig(): void {
	try {
		if (getPref<boolean>('providerConfigMigrated', false)) {
			return;
		}
		const profiles = parseProviderProfiles(getPref<string>('providerProfiles', '{}'));
		const { profiles: next, changed } = migrateLegacyGlobals(profiles, {
			provider: getPref<string>('provider', 'bing-free'),
			apiBaseURL: getPref<string>('apiBaseURL', ''),
			model: getPref<string>('model', '')
		});
		if (changed) {
			setPref('providerProfiles', serializeProviderProfiles(next));
			logger.info(MODULE, 'Migrated legacy Base URL / model into the current provider profile');
		}
		setPref('providerConfigMigrated', true);
	}
	catch (e) {
		logger.warn(MODULE, 'Provider-config migration failed (harmless)', e);
	}
}

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

	// The in-plugin PDF builder embeds this bundled CJK font (subset).
	setFontSource(params.rootURI + 'content/fonts/NotoSansSC-PM.ttf');

	migrateToOverlayArchitecture();
	migrateProviderConfig();

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
			// Vector: the preferences list renders it at whatever size the
			// platform and display scale ask for.
			image: params.rootURI + 'content/icons/icon.svg'
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
		version: params.version,
		/** Toggle bilingual view on the current reader tab (manual entry). */
		toggle: () => toolbarController?.toggleCurrent() ?? Promise.resolve('Plugin not initialized.'),
		/** Overlay coordinate self-check (Run JavaScript): verifyOverlay() */
		verifyOverlay: () => toolbarController?.verifyOverlay() ?? 'Plugin not initialized.',
		/** Cycle 覆盖模式: 原文淡化 → 仅译文 → 悬停显示 */
		cycleOverlayMode: () => toolbarController?.cycleOverlayMode() ?? 'Plugin not initialized.',
		/** Set the toolbar switcher state: 'original' | 'overlay' | 'split' */
		setMode: (mode: 'original' | 'overlay' | 'split') =>
			toolbarController?.setModeOnCurrent(mode) ?? Promise.resolve('Plugin not initialized.'),
		/**
		 * Why does this PDF report "no text layer"? Reports what each of the
		 * three extraction paths returned for the current page:
		 *    return await Zotero.PaperMirror.diagnoseExtraction();
		 */
		diagnoseExtraction: () =>
			toolbarController?.diagnoseExtraction() ?? Promise.resolve('Plugin not initialized.'),
		/**
		 * The last warnings and errors, newest last. When anything misbehaves:
		 *     return Zotero.PaperMirror.lastErrors();
		 */
		lastErrors: (): string => {
			const lines = logger.recentProblems();
			return lines.length ? lines.join('\n') : 'No warnings or errors recorded this session.';
		},
		/**
		 * 生成译文PDF — no longer a button in the pane. Still available on
		 * demand: Zotero.PaperMirror.exportTranslatedPdf()
		 */
		exportTranslatedPdf: () => toolbarController?.exportCurrentPdf() ?? Promise.resolve('Plugin not initialized.'),
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
					const hasButton = !!(r as { _iframeWindow?: Window })._iframeWindow?.document?.querySelector?.('.pm-mode-switch');
					lines.push(`  - tab=${(r as { tabID?: string }).tabID ?? 'window'} type=${type} tabContainer=${hasContainer} customSections=${hasCustomSections} switcher=${hasButton}`);
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
			const profiles = parseProviderProfiles(getPref<string>('providerProfiles', '{}'));
			const cfg = effectiveProviderConfig(profiles, providerId);
			lines.push(`Provider: ${providerId} (${provider.displayName})`);
			lines.push(`  base URL: ${cfg.apiBaseURL || '(default) ' + (provider.displayBaseURL || provider.defaultBaseURL)}`);
			lines.push(`  model: ${cfg.model || '(default) ' + (provider.defaultModel || 'n/a')}`);
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
					apiBaseURL: cfg.apiBaseURL,
					apiKey,
					model: cfg.model,
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
			requiresApiKey: p.requiresApiKey,
			// 0.9.3 provider-config UI
			needsModel: providerNeedsModel(p.id),
			models: catalogModelsFor(p.id),
			recommendedModel: recommendedModelFor(p.id) || p.defaultModel
		})),
		getApiKey,
		setApiKey,
		deleteApiKey,
		/**
		 * The exact URL a request will hit for a given provider + Base URL
		 * override — used by the settings pane's "实际请求地址" preview so it can
		 * never drift from the transport. Empty override = provider default.
		 */
		describeEndpoint(providerId: string, apiBaseURL: string, apiPath?: string): string {
			try {
				const provider = getProvider(providerId);
				return provider.endpointFor?.({
					providerId,
					apiBaseURL: (apiBaseURL ?? '').trim(),
					apiKey: '',
					model: '',
					timeoutMs: 0,
					apiPath: (apiPath ?? '').trim() || undefined
				} as ProviderSettings) ?? '';
			}
			catch {
				return '';
			}
		},
		/**
		 * Test the connection using LIVE, possibly-unsaved settings from the
		 * pane. Overrides let the user hit "测试" before saving. The API key is
		 * always read from the secure store for the tested provider; it is never
		 * accepted here and never returned in the result.
		 */
		async testConnection(overrides?: { providerId?: string; apiBaseURL?: string; model?: string; apiPath?: string; reasoning?: string; maxOutputTokens?: number; temperature?: number }): Promise<ValidationResult> {
			const providerId = overrides?.providerId || getPref<string>('provider', 'bing-free');
			const provider = getProvider(providerId);
			const profiles = parseProviderProfiles(getPref<string>('providerProfiles', '{}'));
			const stored = effectiveProviderConfig(profiles, providerId);
			const profile = profiles[providerId] ?? {};
			const settings: ProviderSettings & { allowInsecureHTTP?: boolean } = {
				providerId,
				apiBaseURL: (overrides?.apiBaseURL ?? stored.apiBaseURL).trim(),
				apiKey: await getApiKey(providerId),
				model: (overrides?.model ?? stored.model).trim(),
				timeoutMs: getPref<number>('timeoutMs', 60000),
				allowInsecureHTTP: getPref<boolean>('allowHTTPEndpoint', false),
				apiPath: ((overrides?.apiPath ?? profile.apiPath) ?? '').trim() || undefined,
				reasoning: overrides?.reasoning ?? profile.reasoning,
				maxOutputTokens: overrides?.maxOutputTokens ?? profile.maxOutputTokens,
				temperature: overrides?.temperature ?? profile.temperature
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
