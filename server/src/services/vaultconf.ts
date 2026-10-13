import { applyStoragePatch } from './storagepatch.js';
import { parseRules, parseRepoRef } from './storageenv.js';
import { VaultSchema, type VaultConfig } from './settings.js';

/**
 * Extra vaults from the environment: `WEBOBSIDIAN_VAULTS` is a JSON array, e.g.
 *   [{"id":"notes","name":"Notes","driver":"local","path":"/data/notes"},
 *    {"id":"kb","name":"Knowledge base","repo":"acme/kb","tokenEnv":"KB_TOKEN","preset":"mirror-all"}]
 * Entries override saved vaults with the same id and are read-only in the UI.
 * A malformed value stops the server at startup (a typo must not silently drop a vault).
 */

const PRESET_RULES: Record<string, string> = {
  default: '.obsidian/**=mirror:noindex;**/*.{md,markdown,canvas}=mirror:index;**=lazy:noindex',
  'remote-only': '**=remote:noindex',
  'mirror-all': '**=mirror:index',
};

const fail = (msg: string): never => {
  throw new Error(`Invalid environment variable WEBOBSIDIAN_VAULTS: ${msg}`);
};

export function readVaultsEnv(env: Record<string, string | undefined> = process.env): VaultConfig[] {
  const raw = env.WEBOBSIDIAN_VAULTS?.trim();
  if (!raw) return [];
  let arr: any;
  try {
    arr = JSON.parse(raw);
  } catch (e: any) {
    return fail(`not valid JSON (${e?.message})`);
  }
  if (!Array.isArray(arr)) return fail('expected a JSON array');
  const seen = new Set<string>();
  return arr.map((e, i) => {
    if (!e || typeof e !== 'object') return fail(`item ${i + 1} is not an object`);
    const label = `item ${i + 1}${e.id ? ` ("${e.id}")` : ''}`;
    try {
      const base = VaultSchema.parse({ id: e.id, name: e.name ?? e.id, path: e.path ?? '', tokenEnv: e.tokenEnv ?? '' });
      if (seen.has(base.id)) throw new Error('duplicate id');
      seen.add(base.id);
      const patch: any = { github: {}, cache: {} };
      if (e.repo) {
        const [owner, name] = parseRepoRef(String(e.repo));
        patch.github.owner = e.owner ?? owner;
        patch.github.repo = name;
      }
      for (const k of ['branch', 'basePath', 'apiUrl', 'pollSec', 'flushSec', 'holdSec', 'holdMatch']) {
        if (e[k] !== undefined) patch.github[k] = e[k];
      }
      if (e.cache && typeof e.cache === 'object') patch.cache = e.cache;
      const rulesSrc = e.rules ?? (e.preset ? PRESET_RULES[String(e.preset).toLowerCase()] : undefined);
      if (e.preset && !rulesSrc) throw new Error(`unknown preset "${e.preset}"`);
      if (rulesSrc !== undefined) patch.rules = Array.isArray(rulesSrc) ? rulesSrc : parseRules(String(rulesSrc));
      patch.driver = e.driver ?? (e.repo ? 'github' : 'local');
      applyStoragePatch(base.storage, patch);
      if (e.token) base.storage.github.token = String(e.token);
      if (base.storage.driver === 'local' && !base.path) throw new Error('a local vault needs "path"');
      if (base.storage.driver === 'github' && (!base.storage.github.owner || !base.storage.github.repo)) throw new Error('a GitHub vault needs "repo": "owner/repo"');
      return VaultSchema.parse(base);
    } catch (err: any) {
      const m = err?.issues ? err.issues.map((x: any) => `${x.path.join('.')}: ${x.message}`).join('; ') : err?.message ?? err;
      return fail(`${label}: ${m}`);
    }
  });
}
