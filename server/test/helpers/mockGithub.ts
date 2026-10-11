import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { gitBlobSha } from '../../src/storage/github/cache.js';

/**
 * In-process fake of the slice of the GitHub REST API the storage driver uses:
 * repo, branch ref (with ETag/304), commits, trees (flat + nested, optional
 * truncation), blobs and tarballs (via a 302 to a "codeload" path, with pax headers
 * like the real thing). Requests are counted per endpoint so tests can assert how
 * much API budget an operation costs, and failures can be injected.
 */

type Files = Map<string, Buffer>;
interface TreeEntryRaw {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}
interface Failure {
  match: RegExp;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  times: number;
}

// ---- tar writer (also used by tar unit tests) --------------------------------

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

export function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function padded(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem ? Buffer.concat([data, Buffer.alloc(512 - rem)]) : data;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`);
  return Buffer.from(`${len}${body}`);
}

/** Build a tar like GitHub's: global pax header, top-level dir, pax `path` for long/non-ASCII names. */
export function buildTar(prefix: string, files: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const g = paxRecord('comment', 'mock');
  parts.push(tarHeader('pax_global_header', g.length, 'g'), padded(g));
  parts.push(tarHeader(`${prefix}/`, 0, '5'));
  for (const [p, data] of files) {
    const full = `${prefix}/${p}`;
    if (Buffer.byteLength(full) > 99 || /[^\x00-\x7f]/.test(full)) {
      const rec = paxRecord('path', full);
      parts.push(tarHeader('pax_header', rec.length, 'x'), padded(rec));
      parts.push(tarHeader(full.slice(0, 50).replace(/[^\x00-\x7f]/g, '_'), data.length, '0'), padded(data));
    } else {
      parts.push(tarHeader(full, data.length, '0'), padded(data));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---- the server -----------------------------------------------------------------

export class MockGithub {
  readonly owner = 'o';
  readonly repo = 'r';
  readonly branch = 'main';
  readonly token = 'ghp_TESTTOKEN_do_not_leak';

  counts: Record<string, number> = {};
  refNotModified = 0;
  urls: string[] = [];
  /** If set, recursive tree responses are cut to this many entries with truncated:true. */
  truncateRecursiveAt: number | undefined;

  private server!: http.Server;
  private failures: Failure[] = [];
  private blobs = new Map<string, Buffer>();
  private trees = new Map<string, TreeEntryRaw[]>();
  private commits = new Map<string, { tree: string; files: Files }>();
  private head = '';
  private seq = 0;
  private remaining = 5000;
  url = '';

  async start(): Promise<void> {
    this.commit({}); // a repo always has an initial (empty) commit
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  count(key: string): number {
    return this.counts[key] ?? 0;
  }

  /** Make the next `times` requests whose path matches fail. */
  inject(match: RegExp, status: number, o: { headers?: Record<string, string>; body?: unknown; times?: number } = {}): void {
    this.failures.push({ match, status, headers: o.headers, body: o.body, times: o.times ?? 1 });
  }

  get headSha(): string {
    return this.head;
  }

  /** Apply changes on top of the head commit (null deletes a file); returns the new commit sha. */
  commit(changes: Record<string, string | Buffer | null>): string {
    const files: Files = new Map(this.head ? this.commits.get(this.head)!.files : []);
    for (const [p, v] of Object.entries(changes)) {
      if (v === null) files.delete(p);
      else files.set(p, Buffer.isBuffer(v) ? v : Buffer.from(v));
    }
    const tree = this.buildTree(files, '');
    const sha = createHash('sha1').update(`commit:${++this.seq}:${tree}`).digest('hex');
    this.commits.set(sha, { tree, files });
    this.head = sha;
    return sha;
  }

  private buildTree(files: Files, prefix: string): string {
    const entries: TreeEntryRaw[] = [];
    const dirs = new Map<string, Files>();
    for (const [p, data] of files) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const sha = gitBlobSha(data);
        this.blobs.set(sha, data);
        entries.push({ path: rest, mode: '100644', type: 'blob', sha, size: data.length });
      } else {
        const d = rest.slice(0, slash);
        if (!dirs.has(d)) dirs.set(d, new Map());
        dirs.get(d)!.set(p, data);
      }
    }
    for (const [d, sub] of dirs) {
      entries.push({ path: d, mode: '040000', type: 'tree', sha: this.buildTree(sub, `${prefix}${d}/`) });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const sha = createHash('sha1').update('tree:' + JSON.stringify(entries)).digest('hex');
    this.trees.set(sha, entries);
    return sha;
  }

  private flatten(treeSha: string, prefix = ''): TreeEntryRaw[] {
    const out: TreeEntryRaw[] = [];
    for (const e of this.trees.get(treeSha) ?? []) {
      out.push({ ...e, path: prefix + e.path });
      if (e.type === 'tree') out.push(...this.flatten(e.sha, `${prefix}${e.path}/`));
    }
    return out;
  }

  // ---- HTTP -------------------------------------------------------------------

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      'content-length': raw.length,
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(this.remaining),
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      ...headers,
    });
    res.end(raw);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '';
    this.urls.push(url);
    const path = url.split('?')[0];

    if (req.headers.authorization !== `Bearer ${this.token}` && !path.startsWith('/codeload/')) {
      return this.send(res, 401, { message: 'Bad credentials' });
    }
    const fail = this.failures.find((f) => f.times > 0 && f.match.test(url));
    if (fail) {
      fail.times--;
      return this.send(res, fail.status, fail.body ?? { message: 'injected failure' }, fail.headers);
    }

    const base = `/repos/${this.owner}/${this.repo}`;
    const bump = (k: string) => (this.counts[k] = (this.counts[k] ?? 0) + 1);
    let m: RegExpMatchArray | null;

    if (path === base) {
      bump('repo');
      this.remaining--;
      return this.send(res, 200, { default_branch: this.branch, private: true });
    }
    if (path === `${base}/git/ref/heads/${this.branch}`) {
      bump('ref');
      const etag = `"ref-${this.head}"`;
      if (req.headers['if-none-match'] === etag) {
        this.refNotModified++;
        return this.send(res, 304, '', { etag });
      }
      this.remaining--;
      return this.send(res, 200, { object: { sha: this.head } }, { etag });
    }
    if ((m = path.match(new RegExp(`^${base}/git/commits/([0-9a-f]{40})$`)))) {
      bump('commit');
      this.remaining--;
      const c = this.commits.get(m[1]);
      return c ? this.send(res, 200, { sha: m[1], tree: { sha: c.tree } }) : this.send(res, 404, { message: 'Not Found' });
    }
    if ((m = path.match(new RegExp(`^${base}/git/trees/([0-9a-f]{40})$`)))) {
      bump('tree');
      this.remaining--;
      if (!this.trees.has(m[1])) return this.send(res, 404, { message: 'Not Found' });
      if (url.includes('recursive=1')) {
        bump('tree-recursive');
        let tree = this.flatten(m[1]);
        let truncated = false;
        if (this.truncateRecursiveAt !== undefined && tree.length > this.truncateRecursiveAt) {
          tree = tree.slice(0, this.truncateRecursiveAt);
          truncated = true;
        }
        return this.send(res, 200, { sha: m[1], tree, truncated });
      }
      return this.send(res, 200, { sha: m[1], tree: this.trees.get(m[1]), truncated: false });
    }
    if ((m = path.match(new RegExp(`^${base}/git/blobs/([0-9a-f]{40})$`)))) {
      bump('blob');
      this.remaining--;
      const b = this.blobs.get(m[1]);
      if (!b) return this.send(res, 404, { message: 'Not Found' });
      return this.send(res, 200, b, { 'content-type': 'application/octet-stream' });
    }
    if ((m = path.match(new RegExp(`^${base}/tarball/([0-9a-f]{40})$`)))) {
      bump('tarball');
      this.remaining--;
      return this.send(res, 302, '', { location: `${this.url}/codeload/${m[1]}` });
    }
    if ((m = path.match(/^\/codeload\/([0-9a-f]{40})$/))) {
      bump('codeload');
      const c = this.commits.get(m[1]);
      if (!c) return this.send(res, 404, { message: 'Not Found' });
      const tar = buildTar(`${this.owner}-${this.repo}-${m[1].slice(0, 7)}`, [...c.files]);
      return this.send(res, 200, gzipSync(tar), { 'content-type': 'application/x-gzip' });
    }
    return this.send(res, 404, { message: `Not Found: ${path}` });
  }
}
