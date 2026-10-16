/**
 * Value model for Bases formulas. Plain JS values are used wherever possible (null, boolean, number,
 * string, array, plain object); the few richer kinds are small classes so the evaluator can tell them apart.
 * Pure — no DOM, no app state (unit-tested in Node).
 */
import { formatDate } from '../obsidianUtils';

export class BDate {
  constructor(public d: Date, public dateOnly = false) {}
  get t() { return this.d.getTime(); }
  toString() { return this.dateOnly ? formatDate(this.d, 'YYYY-MM-DD') : formatDate(this.d, 'YYYY-MM-DD HH:mm:ss'); }
}

export interface DurationParts { years: number; months: number; weeks: number; days: number; hours: number; minutes: number; seconds: number; ms: number }
const ZERO: DurationParts = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0, ms: 0 };
export class BDuration {
  parts: DurationParts;
  constructor(parts: Partial<DurationParts> = {}) { this.parts = { ...ZERO, ...parts }; }
  /** Approximate length in ms (a month is 30 days, a year 365). */
  get ms(): number {
    const p = this.parts;
    return p.years * 365 * 864e5 + p.months * 30 * 864e5 + p.weeks * 7 * 864e5 + p.days * 864e5 + p.hours * 36e5 + p.minutes * 6e4 + p.seconds * 1e3 + p.ms;
  }
  static fromMs(ms: number) { return new BDuration({ ms }); }
  toString() {
    const out: string[] = [];
    for (const [k, v] of Object.entries(this.parts)) if (v) out.push(`${v} ${k === 'ms' ? 'ms' : v === 1 ? k.slice(0, -1) : k}`);
    return out.join(' ') || '0 ms';
  }
}

