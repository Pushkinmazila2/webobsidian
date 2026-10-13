/**
 * Where loaded community plugins attach their UI: commands, ribbon buttons, status-bar items
 * and settings tabs. React components read it through `usePluginHost()`; everything a plugin
 * registered is removed again when it is unloaded.
 */
import { useSyncExternalStore } from 'react';

export interface PluginCommand {
  /** `<plugin id>:<command id>` */
  id: string;
  pluginId: string;
  name: string;
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

let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach((l) => l()); };

export const pluginHost = {
  addCommand(c: PluginCommand) { commands.set(c.id, c); bump(); },
  addRibbon(r: PluginRibbonItem) { ribbon.set(r.id, r); bump(); },
  removeRibbon(id: string) { if (ribbon.delete(id)) bump(); },
  addStatus(id: string, pluginId: string, el: HTMLElement) { status.set(id, { pluginId, el }); bump(); },
  removeStatus(id: string) { if (status.delete(id)) bump(); },
  addTab(pluginId: string, name: string, tab: PluginSettingTabLike) { tabs.set(`${pluginId}:${tabs.size}:${Math.random()}`, { pluginId, name, tab }); bump(); },
  /** Drop everything a plugin registered. */
  removePlugin(pluginId: string) {
    let changed = false;
    for (const m of [commands, ribbon, status, tabs] as Map<string, any>[]) {
      for (const [k, v] of [...m]) if (v.pluginId === pluginId) { m.delete(k); changed = true; }
    }
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
