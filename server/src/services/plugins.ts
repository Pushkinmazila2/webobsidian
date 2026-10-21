import * as vault from './vault.js';
import { getSettings, updateSettings } from './settings.js';

/**
 * Obsidian community plugin support (PRD FR-8).
 * Plugins live in `<vault>/.obsidian/plugins/<id>/` with manifest.json + main.js
 * (+ optional styles.css), exactly like the desktop app. The server lists,
 * installs (from GitHub releases) and toggles them; the browser loads main.js
 * against the Obsidian API shim (see web/src/lib/obsidian-shim).
 */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export interface InstalledPlugin extends PluginManifest {
  enabled: boolean;
  hasStyles: boolean;
  dir: string; // vault-relative
}

/** Vault-relative plugins folder. All access goes through the storage facade. */
const PLUGINS_DIR = '.obsidian/plugins';
/**
 * Which community plugins are on, in Obsidian's own format (a JSON array of ids), so
 * the state lives WITH the vault (local folder, GitHub, …) and survives a container
 * being recreated — and stays compatible with the desktop app.
 */
const ENABLED_FILE = '.obsidian/community-plugins.json';
/** Per-plugin settings, written by `saveData()` — also Obsidian's own location. */
const dataFile = (id: string) => `${PLUGINS_DIR}/${id}/data.json`;
const MAX_DATA_BYTES = 5 * 1024 * 1024;

/**
 * The enabled list from the vault. A vault that has never had the file falls back to
 * the list older versions kept in settings.json (see migrateLegacyEnabled()).
 */
async function readEnabled(): Promise<{ ids: string[]; fromFile: boolean }> {
  try {
    const parsed = JSON.parse(await vault.readFileText(ENABLED_FILE));
    if (Array.isArray(parsed)) return { ids: parsed.filter((x): x is string => typeof x === 'string'), fromFile: true };
    return { ids: [], fromFile: true };
  } catch (e: any) {
    if (e?.status === 404 || e?.code === 'ENOENT' || /not found/i.test(String(e?.message))) {
      return { ids: [...(await getSettings()).plugins.enabled], fromFile: false };
    }
    // unreadable / malformed: treat as "none enabled" rather than failing the whole plugin list
    return { ids: [], fromFile: true };
  }
}

async function writeEnabled(ids: string[]): Promise<void> {
  await vault.writeFileText(ENABLED_FILE, JSON.stringify([...new Set(ids)].sort(), null, 2) + '\n');
}

/** One-time: move the pre-existing settings.json list into the vault so it follows the vault from now on. */
export async function migrateLegacyEnabled(): Promise<void> {
  try {
    const { fromFile } = await readEnabled();
    const legacy = (await getSettings()).plugins.enabled;
    if (!fromFile && legacy.length) await writeEnabled(legacy);
  } catch {
    /* best effort: the legacy fallback keeps working */
  }
}

/**
 * A plugin id becomes a path segment under `.obsidian/plugins/`, both when
 * installing (taken from a *remote* manifest.json) and when serving assets
 * (taken from the URL). Reject anything that isn't a plain id so a crafted
 * `../../..` can't read or write outside the plugins directory.
 */
function assertSafeId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw Object.assign(new Error('Invalid plugin id'), { status: 400 });
  }
  return id;
}

export async function listInstalled(): Promise<InstalledPlugin[]> {
  const enabledIds = new Set((await readEnabled()).ids);
  let entries: string[] = [];
  try {
    entries = (await vault.listDir(PLUGINS_DIR)).filter((e) => e.isDir).map((e) => e.name);
  } catch {
    return [];
  }
  const out: InstalledPlugin[] = [];
  for (const id of entries) {
    try {
      const manifestRaw = await vault.readFileText(`${PLUGINS_DIR}/${id}/manifest.json`);
      const manifest = JSON.parse(manifestRaw) as PluginManifest;
      const hasStyles = await vault.exists(`${PLUGINS_DIR}/${id}/styles.css`);
      out.push({
        ...manifest,
        id: manifest.id || id,
        enabled: enabledIds.has(manifest.id || id),
        hasStyles,
        dir: `${PLUGINS_DIR}/${id}`,
      });
    } catch {
      /* skip invalid plugin dir */
    }
  }
  return out;
}

