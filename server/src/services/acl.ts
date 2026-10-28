import { AsyncLocalStorage } from 'node:async_hooks';
import { getAclStore, getUserStore, levelNum, normPattern, type AclRule, type Level } from '../db/index.js';
import { globToRegExp } from '../storage/github/rules.js';
import { currentVault } from './vaultals.js';
import type { TreeNode } from '../storage/types.js';

/**
 * Folder-level permissions.
 *
 * Who is asking: a `Principal` rides along each signed-in request (AsyncLocalStorage, like the
 * current vault). Code that runs without one — boot, indexing, background sync, API-key (agent)
 * requests — is "system" and unrestricted. Session routes always get a principal from `requireAuth`.
 *
 * What a principal may do with a path:
 *  - Administrators: everything (`manage`) everywhere.
 *  - Others: start from the vault's default level (`none` unless an admin set one), then walk the
 *    matching rules from the least to the most specific pattern (specificity = number of literal
 *    leading path segments). A more specific `allow` replaces the level; a `deny L` caps the
 *    level below L. Within one specificity tier `deny` beats `allow`.
 *  - Built-in: `.obsidian` is readable by everyone who can use the vault but read-only
 *    (plugins and settings are the admin's); an explicit rule on a deeper path such as
 *    `.obsidian/plugins` overrides that.
 */

export interface Principal {
  userId: string;
  isAdmin: boolean;
  groupIds: ReadonlySet<string>;
}

const READ = levelNum('read');
const WRITE = levelNum('write');
const MANAGE = levelNum('manage');

// ---- who is asking ---------------------------------------------------------------
const als = new AsyncLocalStorage<{ p: Principal | null }>();

export const runAs = <T>(p: Principal | null, fn: () => T): T => als.run({ p }, fn);
/** Run `fn` unrestricted (derived indexes, background work started inside a request). */
export const asSystem = <T>(fn: () => T): T => als.run({ p: null }, fn);
export const currentPrincipal = (): Principal | null => als.getStore()?.p ?? null;

export async function principalFor(user: { id: string; isAdmin: boolean }): Promise<Principal> {
  const groups = await getUserStore().listGroupsOfUser(user.id);
  return { userId: user.id, isAdmin: user.isAdmin, groupIds: new Set(groups.map((g) => g.id)) };
}

// ---- rules (cached in memory, reloaded after every change) -------------------------
interface Compiled {
  rule: Pick<AclRule, 'subjectType' | 'subjectId' | 'level' | 'effect'>;
  spec: number;
  re: RegExp;
  /** Leading literal part of the pattern ('' when it starts with a wildcard). */
  literal: string;
}
interface VaultAcl {
  default: number;
  rules: Compiled[];
}

