import path from 'node:path';
import { config, INDEX_FILE } from '../config.js';
import { LocalFsStorage } from '../storage/local.js';
import { createGithubStorage } from '../storage/github/index.js';
import { createGitStorage, publicUrl } from '../storage/gitrepo/index.js';
import type { VaultStorage } from '../storage/types.js';
import { getSettings, peekSettings, type Settings, type VaultConfig } from './settings.js';
import { readVaultsEnv } from './vaultconf.js';
import {
  DEFAULT_VAULT_ID, runInVault, setDefaultStorageOverrider, setDefaultVaultProvider, type VaultCtx,
} from './vaultals.js';
import { QmdEngine, initSearch } from './search.js';
import { buildLinkGraph, updateLinkGraphForFile } from './links.js';
import { buildFileIndex, indexFile, unindexFile } from './fileindex.js';
import { broadcast } from './realtime.js';

/**
 * Vault registry. The main vault ("default") is built from `settings.vault` + `settings.storage`;
 * extra vaults come from `settings.vaults[]` and the WEBOBSIDIAN_VAULTS environment variable
 * (env wins on equal ids and is read-only). Each vault has its own storage driver, search index,
 * link graph, file index and change watcher, created lazily and torn down when its
 * configuration is removed or changed.
 */

interface Entry {
  ctx: VaultCtx;
  fingerprint: string;
  ready: Promise<void> | null;
  stop: (() => void) | null;
}

const entries = new Map<string, Entry>();
let envVaults: VaultConfig[] | null = null;
/** Storage settings the main vault was built from (restartRequired indicator). */
let bootStorageConfig = '';
const storageFingerprint = (s: { storage: unknown }) => JSON.stringify(s.storage);

export function storageRestartRequired(saved: { storage: unknown }): boolean {
  return bootStorageConfig !== '' && bootStorageConfig !== storageFingerprint(saved);
}

export function envVaultList(): VaultConfig[] {
  return (envVaults ??= readVaultsEnv());
}

/** Effective extra vaults: saved ones, overridden/extended by the environment. */
export function extraVaultConfigs(s: Settings): { conf: VaultConfig; fromEnv: boolean }[] {
  const env = envVaultList();
  const ids = new Set(env.map((v) => v.id));
  return [
    ...s.vaults.filter((v) => !ids.has(v.id)).map((conf) => ({ conf, fromEnv: false })),
    ...env.map((conf) => ({ conf, fromEnv: true })),
  ];
}

const trashDir = async () => (await getSettings()).vault.trash;

function makeCtx(id: string, name: string, isDefault: boolean, storage: VaultStorage): VaultCtx {
  const indexFile = isDefault ? INDEX_FILE : path.join(config.dataDir, 'vaults', id, 'qmd-index.json');
  const ctx: VaultCtx = {
    id, name, isDefault, storage,
    search: null,
    links: { graph: null },
    files: { byBasename: new Map(), byBasenameNoExt: new Map() },
  };
  ctx.search = new QmdEngine({ indexFile, storage: () => ctx.storage });
  return ctx;
}

function buildDefaultStorage(s: Settings): VaultStorage {
  if (s.storage.driver === 'git') return createGitStorage(s, { dataDir: config.dataDir, trashDir });
  return s.storage.driver === 'github'
    ? createGithubStorage(s, { dataDir: config.dataDir, trashDir })
    : new LocalFsStorage({ root: async () => (await getSettings()).vault.path, trashDir });
}

function buildExtraStorage(c: VaultConfig, s: Settings): VaultStorage {
  if (c.storage.driver === 'git') {
    return createGitStorage({ storage: c.storage, git: s.git }, {
      dataDir: config.dataDir, trashDir, tokenEnv: c.tokenEnv || undefined, cacheName: c.id,
    });
  }
  if (c.storage.driver === 'github') {
    return createGithubStorage({ storage: c.storage, git: s.git }, {
      dataDir: config.dataDir, trashDir, tokenEnv: c.tokenEnv || undefined, cacheName: c.id,
    });
  }
  return new LocalFsStorage({ root: async () => c.path, trashDir });
}

export function getDefaultContext(): VaultCtx {
  let e = entries.get(DEFAULT_VAULT_ID);
  if (!e) {
    const s = peekSettings();
    if (!s) throw new Error('Settings are not loaded yet');
    bootStorageConfig = storageFingerprint(s);
    e = { ctx: makeCtx(DEFAULT_VAULT_ID, 'Main vault', true, buildDefaultStorage(s)), fingerprint: '', ready: null, stop: null };
    entries.set(DEFAULT_VAULT_ID, e);
  }
  return e.ctx;
}

