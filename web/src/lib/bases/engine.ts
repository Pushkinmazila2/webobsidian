/**
 * Bases query engine: parses a `.base` file (YAML) and runs one of its views over the vault —
 * global + view filters, formulas, sort, group-by, limit, column order and summaries.
 * Pure (no DOM, no app state): feed it `BaseFile`s and a link resolver; unit-tested in Node.
 */
import yaml from 'js-yaml';
import {
  BDate, BLink, BError, parseDate, compareValues, isEmptyValue, isTruthy, toStr,
} from './values';
import {
  parseExpression, evaluate, evalSource, type Node, type Scope, type EvalEnv, type FileLike, fileProp, FileRoot,
} from './expr';

export type BaseFile = FileLike;

export type FilterNode = string | { and: FilterNode[] } | { or: FilterNode[] } | { not: FilterNode[] };
export interface ViewConfig {
  type: string;
  name?: string;
  filters?: FilterNode;
  order?: string[];
  sort?: { property: string; direction?: 'ASC' | 'DESC' }[];
  groupBy?: { property: string; direction?: 'ASC' | 'DESC' };
  limit?: number;
  summaries?: Record<string, string>;
  [key: string]: unknown;
}
export interface BaseConfig {
  filters?: FilterNode;
  formulas?: Record<string, string>;
  properties?: Record<string, { displayName?: string }>;
  summaries?: Record<string, string>;
  views?: ViewConfig[];
}

export function parseBase(text: string): BaseConfig {
  const raw = (text.trim() === '' ? {} : yaml.load(text)) as BaseConfig | null;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A .base file must be a YAML mapping');
  const views = Array.isArray(raw.views) ? raw.views.filter((v) => v && typeof v === 'object').map((v) => ({ ...v, type: String((v as ViewConfig).type ?? 'table') })) : [];
  return { ...raw, views };
}

export function stringifyBase(cfg: BaseConfig): string { return yaml.dump(cfg, { lineWidth: -1, noRefs: true }); }
export const DEFAULT_BASE = 'views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - file.mtime\n';

export interface Env {
  files: BaseFile[];
  /** `[[link]]` text → vault path (or null). */
  resolve(link: string, from: string): string | null;
}

export interface Row {
  file: BaseFile;
  /** Value of a property id (`note.x`, `file.name`, `formula.x`, or a bare note property). */
  get(id: string): unknown;
}
export interface Column { id: string; name: string }
export interface Group { key: unknown; rows: Row[] }
export interface ViewResult {
  view: ViewConfig;
  columns: Column[];
  rows: Row[];
  groups: Group[] | null;
  /** property id → computed summary (only for columns with a summary configured). */
  summaries: Record<string, unknown>;
  total: number;
  errors: string[];
}

const NOTE_LINK_RE = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/;

/** Reusable query context: indexes the files once (backlinks, path map) and caches formula results. */
export class BaseContext implements EvalEnv {
  byPath = new Map<string, BaseFile>();
  private back = new Map<string, string[]>();
  private formulaCache = new Map<string, unknown>();
  private formulaAst = new Map<string, Node | Error>();
  private formulaBusy = new Set<string>();
  formulas: Record<string, string> = {};

  constructor(public env: Env) {
    for (const f of env.files) this.byPath.set(f.path, f);
    for (const f of env.files) {
      for (const l of [...f.links, ...f.embeds]) {
        const target = env.resolve(l, f.path);
        if (!target || target === f.path) continue;
        const arr = this.back.get(target) ?? [];
        if (!arr.includes(f.path)) arr.push(f.path);
        this.back.set(target, arr);
      }
    }
  }
  setFormulas(f: Record<string, string> | undefined) { this.formulas = f ?? {}; this.formulaCache.clear(); this.formulaAst.clear(); }

  resolve(link: string, from: string) { return this.env.resolve(link, from); }
  backlinks(path: string) { return this.back.get(path) ?? []; }
  file(path: string) { return this.byPath.get(path) ?? null; }

