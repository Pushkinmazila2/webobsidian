import path from 'node:path';
import type { VaultStorage } from '../storage/types.js';
import { currentVault, overrideDefaultStorage } from './vaultals.js';
import * as acl from './acl.js';
// Installs the vault registry (default-vault provider) as a side effect.
import './vaults.js';

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

/** The storage driver of the current vault (see vaultals.ts). */
export function getStorage(): VaultStorage {
  return currentVault().storage;
}

/** Replace the main vault's driver (tests); `null` drops it so it is rebuilt from settings. */
export function setStorage(s: VaultStorage | null): void {
  overrideDefaultStorage(s);
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.canvas', '.base', '.css', '.js', '.yml', '.yaml',
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

// ---- permissions ---------------------------------------------------------------
// Every call below is checked against the signed-in person of the current request (see acl.ts).
// Boot code, indexing and agent (API-key) requests have no person and are unrestricted.

// listing
export const listTree = async () => acl.filterTree(await getStorage().listTree());
export async function listDir(rel: string) {
  if (!acl.maySee(rel)) throw Object.assign(new Error(`No access to "${rel}"`), { status: 403 });
  const entries = await getStorage().listDir(rel);
  const p = acl.currentPrincipal();
  if (!p || p.isAdmin) return entries;
  const join = (n: string) => (rel ? `${rel.replace(/\/+$/, '')}/${n}` : n);
  return entries.filter((e) => (e.isDir ? acl.maySee(join(e.name)) : acl.canRead(join(e.name))));
}
export const exists = async (rel: string) => (await getStorage().exists(rel)) && acl.maySee(rel);

/** All visible files (vault-relative) — every type, not just markdown. */
export const listFiles = async () => acl.filterPaths(await getStorage().listFiles());

/** All markdown files (vault-relative), regardless of indexing rules. */
export async function listMarkdownFiles(): Promise<string[]> {
  return (await listFiles()).filter((f) => /\.(md|markdown)$/i.test(f));
}

/** Whether a file takes part in search / backlinks / graph (see VaultStorage.isIndexed). */
export const isIndexed = (rel: string) => getStorage().isIndexed(rel);

/** Markdown files that belong in the search index and link graph. */
export async function listIndexedMarkdownFiles(): Promise<string[]> {
  const st = getStorage();
  return (await listMarkdownFiles()).filter((f) => st.isIndexed(f));
}

// content
const reading = <A extends unknown[], R>(fn: (rel: string, ...a: A) => Promise<R>) => async (rel: string, ...a: A): Promise<R> => {
  acl.assertRead(rel);
  return fn(rel, ...a);
};
const writing = <A extends unknown[], R>(fn: (rel: string, ...a: A) => Promise<R>) => async (rel: string, ...a: A): Promise<R> => {
  acl.assertWrite(rel);
  return fn(rel, ...a);
};
export const readFileText = reading((rel: string) => getStorage().readText(rel));
export const readFileBuffer = reading((rel: string) => getStorage().readBuffer(rel));
export const openFile = reading((rel: string) => getStorage().openFile(rel));
export const writeFileText = writing((rel: string, content: string) => getStorage().writeText(rel, content));
export const writeFileBuffer = writing((rel: string, buf: Buffer) => getStorage().writeBuffer(rel, buf));

// structure
export const createFolder = writing((rel: string) => getStorage().mkdir(rel));
export const resolveDirCaseInsensitive = (rel: string) => getStorage().resolveDirCaseInsensitive(rel);
export const rename = async (from: string, to: string) => {
  acl.assertWrite(from);
  acl.assertWrite(to);
  return getStorage().rename(from, to);
};
export const copy = async (from: string, to: string) => {
  acl.assertRead(from);
  acl.assertWrite(to);
  return getStorage().copy(from, to);
};
/** Permanently delete a file or folder (no trash). */
export const remove = writing((rel: string) => getStorage().remove(rel));

// trash
export const trash = writing((rel: string) => getStorage().trash(rel));
export const listTrash = async () => {
  const items = await getStorage().listTrash();
  const p = acl.currentPrincipal();
  return !p || p.isAdmin ? items : items.filter((i) => acl.canRead(i.original));
};
async function trashOriginal(trashRel: string): Promise<string | undefined> {
  return (await getStorage().listTrash()).find((i) => i.path === trashRel)?.original;
}
export const restoreFromTrash = async (trashRel: string) => {
  const original = await trashOriginal(trashRel);
  if (original !== undefined) acl.assertWrite(original);
  else acl.assertAdmin();
  return getStorage().restoreFromTrash(trashRel);
};
export const deleteFromTrash = async (trashRel: string) => {
  const original = await trashOriginal(trashRel);
  if (original !== undefined) acl.assertWrite(original);
  else acl.assertAdmin();
  return getStorage().deleteFromTrash(trashRel);
};
export const emptyTrash = async () => {
  const p = acl.currentPrincipal();
  if (!p || p.isAdmin) return getStorage().emptyTrash();
  // Others empty only what they could restore.
  for (const i of await getStorage().listTrash()) if (acl.canWrite(i.original)) await getStorage().deleteFromTrash(i.path);
};

// change feed
/** Commit buffered changes (remote drivers). No-op for local folders. */
export const flushStorage = async (): Promise<void> => {
  await getStorage().flush?.();
};

export const watchVault = (handler: Parameters<VaultStorage['watch']>[0]) => getStorage().watch(handler);
