/**
 * Preferences pane script.
 *
 * TIMING (critical): Zotero's _loadPane() runs pane scripts with
 * Services.scriptloader.loadSubScript BEFORE the XHTML fragment is parsed and
 * appended to the document. Anything that touches the DOM at script-evaluation
 * time therefore sees nothing. We wait for our root element to appear before
 * initialising.
 *
 * BINDING: string and boolean prefs use Zotero's own `preference` attribute
 * (two-way binding handled by preferences.js). This script only covers what
 * cannot be declarative:
 *   - integer prefs (Zotero writes element values as strings, which would
 *     corrupt an int-typed pref)
 *   - the API key (system credential store, never a pref)
 *   - test connection / glossary / cache actions
 *   - provider-change auto-fill of Base URL placeholder + default model
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
	version?: string;
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

(function bootstrapPane(): void {
	const ROOT_ID = 'papermirror-prefs';
	const NS = 'bilingualReader.';
	const MAX_WAIT_MS = 15000;
	const POLL_MS = 60;

	let initialised = false;

	const findRoot = (): HTMLElement | null =>
		(typeof document !== 'undefined' ? document.getElementById(ROOT_ID) : null);

	const waitForRoot = (elapsed = 0): void => {
		if (initialised) {
			return;
		}
		const root = findRoot();
		if (root) {
			initialised = true;
			try {
				init(root);
			}
			catch (e) {
				Zotero.logError(e as Error);
			}
			return;
		}
		if (elapsed >= MAX_WAIT_MS) {
			Zotero.debug('[PaperMirror] preference pane root never appeared; skipping custom init');
			return;
		}
		setTimeout(() => waitForRoot(elapsed + POLL_MS), POLL_MS);
	};

	// The pane may also already be present if this script is re-run.
	waitForRoot();

	// ---- actual initialisation ---------------------------------------------

	function init(root: HTMLElement): void {
		const api = (): PaperMirrorPublicAPI | null =>
			((Zotero as unknown as Record<string, unknown>).PaperMirror as PaperMirrorPublicAPI) ?? null;

		const byId = <T extends Element = HTMLElement>(id: string): T | null =>
			(root.querySelector(`#${id}`) as T | null) ?? (document.getElementById(id) as T | null);

		const getPref = (key: string): unknown => Zotero.Prefs.get(NS + key);
		const setPref = (key: string, value: unknown): void => Zotero.Prefs.set(NS + key, value as never);

		// ---- integer prefs (declarative binding would store strings) --------



		// ---- provider defaults / endpoint hint ------------------------------

		const providerList = byId<HTMLElement & { value: string }>('papermirror-provider');

		// The preference-attribute binding can leave a menulist with no visible
		// selection (Fluent/binding timing). Force every dropdown onto its
		// stored value — or its default — so none renders blank.
		for (const [id, key, fallback] of [
			['papermirror-source-lang', 'sourceLanguage', 'auto'],
			['papermirror-target-lang', 'targetLanguage', 'auto'],
			['papermirror-provider', 'provider', 'bing-free'],
			['papermirror-default-mode', 'viewMode', 'split']
		] as const) {
			const list = byId<HTMLElement & { value: string }>(id);
			if (list && !list.value) {
				list.value = String(getPref(key) ?? fallback) || fallback;
			}
		}
		// The default-mode pref can hold 'original' (the toolbar's off state);
		// the picker only offers the two translated modes, so map it to split.
		{
			const modeList = byId<HTMLElement & { value: string }>('papermirror-default-mode');
			if (modeList && modeList.value !== 'overlay' && modeList.value !== 'split') {
				modeList.value = 'split';
			}
		}

		// Footer: the real installed version, not a hardcoded string that
		// went stale the day after it was written.
		{
			const note = byId<HTMLElement>('papermirror-version-note');
			const version = api()?.version;
			if (note && version) {
				note.textContent = `PaperMirror for Zotero ${version} — AGPL-3.0`;
			}
		}

		// 原文淡化 is a boolean checkbox over a string pref
		// (overlayDisplayMode: 'dim-original' | 'translation-only' | 'hover'),
		// so the preference attribute cannot bind it — wire it by hand.
		{
			const dimBox = byId<HTMLElement & { checked: boolean }>('papermirror-dim-original');
			if (dimBox) {
				dimBox.checked = String(getPref('overlayDisplayMode') ?? 'dim-original') === 'dim-original';
				dimBox.addEventListener('command', () => {
					setPref('overlayDisplayMode', dimBox.checked ? 'dim-original' : 'translation-only');
				});
			}
		}
		const baseUrlInput = byId<HTMLInputElement>('papermirror-baseurl');
		const modelInput = byId<HTMLInputElement>('papermirror-model');
		const endpointNote = byId<HTMLElement & { value: string }>('papermirror-endpoint-note');
		const apiKeyInput = byId<HTMLInputElement>('papermirror-apikey');


		const currentProviderId = (): string =>
			String(providerList?.value || getPref('provider') || 'bing-free');

		function currentProviderInfo(): ProviderInfo | null {
			const providers = api()?.listProviders() ?? [];
			const id = currentProviderId();
			return providers.find(p => p.id === id) ?? null;
		}

		/** True when the model field still holds a value we auto-filled. */
		function modelIsAutoFilled(value: string): boolean {
			const trimmed = value.trim();
			if (!trimmed) {
				return true;
			}
			return (api()?.listProviders() ?? []).some(p => p.defaultModel === trimmed);
		}

		/**
		 * Fill in everything the provider can supply so only the API key is
		 * required. The Base URL field is filled with the effective endpoint
		 * (e.g. https://api.openai.com/v1) when empty, and also shown as the
		 * placeholder. A model the user typed themselves is never overwritten.
		 */
		function applyProviderDefaults(providerChanged: boolean): void {
			const provider = currentProviderInfo();
			if (!provider) {
				return;
			}
			const effectiveBase = provider.displayBaseURL || provider.defaultBaseURL || '';
			if (baseUrlInput) {
				baseUrlInput.placeholder = effectiveBase || 'https://…';
				const knownBases = (api()?.listProviders() ?? [])
					.map(p => p.displayBaseURL || p.defaultBaseURL)
					.filter(Boolean);
				const isAutoFilled = !baseUrlInput.value.trim() || knownBases.includes(baseUrlInput.value.trim());
				if (effectiveBase && (providerChanged ? isAutoFilled : !baseUrlInput.value.trim())) {
					baseUrlInput.value = effectiveBase;
					setPref('apiBaseURL', effectiveBase);
				}
			}
			if (modelInput && provider.defaultModel) {
				const canReplace = providerChanged ? modelIsAutoFilled(modelInput.value) : !modelInput.value.trim();
				if (canReplace) {
					modelInput.value = provider.defaultModel;
					setPref('model', provider.defaultModel);
				}
			}
		}

		const updateEndpointNote = (): void => {
			const provider = currentProviderInfo();
			const base = String(
				(baseUrlInput?.value.trim() || '')
				|| provider?.displayBaseURL
				|| provider?.defaultBaseURL
				|| ''
			);
			if (endpointNote) {
				endpointNote.textContent = base ? `实际请求地址: ${base}` : '';
			}
		};

		providerList?.addEventListener('command', () => {
			// Zotero's declarative binding already stored the new provider.
			applyProviderDefaults(true);
			void loadApiKey();
			updateEndpointNote();
		});
		baseUrlInput?.addEventListener('change', updateEndpointNote);
		applyProviderDefaults(false);
		updateEndpointNote();

		// ---- API key (credential store, never a plain pref) -----------------

		async function loadApiKey(): Promise<void> {
			if (!apiKeyInput) {
				return;
			}
			try {
				apiKeyInput.value = (await api()?.getApiKey(currentProviderId())) ?? '';
			}
			catch {
				apiKeyInput.value = '';
			}
		}

		const commitApiKey = (): void => {
			if (apiKeyInput) {
				void api()?.setApiKey(currentProviderId(), apiKeyInput.value);
			}
		};
		apiKeyInput?.addEventListener('change', commitApiKey);
		apiKeyInput?.addEventListener('blur', commitApiKey);
		void loadApiKey();

		// ---- test connection -------------------------------------------------

		const testResult = byId<HTMLElement & { value: string }>('papermirror-test-result');
		let testing = false;
		const runTest = (): void => {
			if (testing || !testResult) {
				return;
			}
			testing = true;
			// Persist a key typed but not yet committed before testing.
			commitApiKey();
			testResult.value = '…';
			testResult.removeAttribute('data-state');
			void (async () => {
				try {
					const result = await api()?.testConnection();
					if (!result) {
						testResult.value = 'PaperMirror not running';
						testResult.setAttribute('data-state', 'fail');
						return;
					}
					if (result.ok) {
						testResult.value = `✓ HTTP ${result.httpStatus ?? 200} · ${result.elapsedMs ?? '?'} ms`;
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
		};
		const wire = (id: string, handler: () => void): void => {
			const el = byId(id);
			el?.addEventListener('command', handler);
			el?.addEventListener('click', handler);
		};
		wire('papermirror-test-connection', runTest);

		// ---- glossary --------------------------------------------------------

		const glossaryArea = byId<HTMLTextAreaElement>('papermirror-glossary');
		const glossaryStatus = byId<HTMLElement & { value: string }>('papermirror-glossary-status');
		if (glossaryArea) {
			glossaryArea.value = api()?.glossary.getLinesText() ?? '';
		}
		const guard = (fn: () => void) => (): void => {
			try {
				fn();
			}
			catch (e) {
				if (glossaryStatus) {
					glossaryStatus.value = '✗ ' + String((e as Error)?.message ?? e);
					glossaryStatus.setAttribute('data-state', 'fail');
				}
			}
		};
		wire('papermirror-glossary-save', guard(() => {
			const count = api()?.glossary.setFromLinesText(glossaryArea?.value ?? '') ?? 0;
			if (glossaryStatus) {
				glossaryStatus.value = `✓ ${count}`;
				glossaryStatus.setAttribute('data-state', 'ok');
			}
		}));
		wire('papermirror-glossary-export', guard(() => {
			const json = api()?.glossary.exportJSON() ?? '[]';
			Components.classes['@mozilla.org/widget/clipboardhelper;1']
				.getService(Components.interfaces.nsIClipboardHelper)
				.copyString(json);
			if (glossaryStatus) {
				glossaryStatus.value = '✓ JSON → clipboard';
				glossaryStatus.setAttribute('data-state', 'ok');
			}
		}));
		wire('papermirror-glossary-import', guard(() => {
			const win = document.defaultView as (Window & { prompt?: (msg: string) => string | null }) | null;
			const json = win?.prompt?.('Paste glossary JSON') ?? null;
			if (json) {
				const count = api()?.glossary.importJSON(json) ?? 0;
				if (glossaryArea) {
					glossaryArea.value = api()?.glossary.getLinesText() ?? '';
				}
				if (glossaryStatus) {
					glossaryStatus.value = `✓ ${count}`;
					glossaryStatus.setAttribute('data-state', 'ok');
				}
			}
		}));

		// ---- cache -----------------------------------------------------------

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

		Zotero.debug('[PaperMirror] preference pane initialised');
	}
})();
