import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CatalogInfo, type CatalogItem, type CatalogPage, type Compat } from '../lib/api';
import { syncPlugins } from '../lib/plugins';

/** Wording for the three ratings (full / partial / broken) plus "not rated yet". */
export const COMPAT_LABEL: Record<Compat, string> = { full: 'Compatible', partial: 'Limited', broken: 'Incompatible', unknown: 'Not checked' };
const COMPAT_HINT: Record<Compat, string> = {
  full: 'Everything the plugin uses is available in WebObsidian.',
  partial: 'It should start, but some features use things WebObsidian does not have yet.',
  broken: 'It is expected not to work (needs desktop-only APIs, or cannot be installed).',
  unknown: 'This plugin has not been analysed yet.',
};

export function CompatBadge({ compat, reasons, flags }: { compat: Compat; reasons?: string[]; flags?: string[] }) {
  const title = [COMPAT_HINT[compat], ...(reasons ?? []), ...(flags?.includes('eval') ? ['Some features need WEBOBSIDIAN_ALLOW_UNSAFE_EVAL=1.'] : [])].join('\n');
  return <span className={`compat-badge ${compat}`} title={title}>{COMPAT_LABEL[compat]}</span>;
}

const REFRESH_CHOICES: [number, string][] = [[6, 'every 6 hours'], [12, 'every 12 hours'], [24, 'every day'], [72, 'every 3 days'], [168, 'every week'], [0, 'only when I press “Check now”']];
const PAGE = 30;

