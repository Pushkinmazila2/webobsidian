import { applyStoragePatch } from './storagepatch.js';

/**
 * Storage settings from environment variables, so a container can start fully
 * configured (`docker run -e WEBOBSIDIAN_GITHUB_REPO=owner/repo …`).
 *
 * Every variable that is set OVERRIDES settings.json and locks that field in the
 * UI. Overrides live only in memory — they are never written to settings.json, so
 * removing a variable restores whatever was saved before. A malformed value stops
 * the server at startup with a message naming the variable (a typo should not
 * silently fall back to a different vault).
 */

export const TOKEN_ENV_NAME = 'WEBOBSIDIAN_GITHUB_TOKEN';

export interface StorageEnv {
  /** Patch in the same shape the settings API accepts. */
  patch: Record<string, any>;
  /** settings path (e.g. "github.owner", "rules") → name of the variable that sets it. */
  lockedBy: Record<string, string>;
}

type Env = Record<string, string | undefined>;

const PRESETS: Record<string, { match: string; mode: string; index: boolean }[]> = {
  // notes mirrored + searchable, everything else fetched on demand (the default)
  default: [
    { match: '.obsidian/**', mode: 'mirror', index: false },
    { match: '**/*.{md,markdown,canvas}', mode: 'mirror', index: true },
    { match: '**', mode: 'lazy', index: false },
  ],
  // nothing kept on the server; search/backlinks unavailable
  'remote-only': [{ match: '**', mode: 'remote', index: false }],
  // download everything
  'mirror-all': [{ match: '**', mode: 'mirror', index: true }],
};

/**
 * Compact rule syntax: `pattern=mode[:index|:noindex]`, separated by `;` or newlines.
 *   .obsidian/**=mirror;**​/*.md=mirror:index;Private/**=remote;**=lazy
 * or a JSON array of {match, mode, index?}.
 */