  noteValue(f: BaseFile, key: string): unknown {
    const fm = f.frontmatter ?? {};
    if (!(key in fm)) return null;
    return this.convert(fm[key], f.path);
  }
  /** Front-matter value → formula value: `[[link]]` strings become links, ISO date strings become dates. */
  private convert(v: unknown, from: string): unknown {
    if (typeof v === 'string') {
      const m = NOTE_LINK_RE.exec(v.trim());
      if (m) return new BLink(this.env.resolve(m[1], from), m[2], m[1]);
      return parseDate(v) ?? v;
    }
    if (v instanceof Date) return new BDate(v, v.getUTCHours() + v.getUTCMinutes() + v.getUTCSeconds() === 0);
    if (Array.isArray(v)) return v.map((x) => this.convert(x, from));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.convert(x, from)]));
    return v;
  }

  formula(f: BaseFile, name: string): unknown {
    const key = `${f.path}\u0000${name}`;
    if (this.formulaCache.has(key)) return this.formulaCache.get(key);
    const src = this.formulas[name];
    if (src === undefined) return null;
    if (this.formulaBusy.has(key)) return new BError(`Circular formula "${name}"`);
    this.formulaBusy.add(key);
    let out: unknown;
    try {
      let ast = this.formulaAst.get(name);
      if (!ast) { try { ast = parseExpression(String(src)); } catch (e) { ast = e as Error; } this.formulaAst.set(name, ast); }
      out = ast instanceof Error ? new BError(ast.message) : evaluate(ast, this.scope(f, this.thisFile));
    } catch (e) { out = new BError((e as Error).message); }
    this.formulaBusy.delete(key);
    this.formulaCache.set(key, out);
    return out;
  }

  /** The file `this` refers to (the .base file, or the note embedding it). */
  thisFile: BaseFile | null = null;
  scope(file: BaseFile, self: BaseFile | null, vars: Record<string, unknown> = {}): Scope { return { env: this, file, self, vars }; }

  /** Evaluate expression text for a file (errors come back as `BError`). */
  evalFor(src: string, file: BaseFile, self: BaseFile | null, vars: Record<string, unknown> = {}): unknown { return evalSource(src, this.scope(file, self, vars)); }

  /** Property id → value for one file. */
  propValue(f: BaseFile, id: string): unknown {
    const dot = id.indexOf('.');
    const head = dot < 0 ? '' : id.slice(0, dot);
    if (head === 'file') return fileProp(f, id.slice(5), this.scope(f, this.thisFile));
    if (head === 'formula') return this.formula(f, id.slice(8));
    if (head === 'note') return this.noteValue(f, id.slice(5));
    return this.noteValue(f, id);
  }
}

function evalFilter(node: FilterNode | undefined, ctx: BaseContext, f: BaseFile, errors: string[]): boolean {
  if (node == null) return true;
  if (typeof node === 'string') {
    const r = evalSource(node, ctx.scope(f, ctx.thisFile));
    if (r instanceof BError) { const msg = `${node} → ${r.message}`; if (!errors.includes(msg)) errors.push(msg); return false; }
    return isTruthy(r);
  }
  if ('and' in node) return node.and.every((n) => evalFilter(n, ctx, f, errors));
  if ('or' in node) return node.or.some((n) => evalFilter(n, ctx, f, errors));
  if ('not' in node) return !node.not.some((n) => evalFilter(n, ctx, f, errors));
  return true;
}

const TITLE_FILE: Record<string, string> = { name: 'Name', path: 'Path', folder: 'Folder', ext: 'Extension', size: 'Size', ctime: 'Created', mtime: 'Modified', tags: 'Tags', links: 'Links', embeds: 'Embeds', backlinks: 'Backlinks', basename: 'Basename' };
export function displayName(id: string, cfg: BaseConfig): string {
  const custom = cfg.properties?.[id]?.displayName;
  if (custom) return custom;
  if (id.startsWith('file.')) { const n = id.slice(5); return TITLE_FILE[n] ?? n; }
  if (id.startsWith('note.')) return id.slice(5);
  if (id.startsWith('formula.')) return id.slice(8);
  return id;
}
export function normalizeId(id: string): string {
  return /^(file|note|formula)\./.test(id) ? id : `note.${id}`;
}

