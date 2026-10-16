/**
 * Bases expression language: tokenizer + Pratt parser → AST, and an evaluator with the built-in
 * global functions and the string / number / list / date / duration / link / file methods.
 * Pure (no DOM, no app state). The evaluator talks to the vault through `EvalEnv`.
 */
import {
  BDate, BDuration, BLink, BHtml, BImage, BIcon, BError, addDuration, parseDate, parseDuration,
  compareValues, looseEquals, isEmptyValue, isTruthy, typeOf, toStr, display,
} from './values';
import { formatDate } from '../obsidianUtils';

// ------------------------------------------------------------------ AST + parser
export type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'list'; items: Node[] }
  | { t: 'obj'; entries: [string, Node][] }
  | { t: 'id'; name: string }
  | { t: 'member'; obj: Node; name: string }
  | { t: 'index'; obj: Node; idx: Node }
  | { t: 'call'; fn: Node; args: Node[] }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'un'; op: string; e: Node };

interface Tok { k: 'num' | 'str' | 'id' | 'p' | 're' | 'end'; v: string; pos: number }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const prevAllowsValue = () => { const p = out[out.length - 1]; return !p || (p.k === 'p' && !')]}'.includes(p.v)); };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], pos: i }); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n; j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new Error(`Unterminated string at ${i}`);
      out.push({ k: 'str', v: s, pos: i }); i = j + 1; continue;
    }
    if (c === '/' && prevAllowsValue()) {
      let j = i + 1, esc = false, cls = false;
      for (; j < src.length; j++) {
        const ch = src[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '[') cls = true; else if (ch === ']') cls = false;
        else if (ch === '/' && !cls) break;
      }
      if (j >= src.length) throw new Error(`Unterminated regular expression at ${i}`);
      let f = j + 1; while (/[a-z]/i.test(src[f] ?? '')) f++;
      out.push({ k: 're', v: src.slice(i + 1, j) + '\u0000' + src.slice(j + 1, f), pos: i }); i = f; continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1; while (j < src.length && /[\w$\u0080-￿]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), pos: i }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) { out.push({ k: 'p', v: two, pos: i }); i += 2; continue; }
    if ('()[]{},.:+-*/%<>!'.includes(c)) { out.push({ k: 'p', v: c, pos: i }); i++; continue; }
    throw new Error(`Unexpected character "${c}" at ${i}`);
  }
  out.push({ k: 'end', v: '', pos: src.length });
  return out;
}

const BIN_PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export function parseExpression(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isP = (v: string) => peek().k === 'p' && peek().v === v;
  const expect = (v: string) => { if (!isP(v)) throw new Error(`Expected "${v}" at ${peek().pos}`); p++; };

  const parseBin = (min: number): Node => {
    let l = parseUnary();
    for (;;) {
      const t = peek();
      const prec = t.k === 'p' ? BIN_PREC[t.v] : undefined;
      if (prec === undefined || prec < min) return l;
      next();
      const r = parseBin(prec + 1);
      l = { t: 'bin', op: t.v, l, r };
    }
  };
  const parseUnary = (): Node => {
    if (isP('!')) { next(); return { t: 'un', op: '!', e: parseUnary() }; }
    if (isP('-')) { next(); return { t: 'un', op: '-', e: parseUnary() }; }
    return parsePostfix(parsePrimary());
  };
  const parsePostfix = (e: Node): Node => {
    for (;;) {
      if (isP('.')) {
        next(); const t = next();
        if (t.k !== 'id') throw new Error(`Expected a name after "." at ${t.pos}`);
        e = { t: 'member', obj: e, name: t.v };
      } else if (isP('[')) { next(); const idx = parseBin(1); expect(']'); e = { t: 'index', obj: e, idx }; }
      else if (isP('(')) {
        next(); const args: Node[] = [];
        if (!isP(')')) { do { args.push(parseBin(1)); } while (isP(',') && next()); }
        expect(')'); e = { t: 'call', fn: e, args };
      } else return e;
    }
  };
  const parsePrimary = (): Node => {
    const t = next();
    if (t.k === 'num') return { t: 'lit', v: parseFloat(t.v) };
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 're') { const [body, flags] = t.v.split('\u0000'); return { t: 'lit', v: new RegExp(body, flags) }; }
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      return { t: 'id', name: t.v };
    }
    if (t.k === 'p' && t.v === '(') { const e = parseBin(1); expect(')'); return e; }
    if (t.k === 'p' && t.v === '[') {
      const items: Node[] = [];
      if (!isP(']')) { do { items.push(parseBin(1)); } while (isP(',') && next()); }
      expect(']'); return { t: 'list', items };
    }
    if (t.k === 'p' && t.v === '{') {
      const entries: [string, Node][] = [];
      if (!isP('}')) {
        do {
          const k = next(); if (k.k !== 'id' && k.k !== 'str') throw new Error(`Expected a key at ${k.pos}`);
          expect(':'); entries.push([k.v, parseBin(1)]);
        } while (isP(',') && next());
      }
      expect('}'); return { t: 'obj', entries };
    }
    throw new Error(t.k === 'end' ? 'Unexpected end of expression' : `Unexpected "${t.v}" at ${t.pos}`);
  };
  const ast = parseBin(1);
  if (peek().k !== 'end') throw new Error(`Unexpected "${peek().v}" at ${peek().pos}`);
  return ast;
}

