import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../services/settings.js';
import { LocalFsStorage } from '../local.js';
import type { RemoteInfo, StopWatching, StorageEventHandler } from '../types.js';

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

function run(args: string[], cwd: string | undefined, remote: GitRemoteOptions, opts: { timeoutMs?: number; buffer?: boolean } = {}): Promise<string | Buffer> {
  const secrets = [remote.token, remote.token && Buffer.from(`${remote.username || 'git'}:${remote.token}`).toString('base64')].filter(Boolean) as string[];
  const scrub = (t: string) => secrets.reduce((a, s) => a.split(s).join('***'), t);
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, env: gitEnv(remote), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024,
      encoding: opts.buffer ? 'buffer' : 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout as string | Buffer);
      const text = scrub(String(stderr || stdout || (err as Error).message)).trim();
      reject(new GitError(text.split('\n').slice(-4).join(' ') || 'git failed', typeof (err as any).code === 'number' ? (err as any).code : null));
    });
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

  constructor(private readonly o: GitStorageOptions) {
    super({ root: async () => (o.basePath ? path.join(o.repoDir, o.basePath) : o.repoDir), trashDir: o.trashDir });
    this.remote = { url: o.url, branch: o.branch, username: o.username, token: o.token };
    this.branch = o.branch || '';
  }

  private g(args: string[], opts?: { timeoutMs?: number }): Promise<string> {
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
        const args = ['clone', '-q'];
        if (this.branch) args.push('--branch', this.branch);
        args.push('--', this.remote.url, repoDir);
        await run(args, undefined, this.remote, { timeoutMs: 15 * 60_000 });
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

  override writeText(rel: string, content: string) { return super.writeText(rel, content).then((r) => { this.markDirty(rel); return r; }); }
  override writeBuffer(rel: string, buf: Buffer) { return super.writeBuffer(rel, buf).then((r) => { this.markDirty(rel); return r; }); }
  override rename(from: string, to: string) { return super.rename(from, to).then((r) => { this.markDirty(from); this.markDirty(to); return r; }); }
  override copy(from: string, to: string) { return super.copy(from, to).then((r) => { this.markDirty(to); return r; }); }
  override remove(rel: string) { return super.remove(rel).then((r) => { this.markDirty(rel); return r; }); }
  override trash(rel: string) { return super.trash(rel).then((r) => { this.markDirty(rel); return r; }); }
  override restoreFromTrash(trashRel: string) { return super.restoreFromTrash(trashRel).then((r) => { this.markDirty(trashRel); return r; }); }
  override deleteFromTrash(trashRel: string) { return super.deleteFromTrash(trashRel).then((r) => { this.markDirty(trashRel); return r; }); }
  override emptyTrash() { return super.emptyTrash().then((r) => { this.markDirty('.trash'); return r; }); }

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

/** Build the Git driver from persisted settings. */
export function createGitStorage(
  s: Pick<Settings, 'storage' | 'git'>,
  opts: { dataDir: string; trashDir: () => Promise<string>; env?: NodeJS.ProcessEnv; tokenEnv?: string; cacheName?: string },
): GitStorage {
  const env = opts.env ?? process.env;
  const g = s.storage.git;
  if (!g.url) throw new Error('Git storage needs a remote URL (storage.git.url)');
  const token = env[opts.tokenEnv || GIT_TOKEN_ENV] || g.token;
  const email = g.authorEmail || env.WEBOBSIDIAN_GIT_AUTHOR_EMAIL?.trim() || (s.git.authorEmail !== 'webobsidian@localhost' ? s.git.authorEmail : '');
  return new GitStorage({
    url: g.url, branch: g.branch || undefined, username: g.username || env.WEBOBSIDIAN_GIT_USERNAME || undefined, token: token || undefined,
    basePath: g.basePath, repoDir: path.join(opts.dataDir, 'git', opts.cacheName ?? 'default', 'repo'), trashDir: opts.trashDir,
    pollMs: g.pollSec * 1000, flushDelayMs: g.flushSec * 1000,
    author: email ? { name: g.authorName || env.WEBOBSIDIAN_GIT_AUTHOR_NAME?.trim() || s.git.authorName || 'WebObsidian', email } : undefined,
  });
}
