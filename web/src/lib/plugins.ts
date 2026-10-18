/**
 * Obsidian community-plugin loader + API shim (PRD FR-8, browser side).
 *
 * Obsidian plugins are CommonJS modules that `require('obsidian')` and export a
 * default class extending `Plugin`. We provide a compatibility shim exposing a
 * commonly-used subset of the Obsidian API, then evaluate each enabled plugin's
 * main.js against it. Plugins relying on Electron/Node internals will fail
 * softly (their missing-API calls throw and are caught) — logged, not fatal.
 */
import { vaultHeaders, withVault } from './vault';
import { api } from './api';
import { pluginHost } from './pluginHost';
import { loadLucide } from '../components/Icon';
import { App, Notice, Plugin, moment, obsidianModule, setPluginDataBackend, startMetadataCache } from './obsidianApi';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as cmCommands from '@codemirror/commands';
import * as cmAutocomplete from '@codemirror/autocomplete';
import * as cmLanguage from '@codemirror/language';
import * as cmSearch from '@codemirror/search';
import * as cmLint from '@codemirror/lint';
import * as lezerCommon from '@lezer/common';
import * as lezerHighlight from '@lezer/highlight';
import * as lezerLr from '@lezer/lr';

const sharedApp = new App();
// Obsidian exposes the app as a global too (`window.app` / bare `app`); many plugins read it that way.
(window as any).app = sharedApp;
// Obsidian also exposes moment.js globally (`window.moment`).
(window as any).moment = moment;
setPluginDataBackend({
  // Obsidian's loadData() is null when the plugin has no data.json yet; the server answers {} then.
  load: async (id) => {
    const d = (await api.pluginData(id)).data ?? null;
    return d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 0 ? null : d;
  },
  save: (id, data) => saveDataCoalesced(id, data),
});
const loaded = new Map<string, { instance: Plugin; style?: HTMLLinkElement }>();

// saveData() can be called in a tight loop (a slider, typing in a setting). Keep at most one
// request in flight per plugin and send only the newest value after it: nothing is lost,
// the server isn't flooded, and every caller's promise resolves once its data (or newer) is saved.
const saving = new Map<string, { inflight: Promise<void>; next?: { data: unknown; waiters: { ok: () => void; fail: (e: unknown) => void }[] } }>();
function saveDataCoalesced(id: string, data: unknown): Promise<void> {
  const cur = saving.get(id);
  if (!cur) {
    const entry: { inflight: Promise<void>; next?: any } = { inflight: Promise.resolve() };
    saving.set(id, entry);
    const run = (d: unknown): Promise<void> =>
      api.savePluginData(id, d).then(() => {
        const n = entry.next;
        if (!n) { saving.delete(id); return; }
        entry.next = undefined;
        return run(n.data).then(() => n.waiters.forEach((w: any) => w.ok()), (e) => n.waiters.forEach((w: any) => w.fail(e)));
      }, (e) => {
        saving.delete(id);
        entry.next?.waiters.forEach((w: any) => w.fail(e)); // don't leave queued callers hanging
        throw e;
      });
    entry.inflight = run(data);
    return entry.inflight;
  }
  return new Promise<void>((ok, fail) => {
    if (cur.next) { cur.next.data = data; cur.next.waiters.push({ ok, fail }); }
    else cur.next = { data, waiters: [{ ok, fail }] };
  });
}

const EXTERNALS: Record<string, unknown> = {
  '@codemirror/state': cmState, '@codemirror/view': cmView, '@codemirror/commands': cmCommands,
  '@codemirror/autocomplete': cmAutocomplete, '@codemirror/language': cmLanguage, '@codemirror/search': cmSearch,
  '@codemirror/lint': cmLint, '@lezer/common': lezerCommon, '@lezer/highlight': lezerHighlight, '@lezer/lr': lezerLr,
};
const NODE_BUILTINS = new Set(['fs', 'fs/promises', 'os', 'crypto', 'util', 'zlib', 'url', 'child_process', 'stream', 'events', 'buffer', 'http', 'https', 'net', 'tls', 'electron', 'original-fs', 'process', 'assert', 'readline', 'worker_threads', 'module', 'vm']);
const unavailable = (mod: string, plugin: string) =>
  new Proxy({}, {
    get: (_t, key) => {
      if (key === '__esModule' || key === 'then' || typeof key === 'symbol') return undefined;
      return () => { throw new Error(`"${mod}" is not available in WebObsidian (plugin "${plugin}" called ${String(key)}())`); };
    },
  });
