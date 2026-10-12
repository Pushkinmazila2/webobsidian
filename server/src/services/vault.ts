import path from 'node:path';
import { config } from '../config.js';
import { getSettings, peekSettings } from './settings.js';
import { LocalFsStorage } from '../storage/local.js';
import { createGithubStorage } from '../storage/github/index.js';
import type { VaultStorage } from '../storage/types.js';

export type {
  TreeNode,
  TrashItem,
  DirEntry,
  ReadHandle,
  ByteRange,
  StorageEvent,
  StorageEventHandler,
  StopWatching,
  VaultStorage,
} from '../storage/types.js';

/**
 * Vault facade. All note/attachment I/O in the server goes through here, which
 * delegates to the active `VaultStorage` driver. Keeping this module a thin
 * function-style facade means routes/services don't care which driver is active.
 */

let active: VaultStorage | null = null;
/** Storage settings the running driver was built from (to tell the UI a restart is needed). */
let bootStorageConfig = '';
const storageFingerprint = (s: { storage: unknown }) => JSON.stringify(s.storage);

/** True when the saved storage settings differ from what the running server uses. */
export function storageRestartRequired(saved: { storage: unknown }): boolean {
  return bootStorageConfig !== '' && bootStorageConfig !== storageFingerprint(saved);
}

/** The active storage driver (lazily created from settings). */
export function getStorage(): VaultStorage {
  if (!active) {
    const trashDir = async () => (await getSettings()).vault.trash;
    const s = peekSettings();
    if (s) bootStorageConfig = storageFingerprint(s);
    active =
      s?.storage.driver === 'github'
        ? createGithubStorage(s, { dataDir: config.dataDir, trashDir })
        : new LocalFsStorage({ root: async () => (await getSettings()).vault.path, trashDir });
  }
  return active;
}

/** Swap the driver (tests / future runtime driver switching). */
export function setStorage(s: VaultStorage | null): void {
  active = s;
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.canvas', '.css', '.js', '.yml', '.yaml',
]);

export function isTextFile(rel: string): boolean {
  return TEXT_EXTS.has(path.extname(rel).toLowerCase());
}

/**
 * Absolute folder backing the vault. LOCAL DRIVER ONLY — used by the git service,
 * which shells out to `git` in the vault directory. Throws for remote drivers.
 */
export const getVaultRoot = () => getStorage().localRoot();

export const ensureVault = () => getStorage().init();

// listing
export const listTree = () => getStorage().listTree();
export const listDir = (rel: string) => getStorage().listDir(rel);
export const exists = (rel: string) => getStorage().exists(rel);

/** All visible files (vault-relative) — every type, not just markdown. */
export const listFiles = () => getStorage().listFiles();

/** All markdown files (vault-relative), regardless of indexing rules. */
export async function listMarkdownFiles(): Promise<string[]> {
  return (await getStorage().listFiles()).filter((f) => /\.(md|markdown)$/i.test(f));
}

/** Whether a file takes part in search / backlinks / graph (see VaultStorage.isIndexed). */
export const isIndexed = (rel: string) => getStorage().isIndexed(rel);

/** Markdown files that belong in the search index and link graph. */
export async function listIndexedMarkdownFiles(): Promise<string[]> {
  const st = getStorage();
  return (await listMarkdownFiles()).filter((f) => st.isIndexed(f));
}

// content
export const readFileText = (rel: string) => getStorage().readText(rel);
export const readFileBuffer = (rel: string) => getStorage().readBuffer(rel);
export const openFile = (rel: string) => getStorage().openFile(rel);
export const writeFileText = (rel: string, content: string) => getStorage().writeText(rel, content);
export const writeFileBuffer = (rel: string, buf: Buffer) => getStorage().writeBuffer(rel, buf);

// structure
export const createFolder = (rel: string) => getStorage().mkdir(rel);
export const resolveDirCaseInsensitive = (rel: string) => getStorage().resolveDirCaseInsensitive(rel);
export const rename = (from: string, to: string) => getStorage().rename(from, to);
export const copy = (from: string, to: string) => getStorage().copy(from, to);
/** Permanently delete a file or folder (no trash). */
export const remove = (rel: string) => getStorage().remove(rel);

// trash
export const trash = (rel: string) => getStorage().trash(rel);
export const listTrash = () => getStorage().listTrash();
export const restoreFromTrash = (trashRel: string) => getStorage().restoreFromTrash(trashRel);
export const deleteFromTrash = (trashRel: string) => getStorage().deleteFromTrash(trashRel);
export const emptyTrash = () => getStorage().emptyTrash();

// change feed
/** Commit buffered changes (remote drivers). No-op for local folders. */
export const flushStorage = async (): Promise<void> => {
  if (active) await active.flush?.();
};

export const watchVault = (handler: Parameters<VaultStorage['watch']>[0]) => getStorage().watch(handler);
