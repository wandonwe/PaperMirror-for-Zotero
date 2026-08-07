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
	type CacheKeyParts,
	type CachedPage
} from './cacheSchema';

const MODULE = 'cache';

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
		try {
			await IOUtils.remove(path, { ignoreAbsent: true });
		}
		catch {
			// ignore
		}
		return null;
	}
}

export async function writePage(parts: CacheKeyParts, translations: TranslatedBlock[]): Promise<void> {
	const path = pagePath(parts);
	const dir = PathUtils.parent(path);
	const entry: CachedPage = {
		schemaVersion: CACHE_SCHEMA_VERSION,
		key: parts,
		createdAt: new Date().toISOString(),
		translations
	};
	try {
		if (dir) {
			await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		}
		// Atomic: write to tmp file, then rename over the target.
		await IOUtils.writeJSON(path, entry, { tmpPath: path + '.tmp' });
	}
	catch (e) {
		logger.warn(MODULE, 'Cache write failed (continuing without cache)', e);
	}
}

export async function clearAttachment(attachmentKey: string, fileHash: string): Promise<void> {
	const dir = PathUtils.join(cacheRootDir(), attachmentDirName(attachmentKey, fileHash));
	await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
}

/** Remove every cache dir for this attachment key regardless of file hash. */
export async function clearAttachmentAllVersions(attachmentKey: string): Promise<void> {
	const root = cacheRootDir();
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
	await IOUtils.remove(cacheRootDir(), { recursive: true, ignoreAbsent: true });
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
