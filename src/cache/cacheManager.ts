/**
 * File-backed translation cache under <Zotero data dir>/bilingual-reader/cache.
 * Never touches the Zotero database. All writes are atomic (tmp + rename via
 * IOUtils tmpPath). Cache entries never contain API keys.
 */

import type { TranslatedBlock } from '../types/models';
import * as logger from '../utils/logger';
import {
	CACHE_SCHEMA_VERSION,
	attachmentDirName,
	isValidCachedPage,
	pageFileName,
	segmentContextHash,
	segmentsFileName,
	isValidCachedSegments,
	type CacheKeyParts,
	type CachedPage,
	type CachedSegments,
	type SegmentContextParts
} from './cacheSchema';

const MODULE = 'cache';

/**
 * 每个缓存文件一条写队列 (1.3.0, 审核 P1): 段落缓存的写入是「读旧文件 → 合并
 * → 原子覆盖」。原子写只保证文件不写坏,保证不了并发合并正确 —— 页面 A、B
 * 同时读到 {x},A 写 {x,a},B 再写 {x,b},a 被覆盖丢失。表现为翻译成功但下次
 * 打开重新翻译、段落命中率异常低、完成顺序影响缓存。同一路径的写现在串行:
 * 后一次写必须等前一次的 读→合并→写 全部落盘。不同文件互不阻塞。
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(path: string, job: () => Promise<void>): Promise<void> {
	const prev = writeQueues.get(path) ?? Promise.resolve();
	const next = prev.then(job, job); // 前一次失败也不能卡死队列
	const tail = next.then(() => undefined, () => undefined);
	writeQueues.set(path, tail);
	// Map 收缩 (2.0.6, 审核 P3): 此前表项只增不减 —— 长会话里每个写过的缓存
	// 文件路径都占一条已 settled 的 promise。队列排空后把自己的表项删掉;
	// 只有自己仍是队尾时才删,期间有新写入接上则交由新队尾负责。
	void tail.then(() => {
		if (writeQueues.get(path) === tail) {
			writeQueues.delete(path);
		}
	});
	return next;
}

/**
 * 收紧缓存权限 (2.1.1, 审核 P2-A): 缓存文件里是**整篇论文的译文**明文。默认
 * umask 下文件是 0644、目录 0755 —— 同一台机器上的其他本地账户可直接读走
 * 用户在读什么、译文全文。写文件后收到 0600、建目录后收到 0700。纯尽力而为:
 * Windows 上 IOUtils.setPermissions 是 no-op / 抛错(NTFS ACL 非 POSIX 位),
 * 任何失败都吞掉 —— 权限收不紧不该让缓存写入失败(缓存本就是可失败的旁路)。
 */
async function chmodBestEffort(path: string, mode: number): Promise<void> {
	try {
		await (IOUtils as unknown as { setPermissions?(p: string, permissions: number): Promise<void> })
			.setPermissions?.(path, mode);
	}
	catch {
		// 权限收紧尽力而为
	}
}

export function cacheRootDir(): string {
	return PathUtils.join(Zotero.DataDirectory.dir, 'bilingual-reader', 'cache');
}

function pagePath(parts: CacheKeyParts): string {
	return PathUtils.join(cacheRootDir(), attachmentDirName(parts.attachmentKey, parts.fileHash), pageFileName(parts));
}

export async function readPage(parts: CacheKeyParts): Promise<TranslatedBlock[] | null> {
	const path = pagePath(parts);
	try {
		if (!(await IOUtils.exists(path))) {
			return null;
		}
		const data = await IOUtils.readJSON(path);
		if (!isValidCachedPage(data, parts)) {
			logger.warn(MODULE, `Corrupt or mismatched cache entry removed: ${PathUtils.filename(path)}`);
			await IOUtils.remove(path, { ignoreAbsent: true });
			return null;
		}
		return data.translations;
	}
	catch (e) {
		logger.warn(MODULE, 'Cache read failed; treating as miss', e);
		// 同 P2-13: 只有内容确认损坏 (SyntaxError) 才删;瞬时 I/O 失败不删,
		// 文件下次读取很可能是好的。
		if ((e as Error)?.name === 'SyntaxError') {
			try {
				await IOUtils.remove(path, { ignoreAbsent: true });
			}
			catch {
				// ignore
			}
		}
		return null;
	}
}

