import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type {
  ByteRange,
  DirEntry,
  ReadHandle,
  StopWatching,
  StorageEventHandler,
  StorageEventType,
  TrashItem,
  TreeNode,
  VaultStorage,
} from './types.js';

export interface LocalFsOptions {
  /** Absolute-or-relative vault folder; read on every call so settings changes apply live. */
  root: () => Promise<string>;
  /** Trash folder name inside the vault (e.g. ".trash"). */
  trashDir: () => Promise<string>;
}

const IGNORED = new Set(['.git', 'node_modules']);

/** The vault is a plain folder on the local disk. */
export class LocalFsStorage implements VaultStorage {
  readonly kind = 'local' as const;

  /**
   * In-memory mtime/ctime cache so sort-by-time costs ONE stat per file total,
   * not 27k stats on every tree fetch (the tree is refetched on each fs event).
   * Filled lazily during listTree(); the watcher invalidates changed paths, so
   * steady-state tree fetches do zero extra syscalls.
   */
  private statCache = new Map<string, { m: number; c: number }>();

  constructor(private readonly opts: LocalFsOptions) {}

  // ---- paths --------------------------------------------------------------

  async localRoot(): Promise<string> {
    return path.resolve(await this.opts.root());
  }

  private toRel(root: string, abs: string): string {
    return path.relative(root, abs).split(path.sep).join('/');
  }

