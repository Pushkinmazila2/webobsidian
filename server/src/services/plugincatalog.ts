import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import type { InstalledPlugin } from './plugins.js';

/**
 * Community plugin catalogue with a compatibility rating per plugin (PRD FR-8).
 *
 * The list is produced daily by the separate `webobsidian-community-plugins` repository (nothing of it lives here): it reads Obsidian's
 * community-plugins.json, scans every plugin's main.js against what WebObsidian implements and publishes
 * `community-plugins.json` with `compat: "full" | "partial" | "broken"` (or "unknown" = not scanned yet).
 *
 * This service downloads that one file — never the 9 000 plugin repositories — and keeps it in memory and in
 * `<DATA_DIR>/plugin-catalog.json`. It is refreshed at most every `settings.plugins.catalogRefreshHours` (0 = only
 * on request), with a conditional request (ETag) so an unchanged file costs a 304. A failure keeps the stale copy
 * and is not retried for 10 minutes.
 */

export type Compat = 'full' | 'partial' | 'broken' | 'unknown';
const COMPAT: readonly Compat[] = ['full', 'partial', 'broken', 'unknown'];

export interface CatalogPlugin {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  version?: string;
  minAppVersion?: string;
  desktopOnly?: boolean;
  downloads?: number;
  compat: Compat;
  reasons?: string[];
  /** Facts that do not change the rating: "eval" = some features need WEBOBSIDIAN_ALLOW_UNSAFE_EVAL=1. */
  flags?: string[];
}

export interface CatalogMeta {
  generatedAt: string;
  apiVersion: string;
  totals: Record<Compat, number>;
  count: number;
}

export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/Pushkinmazila2/webobsidian-community-plugins/main/community-plugins.json';
/** Operator-controlled on purpose (not a UI setting): it makes the server fetch a URL. */
export const catalogUrl = () => process.env.WEBOBSIDIAN_PLUGIN_CATALOG_URL || DEFAULT_CATALOG_URL;

const MAX_BYTES = 40 * 1048576;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_AFTER_ERROR_MS = 10 * 60_000;
const cacheFile = () => path.join(config.dataDir, 'plugin-catalog.json');

interface Loaded {
  meta: CatalogMeta;
  plugins: CatalogPlugin[];
  byId: Map<string, CatalogPlugin>;
  fetchedAt: number; // when we last confirmed the list with the source
  etag?: string;
}

let mem: Loaded | null = null;
let diskLoad: Promise<void> | null = null;
let inflight: Promise<void> | null = null;
let lastError: { message: string; at: number } | null = null;
let nextRetryAt = 0;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Validate and normalise a downloaded catalogue. Throws on anything that is not one. */
export function parseCatalog(text: string): { meta: CatalogMeta; plugins: CatalogPlugin[] } {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error('The plugin catalogue is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || raw.schema !== 1 || !Array.isArray(raw.plugins)) {
    throw new Error('The plugin catalogue has an unknown format (expected schema 1)');
  }
  const plugins: CatalogPlugin[] = [];
  const seen = new Set<string>();
  for (const p of raw.plugins) {
    // `id` becomes an install target and a path segment later: accept only plain ids and owner/repo
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(p.id) || seen.has(p.id)) continue;
    if (typeof p.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(p.repo)) continue;
    seen.add(p.id);
    const compat: Compat = COMPAT.includes(p.compat) ? p.compat : 'unknown';
    plugins.push({
      id: p.id,
      name: str(p.name, 200) || p.id,
      author: str(p.author, 200),
      description: str(p.description, 1000),
      repo: p.repo,
      ...(typeof p.version === 'string' ? { version: p.version.slice(0, 50) } : {}),
      ...(typeof p.minAppVersion === 'string' ? { minAppVersion: p.minAppVersion.slice(0, 50) } : {}),
      ...(p.desktopOnly === true ? { desktopOnly: true } : {}),
      ...(typeof p.downloads === 'number' && Number.isFinite(p.downloads) ? { downloads: p.downloads } : {}),
      compat,
      ...(Array.isArray(p.reasons) ? { reasons: p.reasons.filter((r: unknown) => typeof r === 'string').slice(0, 6).map((r: string) => r.slice(0, 300)) } : {}),
      ...(Array.isArray(p.flags) ? { flags: p.flags.filter((f: unknown) => typeof f === 'string').slice(0, 6) } : {}),
    });
  }
  if (!plugins.length) throw new Error('The plugin catalogue is empty');
  const totals: Record<Compat, number> = { full: 0, partial: 0, broken: 0, unknown: 0 };
  for (const p of plugins) totals[p.compat]++;
  return {
    meta: {
      generatedAt: str(raw.generatedAt, 40),
      apiVersion: str(raw.capabilities?.api, 20),
      totals,
      count: plugins.length,
    },
    plugins,
  };
}