export class BLink {
  constructor(public path: string | null, public display?: string, public raw = '') {}
  toString() { return this.display ?? (this.path ? this.path.replace(/^.*\//, '').replace(/\.md$/i, '') : this.raw); }
}

export class BHtml { constructor(public html: string) {} toString() { return this.html; } }
export class BImage { constructor(public url: string) {} toString() { return this.url; } }
export class BIcon { constructor(public name: string) {} toString() { return this.name; } }
export class BError { constructor(public message: string) {} toString() { return `Error: ${this.message}`; } }

const UNIT_RE = /(-?\d+(?:\.\d+)?)\s*(years?|yr?s?|months?|mo|M|weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|milliseconds?|ms)\b/g;
const UNIT_KEY: Record<string, keyof DurationParts> = {
  y: 'years', yr: 'years', yrs: 'years', year: 'years', years: 'years', mo: 'months', M: 'months', month: 'months', months: 'months',
  w: 'weeks', week: 'weeks', weeks: 'weeks', d: 'days', day: 'days', days: 'days', h: 'hours', hr: 'hours', hrs: 'hours', hour: 'hours', hours: 'hours',
  m: 'minutes', min: 'minutes', mins: 'minutes', minute: 'minutes', minutes: 'minutes', s: 'seconds', sec: 'seconds', secs: 'seconds', second: 'seconds', seconds: 'seconds',
  ms: 'ms', millisecond: 'ms', milliseconds: 'ms',
};
/** "1d", "2 weeks", "1y 3M", "-3h" → duration; null when the text is not a duration. */
export function parseDuration(text: string): BDuration | null {
  const t = text.trim();
  if (!t) return null;
  const parts: Partial<DurationParts> = {};
  let rest = t;
  let any = false;
  rest = rest.replace(UNIT_RE, (_m, n, u) => { const k = UNIT_KEY[u]; if (!k) return _m; parts[k] = (parts[k] ?? 0) + parseFloat(n); any = true; return ''; });
  if (!any || rest.replace(/[\s,]|and/g, '') !== '') return null;
  return new BDuration(parts);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** ISO-ish date/datetime text → BDate (date-only strings stay date-only); null otherwise. */
export function parseDate(text: string): BDate | null {
  const t0 = text.trim();
  // YAML dates reach the client as `YYYY-MM-DDT00:00:00.000Z` (JSON of a Date): that is a date without a time.
  const midnight = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.000)?Z$/.exec(t0);
  if (midnight) return new BDate(new Date(+midnight[1], +midnight[2] - 1, +midnight[3]), true);
  const m = ISO_RE.exec(t0);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let date: Date;
  if (h === undefined) date = new Date(+y, +mo - 1, +d);
  else if (tz) date = new Date(text.trim().replace(' ', 'T'));
  else date = new Date(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  if (isNaN(date.getTime())) return null;
  return new BDate(date, h === undefined);
}

export function addDuration(date: BDate, dur: BDuration, sign = 1): BDate {
  const p = dur.parts;
  const d = new Date(date.d.getTime());
  if (p.years) d.setFullYear(d.getFullYear() + sign * p.years);
  if (p.months) d.setMonth(d.getMonth() + sign * p.months);
  const ms = (p.weeks * 7 + p.days) * 864e5 + p.hours * 36e5 + p.minutes * 6e4 + p.seconds * 1e3 + p.ms;
  d.setTime(d.getTime() + sign * ms);
  const timeless = date.dateOnly && !p.hours && !p.minutes && !p.seconds && !p.ms;
  return new BDate(d, timeless);
}

export function isEmptyValue(v: unknown): boolean {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof BError) return false;
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.keys(v as object).length === 0;
  return false;
}
export function isTruthy(v: unknown): boolean {
  if (v == null || v === false || v === 0 || v === '') return false;
  if (typeof v === 'number' && isNaN(v)) return false;
  return true;
}

export function typeOf(v: unknown): string {
  if (v == null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'list';
  if (v instanceof BDate) return v.dateOnly ? 'date' : 'datetime';
  if (v instanceof BDuration) return 'duration';
  if (v instanceof BLink) return 'link';
  if (v instanceof BHtml) return 'html';
  if (v instanceof BImage) return 'image';
  if (v instanceof BIcon) return 'icon';
  if (v instanceof RegExp) return 'regexp';
  return 'object';
}

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  if (Array.isArray(v)) return v.map(toStr).join(', ');
  if (v instanceof RegExp) return v.toString();
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return JSON.stringify(v);
  return String(v);
}

/** Loose equality: numbers vs numeric text, dates by instant, links by target, lists element-wise. */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof BDate || b instanceof BDate) {
    const da = a instanceof BDate ? a : typeof a === 'string' ? parseDate(a) : null;
    const db = b instanceof BDate ? b : typeof b === 'string' ? parseDate(b) : null;
    return !!da && !!db && da.t === db.t;
  }
  if (a instanceof BLink || b instanceof BLink) {
    const pa = a instanceof BLink ? a.path ?? a.raw : toStr(a);
    const pb = b instanceof BLink ? b.path ?? b.raw : toStr(b);
    return pa === pb || (a instanceof BLink && b instanceof BLink ? false : toStr(a) === toStr(b));
  }
  if (a instanceof BDuration && b instanceof BDuration) return a.ms === b.ms;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => looseEquals(x, b[i]));
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b) && b.trim() !== '';
  if (typeof a === 'string' && typeof b === 'number') return looseEquals(b, a);
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Ordering used by `<`, `>` and by sorting: nulls sort last; −1/0/1. */
export function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a instanceof BDate || b instanceof BDate) {
    const da = a instanceof BDate ? a : typeof a === 'string' ? parseDate(a) : null;
    const db = b instanceof BDate ? b : typeof b === 'string' ? parseDate(b) : null;
    if (da && db) return da.t < db.t ? -1 : da.t > db.t ? 1 : 0;
  }
  if (a instanceof BDuration && b instanceof BDuration) return Math.sign(a.ms - b.ms);
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compareValues(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  return toStr(a).localeCompare(toStr(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Display text for a value (cells, `toString()`); dates without a time show only the day. */
export function display(v: unknown): string {
  if (v instanceof BDate) return v.toString();
  if (v instanceof BLink) return v.toString();
  if (v instanceof BDuration) return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return toStr(v);
}