  /** Resolve a vault-relative path to an absolute one, refusing traversal. */
  async resolve(relPath: string): Promise<string> {
    const root = await this.localRoot();
    const clean = relPath.replace(/^[/\\]+/, '');
    const abs = path.resolve(root, clean);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      throw Object.assign(new Error('Path escapes vault'), { status: 400 });
    }
    // Never resolve into the vault's own git metadata: an authenticated write to
    // e.g. .git/hooks/post-merge would execute on the next git sync.
    if (path.relative(root, abs).split(path.sep).includes('.git')) {
      throw Object.assign(new Error('Path not allowed'), { status: 400 });
    }
    // Symlink guard: a symlink *inside* the vault could point outside it, which the
    // string-prefix check above can't catch. Resolve the real path of the deepest
    // existing ancestor and confirm it still lives under the vault root.
    await this.assertRealpathInVault(abs, root);
    return abs;
  }

  private async assertRealpathInVault(abs: string, root: string): Promise<void> {
    const realRoot = await fs.realpath(root).catch(() => root);
    const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realRoot && !real.startsWith(realRootSep)) {
          throw Object.assign(new Error('Path escapes vault'), { status: 400 });
        }
        return; // deepest existing ancestor is inside the vault; the rest is new
      } catch (e: any) {
        if (e?.status === 400) throw e; // our own escape error — propagate
        const parent = path.dirname(probe);
        if (parent === probe) return; // reached fs root without resolving — nothing to verify
        probe = parent;
      }
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  async init(): Promise<void> {
    await fs.mkdir(await this.localRoot(), { recursive: true });
  }

  // ---- listing ------------------------------------------------------------

  private async fileStat(abs: string, rel: string): Promise<{ m: number; c: number }> {
    const hit = this.statCache.get(rel);
    if (hit) return hit;
    let v = { m: 0, c: 0 };
    try {
      const st = await fs.stat(abs);
      // birthtime can be 0 on some Linux filesystems → fall back to mtime.
      v = { m: st.mtimeMs, c: st.birthtimeMs || st.mtimeMs };
    } catch { /* file vanished mid-walk — leave zeros */ }
    this.statCache.set(rel, v);
    return v;
  }

  /** Build the full tree (folders + files), skipping ignored dirs. */
  async listTree(): Promise<TreeNode> {
    const root = await this.localRoot();
    await fs.mkdir(root, { recursive: true });

    const walk = async (absDir: string): Promise<TreeNode[]> => {
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      // Stat files concurrently per directory (cached) so the one-time fill is fast;
      // steady state reads from statCache → no syscalls. mtime/ctime power sort-by-time.
      const nodes = await Promise.all(
        entries
          .filter((e) => !(IGNORED.has(e.name) || e.name.startsWith('.'))) // hide dotfiles like Obsidian
          .map(async (e): Promise<TreeNode | null> => {
            const abs = path.join(absDir, e.name);
            const rel = this.toRel(root, abs);
            if (e.isDirectory()) {
              return { name: e.name, path: rel, type: 'folder', children: await walk(abs) };
            }
            if (e.isFile()) {
              const { m, c } = await this.fileStat(abs, rel);
              return { name: e.name, path: rel, type: 'file', ext: path.extname(e.name).toLowerCase(), mtime: m, ctime: c };
            }
            return null;
          }),
      );
      const out = nodes.filter((n): n is TreeNode => n !== null);
      // folders first, then alphabetical (client re-sorts by the chosen order)
      out.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return out;
    };

    return { name: path.basename(root), path: '', type: 'folder', children: await walk(root) };
  }

  /**
   * Every visible file, depth-first in readdir order. Dotfiles/dot-dirs
   * (`.trash`, `.obsidian`, …) are skipped like the tree view does — a note moved
   * to `.trash` must not stay a live link target (and would otherwise shadow a
   * real file with the same basename).
   */
  async listFiles(): Promise<string[]> {
    const root = await this.localRoot();
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) out.push(this.toRel(root, abs));
      }
    };
    await walk(root);
    return out;
  }

  async listDir(rel: string): Promise<DirEntry[]> {
    const abs = await this.resolve(rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(await this.resolve(rel));
      return true;
    } catch {
      return false;
    }
  }

  // ---- content ------------------------------------------------------------

  async readText(rel: string): Promise<string> {
    return fs.readFile(await this.resolve(rel), 'utf8');
  }

  async readBuffer(rel: string): Promise<Buffer> {
    return fs.readFile(await this.resolve(rel));
  }

  async openFile(rel: string): Promise<ReadHandle> {
    const abs = await this.resolve(rel);
    const { size } = await fs.stat(abs);
    return {
      size,
      createReadStream: (range?: ByteRange) => createReadStream(abs, range),
    };
  }

  async writeText(rel: string, content: string): Promise<void> {
    const abs = await this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${Date.now()}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
  }

  async writeBuffer(rel: string, buf: Buffer): Promise<void> {
    const abs = await this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
  }

  // ---- structure ----------------------------------------------------------

  async mkdir(rel: string): Promise<void> {
    await fs.mkdir(await this.resolve(rel), { recursive: true });
  }

  /**
   * Resolve a directory path against the folders that already exist, matching each
   * segment case-insensitively. Prevents creating a case-duplicate folder (e.g. a
   * new `attachments` next to an existing `Attachments`) on case-sensitive
   * filesystems. Segments with no existing match are kept verbatim.
   */
  async resolveDirCaseInsensitive(rel: string): Promise<string> {
    const root = await this.localRoot();
    const segs = rel.split('/').filter(Boolean);
    const out: string[] = [];
    let curAbs = root;
    for (const seg of segs) {
      let actual = seg;
      try {
        const entries = await fs.readdir(curAbs, { withFileTypes: true });
        const exact = entries.find((e) => e.isDirectory() && e.name === seg);
        const ci = exact ?? entries.find((e) => e.isDirectory() && e.name.toLowerCase() === seg.toLowerCase());
        if (ci) actual = ci.name;
      } catch {
        /* directory doesn't exist yet — keep the requested casing */
      }
      out.push(actual);
      curAbs = path.join(curAbs, actual);
    }
    return out.join('/');
  }

  async rename(from: string, to: string): Promise<void> {
    const absFrom = await this.resolve(from);
    const absTo = await this.resolve(to);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
  }

  async copy(from: string, to: string): Promise<string[]> {
    const absFrom = await this.resolve(from);
    const absTo = await this.resolve(to);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.cp(absFrom, absTo, { recursive: true, errorOnExist: true, force: false });
    const root = await this.localRoot();
    const out: string[] = [];
    const st = await fs.stat(absTo);
    if (st.isDirectory()) {
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (IGNORED.has(e.name)) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else if (e.isFile()) out.push(this.toRel(root, abs));
        }
      };
      await walk(absTo);
    } else {
      out.push(this.toRel(root, absTo));
    }
    return out;
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(await this.resolve(rel), { recursive: true, force: true });
  }

  // ---- trash --------------------------------------------------------------

  private async trashRoot(): Promise<string> {
    return path.join(await this.localRoot(), await this.opts.trashDir());
  }

  private async pathExists(abs: string): Promise<boolean> {
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** Confirm `abs` lives inside the trash folder; return its trash-relative path. */
  private assertInTrash(abs: string, trashRoot: string): string {
    const rel = path.relative(trashRoot, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw Object.assign(new Error('Not a trash item'), { status: 400 });
    }
    return rel;
  }

  /** Remove now-empty directories upward from `dir`, stopping at (and keeping) `stopAt`. */
  private async pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
    let cur = path.resolve(dir);
    const root = path.resolve(stopAt);
    while (cur !== root && cur.startsWith(root + path.sep)) {
      try {
        const remaining = await fs.readdir(cur);
        if (remaining.length > 0) break;
        await fs.rmdir(cur);
      } catch {
        break;
      }
      cur = path.dirname(cur);
    }
  }

  async trash(rel: string): Promise<string> {
    const root = await this.localRoot();
    const absFrom = await this.resolve(rel);
    const trashRoot = await this.trashRoot();
    const dest = path.join(trashRoot, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // avoid collision
    let finalDest = dest;
    if (await this.pathExists(finalDest)) {
      const ext = path.extname(dest);
      finalDest = `${dest.slice(0, dest.length - ext.length)}.${Date.now()}${ext}`;
    }
    await fs.rename(absFrom, finalDest);
    return this.toRel(root, finalDest);
  }

  async listTrash(): Promise<TrashItem[]> {
    const root = await this.localRoot();
    const trashRoot = await this.trashRoot();
    const out: TrashItem[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // trash folder doesn't exist yet
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
        } else if (e.isFile()) {
          const st = await fs.stat(abs).catch(() => null);
          out.push({
            name: e.name,
            path: this.toRel(root, abs),
            original: path.relative(trashRoot, abs).split(path.sep).join('/'),
            ext: path.extname(e.name).toLowerCase(),
            size: st?.size ?? 0,
            mtime: st ? st.mtimeMs : 0,
          });
        }
      }
    };
    await walk(trashRoot);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  async restoreFromTrash(trashRel: string): Promise<string> {
    const trashRoot = await this.trashRoot();
    const absFrom = await this.resolve(trashRel);
    const relInTrash = this.assertInTrash(absFrom, trashRoot);
    let destRel = relInTrash.split(path.sep).join('/');
    let absTo = await this.resolve(destRel);
    // Don't clobber a file that was recreated at the same path after deletion.
    if (await this.pathExists(absTo)) {
      const ext = path.extname(destRel);
      destRel = `${destRel.slice(0, destRel.length - ext.length)}.restored-${Date.now()}${ext}`;
      absTo = await this.resolve(destRel);
    }
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
    await this.pruneEmptyDirs(path.dirname(absFrom), trashRoot);
    return destRel;
  }

  async deleteFromTrash(trashRel: string): Promise<void> {
    const trashRoot = await this.trashRoot();
    const abs = await this.resolve(trashRel);
    this.assertInTrash(abs, trashRoot);
    await fs.rm(abs, { recursive: true, force: true });
    await this.pruneEmptyDirs(path.dirname(abs), trashRoot);
  }

  async emptyTrash(): Promise<void> {
    const trashRoot = await this.trashRoot();
    let entries;
    try {
      entries = await fs.readdir(trashRoot);
    } catch {
      return; // nothing to empty
    }
    for (const name of entries) {
      await fs.rm(path.join(trashRoot, name), { recursive: true, force: true });
    }
  }

  // ---- change feed --------------------------------------------------------

  async watch(handler: StorageEventHandler): Promise<StopWatching> {
    const root = await this.localRoot();
    // WEBOBSIDIAN_WATCH: 'auto' (default) = native inotify with automatic polling
    // fallback when the host watch limit is exceeded; 'polling' = force polling.
    const forcePolling = (process.env.WEBOBSIDIAN_WATCH ?? 'auto').toLowerCase() === 'polling';

    let current: ReturnType<typeof chokidar.watch> | null = null;
    let stopped = false;

    const start = (usePolling: boolean): void => {
      const watcher = chokidar.watch(root, {
        // Ignore VCS/dep/trash dirs AND `.obsidian` — the desktop Obsidian app
        // rewrites its workspace/state files constantly, which otherwise floods the
        // server with events (→ broadcasts → full tree refetches) and pins the CPU.
        ignored: (p) => /(^|[/\\])(\.git|\.obsidian|node_modules|\.trash)([/\\]|$)/.test(p),
        ignoreInitial: true,
        persistent: true,
        usePolling,
        interval: 1000,
        binaryInterval: 3000,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });
      current = watcher;

      // On a fresh VPS the kernel's `fs.inotify.max_user_watches` is often far below
      // the file count of a large vault, so native watching fails with ENOSPC/EMFILE.
      // Self-heal by transparently switching to polling (no inotify), and tell the
      // operator how to restore native (cheaper) watching.
      let degraded = false;
      watcher.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (!usePolling && !degraded && (code === 'ENOSPC' || code === 'EMFILE')) {
          degraded = true;
          console.warn(
            `[watcher] native file watching hit ${code} (host inotify limit too low ` +
            `for this vault). Falling back to polling. For lower CPU, raise the limit: ` +
            `sudo sysctl -w fs.inotify.max_user_watches=524288`,
          );
          watcher.close().catch(() => {});
          if (!stopped) start(true);
          return;
        }
        console.error('[watcher] error:', err);
      });

      const emit = (absPath: string, type: StorageEventType): void => {
        const rel = this.toRel(root, absPath);
        // Drop the cached mtime/ctime so the next listTree re-stats just this file.
        this.statCache.delete(rel);
        void Promise.resolve(handler({ type, path: rel })).catch((e) => console.error('[watcher] handler error:', e));
      };
      watcher
        .on('add', (p) => emit(p, 'add'))
        .on('change', (p) => emit(p, 'change'))
        .on('unlink', (p) => emit(p, 'unlink'))
        .on('addDir', (p) => emit(p, 'addDir'))
        .on('unlinkDir', (p) => emit(p, 'unlinkDir'));
    };

    start(forcePolling);
    return async () => {
      stopped = true;
      await current?.close();
    };
  }
}
