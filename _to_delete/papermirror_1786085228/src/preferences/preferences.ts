/**
 * Preferences pane script. Runs in the Zotero preferences window, which has
 * the `Zotero` global. Talks to the plugin core via Zotero.PaperMirror
 * (registered at startup). All values are synced manually — no reliance on
 * undocumented binding behavior.
 */

interface ProviderInfo {
	id: string;
	displayName: string;
	defaultBaseURL: string;
	displayBaseURL: string;
	defaultModel: string;
	requiresApiKey: boolean;
}

interface PaperMirrorPublicAPI {
	listProviders(): ProviderInfo[];
	getApiKey(providerId: string): Promise<string>;
	setApiKey(providerId: string, key: string): Promise<void>;
	testConnection(): Promise<{ ok: boolean; message?: string; httpStatus?: number; modelAvailable?: boolean; elapsedMs?: number }>;
	cache: { totalSizeBytes(): Promise<number>; clearAll(): Promise<void> };
	glossary: {
		getLinesText(): string;
		setFromLinesText(text: string): number;
		exportJSON(): string;
		importJSON(json: string): number;
	};
}

(function init(): void {
	const NS = 'bilingualReader.';
	const doc = document;

	const api = (): PaperMirrorPublicAPI | null =>
		((Zotero as unknown as Record<string, unknown>).PaperMirror as PaperMirrorPublicAPI) ?? null;

	const byId = <T extends Element = HTMLElement>(id: string): T | null =>
		doc.getElementById(id) as T | null;

	const getPref = (key: string): unknown => Zotero.Prefs.get(NS + key);
	const setPref = (key: string, value: unknown): void => Zotero.Prefs.set(NS + key, value as never);

	// ---- simple two-way binding helpers -------------------------------------

	// Sensible defaults so every field except the API key auto-fills itself.
	const DEFAULTS: Record<string, unknown> = {
		provider: 'bing-free',
		sourceLanguage: 'auto',
		targetLanguage: 'auto',
		timeoutMs: 60000,
		maxConcurrentRequests: 2
	};

	/** Read a pref, falling back to (and persisting) the default when empty. */
	function getPrefOrDefault(key: string): unknown {
		const value = getPref(key);
		if (value === undefined || value === null || value === '') {
			if (key in DEFAULTS) {
				setPref(key, DEFAULTS[key]);
				return DEFAULTS[key];
			}
		}
		return value;
	}

	function bindText(id: string, key: string, isNumber = false): void {
		const el = byId<HTMLInputElement>(id);
		if (!el) {
			return;
		}
		const value = getPrefOrDefault(key);
		el.value = value === undefined || value === null ? '' : String(value);
		el.addEventListener('change', () => {
			setPref(key, isNumber ? Number(el.value) || 0 : el.value);
		});
	}

	function bindCheckbox(id: string, key: string): void {
		const el = byId<HTMLInputElement & { checked: boolean }>(id);
		if (!el) {
			return;
		}
		el.checked = !!getPref(key);
		el.addEventListener('command', () => setPref(key, el.checked));
		el.addEventListener('change', () => setPref(key, el.checked));
	}

	function bindMenulist(id: string, key: string, onChange?: (value: string) => void): void {
		const el = byId<HTMLElement & { value: string; selectedIndex?: number; itemCount?: number; getItemAtIndex?: (i: number) => (Element & { value: string }) | null }>(id);
		if (!el) {
			return;
		}
		const value = String(getPrefOrDefault(key) ?? '');
		if (value) {
			el.value = value;
			// XUL menulist fallback: if .value didn't select anything, match by index.
			if ((el.selectedIndex ?? -1) < 0 && el.getItemAtIndex && el.itemCount) {
				for (let i = 0; i < el.itemCount; i++) {
					if (el.getItemAtIndex(i)?.value === value) {
						el.selectedIndex = i;
						break;
					}
				}
			}
		}
		el.addEventListener('command', () => {
			setPref(key, el.value);
			onChange?.(el.value);
		});
	}

	// ---- fields -------------------------------------------------------------

	bindText('papermirror-baseurl', 'apiBaseURL');
	bindText('papermirror-model', 'model');
	bindText('papermirror-timeout', 'timeoutMs', true);
	bindText('papermirror-concurrency', 'maxConcurrentRequests', true);
	bindText('papermirror-custom-prompt', 'customPrompt');
	bindCheckbox('papermirror-translate-captions', 'translateCaptions');
	bindCheckbox('papermirror-translate-references', 'translateReferences');
	bindCheckbox('papermirror-use-context', 'useContext');
	bindCheckbox('papermirror-auto-prefetch', 'autoPrefetch');
	bindCheckbox('papermirror-sync-scroll', 'syncScroll');
	bindCheckbox('papermirror-show-original', 'showOriginal');
	bindCheckbox('papermirror-debug-logging', 'debugLogging');
	bindCheckbox('papermirror-allow-http', 'allowHTTPEndpoint');
	bindCheckbox('papermirror-local-only', 'localOnlyMode');
	bindMenulist('papermirror-source-lang', 'sourceLanguage');
	bindMenulist('papermirror-target-lang', 'targetLanguage');

	// Article font size range (阅读界面 → 译文排版字号)
	{
		const range = byId<HTMLInputElement>('papermirror-font-size');
		const valueLabel = byId<HTMLElement & { value: string }>('papermirror-font-size-value');
		if (range) {
			const current = Number(getPref('articleFontSize')) || 16;
			range.value = String(current);
			if (valueLabel) {
				valueLabel.value = `${current} px`;
			}
			range.addEventListener('input', () => {
				if (valueLabel) {
					valueLabel.value = `${range.value} px`;
				}
			});
			range.addEventListener('change', () => {
				setPref('articleFontSize', Number(range.value) || 16);
			});
		}
	}

	const baseUrlInput = byId<HTMLInputElement>('papermirror-baseurl');
	const modelInput = byId<HTMLInputElement>('papermirror-model');
	const endpointNote = byId<HTMLElement & { value: string }>('papermirror-endpoint-note');

	function currentProviderInfo(): ProviderInfo | null {
		const providers = api()?.listProviders() ?? [];
		const id = String(getPref('provider') ?? 'bing-free');
		return providers.find(p => p.id === id) ?? null;
	}

	/** True when the model field still holds a value we auto-filled earlier. */
	function modelIsAutoFilled(value: string): boolean {
		const trimmed = value.trim();
		if (!trimmed) {
			return true;
		}
		return (api()?.listProviders() ?? []).some(p => p.defaultModel === trimmed);
	}

	/**
	 * Auto-fill everything the provider can supply, so only the API key is
	 * required: the Base URL placeholder shows the effective endpoint (blank
	 * field = use it automatically) and the model is filled with the
	 * provider's default — but a model the user typed themselves is never
	 * overwritten.
	 */
	function applyProviderDefaults(providerChanged = false): void {
		const provider = currentProviderInfo();
		if (!provider) {
			return;
		}
		if (baseUrlInput) {
			baseUrlInput.placeholder = provider.displayBaseURL || provider.defaultBaseURL || 'https://…';
		}
		if (!modelInput || !provider.defaultModel) {
			return;
		}
		const canReplace = providerChanged ? modelIsAutoFilled(modelInput.value) : !modelInput.value.trim();
		if (canReplace) {
			modelInput.value = provider.defaultModel;
			setPref('model', provider.defaultModel);
		}
	}

	const updateEndpointNote = (): void => {
		const provider = currentProviderInfo();
		const base = String(getPref('apiBaseURL') || provider?.displayBaseURL || provider?.defaultBaseURL || '');
		if (endpointNote) {
			endpointNote.value = base ? `→ ${base}` : '';
		}
	};

	bindMenulist('papermirror-provider', 'provider', () => {
		// Provider changed: refresh the auto-filled model/Base URL and API key.
		applyProviderDefaults(true);
		void loadApiKey();
		updateEndpointNote();
	});
	applyProviderDefaults();
	updateEndpointNote();
	baseUrlInput?.addEventListener('change', updateEndpointNote);

	// ---- API key (via credential store, never plain prefs when avoidable) ---

	const apiKeyInput = byId<HTMLInputElement>('papermirror-apikey');

	async function loadApiKey(): Promise<void> {
		if (!apiKeyInput) {
			return;
		}
		const providerId = String(getPref('provider') ?? 'bing-free');
		try {
			apiKeyInput.value = (await api()?.getApiKey(providerId)) ?? '';
		}
		catch {
			apiKeyInput.value = '';
		}
	}

	apiKeyInput?.addEventListener('change', () => {
		const providerId = String(getPref('provider') ?? 'bing-free');
		void api()?.setApiKey(providerId, apiKeyInput.value);
	});
	void loadApiKey();

	// ---- test connection ----------------------------------------------------

	const testButton = byId('papermirror-test-connection');
	const testResult = byId<HTMLElement & { value: string }>('papermirror-test-result');
	testButton?.addEventListener('command', run);
	testButton?.addEventListener('click', run);
	let testing = false;
	function run(): void {
		if (testing || !testResult) {
			return;
		}
		testing = true;
		testResult.value = '…';
		void (async () => {
			try {
				const result = await api()?.testConnection();
				if (!result) {
					testResult.value = 'plugin not running';
					return;
				}
				if (result.ok) {
					testResult.value = `✓ HTTP ${result.httpStatus ?? 200} · model ok · ${result.elapsedMs ?? '?'} ms`;
					testResult.setAttribute('data-state', 'ok');
				}
				else {
					testResult.value = `✗ ${result.message ?? 'failed'}${result.httpStatus ? ' · HTTP ' + result.httpStatus : ''}`;
					testResult.setAttribute('data-state', 'fail');
				}
			}
			catch (e) {
				testResult.value = '✗ ' + String((e as Error)?.message ?? e);
				testResult.setAttribute('data-state', 'fail');
			}
			finally {
				testing = false;
			}
		})();
	}

	// ---- glossary -----------------------------------------------------------

	const glossaryArea = byId<HTMLTextAreaElement>('papermirror-glossary');
	const glossaryStatus = byId<HTMLElement & { value: string }>('papermirror-glossary-status');
	if (glossaryArea) {
		glossaryArea.value = api()?.glossary.getLinesText() ?? '';
	}
	const onGlossary = (fn: () => void) => (): void => {
		try {
			fn();
		}
		catch (e) {
			if (glossaryStatus) {
				glossaryStatus.value = '✗ ' + String((e as Error)?.message ?? e);
			}
		}
	};
	const wire = (id: string, fn: () => void): void => {
		const el = byId(id);
		el?.addEventListener('command', onGlossary(fn));
		el?.addEventListener('click', onGlossary(fn));
	};
	wire('papermirror-glossary-save', () => {
		const count = api()?.glossary.setFromLinesText(glossaryArea?.value ?? '') ?? 0;
		if (glossaryStatus) {
			glossaryStatus.value = `✓ ${count}`;
		}
	});
	wire('papermirror-glossary-export', () => {
		const json = api()?.glossary.exportJSON() ?? '[]';
		const helper = Components.classes['@mozilla.org/widget/clipboardhelper;1']
			.getService(Components.interfaces.nsIClipboardHelper);
		helper.copyString(json);
		if (glossaryStatus) {
			glossaryStatus.value = '✓ JSON → clipboard';
		}
	});
	wire('papermirror-glossary-import', () => {
		const win = doc.defaultView as (Window & { prompt?: (msg: string) => string | null }) | null;
		const json = win?.prompt?.('Paste glossary JSON') ?? null;
		if (json) {
			const count = api()?.glossary.importJSON(json) ?? 0;
			if (glossaryArea) {
				glossaryArea.value = api()?.glossary.getLinesText() ?? '';
			}
			if (glossaryStatus) {
				glossaryStatus.value = `✓ ${count}`;
			}
		}
	});

	// ---- cache --------------------------------------------------------------

	const cacheSize = byId<HTMLElement & { value: string }>('papermirror-cache-size');
	async function refreshCacheSize(): Promise<void> {
		if (!cacheSize) {
			return;
		}
		try {
			const bytes = (await api()?.cache.totalSizeBytes()) ?? 0;
			cacheSize.value = bytes > 1048576
				? (bytes / 1048576).toFixed(1) + ' MB'
				: (bytes / 1024).toFixed(1) + ' KB';
		}
		catch {
			cacheSize.value = '?';
		}
	}
	wire('papermirror-cache-refresh', () => void refreshCacheSize());
	wire('papermirror-cache-clear', () => {
		void (async () => {
			await api()?.cache.clearAll();
			await refreshCacheSize();
		})();
	});
	void refreshCacheSize();
})();
