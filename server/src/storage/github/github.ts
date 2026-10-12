import { Readable } from 'node:stream';
import type {
  ByteRange,
  DirEntry,
  ReadHandle,
  RemoteInfo,
  StopWatching,
  StorageEvent,
  StorageEventHandler,
  TrashItem,
  TreeNode,
  VaultStorage,
} from '../types.js';
import { GithubClient, GithubError, NotFastForwardError, type TreeEntry } from './client.js';
import { TtlCache, gitBlobSha, type ContentCache } from './cache.js';
import type { Rules } from './rules.js';
import { tarFiles } from './tar.js';
import { TreeIndex, diffTrees, type FileEntry } from './treeindex.js';

export interface GithubStorageOptions {
  owner: string;
  repo: string;
  /** Empty/undefined = the repository's default branch. */
  branch?: string;
  /** Folder inside the repo that is the vault root ('' = repo root). */
  basePath?: string;
  client: GithubClient;
  rules: Rules;
  cache: ContentCache;
  /** Trash folder name inside the vault (default ".trash"). */
  trashDir?: () => Promise<string> | string;
  /** How often the branch is polled for outside changes. Default 30s. */
  pollMs?: number;
  /** `remote` files are kept in memory this long (absorbs repeated reads). Default 60s. */
  remoteTtlMs?: number;
  remoteMaxBytes?: number;
  /** Use one tarball instead of N blob requests once more than this many files are wanted. */
  tarballThreshold?: number;
  maxTarFileBytes?: number;
  /** Parallel API requests. Default 6. */
  concurrency?: number;

  // ---- write-behind ----
  /** Quiet period after the last write before changes are committed. Default 15s. */
  flushDelayMs?: number;
  /** Upper bound on how long a change may wait, however busy the editor is. Default 60s. */
  flushMaxWaitMs?: number;
  /** Commit immediately once this many unsaved bytes are buffered. Default 32 MB. */
  flushMaxBytes?: number;
  /** Longest wait between retries of a failing commit. Default 5 min. */
  flushRetryMaxMs?: number;
  /** Largest file we will upload (GitHub's blob limit is 100 MB). */
  maxBlobBytes?: number;
  /** Commit author; omitted = the account that owns the token. */
  author?: { name: string; email: string };
  log?: (msg: string) => void;
}

const IGNORED_EVENT = /(^|\/)(\.git|\.obsidian|node_modules|\.trash)(\/|$)/;
const LFS_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const KEEP = '.gitkeep'; // placeholder that lets an otherwise empty folder exist in git

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}
const notFound = (rel: string) => httpError(`Not found: ${rel}`, 404);

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function splitExt(p: string): { stem: string; ext: string } {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  return dot > slash + 1 ? { stem: p.slice(0, dot), ext: p.slice(dot) } : { stem: p, ext: '' };
}

/** A change that has not been committed to GitHub yet. */
type Pending =
  | {
      kind: 'put';
      sha: string;
      size: number;
      /** Content, when it only exists locally. Absent = a blob already in the repo (rename/copy). */
      data?: Buffer;
      /** Blob sha of this path in the committed snapshot our edit was based on. */
      baseSha: string | undefined;
      ver: number;
    }
  | { kind: 'del'; baseSha: string | undefined; ver: number };

/**
 * The vault is a branch of a GitHub repository, reached through the REST API.
 *
 * Reading
 * - The tree comes from one recursive Trees request and is kept as an in-memory
 *   snapshot; content is fetched by blob sha and cached by sha (rules.ts decides
 *   what is mirrored, lazy or never stored).
 * - There are no filesystem events, so `watch()` polls the branch ref with a
 *   conditional request (a 304 is free) and diffs the old and new trees.
 *
 * Writing (write-behind)
 * - Every write lands instantly in an in-memory overlay of unsaved changes and is
 *   visible to reads straight away, so the editor feels local. The overlay is
 *   committed later as ONE commit (blobs → tree → commit → ref) after a quiet
 *   period, on `flush()`, or at shutdown. Rename/copy/delete of whole folders are a
 *   single atomic tree change, and renamed/copied files reuse their existing blobs.
 * - If somebody else pushed meanwhile, our changes are re-applied on top of theirs.
 *   When both sides changed the same file, the remote version stays and ours is
 *   saved next to it as "<name> (conflict <date>)" — nothing is ever overwritten
 *   or lost.
 * - Unsaved changes live only in memory until committed; a crash loses at most
 *   the last `flushDelayMs`–`flushMaxWaitMs` of edits.
 */
export class GitHubStorage implements VaultStorage {
  readonly kind = 'github' as const;

  private readonly o: Required<
    Pick<
      GithubStorageOptions,
      | 'pollMs'
      | 'remoteTtlMs'
      | 'remoteMaxBytes'
      | 'tarballThreshold'
      | 'maxTarFileBytes'
      | 'concurrency'
      | 'flushDelayMs'
      | 'flushMaxWaitMs'
      | 'flushMaxBytes'
      | 'flushRetryMaxMs'
      | 'maxBlobBytes'
    >
  > &
    GithubStorageOptions;
  private readonly client: GithubClient;
  private readonly rules: Rules;
  private readonly cache: ContentCache;
  private readonly ttl: TtlCache;
  private readonly basePath: string;

