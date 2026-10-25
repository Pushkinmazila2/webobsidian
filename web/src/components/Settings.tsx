import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import Icon from './Icon';
import VaultsSettings from './VaultsSettings';
import { syncPlugins } from '../lib/plugins';
import { pluginHost, usePluginHost } from '../lib/pluginHost';
import PluginBrowser, { CompatBadge } from './PluginBrowser';

type Section = 'vaults' | 'git' | 'api' | 'sharing' | 'plugins' | 'appearance' | 'account' | 'about';

export default function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('vaults');
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    if (open) api.getSettings().then(setSettings).catch(() => {});
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <div className="settings-nav">
            {(['vaults', 'git', 'api', 'sharing', 'plugins', 'appearance', 'account', 'about'] as Section[]).map((s) => (
              <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
                {labels[s]}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {settings && section === 'vaults' && <VaultsSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {settings && section === 'git' && <GitSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'api' && <ApiKeys />}
            {section === 'sharing' && <Shares />}
            {section === 'plugins' && <Plugins />}
            {settings && section === 'appearance' && <Appearance s={settings} />}
            {section === 'account' && <AccountSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'about' && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}

const labels: Record<Section, string> = {
  vaults: 'Vaults',
  git: 'GitHub Sync',
  api: 'API Keys',
  sharing: 'Sharing',
  plugins: 'Community Plugins',
  appearance: 'Appearance',
  account: 'Account',
  about: 'About',
};

function Row({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="info">
        <div className="name">{name}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

function GitSettings({ s, reload }: { s: any; reload: () => void }) {
  const [g, setG] = useState({ ...s.git });
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const set = (k: string, v: any) => setG((p: any) => ({ ...p, [k]: v }));
  // Append timestamped lines to the running log instead of replacing it, so the
  // textarea keeps a history of every git action across clicks.
  const append = (lines: string[]) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, ...lines.map((l, i) => (i === 0 ? `[${ts}] ${l}` : `         ${l}`))]);
  };
  // Auto-scroll to the newest line whenever the log grows.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  const save = async () => { await api.putSettings({ git: g }); await reload(); append(['Saved git settings']); };
  const run = async (fn: () => Promise<any>, label: string) => {
    append([`${label}…`]);
    try {
      const r = await fn();
      // sync returns { ok, log: string[] }; others return { message }. Split any
      // embedded newlines so multi-line git output renders one line per row.
      const lines: string[] = Array.isArray(r?.log)
        ? [`${label} ${r.ok ? 'ok' : 'NOT ok'}`, ...r.log]
        : [String(r?.message ?? JSON.stringify(r))];
      append(lines.flatMap((l) => String(l).split('\n')));
    } catch (e: any) { append([`Error: ${e.message}`]); }
  };
  return (
    <div>
      <h2>GitHub Sync</h2>
      {(s.storage?.driver === 'github' || s.storage?.driver === 'git') && (
        <div style={{ border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, fontSize: 12.5 }}>
          The vault is stored in a {s.storage.driver === 'git' ? 'Git' : 'GitHub'} repository (see <b>Vaults</b>), which the server handles itself. Edits are committed
          and pushed automatically; <b>Sync now</b> does it immediately and checks for new commits. Init, Clone, history and the
          options below don’t apply.
        </div>
      )}
      <Row name="Enable git sync"><input type="checkbox" checked={g.enabled} onChange={(e) => set('enabled', e.target.checked)} /></Row>
      <Row name="Remote URL" desc="https://github.com/owner/repo.git">
        <input className="text-input" style={{ width: 260 }} value={g.remote} onChange={(e) => set('remote', e.target.value)} />
      </Row>
      <Row name="Branch"><input className="text-input" style={{ width: 120 }} value={g.branch} onChange={(e) => set('branch', e.target.value)} /></Row>
      <Row name="Access token (PAT)" desc="Stored server-side; leave masked to keep current">
        <input className="text-input" type="password" style={{ width: 260 }} value={g.token} onChange={(e) => set('token', e.target.value)} />
      </Row>
      <Row name="Author name"><input className="text-input" value={g.authorName} onChange={(e) => set('authorName', e.target.value)} /></Row>
      <Row name="Author email"><input className="text-input" value={g.authorEmail} onChange={(e) => set('authorEmail', e.target.value)} /></Row>
      <Row name="Auto-sync" desc="Periodic pull+commit+push on the interval below"><input type="checkbox" checked={g.autoSync} onChange={(e) => set('autoSync', e.target.checked)} /></Row>
      <Row name="Auto-commit on save" desc="Commit (+push) ~5s after each edit"><input type="checkbox" checked={g.autoCommitOnSave} onChange={(e) => set('autoCommitOnSave', e.target.checked)} /></Row>
      <Row name="Interval (sec)"><input className="text-input" type="number" style={{ width: 90 }} value={g.intervalSec} onChange={(e) => set('intervalSec', Number(e.target.value))} /></Row>
      <Row name="Git LFS patterns" desc="Space-separated globs tracked via LFS">
        <input className="text-input" style={{ width: 260 }} value={(g.lfsPatterns || []).join(' ')} onChange={(e) => set('lfsPatterns', e.target.value.split(/\s+/).filter(Boolean))} />
      </Row>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn secondary" onClick={() => run(api.gitInit, 'Init')}>Init repo</button>
        <button className="btn secondary" onClick={() => run(api.gitClone, 'Clone')}>Clone</button>
        <button className="btn secondary" onClick={() => run(api.gitPull, 'Pull')}>Pull</button>
        <button className="btn secondary" onClick={() => run(() => api.gitCommit(), 'Commit')}>Commit</button>
        <button className="btn secondary" onClick={() => run(api.gitPush, 'Push')}>Push</button>
        <button className="btn" onClick={() => run(() => api.gitSync(), 'Sync')}>Sync now</button>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sync log</span>
          {log.length > 0 && (
            <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={() => setLog([])}>Clear</button>
          )}
        </div>
        <textarea
          ref={logRef}
          readOnly
          value={log.length ? log.join('\n') : 'No git activity yet. Click an action above (Sync now, Pull, Push…) to see logs here.'}
          style={{
            width: '100%', height: 200, boxSizing: 'border-box', resize: 'vertical',
            background: 'var(--bg-primary)', color: 'var(--text-normal)',
            border: '1px solid var(--bg-modifier-border, #444)', borderRadius: 6, padding: 10,
            fontFamily: 'var(--font-monospace, monospace)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre',
          }}
        />
      </div>
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [name, setName] = useState('my-agent');
  const [scopes, setScopes] = useState<string[]>(['read', 'search']);
  const [created, setCreated] = useState('');
  const load = () => api.listKeys().then((r) => setKeys(r.keys)).catch(() => {});
  useEffect(() => { load(); }, []);
  const toggle = (sc: string) => setScopes((p) => (p.includes(sc) ? p.filter((x) => x !== sc) : [...p, sc]));
  const create = async () => {
    const r = await api.createKey(name, scopes);
    setCreated(r.key);
    await load();
  };
  return (
    <div>
      <h2>API Keys</h2>
      <p style={{ color: 'var(--text-muted)' }}>Keys let AI agents call <code>/api/v1</code>. The raw key is shown once.</p>
      <Row name="Name"><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} /></Row>
      <Row name="Scopes">
        <span>
          {['read', 'write', 'search'].map((sc) => (
            <label key={sc} style={{ marginRight: 10 }}>
              <input type="checkbox" checked={scopes.includes(sc)} onChange={() => toggle(sc)} /> {sc}
            </label>
          ))}
        </span>
      </Row>
      <button className="btn" onClick={create}>Create key</button>
      {created && (
        <pre style={{ background: 'var(--bg-primary)', padding: 10, borderRadius: 6, marginTop: 10, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
          {created}
          {'\n'}⚠ Copy now — it will not be shown again.
        </pre>
      )}
      <div style={{ marginTop: 16 }}>
        {keys.map((k) => (
          <div className="setting-row" key={k.id}>
            <div className="info">
              <div className="name">{k.name} <span style={{ color: 'var(--text-faint)' }}>{k.prefix}…</span></div>
              <div className="desc">scopes: {k.scopes.join(', ')} · used: {k.lastUsed ?? 'never'}</div>
            </div>
            <button className="btn danger" onClick={async () => { await api.revokeKey(k.id); load(); }}>Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Shares() {
  const notify = useStore((s) => s.notify);
  const openFile = useStore((s) => s.openFile);
  const setOpen = useStore((s) => s.setSettings);
  // Shared with the store so the file tree's globe badges refresh on changes.
  const shares = useStore((s) => s.shares);
  const load = useStore((s) => s.loadShares);
  const [query, setQuery] = useState('');
  useEffect(() => { load(); }, [load]);

  const url = (id: string) => `${location.origin}/share/${id}`;
  const copy = (id: string) => {
    navigator.clipboard?.writeText(url(id)).catch(() => {});
    notify('Public link copied');
  };
  const toggle = async (s: any) => {
    await api.setShareEnabled(s.id, !s.enabled);
    load();
  };
  const remove = async (s: any) => {
    if (!confirm(`Delete the public link for "${s.path}"? The URL stops working permanently.`)) return;
    await api.deleteShare(s.id);
    load();
  };
  const setPassword = async (s: any) => {
    const pw = prompt(
      s.hasPassword
        ? 'New password for this link (leave empty to REMOVE the password):'
        : 'Password for this link:',
    );
    if (pw === null) return;
    await api.setSharePassword(s.id, pw || null);
    notify(pw ? 'Password set' : 'Password removed');
    load();
  };

  const q = query.trim().toLowerCase();
  const filtered = q ? shares.filter((s) => s.path.toLowerCase().includes(q)) : shares;

  return (
    <div>
      <h2>Sharing</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Notes shared via a public link are readable by <b>anyone with the URL</b>, without login.
        Create a link from a note's context menu ("Share…"). Disable keeps the URL for
        re-enabling later; delete revokes it permanently.
      </p>
      <input
        className="text-input"
        style={{ width: '100%', margin: '6px 0 12px' }}
        placeholder="Search shared notes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.length === 0 && (
        <div style={{ color: 'var(--text-faint)' }}>
          {shares.length === 0 ? 'No notes are shared publicly.' : 'No shared note matches the search.'}
        </div>
      )}
      {filtered.map((s) => (
        <div className="setting-row" key={s.id}>
          <div className="info" style={{ minWidth: 0 }}>
            <div
              className="name"
              style={{ cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: s.enabled ? 1 : 0.55 }}
              title={`Open ${s.path}`}
              onClick={() => { openFile(s.path); setOpen(false); }}
            >
              {s.path}
            </div>
            <div className="desc">
              {s.enabled ? 'active' : 'disabled'}
              {s.hasPassword ? ' · password-protected' : ''} · created {new Date(s.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <button className="btn secondary" disabled={!s.enabled} onClick={() => copy(s.id)} title={url(s.id)}>
              <Icon name="link" size={14} /> Copy link
            </button>
            <button className="btn secondary" onClick={() => setPassword(s)} title={s.hasPassword ? 'Change or remove password' : 'Require a password to open the link'}>
              {s.hasPassword ? 'Password ✓' : 'Password…'}
            </button>
            <button className={`btn ${s.enabled ? 'secondary' : ''}`} onClick={() => toggle(s)}>
              {s.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn danger" onClick={() => remove(s)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A plugin's own settings tab (PluginSettingTab.display()) rendered inside our settings dialog. */
function PluginTab({ tab }: { tab: { containerEl: HTMLElement; display(): void; hide(): void } }) {
  return (
    <div
      className="plugin-settings-host"
      ref={(n) => {
        if (n && tab.containerEl.parentNode !== n) {
          n.appendChild(tab.containerEl);
          try { tab.containerEl.empty(); tab.display(); } catch (e) { n.textContent = `This plugin's settings could not be shown: ${(e as Error).message}`; }
        }
      }}
    />
  );
}

function Plugins() {
  usePluginHost();
  const [tab, setTab] = useState<'installed' | 'browse'>('installed');
  const [openOptions, setOpenOptions] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<any[]>([]);
  const [unsaved, setUnsaved] = useState(0);
  const [repo, setRepo] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.listPlugins().then((r) => { setPlugins(r.plugins); setUnsaved(r.unsaved ?? 0); }).catch(() => {});
  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, []);
  const install = async () => {
    setMsg('Installing…');
    try { await api.installPlugin(repo); setMsg('Installed ✓'); setRepo(''); await load(); await syncPlugins(); }
    catch (e: any) { setMsg(`Error: ${e.message}`); }
  };
  const [allowEval, setAllowEval] = useState(false);
  useEffect(() => { api.getSettings().then((s) => setAllowEval(!!s.plugins?.allowUnsafeEval)).catch(() => {}); }, []);
  const toggleEval = async (on: boolean) => {
    try { await api.putSettings({ plugins: { allowUnsafeEval: on } }); setAllowEval(on); setMsg(on ? 'Saved. Reload the page to let plugins evaluate code.' : 'Saved. Reload the page to apply.'); }
    catch (e: any) { setMsg(`Error: ${e.message}`); }
  };
  const remove = async (p: any) => {
    if (!window.confirm(`Delete plugin "${p.name}"? Its files and saved settings are removed from the vault.`)) return;
    try {
      await api.uninstallPlugin(p.id);
      setOpenOptions(null); setMsg(`Deleted ${p.name}`);
      await syncPlugins(); await load();
    } catch (e: any) { setMsg(`Error: ${e.message}`); }
  };
  return (
    <div>
      <h2>Community Plugins</h2>
      <div className="plugin-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'installed'} className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>Installed{plugins.length ? ` (${plugins.length})` : ''}</button>
        <button role="tab" aria-selected={tab === 'browse'} className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>Browse</button>
      </div>
      {tab === 'browse' && <PluginBrowser onChanged={load} />}
      {tab === 'installed' && <>
      <Row name="Install from GitHub" desc="owner/repo — pulls manifest.json + main.js from latest release">
        <span style={{ display: 'flex', gap: 8 }}>
          <input className="text-input" placeholder="blacksmithgu/obsidian-dataview" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <button className="btn" onClick={install}>Install</button>
        </span>
      </Row>
      <Row name="Allow plugins to evaluate code (unsafe-eval)" desc="Needed by plugins like Excalidraw (“Evaluating a string as JavaScript violates the Content Security Policy”). Weakens XSS protection — enable only for a vault you trust. Applies after reloading the page.">
        <input type="checkbox" checked={allowEval} onChange={(e) => void toggleEval(e.target.checked)} />
      </Row>
      {msg && <div style={{ color: 'var(--text-muted)', margin: '6px 0' }}>{msg}</div>}
      {unsaved > 0 && (
        <div style={{ border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: '8px 10px', margin: '8px 0', fontSize: 12.5 }}>
          {unsaved} plugin change(s) are kept on the server for a few minutes before they are saved to GitHub (plugins can change
          often). Use <b>Sync now</b> to save them immediately.
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        {plugins.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No plugins installed in .obsidian/plugins</div>}
        {plugins.map((p) => {
          const tabs = p.enabled ? pluginHost.tabs(p.id) : [];
          const err = p.enabled ? pluginHost.error(p.id) : undefined;
          return (
            <div key={p.id}>
              <div className="setting-row">
                <div className="info">
                  <div className="name">{p.name} <span style={{ color: 'var(--text-faint)' }}>v{p.version}</span> {p.compat && <CompatBadge compat={p.compat} reasons={p.reasons} flags={p.flags} />}</div>
                  <div className="desc">{p.description}</div>
                  {err && <div className="desc" style={{ color: '#e5534b' }}>Could not start: {err}{/unsafe-eval/.test(err) ? ' — turn on “Allow plugins to evaluate code” above and reload the page.' : ''}</div>}
                </div>
                <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {tabs.length > 0 && (
                    <button className="btn" onClick={() => setOpenOptions(openOptions === p.id ? null : p.id)}>
                      {openOptions === p.id ? 'Hide options' : 'Options'}
                    </button>
                  )}
                  <button className="btn" title="Delete this plugin (code and settings)" style={{ background: 'transparent', color: '#e5534b', border: '1px solid #e5534b' }} onClick={() => remove(p)}>Delete</button>
                  <label>
                    <input type="checkbox" checked={p.enabled} onChange={async (e) => { await api.setPluginEnabled(p.id, e.target.checked); await syncPlugins(); load(); }} /> enabled
                  </label>
                </span>
              </div>
              {openOptions === p.id && tabs.map((t, i) => <PluginTab key={i} tab={t.tab} />)}
            </div>
          );
        })}
      </div>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 14 }}>
        Note: WebObsidian supports a subset of the Obsidian plugin API. Most metadata/markdown plugins work; plugins relying on Electron/Node internals may not.
        The compatibility badge comes from the Browse tab’s daily-updated list.
      </p>
      </>}
    </div>
  );
}

function Appearance({ s }: { s: any }) {
  const [theme, setTheme] = useState(s.ui.theme);
  const save = async (t: string) => { setTheme(t); await api.putSettings({ ui: { theme: t } }); location.reload(); };
  return (
    <div>
      <h2>Appearance</h2>
      <Row name="Theme">
        <select className="text-input" value={theme} onChange={(e) => save(e.target.value)}>
          <option value="obsidian-dark">Obsidian Dark</option>
          <option value="obsidian-light">Obsidian Light</option>
        </select>
      </Row>
    </div>
  );
}

function AccountSettings({ s, reload }: { s: any; reload: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const usingDefault = !s?.auth?.hasCustomPassword;

  const save = async () => {
    setErr('');
    setMsg('');
    if (next.length < 6) {
      setErr('Mật khẩu mới phải có ít nhất 6 ký tự');
      return;
    }
    if (next !== confirm) {
      setErr('Mật khẩu xác nhận không khớp');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setMsg('Đã đổi mật khẩu ✓');
      setCurrent('');
      setNext('');
      setConfirm('');
      await reload();
    } catch (e: any) {
      setErr(e?.message ?? 'Đổi mật khẩu thất bại');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>Account</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Mật khẩu đăng nhập vào WebObsidian.
        {usingDefault && (
          <>
            {' '}Bạn đang dùng <b>mật khẩu mặc định <code>123456</code></b> — hãy đổi mật khẩu để
            bảo mật vault.
          </>
        )}
      </p>
      <Row name="Mật khẩu hiện tại" desc={usingDefault ? 'Mặc định là 123456' : undefined}>
        <input className="text-input" type="password" style={{ width: 240 }} value={current}
          onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Row>
      <Row name="Mật khẩu mới" desc="Tối thiểu 6 ký tự">
        <input className="text-input" type="password" style={{ width: 240 }} value={next}
          onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Row>
      <Row name="Xác nhận mật khẩu mới">
        <input className="text-input" type="password" style={{ width: 240 }} value={confirm}
          onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Row>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--text-accent, #4caf50)', margin: '6px 0' }}>{msg}</div>}
      <button className="btn" onClick={save} disabled={busy || !current || !next}>
        {busy ? 'Đang lưu…' : 'Đổi mật khẩu'}
      </button>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 16 }}>
        Quên mật khẩu? Đặt <code>auth.passwordHash</code> trong <code>data/settings.json</code> hoặc
        biến môi trường <code>WEBOBSIDIAN_PASSWORD</code> làm mật khẩu khôi phục (override) rồi đăng
        nhập lại để đổi mật khẩu mới.
      </p>
    </div>
  );
}

function About() {
  const logout = async () => { await api.logout(); location.reload(); };
  return (
    <div>
      <h2>About WebObsidian</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        A self-hosted, Obsidian-compatible web app. Vault, QMD search, GitHub sync (with LFS),
        agent API and community plugins.
      </p>
      <button className="btn danger" onClick={logout}>Log out</button>
    </div>
  );
}
