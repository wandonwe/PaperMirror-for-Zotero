/**
 * Minimal ambient type declarations for the Zotero 9.0.6 plugin environment.
 *
 * These are hand-verified against the Zotero 9.0.6 source tree
 * (tag eabf364, chrome/content/zotero/xpcom/*) and intentionally cover only
 * the surface this plugin uses. Anything undocumented/unstable is typed
 * loosely and accessed ONLY from src/reader/zoteroReaderAdapter.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare interface ZoteroPrefsAPI {
	get(pref: string, global?: boolean): any;
	set(pref: string, value: any, global?: boolean): void;
	clear(pref: string, global?: boolean): void;
	registerObserver(pref: string, handler: (value: any) => void, global?: boolean): symbol | string;
	unregisterObserver(id: symbol | string): void;
}

declare interface ZoteroNotifierAPI {
	registerObserver(
		observer: { notify(event: string, type: string, ids: (number | string)[], extraData: any): void },
		types: string[],
		id?: string,
		priority?: number
	): string;
	unregisterObserver(id: string): void;
}

declare interface ZoteroItem {
	id: number;
	key: string;
	libraryID: number;
	parentID?: number;
	parentItemID?: number;
	parentItem?: ZoteroItem;
	deleted?: boolean;
	isAttachment(): boolean;
	isPDFAttachment(): boolean;
	isEditable(): boolean;
	getField(field: string): any;
	getFilePathAsync(): Promise<string | false>;
	getBestAttachment?(): Promise<ZoteroItem | false>;
	getTabTitle?(): Promise<string>;
	attachmentHash?: Promise<string>;
	attachmentReaderType?: string;
	getAttachmentLastPageIndex?(): number | null;
	setNote?(html: string): void;
	saveTx(options?: any): Promise<number>;
	getDisplayTitle?(includeAuthorAndDate?: boolean): string;
}

declare interface ZoteroItemsAPI {
	get(id: number | number[]): any;
	getAsync(id: number): Promise<ZoteroItem>;
	getByLibraryAndKey(libraryID: number, key: string): ZoteroItem | false;
}

declare interface ZoteroReaderEvent {
	reader: any;
	doc: Document;
	params: any;
	append: (...elements: (Element | string)[]) => void;
}

declare interface ZoteroReaderAPI {
	_readers: any[];
	registerEventListener(
		type: string,
		handler: (event: ZoteroReaderEvent) => void,
		pluginID?: string
	): void;
	unregisterEventListener(type: string, handler: (event: ZoteroReaderEvent) => void): void;
	getByTabID(tabID: string): any;
	open(itemID: number, location?: any, options?: any): Promise<any>;
}

declare interface ZoteroPDFWorkerAPI {
	getFullText(
		itemID: number,
		maxPages: number | null,
		isPriority?: boolean,
		password?: string
	): Promise<{ text: string; pages?: number; extractedPages?: number; totalPages?: number }>;
}

declare interface ZoteroPreferencePanesAPI {
	register(options: {
		pluginID: string;
		src: string;
		id?: string;
		parent?: string;
		label?: string;
		image?: string;
		scripts?: string[];
		stylesheets?: string[];
		helpURL?: string;
	}): Promise<string>;
	unregister(id: string): void;
}

declare interface ZoteroHTTPAPI {
	request(
		method: string,
		url: string,
		options?: {
			body?: string;
			headers?: Record<string, string>;
			timeout?: number;
			responseType?: string;
			successCodes?: number[] | false;
			/** 0 keeps request bodies out of the debug log (privacy). */
			logBodyLength?: number;
			requestObserver?: (xhr: any) => void;
			noCache?: boolean;
		}
	): Promise<{ status: number; responseText: string; response: any; getAllResponseHeaders?: () => string }>;
}