function setLoaded(text: string, fetchedAt: number, etag?: string): void {
  const { meta, plugins } = parseCatalog(text);
  mem = { meta, plugins, byId: new Map(plugins.map((p) => [p.id, p])), fetchedAt, etag };
}

/** Load the on-disk copy once (no network). */
function loadCached(): Promise<void> {
  diskLoad ??= (async () => {
    try {
      const env = JSON.parse(await fs.readFile(cacheFile(), 'utf8'));
      if (typeof env.catalog === 'string' && typeof env.fetchedAt === 'number') setLoaded(env.catalog, env.fetchedAt, env.etag);
    } catch {
      /* no cache yet, or unreadable: the first refresh fills it */
    }
  })();
  return diskLoad;
}

async function persist(text: string): Promise<void> {
  if (!mem) return;
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    const tmp = `${cacheFile()}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ fetchedAt: mem.fetchedAt, etag: mem.etag, catalog: text }));
    await fs.rename(tmp, cacheFile());
  } catch {
    /* the in-memory copy still works; a read-only data dir must not break the plugin manager */
  }
}

async function download(): Promise<void> {
  const url = catalogUrl();
  if (!/^https?:\/\//i.test(url)) throw new Error('WEBOBSIDIAN_PLUGIN_CATALOG_URL must be an http(s) URL');
  const headers: Record<string, string> = { 'user-agent': 'WebObsidian', accept: 'application/json' };
  if (mem?.etag) headers['if-none-match'] = mem.etag;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (res.status === 304 && mem) {
    mem.fetchedAt = Date.now();
    await persistSame();
    return;
  }
  if (!res.ok) throw new Error(`Could not download the plugin catalogue (HTTP ${res.status})`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new Error('The plugin catalogue is too large');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('The plugin catalogue is too large');
  setLoaded(text, Date.now(), res.headers.get('etag') ?? undefined);
  await persist(text);
}

/** After a 304 only the timestamp changes: rewrite the envelope around the unchanged catalogue text. */
async function persistSame(): Promise<void> {
  try {
    const env = JSON.parse(await fs.readFile(cacheFile(), 'utf8'));
    if (mem && typeof env.catalog === 'string') await persist(env.catalog);
  } catch { /* nothing cached on disk: keep the memory copy */ }
}

/** Download now (single-flight). Rejects with the reason when it fails; the stale copy stays in use. */
export function refresh(): Promise<void> {
  inflight ??= (async () => {
    try {
      await loadCached();
      await download();
      lastError = null;
      nextRetryAt = 0;
    } catch (e: any) {
      const message = String(e?.message ?? e);
      lastError = { message, at: Date.now() };
      nextRetryAt = Date.now() + RETRY_AFTER_ERROR_MS;
      throw new Error(message);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface CatalogInfo {
  available: boolean;
  generatedAt?: string;
  apiVersion?: string;
  totals?: Record<Compat, number>;
  count?: number;
  fetchedAt?: string;
  refreshHours: number;
  nextCheckAt?: string;
  refreshing: boolean;
  error?: string;
}

async function refreshHours(): Promise<number> {
  const h = (await getSettings()).plugins.catalogRefreshHours;
  return Number.isFinite(h) && h >= 0 ? h : 24;
}

export async function info(): Promise<CatalogInfo> {
  const hours = await refreshHours();
  return {
    available: Boolean(mem),
    ...(mem ? { generatedAt: mem.meta.generatedAt, apiVersion: mem.meta.apiVersion, totals: mem.meta.totals, count: mem.meta.count, fetchedAt: new Date(mem.fetchedAt).toISOString() } : {}),
    refreshHours: hours,
    ...(mem && hours > 0 ? { nextCheckAt: new Date(Math.max(mem.fetchedAt + hours * 3_600_000, nextRetryAt)).toISOString() } : {}),
    refreshing: inflight !== null,
    ...(lastError ? { error: lastError.message } : {}),
  };
}

/**
 * Make sure there is a catalogue to serve. Without any copy this waits for the first download; with a stale copy it
 * answers immediately and refreshes in the background (stale-while-revalidate), so opening the manager never waits
 * for GitHub once it has been opened before.
 */
async function ensure(): Promise<void> {
  await loadCached();
  if (!mem) {
    if (Date.now() < nextRetryAt) return; // failed a moment ago: don't hammer the source on every page load
    try { await refresh(); } catch { /* reported through info().error */ }
    return;
  }
  const hours = await refreshHours();
  if (hours > 0 && Date.now() - mem.fetchedAt >= hours * 3_600_000 && Date.now() >= nextRetryAt) {
    refresh().catch(() => { /* reported through info().error */ });
  }
}

/** Rating of an installed plugin, from what is already loaded (no network). */
export async function compatOf(id: string): Promise<Pick<CatalogPlugin, 'compat' | 'reasons' | 'flags'> | undefined> {
  await loadCached();
  const p = mem?.byId.get(id);
  return p ? { compat: p.compat, ...(p.reasons ? { reasons: p.reasons } : {}), ...(p.flags ? { flags: p.flags } : {}) } : undefined;
}

export interface CatalogQuery {
  q?: string;
  /** all | installed | not-installed */
  status?: string;
  /** all | full | partial | broken | unknown, or a comma list ("full,partial") */
  compat?: string;
  /** downloads | name | compat */
  sort?: string;
  offset?: number;
  limit?: number;
}
export interface CatalogItem extends CatalogPlugin {
  installed: boolean;
  enabled: boolean;
  installedVersion?: string;
}
export interface CatalogPage {
  info: CatalogInfo;
  total: number;
  items: CatalogItem[];
  /** Counts over the text search alone, so the filter chips can show how many each choice would give. */
  counts: { compat: Record<Compat, number>; installed: number; notInstalled: number };
}

const RANK: Record<Compat, number> = { full: 0, partial: 1, broken: 2, unknown: 3 };

export async function query(q: CatalogQuery, installed: InstalledPlugin[]): Promise<CatalogPage> {
  await ensure();
  const base = await info();
  const empty: CatalogPage['counts'] = { compat: { full: 0, partial: 0, broken: 0, unknown: 0 }, installed: 0, notInstalled: 0 };
  if (!mem) return { info: base, total: 0, items: [], counts: empty };

  const inst = new Map(installed.map((p) => [p.id, p]));
  const needle = (q.q ?? '').trim().toLowerCase();
  const words = needle ? needle.split(/\s+/) : [];
  const wanted = new Set((q.compat ?? 'all').split(',').map((s) => s.trim()).filter((s): s is Compat => (COMPAT as readonly string[]).includes(s)));
  const status = q.status === 'installed' || q.status === 'not-installed' ? q.status : 'all';

  const counts = empty;
  const rows: CatalogPlugin[] = [];
  for (const p of mem.plugins) {
    if (words.length) {
      const hay = `${p.id} ${p.name} ${p.author} ${p.description}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    const isInst = inst.has(p.id);
    counts.compat[p.compat]++;
    if (isInst) counts.installed++; else counts.notInstalled++;
    if (status === 'installed' && !isInst) continue;
    if (status === 'not-installed' && isInst) continue;
    if (wanted.size && !wanted.has(p.compat)) continue;
    rows.push(p);
  }

  const sort = q.sort === 'name' || q.sort === 'compat' ? q.sort : 'downloads';
  rows.sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name)
      : sort === 'compat'
        ? RANK[a.compat] - RANK[b.compat] || (b.downloads ?? 0) - (a.downloads ?? 0)
        : (b.downloads ?? 0) - (a.downloads ?? 0) || a.name.localeCompare(b.name),
  );

  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 30)));
  const items = rows.slice(offset, offset + limit).map((p): CatalogItem => {
    const i = inst.get(p.id);
    return { ...p, installed: Boolean(i), enabled: Boolean(i?.enabled), ...(i ? { installedVersion: i.version } : {}) };
  });
  return { info: base, total: rows.length, items, counts };
}

/** Test hook: forget everything held in memory (the disk copy stays). */
export function _resetForTests(): void {
  mem = null; diskLoad = null; inflight = null; lastError = null; nextRetryAt = 0;
}