export async function writePage(parts: CacheKeyParts, translations: TranslatedBlock[], producedBy?: string): Promise<void> {
	const path = pagePath(parts);
	const dir = PathUtils.parent(path);
	const entry: CachedPage & { producedBy?: string } = {
		schemaVersion: CACHE_SCHEMA_VERSION,
		key: parts,
		createdAt: new Date().toISOString(),
		// 实际产出引擎 (2.0.10, 审核 P3, 仅诊断): 熔断/轮换页的译文以规范引擎
		// 的键落盘(读写恒等,正确)—— key.provider 因此可能不是真正产出译文
		// 的引擎。v5 的已知残余: 改**实际**引擎的参数不会使这些条目失效。
		// producedBy 不入键、不参与校验,只为人工检查与诊断诚实。
		...(producedBy ? { producedBy } : {}),
		translations
	};
	await enqueueWrite(path, async () => {
		try {
			if (dir) {
				await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
				await chmodBestEffort(dir, 0o700);
			}
			// Atomic: write to tmp file, then rename over the target.
			await IOUtils.writeJSON(path, entry, { tmpPath: path + '.tmp' });
			await chmodBestEffort(path, 0o600);
		}
		catch (e) {
			logger.warn(MODULE, 'Cache write failed (continuing without cache)', e);
		}
	});
}

/**
 * 跨文档共享段落库 (2.3.5, 第四批 item7 · API-3): 段落 store 从「每 attachment
 * 一份」改为**全局共享**目录 —— 段落身份本就是 内容+语言(segmentHash)×
 * 引擎/模型/提示词/术语表(context),与文档无关;同领域批量读论文时样板句
 * (资助声明/伦理声明/方法套话)可占 5–15%,跨文档命中即 0 请求。
 * 写入只写共享库;读取先共享、后旧 per-attachment 路径(存量平滑迁移,旧库
 * 由 schema 清扫/清全部缓存自然退场)。「清除本文缓存」不再涉及共享段落库
 * (确认框如实说明);「清除全部缓存」照常全清(共享目录在缓存根下)。
 */
function segmentsPath(parts: SegmentContextParts): string {
	return PathUtils.join(cacheRootDir(), 'shared-segments', segmentsFileName(parts));
}

/** 旧 per-attachment 段落库路径 —— 只读回退(迁移期命中存量)。 */
function legacySegmentsPath(parts: SegmentContextParts): string {
	return PathUtils.join(cacheRootDir(), attachmentDirName(parts.attachmentKey, parts.fileHash), segmentsFileName(parts));
}

/**
 * 段落写入的内存合并 + 节流落盘 (2.2.4, 计划 第三批 item5 · PF-3)。
 *
 * 问题: 每 attachment+context 只有一个 store 文件,旧的 writeSegments 每次调用
 * 都 read→merge→**整篇重写**。整篇论文按页翻译时,store 随页增长、每页各重写
 * 一遍全库 → 全篇累计 O(N²) 的 JSON 读写。
 *
 * 现在: writeSegments 把条目并入**内存 pending**(按文件路径合并),启动一个节流
 * 窗口;窗口到点时 flushSegments 把该路径**当前累积的全部** pending 一次性
 * read→merge→write。整篇突发翻译里几十次每页写坍缩成个位数次全库重写。返回的
 * Promise 在**本批真正落盘后**才 resolve(读写语义不变,调用方仍可 await 持久化)。
 *
 * 保留三条既有硬约束:① 同路径写经 enqueueWrite 串行,并发页不互相覆盖(P1,
 * 1.3.0);② 合并基底瞬时读失败 → 放弃本次落盘、绝不以空库截断(P2-1, 2.0.7);
 * ③ 原子 tmp 写 + 0700/0600 收权。
 */
interface PendingSegments {
	context: string;
	entries: Map<string, string>;
	timer: ReturnType<typeof setTimeout> | null;
	promise: Promise<void>;
	resolve: () => void;
}
const pendingSegments = new Map<string, PendingSegments>();

/** flush 节流窗口 (ms)。默认 500;测试用 setSegmentFlushDelayMs(0) 取确定性即时落盘。 */
let segmentFlushDelayMs = 500;
export function setSegmentFlushDelayMs(ms: number): void {
	segmentFlushDelayMs = Math.max(0, ms | 0);
}