const GLOB_CHARS = /[*?{]/;

export function compileRule(r: Pick<AclRule, 'subjectType' | 'subjectId' | 'level' | 'effect' | 'pattern'>): Compiled {
  const pattern = normPattern(r.pattern);
  const segs = pattern.split('/').filter(Boolean);
  const lit: string[] = [];
  for (const s of segs) {
    if (GLOB_CHARS.test(s)) break;
    lit.push(s);
  }
  return {
    rule: { subjectType: r.subjectType, subjectId: r.subjectId, level: r.level, effect: r.effect },
    spec: lit.length,
    re: globToRegExp(pattern || '**'),
    literal: lit.join('/').toLowerCase(),
  };
}

const BUILTIN: Compiled[] = [
  compileRule({ subjectType: 'everyone', subjectId: null, pattern: '.obsidian', level: 'read', effect: 'allow' }),
  compileRule({ subjectType: 'everyone', subjectId: null, pattern: '.obsidian', level: 'write', effect: 'deny' }),
];

const vaults = new Map<string, VaultAcl>();
const NONE: VaultAcl = { default: 0, rules: [] };

/** (Re)load every rule and vault default from the database. */
export async function refreshAcl(): Promise<void> {
  const store = getAclStore();
  const next = new Map<string, VaultAcl>();
  const get = (id: string) => next.get(id) ?? next.set(id, { default: 0, rules: [] }).get(id)!;
  for (const d of await store.listDefaults()) get(d.vaultId).default = levelNum(d.level);
  for (const r of await store.listRules()) get(r.vaultId).rules.push(compileRule(r));
  vaults.clear();
  for (const [k, v] of next) vaults.set(k, v);
}

const appliesTo = (c: Compiled, p: Principal): boolean =>
  c.rule.subjectType === 'everyone' || (c.rule.subjectType === 'user' ? c.rule.subjectId === p.userId : c.rule.subjectId !== null && p.groupIds.has(c.rule.subjectId));

/** A pattern applies to a path when it matches the path itself or any folder above it. */
function matches(c: Compiled, rel: string): boolean {
  if (c.re.test(rel)) return true;
  let i = rel.indexOf('/');
  while (i !== -1) {
    if (c.re.test(rel.slice(0, i))) return true;
    i = rel.indexOf('/', i + 1);
  }
  return false;
}

/** The level (0 none … 4 manage) `p` has on `rel` in `vaultId`. A null principal is the system. */
export function levelFor(p: Principal | null, vaultId: string, rel: string): number {
  if (!p || p.isAdmin) return MANAGE;
  // The built-in `.obsidian` access below is for people who can use the vault at all.
  if (!vaultAccessible(p, vaultId)) return 0;
  const v = vaults.get(vaultId) ?? NONE;
  const norm = normPattern(rel);
  const tiers = new Map<number, Compiled[]>();
  for (const c of [...BUILTIN, ...v.rules]) {
    if (!appliesTo(c, p) || !matches(c, norm)) continue;
    (tiers.get(c.spec) ?? tiers.set(c.spec, []).get(c.spec)!).push(c);
  }
  let level = v.default;
  for (const spec of [...tiers.keys()].sort((a, b) => a - b)) {
    const tier = tiers.get(spec)!;
    const allows = tier.filter((c) => c.rule.effect === 'allow').map((c) => levelNum(c.rule.level));
    if (allows.length) level = Math.max(...allows);
    const denies = tier.filter((c) => c.rule.effect === 'deny').map((c) => levelNum(c.rule.level) - 1);
    if (denies.length) level = Math.min(level, ...denies);
  }
  return level;
}

/** May `p` open this vault at all (it is listed for them)? */
export function vaultAccessible(p: Principal | null, vaultId: string): boolean {
  if (!p || p.isAdmin) return true;
  const v = vaults.get(vaultId) ?? NONE;
  if (v.default >= READ) return true;
  return v.rules.some((c) => c.rule.effect === 'allow' && levelNum(c.rule.level) >= READ && appliesTo(c, p));
}

/** Could something readable live below folder `rel`? (Lets people walk down to a folder they were granted.) */
function grantUnder(p: Principal, vaultId: string, rel: string): boolean {
  const v = vaults.get(vaultId) ?? NONE;
  const f = normPattern(rel).toLowerCase();
  return v.rules.some((c) => {
    if (c.rule.effect !== 'allow' || levelNum(c.rule.level) < READ || !appliesTo(c, p)) return false;
    return f === '' || c.literal === '' || c.literal === f || c.literal.startsWith(f + '/') || f.startsWith(c.literal + '/');
  });
}

// ---- checks against the current request ---------------------------------------------
const vid = () => currentVault().id;
const forbidden = (rel: string) => Object.assign(new Error(`No access to "${rel}"`), { status: 403 });

export const levelHere = (rel: string): number => levelFor(currentPrincipal(), vid(), rel);
export const canRead = (rel: string): boolean => levelHere(rel) >= READ;
export const canWrite = (rel: string): boolean => levelHere(rel) >= WRITE;

/** Is a folder worth showing: readable itself, or something below it is granted. */
export function maySee(rel: string): boolean {
  const p = currentPrincipal();
  if (!p || p.isAdmin) return true;
  return levelFor(p, vid(), rel) >= READ || grantUnder(p, vid(), rel);
}

export function assertRead(rel: string): void {
  if (!canRead(rel)) throw forbidden(rel);
}
export function assertWrite(rel: string): void {
  if (!canWrite(rel)) throw forbidden(rel);
}
export const assertAdmin = (): void => {
  const p = currentPrincipal();
  if (p && !p.isAdmin) throw Object.assign(new Error('Administrator access required'), { status: 403 });
};

/** Drop what the current person may not see from a vault tree (folders stay when something below is visible). */
export function filterTree(root: TreeNode): TreeNode {
  const p = currentPrincipal();
  if (!p || p.isAdmin) return root;
  const walk = (n: TreeNode): TreeNode | null => {
    if (n.type === 'file') return canRead(n.path) ? n : null;
    const children = (n.children ?? []).map(walk).filter((c): c is TreeNode => c !== null);
    return children.length || canRead(n.path) ? { ...n, children } : null;
  };
  return walk(root) ?? { ...root, children: [] };
}

export function filterPaths(paths: string[]): string[] {
  const p = currentPrincipal();
  return !p || p.isAdmin ? paths : paths.filter(canRead);
}
