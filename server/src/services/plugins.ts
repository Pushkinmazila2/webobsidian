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
  const relApi = `https://api.github.com/repos/${clean}/releases/latest`;
  const res = await fetch(relApi, { headers: { 'User-Agent': 'WebObsidian' } });
  if (!res.ok) throw new Error(`GitHub release lookup failed: ${res.status}`);
  const release = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
  const assets = Object.fromEntries(release.assets.map((a) => [a.name, a.browser_download_url]));
  if (!assets['manifest.json'] || !assets['main.js']) {
    throw new Error('Release missing manifest.json or main.js');
  }

  const manifest = JSON.parse(await fetchText(assets['manifest.json'])) as PluginManifest;
  // id comes from a REMOTE manifest — validate before it becomes a path segment
  // (a crafted `../../..` would otherwise write main.js outside the plugins dir).
  const id = assertSafeId(manifest.id || clean.split('/')[1]);
  const target = `${PLUGINS_DIR}/${id}`;
  await vault.createFolder(target);
  await vault.writeFileText(`${target}/manifest.json`, JSON.stringify(manifest, null, 2));
  await vault.writeFileText(`${target}/main.js`, await fetchText(assets['main.js']));
  if (assets['styles.css']) {
    await vault.writeFileText(`${target}/styles.css`, await fetchText(assets['styles.css']));
  }
  await updateSettings((d) => {
    if (!d.plugins.installed.includes(id)) d.plugins.installed.push(id);
  }); // informational only: the plugin folder in the vault is the source of truth
  const installed = await listInstalled();
  const found = installed.find((p) => p.id === id);
  if (!found) throw new Error('Install verification failed');
  return found;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': 'WebObsidian' } });
  if (!r.ok) throw new Error(`Download failed: ${url} (${r.status})`);
  return r.text();
}
