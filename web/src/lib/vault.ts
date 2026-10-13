// Which vault this browser tab works on. Every tab can have its own: the choice lives in
// sessionStorage (per tab, survives reload) and may be set once from `?vault=<id>` in the URL.
// The main vault is "default" and needs no marker, so single-vault setups behave as before.

export const DEFAULT_VAULT = 'default';
const KEY = 'wo.vault';

function initial(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('vault');
    if (fromUrl && /^[a-z0-9][a-z0-9-]{0,31}$/.test(fromUrl)) {
      sessionStorage.setItem(KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(KEY) || DEFAULT_VAULT;
  } catch {
    return DEFAULT_VAULT;
  }
}

let current = initial();

export const currentVaultId = (): string => current;

/** Switch this tab to another vault. Reloads so every piece of per-vault state starts clean. */
export function switchVault(id: string): void {
  try {
    if (id === DEFAULT_VAULT) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, id);
  } catch { /* ignore */ }
  const u = new URL(window.location.href);
  u.searchParams.delete('vault');
  u.pathname = '/';
  window.location.assign(u.toString());
}

/** Headers that select the vault for fetch() calls. */
export const vaultHeaders = (): Record<string, string> => (current === DEFAULT_VAULT ? {} : { 'X-Vault': current });

/** Adds `?vault=` to URLs the browser loads by itself (img/video src, plugin scripts, downloads). */
export function withVault(url: string): string {
  if (current === DEFAULT_VAULT) return url;
  return url + (url.includes('?') ? '&' : '?') + `vault=${encodeURIComponent(current)}`;
}