const pathShim = {
  sep: '/', delimiter: ':',
  join: (...p: string[]) => p.join('/').replace(/\/+/g, '/'),
  resolve: (...p: string[]) => p.join('/').replace(/\/+/g, '/'),
  basename: (p: string, ext?: string) => { const b = p.split('/').pop() ?? ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
  dirname: (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); },
  extname: (p: string) => { const b = p.split('/').pop() ?? ''; const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
  normalize: (p: string) => p.replace(/\/+/g, '/'),
  isAbsolute: (p: string) => p.startsWith('/'),
  relative: (_a: string, b: string) => b,
};

/** Evaluate one plugin's main.js against the shim. */
async function loadPlugin(id: string, manifest: any) {
  if (loaded.has(id)) return;
  const module = { exports: {} as any };
  const require = (name: string) => {
    if (name === 'obsidian') return obsidianModule;
    // Editor libraries are the app's own instances: plugins extending the editor must share its classes.
    if (name in EXTERNALS) return EXTERNALS[name];
    // Node/Electron built-ins do not exist in a browser. Many plugins only touch them on desktop-only
    // code paths, so hand back a stub that fails when *used* instead of refusing to start.
    const bare = name.replace(/^node:/, '');
    if (bare === 'path') return pathShim;
    if (NODE_BUILTINS.has(bare)) return unavailable(bare, id);
    throw new Error(`Plugin "${id}" required unsupported module: ${name}`);
  };
  // The page's CSP forbids evaluating code from strings, so the plugin is loaded as a
  // same-origin <script> (the server wraps its CommonJS code, see wrapPluginCode()).
  const registry = ((window as any).__woPlugins ??= {}) as Record<string, (m: any, e: any, r: any) => void>;
  delete registry[id];
  await new Promise<void>((ok, fail) => {
    const el = document.createElement('script');
    el.src = withVault(`/api/plugins/${encodeURIComponent(id)}/main.js?wrap=1&t=${Date.now()}`);
    el.onload = () => { el.remove(); ok(); };
    el.onerror = () => { el.remove(); fail(new Error(`could not load main.js of ${id}`)); };
    document.head.appendChild(el);
  });
  const run = registry[id];
  if (!run) throw new Error(`Plugin "${id}" did not register`);
  delete registry[id];
  run(module, module.exports, require);
  const PluginClass = module.exports.default ?? module.exports;
  const instance: Plugin = new PluginClass(sharedApp, manifest);
  sharedApp.plugins.plugins[id] = instance; sharedApp.plugins.manifests[id] = manifest; sharedApp.plugins.enabledPlugins.add(id);
  await instance.onload?.();
  let style: HTMLLinkElement | undefined;
  // inject plugin styles if any
  if (manifest.hasStyles) {
    style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = withVault(`/api/plugins/${id}/styles.css`);
    document.head.appendChild(style);
  }
  loaded.set(id, { instance, style });
  console.log(`[plugin] loaded ${id}`);
}

/** Turn a plugin off in this tab: let it clean up, drop its styles. */
async function unloadPlugin(id: string) {
  const p = loaded.get(id);
  if (!p) return;
  loaded.delete(id);
  delete sharedApp.plugins.plugins[id]; delete sharedApp.plugins.manifests[id]; sharedApp.plugins.enabledPlugins.delete(id);
  try { await p.instance.onunload?.(); } catch (e) { console.warn(`[plugin] ${id} failed to unload cleanly:`, e); }
  p.instance.teardown(); // commands, ribbon, status bar, settings tab, listeners, timers
  p.style?.remove();
  console.log(`[plugin] unloaded ${id}`);
}

let syncing = false;
/**
 * Bring this tab in line with the vault's plugin state (community-plugins.json): load newly
 * enabled plugins, unload disabled ones. The state lives in the vault, so it can change
 * behind our back (another tab, another device, a git push) — hence the periodic call.
 */
export async function syncPlugins(): Promise<{ unsaved: number } | null> {
  if (syncing) return null;
  syncing = true;
  try {
    const { plugins, unsaved } = await api.listPlugins();
    const enabled = new Set<string>(plugins.filter((x: any) => x.enabled).map((x: any) => x.id));
    if (enabled.size > 0) await loadLucide(); // plugins refer to icons by Lucide name
    for (const id of [...loaded.keys()]) if (!enabled.has(id)) await unloadPlugin(id);
    for (const p of plugins.filter((x: any) => x.enabled)) {
      if (loaded.has(p.id)) continue;
      try {
        await loadPlugin(p.id, p);
        pluginHost.setError(p.id, null);
      } catch (e) {
        console.warn(`[plugin] failed to load ${p.id}:`, e);
        pluginHost.removePlugin(p.id); // drop whatever it registered before failing
        pluginHost.setError(p.id, String((e as Error)?.message ?? e));
        new Notice(`Plugin "${p.name}" failed to load (incompatible API)`);
      }
    }
    return { unsaved: unsaved ?? 0 };
  } catch {
    return null; // not authed / no plugins
  } finally {
    syncing = false;
  }
}

const SYNC_EVERY_MS = 30_000;
/** Load all enabled community plugins, then keep following the vault's plugin state. */
export async function loadPlugins(): Promise<void> {
  // Plugins index the vault through app.metadataCache as soon as they load, so it must be populated first.
  await Promise.race([startMetadataCache().catch((e) => console.warn('[metadata] initial load failed:', e)), new Promise((r) => setTimeout(r, 20000))]);
  await syncPlugins();
  setInterval(() => { if (!document.hidden) void syncPlugins(); }, SYNC_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncPlugins(); });
}