// ------------------------------------------------------------------ evaluation
/** What the evaluator needs to know about a file (see `BaseFile` in engine.ts). */
export interface FileLike {
  path: string; name: string; basename: string; ext: string; folder: string; size: number; ctime: number; mtime: number;
  tags: string[]; links: string[]; embeds: string[]; frontmatter: Record<string, unknown>;
}
export interface EvalEnv {
  resolve(link: string, from: string): string | null;
  backlinks(path: string): string[];
  file(path: string): FileLike | null;
  /** Property value of a note, with front-matter strings converted (links, dates). */
  noteValue(f: FileLike, key: string): unknown;
  formula(f: FileLike, name: string): unknown;
}
/** A file as seen from formulas (`file`, `this`, `link.asFile()`). */
export class BFile { constructor(public f: FileLike) {} toString() { return this.f.path; } }
export class FormulaRoot { constructor(public f: FileLike) {} }
export class NoteRoot { constructor(public f: FileLike) {} }
export class FileRoot { constructor(public f: FileLike) {} }

export interface Scope { env: EvalEnv; file: FileLike; self: FileLike | null; vars: Record<string, unknown> }

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const asDate = (v: unknown): BDate | null => (v instanceof BDate ? v : typeof v === 'string' ? parseDate(v) : typeof v === 'number' ? new BDate(new Date(v)) : null);
const asDur = (v: unknown): BDuration | null => (v instanceof BDuration ? v : typeof v === 'string' ? parseDuration(v) : null);

export function evaluate(node: Node, sc: Scope): unknown {
  switch (node.t) {
    case 'lit': return node.v;
    case 'list': return node.items.map((n) => evaluate(n, sc));
    case 'obj': return Object.fromEntries(node.entries.map(([k, n]) => [k, evaluate(n, sc)]));
    case 'id': return resolveId(node.name, sc);
    case 'member': return getMember(evaluate(node.obj, sc), node.name, sc);
    case 'index': {
      const o = evaluate(node.obj, sc); const i = evaluate(node.idx, sc);
      if (o instanceof NoteRoot) return sc.env.noteValue(o.f, toStr(i));
      if (o instanceof FormulaRoot) return sc.env.formula(o.f, toStr(i));
      if (o instanceof FileRoot) return getMember(o, toStr(i), sc);
      if (Array.isArray(o)) return typeof i === 'number' ? o[i < 0 ? o.length + i : i] ?? null : null;
      if (o && typeof o === 'object' && !(o instanceof BDate)) return (o as any)[toStr(i)] ?? null;
      if (typeof o === 'string' && typeof i === 'number') return o[i] ?? null;
      return null;
    }
    case 'un': {
      const v = evaluate(node.e, sc);
      if (node.op === '!') return !isTruthy(v);
      if (v instanceof BDuration) return new BDuration(Object.fromEntries(Object.entries(v.parts).map(([k, n]) => [k, -n])));
      return -num(v);
    }
    case 'bin': return evalBin(node, sc);
    case 'call': return evalCall(node, sc);
  }
}

