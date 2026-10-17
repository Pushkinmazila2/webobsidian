/**
 * Structured model of a Bases filter for the filter-editor UI: a combinator (`and` / `or`) over simple
 * conditions (`property op value`). Conditions are converted to/from the expression strings stored in the
 * `.base` file; anything the UI cannot express is kept verbatim as a "raw" row so nothing is lost.
 */
import type { FilterNode } from './engine';

export type Op = 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'gt' | 'lt' | 'gte' | 'lte' | 'empty' | 'notEmpty' | 'hasTag' | 'inFolder';
export const OPS: { op: Op; label: string; needsValue: boolean; fileOnly?: boolean }[] = [
  { op: 'is', label: 'is', needsValue: true },
  { op: 'isNot', label: 'is not', needsValue: true },
  { op: 'contains', label: 'contains', needsValue: true },
  { op: 'notContains', label: 'does not contain', needsValue: true },
  { op: 'startsWith', label: 'starts with', needsValue: true },
  { op: 'endsWith', label: 'ends with', needsValue: true },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'gte', label: '≥', needsValue: true },
  { op: 'lte', label: '≤', needsValue: true },
  { op: 'empty', label: 'is empty', needsValue: false },
  { op: 'notEmpty', label: 'is not empty', needsValue: false },
  { op: 'hasTag', label: 'has tag', needsValue: true, fileOnly: true },
  { op: 'inFolder', label: 'is in folder', needsValue: true, fileOnly: true },
];
export interface Cond { prop: string; op: Op; value: string }
export type Item = { kind: 'cond'; cond: Cond } | { kind: 'raw'; node: FilterNode };
export interface FilterModel { mode: 'and' | 'or'; items: Item[] }

const PROP = String.raw`[A-Za-z_][\w\-]*(?:\.[A-Za-z_][\w\-]*)*`;
const lit = (v: string): string => (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false' ? v : JSON.stringify(v));
const unlit = (s: string): string | null => {
  s = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(s) || s === 'true' || s === 'false') return s;
  if (s.startsWith('"')) { try { const v = JSON.parse(s); return typeof v === 'string' ? v : null; } catch { return null; } }
  return null;
};

export function condToExpr(c: Cond): string {
  const p = c.prop || 'file.name';
  switch (c.op) {
    case 'is': return `${p} == ${lit(c.value)}`;
    case 'isNot': return `${p} != ${lit(c.value)}`;
    case 'gt': return `${p} > ${lit(c.value)}`;
    case 'lt': return `${p} < ${lit(c.value)}`;
    case 'gte': return `${p} >= ${lit(c.value)}`;
    case 'lte': return `${p} <= ${lit(c.value)}`;
    case 'contains': return `${p}.contains(${JSON.stringify(c.value)})`;
    case 'notContains': return `!${p}.contains(${JSON.stringify(c.value)})`;
    case 'startsWith': return `${p}.startsWith(${JSON.stringify(c.value)})`;
    case 'endsWith': return `${p}.endsWith(${JSON.stringify(c.value)})`;
    case 'empty': return `${p}.isEmpty()`;
    case 'notEmpty': return `!${p}.isEmpty()`;
    case 'hasTag': return `file.hasTag(${JSON.stringify(c.value)})`;
    case 'inFolder': return `file.inFolder(${JSON.stringify(c.value)})`;
  }
}

export function exprToCond(src: string): Cond | null {
  const s = src.trim();
  let m = new RegExp(`^file\\.(hasTag|inFolder)\\(("(?:[^"\\\\]|\\\\.)*")\\)$`).exec(s);
  if (m) { const v = unlit(m[2]); return v == null ? null : { prop: 'file.name', op: m[1] as Op, value: v }; }
  m = new RegExp(`^(!)?(${PROP})\\.(contains|startsWith|endsWith)\\(("(?:[^"\\\\]|\\\\.)*")\\)$`).exec(s);
  if (m) {
    const v = unlit(m[4]); if (v == null) return null;
    if (m[3] === 'contains') return { prop: m[2], op: m[1] ? 'notContains' : 'contains', value: v };
    return m[1] ? null : { prop: m[2], op: m[3] as Op, value: v };
  }
  m = new RegExp(`^(!)?(${PROP})\\.isEmpty\\(\\)$`).exec(s);
  if (m) return { prop: m[2], op: m[1] ? 'notEmpty' : 'empty', value: '' };
  m = new RegExp(`^(${PROP})\\s*(==|!=|>=|<=|>|<)\\s*(.+)$`).exec(s);
  if (m) {
    const v = unlit(m[3]); if (v == null) return null;
    const op: Op = ({ '==': 'is', '!=': 'isNot', '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt' } as const)[m[2] as '=='];
    return { prop: m[1], op, value: v };
  }
  return null;
}

export function filterToModel(node: FilterNode | undefined): FilterModel {
  if (node == null) return { mode: 'and', items: [] };
  const list: FilterNode[] = typeof node === 'string' ? [node] : 'and' in node ? node.and : 'or' in node ? node.or : [node];
  const mode: 'and' | 'or' = typeof node !== 'string' && 'or' in node ? 'or' : 'and';
  return {
    mode,
    items: list.map((n): Item => {
      if (typeof n === 'string') { const cond = exprToCond(n); if (cond) return { kind: 'cond', cond }; }
      return { kind: 'raw', node: n };
    }),
  };
}

export function modelToFilter(m: FilterModel): FilterNode | undefined {
  const nodes = m.items.map((i): FilterNode => (i.kind === 'cond' ? condToExpr(i.cond) : i.node));
  if (!nodes.length) return undefined;
  return m.mode === 'or' ? { or: nodes } : { and: nodes };
}
