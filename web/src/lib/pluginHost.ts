/**
 * Where loaded community plugins attach their UI: commands, ribbon buttons, status-bar items
 * and settings tabs. React components read it through `usePluginHost()`; everything a plugin
 * registered is removed again when it is unloaded.
 */
import { useSyncExternalStore } from 'react';
import type { Extension } from '@codemirror/state';

export interface PluginCommand {
  /** `<plugin id>:<command id>` */
  id: string;
  pluginId: string;
  name: string;
  icon?: string;
  hotkeys?: unknown[];
  /** Whether the command can run right now (checkCallback / editorCheckCallback in "checking" mode). */
  available: () => boolean;
  run: () => void;
}
export interface PluginRibbonItem { id: string; pluginId: string; icon: string; title: string; onClick: (e: MouseEvent) => void }
export interface PluginSettingTabLike { containerEl: HTMLElement; display(): void; hide(): void }

const commands = new Map<string, PluginCommand>();
const ribbon = new Map<string, PluginRibbonItem>();
const status = new Map<string, { pluginId: string; el: HTMLElement }>();
const tabs = new Map<string, { pluginId: string; name: string; tab: PluginSettingTabLike }>();

const errors = new Map<string, string>();

export interface PostProcessorCtx {
  sourcePath: string;
  frontmatter: Record<string, unknown> | undefined;
  docId: string;
  containerEl: HTMLElement;
  addChild(child: { load(): void; unload(): void }): void;
  getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}
export type PostProcessorFn = (el: HTMLElement, ctx: PostProcessorCtx) => void | Promise<void>;
export type CodeBlockFn = (source: string, el: HTMLElement, ctx: PostProcessorCtx) => void | Promise<void>;
const postProcessors = new Map<string, { pluginId: string; fn: PostProcessorFn; sortOrder: number }>();
const codeBlockProcessors = new Map<string, { pluginId: string; lang: string; fn: CodeBlockFn; sortOrder: number }>();
const editorExtensions = new Map<string, { pluginId: string; ext: Extension }>();
/** A view type a plugin registered with `registerView(type, creator)`. */
interface ViewReg { pluginId: string; type: string; creator: (leaf: any) => any }
const views = new Map<string, ViewReg>();
/** A Bases view type a plugin registered with `registerBasesView`. */
export interface BasesViewReg { id: string; name: string; icon: string; factory: (controller: any, el: HTMLElement) => any; options?: (config: any) => any[] }
const basesViews = new Map<string, BasesViewReg & { pluginId: string }>();
const extensionViews = new Map<string, { pluginId: string; viewType: string }>();
/** A workspace leaf shown somewhere: a main-area tab or a side panel. */
export interface LeafEntry { id: string; location: 'main' | 'left' | 'right'; leaf: any; path?: string }
const leaves = new Map<string, LeafEntry>();
const leafListeners = new Set<() => void>();
let leafVersion = 0;
const bumpLeaves = () => { leafVersion++; leafListeners.forEach((l) => l()); };
let procSeq = 0;
let procVersion = 0;
let extVersion = 0;
const procListeners = new Set<() => void>();
const extListeners = new Set<() => void>();

let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach((l) => l()); };

