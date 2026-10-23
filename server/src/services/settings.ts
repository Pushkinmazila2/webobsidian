import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { applyStoragePatch } from './storagepatch.js';
import { readStorageEnv, type StorageEnv } from './storageenv.js';
import { config, SETTINGS_FILE } from '../config.js';

/** ---- Schema (PRD §6) ---------------------------------------------------- */

const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  prefix: z.string(), // first chars, for display
  scopes: z.array(z.enum(['read', 'write', 'search'])).default(['read', 'search']),
  createdAt: z.string(),
  lastUsed: z.string().nullable().default(null),
});

const StorageSchema = z
    .object({
      driver: z.enum(['local', 'github']).default('local'),
      github: z
        .object({
          owner: z.string().default(''),
          repo: z.string().default(''),
          // Empty = the repository's default branch.
          branch: z.string().default(''),
          // Folder inside the repo that is the vault root ('' = repo root).
          basePath: z.string().default(''),
          // Prefer the WEBOBSIDIAN_GITHUB_TOKEN env var so the secret never sits in
          // settings.json. Fine-grained PAT, Contents: read (+ write for editing).
          token: z.string().default(''),
          apiUrl: z.string().default('https://api.github.com'),
          pollSec: z.number().min(5).default(30),
          // Edits are committed in one batch after this many quiet seconds (write-behind).
          flushSec: z.number().min(1).default(15),
          // Paths matching holdMatch (plugin code + settings under .obsidian by default) are
          // saved to GitHub only after this many quiet seconds, so a chatty plugin can't
          // spam commits. Notes are unaffected (they follow flushSec).
          holdSec: z.number().min(1).default(300),
          holdMatch: z.array(z.string().min(1)).default(['.obsidian/**']),
        })
        .default({}),
      cache: z
        .object({
          // 'memory' = nothing is ever written to the server's disk.
          persist: z.enum(['memory', 'disk']).default('memory'),
          // Used when persist = 'disk'. Empty = <DATA_DIR>/cache.
          dir: z.string().default(''),
          maxMB: z.number().min(1).default(256),
        })
        .default({}),
      // First match wins. mirror = prefetched + never evicted; lazy = fetched on first
      // use, kept in the LRU cache; remote = never cached (short in-memory TTL only).
      // `index: true` = include in search / backlinks / graph.
      rules: z
        .array(
          z.object({
            match: z.string().min(1),
            mode: z.enum(['mirror', 'lazy', 'remote']),
            index: z.boolean().optional(),
          }),
        )
        .default([
          { match: '.obsidian/**', mode: 'mirror', index: false },
          { match: '**/*.{md,markdown,canvas}', mode: 'mirror', index: true },
          { match: '**', mode: 'lazy', index: false },
        ]),
    });

/** An additional vault: its own folder or GitHub repository, with its own storage rules. */
export const VaultSchema = z.object({
  // URL/header-safe slug; "default" is reserved for the main vault.
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).refine((v) => v !== 'default', 'reserved id'),
  name: z.string().min(1).max(80),
  // Folder of a local vault (driver "local").
  path: z.string().default(''),
  // Name of an environment variable holding this vault's GitHub token (preferred over storage.github.token).
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).or(z.literal('')).default(''),
  storage: StorageSchema.default({}),
});
export type VaultConfig = z.infer<typeof VaultSchema>;

