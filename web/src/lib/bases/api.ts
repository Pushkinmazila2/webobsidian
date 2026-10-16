/**
 * The Bases part of Obsidian's plugin API (`BasesView`, `BasesEntry`, `BasesQueryResult`, `Value` classes …)
 * on top of the engine in engine.ts. It has no import from obsidianApi.ts (that file imports this one and
 * hands over the few app classes needed through `deps`), so there is no module cycle.
 */
import {
  BDate, BDuration, BLink, BHtml, BImage, BIcon, BError, parseDate, parseDuration, looseEquals, isEmptyValue, isTruthy, toStr, display,
} from './values';
import { BFile } from './expr';
import {
  runView, summarize, displayName, normalizeId, type BaseConfig, type BaseContext, type ViewConfig, type ViewResult, type Row, type BaseFile,
} from './engine';

export interface BasesApiDeps {
  Component: new () => any;
  getApp: () => any;
  openPath: (path: string, newTab?: boolean) => void;
  createNote: (path: string, body: string) => Promise<any>;
}

export function createBasesApi(deps: BasesApiDeps) {
  const { Component } = deps;

  // ------------------------------------------------------------ Value classes
  abstract class Value {
    static type = 'value';
    /** Engine value this wraps (null, number, string, BDate, …). */
    raw: unknown = null;
    abstract toString(): string;
    abstract isTruthy(): boolean;
    static equals(a: Value | null, b: Value | null): boolean { return a == null || b == null ? a == b : a.equals(b); }
    static looseEquals(a: Value | null, b: Value | null): boolean { return a == null || b == null ? a == b : a.looseEquals(b); }
    equals(other: Value): boolean { return !!other && Object.getPrototypeOf(this) === Object.getPrototypeOf(other) && this.toString() === other.toString(); }
    looseEquals(other: Value): boolean { return !!other && looseEquals(this.raw, other.raw); }
    renderTo(el: HTMLElement, _ctx?: unknown): void { renderRaw(el, this.raw); }
  }
  abstract class NotNullValue extends Value {}
  class NullValue extends Value {
    static type = 'null';
    static value: NullValue;
    toString() { return ''; }
    isTruthy() { return false; }
  }
  NullValue.value = new NullValue();
  abstract class PrimitiveValue<T> extends NotNullValue {
    value: T;
    constructor(value: T) { super(); this.value = value; this.raw = value; }
    toString() { return String(this.value); }
    isTruthy() { return !!this.value; }
  }
  class StringValue extends PrimitiveValue<string> { static type = 'string'; }
  class NumberValue extends PrimitiveValue<number> { static type = 'number'; toString() { return toStr(this.value); } }
  class BooleanValue extends PrimitiveValue<boolean> { static type = 'boolean'; }
  class HTMLValue extends StringValue { static type = 'html'; constructor(v: string) { super(v); this.raw = new BHtml(v); } }
  class IconValue extends StringValue { static type = 'icon'; constructor(v: string) { super(v); this.raw = new BIcon(v); } }
  class ImageValue extends StringValue { static type = 'image'; constructor(v: string) { super(v); this.raw = new BImage(v); } }
  class UrlValue extends StringValue { static type = 'url'; }
  class TagValue extends StringValue { static type = 'tag'; }
  class LinkValue extends StringValue {
    static type = 'link';
    link: BLink;
    constructor(v: string | BLink) { const l = typeof v === 'string' ? new BLink(v.replace(/^\[\[|\]\]$/g, '').split('|')[0], undefined, v) : v; super(l.toString()); this.link = l; this.raw = l; }
    static parseFromString(app: any, input: string, sourcePath: string): LinkValue | null {
      const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(input.trim());
      if (!m) return null;
      const dest = app?.metadataCache?.getFirstLinkpathDest?.(m[1], sourcePath);
      return new LinkValue(new BLink(dest?.path ?? null, m[2], m[1]));
    }
  }
  class DateValue extends NotNullValue {
    static type = 'date';
    d: BDate;
    constructor(d: BDate | Date) { super(); this.d = d instanceof BDate ? d : new BDate(d); this.raw = this.d; }
    toString() { return this.d.toString(); }
    isTruthy() { return !isNaN(this.d.t); }
    dateOnly(): DateValue { return new DateValue(new BDate(new Date(this.d.d.getFullYear(), this.d.d.getMonth(), this.d.d.getDate()), true)); }
    relative(): string { return relativeText(this.d.d); }
    static parseFromString(input: string): DateValue | null { const d = parseDate(input); return d ? new DateValue(d) : null; }
  }
  class RelativeDateValue extends DateValue { static type = 'relative-date'; toString() { return this.relative(); } }
  class DurationValue extends NotNullValue {
    static type = 'duration';
    dur: BDuration;
    constructor(d: BDuration) { super(); this.dur = d; this.raw = d; }
    toString() { return this.dur.toString(); }
    isTruthy() { return this.dur.ms !== 0; }
    addToDate(value: DateValue, subtract = false): DateValue { const ms = this.dur.ms * (subtract ? -1 : 1); return new DateValue(new BDate(new Date(value.d.t + ms), value.d.dateOnly)); }
    getMilliseconds() { return this.dur.ms; }
    static parseFromString(input: string): DurationValue | null { const d = parseDuration(input); return d ? new DurationValue(d) : null; }
    static fromMilliseconds(ms: number) { return new DurationValue(BDuration.fromMs(ms)); }
  }
  class FileValue extends NotNullValue {
    static type = 'file';
    file: BaseFile;
    constructor(file: BaseFile) { super(); this.file = file; this.raw = new BFile(file); }
    toString() { return this.file.path; }
    isTruthy() { return true; }
  }
  class RegExpValue extends NotNullValue {
    static type = 'regexp';
    re: RegExp;
    constructor(re: RegExp) { super(); this.re = re; this.raw = re; }
    toString() { return this.re.toString(); }
    isTruthy() { return true; }
  }
  class ErrorValue extends NotNullValue {
    static type = 'error';
    message: string;
    constructor(message: string) { super(); this.message = message; this.raw = new BError(message); }
    toString() { return `Error: ${this.message}`; }
    isTruthy() { return false; }
  }
  class ListValue extends NotNullValue {
    static type = 'list';
    value: Value[];
    constructor(value: unknown[]) { super(); this.value = value.map((x) => (x instanceof Value ? x : wrapValue(x))); this.raw = this.value.map((v) => v.raw); }
    toString() { return this.value.map((v) => v.toString()).join(', '); }
    isTruthy() { return this.value.length > 0; }
    includes(v: Value) { return this.value.some((x) => x.looseEquals(v)); }
    length() { return this.value.length; }
    get(i: number): Value | null { return this.value[i] ?? null; }
    concat(other: ListValue) { return new ListValue([...this.value, ...other.value]); }
  }
  class ObjectValue extends NotNullValue {
    static type = 'object';
    value: Record<string, unknown>;
    constructor(value: Record<string, unknown> = {}) { super(); this.value = value; this.raw = value; }
    toString() { return JSON.stringify(this.value); }
    isTruthy() { return !this.isEmpty(); }
    isEmpty() { return Object.keys(this.value).length === 0; }
    get(key: string): Value | null { return key in this.value ? wrapValue(this.value[key]) : null; }
  }

  /** Engine value → `Value` instance. */
  function wrapValue(v: unknown): Value {
    if (v instanceof Value) return v;
    if (v == null) return NullValue.value;
    if (typeof v === 'boolean') return new BooleanValue(v);
    if (typeof v === 'number') return new NumberValue(v);
    if (typeof v === 'string') return /^https?:\/\//i.test(v) ? new UrlValue(v) : new StringValue(v);
    if (Array.isArray(v)) return new ListValue(v);
    if (v instanceof BDate) return new DateValue(v);
    if (v instanceof BDuration) return new DurationValue(v);
    if (v instanceof BLink) return new LinkValue(v);
    if (v instanceof BFile) return new FileValue(v.f);
    if (v instanceof BHtml) return new HTMLValue(v.html);
    if (v instanceof BImage) return new ImageValue(v.url);
    if (v instanceof BIcon) return new IconValue(v.name);
    if (v instanceof BError) return new ErrorValue(v.message);
    if (v instanceof RegExp) return new RegExpValue(v);
    if (typeof v === 'object') return new ObjectValue(v as Record<string, unknown>);
    return new StringValue(String(v));
  }

  function relativeText(d: Date): string {
    const diff = d.getTime() - Date.now(); const abs = Math.abs(diff);
    const units: [number, string][] = [[3.15576e10, 'year'], [2.592e9, 'month'], [6048e5, 'week'], [864e5, 'day'], [36e5, 'hour'], [6e4, 'minute']];
    for (const [ms, label] of units) if (abs >= ms) { const n = Math.floor(abs / ms); const s = `${n} ${label}${n === 1 ? '' : 's'}`; return diff < 0 ? `${s} ago` : `in ${s}`; }
    return 'just now';
  }

  /** Default DOM rendering of a value (links open the note; lists are comma-separated). */
  function renderRaw(el: HTMLElement, v: unknown): void {
    if (v == null) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => { if (i) el.appendChild(document.createTextNode(', ')); const s = document.createElement('span'); renderRaw(s, x); el.appendChild(s); });
      return;
    }
    if (v instanceof BLink) {
      const a = document.createElement('a');
      a.className = 'internal-link' + (v.path ? '' : ' is-unresolved');
      a.textContent = v.toString();
      if (v.path) { a.setAttribute('data-href', v.path); a.addEventListener('click', (e) => { e.preventDefault(); deps.openPath(v.path!, e.ctrlKey || e.metaKey); }); }
      el.appendChild(a); return;
    }
    if (v instanceof BFile) { renderRaw(el, new BLink(v.f.path)); return; }
    if (v instanceof BHtml) { el.innerHTML = v.html; return; }
    if (v instanceof BImage) { const i = document.createElement('img'); i.src = v.url; el.appendChild(i); return; }
    if (v instanceof BError) { const s = document.createElement('span'); s.className = 'bases-error'; s.textContent = v.toString(); el.appendChild(s); return; }
    if (typeof v === 'boolean') { const c = document.createElement('input'); c.type = 'checkbox'; c.checked = v; c.disabled = true; el.appendChild(c); return; }
    el.appendChild(document.createTextNode(display(v)));
  }

  // ------------------------------------------------------------ query objects
  class BasesEntry {
    file: any;
    constructor(public row: Row) { this.file = deps.getApp().vault.getAbstractFileByPath(row.file.path) ?? { path: row.file.path, name: row.file.name, basename: row.file.basename, extension: row.file.ext }; }
    getValue(propertyId: string): Value | null {
      const v = this.row.get(normalizeId(propertyId));
      return v == null ? NullValue.value : wrapValue(v);
    }
  }
  class BasesEntryGroup {
    key?: Value;
    entries: BasesEntry[];
    constructor(key: Value | undefined, entries: BasesEntry[]) { this.key = key; this.entries = entries; }
    hasKey() { return !!this.key && !(this.key instanceof NullValue); }
  }
  class BasesQueryResult {
    data: BasesEntry[];
    private _groups: BasesEntryGroup[];
    private _props: string[];
    constructor(public result: ViewResult, private base: BaseConfig, private ctx: BaseContext) {
      const wrap = new Map<Row, BasesEntry>();
      const entry = (r: Row) => wrap.get(r) ?? (wrap.set(r, new BasesEntry(r)), wrap.get(r)!);
      this.data = result.rows.map(entry);
      this._groups = result.groups
        ? result.groups.map((g) => new BasesEntryGroup(g.key == null ? NullValue.value : wrapValue(g.key), g.rows.map(entry)))
        : [new BasesEntryGroup(undefined, this.data)];
      this._props = result.columns.map((c) => normalizeId(c.id));
    }
    get groupedData() { return this._groups; }
    get properties() { return this._props; }
    getSummaryValue(_controller: unknown, entries: BasesEntry[], prop: string, summaryKey: string): Value {
      return wrapValue(summarize(summaryKey, entries.map((e) => e.row.get(normalizeId(prop))), this.ctx, this.base));
    }
  }
  class BasesViewConfig {
    constructor(private view: ViewConfig, private base: BaseConfig, private changed: () => void, private controller: QueryController) {}
    get name(): string { return this.view.name ?? ''; }
    set name(v: string) { this.view.name = v; this.changed(); }
    get(key: string): unknown { return this.view[key] ?? null; }
    getAsPropertyId(key: string): string | null { const v = this.view[key]; return typeof v === 'string' && v ? normalizeId(v) : null; }
    getEvaluatedFormula(_view: unknown, key: string): Value {
      const src = this.view[key];
      if (typeof src !== 'string' || !src) return NullValue.value;
      return wrapValue(this.controller.evaluate(src));
    }
    set(key: string, value: unknown): void { if (value === null || value === undefined) delete this.view[key]; else this.view[key] = value; this.changed(); }
    getOrder(): string[] { return this.controller.result.columns.map((c) => normalizeId(c.id)); }
    getSort(): { property: string; direction: 'ASC' | 'DESC' }[] {
      return (this.view.sort ?? []).filter((s) => s && s.property).map((s) => ({ property: normalizeId(s.property), direction: s.direction === 'DESC' ? 'DESC' as const : 'ASC' as const }));
    }
    getDisplayName(id: string): string { return displayName(normalizeId(id), this.base); }
  }

  /** Runs a base's query and keeps the plugin view informed (one controller per displayed base view). */
  class QueryController extends Component {
    app: any;
    base: BaseConfig;
    viewIndex = 0;
    result!: ViewResult;
    private ctx: BaseContext;
    private thisFile: BaseFile | null;
    config!: BasesViewConfig;
    data!: BasesQueryResult;
    onChange: () => void = () => {};
    view: any = null;
    constructor(app: any, base: BaseConfig, ctx: BaseContext, thisFile: BaseFile | null, viewIndex: number, onChange: () => void) {
      super(); this.app = app; this.base = base; this.ctx = ctx; this.thisFile = thisFile; this.viewIndex = viewIndex; this.onChange = onChange;
      this.update(base, ctx, thisFile);
    }
    evaluate(src: string): unknown {
      const f = this.thisFile ?? this.ctx.env.files[0];
      if (!f) return null;
      return this.ctx.evalFor(src, f, this.thisFile);
    }
    /** Re-run the query and push the new data to the view. */
    update(base: BaseConfig, ctx: BaseContext, thisFile: BaseFile | null) {
      this.base = base; this.ctx = ctx; this.thisFile = thisFile;
      this.result = runView(base, this.viewIndex, ctx, thisFile);
      this.config = new BasesViewConfig(base.views?.[this.viewIndex] ?? { type: 'table' }, base, () => this.onChange(), this);
      this.data = new BasesQueryResult(this.result, base, ctx);
      const v = this.view;
      if (v) {
        v.config = this.config; v.data = this.data; v.allProperties = this.allProperties();
        try { v.onDataUpdated?.(); } catch (e) { console.warn('[bases] view failed to render:', e); }
      }
    }
    allProperties(): string[] {
      const keys = new Set<string>(['file.name', 'file.path', 'file.folder', 'file.ext', 'file.size', 'file.ctime', 'file.mtime', 'file.tags', 'file.links', 'file.backlinks']);
      for (const f of this.ctx.env.files) for (const k of Object.keys(f.frontmatter ?? {})) keys.add(`note.${k}`);
      for (const k of Object.keys(this.base.formulas ?? {})) keys.add(`formula.${k}`);
      return [...keys];
    }
  }

  abstract class BasesView extends Component {
    abstract type: string;
    app: any;
    config: BasesViewConfig;
    allProperties: string[];
    data: BasesQueryResult;
    protected constructor(controller: QueryController) {
      super();
      this.app = controller.app; this.config = controller.config; this.data = controller.data; this.allProperties = controller.allProperties();
      (this as any).controller = controller;
    }
    abstract onDataUpdated(): void;
    async createFileForView(baseFileName = 'Untitled', frontmatterProcessor?: (fm: any, file: any) => void): Promise<void> {
      const vault = this.app.vault;
      let name = baseFileName.replace(/\.md$/i, ''); let path = `${name}.md`;
      for (let i = 1; vault.getAbstractFileByPath(path); i++) path = `${name} ${i}.md`;
      const fm: Record<string, unknown> = {};
      frontmatterProcessor?.(fm, { path });
      const yaml = Object.keys(fm).length ? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n` : '';
      await deps.createNote(path, yaml);
    }
  }

  return {
    Value, NotNullValue, NullValue, PrimitiveValue, StringValue, NumberValue, BooleanValue, HTMLValue, IconValue, ImageValue, UrlValue, TagValue, LinkValue,
    DateValue, RelativeDateValue, DurationValue, FileValue, RegExpValue, ErrorValue, ListValue, ObjectValue,
    BasesEntry, BasesEntryGroup, BasesQueryResult, BasesViewConfig, QueryController, BasesView,
    wrapValue, renderRaw,
  };
}
export type BasesApi = ReturnType<typeof createBasesApi>;
export { isTruthy, isEmptyValue };
