import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../services/settings.js';
import { LocalFsStorage } from '../local.js';
import type { DirEntry, FileVersion, ReadHandle, RemoteInfo, StopWatching, StorageEventHandler, TreeNode } from '../types.js';
import { Rules, type RuleConfig } from '../github/rules.js';
import { Readable } from 'node:stream';

/** Env variable holding the Git remote password/token; wins over settings.json. */
export const GIT_TOKEN_ENV = 'WEBOBSIDIAN_GIT_TOKEN';

export interface GitRemoteOptions {
  url: string;
  /** Empty = the remote's default branch. */
  branch?: string;
  username?: string;
  token?: string;
}

export interface GitStorageOptions extends GitRemoteOptions {
  /** Where the clone lives (server-owned; nothing else may write there). */
  repoDir: string;
  /** Folder inside the repository that is the vault root. */
  basePath?: string;
  trashDir: () => Promise<string>;
  /**
   * Same per-path rules as the GitHub driver: mirror = always in the working tree, lazy = fetched when first used and kept up to
   * `maxLazyBytes`, remote = never kept (read straight from the repository). Without rules everything is mirrored (a plain clone).
   */
  rules?: RuleConfig[];
  maxLazyBytes?: number;
  pollMs?: number;
  flushDelayMs?: number;
  author?: { name: string; email: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip credentials from a URL for display/logging. */
export function publicUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Environment for one git invocation. Credentials travel in an `http.<url>.extraHeader` set through GIT_CONFIG_*
 * variables, so they are never written to `.git/config`, never appear in a process list and are only sent to that URL.
 * Hooks, credential helpers and every transport except the network ones are switched off.
 */
function gitEnv(o: GitRemoteOptions): NodeJS.ProcessEnv {
  const cfg: [string, string][] = [['core.hooksPath', '/dev/null'], ['credential.helper', ''], ['core.askPass', '']];
  if (o.token && /^https?:\/\//i.test(o.url)) {
    const basic = Buffer.from(`${o.username || 'git'}:${o.token}`).toString('base64');
    cfg.push([`http.${publicUrl(o.url)}.extraHeader`, `Authorization: Basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1', // every path we pass is a literal file name
    GIT_ASKPASS: 'true',
    GIT_ALLOW_PROTOCOL: process.env.WEBOBSIDIAN_GIT_ALLOW_LOCAL === '1' ? 'https:http:ssh:git:file' : 'https:http:ssh:git',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_CONFIG_COUNT: String(cfg.length),
  };
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

class GitError extends Error {
  constructor(message: string, readonly code: number | null) { super(message); }
}

function run(args: string[], cwd: string | undefined, remote: GitRemoteOptions, opts: { timeoutMs?: number; buffer?: boolean; input?: string } = {}): Promise<string | Buffer> {
  const secrets = [remote.token, remote.token && Buffer.from(`${remote.username || 'git'}:${remote.token}`).toString('base64')].filter(Boolean) as string[];
  const scrub = (t: string) => secrets.reduce((a, s) => a.split(s).join('***'), t);
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd, env: gitEnv(remote), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024,
      encoding: opts.buffer ? 'buffer' : 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout as string | Buffer);
      const text = scrub(String(stderr || stdout || (err as Error).message)).trim();
      reject(new GitError(text.split('\n').slice(-4).join(' ') || 'git failed', typeof (err as any).code === 'number' ? (err as any).code : null));
    });
    if (opts.input !== undefined) { child.stdin?.on('error', () => {}); child.stdin?.end(opts.input); }
  });
}

/** Check a remote without cloning: reachable, credentials accepted, which branches it has. */
export async function testGitRemote(o: GitRemoteOptions): Promise<{ ok: true; branches: string[]; defaultBranch: string | null; empty: boolean } | { ok: false; error: string }> {
  try {
    const out = String(await run(['ls-remote', '--symref', '--heads', '--', o.url], undefined, o, { timeoutMs: 30_000 }));
    const branches = [...out.matchAll(/refs\/heads\/(\S+)\s*$/gm)].map((m) => m[1]).filter((b, i, a) => a.indexOf(b) === i);
    const head = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out)?.[1] ?? null;
    if (o.branch && branches.length && !branches.includes(o.branch)) return { ok: false, error: `The remote has no branch "${o.branch}" (it has: ${branches.slice(0, 8).join(', ')})` };
    return { ok: true, branches, defaultBranch: head, empty: branches.length === 0 };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * The vault is a clone of any Git remote (GitLab, Gitea, a bare repo over SSH, …). The server owns the clone: edits are written to
 * it like to a normal folder, committed in one batch after a quiet period, then merged with the remote and pushed. Nothing is
 * ever lost on a conflict — the remote's version is kept next to ours as "<name> (conflict …)".
 */
export class GitStorage extends LocalFsStorage {
  override readonly kind = 'git' as const;
  private readonly remote: GitRemoteOptions;
  private branch: string;
  private head: string | null = null;
  private readonly dirty = new Set<string>();
  private lastError: string | null = null;
  private readonly conflictCopies: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private firstDirtyAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** null = everything is mirrored (plain clone). */
  private readonly rules: Rules | null;
  /** Tracked files that are not in the working tree (vault-relative). */
  private readonly ghosts = new Set<string>();
  /** lazy/remote files currently in the working tree on purpose → last use (ms). Trimmed to maxLazyBytes after each sync. */
  private readonly kept = new Map<string, number>();

  constructor(private readonly o: GitStorageOptions) {
    super({ root: async () => (o.basePath ? path.join(o.repoDir, o.basePath) : o.repoDir), trashDir: o.trashDir });
    const rc = o.rules ?? [];
    const allMirror = rc.length > 0 && rc.every((x) => x.mode === 'mirror') && rc.some((x) => x.match.trim() === '**');
    this.rules = rc.length && !allMirror ? new Rules(rc) : null;
    this.remote = { url: o.url, branch: o.branch, username: o.username, token: o.token };
    this.branch = o.branch || '';
  }

  private g(args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<string> {
    return run(args, this.o.repoDir, this.remote, opts) as Promise<string>;
  }
  private gBuf(args: string[]): Promise<Buffer> {
    return run(args, this.o.repoDir, this.remote, { buffer: true }) as Promise<Buffer>;
  }
  /** Serialize every git operation on the clone. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  override isIndexed(rel: string): boolean {
    return this.rules ? this.rules.resolve(rel).index : true;
  }

  // ---- lifecycle ----------------------------------------------------------

  override async init(): Promise<void> {
    const { repoDir } = this.o;
    await fs.mkdir(path.dirname(repoDir), { recursive: true });
    const hasRepo = await fs.stat(path.join(repoDir, '.git')).then(() => true, () => false);
    if (!hasRepo) {
      await fs.rm(repoDir, { recursive: true, force: true }); // a failed earlier clone; the folder is ours
      const probe = await testGitRemote(this.remote);
      if (!probe.ok) throw new Error(`Cannot reach the Git remote: ${probe.error}`);
      if (probe.empty) {
        await fs.mkdir(repoDir, { recursive: true });
        this.branch ||= 'main';
        await this.g(['init', '-q', '-b', this.branch]);
        await this.g(['remote', 'add', 'origin', this.remote.url]);
      } else {
        const mk = (extra: string[]) => {
          const args = ['clone', '-q', ...extra];
          if (this.branch) args.push('--branch', this.branch);
          args.push('--', this.remote.url, repoDir);
          return run(args, undefined, this.remote, { timeoutMs: 15 * 60_000 });
        };
        if (this.rules) {
          // Partial clone: history and folders now, file contents only for what the rules keep (the rest on demand).
          try { await mk(['--no-checkout', '--filter=blob:none']); } catch {
            await fs.rm(repoDir, { recursive: true, force: true });
            await mk(['--no-checkout']); // the server does not support filters: full clone, same rules on top
          }
          await this.g(['read-tree', 'HEAD']);
          await this.g(['update-index', '--skip-worktree', '-z', '--stdin'], { input: await this.g(['ls-files', '-z']) });
        } else {
          await mk([]);
        }
      }
    } else {
      await this.g(['remote', 'set-url', 'origin', this.remote.url]).catch(() => this.g(['remote', 'add', 'origin', this.remote.url]));
    }
    // symbolic-ref also works in a repository that has no commit yet (an empty remote).
    const current = (await this.g(['symbolic-ref', '--short', 'HEAD']).catch(() => '')).trim();
    if (!this.branch) this.branch = current || 'main';
    else if (current !== this.branch) {
      const exists = (await this.g(['rev-parse', '--verify', '-q', `refs/heads/${this.branch}`]).catch(() => '')).trim();
      await this.g(exists ? ['checkout', '-q', this.branch] : ['checkout', '-q', '-B', this.branch]);
    }
    await fs.mkdir(await this.localRoot(), { recursive: true });
    this.head = (await this.g(['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
    await this.resparsify();
    // Pick up what is already different (a previous run died before pushing).
    if (await this.hasLocalChanges() || (await this.aheadBehind()).ahead > 0) this.markDirty('*');
    const every = this.o.pollMs ?? 60_000;
    this.pollTimer = setInterval(() => { void this.poll(); }, every);
    this.pollTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.flushTimer = this.pollTimer = null;
  }

  // ---- change tracking ----------------------------------------------------

  private markDirty(rel: string): void {
    if (this.disposed) return;
    this.dirty.add(rel);
    if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();
    this.schedule(this.o.flushDelayMs ?? 30_000);
  }

  private schedule(delay: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // Quiet period, but never later than 4× the delay after the first unsaved change.
    const cap = this.firstDirtyAt + (this.o.flushDelayMs ?? 30_000) * 4;
    const wait = Math.max(0, Math.min(delay, cap - Date.now()));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((e) => { console.error('[git storage] save failed:', e?.message ?? e); this.schedule(60_000); });
    }, wait);
    this.flushTimer.unref();
  }

  override async writeText(rel: string, content: string) { await this.prepareWrite(rel); await super.writeText(rel, content); this.markDirty(rel); }
  override async writeBuffer(rel: string, buf: Buffer) { await this.prepareWrite(rel); await super.writeBuffer(rel, buf); this.markDirty(rel); }
  override async rename(from: string, to: string) {
    await this.materialize(from);
    if (this.ghosts.has(to)) await this.prepareWrite(to);
    await super.rename(from, to);
    this.markDirty(from); this.markDirty(to);
  }
  override async copy(from: string, to: string) {
    await this.materialize(from);
    if (this.ghosts.size && await this.exists(to)) throw Object.assign(new Error(`Destination exists: ${to}`), { code: 'ERR_FS_CP_EEXIST' });
    const r = await super.copy(from, to);
    this.markDirty(to);
    return r;
  }
  override async remove(rel: string) {
    const hadGhosts = await this.dropGhosts(rel);
    try { await super.remove(rel); } catch (e: any) { if (!(hadGhosts && e?.code === 'ENOENT')) throw e; }
    this.markDirty(rel);
  }
  override async trash(rel: string) { await this.materialize(rel); const r = await super.trash(rel); this.markDirty(rel); return r; }
  override async listTrash() { await this.materialize(await this.o.trashDir()); return super.listTrash(); }
  override async restoreFromTrash(trashRel: string) { await this.materialize(trashRel); const r = await super.restoreFromTrash(trashRel); this.markDirty(trashRel); return r; }
  override async deleteFromTrash(trashRel: string) {
    const hadGhosts = await this.dropGhosts(trashRel);
    try { await super.deleteFromTrash(trashRel); } catch (e: any) { if (!(hadGhosts && e?.code === 'ENOENT')) throw e; }
    this.markDirty(trashRel);
  }
  override async emptyTrash() { await this.dropGhosts(await this.o.trashDir()); await super.emptyTrash(); this.markDirty('.trash'); }

  override async watch(handler: StorageEventHandler): Promise<StopWatching> {
    // Files changed behind our back (plugins writing through localRoot, a manual edit) count as unsaved too.
    return super.watch((ev) => { this.markDirty(ev.path); return handler(ev); });
  }

  // ---- git plumbing -------------------------------------------------------

  private async hasLocalChanges(): Promise<boolean> {
    return (await this.g(['status', '--porcelain'])).trim() !== '';
  }

  private async remoteHasBranch(): Promise<boolean> {
    return (await this.g(['rev-parse', '--verify', '-q', `refs/remotes/origin/${this.branch}`]).catch(() => '')).trim() !== '';
  }

  private async aheadBehind(): Promise<{ ahead: number; behind: number }> {
    if (!(await this.remoteHasBranch())) {
      const any = (await this.g(['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
      return { ahead: any ? 1 : 0, behind: 0 };
    }
    const [a, b] = (await this.g(['rev-list', '--left-right', '--count', `HEAD...origin/${this.branch}`])).trim().split(/\s+/).map(Number);
    return { ahead: a || 0, behind: b || 0 };
  }

  private identity(): string[] {
    const a = this.o.author ?? { name: 'WebObsidian', email: 'webobsidian@localhost' };
    return ['-c', `user.name=${a.name}`, '-c', `user.email=${a.email}`];
  }

  /** Commit everything that changed in the working tree as one commit. Returns the number of files. */
  private async commitLocal(): Promise<number> {
    await this.g(['add', '-A']);
    const names = (await this.g(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
    if (!names.length) return 0;
    const shown = names.slice(0, 5).map((n) => path.posix.basename(n)).join(', ');
    const msg = `Update ${names.length} file${names.length === 1 ? '' : 's'}: ${shown}${names.length > 5 ? ', …' : ''}`;
    await this.g([...this.identity(), 'commit', '-q', '-m', msg]);
    return names.length;
  }

  /** Merge origin/<branch> into HEAD; conflicts never lose data (see class comment). */
  private async mergeRemote(): Promise<void> {
    try {
      await this.g([...this.identity(), 'merge', '--no-edit', '-q', `origin/${this.branch}`]);
      return;
    } catch (e: any) {
      const unmerged = (await this.g(['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '')).split('\0').filter(Boolean);
      if (!unmerged.length) {
        await this.g(['merge', '--abort']).catch(() => {});
        throw e;
      }
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '');
      for (const file of unmerged) {
        const stages = (await this.g(['ls-files', '-u', '-z', '--', file])).split('\0').filter(Boolean).map((l) => Number(l.split(/\s+/)[2]));
        const hasOurs = stages.includes(2);
        const hasTheirs = stages.includes(3);
        if (hasOurs && hasTheirs) {
          // Both edited: keep ours in place, store theirs beside it.
          const theirs = await this.gBuf(['show', `:3:${file}`]);
          const ext = path.posix.extname(file);
          const copy = `${file.slice(0, file.length - ext.length)} (conflict ${stamp})${ext}`;
          await fs.writeFile(path.join(this.o.repoDir, copy), theirs);
          this.conflictCopies.push(copy);
          await this.g(['checkout', '--ours', '--', file]);
          await this.g(['add', '--', file, copy]);
        } else if (hasTheirs) {
          await this.g(['checkout', '--theirs', '--', file]); // we deleted it, they edited: keep their edit
          await this.g(['add', '--', file]);
        } else {
          await this.g(['add', '--', file]); // they deleted it, we edited: keep our edit
        }
      }
      await this.g([...this.identity(), 'commit', '-q', '--no-edit']);
    }
  }

  /** Commit local edits, bring in the remote's, push. The one place that talks to the network. */
  private syncImpl(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.commitLocal();
        for (let attempt = 0; attempt < 4; attempt++) {
          await this.g(['fetch', '-q', 'origin'], { timeoutMs: 5 * 60_000 });
          if (await this.remoteHasBranch()) {
            const { behind } = await this.aheadBehind();
            if (behind > 0) await this.mergeRemote();
          }
          const { ahead } = await this.aheadBehind();
          if (ahead === 0) break;
          try {
            await this.g(['push', '-q', 'origin', `HEAD:refs/heads/${this.branch}`], { timeoutMs: 5 * 60_000 });
            break;
          } catch (e: any) {
            // Somebody pushed in between: fetch + merge again.
            if (attempt < 3 && /rejected|non-fast-forward|fetch first|stale info/i.test(String(e?.message))) { await sleep(300 * (attempt + 1)); continue; }
            throw e;
          }
        }
        this.head = (await this.g(['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
        await this.resparsify(true);
        this.dirty.clear();
        this.firstDirtyAt = 0;
        this.lastError = null;
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
        throw e;
      }
    });
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.dirty.size === 0 && await this.serial(() => this.hasLocalChanges())) this.markDirty('*');
      if (this.dirty.size === 0) await this.syncImpl(); // nothing pending: just look at the remote
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
    }
  }


  // ---- rules: which files live in the working tree ----------------------------------------------------------

  private toRepo(rel: string): string { return this.o.basePath ? `${this.o.basePath}/${rel}` : rel; }
  private fromRepo(p: string): string | null {
    const b = this.o.basePath;
    if (!b) return p;
    return p.startsWith(`${b}/`) ? p.slice(b.length + 1) : null;
  }
  /** Should this file be in the working tree right now? */
  private wants(rel: string | null): boolean {
    if (rel === null) return false; // outside the vault folder: never needed
    if (!this.rules) return true;
    const mode = this.rules.resolve(rel).mode;
    return mode === 'mirror' || (mode === 'lazy' && this.kept.has(rel));
  }
  private visible(rel: string): boolean {
    return rel.split('/').every((seg) => !seg.startsWith('.') && seg !== 'node_modules');
  }
  private nul(paths: string[]): string { return paths.length ? `${paths.join('\0')}\0` : ''; }

  /**
   * Make the working tree match the rules: fetch files that should be there, drop (and forget) those that should not.
   * Dropping = skip-worktree bit + delete the file; the repository still has it and it is read on demand. Files with
   * uncommitted edits are never touched. Called after init and after every sync (merges bring in files of every kind).
   */
  private async resparsify(trim = false): Promise<void> {
    if (!this.rules) return;
    if (trim && this.o.maxLazyBytes) {
      const root = await this.localRoot();
      const sizes: { rel: string; at: number; size: number }[] = [];
      for (const [rel, at] of this.kept) {
        const size = await fs.stat(path.join(root, rel)).then((st) => st.size, () => 0);
        sizes.push({ rel, at, size });
      }
      let total = sizes.reduce((a, b) => a + b.size, 0);
      for (const e of sizes.sort((a, b) => a.at - b.at)) {
        if (total <= this.o.maxLazyBytes) break;
        this.kept.delete(e.rel);
        total -= e.size;
      }
    }
    const entries = (await this.g(['ls-files', '-v', '-z'])).split('\0').filter(Boolean);
    const modified = new Set((await this.g(['diff', '--name-only', '-z'])).split('\0').filter(Boolean));
    const fetchNow: string[] = [];
    const drop: string[] = [];
    this.ghosts.clear();
    for (const e of entries) {
      const tag = e[0];
      const p = e.slice(2);
      const rel = this.fromRepo(p);
      const want = this.wants(rel);
      if (tag === 'S' || tag === 's') {
        if (want) fetchNow.push(p);
        else if (rel !== null) this.ghosts.add(rel);
      } else if (!want && !modified.has(p)) {
        drop.push(p);
        if (rel !== null) this.ghosts.add(rel);
      }
    }
    if (fetchNow.length) {
      await this.g(['update-index', '--no-skip-worktree', '-z', '--stdin'], { input: this.nul(fetchNow) });
      await this.g(['restore', '--source=HEAD', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: this.nul(fetchNow), timeoutMs: 15 * 60_000 });
    }
    if (drop.length) {
      await this.g(['update-index', '--skip-worktree', '-z', '--stdin'], { input: this.nul(drop) });
      const dirs = new Set<string>();
      for (const p of drop) {
        await fs.rm(path.join(this.o.repoDir, p), { force: true });
        dirs.add(path.dirname(p));
      }
      // tidy up folders that became empty (deepest first), never the repository itself
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
        for (let cur = d; cur && cur !== '.'; cur = path.dirname(cur)) {
          try { await fs.rmdir(path.join(this.o.repoDir, cur)); } catch { break; }
        }
      }
    }
  }

  /** Put tracked-but-absent files (a file, or everything under a folder) into the working tree. */
  private async materialize(rel: string): Promise<void> {
    if (!this.rules || !this.ghosts.size) return;
    const hit = [...this.ghosts].filter((g) => rel === '' || g === rel || g.startsWith(`${rel}/`));
    if (!hit.length) return;
    const paths = hit.map((g) => this.toRepo(g));
    await this.serial(async () => {
      await this.g(['update-index', '--no-skip-worktree', '-z', '--stdin'], { input: this.nul(paths) });
      await this.g(['restore', '--source=HEAD', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: this.nul(paths), timeoutMs: 15 * 60_000 });
    });
    for (const g of hit) { this.ghosts.delete(g); this.kept.set(g, Date.now()); }
  }

  /** About to overwrite `rel`: make git look at the working-tree file again (no download needed). */
  private async prepareWrite(rel: string): Promise<void> {
    if (!this.rules) return;
    if (this.ghosts.has(rel)) {
      await this.serial(() => this.g(['update-index', '--no-skip-worktree', '--', this.toRepo(rel)]));
      this.ghosts.delete(rel);
    }
    if (this.rules.resolve(rel).mode === 'lazy') this.kept.set(rel, Date.now());
  }

  private async readGhost(rel: string): Promise<Buffer> {
    if (this.rules?.resolve(rel).mode === 'remote') {
      return this.serial(() => this.gBuf(['cat-file', 'blob', `:${this.toRepo(rel)}`])); // straight from the repository, nothing kept
    }
    await this.materialize(rel);
    return super.readBuffer(rel);
  }

  /** Remove tracked-but-absent files under `rel` from the repository (the next commit records the deletion). */
  private async dropGhosts(rel: string): Promise<boolean> {
    const hit = [...this.ghosts].filter((g) => g === rel || g.startsWith(`${rel}/`));
    if (!hit.length) return false;
    await this.serial(() => this.g(['update-index', '--force-remove', '-z', '--stdin'], { input: this.nul(hit.map((g) => this.toRepo(g))) }));
    for (const g of hit) { this.ghosts.delete(g); this.kept.delete(g); }
    return true;
  }

  override async listFiles(): Promise<string[]> {
    const base = await super.listFiles();
    if (!this.ghosts.size) return base;
    const have = new Set(base);
    for (const g of this.ghosts) if (!have.has(g) && this.visible(g)) base.push(g);
    return base;
  }

  override async listTree(): Promise<TreeNode> {
    const tree = await super.listTree();
    if (!this.ghosts.size) return tree;
    for (const g of this.ghosts) {
      if (!this.visible(g)) continue;
      const segs = g.split('/');
      let node = tree;
      for (let i = 0; i < segs.length - 1; i++) {
        let child = node.children!.find((c) => c.name === segs[i] && c.type === 'folder');
        if (!child) {
          child = { name: segs[i], path: segs.slice(0, i + 1).join('/'), type: 'folder', children: [] };
          node.children!.push(child);
        }
        node = child;
      }
      const name = segs[segs.length - 1];
      if (!node.children!.some((c) => c.name === name)) {
        node.children!.push({ name, path: g, type: 'file', ext: path.extname(name).toLowerCase(), mtime: 0, ctime: 0 });
      }
    }
    const sort = (n: TreeNode): void => {
      if (!n.children) return;
      n.children.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)));
      n.children.forEach(sort);
    };
    sort(tree);
    return tree;
  }

  override async listDir(rel: string): Promise<DirEntry[]> {
    const prefix = rel ? `${rel.replace(/\/+$/, '')}/` : '';
    const kids = new Map<string, boolean>();
    for (const g of this.ghosts) {
      if (!g.startsWith(prefix)) continue;
      const rest = g.slice(prefix.length);
      const i = rest.indexOf('/');
      const name = i < 0 ? rest : rest.slice(0, i);
      kids.set(name, (kids.get(name) ?? false) || i >= 0);
    }
    let base: DirEntry[];
    try { base = await super.listDir(rel); } catch (e) { if (!kids.size) throw e; base = []; }
    const have = new Set(base.map((e) => e.name));
    for (const [name, isDir] of kids) if (!have.has(name)) base.push({ name, isDir });
    return base;
  }

  override async exists(rel: string): Promise<boolean> {
    if (await super.exists(rel)) return true;
    if (!this.ghosts.size) return false;
    if (this.ghosts.has(rel)) return true;
    const prefix = `${rel.replace(/\/+$/, '')}/`;
    for (const g of this.ghosts) if (g.startsWith(prefix)) return true;
    return false;
  }

  override async readText(rel: string): Promise<string> {
    return this.ghosts.has(rel) ? (await this.readGhost(rel)).toString('utf8') : super.readText(rel);
  }
  override async readBuffer(rel: string): Promise<Buffer> {
    return this.ghosts.has(rel) ? this.readGhost(rel) : super.readBuffer(rel);
  }
  override async openFile(rel: string): Promise<ReadHandle> {
    if (!this.ghosts.has(rel)) return super.openFile(rel);
    if (this.rules?.resolve(rel).mode !== 'remote') { await this.materialize(rel); return super.openFile(rel); }
    const buf = await this.readGhost(rel);
    return { size: buf.length, createReadStream: (range) => Readable.from([range ? buf.subarray(range.start, range.end + 1) : buf]) };
  }

  // ---- version history ---------------------------------------------------------------------------------

  private repoFile(rel: string): string {
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length || parts.some((x) => x === '..' || x === '.')) throw Object.assign(new Error('Bad path'), { status: 400 });
    return this.toRepo(parts.join('/'));
  }

  /** `git log` for one file: author name, e-mail and (for the hosts that put it there) no login — the name is what was committed. */
  async history(rel: string, limit = 50): Promise<FileVersion[]> {
    const out = await this.g(['log', `--max-count=${Math.min(200, Math.max(1, limit))}`, '--format=%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1e', '--', this.repoFile(rel)]).catch(() => '');
    return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
      const [hash, date, author, email, message] = r.split('\x1f');
      return { hash, date, author, ...(email ? { email } : {}), message: message ?? '' };
    });
  }

  async fileAt(hash: string, rel: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw Object.assign(new Error('Bad commit id'), { status: 400 });
    return this.g(['show', `${hash}:${this.repoFile(rel)}`]); // a partial clone fetches the one blob it lacks
  }

  // ---- VaultStorage remote API ---------------------------------------------

  pendingChanges(): number { return this.dirty.size; }
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this.syncImpl();
  }
  async refresh(): Promise<void> { await this.syncImpl(); }
  remoteInfo(): RemoteInfo {
    return {
      repo: publicUrl(this.remote.url), branch: this.branch, commit: this.head, pending: this.dirty.size, held: 0,
      lastError: this.lastError, conflicts: [...this.conflictCopies],
    };
  }
}

/** Placeholder address for a login: github.com's own noreply form links the commit to the account, elsewhere it is just a label. */
function noreplyEmail(login: string, url: string): string {
  const safe = login.replace(/[^\w.-]/g, '');
  return /^(https?:\/\/|git@)(www\.)?github\.com[/:]/i.test(url) ? `${safe}@users.noreply.github.com` : `${safe}@localhost`;
}

/** Build the Git driver from persisted settings. */
export function createGitStorage(
  s: Pick<Settings, 'storage' | 'git'>,
  opts: { dataDir: string; trashDir: () => Promise<string>; env?: NodeJS.ProcessEnv; tokenEnv?: string; cacheName?: string },
): GitStorage {
  const env = opts.env ?? process.env;
  const g = s.storage.git;
  if (!g.url) throw new Error('Git storage needs a remote URL (storage.git.url)');
  const token = env[opts.tokenEnv || GIT_TOKEN_ENV] || g.token;
  const login = g.username || env.WEBOBSIDIAN_GIT_USERNAME?.trim() || '';
  const globalEmail = s.git.authorEmail !== 'webobsidian@localhost' ? s.git.authorEmail : '';
  const name = g.authorName || env.WEBOBSIDIAN_GIT_AUTHOR_NAME?.trim() || (s.git.authorName !== 'WebObsidian' ? s.git.authorName : '') || login || 'WebObsidian';
  // Commits are signed with the account's login unless an identity is configured, so the history says who made each one.
  const email = g.authorEmail || env.WEBOBSIDIAN_GIT_AUTHOR_EMAIL?.trim() || globalEmail || (login ? noreplyEmail(login, g.url) : '');
  return new GitStorage({
    url: g.url, branch: g.branch || undefined, username: g.username || env.WEBOBSIDIAN_GIT_USERNAME || undefined, token: token || undefined,
    basePath: g.basePath, repoDir: path.join(opts.dataDir, 'git', opts.cacheName ?? 'default', 'repo'), trashDir: opts.trashDir,
    pollMs: g.pollSec * 1000, flushDelayMs: g.flushSec * 1000,
    rules: s.storage.rules, maxLazyBytes: s.storage.cache.maxMB * 1024 * 1024,
    author: email ? { name, email } : undefined,
  });
}
