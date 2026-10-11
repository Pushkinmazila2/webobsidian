import { Readable } from 'node:stream';

/**
 * Thin GitHub REST client for the storage driver.
 *
 * - Conditional requests: JSON endpoints opted in with `etag: true` send
 *   If-None-Match; a 304 is answered from the cached body and does NOT count
 *   against the rate limit.
 * - Rate limits: remaining/reset are tracked from response headers; when the
 *   budget is exhausted we fail fast instead of hammering the API.
 * - Retries: network errors and 5xx are retried with backoff; primary/secondary
 *   rate limits wait for `retry-after` if it is short enough.
 * - Errors are mapped to statuses that are safe to pass to the browser. A GitHub
 *   401/403 is NEVER forwarded as 401: the web client treats 401 as "session
 *   expired" and would log the user out.
 * - The token is only ever placed in the Authorization header; it never appears
 *   in URLs, error messages or logs.
 */

export class GithubError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

export interface RateInfo {
  limit: number;
  remaining: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
}

export interface GithubClientOptions {
  apiUrl: string;
  token: string;
  userAgent?: string;
  /** Retries for network errors / 5xx / short rate-limit waits. Default 3. */
  maxRetries?: number;
  /** Base for exponential backoff. Default 300ms. */
  retryBaseMs?: number;
  /** Longest rate-limit wait we are willing to sit through. Default 30s. */
  maxRateWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface TreeResult {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

interface RequestOpts {
  accept?: string;
  headers?: Record<string, string>;
  /** Cache the body by ETag and revalidate with If-None-Match. */
  etag?: boolean;
}

const DEFAULT_ACCEPT = 'application/vnd.github+json';
export const RAW_ACCEPT = 'application/vnd.github.raw+json';

export class GithubClient {
  /** Latest rate-limit snapshot from response headers (null until a response arrives). */
  rate: RateInfo | null = null;

  private readonly apiUrl: string;
  private readonly token: string;
  private readonly ua: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxRateWaitMs: number;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private etags = new Map<string, { etag: string; body: Buffer }>();

  constructor(opts: GithubClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.ua = opts.userAgent ?? 'WebObsidian';
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 300;
    this.maxRateWaitMs = opts.maxRateWaitMs ?? 30_000;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---- core ---------------------------------------------------------------

  private trackRate(h: Headers): void {
    const limit = h.get('x-ratelimit-limit');
    const remaining = h.get('x-ratelimit-remaining');
    const reset = h.get('x-ratelimit-reset');
    if (limit === null || remaining === null) return;
    this.rate = {
      limit: Number(limit),
      remaining: Number(remaining),
      resetAt: reset ? Number(reset) * 1000 : (this.rate?.resetAt ?? 0),
    };
  }

  /** Perform a GET with retry / rate-limit handling. Resolves with a 2xx or 304 Response. */
  private async send(path: string, o: RequestOpts): Promise<{ res: Response; cached?: Buffer }> {
    const url = this.apiUrl + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: o.accept ?? DEFAULT_ACCEPT,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.ua,
      ...o.headers,
    };
    const cacheKey = o.etag ? `${headers.Accept}|${path}` : '';
    const hit = cacheKey ? this.etags.get(cacheKey) : undefined;
    if (hit) headers['If-None-Match'] = hit.etag;

    for (let attempt = 0; ; attempt++) {
      if (this.rate && this.rate.remaining <= 0 && Date.now() < this.rate.resetAt) {
        const wait = this.rate.resetAt - Date.now();
        throw new GithubError(`GitHub rate limit exhausted; resets in ~${Math.ceil(wait / 1000)}s`, 429, wait);
      }

      let res: Response;
      try {
        res = await this.doFetch(url, { headers, redirect: 'follow' });
      } catch (e: any) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBaseMs * 3 ** attempt);
          continue;
        }
        throw new GithubError(`GitHub unreachable: ${e?.cause?.code ?? e?.message ?? 'network error'}`, 502);
      }
      this.trackRate(res.headers);

      if (res.status === 304 && hit) return { res, cached: hit.body };
      if (res.ok) return { res };

      // ---- error path: read the (small) body once for the message
      const text = await res.text().catch(() => '');
      let message = '';
      try {
        message = JSON.parse(text)?.message ?? '';
      } catch {
        message = text.slice(0, 200);
      }

      if (res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBaseMs * 3 ** attempt);
          continue;
        }
        throw new GithubError(`GitHub error ${res.status}`, 502);
      }

      if (res.status === 429 || (res.status === 403 && (this.isRateLimited(res, message)))) {
        const wait = this.rateWaitMs(res);
        if (wait <= this.maxRateWaitMs && attempt < this.maxRetries) {
          await this.sleep(wait);
          continue;
        }
        throw new GithubError(`GitHub rate limit exceeded; retry in ~${Math.ceil(wait / 1000)}s`, 429, wait);
      }

      if (res.status === 401) throw new GithubError('GitHub token is invalid or expired', 502);
      if (res.status === 403) throw new GithubError(`GitHub denied access: ${message || 'forbidden'}`, 502);
      if (res.status === 404) throw new GithubError('Not found on GitHub (or the token has no access to it)', 404);
      throw new GithubError(`GitHub error ${res.status}: ${message}`.trim(), 502);
    }
  }

  private isRateLimited(res: Response, message: string): boolean {
    return (
      res.headers.get('x-ratelimit-remaining') === '0' ||
      res.headers.has('retry-after') ||
      /rate limit/i.test(message)
    );
  }

  private rateWaitMs(res: Response): number {
    const ra = Number(res.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) return ra * 1000;
    if (res.headers.get('x-ratelimit-remaining') === '0' && this.rate) {
      return Math.max(0, this.rate.resetAt - Date.now()) + 1000;
    }
    return 60_000; // secondary rate limit without a hint
  }

  private async request(path: string, o: RequestOpts = {}): Promise<Buffer> {
    const { res, cached } = await this.send(path, o);
    if (cached) return cached;
    const body = Buffer.from(await res.arrayBuffer());
    const etag = res.headers.get('etag');
    if (o.etag && etag) {
      if (this.etags.size > 500) this.etags.delete(this.etags.keys().next().value as string);
      this.etags.set(`${o.accept ?? DEFAULT_ACCEPT}|${path}`, { etag, body });
    }
    return body;
  }

  private async json<T>(path: string, o: RequestOpts = {}): Promise<T> {
    return JSON.parse((await this.request(path, o)).toString('utf8')) as T;
  }

  // ---- endpoints ----------------------------------------------------------

  private repoPath(owner: string, repo: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async getRepo(owner: string, repo: string): Promise<{ default_branch: string; private: boolean }> {
    return this.json(this.repoPath(owner, repo));
  }

  /** Commit sha the branch points to. Conditional: cheap (304) when nothing changed. */
  async getBranchSha(owner: string, repo: string, branch: string): Promise<string> {
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    const r = await this.json<{ object: { sha: string } }>(`${this.repoPath(owner, repo)}/git/ref/heads/${ref}`, { etag: true });
    return r.object.sha;
  }

  async getCommitTreeSha(owner: string, repo: string, commitSha: string): Promise<string> {
    const r = await this.json<{ tree: { sha: string } }>(`${this.repoPath(owner, repo)}/git/commits/${commitSha}`);
    return r.tree.sha;
  }

  async getTree(owner: string, repo: string, treeSha: string, recursive: boolean): Promise<TreeResult> {
    return this.json(`${this.repoPath(owner, repo)}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`);
  }

  /** Raw blob bytes (up to GitHub's 100 MB limit). */
  async getBlob(owner: string, repo: string, sha: string): Promise<Buffer> {
    return this.request(`${this.repoPath(owner, repo)}/git/blobs/${sha}`, { accept: RAW_ACCEPT });
  }

  /** Whole-repo .tar.gz as a stream (GitHub redirects to codeload). */
  async tarball(owner: string, repo: string, ref: string): Promise<Readable> {
    const { res } = await this.send(`${this.repoPath(owner, repo)}/tarball/${ref}`, {});
    if (!res.body) throw new GithubError('GitHub returned an empty tarball', 502);
    return Readable.fromWeb(res.body as any);
  }
}
