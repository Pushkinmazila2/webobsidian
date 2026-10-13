import { Rules, globToRegExp } from '../storage/github/rules.js';

const MASK = '••••••••';
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

export function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

/** Validate + merge a `storage` patch. Throws 400 on anything malformed; the schema parse after it is the final gate. */
export function applyStoragePatch(d: any, b: any): void {
  if (b.driver !== undefined) {
    if (b.driver !== 'local' && b.driver !== 'github') badRequest('storage.driver must be "local" or "github"');
    d.driver = b.driver;
  }
  const g = b.github;
  if (g && typeof g === 'object') {
    for (const k of ['owner', 'repo'] as const) {
      const v = str(g[k], 100);
      if (v !== undefined) {
        if (v && !/^[A-Za-z0-9._-]+$/.test(v)) badRequest(`storage.github.${k} has invalid characters`);
        d.github[k] = v;
      }
    }
    const branch = str(g.branch, 255);
    if (branch !== undefined) {
      if (/[\s~^:?*\[\\]|\.\.|^\/|\/$/.test(branch)) badRequest('storage.github.branch is not a valid branch name');
      d.github.branch = branch;
    }
    const base = str(g.basePath, 500);
    if (base !== undefined) {
      const clean = base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (clean.split('/').some((seg: string) => seg === '..' || seg === '.git')) badRequest('storage.github.basePath is not allowed');
      d.github.basePath = clean;
    }
    const api = str(g.apiUrl, 300);
    if (api !== undefined) {
      if (api) {
        let u: URL;
        try { u = new URL(api); } catch { badRequest('storage.github.apiUrl is not a URL'); }
        if (u!.protocol !== 'https:' && u!.protocol !== 'http:') badRequest('storage.github.apiUrl must be http(s)');
      }
      d.github.apiUrl = api || 'https://api.github.com';
    }
    const minNum = (key: 'pollSec' | 'flushSec' | 'holdSec', min: number) => {
      if (g[key] === undefined) return;
      if (typeof g[key] !== 'number' || !Number.isFinite(g[key]) || g[key] < min) badRequest(`storage.github.${key} must be a number ≥ ${min}`);
      d.github[key] = g[key];
    };
    minNum('pollSec', 5);
    minNum('flushSec', 1);
    minNum('holdSec', 1);
    if (g.holdMatch !== undefined) {
      if (!Array.isArray(g.holdMatch) || g.holdMatch.length > 20) badRequest('storage.github.holdMatch must be a list of at most 20 patterns');
      d.github.holdMatch = g.holdMatch.map((m: unknown) => {
        const pat = str(m, 300);
        if (!pat) badRequest('every held pattern needs a value');
        try { globToRegExp(pat); } catch { badRequest(`invalid pattern: ${pat}`); }
        return pat;
      });
    }
    if (typeof g.token === 'string' && g.token !== MASK) d.github.token = g.token.trim(); // empty string clears it
  }
  const c = b.cache;
  if (c && typeof c === 'object') {
    if (c.persist !== undefined) {
      if (c.persist !== 'memory' && c.persist !== 'disk') badRequest('storage.cache.persist must be "memory" or "disk"');
      d.cache.persist = c.persist;
    }
    if (c.maxMB !== undefined) {
      if (typeof c.maxMB !== 'number' || !Number.isFinite(c.maxMB) || c.maxMB < 1) badRequest('storage.cache.maxMB must be a number ≥ 1');
      d.cache.maxMB = c.maxMB;
    }
    if (typeof c.dir === 'string') d.cache.dir = c.dir.trim();
  }
  if (b.rules !== undefined) {
    if (!Array.isArray(b.rules) || b.rules.length > 100) badRequest('storage.rules must be a list of at most 100 rules');
    const rules = b.rules.map((r: any) => {
      const match = str(r?.match, 300);
      if (!match) badRequest('every rule needs a pattern');
      if (!['mirror', 'lazy', 'remote'].includes(r.mode)) badRequest(`rule "${match}": mode must be mirror, lazy or remote`);
      const out: any = { match, mode: r.mode };
      if (typeof r.index === 'boolean') out.index = r.index;
      return out;
    });
    try { new Rules(rules); } catch (e: any) { badRequest(`invalid rule: ${e?.message ?? e}`); }
    d.rules = rules;
  }
}

