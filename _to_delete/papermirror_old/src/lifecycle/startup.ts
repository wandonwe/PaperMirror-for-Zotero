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
		listProviders: () => listProviders().map(p => ({
			id: p.id,
			displayName: p.displayName,
			defaultBaseURL: p.defaultBaseURL,
			defaultModel: p.defaultModel,
			requiresApiKey: p.requiresApiKey
		})),
		getApiKey,
		setApiKey,
		deleteApiKey,
		async testConnection(): Promise<ValidationResult> {
			const providerId = getPref<string>('provider', 'anthropic');
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
