import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import Icon, { hasIcon } from './Icon';
import { pluginHost, usePluginHost, useLeaves } from '../lib/pluginHost';

export default function Ribbon({ onTheme }: { onTheme: () => void }) {
  const setLeftPanel = useStore((s) => s.setLeftPanel);
  const leftPanel = useStore((s) => s.leftPanel);
  const setGraph = useStore((s) => s.setGraph);
  const setSettings = useStore((s) => s.setSettings);
  const setPalette = useStore((s) => s.setPalette);
  const openDailyNote = useStore((s) => s.openDailyNote);
  const notify = useStore((s) => s.notify);
  const loadTree = useStore((s) => s.loadTree);
  usePluginHost();
  useLeaves();

  // Show the Sync-now button only when git sync is enabled in settings.
  const [gitEnabled, setGitEnabled] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    const refresh = () => api.gitStatus().then((g) => setGitEnabled(!!g?.enabled)).catch(() => setGitEnabled(false));
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, []);

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    notify('Syncing…');
    try {
      const r = await api.gitSync();
      notify(r.ok ? 'Synced ✓' : `Sync: ${r.log.at(-1)}`);
      await loadTree();
    } catch (e: any) {
      notify(`Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="ribbon">
      <button className={leftPanel === 'files' ? 'active' : ''} title="Files" onClick={() => setLeftPanel('files')}>
        <Icon name="file-text" size={18} />
      </button>
      <button className={leftPanel === 'search' ? 'active' : ''} title="Search (⌘⇧F)" onClick={() => setLeftPanel('search')}>
        <Icon name="search" size={18} />
      </button>
      <button title="Graph view" onClick={() => setGraph(true)}>
        <Icon name="graph" size={18} />
      </button>
      <button className={leftPanel === 'bookmarks' ? 'active' : ''} title="Bookmarks & recent" onClick={() => setLeftPanel('bookmarks')}>
        <Icon name="bookmark" size={18} />
      </button>
      <button title="Daily note" onClick={() => openDailyNote()}>
        <Icon name="calendar" size={18} />
      </button>
      <button className={leftPanel === 'tags' ? 'active' : ''} title="Tags" onClick={() => setLeftPanel('tags')}>
        <Icon name="hash" size={18} />
      </button>
      <button title="Command palette (⌘P)" onClick={() => setPalette(true, 'commands')}>
        <Icon name="command" size={18} />
      </button>
      {/* Icons added by plugins live in their own scrollable strip between the built-in buttons. */}
      <div className="ribbon-plugins">
      {pluginHost.ribbon().map((r) => (
        <button key={r.id} title={r.title} onClick={(e) => r.onClick(e.nativeEvent)}>
          {hasIcon(r.icon) ? <Icon name={r.icon} size={18} /> : <span className="plugin-ribbon-letter">{r.title.slice(0, 1).toUpperCase()}</span>}
        </button>
      ))}
      {pluginHost.leaves('left').map(({ leaf }) => (
        <button key={leaf.id} className={leftPanel === `plugin:${leaf.id}` ? 'active' : ''} title={leaf.view?.getDisplayText?.() ?? 'Plugin'} onClick={() => setLeftPanel(`plugin:${leaf.id}`)}>
          {hasIcon(leaf.view?.getIcon?.() ?? '') ? <Icon name={leaf.view.getIcon()} size={18} /> : <span className="plugin-ribbon-letter">{(leaf.view?.getDisplayText?.() ?? 'P').slice(0, 1).toUpperCase()}</span>}
        </button>
      ))}
      </div>
      {gitEnabled && (
        <button title={syncing ? 'Syncing…' : 'Sync now'} onClick={sync} disabled={syncing}>
          <Icon name="refresh-cw" size={18} style={syncing ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
      )}
      <button title="Toggle theme" onClick={onTheme}>
        <Icon name="moon" size={18} />
      </button>
      <button title="Settings" onClick={() => setSettings(true)}>
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}