/** 丢弃指定路径前缀下的 pending(clear* 删文件前调用,防止落盘复活已删文件)。 */
function dropPendingSegments(pathPrefix?: string): void {
	for (const [path, p] of pendingSegments) {
		if (pathPrefix && !path.startsWith(pathPrefix)) {
			continue;
		}
		if (p.timer) {
			try { clearTimeout(p.timer); }
			catch { /* timers may be gone */ }
		}
		pendingSegments.delete(path);
		p.resolve(); // 别让 await 者悬挂 —— 库正被清,丢弃即视为完成
	}
}

/**
 * 段落库解析缓存 + 条目上限 (2.5.3, PF-5)。
 *
 * 问题: readSegments 每页都把**整份**共享段落库 readJSON 一遍(为了解析出这一
 * 页那二十来个 hash),而 2.3.5 把段落库从「每篇一份」改成**全局共享**之后,
 * 这份文件跨论文只增不减 —— 全仓没有任何 prune/evict,只有「清除全部缓存」能
 * 删。于是第 N 页读的是已经含前 N−1 页的库:单篇内 O(N²),常数还由你读过的
 * 所有论文带进来。用户感受就是「越往后翻越慢」。
 *
 * 解法两条:
 *   ① 进程内保留**已解析**的库,用 (size, lastModified) 作指纹校验 —— 命中
 *      时一次 stat 顶掉一次整库 parse。自己写盘后直接就地更新指纹,连 stat
 *      都省了。指纹拿不到(stat 缺字段/失败)就老实重读,绝不假定有效。
 *   ② 库有条目上限,超了在落盘时按**插入序**淘汰最旧的。读命中会把条目重新
 *      插到末尾(见 readSegments),所以插入序就是近似 LRU。段落 hash 是 16 位
 *      定长十六进制,超过 2^32 不构成数组下标,Object.keys 严格保持插入序。
 */
interface StoreCacheEntry {
	context: string;
	segments: Record<string, string>;
	/** `${size}:${lastModified}` —— 与磁盘一致的证据。 */
	stamp: string;
}
const storeCache = new Map<string, StoreCacheEntry>();

/** 共享段落库的条目上限。约 2 万条 ≈ 十几 MB,跨论文攒得再久也有天花板。 */
const MAX_SEGMENT_ENTRIES = 20000;
let maxSegmentEntries = MAX_SEGMENT_ENTRIES;
/** 仅供测试: 把上限调小,免得为了验证淘汰而真写两万条。 */
export function setMaxSegmentEntries(n: number): void {
	maxSegmentEntries = Math.max(1, n | 0);
}

/** 丢弃解析缓存(删库/清缓存后必须调用,否则会拿着已删文件的内容继续命中)。 */
function dropStoreCache(pathPrefix?: string): void {
	if (!pathPrefix) {
		storeCache.clear();
		return;
	}
	for (const path of [...storeCache.keys()]) {
		if (path.startsWith(pathPrefix)) {
			storeCache.delete(path);
		}
	}
}

/** 文件指纹;拿不到可用的 size+lastModified 就返回 null(= 无法证明缓存有效)。 */
async function statStamp(path: string): Promise<string | null> {
	try {
		const st = await (IOUtils as unknown as { stat?(p: string): Promise<{ size?: number; lastModified?: number }> }).stat?.(path);
		if (typeof st?.size === 'number' && typeof st?.lastModified === 'number') {
			return `${st.size}:${st.lastModified}`;
		}
	}
	catch {
		// stat 失败 = 说不清,按缓存未命中处理
	}
	return null;
}

type StoreLoad =
	| { kind: 'hit'; segments: Record<string, string> }
	/** 文件不存在 —— 空库是正确起点。 */
	| { kind: 'missing' }
	/** 内容确认损坏或 context 不符 —— 允许以空库重建。 */
	| { kind: 'invalid' }
	/** 瞬时读失败 —— 什么都别做,尤其别拿空库覆盖(2.0.7 审核 P2-1)。 */
	| { kind: 'error' };