const SettingsSchema = z.object({
  version: z.number().default(1),
  auth: z
    .object({
      // Mật khẩu người dùng đã đổi. Rỗng = đang dùng mật khẩu mặc định (123456).
      userPasswordHash: z.string().default(''),
      // Mật khẩu override để khôi phục khi quên pass (sửa tay vào file). Rỗng = không có.
      passwordHash: z.string().default(''),
      jwtSecret: z.string().default(''),
    })
    .default({}),
  vault: z
    .object({
      path: z.string().default(''),
      allowedRoots: z.array(z.string()).default([]),
      trash: z.string().default('.trash'),
      // Xoá file: 'trash' = chuyển vào thư mục .trash (khôi phục được);
      // 'permanent' = xoá vĩnh viễn ngay.
      deleteMode: z.enum(['trash', 'permanent']).default('trash'),
      attachmentDir: z.string().default('attachments'),
    })
    .default({}),
  git: z
    .object({
      enabled: z.boolean().default(false),
      remote: z.string().default(''),
      branch: z.string().default('main'),
      token: z.string().default(''),
      authorName: z.string().default('WebObsidian'),
      authorEmail: z.string().default('webobsidian@localhost'),
      autoSync: z.boolean().default(false),
      autoCommitOnSave: z.boolean().default(false),
      intervalSec: z.number().default(300),
      lfsPatterns: z
        .array(z.string())
        .default(['*.png', '*.jpg', '*.jpeg', '*.gif', '*.pdf', '*.mp4', '*.mov', '*.zip']),
    })
    .default({}),
  // Where the vault lives. 'local' = a folder on disk (vault.path above);
  // 'github' = a repository read/written through the GitHub API, with per-path
  // rules for what is mirrored locally, fetched lazily, or never stored at all.
  // Changes here take effect on restart.
  storage: StorageSchema.default({}),

  // Additional vaults (Settings → Vaults). The main vault above is always "default".
  vaults: z.array(VaultSchema).default([]),
  search: z
    .object({
      fuzzy: z.number().default(0.2),
      prefix: z.boolean().default(true),
      indexFrontmatter: z.boolean().default(true),
    })
    .default({}),
  api: z
    .object({
      keys: z.array(ApiKeySchema).default([]),
      rateLimitPerMin: z.number().default(120),
    })
    .default({}),
  ui: z
    .object({
      theme: z.enum(['obsidian-dark', 'obsidian-light']).default('obsidian-light'),
      defaultView: z.enum(['live', 'source', 'reading']).default('live'),
    })
    .default({}),
  plugins: z
    .object({
      enabled: z.array(z.string()).default([]),
      installed: z.array(z.string()).default([]),
      // How often the compatibility catalogue (community-plugins.json of the webobsidian-community-plugins repo) is re-downloaded.
      // 0 = only when the user presses "Check now". The catalogue itself is rebuilt daily, so < 1 day gains little.
      catalogRefreshHours: z.number().min(0).max(24 * 30).default(24),
      // Adds 'unsafe-eval' to the page CSP so plugins that evaluate strings (Excalidraw, …) can run. Weakens XSS protection.
      allowUnsafeEval: z.boolean().default(false),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeySchema>;

/** ---- Store --------------------------------------------------------------- */

let cache: Settings | null = null;

function defaults(): Settings {
  const base = SettingsSchema.parse({});
  base.auth.jwtSecret = randomBytes(48).toString('hex');
  base.vault.path = config.defaultVaultPath;
  base.vault.allowedRoots = config.allowedRoots.length
    ? config.allowedRoots
    : [path.dirname(config.defaultVaultPath), config.defaultVaultPath];
  return base;
}

/**
 * Guarantee the folder browser can reach the configured vault. The default
 * allowedRoots are derived from the sample vault, so pointing the vault at a
 * path outside them (e.g. ~/ObsidianVault) made Browse… return 403 with
 * "Path outside allowed roots". Add the vault's parent directory as a root
 * whenever it isn't already covered. Returns true if it mutated the draft.
 */
export function ensureVaultBrowsable(d: Settings): boolean {
  const vaultPath = path.resolve(d.vault.path);
  const roots = d.vault.allowedRoots ?? [];
  const covered = roots.some((r) => {
    const rr = path.resolve(r);
    return vaultPath === rr || vaultPath.startsWith(rr + path.sep);
  });
  if (covered) return false;
  d.vault.allowedRoots = [...roots, path.dirname(vaultPath)];
  return true;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

/** Storage settings as saved in settings.json (without environment overrides). */
let fileStorage: Settings['storage'] | null = null;
let envInfo: StorageEnv = { patch: {}, lockedBy: {} };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function getPath(o: any, p: string): any {
  return p.split('.').reduce((a, k) => a?.[k], o);
}
function setPath(o: any, p: string, v: any): void {
  const parts = p.split('.');
  let t = o;
  for (const k of parts.slice(0, -1)) t = t[k] ??= {};
  t[parts[parts.length - 1]] = clone(v);
}

/** Settings fields currently set by environment variables → name of the variable. */
export function storageLockedBy(): Record<string, string> {
  return { ...envInfo.lockedBy };
}

/** Apply WEBOBSIDIAN_* storage variables on top of the saved settings (in memory only). */
function withStorageEnv(parsed: Settings): Settings {
  envInfo = readStorageEnv();
  fileStorage = clone(parsed.storage);
  if (!Object.keys(envInfo.patch).length) return parsed;
  const draft: Settings = clone(parsed);
  applyStoragePatch(draft.storage, envInfo.patch);
  try {
    return SettingsSchema.parse(draft);
  } catch (e: any) {
    throw new Error(`Invalid storage environment variables: ${e?.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? e?.message ?? e}`);
  }
}

/** Atomic write: write to tmp then rename; keep a .bak of the previous file. */
async function persist(s: Settings): Promise<void> {
  await ensureDataDir();
  // Environment overrides are never written: the file keeps what the user saved.
  const json = JSON.stringify({ ...s, storage: fileStorage ?? s.storage }, null, 2);
  const tmp = `${SETTINGS_FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, json, { mode: 0o600 });
  try {
    await fs.copyFile(SETTINGS_FILE, `${SETTINGS_FILE}.bak`);
  } catch {
    /* no previous file */
  }
  await fs.rename(tmp, SETTINGS_FILE);
}

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  await ensureDataDir();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = SettingsSchema.parse(JSON.parse(raw));
    // Backfill secrets that may be empty in older files.
    let dirty = false;
    if (!parsed.auth.jwtSecret) {
      parsed.auth.jwtSecret = randomBytes(48).toString('hex');
      dirty = true;
    }
    // Migration: trước đây `passwordHash` là mật khẩu đăng nhập. Mô hình mới coi
    // `passwordHash` là mật khẩu override và `userPasswordHash` là pass đăng nhập
    // (rỗng = mặc định 123456). Để file cũ không bị backdoor bằng 123456, chuyển
    // pass cũ sang `userPasswordHash` rồi xoá field override.
    if (parsed.auth.passwordHash && !parsed.auth.userPasswordHash) {
      parsed.auth.userPasswordHash = parsed.auth.passwordHash;
      parsed.auth.passwordHash = '';
      dirty = true;
    }
    // Heal older files whose allowedRoots predate the current vault path.
    if (ensureVaultBrowsable(parsed)) dirty = true;
    cache = withStorageEnv(parsed);
    if (dirty) await persist(cache);
  } catch (e: any) {
    // A malformed environment variable must stop the server, not fall back to defaults.
    if (typeof e?.message === 'string' && /environment variable/.test(e.message)) throw e;
    const fresh = defaults();
    cache = withStorageEnv(fresh);
    await persist(cache);
  }
  return cache;
}

export async function getSettings(): Promise<Settings> {
  return cache ?? (await loadSettings());
}

/** Already-loaded settings, or null before loadSettings() ran. Lets sync code pick a driver. */
export function peekSettings(): Settings | null {
  return cache;
}

/** Mutate settings via an updater fn, validate, persist, and refresh cache. */
export async function updateSettings(
  mutator: (draft: Settings) => void | Promise<void>,
): Promise<Settings> {
  const current = await getSettings();
  const draft: Settings = JSON.parse(JSON.stringify(current));
  await mutator(draft);
  // Fields owned by environment variables can't be changed from here: keep both the
  // effective (env) value in memory and the saved (file) value on disk as they were.
  const nextFile = clone(draft.storage);
  for (const p of Object.keys(envInfo.lockedBy)) {
    setPath(draft.storage, p, getPath(current.storage, p));
    if (fileStorage) setPath(nextFile, p, getPath(fileStorage, p));
  }
  const validated = SettingsSchema.parse(draft);
  cache = validated;
  fileStorage = SettingsSchema.shape.storage.parse(nextFile);
  await persist(validated);
  return validated;
}

/** Redact secrets for sending to the client. */
export function redactSettings(s: Settings) {
  return {
    ...s,
    auth: {
      // hasCustomPassword=false nghĩa là đang dùng mật khẩu mặc định (123456).
      hasCustomPassword: Boolean(s.auth.userPasswordHash),
      hasOverridePassword: Boolean(s.auth.passwordHash),
    },
    git: { ...s.git, token: s.git.token ? '••••••••' : '' },
    storage: {
      ...s.storage,
      github: { ...s.storage.github, token: s.storage.github.token ? '••••••••' : '' },
    },
    api: {
      ...s.api,
      keys: s.api.keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
      })),
    },
  };
}
