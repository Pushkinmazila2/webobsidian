import type { Readable } from 'node:stream';

/**
 * Storage abstraction for the vault.
 *
 * Everything that touches note/attachment bytes goes through a `VaultStorage`
 * driver. All paths are vault-relative, POSIX-style ("folder/note.md").
 * Drivers are responsible for:
 *   - refusing path traversal (throw an Error with `status = 400`),
 *   - hiding dotfiles / `.git` / `node_modules` from listings (like Obsidian),
 *   - keeping their own caches coherent with their own writes.
 *
 * Drivers: `LocalFsStorage` (a folder on disk) and `GitHubStorage` (a repository
 * reached through the GitHub API).
 */

export interface TreeNode {
  name: string;
  path: string; // vault-relative, posix style
  type: 'file' | 'folder';
  ext?: string;
  size?: number;
  mtime?: number; // last-modified (ms) — for sort-by-modified-time
  ctime?: number; // created/birth (ms) — for sort-by-created-time
  children?: TreeNode[];
}

export interface TrashItem {
  name: string; // basename
  path: string; // vault-relative, including the trash prefix, e.g. ".trash/folder/note.md"
  original: string; // where it restores to, e.g. "folder/note.md"
  ext: string;
  size: number;
  mtime: number; // deletion time (file mtime when it landed in trash)
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/**
 * An opened, readable file. `size` is known up-front (needed for Content-Length /
 * Content-Range) and `createReadStream` can be called with an inclusive byte range.
 */
export interface ReadHandle {
  size: number;
  createReadStream(range?: ByteRange): Readable;
}

export type StorageEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface StorageEvent {
  type: StorageEventType;
  path: string; // vault-relative
}

export type StorageEventHandler = (event: StorageEvent) => void | Promise<void>;

/** Stops a running watcher. */
export type StopWatching = () => Promise<void>;

/** Snapshot of a remote-backed driver's sync state (GitHub). */
export interface RemoteInfo {
  repo: string; // owner/repo (GitHub) or the remote URL without credentials (Git)
  branch: string;
  commit: string | null; // commit sha the committed view is based on
  pending: number; // changes not yet committed
  held: number; // of those: held back on purpose (plugins/config), saved after a longer delay
  lastError: string | null; // last failed flush, cleared on success
  conflicts: string[]; // conflict copies created since start
}

export interface VaultStorage {
  /** Driver identifier, for diagnostics and capability checks. */
  readonly kind: 'local' | 'github' | 'git';

  /**
   * Whether `rel` takes part in search / backlinks / graph. Local vaults index
   * everything; the GitHub driver follows the `index` flag of its storage rules, so
   * large or private files never have to be downloaded just to be indexed.
   */
  isIndexed(rel: string): boolean;

  /** Prepare the backing store (create the vault folder, validate credentials, …). */
  init(): Promise<void>;

  // --- listing -------------------------------------------------------------
  /** Full tree (folders + files), hidden entries skipped. */
  listTree(): Promise<TreeNode>;
  /** Flat list of every visible file, vault-relative, in stable traversal order. */
  listFiles(): Promise<string[]>;
  /** Immediate children of a directory (hidden entries included). Throws if missing. */
  listDir(rel: string): Promise<DirEntry[]>;
  exists(rel: string): Promise<boolean>;

  // --- content -------------------------------------------------------------
  readText(rel: string): Promise<string>;
  readBuffer(rel: string): Promise<Buffer>;
  /** Open for (ranged) streaming — used for media and large attachments. */
  openFile(rel: string): Promise<ReadHandle>;
  writeText(rel: string, content: string): Promise<void>;
  writeBuffer(rel: string, buf: Buffer): Promise<void>;

  // --- structure -----------------------------------------------------------
  mkdir(rel: string): Promise<void>;
  /** Resolve a dir path against existing folders case-insensitively (no case-duplicates). */
  resolveDirCaseInsensitive(rel: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  /** Recursive copy; returns every file path created. Throws if `to` exists. */
  copy(from: string, to: string): Promise<string[]>;
  /** Permanently delete a file or folder. */
  remove(rel: string): Promise<void>;

  // --- trash ---------------------------------------------------------------
  /** Move into the trash folder; returns the vault-relative path inside the trash. */
  trash(rel: string): Promise<string>;
  listTrash(): Promise<TrashItem[]>;
  restoreFromTrash(trashRel: string): Promise<string>;
  deleteFromTrash(trashRel: string): Promise<void>;
  emptyTrash(): Promise<void>;

  // --- change feed ---------------------------------------------------------
  /** Report changes made outside this process (git pull, other editors, …). */
  watch(handler: StorageEventHandler): Promise<StopWatching>;

  // --- remote drivers (optional) ---------------------------------------------
  /** Number of changes held back and not yet committed. */
  pendingChanges?(): number;
  /** Commit everything pending now (one commit). Resolves when done or throws. */
  flush?(): Promise<void>;
  /** Re-check the remote immediately. */
  refresh?(): Promise<void>;
  remoteInfo?(): RemoteInfo;

  // --- local-only escape hatch --------------------------------------------
  /**
   * Absolute folder on disk backing the vault. Only meaningful for drivers that
   * are a real directory; used by the local git service. Throws for remote drivers.
   */
  localRoot(): Promise<string>;
}