async function loadSegmentStore(path: string, context: string): Promise<StoreLoad> {
	const stamp = await statStamp(path);
	const cached = storeCache.get(path);
	if (cached && stamp && cached.stamp === stamp && cached.context === context) {
		return { kind: 'hit', segments: cached.segments };
	}
	let exists: boolean;
	try {
		exists = await IOUtils.exists(path);
	}
	catch {
		return { kind: 'error' };
	}
	if (!exists) {
		storeCache.delete(path);
		return { kind: 'missing' };
	}
	let data: unknown;
	try {
		data = await IOUtils.readJSON(path);
	}
	catch (e) {
		if ((e as Error)?.name === 'SyntaxError') {
			storeCache.delete(path);
			return { kind: 'invalid' };
		}
		return { kind: 'error' };
	}
	if (!isValidCachedSegments(data, context)) {
		storeCache.delete(path);
		return { kind: 'invalid' };
	}
	// 指纹在**读之后**再取一次: 读前那次可能已被并发写作废。
	const after = await statStamp(path);
	if (after) {
		storeCache.set(path, { context, segments: data.segments, stamp: after });
	}
	else {
		storeCache.delete(path);
	}
	return { kind: 'hit', segments: data.segments };
}

async function flushSegments(path: string): Promise<void> {
	const p = pendingSegments.get(path);
	if (!p) {
		return;
	}
	// 抽干并从表中摘除: flush 期间到达的新写入另起一个 pending + 新窗口,绝不丢。
	if (p.timer) {
		try { clearTimeout(p.timer); }
		catch { /* ignore */ }
		p.timer = null;
	}
	pendingSegments.delete(path);
	const { context, entries, resolve } = p;
	const dir = PathUtils.parent(path);
	await enqueueWrite(path, async () => {
		try {
			// 合并基底的读取失败分类 (2.0.7, 审核 P2-1): 只有内容确认损坏
			// (SyntaxError)或 context 不符才允许以空库重建;瞬时读失败直接
			// 放弃本次合并 —— 少写几条段落远好过丢掉整库。命中解析缓存时这里
			// 一次磁盘 parse 都不做 (2.5.3)。
			const loaded = await loadSegmentStore(path, context);
			if (loaded.kind === 'error') {
				logger.warn(MODULE, 'Segment merge base read failed transiently; skipping this write to protect the store');
				return;
			}
			const segments: Record<string, string> = loaded.kind === 'hit' ? loaded.segments : {};
			for (const [hash, text] of entries) {
				if (hash && text) {
					// 先删后插: 复写一条老段落也要把它移到插入序末尾,否则它会
					// 顶着旧位置被当成"最旧"淘汰掉。
					delete segments[hash];
					segments[hash] = text;
				}
			}
			// 条目上限 (2.5.3): 插入序最旧的先走。读命中会把条目重新插到末尾,
			// 所以这就是近似 LRU —— 常被命中的样板句活得久,一次性段落先出局。
			const keys = Object.keys(segments);
			if (keys.length > maxSegmentEntries) {
				const drop = keys.length - maxSegmentEntries;
				for (let i = 0; i < drop; i++) {
					delete segments[keys[i]!];
				}
				logger.info(MODULE, `Segment store trimmed: dropped ${drop} least-recently-used entries (cap ${maxSegmentEntries})`);
			}
			const entry: CachedSegments = { schemaVersion: CACHE_SCHEMA_VERSION, context, segments };
			if (dir) {
				await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
				await chmodBestEffort(dir, 0o700);
			}
			await IOUtils.writeJSON(path, entry, { tmpPath: path + '.tmp' });
			await chmodBestEffort(path, 0o600);
			// 刚写完的内容就是权威版本: 就地更新解析缓存,下一页连 parse 带
			// 重读全省。指纹取不到就把缓存丢掉,绝不留一份无法证明有效的。
			const stamp = await statStamp(path);
			if (stamp) {
				storeCache.set(path, { context, segments, stamp });
			}
			else {
				storeCache.delete(path);
			}
		}
		catch (e) {
			storeCache.delete(path); // 写到一半失败: 内存里那份可能已不对应磁盘
			logger.warn(MODULE, 'Segment cache write failed (continuing without cache)', e);
		}
	});
	resolve();
}

/**
 * 段落级缓存 read: return whichever of the requested segment hashes exist for
 * this attachment+context — first from the un-flushed in-memory pending (so a
 * segment just written by a concurrent page is visible before its flush), then
 * from the on-disk store. Misses are simply absent. Any read problem is a miss.
 */
