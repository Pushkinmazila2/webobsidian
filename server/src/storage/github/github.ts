import { Readable } from 'node:stream';
import type {
  ByteRange,
  DirEntry,
  ReadHandle,
  StopWatching,
  StorageEvent,
  StorageEventHandler,
  TrashItem,
  TreeNode,
  VaultStorage,
} from '../types.js';
import { GithubClient, GithubError, type TreeEntry } from './client.js';
import { TtlCache, type ContentCache } from './cache.js';
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
  log?: (msg: string) => void;
}

const IGNORED_EVENT = /(^|\/)(\.git|\.obsidian|node_modules|\.trash)(\/|$)/;
const LFS_PREFIX = 'version https://git-lfs.github.com/spec/v1';

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

/**
 * The vault is a branch of a GitHub repository, reached through the REST API.
 *
 * - The tree comes from one recursive Trees request and is kept as an in-memory
 *   snapshot; content is fetched by blob sha and cached by sha (see rules.ts for
 *   what is mirrored, lazy or never stored).
 * - There are no filesystem events, so `watch()` polls the branch ref with a
 *   conditional request (a 304 is free) and diffs the old and new trees.
 *
 * Write operations are not implemented yet and fail with 501.
 */
export class GitHubStorage implements VaultStorage {
  readonly kind = 'github' as const;

  private readonly o: Required<
    Pick<GithubStorageOptions, 'pollMs' | 'remoteTtlMs' | 'remoteMaxBytes' | 'tarballThreshold' | 'maxTarFileBytes' | 'concurrency'>
  > &
    GithubStorageOptions;
  private readonly client: GithubClient;
  private readonly rules: Rules;
  private readonly cache: ContentCache;
  private readonly ttl: TtlCache;
  private readonly basePath: string;

  private branch = '';
  private commitSha = '';
  private idx: TreeIndex = TreeIndex.build([]);
  private inflight = new Map<string, Promise<Buffer>>();
  private lock: Promise<unknown> = Promise.resolve();
  private handlers = new Set<StorageEventHandler>();
  private timer: NodeJS.Timeout | null = null;
  private lastPollError = '';

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
    const idx = await this.fetchIndex(sha);
    await this.prefetch(idx, [...idx.files.keys()], sha);
    this.idx = idx;
    this.commitSha = sha;
    this.log(`${owner}/${repo}@${this.branch}: ${idx.files.size} files indexed in ${Date.now() - t0} ms`);
  }

  /** Diagnostics for a status endpoint / UI. */
  status() {
    return {
      repo: `${this.o.owner}/${this.o.repo}`,
      branch: this.branch,
      commit: this.commitSha,
      files: this.idx.files.size,
      rate: this.client.rate,
      cache: this.cache.stats(),
    };
  }

  // ---- tree loading -------------------------------------------------------

  private async fetchIndex(commitSha: string): Promise<TreeIndex> {
    const { owner, repo } = this.o;
    const rootTree = await this.client.getCommitTreeSha(owner, repo, commitSha);
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
    const mode = this.rules.modeFor(rel);
    if (mode === 'remote') {
      this.ttl.put(f.sha, buf);
    } else {
      await this.cache.put(f.sha, buf);
      if (mode === 'mirror') this.cache.pin(f.sha);
    }
    return this.checkLfs(rel, buf);
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

  // ---- content ------------------------------------------------------------

  async readBuffer(rel: string): Promise<Buffer> {
    const p = this.norm(rel);
    const f = this.idx.files.get(p);
    if (!f) throw notFound(rel);
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

  // ---- writes: not implemented yet ----------------------------------------

  private readOnly(): never {
    throw httpError('Writing to a GitHub-backed vault is not implemented yet', 501);
  }
  async writeText(_rel: string, _content: string): Promise<void> {
    this.readOnly();
  }
  async writeBuffer(_rel: string, _buf: Buffer): Promise<void> {
    this.readOnly();
  }
  async mkdir(_rel: string): Promise<void> {
    this.readOnly();
  }
  async rename(_from: string, _to: string): Promise<void> {
    this.readOnly();
  }
  async copy(_from: string, _to: string): Promise<string[]> {
    this.readOnly();
  }
  async remove(_rel: string): Promise<void> {
    this.readOnly();
  }
  async trash(_rel: string): Promise<string> {
    this.readOnly();
  }
  async restoreFromTrash(_trashRel: string): Promise<string> {
    this.readOnly();
  }
  async deleteFromTrash(_trashRel: string): Promise<void> {
    this.readOnly();
  }
  async emptyTrash(): Promise<void> {
    this.readOnly();
  }

  async listTrash(): Promise<TrashItem[]> {
    const dir = (await (this.o.trashDir ?? (() => '.trash'))()).replace(/^\/+|\/+$/g, '');
    const prefix = `${dir}/`;
    const items: TrashItem[] = [];
    for (const [p, f] of this.idx.files) {
      if (!p.startsWith(prefix)) continue;
      const name = p.slice(p.lastIndexOf('/') + 1);
      const dot = name.lastIndexOf('.');
      // Git keeps no per-file mtime; the deletion time is unknown until history is wired in.
      items.push({ name, path: p, original: p.slice(prefix.length), ext: dot > 0 ? name.slice(dot).toLowerCase() : '', size: f.size, mtime: 0 });
    }
    return items.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---- change feed --------------------------------------------------------

  /**
   * Look for commits made outside this process. One conditional request per call
   * (304 when nothing changed, which GitHub does not count against the limit); on a
   * new commit the trees are diffed and the changes emitted as storage events.
   */
  refresh(): Promise<void> {
    const run = async (): Promise<void> => {
      const { owner, repo } = this.o;
      const sha = await this.client.getBranchSha(owner, repo, this.branch);
      if (sha === this.commitSha) return;

      const next = await this.fetchIndex(sha);
      const d = diffTrees(this.idx, next);
      // Mirror files must be readable the moment their event fires (the search index
      // re-reads them), so fetch them before swapping the snapshot and notifying.
      await this.prefetch(next, [...d.added, ...d.changed], sha);
      this.idx = next;
      this.commitSha = sha;

      const events: StorageEvent[] = [
        ...d.addedDirs.map((path) => ({ type: 'addDir' as const, path })),
        ...d.added.map((path) => ({ type: 'add' as const, path })),
        ...d.changed.map((path) => ({ type: 'change' as const, path })),
        ...d.removed.map((path) => ({ type: 'unlink' as const, path })),
        ...d.removedDirs.map((path) => ({ type: 'unlinkDir' as const, path })),
      ].filter((e) => !IGNORED_EVENT.test(e.path));
      for (const e of events) {
        for (const h of this.handlers) {
          void Promise.resolve(h(e)).catch((err) => this.log(`handler error: ${err?.message}`));
        }
      }
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }

  async watch(handler: StorageEventHandler): Promise<StopWatching> {
    this.handlers.add(handler);
    if (!this.timer) this.schedule(this.o.pollMs);
    return async () => {
      this.handlers.delete(handler);
      if (!this.handlers.size && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
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
    else this.timer = null;
  }
}
