/**
 * Fluent localization helper with hard fallbacks. Plugin FTL files in
 * locale/<locale>/papermirror.ftl are auto-registered by Zotero's plugin
 * loader; we read them through a sync Localization instance.
 */

declare const Localization: new (resourceIds: string[], sync?: boolean) => {
	formatValueSync(id: string, args?: Record<string, unknown>): string | null;
};

let l10n: InstanceType<typeof Localization> | null = null;

const FALLBACKS: Record<string, string> = {
	'papermirror-toolbar-toggle': '中英对照 / Bilingual',
	'papermirror-pane-direction': 'Direction',
	'papermirror-status-idle': 'Ready',
	'papermirror-status-translating': 'Translating…',
	'papermirror-status-done': 'Done',
	'papermirror-status-cached': 'Loaded from cache',
	'papermirror-status-error': 'Error',
	'papermirror-no-text-layer': 'This PDF has no text layer and needs OCR. 该 PDF 需要 OCR。',
	'papermirror-page': 'Page',
	'papermirror-sync-on': '🔗 Sync',
	'papermirror-sync-off': '⛓ Sync off',
	'papermirror-retranslate': 'Re-translate',
	'papermirror-cancel': 'Cancel',
	'papermirror-copy': 'Copy',
	'papermirror-copy-both': 'Copy orig.+trans.',
	'papermirror-save-note': 'Save to note',
	'papermirror-settings': 'Settings',
	'papermirror-close': 'Close',
	'papermirror-swap-sides': 'Swap sides',
	'papermirror-pending': '…',
	'papermirror-privacy-notice': 'Translation sends the selected paper text to the third-party service you configured. Make sure you are allowed to process this document and that you understand the provider\'s data retention policy. 翻译功能会将所选论文文本发送至您配置的第三方翻译服务。请确认您有权处理相关文献,并了解服务商的数据保留政策。',
	'papermirror-privacy-accept': 'I understand, continue / 我已了解,继续',
	'papermirror-error-no-api-key': 'No API key configured. Open PaperMirror settings to add one.',
	'papermirror-error-invalid-api-key': 'The API key was rejected. Check it in PaperMirror settings.',
	'papermirror-error-invalid-model': 'The model name or endpoint is wrong.',
	'papermirror-error-network': 'Network error. Check your connection.',
	'papermirror-error-timeout': 'The request timed out.',
	'papermirror-error-rate-limited': 'The API is rate-limiting requests; retrying automatically.',
	'papermirror-error-quota-exceeded': 'API quota/credits exhausted.',
	'papermirror-error-bad-response': 'The service returned an invalid response.',
	'papermirror-error-no-text-layer': 'This PDF has no text layer (needs OCR).',
	'papermirror-error-pdf-encrypted': 'This PDF is encrypted.',
	'papermirror-error-extraction-failed': 'Text extraction failed.',
	'papermirror-error-reader-api-changed': 'The Zotero Reader API changed; this feature is unavailable.',
	'papermirror-error-cache-corrupt': 'The cache entry was corrupt and has been discarded.',
	'papermirror-error-cancelled': 'Translation cancelled.',
	'papermirror-error-http-insecure': 'Insecure HTTP endpoint blocked. Enable it explicitly in settings.',
	'papermirror-error-unknown': 'Unexpected error.'
};

export function initL10n(): void {
	try {
		l10n = new Localization(['papermirror.ftl'], true);
	}
	catch {
		l10n = null;
	}
}

export function disposeL10n(): void {
	l10n = null;
}

export function getString(id: string, args?: Record<string, unknown>): string {
	try {
		const value = l10n?.formatValueSync(id, args);
		if (value) {
			return value;
		}
	}
	catch {
		// fall through to fallback
	}
	return FALLBACKS[id] ?? id;
}