export function runView(cfg: BaseConfig, viewIndex: number, ctx: BaseContext, thisFile: BaseFile | null): ViewResult {
  const view = cfg.views?.[viewIndex] ?? { type: 'table' };
  const errors: string[] = [];
  ctx.thisFile = thisFile;
  ctx.setFormulas(cfg.formulas);

  // candidates: vault files outside hidden folders; the global filter, then the view filter
  const rows: Row[] = [];
  for (const f of ctx.env.files) {
    if (f.path.split('/').some((s) => s.startsWith('.'))) continue;
    if (!evalFilter(cfg.filters, ctx, f, errors) || !evalFilter(view.filters, ctx, f, errors)) continue;
    rows.push({ file: f, get: (id) => ctx.propValue(f, id) });
  }
  const total = rows.length;

  // columns
  let ids = (view.order ?? []).map(String);
  if (!view.order) {
    const keys: string[] = [];
    for (const r of rows) for (const k of Object.keys(r.file.frontmatter ?? {})) if (!keys.includes(k)) keys.push(k);
    ids = ['file.name', ...keys.slice(0, 12).map((k) => `note.${k}`), ...Object.keys(cfg.formulas ?? {}).map((k) => `formula.${k}`)];
  }
  const columns = ids.map((id) => ({ id, name: displayName(normalizeId(id), cfg) }));

  // sort (first key is most significant; stable)
  const sorts = (view.sort ?? []).filter((s) => s && s.property);
  if (sorts.length) {
    rows.sort((a, b) => {
      for (const s of sorts) {
        const id = normalizeId(s.property);
        const va = a.get(id), vb = b.get(id);
        const nullA = va == null || isEmptyValue(va), nullB = vb == null || isEmptyValue(vb);
        if (nullA !== nullB) return nullA ? 1 : -1;
        const c = compareValues(va, vb);
        if (c) return s.direction === 'DESC' ? -c : c;
      }
      return 0;
    });
  }

  // group
  let groups: Group[] | null = null;
  if (view.groupBy?.property) {
    const id = normalizeId(view.groupBy.property);
    const map: Group[] = [];
    for (const r of rows) {
      const k = r.get(id);
      const g = map.find((x) => compareValues(x.key, k) === 0 && (x.key == null) === (k == null));
      if (g) g.rows.push(r); else map.push({ key: k, rows: [r] });
    }
    map.sort((a, b) => { const c = compareValues(a.key, b.key); return view.groupBy!.direction === 'DESC' ? -c : c; });
    groups = map;
  }

  let limited = rows;
  if (typeof view.limit === 'number' && view.limit > 0) {
    limited = rows.slice(0, view.limit);
    if (groups) { const keep = new Set(limited); groups = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => keep.has(r)) })).filter((g) => g.rows.length); }
  }

  // summaries
  const summaries: Record<string, unknown> = {};
  for (const [prop, how] of Object.entries(view.summaries ?? {})) {
    const id = normalizeId(prop);
    summaries[id] = summarize(String(how), limited.map((r) => r.get(id)), ctx, cfg);
  }
  return { view, columns, rows: limited, groups, summaries, total, errors };
}

const numbers = (xs: unknown[]) => xs.filter((x): x is number => typeof x === 'number' && !isNaN(x));
export const BUILTIN_SUMMARIES = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'];
export function summarize(name: string, values: unknown[], ctx: BaseContext, cfg: BaseConfig): unknown {
  const n = numbers(values);
  const dates = values.filter((v): v is BDate => v instanceof BDate);
  switch (name) {
    case 'Sum': return n.reduce((a, b) => a + b, 0);
    case 'Average': return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
    case 'Min': return n.length ? Math.min(...n) : null;
    case 'Max': return n.length ? Math.max(...n) : null;
    case 'Range': return n.length ? Math.max(...n) - Math.min(...n) : null;
    case 'Median': { if (!n.length) return null; const s = [...n].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    case 'Stddev': { if (!n.length) return null; const mean = n.reduce((a, b) => a + b, 0) / n.length; return Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length); }
    case 'Earliest': return dates.length ? dates.reduce((a, b) => (b.t < a.t ? b : a)) : null;
    case 'Latest': return dates.length ? dates.reduce((a, b) => (b.t > a.t ? b : a)) : null;
    case 'Checked': return values.filter((v) => v === true).length;
    case 'Unchecked': return values.filter((v) => v === false).length;
    case 'Empty': return values.filter((v) => v == null || isEmptyValue(v)).length;
    case 'Filled': return values.filter((v) => !(v == null || isEmptyValue(v))).length;
    case 'Unique': return new Set(values.map(toStr)).size;
  }
  const custom = cfg.summaries?.[name];
  if (custom) {
    const file = ctx.env.files[0];
    if (file) return evalSource(custom, ctx.scope(file, ctx.thisFile, { values }));
  }
  return new BError(`Unknown summary "${name}"`);
}

export { FileRoot };
