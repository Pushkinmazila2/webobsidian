import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { pluginHost, useLeaves } from '../lib/pluginHost';
import { basesApi, getSharedApp, sharedMetadataCache, startMetadataCache } from '../lib/obsidianApi';
import { buildBaseEnv } from '../lib/bases/vaultEnv';
import {
  BaseContext, DEFAULT_BASE, normalizeId, parseBase, runView, stringifyBase, BUILTIN_SUMMARIES,
  type BaseConfig, type BaseFile, type Row, type ViewConfig, type ViewResult,
} from '../lib/bases/engine';
import { BDate, BError, BHtml, BIcon, BImage, BLink, display, isEmptyValue } from '../lib/bases/values';
import { BFile } from '../lib/bases/expr';
import Icon, { hasIcon } from './Icon';

const VIEW_ICON: Record<string, string> = { table: 'table', cards: 'layout-grid', list: 'list' };
const BUILTIN_TYPES = ['table', 'cards', 'list'];

function openPath(path: string, newTab = false) {
  const st = useStore.getState();
  if (newTab) void st.openToSide(path); else void st.openFile(path);
}

/** One value in a table cell / card / list entry. */
function Cell({ v, id }: { v: unknown; id?: string }) {
  if (v == null || (Array.isArray(v) && v.length === 0)) return null;
  if (Array.isArray(v)) {
    return <>{v.map((x, i) => <span key={i}>{i > 0 && ', '}<Cell v={x} id={id} /></span>)}</>;
  }
  if (v instanceof BLink) {
    return v.path
      ? <a className="internal-link" href="#" onClick={(e) => { e.preventDefault(); openPath(v.path!, e.ctrlKey || e.metaKey); }}>{v.toString()}</a>
      : <span className="internal-link is-unresolved">{v.toString()}</span>;
  }
  if (v instanceof BFile) return <Cell v={new BLink(v.f.path)} />;
  if (v instanceof BError) return <span className="bases-error" title={v.message}>Error</span>;
  if (v instanceof BImage) return <img className="bases-img" src={/^(https?:|data:)/i.test(v.url) ? v.url : api.rawUrl(v.url)} alt="" />;
  if (v instanceof BIcon) return hasIcon(v.name) ? <Icon name={v.name} size={14} /> : <span>{v.name}</span>;
  if (v instanceof BHtml) return <span>{v.html.replace(/<[^>]*>/g, '')}</span>;
  if (typeof v === 'boolean') return <input type="checkbox" checked={v} disabled readOnly />;
  if (id === 'file.tags' || (typeof v === 'string' && id?.endsWith('tags'))) return <span className="tag">#{String(v).replace(/^#/, '')}</span>;
  if (v instanceof BDate) return <span>{v.toString()}</span>;
  return <span>{display(v)}</span>;
}

function FileNameCell({ row }: { row: Row }) {
  const f = row.file;
  return <a className="internal-link" href="#" onClick={(e) => { e.preventDefault(); openPath(f.path, e.ctrlKey || e.metaKey); }}>{f.ext === 'md' ? f.basename : f.name}</a>;
}
function ValueCell({ row, id }: { row: Row; id: string }) {
  const nid = normalizeId(id);
  if (nid === 'file.name') return <FileNameCell row={row} />;
  return <Cell v={row.get(nid)} id={nid} />;
}

