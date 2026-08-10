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

import {
	normalizePerfMode,
	normalizeGlobalMax,
	poolLanePlan,
	customLaneRange,
	customBandFor,
	type ProviderCapability
} from '../translation/providerPool';
import {
	parseProviderProfiles,
	serializeProviderProfiles,
	type ProviderProfiles,
	type ProviderProfile
} from '../translation/providerProfiles';
import {
	catalogModelsFor,
	recommendedModelFor,
	providerNeedsModel,
	catalogHasModel,
	catalogProvenance,
	MODEL_GROUP_ORDER,
	type CatalogModel
} from '../translation/providers/modelCatalog';
import { supportsReasoningControl } from '../translation/providers/advancedParams';

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
	describeEndpoint(providerId: string, apiBaseURL: string, apiPath?: string): string;
	testConnection(overrides?: { providerId?: string; apiBaseURL?: string; model?: string; apiPath?: string; reasoning?: string; maxOutputTokens?: number; temperature?: number }): Promise<{ ok: boolean; message?: string; httpStatus?: number; modelAvailable?: boolean; elapsedMs?: number }>;
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

		// ---- 性能与并行 -----------------------------------------------------
		{
			const MODE_DESC: Record<string, string> = {
				stable: '降低并发和预取范围,减少限流、超时及额度消耗。',
				auto: '根据响应速度和限流情况,自动调整每个服务商的并发。',
				high: '提高并发和预取范围,适合额度充足的多个服务商。',
				custom: '分别设置每个已启用服务商的最大并行页面数。'
			};
			const readChecked = (): string[] => {
				try {
					const raw = JSON.parse(String(getPref('parallelProviders') ?? '[]'));
					return Array.isArray(raw) ? raw.filter((x: unknown): x is string => typeof x === 'string') : [];
				}
				catch { return []; }
			};
			const readCustom = (): Record<string, number> => {
				try {
					const raw = JSON.parse(String(getPref('providerConcurrency') ?? '{}'));
					const out: Record<string, number> = {};
					if (raw && typeof raw === 'object') {
						for (const [k, v] of Object.entries(raw)) {
							if (typeof v === 'number' && Number.isFinite(v)) {
								out[k] = v;
							}
						}
					}
					return out;
				}
				catch { return {}; }
			};
			const writeCustom = (map: Record<string, number>): void => setPref('providerConcurrency', JSON.stringify(map));
			const capOf = (id: string): ProviderCapability => {
				const p = (api()?.listProviders() ?? []).find(pv => pv.id === id);
				const local = id === 'ollama' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(p?.defaultBaseURL || '');
				return { id, requiresApiKey: p?.requiresApiKey ?? false, local };
			};
			const enabledIds = (): string[] => {
				const primary = String(byId<HTMLElement & { value: string }>('papermirror-provider')?.value || getPref('provider') || 'bing-free');
				return [primary, ...readChecked().filter(id => id !== primary)];
			};
			const nameOf = (id: string): string => (api()?.listProviders() ?? []).find(pv => pv.id === id)?.displayName ?? id;

			const descEl = byId<HTMLElement & { value: string }>('papermirror-perfmode-desc');
			const previewHead = byId<HTMLElement>('papermirror-perf-preview');
			const chipsEl = byId<HTMLElement>('papermirror-perf-chips');
			const whyEl = byId<HTMLElement>('papermirror-perf-why');
			const customHost = byId<HTMLElement>('papermirror-custom-rows');

			const updateSummary = (): void => {
				const mode = normalizePerfMode(getPref('perfMode'));
				if (descEl) {
					descEl.value = MODE_DESC[mode] ?? '';
				}
				const globalMax = normalizeGlobalMax(getPref('maxConcurrentRequests'));
				const ids = enabledIds();
				const caps = ids.map(capOf);
				const plan = poolLanePlan(caps, mode, mode === 'custom' ? readCustom() : undefined);
				const parallel = Math.min(globalMax, plan.initialSum);
				if (previewHead) {
					previewHead.textContent = `预计并行 ${parallel} 页 · 当前页优先${mode === 'auto' ? ' · 自动调节中' : ''}`;
				}
				if (chipsEl) {
					const chips = ids.map((id) => {
						const chip = document.createElement('span');
						chip.className = 'pm-perf-chip';
						chip.textContent = `${nameOf(id)} ${plan.laneBands[id]?.initial ?? 1}`;
						if (customLaneRange(capOf(id)).locked) {
							chip.setAttribute('data-pm-locked', 'true');
						}
						return chip;
					});
					chipsEl.replaceChildren(...chips);
				}
				if (whyEl) {
					whyEl.textContent = `全局上限 ${globalMax},服务商能力合计 ${plan.initialSum},因此实际并行上限为 ${parallel} 页。`;
				}
			};

			const renderCustomRows = (): void => {
				if (!customHost) {
					return;
				}
				const mode = normalizePerfMode(getPref('perfMode'));
				customHost.style.display = mode === 'custom' ? 'flex' : 'none';
				if (mode !== 'custom') {
					customHost.replaceChildren();
					return;
				}
				const custom = readCustom();
				const rows: HTMLElement[] = [];
				const heading = document.createElement('div');
				heading.className = 'pm-desc';
				heading.textContent = '单服务商最大并行页面数';
				rows.push(heading);
				for (const id of enabledIds()) {
					const cap = capOf(id);
					const range = customLaneRange(cap);
					const row = document.createElement('div');
					row.className = 'pm-custom-row';
					const label = document.createElement('span');
					label.textContent = nameOf(id) + (range.locked ? '(锁定)' : '');
					const input = document.createElement('input');
					input.type = 'number';
					input.min = String(range.min);
					input.max = String(range.max);
					input.value = String(customBandFor(cap, custom[id]).initial);
					input.disabled = range.locked;
					input.addEventListener('change', () => {
						const v = Math.max(range.min, Math.min(range.max, Math.round(Number(input.value) || range.default)));
						input.value = String(v);
						const map = readCustom();
						map[id] = v;
						writeCustom(map);
						updateSummary();
					});
					row.append(label, input);
					rows.push(row);
				}
				const restore = document.createElement('button');
				restore.textContent = '恢复默认';
				restore.addEventListener('click', () => {
					writeCustom({});
					renderCustomRows();
					updateSummary();
				});
				rows.push(restore);
				customHost.replaceChildren(...rows);
			};

			const modeGroup = byId<HTMLElement & { value: string }>('papermirror-perfmode');
			if (modeGroup) {
				modeGroup.value = normalizePerfMode(getPref('perfMode'));
				modeGroup.addEventListener('command', () => {
					setPref('perfMode', normalizePerfMode(modeGroup.value));
					renderCustomRows();
					updateSummary();
				});
			}

			const concurrencyInput = byId<HTMLInputElement>('papermirror-concurrency');
			if (concurrencyInput) {
				// Plain global ceiling: 1–24, default 12 (migrate 0/legacy → 12).
				const migrated = normalizeGlobalMax(getPref('maxConcurrentRequests'));
				setPref('maxConcurrentRequests', migrated);
				concurrencyInput.value = String(migrated);
				concurrencyInput.addEventListener('change', () => {
					const next = normalizeGlobalMax(Number(concurrencyInput.value));
					concurrencyInput.value = String(next);
					setPref('maxConcurrentRequests', next);
					updateSummary();
				});
			}

			const poolHost = byId<HTMLElement>('papermirror-pool');
			const renderPool = async (): Promise<void> => {
				if (!poolHost) {
					return;
				}
				const checked = readChecked();
				const providers = api()?.listProviders() ?? [];
				const primary = String(byId<HTMLElement & { value: string }>('papermirror-provider')?.value || getPref('provider') || 'bing-free');
				const rows: HTMLElement[] = [];
				for (const provider of providers) {
					if (provider.id === primary || provider.id === 'custom') {
						continue;
					}
					let usable = !provider.requiresApiKey;
					if (!usable) {
						try {
							usable = ((await api()?.getApiKey(provider.id)) ?? '').length > 0;
						}
						catch {
							usable = false;
						}
					}
					const row = document.createElement('label');
					row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:1px 0;';
					const box = document.createElement('input');
					box.type = 'checkbox';
					box.checked = checked.includes(provider.id);
					box.disabled = !usable;
					box.addEventListener('change', () => {
						const set = new Set(readChecked());
						if (box.checked) {
							set.add(provider.id);
						}
						else {
							set.delete(provider.id);
						}
						setPref('parallelProviders', JSON.stringify([...set]));
						renderCustomRows();
						updateSummary();
					});
					const text = document.createElement('span');
					text.textContent = usable ? provider.displayName : `${provider.displayName}(未配置密钥)`;
					if (!usable) {
						text.style.opacity = '.5';
					}
					row.append(box, text);
					rows.push(row);
				}
				poolHost.replaceChildren(...rows);
				renderCustomRows();
				updateSummary();
			};
			void renderPool();
			renderCustomRows();
			updateSummary();
			byId<HTMLElement>('papermirror-provider')?.addEventListener('command', () => {
				void renderPool();
			});
			byId<HTMLInputElement>('papermirror-apikey')?.addEventListener('change', () => {
				setTimeout(() => void renderPool(), 400);
			});
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
		// ---- per-provider model / Base URL profiles (0.9.3) -----------------
		//
		// Each provider keeps its OWN Base URL and model in the providerProfiles
		// pref, so switching provider never carries one provider's model into
		// another (the cross-provider bleed this release removes). The engine
		// reads the same pref; this pane is the editor.

		const CUSTOM_SENTINEL = '__pm_custom__';

		const baseUrlInput = byId<HTMLInputElement>('papermirror-baseurl');
		const modelSelect = byId<HTMLElement & { value: string }>('papermirror-model-select');
		const modelCustomRow = byId<HTMLElement>('papermirror-model-custom-row');
		const modelCustomInput = byId<HTMLInputElement>('papermirror-model-custom');
		const modelNote = byId<HTMLElement>('papermirror-model-note');
		const baseDefaultNote = byId<HTMLElement>('papermirror-baseurl-default');
		const baseCustomNote = byId<HTMLElement>('papermirror-baseurl-custom-note');
		const endpointNote = byId<HTMLElement>('papermirror-endpoint-note');
		const apiKeyInput = byId<HTMLInputElement>('papermirror-apikey');
		// Advanced params (opt-in, per-provider).
		const advancedSection = byId<HTMLElement>('papermirror-advanced-section');
		const reasoningRow = byId<HTMLElement>('papermirror-reasoning-row');
		const reasoningSelect = byId<HTMLElement & { value: string }>('papermirror-reasoning');
		const thinkingRow = byId<HTMLElement>('papermirror-thinking-row');
		const thinkingSelect = byId<HTMLElement & { value: string }>('papermirror-thinking');
		const reasoningNote = byId<HTMLElement>('papermirror-reasoning-note');
		const apiPathInput = byId<HTMLInputElement>('papermirror-apipath');
		const maxTokensSelect = byId<HTMLElement & { value: string }>('papermirror-maxtokens');
		const temperatureInput = byId<HTMLInputElement>('papermirror-temperature');

		const currentProviderId = (): string =>
			String(providerList?.value || getPref('provider') || 'bing-free');

		function currentProviderInfo(): ProviderInfo | null {
			const providers = api()?.listProviders() ?? [];
			const id = currentProviderId();
			return providers.find(p => p.id === id) ?? null;
		}

		const readProfiles = (): ProviderProfiles =>
			parseProviderProfiles(String(getPref('providerProfiles') ?? '{}'));

		const currentProfile = (): ProviderProfile => readProfiles()[currentProviderId()] ?? {};

		/** Merge a patch into the current provider's profile; empties are pruned. */
		const patchProfile = (patch: ProviderProfile): void => {
			const id = currentProviderId();
			const profiles = readProfiles();
			const next: ProviderProfile = { ...(profiles[id] ?? {}), ...patch };
			if ((next.apiBaseUrl ?? '').trim() === '') {
				delete next.apiBaseUrl;
			}
			if ((next.model ?? '').trim() === '') {
				delete next.model;
			}
			if ((next.customModel ?? '').trim() === '') {
				delete next.customModel;
			}
			if ((next.apiPath ?? '').trim() === '') {
				delete next.apiPath;
			}
			if (!next.reasoning) {
				delete next.reasoning;
			}
			if (!(typeof next.maxOutputTokens === 'number' && next.maxOutputTokens > 0)) {
				delete next.maxOutputTokens;
			}
			if (typeof next.temperature !== 'number' || !Number.isFinite(next.temperature)) {
				delete next.temperature;
			}
			profiles[id] = next;
			setPref('providerProfiles', serializeProviderProfiles(profiles));
		};

		/** The model the UI currently represents (custom input wins in custom mode). */
		const selectedModel = (): string => {
			const id = currentProviderId();
			if (!providerNeedsModel(id)) {
				return '';
			}
			if (modelSelect?.value === CUSTOM_SENTINEL) {
				return (modelCustomInput?.value ?? '').trim();
			}
			return String(modelSelect?.value ?? '').trim();
		};

		const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
		const doc = (): Document => (modelSelect?.ownerDocument ?? document);
		const makeXUL = (tag: string): Element => {
			const d = doc() as Document & { createXULElement?: (t: string) => Element };
			return d.createXULElement ? d.createXULElement(tag) : d.createElementNS(XUL_NS, tag);
		};
		const makeMenuItem = (value: string, label: string): Element => {
			const item = makeXUL('menuitem');
			item.setAttribute('value', value);
			item.setAttribute('label', label);
			return item;
		};
		const makeSeparator = (): Element => makeXUL('menuseparator');

		/** Build the model dropdown for a provider + select the stored value. */
		function populateModelSelector(): void {
			const id = currentProviderId();
			const needs = providerNeedsModel(id);
			if (modelSelect) {
				(modelSelect as unknown as HTMLElement).style.display = needs ? '' : 'none';
			}
			const byIdRow = byId<HTMLElement>('papermirror-model-row');
			if (byIdRow) {
				byIdRow.style.display = needs ? '' : 'none';
			}
			if (!needs) {
				if (modelCustomRow) {
					modelCustomRow.style.display = 'none';
				}
				if (modelNote) {
					modelNote.textContent = '该服务商无需选择模型。';
				}
				return;
			}
			const profile = currentProfile();
			const stored = (profile.model ?? '').trim();
			const catalog: CatalogModel[] = catalogModelsFor(id);
			// Rebuild the menupopup.
			const popup = modelSelect?.querySelector('menupopup');
			if (popup && modelSelect) {
				popup.replaceChildren();
				// FLAT list (no category headers), ordered 推荐 → 高质量 → 快速 →
				// 预览 → 旧版, then a separator and 自定义模型….
				for (const group of MODEL_GROUP_ORDER) {
					for (const m of catalog.filter(x => x.group === group)) {
						popup.appendChild(makeMenuItem(m.id, m.label || m.id));
					}
				}
				// A saved model that is NOT in the catalog is never dropped — show
				// it as-is so it stays selectable.
				if (stored && !catalogHasModel(id, stored)) {
					popup.appendChild(makeMenuItem(stored, stored));
				}
				if (catalog.length) {
					popup.appendChild(makeSeparator());
				}
				popup.appendChild(makeMenuItem(CUSTOM_SENTINEL, '自定义模型…'));

				// Decide the selection.
				if (!stored) {
					modelSelect.value = catalog.length
						? (recommendedModelFor(id) || catalog[0]!.id)
						: CUSTOM_SENTINEL;
				}
				else {
					// Both catalog hits and saved custom models use the exact id;
					// the custom one was just appended above so it selects fine.
					modelSelect.value = stored;
				}
			}
			// Custom input row visibility + value.
			const showCustom = modelSelect?.value === CUSTOM_SENTINEL;
			if (modelCustomRow) {
				modelCustomRow.style.display = showCustom ? '' : 'none';
			}
			if (modelCustomInput) {
				modelCustomInput.value = (profile.customModel ?? (showCustom ? stored : '')) || '';
			}
			// Provenance note.
			if (modelNote) {
				const prov = catalogProvenance(id);
				modelNote.textContent = prov
					? `留空即用推荐模型。模型清单核对于 ${prov.checked},以各服务商官方文档为准。`
					: '请输入该服务商的模型名称。';
			}
		}

		const updateBaseUrlNotes = (): void => {
			const provider = currentProviderInfo();
			const def = provider?.displayBaseURL || provider?.defaultBaseURL || '';
			if (baseUrlInput) {
				baseUrlInput.placeholder = def ? `留空使用官方地址 ${def}` : 'https://…';
			}
			if (baseDefaultNote) {
				baseDefaultNote.textContent = def ? `默认地址: ${def}` : '';
			}
			const typed = (baseUrlInput?.value ?? '').trim();
			if (baseCustomNote) {
				baseCustomNote.textContent = typed && typed !== def ? '· 当前使用自定义地址' : '';
			}
			if (endpointNote) {
				const url = api()?.describeEndpoint(currentProviderId(), typed, (apiPathInput?.value ?? '').trim()) ?? '';
				endpointNote.textContent = url ? `实际请求地址: ${url}` : '';
			}
		};

		/** Load the advanced-params block for the current provider. */
		const loadAdvanced = (): void => {
			const id = currentProviderId();
			const needs = providerNeedsModel(id); // non-LLM engines take no advanced params
			if (advancedSection) {
				advancedSection.style.display = needs ? '' : 'none';
			}
			if (!needs) {
				return;
			}
			const profile = currentProfile();
			{
				const supported = supportsReasoningControl(id);
				const isGemini = id === 'gemini';
				// Gemini gets its own 深度思考 switch; GPT-style providers get the
				// effort ladder. Only one row is visible at a time.
				if (reasoningRow) {
					reasoningRow.style.display = isGemini ? 'none' : '';
				}
				if (thinkingRow) {
					thinkingRow.style.display = isGemini ? '' : 'none';
				}
				if (isGemini && thinkingSelect) {
					const r = profile.reasoning ?? '';
					thinkingSelect.value = r === 'disabled' || r === 'minimal' ? 'disabled' : r === 'auto' ? 'auto' : '';
					if (reasoningNote) {
						reasoningNote.textContent = '仅部分模型支持通过此设置控制深度思考能力的启用状态,主要用于同时支持思考模式和非思考模式的模型。翻译建议「禁用思考」(更快更省)。';
					}
				}
				else if (reasoningSelect) {
					reasoningSelect.value = profile.reasoning === 'disabled' || profile.reasoning === 'auto' ? '' : (profile.reasoning ?? '');
					(reasoningSelect as unknown as HTMLElement & { disabled?: boolean }).disabled = !supported;
					if (reasoningNote) {
						reasoningNote.textContent = supported
							? '控制模型的推理深度,仅部分模型支持。翻译建议 minimal(更快更省);默认设置即用服务商默认。'
							: '该服务商暂不支持推理强度调节(留默认设置即可)。';
					}
				}
			}
			if (apiPathInput) {
				apiPathInput.value = profile.apiPath ?? '';
			}
			if (maxTokensSelect) {
				maxTokensSelect.value = profile.maxOutputTokens ? String(profile.maxOutputTokens) : '';
			}
			if (temperatureInput) {
				// 温度默认 0(翻译更稳定);显式存过则回显存储值。
				temperatureInput.value = typeof profile.temperature === 'number' ? String(profile.temperature) : '0';
			}
		};

		/** Load the whole model+address+advanced block for the current provider. */
		const loadProviderConfig = (): void => {
			const profile = currentProfile();
			if (baseUrlInput) {
				baseUrlInput.value = profile.apiBaseUrl ?? '';
			}
			populateModelSelector();
			loadAdvanced();
			updateBaseUrlNotes();
		};

		// ---- advanced-param change handlers (all opt-in; empty = unset) ------
		reasoningSelect?.addEventListener('command', () => {
			patchProfile({ reasoning: (reasoningSelect.value || undefined) as ProviderProfile['reasoning'] });
		});
		thinkingSelect?.addEventListener('command', () => {
			patchProfile({ reasoning: (thinkingSelect.value || undefined) as ProviderProfile['reasoning'] });
		});
		/** The active reasoning/thinking value for the current provider's UI. */
		const currentReasoning = (): string =>
			currentProviderId() === 'gemini' ? (thinkingSelect?.value ?? '') : (reasoningSelect?.value ?? '');
		apiPathInput?.addEventListener('change', () => {
			patchProfile({ apiPath: (apiPathInput.value ?? '').trim() });
			updateBaseUrlNotes();
		});
		apiPathInput?.addEventListener('input', updateBaseUrlNotes);
		maxTokensSelect?.addEventListener('command', () => {
			const n = Math.floor(Number(maxTokensSelect.value));
			patchProfile({ maxOutputTokens: Number.isFinite(n) && n > 0 ? n : undefined });
		});
		const commitTemperature = (): void => {
			const raw = (temperatureInput?.value ?? '').trim();
			const n = Number(raw);
			patchProfile({ temperature: raw !== '' && Number.isFinite(n) ? n : undefined });
		};
		temperatureInput?.addEventListener('change', commitTemperature);

		modelSelect?.addEventListener('command', () => {
			if (modelSelect.value === CUSTOM_SENTINEL) {
				if (modelCustomRow) {
					modelCustomRow.style.display = '';
				}
				// Prefer a remembered custom model; fall back to whatever model is
				// currently stored (e.g. a migrated custom id) so switching to the
				// custom row never silently drops it.
				const prof = currentProfile();
				const cm = (prof.customModel ?? '').trim() || (prof.model ?? '').trim();
				if (modelCustomInput && !modelCustomInput.value) {
					modelCustomInput.value = cm;
				}
				const v = (modelCustomInput?.value ?? '').trim();
				patchProfile({ model: v, customModel: v });
			}
			else {
				if (modelCustomRow) {
					modelCustomRow.style.display = 'none';
				}
				// A recommended/catalog pick — keep any remembered custom model.
				patchProfile({ model: String(modelSelect.value ?? '').trim() });
			}
			updateBaseUrlNotes();
		});
		modelCustomInput?.addEventListener('change', () => {
			const v = (modelCustomInput.value ?? '').trim();
			patchProfile({ model: v, customModel: v });
		});
		modelCustomInput?.addEventListener('blur', () => {
			const v = (modelCustomInput.value ?? '').trim();
			patchProfile({ model: v, customModel: v });
		});

		baseUrlInput?.addEventListener('change', () => {
			patchProfile({ apiBaseUrl: (baseUrlInput.value ?? '').trim() });
			updateBaseUrlNotes();
		});
		baseUrlInput?.addEventListener('input', updateBaseUrlNotes);
		byId('papermirror-baseurl-restore')?.addEventListener('command', () => {
			if (baseUrlInput) {
				baseUrlInput.value = '';
			}
			patchProfile({ apiBaseUrl: '' });
			updateBaseUrlNotes();
		});
		byId('papermirror-baseurl-restore')?.addEventListener('click', () => {
			if (baseUrlInput) {
				baseUrlInput.value = '';
			}
			patchProfile({ apiBaseUrl: '' });
			updateBaseUrlNotes();
		});

		providerList?.addEventListener('command', () => {
			// Zotero's declarative binding already stored the new provider.
			loadProviderConfig();
			void loadApiKey();
		});
		loadProviderConfig();

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

		// ---- test connection (live, unsaved values; never prints the key) ----

		const testResult = byId<HTMLElement & { value: string }>('papermirror-test-result');
		const TEST_MESSAGES: Record<string, string> = {
			NO_API_KEY: '未填写 API Key',
			INVALID_API_KEY: 'API Key 无效或无权限',
			INVALID_MODEL: '模型不存在、当前账户不可用(如免费档限制),或地址路径不正确',
			RATE_LIMITED: '触发限流,请稍后再试',
			QUOTA_EXCEEDED: '额度或余额不足',
			TIMEOUT: '请求超时,请检查网络或稍后再试',
			NETWORK: '网络错误或服务器错误',
			HTTP_INSECURE: '接口不是 HTTPS(可在高级设置中允许)',
			BAD_RESPONSE: '返回内容异常,地址或路径可能不正确',
			UNKNOWN: '未知错误'
		};
		let testing = false;
		const runTest = (): void => {
			if (testing || !testResult) {
				return;
			}
			testing = true;
			// Persist a key + config typed but not yet committed before testing.
			commitApiKey();
			if (baseUrlInput) {
				patchProfile({ apiBaseUrl: (baseUrlInput.value ?? '').trim() });
			}
			testResult.value = '…';
			testResult.removeAttribute('data-state');
			void (async () => {
				try {
					const maxTok = Math.floor(Number(maxTokensSelect?.value));
					const tempRaw = (temperatureInput?.value ?? '').trim();
					const tempNum = Number(tempRaw);
					const result = await api()?.testConnection({
						providerId: currentProviderId(),
						apiBaseURL: (baseUrlInput?.value ?? '').trim(),
						model: selectedModel(),
						apiPath: (apiPathInput?.value ?? '').trim() || undefined,
						reasoning: currentReasoning() || undefined,
						maxOutputTokens: Number.isFinite(maxTok) && maxTok > 0 ? maxTok : undefined,
						temperature: tempRaw !== '' && Number.isFinite(tempNum) ? tempNum : undefined
					});
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
						// Differentiated, friendly Chinese message. NEVER the key.
						const code = result.message ?? 'UNKNOWN';
						const friendly = TEST_MESSAGES[code] ?? `失败: ${code}`;
						testResult.value = `✗ ${friendly}${result.httpStatus ? ' · HTTP ' + result.httpStatus : ''}`;
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