export function parseRules(raw: string): { match: string; mode: string; index?: boolean }[] {
  const text = raw.trim();
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('expected a JSON array');
    return arr;
  }
  return text
    .split(/[;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((item) => {
      const eq = item.lastIndexOf('=');
      if (eq <= 0) throw new Error(`"${item}" is not "pattern=mode"`);
      const match = item.slice(0, eq).trim();
      const [mode, flag, ...rest] = item.slice(eq + 1).trim().toLowerCase().split(':');
      if (rest.length || (flag !== undefined && flag !== 'index' && flag !== 'noindex')) {
        throw new Error(`"${item}": use mode or mode:index or mode:noindex`);
      }
      const rule: { match: string; mode: string; index?: boolean } = { match, mode };
      if (flag) rule.index = flag === 'index';
      return rule;
    });
}

/** `owner/repo`, `github.com/owner/repo(.git)` or a full https/ssh URL → [owner, repo]. */
export function parseRepoRef(raw: string): [string, string] {
  const m = raw.trim().match(/^(?:(?:https?:\/\/|git@)?[^/:\s]*github[^/:\s]*[/:])?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error('expected "owner/repo" or a GitHub repository URL');
  return [m[1], m[2]];
}

const bool = (v: string) => /^(1|true|yes|on)$/i.test(v.trim());

export function readStorageEnv(env: Env = process.env): StorageEnv {
  const patch: Record<string, any> = {};
  const lockedBy: Record<string, string> = {};
  const set = (path: string, name: string, value: unknown) => {
    const parts = path.split('.');
    let o = patch;
    for (const k of parts.slice(0, -1)) o = o[k] ??= {};
    o[parts[parts.length - 1]] = value;
    lockedBy[path] = name;
  };
  const get = (name: string): string | undefined => {
    const v = env[name];
    return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
  };
  const num = (name: string, v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name}: "${v}" is not a number`);
    return n;
  };
  const wrap = <T>(name: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e: any) {
      throw new Error(`Invalid environment variable ${name}: ${e?.message ?? e}`);
    }
  };

  const repoRef = get('WEBOBSIDIAN_GITHUB_REPO');
  const ownerEnv = get('WEBOBSIDIAN_GITHUB_OWNER');
  if (repoRef) {
    wrap('WEBOBSIDIAN_GITHUB_REPO', () => {
      if (repoRef.includes('/') || /github/i.test(repoRef)) {
        const [owner, repo] = parseRepoRef(repoRef);
        set('github.owner', 'WEBOBSIDIAN_GITHUB_REPO', ownerEnv ?? owner);
        set('github.repo', 'WEBOBSIDIAN_GITHUB_REPO', repo);
      } else {
        if (!ownerEnv) throw new Error('give "owner/repo", or set WEBOBSIDIAN_GITHUB_OWNER as well');
        set('github.repo', 'WEBOBSIDIAN_GITHUB_REPO', repoRef);
      }
    });
  }
  if (ownerEnv) set('github.owner', 'WEBOBSIDIAN_GITHUB_OWNER', ownerEnv);

  const branch = get('WEBOBSIDIAN_GITHUB_BRANCH');
  if (branch) set('github.branch', 'WEBOBSIDIAN_GITHUB_BRANCH', branch);
  const base = get('WEBOBSIDIAN_GITHUB_BASE_PATH');
  if (base !== undefined) set('github.basePath', 'WEBOBSIDIAN_GITHUB_BASE_PATH', base);
  const api = get('WEBOBSIDIAN_GITHUB_API_URL');
  if (api) set('github.apiUrl', 'WEBOBSIDIAN_GITHUB_API_URL', api);
  for (const [name, path] of [
    ['WEBOBSIDIAN_GITHUB_POLL_SEC', 'github.pollSec'],
    ['WEBOBSIDIAN_GITHUB_FLUSH_SEC', 'github.flushSec'],
    ['WEBOBSIDIAN_CACHE_MAX_MB', 'cache.maxMB'],
  ] as const) {
    const v = get(name);
    if (v) set(path, name, wrap(name, () => num(name, v)));
  }
  const persist = get('WEBOBSIDIAN_CACHE');
  if (persist) set('cache.persist', 'WEBOBSIDIAN_CACHE', persist.toLowerCase());
  const cacheDir = get('WEBOBSIDIAN_CACHE_DIR');
  if (cacheDir) set('cache.dir', 'WEBOBSIDIAN_CACHE_DIR', cacheDir);

  const preset = get('WEBOBSIDIAN_STORAGE_PRESET');
  if (preset) {
    const rules = PRESETS[preset.toLowerCase()];
    if (!rules) throw new Error(`Invalid environment variable WEBOBSIDIAN_STORAGE_PRESET: "${preset}" (use ${Object.keys(PRESETS).join(', ')})`);
    set('rules', 'WEBOBSIDIAN_STORAGE_PRESET', rules.map((r) => ({ ...r })));
  }
  const rulesRaw = get('WEBOBSIDIAN_STORAGE_RULES');
  if (rulesRaw) set('rules', 'WEBOBSIDIAN_STORAGE_RULES', wrap('WEBOBSIDIAN_STORAGE_RULES', () => parseRules(rulesRaw)));

  // The token is read from the environment by the driver itself; here it only locks the UI field.
  if (get(TOKEN_ENV_NAME)) lockedBy['github.token'] = TOKEN_ENV_NAME;

  const driver = get('WEBOBSIDIAN_STORAGE');
  if (driver) set('driver', 'WEBOBSIDIAN_STORAGE', driver.toLowerCase());
  else if (repoRef || ownerEnv) set('driver', 'WEBOBSIDIAN_GITHUB_REPO', 'github'); // a repository was given → use it

  // Final check with the same validator the settings API uses, per variable so the error names it.
  for (const [path, name] of Object.entries(lockedBy)) {
    if (path === 'github.token') continue;
    wrap(name, () => {
      const scratch: any = { driver: 'local', github: {}, cache: {}, rules: [] };
      const [top, key] = path.split('.');
      const one: any = key ? { [top]: { [key]: (patch as any)[top][key] } } : { [top]: (patch as any)[top] };
      applyStoragePatch(scratch, one);
    });
  }
  return { patch, lockedBy };
}

/** Identity-style helper for the status route. */
export const storageEnvInfo = (env: Env = process.env) => readStorageEnv(env).lockedBy;