export async function readSegments(parts: SegmentContextParts, hashes: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!hashes.length) {
		return out;
	}
	const path = segmentsPath(parts);
	// 先查 pending: 节流窗口内另一页刚写、尚未落盘的段落也能命中(不丢跨页去重)。
	const pending = pendingSegments.get(path);
	const remaining: string[] = [];
	for (const h of hashes) {
		const mem = pending?.entries.get(h);
		if (typeof mem === 'string' && mem) {
			out.set(h, mem);
		}
		else {
			remaining.push(h);
		}
	}
	if (!remaining.length) {
		return out;
	}
	const context = segmentContextHash(parts);
	// 依次读: 共享库 → 旧 per-attachment 库(API-3 迁移回退)。命中即从 remaining
	// 摘除;任何读失败都只是 miss。
	const readStore = async (storePath: string, removeInvalid: boolean): Promise<void> => {
		try {
			if (!remaining.length) {
				return;
			}
			// 命中解析缓存时这里一次整库 parse 都不做 —— 那正是「越往后翻越慢」
			// 的来源 (2.5.3)。
			const loaded = await loadSegmentStore(storePath, context);
			if (loaded.kind === 'invalid' && removeInvalid) {
				storeCache.delete(storePath);
				await IOUtils.remove(storePath, { ignoreAbsent: true });
				return;
			}
			if (loaded.kind !== 'hit') {
				return;
			}
			const segments = loaded.segments;
			for (let i = remaining.length - 1; i >= 0; i--) {
				const h = remaining[i]!;
				const text = segments[h];
				if (typeof text === 'string' && text) {
					out.set(h, text);
					remaining.splice(i, 1);
					// LRU 触碰: 命中的条目重新插到插入序末尾,淘汰时最后才轮到
					// 它。只动内存里这份,不写盘 —— 顺序随下一次落盘自然持久化。
					delete segments[h];
					segments[h] = text;
				}
			}
		}
		catch (e) {
			logger.warn(MODULE, 'Segment cache read failed; treating as miss', e);
		}
	};
	await readStore(path, true);
	await readStore(legacySegmentsPath(parts), false); // 旧库只读不删,清扫另有机制
	return out;
}

/**
 * 段落级缓存 write: merge into the in-memory pending for this store file, then
 * flush the WHOLE accumulated pending in one read→merge→write after a throttle
 * window (0 = flush now, for deterministic tests). Coalesces a full-document
 * burst of per-page writes into a handful of disk rewrites — see PendingSegments.
 */
export async function writeSegments(parts: SegmentContextParts, entries: { hash: string; translatedText: string }[]): Promise<void> {
	if (!entries.length) {
		return;
	}
	const path = segmentsPath(parts);
	const context = segmentContextHash(parts);
	let p = pendingSegments.get(path);
	if (!p) {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => { resolve = r; });
		p = { context, entries: new Map(), timer: null, promise, resolve };
		pendingSegments.set(path, p);
	}
	for (const e of entries) {
		if (e.hash && e.translatedText) {
			p.entries.set(e.hash, e.translatedText);
		}
	}
	if (segmentFlushDelayMs <= 0) {
		void flushSegments(path);
	}
	else if (!p.timer) {
		// 收集窗口从**本批首条**起 500ms —— 期间的写并入同一 pending、不重置窗口,
		// 落盘延迟因此有上界,不会被持续写入饿死。
		p.timer = setTimeout(() => { void flushSegments(path); }, segmentFlushDelayMs);
	}
	return p.promise;
}

export async function clearAttachment(attachmentKey: string, fileHash: string): Promise<void> {
	const dir = PathUtils.join(cacheRootDir(), attachmentDirName(attachmentKey, fileHash));
	dropPendingSegments(dir); // 删目录前丢弃其未落盘 pending,防止 flush 复活已删文件
	dropStoreCache(dir);      // 解析缓存同样要丢 —— 否则会拿着已删文件的内容继续命中
	await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
}

/** Remove every cache dir for this attachment key regardless of file hash. */
export async function clearAttachmentAllVersions(attachmentKey: string): Promise<void> {
	const root = cacheRootDir();
	dropPendingSegments(); // 跨版本清理: 保守丢弃全部未落盘 pending
	dropStoreCache();
	try {
		if (!(await IOUtils.exists(root))) {
			return;
		}
		const children = await IOUtils.getChildren(root);
		const prefix = attachmentKey.replace(/[^a-zA-Z0-9._-]/g, '_') + '-';
		for (const child of children) {
			if (PathUtils.filename(child).startsWith(prefix)) {
				await IOUtils.remove(child, { recursive: true, ignoreAbsent: true });
			}
		}
	}
	catch (e) {
		logger.warn(MODULE, 'clearAttachmentAllVersions failed', e);
	}
}