  private branch = '';
  private commitSha = '';
  /** Root tree sha of `commitSha` (the whole repo, not just basePath). */
  private rootTree = '';
  /** The committed snapshot. */
  private base: TreeIndex = TreeIndex.build([]);
  /** What readers see: `base` + unsaved changes. */
  private idx: TreeIndex = TreeIndex.build([]);
  private pending = new Map<string, Pending>();
  private ver = 0;
  private flushing = false;
  private trashedAt = new Map<string, number>();
  private conflicts: string[] = [];

  private inflight = new Map<string, Promise<Buffer>>();
  private lock: Promise<unknown> = Promise.resolve();
  private handlers = new Set<StorageEventHandler>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastPollError = '';

  private flushTimer: NodeJS.Timeout | null = null;
  private firstUnsavedAt = 0;
  private flushFailures = 0;
  private lastFlushError = '';

  constructor(opts: GithubStorageOptions) {
    // An explicitly passed `undefined` must not wipe out a default, so drop those first.
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.o = {
      pollMs: 30_000,
      remoteTtlMs: 60_000,
      remoteMaxBytes: 64 * 1024 * 1024,
      tarballThreshold: 30,
      maxTarFileBytes: 50 * 1024 * 1024,
      concurrency: 6,
      flushDelayMs: 15_000,
      flushMaxWaitMs: 60_000,
      flushMaxBytes: 32 * 1024 * 1024,
      flushRetryMaxMs: 5 * 60_000,
      maxBlobBytes: 100 * 1024 * 1024,
      ...given,
    } as typeof this.o;
    this.client = opts.client;
    this.rules = opts.rules;
    this.cache = opts.cache;
    this.ttl = new TtlCache(this.o.remoteTtlMs, this.o.remoteMaxBytes);
    this.basePath = (opts.basePath ?? '').split('/').filter(Boolean).join('/');
  }

  private log(msg: string): void {
    (this.o.log ?? ((m) => console.log(`[github] ${m}`)))(msg);
  }

  // ---- paths --------------------------------------------------------------