export async function getPluginAsset(
  id: string,
  asset: 'main.js' | 'styles.css' | 'manifest.json',
): Promise<string> {
  assertSafeId(id);
  return vault.readFileText(`${PLUGINS_DIR}/${id}/${asset}`);
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  assertSafeId(id);
  const { ids } = await readEnabled();
  const set = new Set(ids);
  if (enabled) set.add(id);
  else set.delete(id);
  if (set.size === ids.length && set.has(id) === ids.includes(id)) return; // nothing to change
  await writeEnabled([...set]);
}

/**
 * Remove a plugin: switch it off and delete its folder (code, styles and saved settings).
 * Returns false when there was nothing to delete.
 */
export async function uninstall(id: string): Promise<boolean> {
  assertSafeId(id);
  await setEnabled(id, false);
  const dir = `${PLUGINS_DIR}/${id}`;
  if (!(await vault.exists(dir))) return false;
  await vault.remove(dir);
  return true;
}

/** A plugin's saved settings (`data.json`); `{}` when it has none yet — like Obsidian's loadData(). */
export async function getPluginData(id: string): Promise<unknown> {
  assertSafeId(id);
  try {
    return JSON.parse(await vault.readFileText(dataFile(id)));
  } catch (e: any) {
    if (e instanceof SyntaxError) return {}; // corrupt file: start fresh instead of breaking the plugin
    if (e?.status === 404 || e?.code === 'ENOENT' || /not found/i.test(String(e?.message))) return {};
    throw e;
  }
}

export async function savePluginData(id: string, data: unknown): Promise<void> {
  assertSafeId(id);
  if (data === undefined) throw Object.assign(new Error('data required'), { status: 400 });
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text) > MAX_DATA_BYTES) throw Object.assign(new Error('Plugin data is too large (5 MB max)'), { status: 413 });
  await vault.writeFileText(dataFile(id), text + '\n');
}

/**
 * Install a community plugin from a GitHub repo (owner/repo). Pulls
 * manifest.json + main.js (+ styles.css) from the latest release assets.
 */
export async function installFromGithub(repo: string): Promise<InstalledPlugin> {
  const clean = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw Object.assign(new Error('repo must be owner/name'), { status: 400 });
  const assets = await releaseAssets(clean);

  const manifest = JSON.parse(await fetchText(assets['manifest.json'])) as PluginManifest;
  // id comes from a REMOTE manifest — validate before it becomes a path segment
  // (a crafted `../../..` would otherwise write main.js outside the plugins dir).
  const id = assertSafeId(manifest.id || clean.split('/')[1]);
  const target = `${PLUGINS_DIR}/${id}`;
  await vault.createFolder(target);
  await vault.writeFileText(`${target}/manifest.json`, JSON.stringify(manifest, null, 2));
  await vault.writeFileText(`${target}/main.js`, await fetchText(assets['main.js']));
  if (assets['styles.css']) {
    // from the download-URL fallback we cannot tell whether a release has styles.css: a 404 just means "none"
    const css = await fetchText(assets['styles.css'], true);
    if (css !== null) await vault.writeFileText(`${target}/styles.css`, css);
  }
  await updateSettings((d) => {
    if (!d.plugins.installed.includes(id)) d.plugins.installed.push(id);
  }); // informational only: the plugin folder in the vault is the source of truth
  const installed = await listInstalled();
  const found = installed.find((p) => p.id === id);
  if (!found) throw new Error('Install verification failed');
  return found;
}

