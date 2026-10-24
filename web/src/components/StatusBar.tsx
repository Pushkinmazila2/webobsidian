import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import Icon from './Icon';
import { pluginHost, usePluginHost } from '../lib/pluginHost';

/** Mounts a DOM element created by a plugin (addStatusBarItem) into the status bar. */
function HostedEl({ el }: { el: HTMLElement }) {
  return <span ref={(n) => { if (n && el.parentNode !== n) n.appendChild(el); }} />;
}

export default function StatusBar() {
  const content = useStore((s) => s.content);
  const activePath = useStore((s) => s.activePath);
  const dirty = useStore((s) => s.dirty);
  const loadTree = useStore((s) => s.loadTree);
  const notify = useStore((s) => s.notify);
  const [git, setGit] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  usePluginHost();

  const refresh = () => api.gitStatus().then(setGit).catch(() => setGit(null));
  useEffect(() => {
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
      await refresh();
    } catch (e: any) {
      notify(`Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const isText = activePath && /\.(md|markdown|txt)$/i.test(activePath);
  const words = isText ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  const gh = git?.driver === 'github' || git?.driver === 'git';
  const remoteName = git?.driver === 'git' ? 'Git' : 'GitHub';
  const gitLabel = gh
    ? git.lastError
      ? `${remoteName}: save failed — retrying`
      : git.ahead
        ? `${git.ahead} unsaved to ${remoteName}`
        : `${remoteName} ${git.branch} ✓`
    : !git?.isRepo
    ? 'No vault sync'
    : git.clean
      ? `git ${git.branch}${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`
      : `${git.modified + git.notAdded} unsaved changes`;

  return (
    <div className="status-bar">
      {pluginHost.status().map((x, i) => <HostedEl key={i} el={x.el} />)}
      {dirty && <span>Saving…</span>}
      {isText && <span>{words} words</span>}
      {isText && <span>{content.length} characters</span>}
      <span className="clickable" title={gh ? (git.lastError ? `Click to retry: ${git.lastError}` : 'Click to save to GitHub now') : 'Git sync'} onClick={sync}>
        <Icon name="refresh-cw" size={13} style={syncing ? { animation: 'spin 1s linear infinite' } : undefined} />
        {gitLabel}
      </span>
    </div>
  );
}