function ago(iso?: string): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const compact = (n?: number) => (n === undefined ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Settings → Community Plugins → Browse: the official catalogue with WebObsidian compatibility ratings. */
export default function PluginBrowser({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'installed' | 'not-installed'>('all');
  const [compat, setCompat] = useState<'all' | Compat>('all');
  const [sort, setSort] = useState<'downloads' | 'name' | 'compat'>('downloads');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);

  // debounce the search box
  useEffect(() => { const t = setTimeout(() => setQ(text), 300); return () => clearTimeout(t); }, [text]);

  const load = useCallback(async (offset: number) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.pluginCatalog({ q, status, compat: compat === 'all' ? '' : compat, sort, offset, limit: PAGE });
      if (my !== seq.current) return; // a newer request superseded this one
      setPage(r);
      setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
      setError('');
    } catch (e: any) {
      if (my === seq.current) setError(e.message ?? String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [q, status, compat, sort]);

  useEffect(() => { void load(0); }, [load]);

  const install = async (p: CatalogItem) => {
    if (p.compat === 'broken' && !window.confirm(`“${p.name}” is rated Incompatible with WebObsidian:\n\n${(p.reasons ?? []).join('\n')}\n\nInstall it anyway?`)) return;
    setBusy(p.id); setMsg(`Installing ${p.name}…`);
    try {
      await api.installPlugin(p.repo);
      setMsg(`Installed ${p.name} ✓ — turn it on in the Installed tab.`);
      await load(0); await syncPlugins(); onChanged();
    } catch (e: any) { setMsg(`Could not install ${p.name}: ${e.message}`); }
    finally { setBusy(null); }
  };

  const checkNow = async () => {
    setChecking(true); setMsg('');
    try { await api.refreshPluginCatalog(); await load(0); setMsg('Compatibility list is up to date.'); }
    catch (e: any) { setMsg(`Could not check: ${e.message}`); await load(0); }
    finally { setChecking(false); }
  };
  const setHours = async (h: number) => {
    try { await api.putSettings({ plugins: { catalogRefreshHours: h } }); await load(0); }
    catch (e: any) { setMsg(`Could not save: ${e.message}`); }
  };

  const info: CatalogInfo | undefined = page?.info;
  const c = page?.counts;
  const chip = (active: boolean, label: string, count: number | undefined, onClick: () => void, cls = '') => (
    <button key={label} className={`chip ${cls} ${active ? 'active' : ''}`} onClick={onClick}>
      {label}{count !== undefined && <span className="n">{count}</span>}
    </button>
  );

  return (
    <div className="plugin-browser">
      <div className="plugin-browser-bar">
        <input className="text-input" style={{ flex: 1, minWidth: 160 }} placeholder="Search plugins…" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="text-input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} title="Sort by">
          <option value="downloads">Most downloaded</option>
          <option value="name">Name</option>
          <option value="compat">Best compatibility</option>
        </select>
      </div>

      <div className="plugin-filters">
        <div className="chips" role="group" aria-label="Status">
          {chip(status === 'all', 'All', c ? c.installed + c.notInstalled : undefined, () => setStatus('all'))}
          {chip(status === 'installed', 'Installed', c?.installed, () => setStatus('installed'))}
          {chip(status === 'not-installed', 'Not installed', c?.notInstalled, () => setStatus('not-installed'))}
        </div>
        <div className="chips" role="group" aria-label="Compatibility">
          {chip(compat === 'all', 'Any compatibility', undefined, () => setCompat('all'))}
          {(['full', 'partial', 'broken', 'unknown'] as Compat[]).map((k) => chip(compat === k, COMPAT_LABEL[k], c?.compat[k], () => setCompat(compat === k ? 'all' : k), k))}
        </div>
      </div>

      <div className="plugin-catalog-info">
        {info?.available ? (
          <>Ratings from {ago(info.generatedAt)} · checked {ago(info.fetchedAt)}{info.apiVersion ? ` · Obsidian API ${info.apiVersion}` : ''}</>
        ) : (info?.error ? 'The compatibility list is not available yet.' : 'Loading the compatibility list…')}
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          Check for updates
          <select className="text-input" style={{ padding: '3px 6px' }} value={info?.refreshHours ?? 24} onChange={(e) => void setHours(Number(e.target.value))}>
            {REFRESH_CHOICES.some(([h]) => h === (info?.refreshHours ?? 24)) ? null : <option value={info?.refreshHours}>{`every ${info?.refreshHours} h`}</option>}
            {REFRESH_CHOICES.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
          </select>
        </label>
        <button className="btn secondary" disabled={checking} onClick={checkNow}>{checking ? 'Checking…' : 'Check now'}</button>
      </div>
      {info?.error && <div className="plugin-note warn">Could not refresh the list: {info.error}{info.available ? ' — showing the last copy.' : ''}</div>}
      {msg && <div className="plugin-note">{msg}</div>}
      {error && <div className="plugin-note warn">{error}</div>}

      <div className="plugin-list">
        {items.map((p) => (
          <div className="plugin-card" key={p.id}>
            <div className="plugin-card-main">
              <div className="plugin-card-title">
                <span className="name">{p.name}</span>
                <span className="meta">{p.author}{p.version ? ` · v${p.version}` : ''}{p.downloads !== undefined ? ` · ${compact(p.downloads)} downloads` : ''}</span>
                <CompatBadge compat={p.compat} reasons={p.reasons} flags={p.flags} />
                {p.desktopOnly && <span className="compat-tag" title="The author marks this plugin as desktop-only">desktop-only</span>}
              </div>
              <div className="desc">{p.description}</div>
              {p.compat !== 'full' && p.reasons?.length ? (
                <ul className="plugin-reasons">{p.reasons.slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}</ul>
              ) : null}
            </div>
            <div className="plugin-card-action">
              {p.installed
                ? <span className="installed-mark" title={p.installedVersion ? `Version ${p.installedVersion}` : ''}>Installed{p.enabled ? ' · on' : ''}</span>
                : <button className="btn" disabled={busy !== null} onClick={() => void install(p)}>{busy === p.id ? 'Installing…' : 'Install'}</button>}
            </div>
          </div>
        ))}
        {!loading && items.length === 0 && !error && (
          <div style={{ color: 'var(--text-faint)', padding: '14px 0' }}>
            {info?.available === false ? 'No plugin list yet. Press “Check now” once the webobsidian-community-plugins repository has published its first list.' : 'No plugins match these filters.'}
          </div>
        )}
      </div>
      {page && items.length < page.total && (
        <div style={{ textAlign: 'center', margin: '12px 0' }}>
          <button className="btn secondary" disabled={loading} onClick={() => void load(items.length)}>{loading ? 'Loading…' : `Show more (${page.total - items.length} left)`}</button>
        </div>
      )}
      {loading && items.length === 0 && <div style={{ color: 'var(--text-faint)', padding: '14px 0' }}>Loading…</div>}
    </div>
  );
}