setDefaultVaultProvider(getDefaultContext);
setDefaultStorageOverrider((st) => {
  const old = entries.get(DEFAULT_VAULT_ID);
  old?.stop?.();
  entries.delete(DEFAULT_VAULT_ID);
  if (!st) return;
  const s = peekSettings();
  bootStorageConfig = s ? storageFingerprint(s) : '';
  entries.set(DEFAULT_VAULT_ID, { ctx: makeCtx(DEFAULT_VAULT_ID, 'Main vault', true, st), fingerprint: '', ready: null, stop: null });
});

const fp = (c: VaultConfig) => JSON.stringify(c);

/** The context of a vault, or null when no such vault is configured. Cheap: nothing is started here. */
export async function getVaultContext(id: string): Promise<VaultCtx | null> {
  if (id === DEFAULT_VAULT_ID) return getDefaultContext();
  const s = await getSettings();
  const found = extraVaultConfigs(s).find((v) => v.conf.id === id);
  const cur = entries.get(id);
  if (!found) {
    if (cur) await dropVault(id);
    return null;
  }
  const f = fp(found.conf);
  if (cur && cur.fingerprint === f) return cur.ctx;
  if (cur) await dropVault(id);
  const ctx = makeCtx(id, found.conf.name, false, buildExtraStorage(found.conf, s));
  entries.set(id, { ctx, fingerprint: f, ready: null, stop: null });
  return ctx;
}

/** Init storage, build indexes and start the change watcher (once per vault). */
export function ensureReady(ctx: VaultCtx): Promise<void> {
  const e = entries.get(ctx.id);
  if (!e || e.ctx !== ctx) return Promise.reject(new Error('Vault was removed'));
  if (!e.ready) {
    e.ready = runInVault(ctx, async () => {
      await ctx.storage.init();
      await initSearch();
      await buildLinkGraph();
      await buildFileIndex();
      e.stop = await watch(ctx);
    });
    e.ready.catch(() => { if (e.ready) e.ready = null; }); // allow a retry after a failed start
  }
  return e.ready;
}

async function watch(ctx: VaultCtx): Promise<() => void> {
  const stop = await ctx.storage.watch((ev) => {
    void runInVault(ctx, async () => {
      const { type, path: rel } = ev;
      if (type === 'add') indexFile(rel);
      else if (type === 'unlink') unindexFile(rel);
      if (/\.(md|markdown)$/i.test(rel)) {
        if (type === 'unlink') {
          ctx.search.remove(rel);
          await updateLinkGraphForFile(rel, true).catch(() => {});
        } else {
          await ctx.search.upsert(rel).catch(() => {});
          await updateLinkGraphForFile(rel).catch(() => {});
        }
      }
      broadcast({ type: 'fs', vault: ctx.id, event: type, path: rel });
    });
  });
  return typeof stop === 'function' ? stop : () => {};
}

/** Stop a vault and save its buffered changes. */
export async function dropVault(id: string): Promise<void> {
  const e = entries.get(id);
  if (!e || id === DEFAULT_VAULT_ID) return;
  entries.delete(id);
  e.stop?.();
  try { await e.ctx.storage.flush?.(); } catch (err: any) { console.error(`[vault ${id}] could not save buffered changes:`, err?.message ?? err); }
  (e.ctx.storage as any).dispose?.();
}

export interface VaultInfo {
  id: string;
  name: string;
  driver: 'local' | 'github' | 'git';
  isDefault: boolean;
  fromEnv: boolean;
  /** Short human description: folder or owner/repo. */
  location: string;
}

export async function listVaults(): Promise<VaultInfo[]> {
  const s = await getSettings();
  const out: VaultInfo[] = [{
    id: DEFAULT_VAULT_ID, name: 'Main vault', driver: s.storage.driver, isDefault: true, fromEnv: false,
    location: s.storage.driver === 'github' ? `${s.storage.github.owner}/${s.storage.github.repo}` : s.storage.driver === 'git' ? publicUrl(s.storage.git.url) : s.vault.path,
  }];
  for (const { conf, fromEnv } of extraVaultConfigs(s)) {
    out.push({
      id: conf.id, name: conf.name, driver: conf.storage.driver, isDefault: false, fromEnv,
      location: conf.storage.driver === 'github' ? `${conf.storage.github.owner}/${conf.storage.github.repo}` : conf.storage.driver === 'git' ? publicUrl(conf.storage.git.url) : conf.path,
    });
  }
  return out;
}

/** Save buffered changes of every running vault (shutdown). */
export async function flushAll(): Promise<void> {
  await Promise.all([...entries.values()].map(async (e) => {
    try { await e.ctx.storage.flush?.(); } catch (err: any) { console.error(`[vault ${e.ctx.id}] could not save buffered changes:`, err?.message ?? err); }
  }));
}

/** Running contexts (tests/diagnostics). */
export const runningVaults = (): VaultCtx[] => [...entries.values()].map((e) => e.ctx);