export const pluginHost = {
  addCommand(c: PluginCommand) { commands.set(c.id, c); bump(); },
  removeCommand(id: string) { if (commands.delete(id)) bump(); },
  addRibbon(r: PluginRibbonItem) { ribbon.set(r.id, r); bump(); },
  removeRibbon(id: string) { if (ribbon.delete(id)) bump(); },
  addStatus(id: string, pluginId: string, el: HTMLElement) { status.set(id, { pluginId, el }); bump(); },
  removeStatus(id: string) { if (status.delete(id)) bump(); },
  addTab(pluginId: string, name: string, tab: PluginSettingTabLike) { tabs.set(`${pluginId}:${tabs.size}:${Math.random()}`, { pluginId, name, tab }); bump(); },
  addPostProcessor(pluginId: string, fn: PostProcessorFn, sortOrder = 0) { postProcessors.set(`pp${++procSeq}`, { pluginId, fn, sortOrder }); procVersion++; procListeners.forEach((l) => l()); },
  addCodeBlockProcessor(pluginId: string, lang: string, fn: CodeBlockFn, sortOrder = 0) { codeBlockProcessors.set(`cb${++procSeq}`, { pluginId, lang, fn, sortOrder }); procVersion++; procListeners.forEach((l) => l()); },
  postProcessors: () => [...postProcessors.values()].sort((a, b) => a.sortOrder - b.sortOrder),
  codeBlockProcessor: (lang: string) => [...codeBlockProcessors.values()].filter((c) => c.lang === lang).sort((a, b) => a.sortOrder - b.sortOrder)[0],
  hasCodeBlockProcessor: (lang: string) => [...codeBlockProcessors.values()].some((c) => c.lang === lang),
  subscribeProcessors(l: () => void) { procListeners.add(l); return () => { procListeners.delete(l); }; },
  processorVersion: () => procVersion,
  /** Editor extensions: plugins keep the array they registered and mutate it, so it is flattened on demand. */
  addEditorExtension(pluginId: string, ext: Extension) { editorExtensions.set(`ee${++procSeq}`, { pluginId, ext }); pluginHost.refreshEditorExtensions(); },
  editorExtensions: (): Extension[] => [...editorExtensions.values()].map((e) => e.ext),
  refreshEditorExtensions() { extVersion++; extListeners.forEach((l) => l()); },
  subscribeEditorExtensions(l: () => void) { extListeners.add(l); return () => { extListeners.delete(l); }; },
  editorExtensionsVersion: () => extVersion,
  addView(pluginId: string, type: string, creator: (leaf: any) => any) { views.set(type, { pluginId, type, creator }); bumpLeaves(); },
  view: (type: string) => views.get(type),
  addBasesView(pluginId: string, reg: BasesViewReg) { basesViews.set(reg.id, { ...reg, pluginId }); bumpLeaves(); },
  basesView: (id: string) => basesViews.get(id),
  basesViews: () => [...basesViews.values()],
  addExtensions(pluginId: string, exts: string[], viewType: string) { for (const e of exts) extensionViews.set(e.toLowerCase().replace(/^\./, ''), { pluginId, viewType }); bumpLeaves(); },
  /** View type registered for a file name's extension (`.excalidraw`, `.base`, …), if any. */
  viewTypeForFile(path: string): string | undefined {
    const m = /\.([^./]+)$/.exec(path);
    return m ? extensionViews.get(m[1].toLowerCase())?.viewType : undefined;
  },
  refreshLeaves() { bumpLeaves(); },
  addLeaf(e: LeafEntry) { leaves.set(e.id, e); bumpLeaves(); },
  removeLeaf(id: string) { if (leaves.delete(id)) bumpLeaves(); },
  leaf: (id: string) => leaves.get(id),
  leafByPath: (path: string) => [...leaves.values()].find((l) => l.path === path),
  leaves: (location?: LeafEntry['location']) => [...leaves.values()].filter((l) => !location || l.location === location),
  subscribeLeaves(l: () => void) { leafListeners.add(l); return () => { leafListeners.delete(l); }; },
  leavesVersion: () => leafVersion,
  /** Drop everything a plugin registered. */
  removePlugin(pluginId: string) {
    let changed = false;
    for (const m of [commands, ribbon, status, tabs] as Map<string, any>[]) {
      for (const [k, v] of [...m]) if (v.pluginId === pluginId) { m.delete(k); changed = true; }
    }
    let procChanged = false, extChanged = false;
    for (const m of [postProcessors, codeBlockProcessors] as Map<string, any>[]) for (const [k, v] of [...m]) if (v.pluginId === pluginId) { m.delete(k); procChanged = true; }
    for (const [k, v] of [...editorExtensions]) if (v.pluginId === pluginId) { editorExtensions.delete(k); extChanged = true; }
    let viewsChanged = false;
    for (const [k, v] of [...views]) if (v.pluginId === pluginId) { views.delete(k); viewsChanged = true; }
    for (const [k, v] of [...basesViews]) if (v.pluginId === pluginId) { basesViews.delete(k); viewsChanged = true; }
    for (const [k, v] of [...extensionViews]) if (v.pluginId === pluginId) { extensionViews.delete(k); viewsChanged = true; }
    // leaves whose view type belonged to this plugin go away with it
    for (const [k, l] of [...leaves]) {
      const t = l.leaf?.view?.getViewType?.();
      if (t && !views.has(t) && l.leaf?.view?.__pluginId === pluginId) { try { l.leaf.detach?.(); } catch { /* ignore */ } leaves.delete(k); viewsChanged = true; }
    }
    if (viewsChanged) bumpLeaves();
    if (procChanged) { procVersion++; procListeners.forEach((l) => l()); }
    if (extChanged) pluginHost.refreshEditorExtensions();
    if (changed) bump();
  },
  setError(pluginId: string, msg: string | null) { if (msg) errors.set(pluginId, msg); else errors.delete(pluginId); bump(); },
  error: (pluginId: string) => errors.get(pluginId),
  commands: () => [...commands.values()],
  ribbon: () => [...ribbon.values()],
  status: () => [...status.values()],
  tabs: (pluginId?: string) => [...tabs.values()].filter((t) => !pluginId || t.pluginId === pluginId),
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  version: () => version,
};

/** Re-render when plugins add/remove UI. */
export function usePluginHost(): void {
  useSyncExternalStore(pluginHost.subscribe, pluginHost.version);
}

/** Re-render the reading view when a plugin adds/removes a markdown processor. */
export function useMarkdownProcessorsVersion(): number {
  return useSyncExternalStore(pluginHost.subscribeProcessors, pluginHost.processorVersion);
}
export function useEditorExtensionsVersion(): number {
  return useSyncExternalStore(pluginHost.subscribeEditorExtensions, pluginHost.editorExtensionsVersion);
}

/** Re-render when views/leaves are added or removed. */
export function useLeaves(): number {
  return useSyncExternalStore(pluginHost.subscribeLeaves, pluginHost.leavesVersion);
}