function TableView({ res, cfg, vi, change, search }: { res: ViewResult; cfg: BaseConfig; vi: number; change: (c: BaseConfig) => void; search: string }) {
  const cols = res.columns;
  const sort = res.view.sort?.[0];
  const toggleSort = (id: string) => {
    const nid = normalizeId(id);
    const cur = sort && normalizeId(sort.property) === nid ? sort.direction ?? 'ASC' : null;
    const next = cur === null ? 'ASC' : cur === 'ASC' ? 'DESC' : null;
    const views = [...(cfg.views ?? [])];
    views[vi] = { ...views[vi], sort: next ? [{ property: id, direction: next }] : [] };
    change({ ...cfg, views });
  };
  const match = (r: Row) => !search || cols.some((c) => display(r.get(normalizeId(c.id))).toLowerCase().includes(search)) || r.file.name.toLowerCase().includes(search);
  const body = (rows: Row[]) => rows.filter(match).map((r) => (
    <tr key={r.file.path}>{cols.map((c) => <td key={c.id}><ValueCell row={r} id={c.id} /></td>)}</tr>
  ));
  return (
    <div className="bases-table-wrap">
      <table className="bases-table">
        <thead>
          <tr>{cols.map((c) => {
            const active = sort && normalizeId(sort.property) === normalizeId(c.id);
            return <th key={c.id} onClick={() => toggleSort(c.id)} title="Click to sort">{c.name}{active && <span className="bases-sort">{sort!.direction === 'DESC' ? ' ↓' : ' ↑'}</span>}</th>;
          })}</tr>
        </thead>
        <tbody>
          {res.groups
            ? res.groups.map((g, i) => (
              <GroupRows key={i} label={g.key == null ? 'No value' : display(g.key)} count={g.rows.length} span={cols.length}>{body(g.rows)}</GroupRows>
            ))
            : body(res.rows)}
        </tbody>
        {Object.keys(res.summaries).length > 0 && (
          <tfoot><tr>{cols.map((c) => {
            const s = res.summaries[normalizeId(c.id)];
            return <td key={c.id}>{s === undefined ? '' : <><span className="bases-sum-name">{res.view.summaries?.[c.id] ?? res.view.summaries?.[normalizeId(c.id)]} </span><Cell v={s} /></>}</td>;
          })}</tr></tfoot>
        )}
      </table>
    </div>
  );
}
function GroupRows({ label, count, span, children }: { label: string; count: number; span: number; children: React.ReactNode }) {
  return <>
    <tr className="bases-group"><td colSpan={span}>{label} <span className="bases-group-count">{count}</span></td></tr>
    {children}
  </>;
}

function ListView({ res, search }: { res: ViewResult; search: string }) {
  const cols = res.columns.filter((c) => normalizeId(c.id) !== 'file.name');
  const match = (r: Row) => !search || r.file.name.toLowerCase().includes(search) || cols.some((c) => display(r.get(normalizeId(c.id))).toLowerCase().includes(search));
  const items = (rows: Row[]) => rows.filter(match).map((r) => (
    <li key={r.file.path}>
      <FileNameCell row={r} />
      {cols.map((c) => { const v = r.get(normalizeId(c.id)); return isEmptyValue(v) ? null : <span key={c.id} className="bases-list-prop"> · <span className="bases-list-label">{c.name}:</span> <Cell v={v} id={normalizeId(c.id)} /></span>; })}
    </li>
  ));
  return (
    <div className="bases-list">
      {res.groups
        ? res.groups.map((g, i) => <div key={i}><div className="bases-group-title">{g.key == null ? 'No value' : display(g.key)}</div><ul>{items(g.rows)}</ul></div>)
        : <ul>{items(res.rows)}</ul>}
    </div>
  );
}

function CardsView({ res, search }: { res: ViewResult; search: string }) {
  const v = res.view;
  const imageId = typeof v.image === 'string' ? normalizeId(v.image) : null;
  const size = typeof v.cardSize === 'number' ? v.cardSize : 200;
  const ratio = typeof v.imageAspectRatio === 'number' ? v.imageAspectRatio : 0.5;
  const fit = v.imageFit === 'contain' ? 'contain' : 'cover';
  const cols = res.columns.filter((c) => normalizeId(c.id) !== 'file.name');
  const match = (r: Row) => !search || r.file.name.toLowerCase().includes(search) || cols.some((c) => display(r.get(normalizeId(c.id))).toLowerCase().includes(search));
  const card = (r: Row) => {
    let img: string | null = null;
    if (imageId) {
      const val = r.get(imageId);
      const first = Array.isArray(val) ? val[0] : val;
      const raw = first instanceof BLink ? first.path : first instanceof BImage ? first.url : typeof first === 'string' ? first : null;
      if (raw) img = /^(https?:|data:)/i.test(raw) ? raw : api.rawUrl(raw);
    }
    return (
      <div className="bases-card" key={r.file.path} onClick={(e) => { if ((e.target as HTMLElement).closest('a')) return; openPath(r.file.path, e.ctrlKey || e.metaKey); }}>
        {imageId && <div className="bases-card-img" style={{ paddingTop: `${ratio * 100}%` }}>{img && <img src={img} alt="" style={{ objectFit: fit }} />}</div>}
        <div className="bases-card-title"><FileNameCell row={r} /></div>
        {cols.map((c) => { const val = r.get(normalizeId(c.id)); return isEmptyValue(val) ? null : <div className="bases-card-prop" key={c.id}><span className="bases-list-label">{c.name}</span><span><Cell v={val} id={normalizeId(c.id)} /></span></div>; })}
      </div>
    );
  };
  const grid = (rows: Row[]) => <div className="bases-cards" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>{rows.filter(match).map(card)}</div>;
  return res.groups
    ? <div>{res.groups.map((g, i) => <div key={i}><div className="bases-group-title">{g.key == null ? 'No value' : display(g.key)}</div>{grid(g.rows)}</div>)}</div>
    : grid(res.rows);
}

