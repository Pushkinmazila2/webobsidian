import { useEffect, useState } from 'react';
import { api, type VaultInfo } from '../lib/api';
import { currentVaultId, switchVault } from '../lib/vault';
import Icon from './Icon';
import { Note, Row, StorageEditor, rulesValid, storagePayload, toStorageValue, type StorageValue } from './StorageSettings';

const DRIVER_NAME = { local: 'Folder', github: 'GitHub', git: 'Git' } as const;

/** Folder picker for "a folder on this server" (main vault and extra vaults alike). */
function FolderField({ value, onChange, desc }: { value: string; onChange: (v: string) => void; desc: string }) {
  const [browser, setBrowser] = useState<any>(null);
  const browse = async (dir?: string) => setBrowser(await api.browse(dir).catch((e) => ({ error: e.message })));
  return (
    <>
      <Row name="Folder path" desc={desc}>
        <input className="text-input" style={{ width: 260 }} value={value} placeholder="/data/notes" onChange={(e) => onChange(e.target.value)} />
      </Row>
      <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <button className="btn secondary" onClick={() => browse()}>Browse…</button>
      </div>
      {browser && !browser.error && (
        <div style={{ border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{browser.dir}</div>
          <div className="result" onClick={() => browse(browser.parent)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="folder" size={15} /> ..
          </div>
          {browser.folders.map((f: any) => (
            <div className="result" key={f.path} onClick={() => browse(f.path)} onDoubleClick={() => onChange(f.path)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="folder" size={15} /> {f.name}
              <button className="btn secondary" style={{ float: 'right', padding: '2px 8px' }} onClick={(e) => { e.stopPropagation(); onChange(f.path); }}>Select</button>
            </div>
          ))}
        </div>
      )}
      {browser?.error && <div style={{ color: '#e5534b' }}>{browser.error}</div>}
    </>
  );
}

/** Which community plugins a vault uses: the main vault's (shared) or its own set, with a way to take chosen ones over. */
function PluginsMode({ vaultId, mode, onMode }: { vaultId?: string; mode: 'own' | 'shared'; onMode: (m: 'own' | 'shared') => void }) {
  const [avail, setAvail] = useState<any[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!vaultId || mode !== 'own') return;
    api.vaultPlugins(vaultId).then((r) => setAvail(r.mode === 'own' ? r.available : null)).catch(() => setAvail(null));
  };
  useEffect(load, [vaultId, mode]);

  const transfer = async (move: boolean) => {
    if (!vaultId || !picked.size) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.transferPlugins(vaultId, { ids: [...picked], move });
      setPicked(new Set());
      setMsg(r.failed.length
        ? { kind: 'error', text: `${r.done.length ? `${move ? 'Moved' : 'Copied'} ${r.done.join(', ')}. ` : ''}Failed: ${r.failed.map((f) => `${f.id} (${f.error})`).join('; ')}` }
        : { kind: 'ok', text: `${move ? 'Moved' : 'Copied'} ${r.done.join(', ')}. Reload the page in that vault to start them.` });
      load();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row name="Community plugins" desc={mode === 'shared'
        ? 'This vault uses exactly the same plugins and plugin settings as the main vault (one set of files). Installing or changing a plugin here changes it everywhere.'
        : 'This vault keeps its own plugins and settings. Take chosen plugins over from the main vault below.'}>
        <select className="text-input" style={{ width: 220 }} value={mode} onChange={(e) => onMode(e.target.value as any)}>
          <option value="own">Own plugins</option>
          <option value="shared">Same as the main vault</option>
        </select>
      </Row>
      {mode === 'own' && vaultId && (
        <div style={{ margin: '4px 0 8px' }}>
          {avail === null ? null : avail.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>The main vault has no other plugins to take over.</div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, marginBottom: 4 }}>Plugins of the main vault that this vault doesn’t have:</div>
              {avail.map((p) => (
                <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0', fontSize: 13 }}>
                  <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                  {p.name} <span style={{ color: 'var(--text-muted)' }}>{p.version}{p.enabled ? ' · on' : ''}</span>
                </label>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn secondary" disabled={busy || !picked.size} onClick={() => transfer(false)} title="The plugin stays in the main vault too">Copy selected</button>
                <button className="btn secondary" disabled={busy || !picked.size} onClick={() => transfer(true)} title="Removes the plugin (and its settings) from the main vault">Move selected</button>
              </div>
            </>
          )}
          {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        </div>
      )}
    </>
  );
}

/** The main vault: folder or remote, rules, and the file-handling options that apply to every vault. */
function MainVaultPanel({ s, reload }: { s: any; reload: () => Promise<void> | void }) {
  const [value, setValue] = useState<StorageValue>(toStorageValue(s.storage));
  const [path, setPath] = useState<string>(s.vault.path);
  const [deleteMode, setDeleteMode] = useState<string>(s.vault.deleteMode ?? 'trash');
  const [status, setStatus] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadStatus = () => api.storageStatus().then(setStatus).catch(() => {});
  useEffect(() => { loadStatus(); const id = setInterval(loadStatus, 5000); return () => clearInterval(id); }, []);

  const locked: Record<string, string> = status?.locked ?? {};
  const remote = status?.remote;
  const pending = remote?.pending ?? 0;
  const remoteName = status?.active === 'git' ? 'the remote' : 'GitHub';

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.putSettings({ vault: { path, deleteMode }, storage: storagePayload(value) });
      await reload();
      await loadStatus();
      setMsg({ kind: 'ok', text: 'Saved. Restart the server to apply changes to where the vault lives.' });
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {Object.keys(locked).length > 0 && (
        <Note kind="info">Some settings are fixed by environment variables ({[...new Set(Object.values(locked))].join(', ')}) and are greyed out. Remove the variable and restart the server to edit them here.</Note>
      )}
      {status?.restartRequired && (
        <Note kind="warn">Saved settings differ from what the server is running. <b>Restart the server</b> to apply them — until then the vault keeps using <b>{status.active === 'github' ? 'GitHub' : status.active === 'git' ? 'the Git remote' : 'the local folder'}</b>.</Note>
      )}
      {(status?.active === 'github' || status?.active === 'git') && (
        <Note kind={remote?.lastError ? 'error' : 'info'}>
          Connected to <b>{remote?.repo}</b> ({remote?.branch}).{' '}
          {pending > 0 ? <b>{pending} change(s) not yet saved to {remoteName}{remote?.held > 0 ? ` (${remote.held} of them plugin/app settings, held back on purpose)` : ''}.</b> : `Everything is saved to ${remoteName}.`}
          {remote?.lastError && <div style={{ marginTop: 4 }}>Last save failed: {remote.lastError}. It will be retried automatically.</div>}
          {remote?.conflicts?.length > 0 && <div style={{ marginTop: 4 }}>Edited on both sides — your version was kept as: {remote.conflicts.map((c: string) => `“${c}”`).join(', ')}</div>}
        </Note>
      )}
      <StorageEditor
        value={value}
        onChange={setValue}
        locked={locked}
        status={status}
        localFields={<FolderField value={path} onChange={setPath} desc="Absolute path on the server to your notes folder" />}
        onTest={(v) => (v.driver === 'git' ? api.storageTestGit(storagePayload(v).git) : api.storageTest(storagePayload(v).github))}
      />
      <Row name="When deleting a file" desc="Applies to every vault. Move to .trash keeps a recoverable copy (Open trash to restore). Permanently delete removes it immediately.">
        <select className="text-input" style={{ width: 220 }} value={deleteMode} onChange={(e) => setDeleteMode(e.target.value)}>
          <option value="trash">Move to .trash (recoverable)</option>
          <option value="permanent">Permanently delete</option>
        </select>
      </Row>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <button className="btn" onClick={save} disabled={saving || !rulesValid(value)}>{saving ? 'Saving…' : 'Save'}</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Changes to where the vault lives take effect after a server restart.</span>
      </div>
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
    </div>
  );
}

/** One extra vault (existing → edit, or new). Each has its own storage settings, rules, cache and plugin mode. */
function ExtraVaultPanel({ id, onDone }: { id?: string; onDone: () => void }) {
  const [loaded, setLoaded] = useState(!id);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const [pluginsMode, setPluginsMode] = useState<'own' | 'shared'>('own');
  const [value, setValue] = useState<StorageValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fromEnv, setFromEnv] = useState(false);

  useEffect(() => {
    if (!id) {
      api.getSettings().then((s) => {
        // new vaults start from the same defaults as the main vault's rules/cache, but with no repository filled in
        const v = toStorageValue(s.storage);
        v.driver = 'local';
        v.github = { ...v.github, owner: '', repo: '', branch: '', basePath: '', token: '' };
        v.git = { ...v.git, url: '', branch: '', basePath: '', username: '', token: '' };
        setValue(v);
      });
      return;
    }
    api.getVault(id).then(({ vault }) => {
      setName(vault.name);
      setPath(vault.path);
      setTokenEnv(vault.tokenEnv);
      setPluginsMode(vault.plugins?.mode ?? 'own');
      setValue(toStorageValue(vault.storage));
      setFromEnv(!!vault.fromEnv);
      setLoaded(true);
    }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [id]);

  if (!value || !loaded) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  const payload = () => ({
    name: name.trim(),
    path: value.driver === 'local' ? path.trim() : '',
    tokenEnv: tokenEnv.trim(),
    plugins: { mode: pluginsMode },
    storage: storagePayload(value),
  });

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (id) await api.updateVault(id, payload());
      else await api.createVault(payload());
      onDone();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!id || !confirm(`Remove "${name}" from the list? Its ${value.driver === 'local' ? 'folder' : 'repository'} is not touched. Unsaved changes are saved first.`)) return;
    try {
      await api.deleteVault(id);
      if (id === currentVaultId()) switchVault('default');
      else onDone();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    }
  };

  return (
    <div>
      {fromEnv && <Note kind="info">This vault is defined by WEBOBSIDIAN_VAULTS and is read-only here.</Note>}
      <Row name="Name">
        <input className="text-input" style={{ width: 275 }} value={name} onChange={(e) => setName(e.target.value)} />
      </Row>
      <StorageEditor
        value={value}
        onChange={setValue}
        driverFixed={!!id}
        tokenEnv={{ value: tokenEnv, onChange: setTokenEnv }}
        localFields={<FolderField value={path} onChange={setPath} desc="Must be inside the allowed roots." />}
        onTest={(v) => {
          const extra = { vault: id, tokenEnv: tokenEnv.trim() || undefined };
          return v.driver === 'git' ? api.storageTestGit(storagePayload(v).git, extra) : api.storageTest(storagePayload(v).github, extra);
        }}
      />
      <PluginsMode vaultId={id} mode={pluginsMode} onMode={setPluginsMode} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <button className="btn" disabled={busy || fromEnv || !name.trim() || !rulesValid(value)} onClick={save}>{busy ? 'Saving…' : id ? 'Save' : 'Add vault'}</button>
        {id && !fromEnv && <button className="btn secondary" onClick={remove}>Remove</button>}
        <button className="btn secondary" onClick={onDone}>{id ? 'Close' : 'Cancel'}</button>
      </div>
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
    </div>
  );
}

/**
 * Settings → Vaults: every vault in one list. "Configure" opens that vault’s settings in place — where it lives (folder,
 * GitHub, Git), what the server keeps, plugins; the main vault also carries the file options that used to be on their own page.
 */
export default function VaultsSettings({ s, reload }: { s: any; reload: () => Promise<void> | void }) {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [open, setOpen] = useState<string | null>(null); // vault id, or '+' for a new one
  const cur = currentVaultId();

  const load = () => api.listVaults().then((r) => setVaults(r.vaults)).catch(() => {});
  useEffect(() => { load(); }, []);
  const closeAndReload = () => { setOpen(null); load(); };

  return (
    <div>
      <h2>Vaults</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Each browser tab works on one vault; switch with the vault name at the bottom of the sidebar. A vault can be a folder on this
        server, a GitHub repository or any Git remote. Every vault has its own storage settings.
      </p>

      {vaults.map((v) => {
        const isOpen = open === v.id;
        return (
          <div key={v.id} style={{ borderTop: '1px solid var(--bg-modifier-border)', padding: '6px 0' }}>
            <Row
              name={`${v.name}${v.id === cur ? ' · this tab' : ''}`}
              desc={`${DRIVER_NAME[v.driver]}: ${v.location || '—'}${v.isDefault ? ' · main vault' : ''}${v.fromEnv ? ' · set by WEBOBSIDIAN_VAULTS' : ''}${!v.isDefault ? ` · ${v.pluginsMode === 'shared' ? 'main vault’s plugins' : 'own plugins'}` : ''}`}
            >
              {v.id !== cur && <button className="btn secondary" onClick={() => switchVault(v.id)}>Open</button>}{' '}
              <button className="btn secondary" onClick={() => setOpen(isOpen ? null : v.id)}>{isOpen ? 'Close' : 'Configure'}</button>
            </Row>
            {isOpen && (
              <div style={{ padding: '4px 0 10px 12px', borderLeft: '2px solid var(--bg-modifier-border)' }}>
                {v.isDefault ? <MainVaultPanel s={s} reload={reload} /> : <ExtraVaultPanel id={v.id} onDone={closeAndReload} />}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ borderTop: '1px solid var(--bg-modifier-border)', padding: '10px 0' }}>
        {open === '+' ? (
          <div style={{ padding: '4px 0 10px 12px', borderLeft: '2px solid var(--bg-modifier-border)' }}>
            <h4>New vault</h4>
            <ExtraVaultPanel onDone={closeAndReload} />
          </div>
        ) : (
          <button className="btn" onClick={() => setOpen('+')}>Add vault…</button>
        )}
      </div>
    </div>
  );
}