/**
 * Where the files to install are, resolved the way Obsidian itself does it, so that what is installed is what the
 * compatibility scanner rated:
 *  1. manifest.json at the root of the default branch names the version; the release tagged exactly that version holds
 *     the files (`releases/download/<version>/…`). No API, no rate limit. This matters: a repository's *latest* release
 *     can be a different plugin id (a beta channel) from the one listed in the community catalogue.
 *  2. Otherwise the GitHub API's latest release (unauthenticated that is only 60 requests an hour per IP, and some
 *     networks block it outright), and when the API is unavailable the `releases/latest/download/<file>` URLs.
 * A 404 from the API means the repository has no release, which is a real answer.
 */
async function releaseAssets(repo: string): Promise<Record<string, string>> {
  const tagged = await taggedAssets(repo);
  if (tagged) return tagged;
  let apiError = '';
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'WebObsidian' } });
    if (res.ok) {
      const release = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
      const assets = Object.fromEntries(release.assets.map((a) => [a.name, a.browser_download_url]));
      if (!assets['manifest.json'] || !assets['main.js']) throw new Error('Release missing manifest.json or main.js');
      return assets;
    }
    if (res.status === 404) throw new Error('GitHub release lookup failed: 404 (the repository has no release)');
    apiError = String(res.status);
  } catch (e: any) {
    if (/^(Release missing|GitHub release lookup failed: 404)/.test(String(e?.message))) throw e;
    apiError = String(e?.message ?? e);
  }
  const base = `https://github.com/${repo}/releases/latest/download`;
  const probe = await fetch(`${base}/main.js`, { method: 'HEAD', headers: { 'User-Agent': 'WebObsidian' } }).catch(() => null);
  if (!probe?.ok) throw new Error(`GitHub release lookup failed: ${apiError}${probe ? ` (and no downloadable release: ${probe.status})` : ''}`);
  return { 'manifest.json': `${base}/manifest.json`, 'main.js': `${base}/main.js`, 'styles.css': `${base}/styles.css` };
}

/** Assets of the release tagged with the version in the repository's root manifest.json (Obsidian's own method), or null. */
async function taggedAssets(repo: string): Promise<Record<string, string> | null> {
  try {
    const head = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`, { headers: { 'User-Agent': 'WebObsidian' } });
    if (!head.ok) return null;
    const version = ((await head.json()) as { version?: unknown }).version;
    if (typeof version !== 'string' || !/^[\w.+-]{1,64}$/.test(version)) return null;
    const base = `https://github.com/${repo}/releases/download/${version}`;
    const probe = await fetch(`${base}/main.js`, { method: 'HEAD', headers: { 'User-Agent': 'WebObsidian' } });
    if (!probe.ok) return null;
    return { 'manifest.json': `${base}/manifest.json`, 'main.js': `${base}/main.js`, 'styles.css': `${base}/styles.css` };
  } catch {
    return null; // any trouble: let the API / latest-release path try
  }
}

async function fetchText(url: string, optional?: false): Promise<string>;
async function fetchText(url: string, optional: true): Promise<string | null>;
async function fetchText(url: string, optional = false): Promise<string | null> {
  const r = await fetch(url, { headers: { 'User-Agent': 'WebObsidian' } });
  if (optional && r.status === 404) return null;
  if (!r.ok) throw new Error(`Download failed: ${url} (${r.status})`);
  return r.text();
}

/**
 * main.js as a classic script that registers its module function under `window.__woPlugins[id]`.
 * The code starts the function body (so a leading "use strict" still applies) and the closing
 * brace sits on its own line (so a trailing `//` comment, e.g. a sourcemap URL, cannot swallow it).
 */
export function wrapPluginCode(id: string, code: string): string {
  assertSafeId(id);
  return `(window.__woPlugins = window.__woPlugins || {})[${JSON.stringify(id)}] = function (module, exports, require, process, Buffer) {${code}\n};\n`;
}