/** Hosts a view a community plugin registered with `registerBasesView`. */
function PluginBasesView({ type, base, ctx, thisFile, vi, onChange }: { type: string; base: BaseConfig; ctx: BaseContext; thisFile: BaseFile | null; vi: number; onChange: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const ctl = useRef<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = useRef({ base, ctx, thisFile, onChange });
  latest.current = { base, ctx, thisFile, onChange };
  useEffect(() => {
    const reg = pluginHost.basesView(type);
    const el = box.current;
    if (!reg || !el) return;
    el.empty?.();
    el.innerHTML = '';
    let view: any = null;
    try {
      const c = new basesApi.QueryController(getSharedApp(), latest.current.base, latest.current.ctx, latest.current.thisFile, vi, () => latest.current.onChange());
      ctl.current = c;
      view = reg.factory(c, el);
      c.view = view;
      view.load?.();
      view.config = c.config; view.data = c.data; view.allProperties = c.allProperties();
      view.onDataUpdated?.();
      setErr(null);
    } catch (e) { console.warn('[bases] plugin view failed:', e); setErr((e as Error).message); }
    return () => { try { view?.unload?.(); } catch { /* ignore */ } ctl.current = null; el.innerHTML = ''; };
  }, [type, vi]);
  useEffect(() => { ctl.current?.update(base, ctx, thisFile); }, [base, ctx, thisFile]);
  return <>{err && <div className="bases-error-box">View failed: {err}</div>}<div ref={box} className="bases-plugin-view" /></>;
}

export default function BaseView({ path, embedded = false, thisPath }: { path: string; embedded?: boolean; thisPath?: string }) {
  useLeaves(); // plugin views registering/unregistering
  const tree = useStore((s) => s.tree);
  const [text, setText] = useState<string | null>(null);
  const [vi, setVi] = useState(0);
  const [src, setSrc] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [tick, setTick] = useState(0);
  const [menu, setMenu] = useState<'props' | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.read(path).then((r: any) => { if (alive) { const t = typeof r === 'string' ? r : r.content; setText(t); setDraft(t); } }).catch(() => alive && setText(''));
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    void startMetadataCache();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => setTick((t) => t + 1), 150); };
    const ref = sharedMetadataCache.on('resolved', bump);
    return () => { sharedMetadataCache.offref(ref); if (timer) clearTimeout(timer); };
  }, []);

  const parsed = useMemo(() => {
    if (text == null) return null;
    try { return { cfg: parseBase(text) as BaseConfig, error: null as string | null }; }
    catch (e) { return { cfg: { views: [] } as BaseConfig, error: (e as Error).message }; }
  }, [text]);

  const cfg = parsed?.cfg ?? { views: [] };
  const views: ViewConfig[] = cfg.views?.length ? cfg.views : [{ type: 'table', name: 'Table' }];
  const idx = Math.min(vi, views.length - 1);
  const cfgWithView: BaseConfig = cfg.views?.length ? cfg : { ...cfg, views };

  const { ctx, thisFile } = useMemo(() => {
    const c = new BaseContext(buildBaseEnv());
    return { ctx: c, thisFile: c.file(thisPath ?? path) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, tree, thisPath, path]);

  const result = useMemo(() => {
    if (!parsed || parsed.error) return null;
    try { return runView(cfgWithView, idx, ctx, thisFile); } catch (e) { console.warn('[bases] query failed', e); return null; }
  }, [parsed, cfgWithView, idx, ctx, thisFile]);

  const persist = useCallback(async (nextText: string) => {
    setText(nextText); setSaving(true);
    try { await api.write(path, nextText); } catch (e) { useStore.getState().notify(`Could not save base: ${(e as Error).message}`); }
    setSaving(false);
  }, [path]);
  const change = useCallback((c: BaseConfig) => { void persist(stringifyBase(c)); }, [persist]);

  if (text == null || !parsed) return <div className="bases-root"><div className="bases-empty">Loading…</div></div>;

  const type = views[idx].type;
  const builtin = BUILTIN_TYPES.includes(type);
  const regs = pluginHost.basesViews();

  const addView = (t: string, name: string) => {
    const next = { ...cfgWithView, views: [...views, { type: t, name }] };
    change(next); setVi(next.views.length - 1);
  };
  const removeView = (i: number) => { if (views.length <= 1) return; change({ ...cfgWithView, views: views.filter((_, j) => j !== i) }); setVi(0); };
  const toggleProp = (id: string) => {
    const order = (views[idx].order ?? result?.columns.map((c) => c.id) ?? []).map(String);
    const nid = normalizeId(id);
    const has = order.some((o) => normalizeId(o) === nid);
    const next = has ? order.filter((o) => normalizeId(o) !== nid) : [...order, id];
    const vs = [...views]; vs[idx] = { ...vs[idx], order: next };
    change({ ...cfgWithView, views: vs });
  };
  const allProps = (() => {
    const set = new Set<string>(['file.name', 'file.path', 'file.folder', 'file.ext', 'file.size', 'file.ctime', 'file.mtime', 'file.tags', 'file.links', 'file.backlinks']);
    for (const f of ctx.env.files) for (const k of Object.keys(f.frontmatter ?? {})) set.add(`note.${k}`);
    for (const k of Object.keys(cfg.formulas ?? {})) set.add(`formula.${k}`);
    return [...set];
  })();
  const activeIds = new Set((result?.columns ?? []).map((c) => normalizeId(c.id)));

  return (
    <div className={`bases-root${embedded ? ' is-embedded' : ''}`}>
      <div className="bases-toolbar">
        <div className="bases-tabs">
          {views.map((v, i) => (
            <button key={i} className={`bases-tab${i === idx ? ' active' : ''}`} onClick={() => setVi(i)} onAuxClick={() => removeView(i)} title={views.length > 1 ? 'Middle-click to remove' : undefined}>
              {(() => { const rg = pluginHost.basesView(v.type); const ic = VIEW_ICON[v.type] ?? rg?.icon; return ic && hasIcon(ic) ? <Icon name={ic} size={14} /> : null; })()}
              <span>{v.name || v.type}</span>
            </button>
          ))}
          <select className="bases-add" value="" onChange={(e) => { const t = e.target.value; if (t) addView(t, t[0].toUpperCase() + t.slice(1)); }} title="Add view">
            <option value="">＋</option>
            {BUILTIN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            {regs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="bases-tools">
          {result && <span className="bases-count">{result.rows.length}{result.total !== result.rows.length ? ` / ${result.total}` : ''} results</span>}
          {builtin && <input className="bases-search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value.toLowerCase())} />}
          {builtin && <div className="bases-menu-wrap">
            <button className="bases-btn" onClick={() => setMenu(menu ? null : 'props')} title="Properties">Properties</button>
            {menu === 'props' && (
              <div className="bases-menu" onMouseLeave={() => setMenu(null)}>
                {allProps.map((id) => (
                  <label key={id}><input type="checkbox" checked={activeIds.has(id)} onChange={() => toggleProp(id)} /> {id}</label>
                ))}
              </div>
            )}
          </div>}
          <button className={`bases-btn${src ? ' active' : ''}`} onClick={() => { setSrc(!src); setDraft(text); }} title="Edit .base source">Source</button>
        </div>
      </div>

      {src && (
        <div className="bases-source">
          <textarea value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
          <div className="bases-source-actions">
            <button className="bases-btn" onClick={() => setDraft(DEFAULT_BASE)}>Reset</button>
            <button className="bases-btn mod-cta" disabled={saving} onClick={() => { void persist(draft); }}>Save</button>
          </div>
        </div>
      )}

      {parsed.error && <div className="bases-error-box">Invalid base: {parsed.error}</div>}
      {result && result.errors.length > 0 && <div className="bases-error-box">{result.errors.map((e, i) => <div key={i}>{e}</div>)}</div>}

      <div className="bases-body">
        {!parsed.error && result && type === 'table' && <TableView res={result} cfg={cfgWithView} vi={idx} change={change} search={search} />}
        {!parsed.error && result && type === 'list' && <ListView res={result} search={search} />}
        {!parsed.error && result && type === 'cards' && <CardsView res={result} search={search} />}
        {!parsed.error && !builtin && (pluginHost.basesView(type)
          ? <PluginBasesView type={type} base={cfgWithView} ctx={ctx} thisFile={thisFile} vi={idx} onChange={() => { void persist(stringifyBase(cfgWithView)); }} />
          : <div className="bases-empty">View type “{type}” is not available (the plugin that provides it is not enabled).</div>)}
        {!parsed.error && builtin && result && result.rows.length === 0 && <div className="bases-empty">No entries match this view.</div>}
      </div>
    </div>
  );
}