  /** Normalise a vault-relative path; refuse traversal and `.git`, like the local driver. */
  private norm(rel: string): string {
    const stack: string[] = [];
    for (const seg of rel.replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (!stack.length) throw httpError('Path escapes vault', 400);
        stack.pop();
        continue;
      }
      if (seg === '.git') throw httpError('Path not allowed', 400);
      stack.push(seg);
    }
    return stack.join('/');
  }

  /** Path inside the repository for a vault-relative path. */
  private repoPath(rel: string): string {
    return this.basePath ? `${this.basePath}/${rel}` : rel;
  }

  async localRoot(): Promise<string> {
    throw httpError('This vault is stored in GitHub; there is no local folder', 501);
  }

  isIndexed(rel: string): boolean {
    try {
      return this.rules.resolve(this.norm(rel)).index;
    } catch {
      return false;
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  async init(): Promise<void> {
    const { owner, repo } = this.o;
    if (!owner || !repo) throw new Error('GitHub storage: "owner" and "repo" must be set in settings.storage.github');
    await this.cache.init();

    this.branch = this.o.branch ?? '';
    if (!this.branch) {
      try {
        this.branch = (await this.client.getRepo(owner, repo)).default_branch;
      } catch (e) {
        if (e instanceof GithubError && e.status === 404) {
          throw new Error(`GitHub repository ${owner}/${repo} was not found, or the token has no access to it`);
        }
        throw e;
      }
    }

    let sha: string;
    try {
      sha = await this.client.getBranchSha(owner, repo, this.branch);
    } catch (e) {
      if (e instanceof GithubError && e.status === 404) {
        throw new Error(`Branch "${this.branch}" was not found in ${owner}/${repo} (or the token has no access to it)`);
      }
      throw e;
    }

    const t0 = Date.now();
    const { index, rootTree } = await this.loadCommit(sha);
    await this.prefetch(index, [...index.files.keys()], sha);
    this.base = index;
    this.rootTree = rootTree;
    this.commitSha = sha;
    this.rebuildView();
    this.log(`${owner}/${repo}@${this.branch}: ${index.files.size} files indexed in ${Date.now() - t0} ms`);
  }

  /** Diagnostics for a status endpoint / UI. */
  status() {
    return {
      repo: `${this.o.owner}/${this.o.repo}`,
      branch: this.branch,
      commit: this.commitSha,
      files: this.idx.files.size,
      pending: this.pending.size,
      lastFlushError: this.lastFlushError,
      conflicts: [...this.conflicts],
      rate: this.client.rate,
      cache: this.cache.stats(),
    };
  }

  remoteInfo(): RemoteInfo {
    return {
      repo: `${this.o.owner}/${this.o.repo}`,
      branch: this.branch,
      commit: this.commitSha,
      pending: this.pending.size,
      lastError: this.lastFlushError,
      conflicts: [...this.conflicts],
    };
  }

  pendingChanges(): number {
    return this.pending.size;
  }

  // ---- snapshot loading ---------------------------------------------------

  /** Fetch the vault snapshot of a commit. */
  private async loadCommit(commitSha: string): Promise<{ index: TreeIndex; rootTree: string }> {
    const rootTree = await this.client.getCommitTreeSha(this.o.owner, this.o.repo, commitSha);
    return { index: await this.loadTree(rootTree), rootTree };
  }

  private async loadTree(rootTree: string): Promise<TreeIndex> {
    const baseTree = await this.resolveBase(rootTree);
    if (baseTree === null) return TreeIndex.build([]); // basePath doesn't exist (yet) → empty vault
    return TreeIndex.build(await this.listEntries(baseTree));
  }

  /** Tree sha of the basePath folder (or null if it doesn't exist). */
  private async resolveBase(rootTree: string): Promise<string | null> {
    const { owner, repo } = this.o;
    let cur = rootTree;
    for (const seg of this.basePath ? this.basePath.split('/') : []) {
      const t = await this.client.getTree(owner, repo, cur, false);
      const next = t.tree.find((e) => e.type === 'tree' && e.path === seg);
      if (!next) return null;
      cur = next.sha;
    }
    return cur;
  }

  private async listEntries(treeSha: string): Promise<TreeEntry[]> {
    const { owner, repo } = this.o;
    const r = await this.client.getTree(owner, repo, treeSha, true);
    if (!r.truncated) return r.tree;

    // GitHub truncates recursive trees past ~100k entries / 7 MB: walk level by level.
    this.log('recursive tree was truncated by GitHub; walking directories instead');
    const out: TreeEntry[] = [];
    let level = [{ sha: treeSha, prefix: '' }];
    while (level.length) {
      const next: typeof level = [];
      await mapLimit(level, this.o.concurrency, async (job) => {
        const t = await this.client.getTree(owner, repo, job.sha, false);
        if (t.truncated) throw new GithubError(`Directory "${job.prefix}" is too large for the GitHub API`, 502);
        for (const e of t.tree) {
          const p = job.prefix + e.path; // non-recursive entries carry only the basename
          out.push({ ...e, path: p });
          if (e.type === 'tree') next.push({ sha: e.sha, prefix: `${p}/` });
        }
      });
      level = next;
    }
    return out;
  }

  /** Rebuild the reader's view: committed snapshot + unsaved changes. */
  private rebuildView(): void {
    const v = this.base.clone();
    for (const [p, e] of this.pending) {
      if (e.kind === 'put') v.setFile(p, { sha: e.sha, size: e.size });
      else v.deleteFile(p);
    }
    this.idx = v;
  }

  // ---- content ------------------------------------------------------------

  private fetchBlob(sha: string): Promise<Buffer> {
    let p = this.inflight.get(sha);
    if (!p) {
      p = this.client.getBlob(this.o.owner, this.o.repo, sha).finally(() => this.inflight.delete(sha));
      this.inflight.set(sha, p);
    }
    return p;
  }

  private checkLfs(rel: string, buf: Buffer): Buffer {
    if (buf.length < 1024 && buf.toString('utf8', 0, LFS_PREFIX.length) === LFS_PREFIX) {
      throw httpError(`"${rel}" is stored in Git LFS, which the GitHub storage driver does not support yet`, 501);
    }
    return buf;
  }

  private async blobFor(rel: string, f: FileEntry): Promise<Buffer> {
    const cached = (await this.cache.get(f.sha)) ?? this.ttl.get(f.sha);
    if (cached) return this.checkLfs(rel, cached);

    const buf = await this.fetchBlob(f.sha);
    this.keep(rel, f.sha, buf);
    return this.checkLfs(rel, buf);
  }

  /** Store content according to the path's rule (mirror: pinned, lazy: LRU, remote: short TTL). */
  private keep(rel: string, sha: string, buf: Buffer): void | Promise<void> {
    const mode = this.rules.modeFor(rel);
    if (mode === 'remote') {
      this.ttl.put(sha, buf);
      return;
    }
    return this.cache.put(sha, buf).then(() => {
      if (mode === 'mirror') this.cache.pin(sha);
    });
  }

  /**
   * Make the `mirror` files among `paths` available locally. A handful are fetched
   * individually; beyond `tarballThreshold` one tarball request is cheaper than N
   * blob requests (and counts once against the rate limit).
   */
  private async prefetch(idx: TreeIndex, paths: string[], ref: string): Promise<void> {
    const want = new Set<string>();
    for (const p of paths) {
      const f = idx.files.get(p);
      if (!f || this.rules.modeFor(p) !== 'mirror') continue;
      this.cache.pin(f.sha);
      if (!(await this.cache.has(f.sha))) want.add(f.sha);
    }
    if (!want.size) return;

    if (want.size > this.o.tarballThreshold) {
      const pending = new Set(want);
      try {
        const stream = await this.client.tarball(this.o.owner, this.o.repo, ref);
        for await (const f of tarFiles(stream, { maxFileBytes: this.o.maxTarFileBytes })) {
          if (f.sha && f.data && pending.has(f.sha)) {
            pending.delete(f.sha);
            await this.cache.put(f.sha, f.data);
            this.cache.pin(f.sha);
            if (!pending.size) break;
          }
        }
      } catch (e: any) {
        this.log(`tarball prefetch failed (${e?.message}); fetching files individually`);
      }
      want.clear();
      for (const s of pending) want.add(s);
    }

    await mapLimit([...want], this.o.concurrency, async (sha) => {
      try {
        await this.cache.put(sha, await this.fetchBlob(sha));
        this.cache.pin(sha);
      } catch (e: any) {
        // Non-fatal: the file is simply fetched on demand when first read.
        this.log(`prefetch of ${sha.slice(0, 7)} failed: ${e?.message}`);
      }
    });
  }

  // ---- listing ------------------------------------------------------------

  async listTree(): Promise<TreeNode> {
    const name = this.basePath ? this.basePath.split('/').pop()! : this.o.repo;
    return this.idx.tree(name);
  }

  async listFiles(): Promise<string[]> {
    return this.idx.visibleFiles();
  }

  async listDir(rel: string): Promise<DirEntry[]> {
    const p = this.norm(rel);
    const kids = this.idx.children.get(p);
    if (!kids) throw notFound(rel);
    return [...kids].map(([name, isDir]) => ({ name, isDir }));
  }

  async exists(rel: string): Promise<boolean> {
    try {
      const p = this.norm(rel);
      return p === '' || this.idx.hasFile(p) || this.idx.hasDir(p);
    } catch {
      return false;
    }
  }

  // ---- reading content ------------------------------------------------------

  async readBuffer(rel: string): Promise<Buffer> {
    const p = this.norm(rel);
    const f = this.idx.files.get(p);
    if (!f) throw notFound(rel);
    const unsaved = this.pending.get(p);
    if (unsaved?.kind === 'put' && unsaved.data) return unsaved.data; // not committed yet
    return this.blobFor(p, f);
  }

  async readText(rel: string): Promise<string> {
    return (await this.readBuffer(rel)).toString('utf8');
  }

  /**
   * GitHub's Contents/Blobs APIs ignore Range, so the whole file is fetched (once,
   * then served from cache or the short `remote` TTL) and slices are cut locally.
   */
  async openFile(rel: string): Promise<ReadHandle> {
    const buf = await this.readBuffer(rel);
    return {
      size: buf.length,
      createReadStream: (range?: ByteRange) =>
        Readable.from(range ? buf.subarray(range.start, range.end + 1) : buf, { objectMode: false }),
    };
  }

  async resolveDirCaseInsensitive(rel: string): Promise<string> {
    const out: string[] = [];
    let cur = '';
    for (const seg of rel.split('/').filter(Boolean)) {
      let actual = seg;
      const kids = this.idx.children.get(cur);
      if (kids) {
        const dirs = [...kids].filter(([, isDir]) => isDir).map(([n]) => n);
        actual = dirs.find((n) => n === seg) ?? dirs.find((n) => n.toLowerCase() === seg.toLowerCase()) ?? seg;
      }
      out.push(actual);
      cur = cur ? `${cur}/${actual}` : actual;
    }
    return out.join('/');
  }

  // ---- writing: the unsaved-changes overlay ------------------------------------

  /** Record "this path now has this content". Mutates `pending` and the view. */
  private putEntry(p: string, sha: string, size: number, data?: Buffer): void {
    const cur = this.pending.get(p);
    const committed = this.base.files.get(p);
    // Back to exactly what is committed → nothing to save. (Not while a commit is in
    // flight: that commit may be about to change what "committed" means for this path.)
    if (!this.flushing && committed && committed.sha === sha) this.pending.delete(p);
    else this.pending.set(p, { kind: 'put', sha, size, data, baseSha: cur ? cur.baseSha : committed?.sha, ver: ++this.ver });
    this.idx.setFile(p, { sha, size });
  }

  private delEntry(p: string): void {
    const cur = this.pending.get(p);
    const committed = this.base.files.get(p);
    if (!this.flushing && !committed) this.pending.delete(p); // created and removed before ever being saved
    else this.pending.set(p, { kind: 'del', baseSha: cur ? cur.baseSha : committed?.sha, ver: ++this.ver });
    this.idx.deleteFile(p);
  }

  private applyPut(p: string, sha: string, size: number, data?: Buffer): StorageEvent[] {
    const existing = this.idx.files.get(p);
    if (existing && existing.sha === sha) return []; // identical content: nothing changed
    const ev: StorageEvent[] = [];
    const parts = p.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      dir = dir ? `${dir}/${parts[i]}` : parts[i];
      if (!this.idx.hasDir(dir)) ev.push({ type: 'addDir', path: dir });
    }
    this.putEntry(p, sha, size, data);
    ev.push({ type: existing ? 'change' : 'add', path: p });
    return ev;
  }

  private applyDel(p: string): StorageEvent[] {
    if (!this.idx.hasFile(p)) return [];
    this.delEntry(p);
    const ev: StorageEvent[] = [{ type: 'unlink', path: p }];
    const parts = p.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
      const dir = parts.slice(0, i).join('/');
      if (!this.idx.hasDir(dir)) ev.push({ type: 'unlinkDir', path: dir });
    }
    return ev;
  }

  /** A path can't be written if it is a folder, or lives below a file. */
  private assertWritable(p: string): void {
    if (!p) throw httpError('A file path is required', 400);
    if (this.idx.hasDir(p) && !this.idx.hasFile(p)) throw httpError(`"${p}" is a folder`, 409);
    this.assertParentsAreFolders(p);
  }

  private assertParentsAreFolders(p: string): void {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('/');
      if (this.idx.hasFile(anc)) throw httpError(`"${anc}" is a file, not a folder`, 409);
    }
  }

  private afterWrite(events: StorageEvent[]): void {
    this.emit(events);
    this.scheduleFlush();
  }

  private emit(events: StorageEvent[]): void {
    for (const e of events) {
      if (IGNORED_EVENT.test(e.path) || e.path.endsWith(`/${KEEP}`) || e.path === KEEP) continue;
      for (const h of this.handlers) {
        void Promise.resolve(h(e)).catch((err) => this.log(`handler error: ${err?.message}`));
      }
    }
  }

  private emitDiff(before: TreeIndex, after: TreeIndex): void {
    const d = diffTrees(before, after);
    this.emit([
      ...d.addedDirs.map((path) => ({ type: 'addDir' as const, path })),
      ...d.added.map((path) => ({ type: 'add' as const, path })),
      ...d.changed.map((path) => ({ type: 'change' as const, path })),
      ...d.removed.map((path) => ({ type: 'unlink' as const, path })),
      ...d.removedDirs.map((path) => ({ type: 'unlinkDir' as const, path })),
    ]);
  }

  private async trashName(): Promise<string> {
    return String((await this.o.trashDir?.()) ?? '.trash').replace(/^\/+|\/+$/g, '') || '.trash';
  }

  // ---- writing: operations -----------------------------------------------------

  async writeBuffer(rel: string, buf: Buffer): Promise<void> {
    const p = this.norm(rel);
    this.assertWritable(p);
    if (buf.length > this.o.maxBlobBytes) {
      throw httpError(`File is too large for GitHub (${Math.round(buf.length / 1048576)} MB, limit ${Math.round(this.o.maxBlobBytes / 1048576)} MB)`, 413);
    }
    this.afterWrite(this.applyPut(p, gitBlobSha(buf), buf.length, buf));
  }

  async writeText(rel: string, content: string): Promise<void> {
    await this.writeBuffer(rel, Buffer.from(content, 'utf8'));
  }

  async mkdir(rel: string): Promise<void> {
    const p = this.norm(rel);
    if (!p || this.idx.hasDir(p)) return;
    if (this.idx.hasFile(p)) throw httpError(`"${p}" is a file`, 409);
    this.assertParentsAreFolders(p);
    // Git has no empty folders: a placeholder file makes the folder real.
    this.afterWrite(this.applyPut(`${p}/${KEEP}`, gitBlobSha(Buffer.alloc(0)), 0, Buffer.alloc(0)));
  }

  /** Move every file at/below `a` to the same relative place below `b`. Content is never downloaded. */
  private moveFiles(a: string, b: string): StorageEvent[] {
    const moves = this.idx.filesUnder(a).map((f) => {
      const entry = this.idx.files.get(f)!;
      const unsaved = this.pending.get(f);
      return { from: f, to: b + f.slice(a.length), entry, data: unsaved?.kind === 'put' ? unsaved.data : undefined };
    });
    const ev: StorageEvent[] = [];
    for (const m of moves) ev.push(...this.applyDel(m.from));
    for (const m of moves) ev.push(...this.applyPut(m.to, m.entry.sha, m.entry.size, m.data));
    return ev;
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.norm(from);
    const b = this.norm(to);
    if (!a || !b) throw httpError('Cannot rename the vault root', 400);
    if (a === b) return;
    if (b.startsWith(`${a}/`)) throw httpError('Cannot move a folder into itself', 400);
    if (!this.idx.filesUnder(a).length) throw notFound(from);
    if (this.idx.hasFile(a)) this.assertWritable(b);
    else {
      if (this.idx.hasFile(b) || this.idx.hasDir(b)) throw httpError(`"${b}" already exists`, 409);
      this.assertParentsAreFolders(b);
    }
    this.afterWrite(this.moveFiles(a, b));
  }

  async copy(from: string, to: string): Promise<string[]> {
    const a = this.norm(from);
    const b = this.norm(to);
    if (!a || !b) throw httpError('Cannot copy the vault root', 400);
    if (b === a || b.startsWith(`${a}/`)) throw httpError('Cannot copy a folder into itself', 400);
    const src = this.idx.filesUnder(a);
    if (!src.length) throw notFound(from);
    if (this.idx.hasFile(b) || this.idx.hasDir(b)) throw httpError(`"${b}" already exists`, 409);
    this.assertParentsAreFolders(b);
    const ev: StorageEvent[] = [];
    const created: string[] = [];
    for (const f of src) {
      const entry = this.idx.files.get(f)!;
      const unsaved = this.pending.get(f);
      const target = b + f.slice(a.length);
      ev.push(...this.applyPut(target, entry.sha, entry.size, unsaved?.kind === 'put' ? unsaved.data : undefined));
      if (!target.split('/').some((s) => s === '.git' || s === 'node_modules')) created.push(target);
    }
    this.afterWrite(ev);
    return created;
  }

  async remove(rel: string): Promise<void> {
    const p = this.norm(rel);
    if (!p) throw httpError('Cannot delete the vault root', 400);
    const ev: StorageEvent[] = [];
    for (const f of this.idx.filesUnder(p)) {
      ev.push(...this.applyDel(f));
      this.trashedAt.delete(f);
    }
    if (ev.length) this.afterWrite(ev);
  }

  // ---- trash ------------------------------------------------------------------

  async trash(rel: string): Promise<string> {
    const p = this.norm(rel);
    if (!p) throw httpError('Cannot delete the vault root', 400);
    const tr = await this.trashName();
    if (!this.idx.filesUnder(p).length) throw notFound(rel);
    let dest = `${tr}/${p}`;
    if (this.idx.hasFile(dest) || this.idx.hasDir(dest)) {
      const { stem, ext } = splitExt(dest);
      dest = `${stem}.${Date.now()}${ext}`;
    }
    const now = Date.now();
    this.afterWrite(this.moveFiles(p, dest));
    for (const f of this.idx.filesUnder(dest)) this.trashedAt.set(f, now);
    return dest;
  }

  private async assertInTrash(rel: string): Promise<{ p: string; inner: string; tr: string }> {
    const p = this.norm(rel);
    const tr = await this.trashName();
    if (!p.startsWith(`${tr}/`) || p.length === tr.length + 1) throw httpError('Not a trash item', 400);
    return { p, inner: p.slice(tr.length + 1), tr };
  }

  async listTrash(): Promise<TrashItem[]> {
    const tr = await this.trashName();
    const items: TrashItem[] = [];
    for (const p of this.idx.filesUnder(tr)) {
      const name = p.slice(p.lastIndexOf('/') + 1);
      if (name === KEEP) continue;
      const dot = name.lastIndexOf('.');
      items.push({
        name,
        path: p,
        original: p.slice(tr.length + 1),
        ext: dot > 0 ? name.slice(dot).toLowerCase() : '',
        size: this.idx.files.get(p)!.size,
        // Git keeps no per-file time; known only for items trashed since this process started.
        mtime: this.trashedAt.get(p) ?? 0,
      });
    }
    return items.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  }

  async restoreFromTrash(trashRel: string): Promise<string> {
    const { p, inner } = await this.assertInTrash(trashRel);
    if (!this.idx.filesUnder(p).length) throw notFound(trashRel);
    let dest = inner;
    // Don't clobber something recreated at the same path after deletion.
    if (this.idx.hasFile(dest) || this.idx.hasDir(dest)) {
      const { stem, ext } = splitExt(dest);
      dest = `${stem}.restored-${Date.now()}${ext}`;
    }
    this.assertParentsAreFolders(dest);
    const files = this.idx.filesUnder(p);
    this.afterWrite(this.moveFiles(p, dest));
    for (const f of files) this.trashedAt.delete(f);
    return dest;
  }

  async deleteFromTrash(trashRel: string): Promise<void> {
    const { p } = await this.assertInTrash(trashRel);
    await this.remove(p);
  }

  async emptyTrash(): Promise<void> {
    const tr = await this.trashName();
    const ev: StorageEvent[] = [];
    for (const f of this.idx.filesUnder(tr)) ev.push(...this.applyDel(f));
    this.trashedAt.clear();
    if (ev.length) this.afterWrite(ev);
  }

  // ---- committing the overlay ------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => {});
    return p;
  }

  private pendingBytes(): number {
    let n = 0;
    for (const e of this.pending.values()) if (e.kind === 'put' && e.data) n += e.data.length;
    return n;
  }

  private scheduleFlush(retryDelay?: number): void {
    if (!this.pending.size) {
      this.firstUnsavedAt = 0;
      return;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const now = Date.now();
    if (!this.firstUnsavedAt) this.firstUnsavedAt = now;
    let delay: number;
    if (retryDelay !== undefined) delay = retryDelay;
    else if (this.pendingBytes() >= this.o.flushMaxBytes) delay = 0;
    else delay = Math.max(0, Math.min(this.o.flushDelayMs, this.firstUnsavedAt + this.o.flushMaxWaitMs - now));
    this.flushTimer = setTimeout(() => void this.autoFlush(), delay);
    this.flushTimer.unref?.();
  }

  private async autoFlush(): Promise<void> {
    this.flushTimer = null;
    try {
      await this.flush();
    } catch (e: any) {
      // Changes stay buffered; retry with exponential backoff (or when GitHub says rate limit lifts).
      this.flushFailures++;
      const backoff = Math.min(this.o.flushRetryMaxMs, 5_000 * 2 ** (this.flushFailures - 1));
      const delay = e instanceof GithubError && e.retryAfterMs ? Math.max(backoff, e.retryAfterMs) : backoff;
      this.scheduleFlush(delay);
    }
  }

  /** Commit all unsaved changes now (one commit). Resolves when they are on GitHub. */
  flush(): Promise<void> {
    return this.enqueue(() => this.flushLocked());
  }

  private async flushLocked(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const { owner, repo } = this.o;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!this.pending.size) break;
        this.flushing = true;

        // 1. Be on top of the remote branch, so our commit is a fast-forward.
        const head = await this.client.getBranchSha(owner, repo, this.branch);
        if (head !== this.commitSha) await this.syncTo(head);
        this.resolveConflicts();

        // 2. Snapshot what to save. Entries touched after this point keep a newer `ver` and stay pending.
        const batch = [...this.pending].filter(([p, e]) => e.kind === 'put' || this.base.files.has(p));
        for (const [p, e] of [...this.pending]) if (e.kind === 'del' && !this.base.files.has(p)) this.pending.delete(p);
        if (!batch.length) break;

        // 3. Upload only content the repository doesn't already have.
        const known = new Set<string>();
        for (const f of this.base.files.values()) known.add(f.sha);
        const uploads = new Map<string, Buffer>();
        for (const [, e] of batch) if (e.kind === 'put' && e.data && !known.has(e.sha)) uploads.set(e.sha, e.data);
        await mapLimit([...uploads], this.o.concurrency, async ([sha, data]) => {
          const got = await this.client.createBlob(owner, repo, data);
          if (got !== sha) throw new GithubError(`GitHub stored a different blob than expected (${got} ≠ ${sha})`, 502);
        });

        // 4. One tree change, one commit, then move the branch.
        const treeSha = await this.client.createTree(
          owner,
          repo,
          this.rootTree,
          batch.map(([p, e]) => ({ path: this.repoPath(p), mode: '100644' as const, type: 'blob' as const, sha: e.kind === 'put' ? e.sha : null })),
        );
        const message = this.commitMessage(batch);
        const commitSha = await this.client.createCommit(owner, repo, { message, tree: treeSha, parents: [head], author: this.o.author });
        try {
          await this.client.updateRef(owner, repo, this.branch, commitSha);
        } catch (e) {
          if (e instanceof NotFastForwardError) {
            this.log('branch moved while committing; re-reading and retrying');
            continue; // the loop re-syncs onto the new head and re-applies our changes
          }
          throw e;
        }

        // 5. Success: adopt the new snapshot, forget what was saved.
        for (const [p, e] of batch) if (e.kind === 'put' && e.data) await this.keep(p, e.sha, e.data);
        const fresh = await this.loadTree(treeSha);
        this.base = fresh;
        this.rootTree = treeSha;
        this.commitSha = commitSha;
        for (const [p, e] of batch) if (this.pending.get(p)?.ver === e.ver) this.pending.delete(p);
        this.flushing = false;
        for (const [p, e] of [...this.pending]) {
          const now = fresh.files.get(p);
          if (e.kind === 'put' && now && now.sha === e.sha) this.pending.delete(p); // already what's committed
          else if (e.kind === 'del' && !now) this.pending.delete(p);
          else e.baseSha = now?.sha; // later edits are now based on what we just committed
        }
        this.rebuildView();
        this.lastFlushError = '';
        this.flushFailures = 0;
        this.log(`committed ${batch.length} change(s) to ${owner}/${repo}@${this.branch} (${commitSha.slice(0, 7)})`);
      }
    } catch (e: any) {
      this.lastFlushError = this.describeFlushError(e);
      this.log(`saving to GitHub failed: ${this.lastFlushError}`);
      throw e;
    } finally {
      this.flushing = false;
      this.firstUnsavedAt = this.pending.size ? this.firstUnsavedAt || Date.now() : 0;
      if (this.pending.size && !this.flushTimer) this.scheduleFlush();
    }
  }

  private describeFlushError(e: any): string {
    const msg = String(e?.message ?? e);
    if (e instanceof GithubError && e.upstream === 403) {
      return `${msg} — the token needs the "Contents: Read and write" permission on this repository`;
    }
    return msg;
  }

  private commitMessage(batch: [string, Pending][]): string {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [p, e] of batch) {
      if (e.kind === 'del') deleted.push(p);
      else if (this.base.files.has(p)) modified.push(p);
      else added.push(p);
    }
    const visible = (l: string[]) => l.filter((p) => !p.endsWith(`/${KEEP}`));
    let subject: string;
    if (batch.length === 1) {
      const [p, e] = batch[0];
      subject = `${e.kind === 'del' ? 'Delete' : added.length ? 'Add' : 'Update'} ${p}`;
    } else {
      const parts = [
        added.length && `${added.length} added`,
        modified.length && `${modified.length} modified`,
        deleted.length && `${deleted.length} deleted`,
      ].filter(Boolean);
      subject = `Update ${batch.length} files (${parts.join(', ')})`;
    }
    const lines = [
      ...visible(added).map((p) => `A ${p}`),
      ...visible(modified).map((p) => `M ${p}`),
      ...visible(deleted).map((p) => `D ${p}`),
    ];
    const shown = lines.slice(0, 100);
    if (lines.length > shown.length) shown.push(`… and ${lines.length - shown.length} more`);
    return shown.length > 1 ? `${subject}\n\n${shown.join('\n')}\n\nSaved by WebObsidian` : `${subject}\n\nSaved by WebObsidian`;
  }

  /** Name for the copy that keeps our version when both sides edited a file. */
  private conflictName(p: string): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const { stem, ext } = splitExt(p);
    let name = `${stem} (conflict ${stamp})${ext}`;
    for (let i = 2; this.idx.hasFile(name) || this.base.files.has(name); i++) name = `${stem} (conflict ${stamp} ${i})${ext}`;
    return name;
  }

  /**
   * After catching up with the remote: for every unsaved path that the remote ALSO
   * changed since our edit was based on it, decide without losing anyone's work.
   */
  private resolveConflicts(): void {
    const ev: StorageEvent[] = [];
    for (const [p, e] of [...this.pending]) {
      const remote = this.base.files.get(p);
      if (remote?.sha === e.baseSha) continue; // the remote didn't touch it → clean
      if (e.kind === 'put') {
        if (remote?.sha === e.sha) {
          this.pending.delete(p); // the same content already arrived from the remote
        } else if (remote) {
          // Both sides changed it: the remote version stays, ours is kept alongside.
          const copy = this.conflictName(p);
          this.pending.delete(p);
          this.idx.setFile(p, { ...remote });
          ev.push({ type: 'change', path: p });
          ev.push(...this.applyPut(copy, e.sha, e.size, e.data));
          this.conflicts.push(copy);
          this.log(`conflict on "${p}": remote version kept, your version saved as "${copy}"`);
        }
        // remote deleted what we edited → keep ours (the commit re-creates it)
      } else if (remote) {
        // We deleted a file that was changed remotely: don't destroy their edit.
        this.pending.delete(p);
        this.idx.setFile(p, { ...remote });
        ev.push({ type: 'add', path: p });
        this.log(`"${p}" was changed on GitHub; your deletion was dropped`);
      } else {
        this.pending.delete(p); // both sides deleted it
      }
    }
    this.emit(ev);
  }

  // ---- change feed --------------------------------------------------------

  /** Adopt a newer commit of the branch, re-applying our unsaved changes on top, and report what changed for readers. */
  private async syncTo(sha: string): Promise<void> {
    const { index, rootTree } = await this.loadCommit(sha);
    const d = diffTrees(this.base, index);
    // Mirror files must be readable the moment their event fires (the search index
    // re-reads them), so fetch them before swapping the snapshot and notifying.
    await this.prefetch(index, [...d.added, ...d.changed], sha);
    const before = this.idx;
    this.base = index;
    this.rootTree = rootTree;
    this.commitSha = sha;
    this.rebuildView();
    this.emitDiff(before, this.idx);
  }

  /**
   * Look for commits made outside this process. One conditional request per call
   * (304 when nothing changed, which GitHub does not count against the limit); on a
   * new commit the trees are diffed and the changes emitted as storage events.
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      const sha = await this.client.getBranchSha(this.o.owner, this.o.repo, this.branch);
      if (sha !== this.commitSha) await this.syncTo(sha);
    });
  }

  async watch(handler: StorageEventHandler): Promise<StopWatching> {
    this.handlers.add(handler);
    if (!this.pollTimer) this.schedule(this.o.pollMs);
    return async () => {
      this.handlers.delete(handler);
      if (!this.handlers.size && this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  private schedule(delay: number): void {
    this.pollTimer = setTimeout(() => void this.tick(), delay);
    this.pollTimer.unref?.();
  }

  private async tick(): Promise<void> {
    let delay = this.o.pollMs;
    try {
      const rate = this.client.rate;
      // Keep the last slice of the hourly budget for user-initiated reads.
      if (rate && rate.remaining < 100 && Date.now() < rate.resetAt) {
        delay = Math.max(delay, rate.resetAt - Date.now());
      } else {
        await this.refresh();
        this.lastPollError = '';
      }
    } catch (e: any) {
      if (e instanceof GithubError && e.retryAfterMs) delay = Math.max(delay, e.retryAfterMs);
      const msg = String(e?.message ?? e);
      if (msg !== this.lastPollError) this.log(`poll failed: ${msg}`); // log each distinct failure once
      this.lastPollError = msg;
    }
    if (this.handlers.size) this.schedule(delay);
    else this.pollTimer = null;
  }
}
