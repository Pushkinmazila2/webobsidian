import { AsyncLocalStorage } from 'node:async_hooks';
import type { VaultStorage } from '../storage/types.js';

/**
 * The vault the current request/task works on.
 *
 * The server can host several vaults at once (a local folder, a GitHub repository, …).
 * Instead of threading a vault argument through every service, each request runs inside
 * `runInVault(ctx, …)` and the vault facade, search index, link graph and file index
 * look their state up through `currentVault()`. Outside any request (boot code, git
 * auto-sync, tests) the main vault ("default") is used, so single-vault code is unchanged.
 *
 * This module deliberately imports nothing but types: the services that need it
 * (search, links, fileindex, vault) must not form import cycles with the registry.
 */

export const DEFAULT_VAULT_ID = 'default';

export interface VaultCtx {
  id: string;
  name: string;
  /** The main vault: git sync, env storage settings and legacy share links belong to it. */
  isDefault: boolean;
  storage: VaultStorage;
  /** Search engine (QmdEngine) of this vault. */
  search: any;
  /** Link graph state of this vault (owned by services/links.ts). */
  links: { graph: any };
  /** Attachment/basename index of this vault (owned by services/fileindex.ts). */
  files: { byBasename: Map<string, string>; byBasenameNoExt: Map<string, string> };
}

const als = new AsyncLocalStorage<VaultCtx>();
let defaultProvider: (() => VaultCtx) | null = null;

export function setDefaultVaultProvider(fn: (() => VaultCtx) | null): void {
  defaultProvider = fn;
}

export function runInVault<T>(ctx: VaultCtx, fn: () => T): T {
  return als.run(ctx, fn);
}

/** The vault of the current request, or the main vault outside a request. */
export function currentVault(): VaultCtx {
  const c = als.getStore();
  if (c) return c;
  if (!defaultProvider) throw new Error('No vault registry is installed');
  return defaultProvider();
}

/** True when running inside an explicit vault scope (as opposed to the default fallback). */
export const inVaultScope = (): boolean => als.getStore() !== undefined;

let overrider: ((s: VaultStorage | null) => void) | null = null;
export function setDefaultStorageOverrider(fn: ((s: VaultStorage | null) => void) | null): void {
  overrider = fn;
}
/** Replace the main vault's driver (tests); `null` drops it so it is rebuilt from settings. */
export function overrideDefaultStorage(s: VaultStorage | null): void {
  if (!overrider) throw new Error('No vault registry is installed');
  overrider(s);
}