declare interface ZoteroAPI {
	debug(message: string, level?: number): void;
	HTTP: ZoteroHTTPAPI;
	logError(error: any): void;
	warn(error: any): void;
	getMainWindow(): (Window & { Zotero_Tabs?: any; ZoteroPane?: any; MozXULElement?: any }) | null;
	getMainWindows(): Window[];
	getActiveZoteroPane(): any;
	uiReadyPromise: Promise<void>;
	initializationPromise: Promise<void>;
	Prefs: ZoteroPrefsAPI;
	Notifier: ZoteroNotifierAPI;
	Items: ZoteroItemsAPI;
	Reader: ZoteroReaderAPI;
	PDFWorker: ZoteroPDFWorkerAPI;
	PreferencePanes: ZoteroPreferencePanesAPI;
	DataDirectory: { dir: string };
	File: {
		getContentsAsync(path: string): Promise<string>;
		putContentsAsync(path: string, contents: string): Promise<void>;
		pathToFile(path: string): any;
	};
	Utilities: {
		randomString(len?: number, chars?: string): string;
		debounce<T extends (...args: any[]) => any>(fn: T, delay: number): T;
		throttle<T extends (...args: any[]) => any>(fn: T, wait: number, options?: any): T;
		Internal: {
			md5(input: any, base64?: boolean): string;
			md5Async(file: string | any, base64?: boolean): Promise<string>;
		};
	};
	Promise: { delay(ms: number): Promise<void> };
	Items_?: never;
	Item: new (itemType: string) => any;
	locale: string;
	platformMajorVersion: number;
	version: string;
	isMac?: boolean;
	isWin?: boolean;
	launchURL(url: string): void;
	getString(name: string, params?: any): string;
	ftl?: { formatValueSync(id: string, args?: any): string };
}

declare var Zotero: ZoteroAPI;

declare interface MozServices {
	scriptloader: { loadSubScript(url: string, scope?: any, charset?: string): void };
	logins: {
		initializationPromise: Promise<void>;
		searchLoginsAsync(matchData: any): Promise<any[]>;
		addLoginAsync(login: any): Promise<any>;
		modifyLogin(oldLogin: any, newLogin: any): void;
		removeLogin(login: any): void;
	};
	prefs: any;
	wm: {
		getMostRecentWindow(type: string): any;
		getEnumerator(type: string): any;
	};
	obs: {
		addObserver(observer: any, topic: string, weak?: boolean): void;
		removeObserver(observer: any, topic: string): void;
	};
	locale: { appLocalesAsBCP47: string[] };
}

declare var Services: MozServices;

declare var Components: {
	classes: Record<string, any>;
	interfaces: Record<string, any>;
	utils: { cloneInto(obj: any, scope: any, options?: any): any };
	Constructor(contractID: string, iface: string | any, init?: string): any;
};

declare var Cu: { cloneInto(obj: any, scope: any, options?: any): any };
declare var Cc: Record<string, any>;
declare var Ci: Record<string, any>;

declare var ChromeUtils: {
	importESModule(url: string): any;
};

declare var IOUtils: {
	read(path: string): Promise<Uint8Array>;
	readUTF8(path: string): Promise<string>;
	readJSON(path: string): Promise<any>;
	write(path: string, data: Uint8Array, options?: { tmpPath?: string }): Promise<number>;
	writeUTF8(path: string, text: string, options?: { tmpPath?: string }): Promise<number>;
	writeJSON(path: string, value: any, options?: { tmpPath?: string }): Promise<number>;
	exists(path: string): Promise<boolean>;
	remove(path: string, options?: { recursive?: boolean; ignoreAbsent?: boolean }): Promise<void>;
	makeDirectory(path: string, options?: { createAncestors?: boolean; ignoreExisting?: boolean }): Promise<void>;
	getChildren(path: string): Promise<string[]>;
	stat(path: string): Promise<{ size: number; lastModified: number; type: string }>;
};

declare var PathUtils: {
	join(...parts: string[]): string;
	filename(path: string): string;
	parent(path: string): string | null;
};