export async function clearAll(): Promise<void> {
	dropPendingSegments(); // 全清前丢弃全部未落盘 pending
	dropStoreCache();
	await IOUtils.remove(cacheRootDir(), { recursive: true, ignoreAbsent: true });
}

/**
 * 兼容性清理 (schema v2, 1.3.0): schema 升级后旧条目的文件名布局也变了
 * (页面文件名多了 customPromptHash 段),读取路径永远碰不到它们,只会白占磁盘。
 * 启动后惰性扫一遍:凡 JSON 里 schemaVersion 与当前不符的缓存文件直接删除。
 * 纯尽力而为 —— 任何失败都吞掉,绝不影响启动。每会话至多跑一次。
 */
let sweepDone = false;

export async function sweepStaleCacheFiles(): Promise<number> {
	if (sweepDone) {
		return 0;
	}
	sweepDone = true;
	let removed = 0;
	try {
		const root = cacheRootDir();
		if (!(await IOUtils.exists(root))) {
			return 0;
		}
		for (const dir of await IOUtils.getChildren(root)) {
			let children: string[];
			try {
				children = await IOUtils.getChildren(dir);
			}
			catch {
				continue; // a file at root level, or unreadable — skip
			}
			for (const file of children) {
				// `.json.tmp` 残留 (2.0.6, 审核 P3): 原子写崩溃在 rename 之前会
				// 留下 tmp 文件 —— 永远不会被读取,却一直计入缓存体积。只清
				// 「明显是残骸」的 (≥5 分钟未动): sweep 虽在启动后运行,但用户
				// 可能已经打开文档开始翻译,新鲜的 tmp 可能是正在进行的原子写。
				if (file.endsWith('.json.tmp')) {
					try {
						const stat = await IOUtils.stat(file);
						const age = Date.now() - (stat.lastModified ?? 0);
						if (age > 5 * 60 * 1000) {
							await IOUtils.remove(file, { ignoreAbsent: true });
							removed++;
						}
					}
					catch { /* stat/remove 失败: 留给下次 */ }
					continue;
				}
				if (!file.endsWith('.json')) {
					continue;
				}
				try {
					const data = await IOUtils.readJSON(file) as { schemaVersion?: number } | null;
					if (!data || data.schemaVersion !== CACHE_SCHEMA_VERSION) {
						await IOUtils.remove(file, { ignoreAbsent: true });
						removed++;
					}
				}
				catch (e) {
					// 只删「内容确认无效」的文件 (2.0.4, 审核 P2-13): JSON 解析失败
					// (SyntaxError) 说明内容本身坏了,可删;其余异常是 I/O 层面的
					// 瞬时失败(文件被占用/权限抖动/网盘同步),内容很可能是完好的
					// 当前版本缓存 —— 旧逻辑一律删除,启动时一次磁盘抖动就能把
					// 整个缓存清空,代价是所有文档全量重译。
					if ((e as Error)?.name === 'SyntaxError') {
						await IOUtils.remove(file, { ignoreAbsent: true }).catch(() => { /* ignore */ });
						removed++;
					}
					else {
						logger.warn(MODULE, `Schema sweep: read failed, keeping file (${PathUtils.filename(file)})`, e);
					}
				}
			}
		}
		if (removed) {
			// 清扫删过文件: 解析缓存整体作废(启动期通常还是空的,纯属守序)。
			dropStoreCache();
			logger.info(MODULE, `Schema sweep removed ${removed} stale cache file(s)`);
		}
	}
	catch (e) {
		logger.warn(MODULE, 'Schema sweep failed (ignored)', e);
	}
	return removed;
}

export async function totalSizeBytes(): Promise<number> {
	const root = cacheRootDir();
	let total = 0;
	try {
		if (!(await IOUtils.exists(root))) {
			return 0;
		}
		const stack = [root];
		while (stack.length) {
			const dir = stack.pop()!;
			for (const child of await IOUtils.getChildren(dir)) {
				try {
					const stat = await IOUtils.stat(child);
					if (stat.type === 'directory') {
						stack.push(child);
					}
					else {
						total += stat.size;
					}
				}
				catch {
					// ignore unreadable entries
				}
			}
		}
	}
	catch {
		return total;
	}
	return total;
}
