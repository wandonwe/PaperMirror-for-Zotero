export type AutoExplanationWatcher = (() => void) & { suppressCurrentSelection(): void };

/** Wait for a completed, stable selection; never send intermediate drag text. */
export function watchAutoExplainSelection(options: {
	document: Document;
	readText: () => string;
	enabled: () => boolean;
	onChange: () => void;
	onSelection: (text: string) => void;
	delayMs?: number;
}): AutoExplanationWatcher {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let dragging = false;
	let observed = '';
	let submitted = '';
	let disposed = false;
	const clear = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const update = () => {
		if (disposed) return;
		const text = options.readText().trim();
		if (text !== observed) {
			observed = text;
			options.onChange();
		}
		clear();
		if (!text) submitted = '';
		if (dragging || !text || text === submitted || !options.enabled()) return;
		timer = setTimeout(() => {
			timer = null;
			if (disposed || dragging || !options.enabled() || options.readText().trim() !== text) return;
			submitted = text;
			options.onSelection(text);
		}, options.delayMs ?? 350);
	};
	const down = () => { dragging = true; clear(); };
	const up = () => { dragging = false; update(); };
	options.document.addEventListener('selectionchange', update);
	options.document.addEventListener('pointerdown', down, true);
	options.document.addEventListener('pointerup', up, true);
	options.document.addEventListener('pointercancel', up, true);
	options.document.addEventListener('keyup', update, true);
	const stop = () => {
		disposed = true;
		clear();
		options.document.removeEventListener('selectionchange', update);
		options.document.removeEventListener('pointerdown', down, true);
		options.document.removeEventListener('pointerup', up, true);
		options.document.removeEventListener('pointercancel', up, true);
		options.document.removeEventListener('keyup', update, true);
	};
	return Object.assign(stop, { suppressCurrentSelection() {
		clear();
		observed = submitted = options.readText().trim();
	} });
}
