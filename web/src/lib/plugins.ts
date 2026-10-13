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
import { useStore } from './store';

// ---- Minimal Obsidian API shim ------------------------------------------
class Events {
  private handlers: Record<string, Function[]> = {};
  on(name: string, cb: Function) { (this.handlers[name] ??= []).push(cb); return { name, cb }; }
  off(name: string, cb: Function) { this.handlers[name] = (this.handlers[name] ?? []).filter((h) => h !== cb); }
  trigger(name: string, ...args: unknown[]) { (this.handlers[name] ?? []).forEach((h) => h(...args)); }
}

class Notice {
  constructor(message: string, _timeout?: number) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
}

class TFile {
  constructor(public path: string, public name: string) {}
  get basename() { return this.name.replace(/\.[^.]+$/, ''); }
  get extension() { return this.name.split('.').pop() ?? ''; }
}

class Vault extends Events {
  getName() { return 'WebObsidian'; }
  async read(file: TFile) { const r = await api.read(file.path); return typeof r === 'string' ? r : r.content; }
  async cachedRead(file: TFile) { return this.read(file); }
  async modify(file: TFile, data: string) { await api.write(file.path, data); }
  async create(path: string, data: string) { await api.write(path, data); return new TFile(path, path.split('/').pop()!); }
  async delete(file: TFile) { await api.remove(file.path); }
  getMarkdownFiles(): TFile[] { return flattenFiles(); }
  getFiles(): TFile[] { return flattenFiles(); }
  getAbstractFileByPath(path: string) { return new TFile(path, path.split('/').pop() ?? path); }
}

class Workspace extends Events {
  getActiveFile(): TFile | null {
    const p = useStore.getState().activePath;
    return p ? new TFile(p, p.split('/').pop()!) : null;
  }
  onLayoutReady(cb: () => void) { cb(); }
}

class App {
  vault = new Vault();
  workspace = new Workspace();
  metadataCache = new Events();
  keymap = {};
  setting = {};
}

abstract class Component {
  registerEvent(_e: unknown) {}
  registerInterval(id: number) { return id; }
  load() {}
  unload() {}
  addChild<T>(c: T) { return c; }
}

abstract class Plugin extends Component {
  app: App;
  manifest: unknown;
  constructor(app: App, manifest: unknown) { super(); this.app = app; this.manifest = manifest; }
  addCommand(_cmd: unknown) {}
  addRibbonIcon(_icon: string, _title: string, _cb: Function) { return document.createElement('div'); }
  addStatusBarItem() { return document.createElement('div'); }
  addSettingTab(_tab: unknown) {}
  // Plugin settings live in the vault (.obsidian/plugins/<id>/data.json), like in Obsidian.
  async loadData() { return (await api.pluginData(this.pluginId())).data ?? null; }
  async saveData(data: unknown) { return saveDataCoalesced(this.pluginId(), data); }
  private pluginId(): string { return (this.manifest as { id: string }).id; }
  registerMarkdownPostProcessor(_fn: unknown) {}
  registerView(_t: string, _f: unknown) {}
  abstract onload(): void | Promise<void>;
  onunload() {}
}

class PluginSettingTab { constructor(public app: App, public plugin: Plugin) {} display() {} hide() {} }
class Modal { constructor(public app: App) {} open() {} close() {} onOpen() {} onClose() {} }
class Setting {
  constructor(containerEl: HTMLElement) { this.el = containerEl; }
  el: HTMLElement;
  setName(_n: string) { return this; }
  setDesc(_d: string) { return this; }
  addText(cb: Function) { cb({ setValue: () => ({}), onChange: () => ({}), setPlaceholder: () => ({}) }); return this; }
  addToggle(cb: Function) { cb({ setValue: () => ({}), onChange: () => ({}) }); return this; }
  addButton(cb: Function) { cb({ setButtonText: () => ({}), onClick: () => ({}), setCta: () => ({}) }); return this; }
  addDropdown(cb: Function) { cb({ addOption: () => ({}), setValue: () => ({}), onChange: () => ({}) }); return this; }
}

function flattenFiles(): TFile[] {
  const tree = useStore.getState().tree;
  const out: TFile[] = [];
  const walk = (n: any) => {
    if (n.type === 'file') out.push(new TFile(n.path, n.name));
    n.children?.forEach(walk);
  };
  tree?.children?.forEach(walk);
  return out;
}

const obsidianModule = {
  App, Plugin, Component, Notice, TFile, Vault, Workspace, Events,
  PluginSettingTab, Modal, Setting,
  MarkdownView: class {}, ItemView: class {}, addIcon: () => {},
  normalizePath: (p: string) => p.replace(/\\/g, '/'),
  moment: () => ({ format: () => new Date().toISOString() }),
};

const sharedApp = new App();
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

/** Evaluate one plugin's main.js against the shim. */
async function loadPlugin(id: string, manifest: any) {
  if (loaded.has(id)) return;
  const code = await fetch(`/api/plugins/${id}/main.js`, { credentials: 'include', headers: vaultHeaders() }).then((r) => r.text());
  const module = { exports: {} as any };
  const require = (name: string) => {
    if (name === 'obsidian') return obsidianModule;
    throw new Error(`Plugin "${id}" required unsupported module: ${name}`);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', code);
  fn(module, module.exports, require);
  const PluginClass = module.exports.default ?? module.exports;
  const instance: Plugin = new PluginClass(sharedApp, manifest);
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
  try { await p.instance.onunload?.(); } catch (e) { console.warn(`[plugin] ${id} failed to unload cleanly:`, e); }
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
    for (const id of [...loaded.keys()]) if (!enabled.has(id)) await unloadPlugin(id);
    for (const p of plugins.filter((x: any) => x.enabled)) {
      if (loaded.has(p.id)) continue;
      try {
        await loadPlugin(p.id, p);
      } catch (e) {
        console.warn(`[plugin] failed to load ${p.id}:`, e);
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
  await syncPlugins();
  setInterval(() => { if (!document.hidden) void syncPlugins(); }, SYNC_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncPlugins(); });
}