function evalBin(node: Extract<Node, { t: 'bin' }>, sc: Scope): unknown {
  const { op } = node;
  if (op === '&&') { const l = evaluate(node.l, sc); return isTruthy(l) ? evaluate(node.r, sc) : l; }
  if (op === '||') { const l = evaluate(node.l, sc); return isTruthy(l) ? l : evaluate(node.r, sc); }
  const l = evaluate(node.l, sc); const r = evaluate(node.r, sc);
  switch (op) {
    case '==': return looseEquals(l, r);
    case '!=': return !looseEquals(l, r);
    case '<': case '>': case '<=': case '>=': {
      if (l == null || r == null) return false;
      const c = compareValues(l, r);
      return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    case '+': {
      const dl = l instanceof BDate ? l : null;
      if (dl) { const d = asDur(r); if (d) return addDuration(dl, d); }
      if (r instanceof BDate && l instanceof BDuration) return addDuration(r, l);
      if (l instanceof BDuration && r instanceof BDuration) { const o = new BDuration(l.parts); for (const k of Object.keys(o.parts) as (keyof typeof o.parts)[]) o.parts[k] += r.parts[k]; return o; }
      if (Array.isArray(l)) return l.concat(Array.isArray(r) ? r : [r]);
      if (typeof l === 'string' || typeof r === 'string' || l instanceof BLink || r instanceof BLink) return display(l) + display(r);
      if (l == null || r == null) return null;
      return num(l) + num(r);
    }
    case '-': {
      if (l instanceof BDate) {
        if (r instanceof BDate || (typeof r === 'string' && parseDate(r))) return BDuration.fromMs(l.t - asDate(r)!.t);
        const d = asDur(r); if (d) return addDuration(l, d, -1);
      }
      if (l instanceof BDuration && r instanceof BDuration) return BDuration.fromMs(l.ms - r.ms);
      if (l == null || r == null) return null;
      return num(l) - num(r);
    }
    case '*': if (l instanceof BDuration) return BDuration.fromMs(l.ms * num(r)); return l == null || r == null ? null : num(l) * num(r);
    case '/': return l == null || r == null ? null : num(l) / num(r);
    case '%': return l == null || r == null ? null : num(l) % num(r);
  }
  return null;
}

function resolveId(name: string, sc: Scope): unknown {
  if (name in sc.vars) return sc.vars[name];
  if (name === 'file') return new FileRoot(sc.file);
  if (name === 'note') return new NoteRoot(sc.file);
  if (name === 'formula') return new FormulaRoot(sc.file);
  if (name === 'this') return sc.self ? new BFile(sc.self) : null;
  return sc.env.noteValue(sc.file, name);
}

const TIME_FIELDS: Record<string, (d: Date) => number> = {
  year: (d) => d.getFullYear(), month: (d) => d.getMonth() + 1, day: (d) => d.getDate(), hour: (d) => d.getHours(),
  minute: (d) => d.getMinutes(), second: (d) => d.getSeconds(), millisecond: (d) => d.getMilliseconds(),
};
const DUR_FIELDS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const;

export function fileProp(f: FileLike, name: string, sc: Scope): unknown {
  const link = () => new BLink(f.path);
  switch (name) {
    case 'name': return f.name;
    case 'basename': return f.basename;
    case 'path': return f.path;
    case 'folder': return f.folder;
    case 'ext': return f.ext;
    case 'size': return f.size;
    case 'ctime': return new BDate(new Date(f.ctime));
    case 'mtime': return new BDate(new Date(f.mtime));
    case 'tags': return allTags(f);
    case 'links': return f.links.map((l) => resolveLinkValue(l, f.path, sc));
    case 'embeds': return f.embeds.map((l) => resolveLinkValue(l, f.path, sc));
    case 'backlinks': return sc.env.backlinks(f.path).map((p) => new BLink(p));
    case 'properties': return Object.fromEntries(Object.keys(f.frontmatter ?? {}).map((k) => [k, sc.env.noteValue(f, k)]));
    case 'file': return new BFile(f);
    case 'link': return link();
  }
  return null;
}
function allTags(f: FileLike): string[] {
  const set = new Set<string>();
  for (const t of f.tags) set.add(t.replace(/^#/, ''));
  return [...set];
}
function resolveLinkValue(raw: string, from: string, sc: Scope): BLink {
  const path = sc.env.resolve(raw, from);
  return new BLink(path, undefined, raw);
}

function getMember(o: unknown, name: string, sc: Scope): unknown {
  if (o == null) return null;
  if (o instanceof FileRoot) return fileProp(o.f, name, sc);
  if (o instanceof NoteRoot) return sc.env.noteValue(o.f, name);
  if (o instanceof FormulaRoot) return sc.env.formula(o.f, name);
  if (o instanceof BFile) {
    const v = fileProp(o.f, name, sc);
    return v !== null ? v : sc.env.noteValue(o.f, name);
  }
  if (o instanceof BDate) { const g = TIME_FIELDS[name]; return g ? g(o.d) : null; }
  if (o instanceof BDuration) {
    if (name === 'milliseconds') return o.ms;
    if (name === 'seconds') return o.ms / 1e3;
    if (name === 'minutes') return o.ms / 6e4;
    if (name === 'hours') return o.ms / 36e5;
    if (name === 'days') return o.ms / 864e5;
    if (name === 'weeks') return o.ms / (7 * 864e5);
    if (name === 'months') return o.ms / (30 * 864e5);
    if (name === 'years') return o.ms / (365 * 864e5);
    return null;
  }
  if (o instanceof BLink) return name === 'path' ? o.path : name === 'display' ? o.display ?? null : null;
  if (typeof o === 'string' || Array.isArray(o)) return name === 'length' ? o.length : null;
  if (typeof o === 'object') return (o as Record<string, unknown>)[name] ?? null;
  return null;
}

// -- calls
const LAZY = new Set(['if', 'map', 'filter', 'reduce']);

function evalCall(node: Extract<Node, { t: 'call' }>, sc: Scope): unknown {
  const fn = node.fn;
  if (fn.t === 'id') {
    if (fn.name === 'if') {
      const [c, a, b] = node.args;
      return isTruthy(evaluate(c, sc)) ? (a ? evaluate(a, sc) : null) : (b ? evaluate(b, sc) : null);
    }
    const args = node.args.map((a) => evaluate(a, sc));
    return callGlobal(fn.name, args, sc);
  }
  if (fn.t === 'member') {
    const target = evaluate(fn.obj, sc);
    if (LAZY.has(fn.name) && Array.isArray(target)) return callListLambda(target, fn.name, node.args, sc);
    const args = node.args.map((a) => evaluate(a, sc));
    return callMethod(target, fn.name, args, sc);
  }
  throw new Error('Not callable');
}

function callListLambda(list: unknown[], name: string, args: Node[], sc: Scope): unknown {
  const body = args[0];
  if (!body) return list;
  const run = (value: unknown, index: number, acc?: unknown) => evaluate(body, { ...sc, vars: { ...sc.vars, value, index, acc } });
  if (name === 'map') return list.map((v, i) => run(v, i));
  if (name === 'filter') return list.filter((v, i) => isTruthy(run(v, i)));
  let acc = args[1] ? evaluate(args[1], sc) : null;
  list.forEach((v, i) => { acc = run(v, i, acc); });
  return acc;
}

const unique = (xs: unknown[]) => { const out: unknown[] = []; for (const x of xs) if (!out.some((y) => looseEquals(x, y))) out.push(x); return out; };
const flat = (xs: unknown[]): unknown[] => xs.flatMap((x) => (Array.isArray(x) ? flat(x) : [x]));

function callGlobal(name: string, a: unknown[], sc: Scope): unknown {
  switch (name) {
    case 'now': return new BDate(new Date());
    case 'today': { const d = new Date(); return new BDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()), true); }
    case 'date': { const v = a[0]; if (v instanceof BDate) return v; return typeof v === 'string' ? parseDate(v) ?? new BError(`Invalid date "${v}"`) : null; }
    case 'duration': return typeof a[0] === 'string' ? parseDuration(a[0]) ?? new BError(`Invalid duration "${a[0]}"`) : a[0] instanceof BDuration ? a[0] : null;
    case 'link': {
      const t = a[0];
      if (t instanceof BLink) return a[1] != null ? new BLink(t.path, toStr(a[1]), t.raw) : t;
      const raw = toStr(t).replace(/^\[\[|\]\]$/g, '');
      const [target, alias] = raw.split('|');
      return new BLink(sc.env.resolve(target, sc.file.path) ?? (/^https?:/.test(target) ? null : null), a[1] != null ? toStr(a[1]) : alias, target);
    }
    case 'file': { const t = a[0]; const path = t instanceof BLink ? t.path : t instanceof BFile ? t.f.path : sc.env.resolve(toStr(t), sc.file.path); const f = path ? sc.env.file(path) : null; return f ? new BFile(f) : null; }
    case 'list': return a[0] == null ? [] : Array.isArray(a[0]) ? a[0] : [a[0]];
    case 'number': return num(a[0]);
    case 'string': return display(a[0]);
    case 'min': { const xs = a.flat().filter((x) => x != null); return xs.length ? xs.reduce((m, x) => (compareValues(x, m) < 0 ? x : m)) : null; }
    case 'max': { const xs = a.flat().filter((x) => x != null); return xs.length ? xs.reduce((m, x) => (compareValues(x, m) > 0 ? x : m)) : null; }
    case 'random': return Math.random();
    case 'escapeHTML': return toStr(a[0]).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    case 'html': return new BHtml(toStr(a[0]));
    case 'image': return new BImage(a[0] instanceof BLink ? a[0].path ?? '' : toStr(a[0]));
    case 'icon': return new BIcon(toStr(a[0]));
    case 'abs': case 'ceil': case 'floor': case 'round': return callMethod(num(a[0]), name, a.slice(1), sc);
    case 'sum': return (Array.isArray(a[0]) ? a[0] : a).reduce((s: number, x) => s + (num(x) || 0), 0);
    case 'contains': return callMethod(a[0], 'contains', a.slice(1), sc);
  }
  throw new Error(`Unknown function ${name}()`);
}

export function callMethod(t: unknown, name: string, a: unknown[], sc: Scope): unknown {
  // Any
  if (name === 'isTruthy') return isTruthy(t);
  if (name === 'toString') return display(t);
  if (name === 'isType') return typeOf(t) === toStr(a[0]) || (toStr(a[0]) === 'date' && t instanceof BDate);
  if (name === 'isEmpty' && !(t instanceof BFile)) return isEmptyValue(t);
  if (t == null) return null;

  if (t instanceof FileRoot || t instanceof BFile) return fileMethod(t instanceof FileRoot ? t.f : t.f, name, a, sc);
  if (t instanceof BLink) {
    if (name === 'asFile') { const f = t.path ? sc.env.file(t.path) : null; return f ? new BFile(f) : null; }
    if (name === 'linksTo') return t.path != null && a[0] instanceof BFile && t.path === a[0].f.path;
    if (name === 'toString') return t.toString();
  }
  if (t instanceof BDate) return dateMethod(t, name, a);
  if (t instanceof BDuration) { if (name === 'format') return t.toString(); throw new Error(`Unknown duration method ${name}()`); }

  if (typeof t === 'string') return stringMethod(t, name, a, sc);
  if (typeof t === 'number') return numberMethod(t, name, a);
  if (Array.isArray(t)) return listMethod(t, name, a, sc);
  if (typeof t === 'object' && !(t instanceof BHtml) && !(t instanceof RegExp)) {
    const o = t as Record<string, unknown>;
    if (name === 'keys') return Object.keys(o);
    if (name === 'values') return Object.values(o);
    if (name === 'contains') return toStr(a[0]) in o;
  }
  if (t instanceof RegExp && name === 'matches') return t.test(toStr(a[0]));
  if (typeof t === 'boolean') return null;
  throw new Error(`Unknown method ${name}() on ${typeOf(t)}`);
}

function fileMethod(f: FileLike, name: string, a: unknown[], sc: Scope): unknown {
  switch (name) {
    case 'hasTag': {
      const tags = allTags(f);
      return a.some((x) => { const w = toStr(x).replace(/^#/, ''); return tags.some((t) => t === w || t.startsWith(w + '/')); });
    }
    case 'hasLink': {
      const target = a[0] instanceof BFile ? a[0].f.path : a[0] instanceof BLink ? a[0].path : sc.env.resolve(toStr(a[0]), f.path);
      return target != null && [...f.links, ...f.embeds].some((l) => sc.env.resolve(l, f.path) === target);
    }
    case 'hasProperty': return toStr(a[0]) in (f.frontmatter ?? {});
    case 'inFolder': { const d = toStr(a[0]).replace(/^\/|\/$/g, ''); return d === '' || f.folder === d || f.folder.startsWith(d + '/'); }
    case 'asLink': return new BLink(f.path, a[0] != null ? toStr(a[0]) : undefined);
    case 'isEmpty': return false;
  }
  throw new Error(`Unknown file method ${name}()`);
}

function dateMethod(d: BDate, name: string, a: unknown[]): unknown {
  switch (name) {
    case 'format': return formatDate(d.d, toStr(a[0] ?? 'YYYY-MM-DD'));
    case 'date': return new BDate(new Date(d.d.getFullYear(), d.d.getMonth(), d.d.getDate()), true);
    case 'time': return formatDate(d.d, 'HH:mm:ss');
    case 'relative': return relative(d.d);
    case 'toString': return d.toString();
  }
  throw new Error(`Unknown date method ${name}()`);
}
function relative(d: Date): string {
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: [number, string][] = [[3.15576e10, 'year'], [2.592e9, 'month'], [6048e5, 'week'], [864e5, 'day'], [36e5, 'hour'], [6e4, 'minute']];
  for (const [ms, label] of units) {
    if (abs >= ms) { const n = Math.floor(abs / ms); const s = `${n} ${label}${n === 1 ? '' : 's'}`; return diff < 0 ? `${s} ago` : `in ${s}`; }
  }
  return 'just now';
}

function stringMethod(s: string, name: string, a: unknown[], sc: Scope): unknown {
  switch (name) {
    case 'contains': return s.includes(toStr(a[0]));
    case 'containsAll': return a.flat().every((x) => s.includes(toStr(x)));
    case 'containsAny': return a.flat().some((x) => s.includes(toStr(x)));
    case 'startsWith': return s.startsWith(toStr(a[0]));
    case 'endsWith': return s.endsWith(toStr(a[0]));
    case 'lower': return s.toLowerCase();
    case 'upper': return s.toUpperCase();
    case 'title': return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case 'trim': return s.trim();
    case 'replace': {
      const pat = a[0]; const rep = toStr(a[1]);
      return pat instanceof RegExp ? s.replace(pat, rep) : s.split(toStr(pat)).join(rep);
    }
    case 'repeat': return s.repeat(Math.max(0, num(a[0]) || 0));
    case 'reverse': return [...s].reverse().join('');
    case 'slice': return s.slice(num(a[0]) || 0, a[1] == null ? undefined : num(a[1]));
    case 'split': return a[0] instanceof RegExp ? s.split(a[0]) : s.split(toStr(a[0]));
    case 'length': return s.length;
    case 'toNumber': return num(s);
    case 'matches': return a[0] instanceof RegExp ? a[0].test(s) : false;
  }
  // date-like strings (front-matter dates) accept date methods
  const d = parseDate(s); if (d) return dateMethod(d, name, a);
  void sc; throw new Error(`Unknown string method ${name}()`);
}

function numberMethod(n: number, name: string, a: unknown[]): unknown {
  switch (name) {
    case 'abs': return Math.abs(n);
    case 'ceil': return Math.ceil(n);
    case 'floor': return Math.floor(n);
    case 'round': { const p = 10 ** (num(a[0]) || 0); return Math.round(n * p) / p; }
    case 'toFixed': return n.toFixed(num(a[0]) || 0);
  }
  throw new Error(`Unknown number method ${name}()`);
}

function listMethod(l: unknown[], name: string, a: unknown[], sc: Scope): unknown {
  switch (name) {
    case 'contains': return l.some((x) => looseEquals(x, a[0]));
    case 'containsAll': return a.flat().every((v) => l.some((x) => looseEquals(x, v)));
    case 'containsAny': return a.flat().some((v) => l.some((x) => looseEquals(x, v)));
    case 'sort': return [...l].sort(compareValues);
    case 'reverse': return [...l].reverse();
    case 'unique': return unique(l);
    case 'flat': return flat(l);
    case 'join': return l.map(display).join(a[0] == null ? ', ' : toStr(a[0]));
    case 'slice': return l.slice(num(a[0]) || 0, a[1] == null ? undefined : num(a[1]));
    case 'length': return l.length;
    case 'concat': return l.concat(...a.map((x) => (Array.isArray(x) ? x : [x])));
    case 'map': case 'filter': case 'reduce': return l;
  }
  void sc; throw new Error(`Unknown list method ${name}()`);
}

/** Evaluate source text; errors become `BError` values (used for formulas and display). */
export function evalSource(src: string, sc: Scope): unknown {
  try { return evaluate(parseExpression(src), sc); } catch (e) { return new BError((e as Error).message); }
}
export { BIcon };
