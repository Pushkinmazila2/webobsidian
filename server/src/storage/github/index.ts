import path from 'node:path';
import type { Settings } from '../../services/settings.js';
import { DiskContentCache, MemoryContentCache, type ContentCache } from './cache.js';
import { GithubClient } from './client.js';
import { GitHubStorage } from './github.js';
import { Rules } from './rules.js';

export { GitHubStorage } from './github.js';
export { GithubClient, GithubError, NotFastForwardError } from './client.js';
export { Rules, globToRegExp } from './rules.js';
export { MemoryContentCache, DiskContentCache, gitBlobSha } from './cache.js';

/** Env var that holds the GitHub token; takes precedence over settings.json. */
export const TOKEN_ENV = 'WEBOBSIDIAN_GITHUB_TOKEN';

function commitAuthor(s: Pick<Settings, 'git'>, env: NodeJS.ProcessEnv): { name: string; email: string } | undefined {
  const email = env.WEBOBSIDIAN_GIT_AUTHOR_EMAIL?.trim() || (s.git.authorEmail !== 'webobsidian@localhost' ? s.git.authorEmail : '');
  if (!email) return undefined;
  return { name: env.WEBOBSIDIAN_GIT_AUTHOR_NAME?.trim() || s.git.authorName || 'WebObsidian', email };
}

/** Build the GitHub driver from persisted settings. */
export function createGithubStorage(
  s: Pick<Settings, 'storage' | 'git'>,
  opts: {
    dataDir: string;
    trashDir: () => Promise<string>;
    env?: NodeJS.ProcessEnv;
    /** Env variable holding this vault's token (extra vaults); default: WEBOBSIDIAN_GITHUB_TOKEN. */
    tokenEnv?: string;
    /** Sub-folder of the disk cache for this vault (extra vaults), so caches never mix. */
    cacheName?: string;
  },
): GitHubStorage {
  const g = s.storage.github;
  const tokenVar = opts.tokenEnv || TOKEN_ENV;
  const token = (opts.env ?? process.env)[tokenVar] || g.token;
  if (!token) {
    throw new Error(`GitHub storage needs a token: set the ${tokenVar} environment variable (or storage.github.token in settings)`);
  }
  const cacheDir = (s.storage.cache.dir || path.join(opts.dataDir, 'cache')) + (opts.cacheName ? path.sep + opts.cacheName : '');
  const maxBytes = s.storage.cache.maxMB * 1024 * 1024;
  const cache: ContentCache =
    s.storage.cache.persist === 'disk'
      ? new DiskContentCache(cacheDir, maxBytes)
      : new MemoryContentCache(maxBytes);
  return new GitHubStorage({
    owner: g.owner,
    repo: g.repo,
    branch: g.branch || undefined,
    basePath: g.basePath,
    client: new GithubClient({ apiUrl: g.apiUrl, token }),
    rules: new Rules(s.storage.rules),
    cache,
    trashDir: opts.trashDir,
    pollMs: g.pollSec * 1000,
    flushDelayMs: g.flushSec * 1000,
    flushMaxWaitMs: Math.max(60_000, g.flushSec * 4000),
    holdMatch: g.holdMatch,
    holdDelayMs: g.holdSec * 1000,
    holdMaxWaitMs: Math.max(30 * 60_000, g.holdSec * 4000),
    // Commits are authored by the token's owner unless an identity is configured
    // (WEBOBSIDIAN_GIT_AUTHOR_NAME/EMAIL, or git.authorName/authorEmail in settings).
    author: commitAuthor(s, opts.env ?? process.env),
  });
}
