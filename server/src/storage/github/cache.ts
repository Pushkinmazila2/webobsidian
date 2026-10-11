import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Content cache keyed by git blob sha.
 *
 * Because the key is a hash of the content, entries are immutable: there is never
 * anything to invalidate when a file changes (it simply has a new sha), and two
 * files with identical content share one entry. Pinned entries (mirror files) are
 * never evicted; everything else is evicted least-recently-used once the cache
 * exceeds its byte budget.
 */
export interface ContentCache {
  init(): Promise<void>;
  has(sha: string): Promise<boolean>;
  get(sha: string): Promise<Buffer | undefined>;
  put(sha: string, data: Buffer): Promise<void>;
  pin(sha: string): void;
  unpin(sha: string): void;
  stats(): { entries: number; bytes: number; pinned: number };
}

/** git's blob object id: sha1("blob <len>\0" + content). */
export function gitBlobSha(data: Buffer): string {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

/** In-memory LRU. Nothing touches the server's disk. */
export class MemoryContentCache implements ContentCache {
  private map = new Map<string, Buffer>();
  private pinned = new Set<string>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  async init(): Promise<void> {}

  async has(sha: string): Promise<boolean> {
    return this.map.has(sha);
  }

  async get(sha: string): Promise<Buffer | undefined> {
    const v = this.map.get(sha);
    if (v) {
      this.map.delete(sha); // refresh recency
      this.map.set(sha, v);
    }
    return v;
  }

  async put(sha: string, data: Buffer): Promise<void> {
    const prev = this.map.get(sha);
    if (prev) {
      this.map.delete(sha);
      this.bytes -= prev.length;
    }
    this.map.set(sha, data);
    this.bytes += data.length;
    this.evict(sha);
  }

  private evict(keep: string): void {
    if (this.bytes <= this.maxBytes) return;
    for (const [sha, buf] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      if (sha === keep || this.pinned.has(sha)) continue;
      this.map.delete(sha);
      this.bytes -= buf.length;
    }
  }

  pin(sha: string): void {
    this.pinned.add(sha);
  }
  unpin(sha: string): void {
    this.pinned.delete(sha);
  }
  stats() {
    return { entries: this.map.size, bytes: this.bytes, pinned: this.pinned.size };
  }
}

/** Disk-backed LRU: `<dir>/<sha[0:2]>/<sha>`. Survives restarts for a fast cold start. */
export class DiskContentCache implements ContentCache {
  private index = new Map<string, { size: number; last: number }>();
  private pinned = new Set<string>();
  private bytes = 0;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  private file(sha: string): string {
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const sub of await fs.readdir(this.dir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      for (const name of await fs.readdir(path.join(this.dir, sub)).catch(() => [] as string[])) {
        if (!/^[0-9a-f]{40}$/.test(name)) continue; // ignores *.tmp leftovers
        const st = await fs.stat(path.join(this.dir, sub, name)).catch(() => null);
        if (!st) continue;
        this.index.set(name, { size: st.size, last: st.mtimeMs });
        this.bytes += st.size;
      }
    }
  }

  async has(sha: string): Promise<boolean> {
    return this.index.has(sha);
  }

  async get(sha: string): Promise<Buffer | undefined> {
    const meta = this.index.get(sha);
    if (!meta) return undefined;
    try {
      const buf = await fs.readFile(this.file(sha));
      if (buf.length !== meta.size) throw new Error('size mismatch'); // torn/foreign file → treat as a miss
      meta.last = Date.now();
      return buf;
    } catch {
      this.index.delete(sha);
      this.bytes -= meta.size;
      return undefined;
    }
  }

  async put(sha: string, data: Buffer): Promise<void> {
    const prev = this.index.get(sha);
    if (prev) {
      prev.last = Date.now();
      return;
    }
    const f = this.file(sha);
    await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, f);
    this.index.set(sha, { size: data.length, last: Date.now() });
    this.bytes += data.length;
    await this.evict(sha);
  }

  private async evict(keep: string): Promise<void> {
    if (this.bytes <= this.maxBytes) return;
    const victims = [...this.index.entries()]
      .filter(([sha]) => sha !== keep && !this.pinned.has(sha))
      .sort((a, b) => a[1].last - b[1].last);
    for (const [sha, meta] of victims) {
      if (this.bytes <= this.maxBytes * 0.9) break;
      await fs.rm(this.file(sha), { force: true });
      this.index.delete(sha);
      this.bytes -= meta.size;
    }
  }

  pin(sha: string): void {
    this.pinned.add(sha);
  }
  unpin(sha: string): void {
    this.pinned.delete(sha);
  }
  stats() {
    return { entries: this.index.size, bytes: this.bytes, pinned: this.pinned.size };
  }
}

/**
 * Short-lived in-memory cache for `remote` files: absorbs the burst of repeated
 * reads (editor + preview, a video player issuing many Range requests) without
 * keeping the content around.
 */
export class TtlCache {
  private map = new Map<string, { data: Buffer; expires: number }>();
  private bytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
  ) {}

  get(sha: string): Buffer | undefined {
    const e = this.map.get(sha);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.map.delete(sha);
      this.bytes -= e.data.length;
      return undefined;
    }
    return e.data;
  }

  put(sha: string, data: Buffer): void {
    this.sweep();
    if (data.length > this.maxBytes) return;
    const prev = this.map.get(sha);
    if (prev) this.bytes -= prev.data.length;
    this.map.set(sha, { data, expires: Date.now() + this.ttlMs });
    this.bytes += data.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      if (k === sha) continue;
      this.map.delete(k);
      this.bytes -= v.data.length;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expires < now) {
        this.map.delete(k);
        this.bytes -= v.data.length;
      }
    }
  }
}
