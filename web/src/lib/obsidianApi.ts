/**
 * The `obsidian` module for community plugins running in the browser (PRD FR-8).
 *
 * Plugins are written against Obsidian's API; this implements the commonly used subset on top
 * of WebObsidian: commands, ribbon, status bar, settings tabs, modals, notices, setting widgets,
 * DOM helpers (`createEl`, `setText`, …), a CodeMirror-backed Editor, vault access and events.
 * Anything not implemented is a no-op or throws a clear error — the loader reports it per plugin.
 */
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, redo, indentMore, indentLess, cursorDocStart, cursorDocEnd, selectAll, deleteLine } from '@codemirror/commands';
import { api } from './api';
import { useStore, type ContextMenuItem } from './store';
import { getActiveEditor } from './activeEditor';
import { pluginHost } from './pluginHost';
import { iconSvg, registerCustomIcon, unregisterCustomIcon, listIconNames } from '../components/Icon';
import { renderMarkdown as renderMarkdownHtml } from './markdown';
import * as utils from './obsidianUtils';

// ---- DOM helpers Obsidian adds to every element ------------------------------------------
type ElOpts = string | { cls?: string | string[]; text?: string | DocumentFragment; attr?: Record<string, string | number | boolean | null>; title?: string; parent?: Node; value?: string; type?: string; prepend?: boolean; placeholder?: string; href?: string };

function createElIn<K extends keyof HTMLElementTagNameMap>(parent: Node | null, tag: K, o?: ElOpts, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const opts: Exclude<ElOpts, string> = typeof o === 'string' ? { cls: o } : o ?? {};
  if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls;
  if (opts.text !== undefined) el.append(opts.text as any);
  if (opts.title) el.title = opts.title;
  if (opts.value !== undefined) (el as any).value = opts.value;
  if (opts.type) (el as any).type = opts.type;
  if (opts.placeholder) (el as any).placeholder = opts.placeholder;
  if (opts.href) (el as any).href = opts.href;
  for (const [k, v] of Object.entries(opts.attr ?? {})) if (v !== null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  const host = opts.parent ?? parent;
  if (host) (opts.prepend ? host.insertBefore(el, host.firstChild) : host.appendChild(el));
  cb?.(el);
  return el;
}

declare global {
  interface Node {
    empty(): void;
    setText(t: string | DocumentFragment): void;
    getText(): string;
    appendText(t: string): void;
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: ElOpts, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
    createDiv(o?: ElOpts, cb?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(o?: ElOpts, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement;
  }
  interface Element {
    addClass(...c: string[]): void;
    addClasses(c: string[]): void;
    removeClass(...c: string[]): void;
    removeClasses(c: string[]): void;
    toggleClass(c: string | string[], on: boolean): void;
    hasClass(c: string): boolean;
    setAttr(k: string, v: string | number | boolean | null): void;
    setAttrs(a: Record<string, string | number | boolean | null>): void;
    getAttr(k: string): string | null;
    find(s: string): Element | null;
    findAll(s: string): Element[];
  }
  interface HTMLElement { show(): void; hide(): void; isShown(): boolean }
  // eslint-disable-next-line no-var
  var activeDocument: Document;
  // eslint-disable-next-line no-var
  var activeWindow: Window;
}

let domInstalled = false;
function installDomHelpers() {
  if (domInstalled) return;
  domInstalled = true;
  const def = (proto: any, name: string, fn: Function) => {
    if (!(name in proto)) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
  };
  def(Node.prototype, 'empty', function (this: Node) { while (this.firstChild) this.removeChild(this.firstChild); });
  def(Node.prototype, 'setText', function (this: Node, t: string | DocumentFragment) { (this as any).empty(); this.appendChild(typeof t === 'string' ? document.createTextNode(t) : t); });
  def(Node.prototype, 'getText', function (this: Node) { return this.textContent ?? ''; });
  def(Node.prototype, 'appendText', function (this: Node, t: string) { this.appendChild(document.createTextNode(t)); });
  def(Node.prototype, 'createEl', function (this: Node, tag: any, o?: ElOpts, cb?: any) { return createElIn(this, tag, o, cb); });
  def(Node.prototype, 'createDiv', function (this: Node, o?: ElOpts, cb?: any) { return createElIn(this, 'div', o, cb); });
  def(Node.prototype, 'createSpan', function (this: Node, o?: ElOpts, cb?: any) { return createElIn(this, 'span', o, cb); });
  def(Element.prototype, 'addClass', function (this: Element, ...c: string[]) { this.classList.add(...c); });
  def(Element.prototype, 'addClasses', function (this: Element, c: string[]) { this.classList.add(...c); });
  def(Element.prototype, 'removeClass', function (this: Element, ...c: string[]) { this.classList.remove(...c); });
  def(Element.prototype, 'removeClasses', function (this: Element, c: string[]) { this.classList.remove(...c); });
  def(Element.prototype, 'toggleClass', function (this: Element, c: string | string[], on: boolean) { for (const x of ([] as string[]).concat(c)) this.classList.toggle(x, on); });
  def(Element.prototype, 'hasClass', function (this: Element, c: string) { return this.classList.contains(c); });
  def(Element.prototype, 'setAttr', function (this: Element, k: string, v: string | number | boolean | null) { v === null ? this.removeAttribute(k) : this.setAttribute(k, String(v)); });
  def(Element.prototype, 'setAttrs', function (this: Element, a: Record<string, any>) { for (const [k, v] of Object.entries(a)) (this as any).setAttr(k, v); });
  def(Element.prototype, 'getAttr', function (this: Element, k: string) { return this.getAttribute(k); });
  def(HTMLElement.prototype, 'show', function (this: HTMLElement) { this.style.display = ''; });
  def(HTMLElement.prototype, 'hide', function (this: HTMLElement) { this.style.display = 'none'; });
  def(HTMLElement.prototype, 'isShown', function (this: HTMLElement) { return this.style.display !== 'none'; });
  def(Element.prototype, 'find', function (this: Element, s: string) { return this.querySelector(s); });
  def(Element.prototype, 'findAll', function (this: Element, s: string) { return Array.from(this.querySelectorAll(s)); });
  const w = window as any;
  // Obsidian also exposes these as globals (plugins call createDiv(), createFragment(), sleep() …).
  w.createEl ??= (tag: any, o?: ElOpts, cb?: any) => createElIn(null, tag, o, cb);
  w.createDiv ??= (o?: ElOpts, cb?: any) => createElIn(null, 'div', o, cb);
  w.createSpan ??= (o?: ElOpts, cb?: any) => createElIn(null, 'span', o, cb);
  w.createSvg ??= (tag: string, o?: { cls?: string | string[]; attr?: Record<string, string> }, cb?: any) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (o?.cls) el.classList.add(...([] as string[]).concat(o.cls));
    for (const [k, v] of Object.entries(o?.attr ?? {})) el.setAttribute(k, v);
    cb?.(el); return el;
  };
  w.createFragment ??= (cb?: (f: DocumentFragment) => void) => { const f = document.createDocumentFragment(); cb?.(f); return f; };
  w.sleep ??= (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  w.nextFrame ??= () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  // Obsidian still exposes legacy CodeMirror 5 as a global; Dataview registers a highlight mode on it.
  w.CodeMirror ??= { defineMode() {}, defineMIME() {}, defineExtension() {}, registerHelper() {}, getMode: () => ({}), modes: {}, mimeModes: {}, commands: {} };
  w.activeDocument ??= document;
  w.activeWindow ??= window;
}
installDomHelpers();

// ---- Events / Component ---------------------------------------------------------------
export interface EventRef { emitter: Events; name: string; cb: Function }

export class Events {
  private handlers: Record<string, Function[]> = {};
  on(name: string, cb: Function, ctx?: unknown): EventRef {
    const fn = ctx ? cb.bind(ctx) : cb;
    (this.handlers[name] ??= []).push(fn);
    return { emitter: this, name, cb: fn };
  }
  off(name: string, cb: Function) { this.handlers[name] = (this.handlers[name] ?? []).filter((h) => h !== cb); }
  offref(ref: EventRef) { this.off(ref.name, ref.cb); }
  trigger(name: string, ...args: unknown[]) {
    for (const h of [...(this.handlers[name] ?? [])]) {
      try { h(...args); } catch (e) { console.warn(`[plugin] "${name}" handler failed:`, e); }
    }
  }
  tryTrigger(name: string, ...args: unknown[]) { this.trigger(name, ...args); }
}

export class Component {
  private _cleanups: (() => void)[] = [];
  private _children: Component[] = [];
  private _loaded = false;
  load() { if (this._loaded) return; this._loaded = true; this.onload?.(); }
  onload?(): void | Promise<void>;
  unload() {
    this._loaded = false;
    for (const c of this._children.splice(0)) c.unload();
    for (const f of this._cleanups.splice(0).reverse()) { try { f(); } catch (e) { console.warn('[plugin] cleanup failed:', e); } }
    this.onunload?.();
  }
  onunload?(): void;
  addChild<T extends Component>(c: T): T { this._children.push(c); c.load(); return c; }
  removeChild<T extends Component>(c: T): T { this._children = this._children.filter((x) => x !== c); c.unload(); return c; }
  register(cb: () => void) { this._cleanups.push(cb); }
  registerEvent(ref: EventRef) { this._cleanups.push(() => ref.emitter.offref(ref)); }
  registerDomEvent(el: EventTarget, type: string, cb: (ev: any) => any, opts?: boolean | AddEventListenerOptions) {
    el.addEventListener(type, cb, opts);
    this._cleanups.push(() => el.removeEventListener(type, cb, opts));
  }
  registerInterval(id: number) { this._cleanups.push(() => window.clearInterval(id)); return id; }
}

// ---- Files / vault / workspace ---------------------------------------------------------
let sharedVault: Vault | null = null;
export class TAbstractFile {
  get vault(): Vault { return (sharedVault ??= new Vault()); }
  constructor(public path: string, public name: string = path.split('/').pop() ?? path) {}
  get parent(): TFolder | null { const i = this.path.lastIndexOf('/'); return i < 0 ? null : new TFolder(this.path.slice(0, i)); }
}
export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  get basename() { return this.name.replace(/\.[^.]+$/, ''); }
  get extension() { return this.name.includes('.') ? this.name.split('.').pop()! : ''; }
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot() { return this.path === '' || this.path === '/'; }
}

function flattenFiles(): TFile[] {
  const out: TFile[] = [];
  const walk = (n: any) => {
    if (n.type === 'file') out.push(new TFile(n.path, n.name));
    n.children?.forEach(walk);
  };
  useStore.getState().tree?.children?.forEach(walk);
  return out;
}

const asFile = (f: TFile | string) => (typeof f === 'string' ? f : f.path);
const readText = async (path: string) => { const r: any = await api.read(path); return typeof r === 'string' ? r : r.content; };

function treeNode(path: string): any | null {
  const p = normalizePath(path);
  if (p === '') return useStore.getState().tree ?? null;
  let found: any = null;
  const walk = (n: any) => { if (found) return; if (n.path === p) { found = n; return; } n.children?.forEach(walk); };
  useStore.getState().tree?.children?.forEach(walk);
  return found;
}
/** `vault.adapter`: path-based file access (no real disk path exists — the vault may live in GitHub). */
export class DataAdapter {
  getName() { return 'WebObsidian'; }
  async exists(p: string, _sensitive?: boolean) { try { await api.read(p); return true; } catch { return treeNode(p) !== null; } }
  async read(p: string) { return readText(p); }
  async write(p: string, data: string) { await api.write(p, data); }
  async append(p: string, data: string) { let old = ''; try { old = await readText(p); } catch { /* new file */ } await api.write(p, old + data); }
  async process(p: string, fn: (d: string) => string) { const next = fn(await readText(p)); await api.write(p, next); return next; }
  async readBinary(p: string): Promise<ArrayBuffer> {
    const r = await fetch(api.rawUrl(p), { credentials: 'include' });
    if (!r.ok) throw new Error(`Cannot read ${p} (${r.status})`);
    return r.arrayBuffer();
  }
  async writeBinary(p: string, data: ArrayBuffer) {
    const i = p.lastIndexOf('/');
    await api.upload(new File([data], i < 0 ? p : p.slice(i + 1)), i < 0 ? '' : p.slice(0, i));
  }
  async mkdir(p: string) { await api.createFolder(normalizePath(p)); }
  async remove(p: string) { await api.remove(p); }
  async rmdir(p: string, _recursive?: boolean) { await api.remove(p); }
  async trashSystem(p: string) { await api.remove(p); return true; }
  async trashLocal(p: string) { await api.remove(p); }
  async rename(from: string, to: string) { await api.rename(from, to); }
  async copy(from: string, to: string) { await api.copy(from, to); }
  async list(p: string): Promise<{ files: string[]; folders: string[] }> {
    const n = treeNode(p);
    const kids: any[] = n?.children ?? [];
    return { files: kids.filter((k) => k.type === 'file').map((k) => k.path), folders: kids.filter((k) => k.type !== 'file').map((k) => k.path) };
  }
  async stat(p: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
    const n = treeNode(p);
    return n ? { type: n.type === 'file' ? 'file' : 'folder', ctime: n.ctime ?? 0, mtime: n.mtime ?? 0, size: n.size ?? 0 } : null;
  }
  getResourcePath(p: string) { return api.rawUrl(p); }
  getFullPath(p: string) { return p; }
  getBasePath() { return ''; }
}

export class Vault extends Events {
  adapter: DataAdapter = new DataAdapter();
  getName() { return 'WebObsidian'; }
  getRoot() { return new TFolder(''); }
  async read(file: TFile) { return readText(file.path); }
  async cachedRead(file: TFile) { return readText(file.path); }
  async modify(file: TFile, data: string) { await api.write(file.path, data); }
  async process(file: TFile, fn: (data: string) => string) { const next = fn(await readText(file.path)); await api.write(file.path, next); return next; }
  async append(file: TFile, data: string) { await api.write(file.path, (await readText(file.path)) + data); }
  async create(path: string, data: string) { await api.write(path, data); return new TFile(path); }
  async createFolder(path: string) { await api.createFolder(path); }
  async delete(file: TAbstractFile) { await api.remove(file.path); }
  async trash(file: TAbstractFile) { await api.remove(file.path); }
  getMarkdownFiles(): TFile[] { return flattenFiles().filter((f) => /\.(md|markdown)$/i.test(f.name)); }
  getFiles(): TFile[] { return flattenFiles(); }
  getAllLoadedFiles(): TAbstractFile[] { return flattenFiles(); }
  getAbstractFileByPath(path: string) { return flattenFiles().find((f) => f.path === path) ?? null; }
  getFileByPath(path: string) { const f = this.getAbstractFileByPath(path); return f instanceof TFile ? f : null; }
  configDir = '.obsidian';
  getAllFolders(includeRoot = false): TFolder[] {
    const out: TFolder[] = includeRoot ? [new TFolder('')] : [];
    const walk = (n: any) => { if (n.type === 'folder' || n.children) { if (n.path) out.push(new TFolder(n.path, n.name)); n.children?.forEach(walk); } };
    useStore.getState().tree?.children?.forEach(walk);
    return out;
  }
  getFolderByPath(path: string): TFolder | null {
    const p = normalizePath(path);
    return p === '' ? new TFolder('') : this.getAllFolders().find((f) => f.path === p) ?? null;
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const r = await fetch(api.rawUrl(file.path), { credentials: 'include' });
    if (!r.ok) throw new Error(`Cannot read ${file.path} (${r.status})`);
    return r.arrayBuffer();
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const i = path.lastIndexOf('/');
    const dir = i < 0 ? '' : path.slice(0, i);
    const name = i < 0 ? path : path.slice(i + 1);
    await api.upload(new File([data], name), dir);
    return new TFile(path);
  }
  async modifyBinary(file: TFile, data: ArrayBuffer) { await this.createBinary(file.path, data); }
  async appendBinary(file: TFile, data: ArrayBuffer) {
    const old = await this.readBinary(file);
    const merged = new Uint8Array(old.byteLength + data.byteLength);
    merged.set(new Uint8Array(old), 0); merged.set(new Uint8Array(data), old.byteLength);
    await this.createBinary(file.path, merged.buffer);
  }
  getResourcePath(file: TFile): string { return api.rawUrl(file.path); }
  async rename(file: TAbstractFile, newPath: string) { await api.rename(file.path, newPath); }
  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    await api.copy(file.path, newPath);
    return (file instanceof TFile ? new TFile(newPath) : new TFolder(newPath)) as unknown as T;
  }
  static recurseChildren(root: TAbstractFile, cb: (file: TAbstractFile) => any) {
    const walk = (f: TAbstractFile) => { cb(f); (f as TFolder).children?.forEach(walk); };
    walk(root);
  }
}

// ---- Editor (CodeMirror 6 under the hood) -----------------------------------------------
export interface EditorPosition { line: number; ch: number }

export class Editor {
  private get v() {
    const v = getActiveEditor();
    if (!v) throw new Error('No active editor');
    return v;
  }
  private off(p: EditorPosition): number {
    const doc = this.v.state.doc;
    const line = doc.line(Math.min(Math.max(p.line + 1, 1), doc.lines));
    return Math.min(line.from + p.ch, line.to);
  }
  private pos(o: number): EditorPosition {
    const l = this.v.state.doc.lineAt(o);
    return { line: l.number - 1, ch: o - l.from };
  }
  getDoc() { return this; }
  exec(command: string) {
    const v = this.v;
    const run: Record<string, () => unknown> = { undo: () => undo(v), redo: () => redo(v), indentMore: () => indentMore(v), indentLess: () => indentLess(v), goStart: () => cursorDocStart(v), goEnd: () => cursorDocEnd(v), selectAll: () => selectAll(v), deleteLine: () => deleteLine(v) };
    run[command]?.();
  }
  getValue() { return this.v.state.doc.toString(); }
  setValue(t: string) { this.v.dispatch({ changes: { from: 0, to: this.v.state.doc.length, insert: t } }); }
  getLine(n: number) { return this.v.state.doc.line(n + 1).text; }
  setLine(n: number, t: string) { const l = this.v.state.doc.line(n + 1); this.v.dispatch({ changes: { from: l.from, to: l.to, insert: t } }); }
  lineCount() { return this.v.state.doc.lines; }
  lastLine() { return this.v.state.doc.lines - 1; }
  getSelection() { const { from, to } = this.v.state.selection.main; return this.v.state.sliceDoc(from, to); }
  somethingSelected() { return !this.v.state.selection.main.empty; }
  replaceSelection(t: string) {
    const { from, to } = this.v.state.selection.main;
    this.v.dispatch({ changes: { from, to, insert: t }, selection: { anchor: from + t.length }, userEvent: 'input' });
  }
  getRange(from: EditorPosition, to: EditorPosition) { return this.v.state.sliceDoc(this.off(from), this.off(to)); }
  replaceRange(t: string, from: EditorPosition, to?: EditorPosition) {
    const a = this.off(from);
    this.v.dispatch({ changes: { from: a, to: to ? this.off(to) : a, insert: t }, userEvent: 'input' });
  }
  getCursor(which: 'from' | 'to' | 'head' | 'anchor' = 'head') {
    const s = this.v.state.selection.main;
    return this.pos(which === 'from' ? s.from : which === 'to' ? s.to : which === 'anchor' ? s.anchor : s.head);
  }
  setCursor(p: EditorPosition | number, ch?: number) {
    const pos = typeof p === 'number' ? { line: p, ch: ch ?? 0 } : p;
    this.v.dispatch({ selection: { anchor: this.off(pos) } });
  }
  setSelection(anchor: EditorPosition, head?: EditorPosition) {
    this.v.dispatch({ selection: { anchor: this.off(anchor), head: this.off(head ?? anchor) } });
  }
  listSelections() { const s = this.v.state.selection.main; return [{ anchor: this.pos(s.anchor), head: this.pos(s.head) }]; }
  offsetToPos(o: number) { return this.pos(o); }
  posToOffset(p: EditorPosition) { return this.off(p); }
  focus() { this.v.focus(); }
  blur() { (this.v.contentDOM as HTMLElement).blur(); }
  hasFocus() { return this.v.hasFocus; }
  refresh() { this.v.requestMeasure(); }
  scrollIntoView(range: { from: EditorPosition; to: EditorPosition }, center = false) {
    this.v.dispatch({ effects: EditorView.scrollIntoView(this.off(range.from), { y: center ? 'center' : 'nearest' }) });
  }
  scrollTo(x?: number | null, y?: number | null) {
    const sc = this.v.scrollDOM;
    if (typeof x === 'number') sc.scrollLeft = x;
    if (typeof y === 'number') sc.scrollTop = y;
  }
  getScrollInfo() { const sc = this.v.scrollDOM; return { top: sc.scrollTop, left: sc.scrollLeft, height: sc.scrollHeight, width: sc.scrollWidth, clientHeight: sc.clientHeight, clientWidth: sc.clientWidth }; }
  setSelections(ranges: { anchor: EditorPosition; head?: EditorPosition }[], main = 0) {
    if (!ranges.length) return;
    this.v.dispatch({ selection: EditorSelection.create(ranges.map((r) => EditorSelection.range(this.off(r.anchor), this.off(r.head ?? r.anchor))), main) });
  }
  undo() { undo(this.v); }
  redo() { redo(this.v); }
  wordAt(pos: EditorPosition): { from: EditorPosition; to: EditorPosition } | null {
    const w = this.v.state.wordAt(this.off(pos));
    return w ? { from: this.pos(w.from), to: this.pos(w.to) } : null;
  }
  transaction(tx: { changes?: { from: EditorPosition; to?: EditorPosition; text: string }[]; selection?: { from: EditorPosition; to?: EditorPosition } }) {
    this.v.dispatch({
      changes: tx.changes?.map((c) => ({ from: this.off(c.from), to: c.to ? this.off(c.to) : undefined, insert: c.text })),
      selection: tx.selection ? { anchor: this.off(tx.selection.from), head: this.off(tx.selection.to ?? tx.selection.from) } : undefined,
    });
  }
  processLines<T>(read: (line: number, lineText: string) => T | null, write: (from: EditorPosition, to: EditorPosition, text: string, value: T | null) => { from: EditorPosition; to: EditorPosition; text: string } | void, ignoreEmpty = false) {
    const doc = this.v.state.doc;
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let n = 1; n <= doc.lines; n++) {
      const l = doc.line(n);
      if (ignoreEmpty && l.text === '') continue;
      const value = read(n - 1, l.text);
      if (value === null) continue;
      const out = write({ line: n - 1, ch: 0 }, { line: n - 1, ch: l.text.length }, l.text, value);
      if (out) changes.push({ from: this.off(out.from), to: this.off(out.to), insert: out.text });
    }
    if (changes.length) this.v.dispatch({ changes });
  }
}

export class MarkdownView {
  get editor() { return new Editor(); }
  get file(): TFile | null { return sharedWorkspace.getActiveFile(); }
  getViewType() { return 'markdown'; }
  getMode() { return useStore.getState().viewMode === 'reading' ? 'preview' : 'source'; }
  getViewData() { return useStore.getState().content; }
  getDisplayText() { return this.file?.basename ?? ''; }
}
export class View extends Component {
  app: App = new App();
  containerEl: HTMLElement = document.createElement('div');
  icon = '';
  navigation = true;
  scope: Scope | null = null;
  constructor(public leaf: WorkspaceLeaf = new WorkspaceLeaf()) { super(); this.containerEl.className = 'view-container'; }
  getViewType(): string { return ''; }
  getDisplayText(): string { return ''; }
  getIcon(): string { return this.icon; }
  getState(): Record<string, unknown> { return {}; }
  async setState(_state: unknown, _result?: unknown): Promise<void> {}
  getEphemeralState(): Record<string, unknown> { return {}; }
  setEphemeralState(_state: unknown): void {}
  onOpen(): void | Promise<void> {}
  onClose(): void | Promise<void> {}
  onResize(): void {}
  onPaneMenu(_menu: Menu, _source: string): void {}
  addAction(icon: string, title: string, cb: (e: MouseEvent) => any): HTMLElement {
    const el = createElIn(null, 'a', { cls: 'view-action clickable-icon', attr: { 'aria-label': title } });
    el.innerHTML = iconSvg(icon, 16); el.addEventListener('click', cb as any); return el;
  }
  handleCopy(_e: ClipboardEvent) {}
  handleCut(_e: ClipboardEvent) {}
  handlePaste(_e: ClipboardEvent) {}
}
export class ItemView extends View {
  contentEl: HTMLElement;
  constructor(leaf?: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = this.containerEl.createDiv('view-content');
  }
  addAction(icon: string, title: string, cb: (e: MouseEvent) => any): HTMLElement { return super.addAction(icon, title, cb); }
}
export class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  navigation = true;
  getDisplayText(): string { return this.file?.basename ?? ''; }
  canAcceptExtension(_extension: string): boolean { return false; }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async onRename(_file: TFile): Promise<void> {}
}
export abstract class TextFileView extends FileView {
  data = '';
  lastSavedData: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  requestSave = () => {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.save(); }, 2000);
  };
  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;
  async onLoadFile(file: TFile) { this.data = await readText(file.path); this.lastSavedData = this.data; this.setViewData(this.data, true); }
  async onUnloadFile(_file: TFile) { await this.save(); this.clear(); }
  async save(_clear?: boolean) {
    if (!this.file) return;
    this.data = this.getViewData();
    if (this.data !== this.lastSavedData) { await api.write(this.file.path, this.data); this.lastSavedData = this.data; }
  }
}
export class EditableFileView extends FileView {}

export class WorkspaceItem extends Events {
  parent: WorkspaceParent | null = null;
  getRoot(): WorkspaceItem { return this; }
  getContainer(): WorkspaceItem { return this; }
}
export class WorkspaceParent extends WorkspaceItem { children: WorkspaceItem[] = []; }
export class WorkspaceSplit extends WorkspaceParent { direction: 'vertical' | 'horizontal' = 'vertical'; }
export class WorkspaceLeaf extends WorkspaceItem {
  view: View = new MarkdownViewShell();
  async openFile(f: TFile, _state?: unknown) { await useStore.getState().openFile(f.path); }
  async open(view: View) { this.view = view; return view; }
  async setViewState(_state: unknown, _eState?: unknown) {}
  getViewState(): { type: string; state?: unknown } { return { type: this.view.getViewType() }; }
  getDisplayText() { return this.view.getDisplayText(); }
  getIcon() { return this.view.getIcon(); }
  detach() {}
  setPinnedFlag(_p: boolean) {}
  isDeferred = false;
  async loadIfDeferred() {}
  setGroup(_g: string) {}
  setEphemeralState(_s: unknown) {}
  togglePinned() {}
}
class MarkdownViewShell extends ItemView { getViewType() { return 'markdown'; } }

export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) { super(); }
}
export const MarkdownRenderer = {
  async render(_app: App, markdown: string, el: HTMLElement, _sourcePath: string, _component: Component) {
    el.innerHTML = await renderMarkdownHtml(markdown, { rawUrl: (p: string) => api.rawUrl(p) });
  },
  async renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component) {
    return MarkdownRenderer.render(new App(), markdown, el, sourcePath, component);
  },
};

// ---- Settings groups & secrets --------------------------------------------------------------
export class SettingGroup {
  groupEl: HTMLElement;
  headerEl: HTMLElement;
  listEl: HTMLElement;
  constructor(public containerEl: HTMLElement) {
    this.groupEl = containerEl.createDiv('setting-group');
    this.headerEl = this.groupEl.createDiv('setting-item setting-item-heading');
    this.listEl = this.groupEl.createDiv('setting-items');
  }
  setHeading(heading: string | DocumentFragment) { this.headerEl.setText(heading as any); return this; }
  addClass(cls: string) { this.groupEl.classList.add(cls); return this; }
  addSetting(cb: (setting: Setting) => void) { cb(new Setting(this.listEl)); return this; }
  addSearch(cb: (c: SearchComponent) => any) { new Setting(this.listEl).addSearch(cb); return this; }
  addExtraButton(cb: (c: ExtraButtonComponent) => any) { new Setting(this.headerEl).addExtraButton(cb); return this; }
}
/** Secrets live in this browser's localStorage (never in the vault, so they are not synced to GitHub). */
export class SecretStorage {
  private key = (id: string) => `wo-secret:${id}`;
  getSecret(id: string): string | null { try { return localStorage.getItem(this.key(id)); } catch { return null; } }
  setSecret(id: string, secret: string): void { try { localStorage.setItem(this.key(id), secret); } catch { /* storage unavailable */ } }
  listSecrets(): string[] { try { return Object.keys(localStorage).filter((k) => k.startsWith('wo-secret:')).map((k) => k.slice(10)); } catch { return []; } }
}
// ---- Bases value types (minimal, so plugins that extend them load) ---------------------------
export class Value { static type = 'value'; isTruthy(): boolean { return true; } toString(): string { return ''; } equals(o: Value) { return this.toString() === o.toString(); } }
export class NullValue extends Value { static type = 'null'; isTruthy() { return false; } }
export class PrimitiveValue<T> extends Value { constructor(public value: T) { super(); } toString() { return String(this.value); } isTruthy() { return !!this.value; } }
export class StringValue extends PrimitiveValue<string> { static type = 'string'; }
export class NumberValue extends PrimitiveValue<number> { static type = 'number'; }
export class BooleanValue extends PrimitiveValue<boolean> { static type = 'boolean'; }
export class DateValue extends PrimitiveValue<Date> { static type = 'date'; }
export class ListValue extends Value { static type = 'list'; constructor(public value: Value[]) { super(); } isTruthy() { return this.value.length > 0; } toString() { return this.value.map(String).join(', '); } length() { return this.value.length; } get(i: number) { return this.value[i]; } }
export interface MarkdownFileInfo { file: TFile | null; editor?: Editor }

export class Workspace extends Events {
  getActiveFile(): TFile | null {
    const p = useStore.getState().activePath;
    return p && !p.startsWith('__') ? new TFile(p) : null;
  }
  get activeEditor() { return getActiveEditor() ? { editor: new Editor(), file: this.getActiveFile() } : null; }
  getActiveViewOfType<T>(type: new (...a: any[]) => T): T | null {
    if (isType(type, MarkdownView)) {
      return getActiveEditor() && useStore.getState().viewMode !== 'reading' ? (new MarkdownView() as unknown as T) : null;
    }
    return null;
  }
  getLeaf(_new?: boolean | string) {
    const leaf = new WorkspaceLeaf();
    leaf.view = new MarkdownView() as unknown as View;
    return leaf;
  }
  getRightLeaf(_split: boolean) { return this.getLeaf(); }
  getLeftLeaf(_split: boolean) { return this.getLeaf(); }
  ensureSideLeaf(_type: string, _side: string, _o?: unknown) { return Promise.resolve(this.getLeaf()); }
  revealLeaf(_leaf: WorkspaceLeaf) { return Promise.resolve(); }
  setActiveLeaf(_leaf: WorkspaceLeaf, _o?: unknown) {}
  getMostRecentLeaf() { return this.getLeaf(); }
  async openLinkText(link: string, _src?: string) { await useStore.getState().openFile(/\.[a-z0-9]+$/i.test(link) ? link : `${link}.md`); }
  onLayoutReady(cb: () => void) { cb(); }
  layoutReady = true;
  containerEl: HTMLElement = document.body;
  leftSplit = new WorkspaceSplit();
  rightSplit = new WorkspaceSplit();
  rootSplit = new WorkspaceSplit();
  updateOptions() {}
  requestSaveLayout() {}
  getLastOpenFiles(): string[] { return useStore.getState().tabs.map((t: any) => (typeof t === 'string' ? t : t.path)).filter(Boolean); }
  duplicateLeaf(leaf: WorkspaceLeaf) { return Promise.resolve(leaf); }
  getGroupLeaves(_g: string): WorkspaceLeaf[] { return []; }
  getLeafById(_id: string): WorkspaceLeaf | null { return null; }
  moveLeafToPopout(leaf: WorkspaceLeaf) { return leaf; }
  iterateAllLeaves(_cb: (l: unknown) => void) {}
  detachLeavesOfType(_t: string) {}
  getLeavesOfType(_t: string): unknown[] { return []; }
}
const sharedWorkspace = new Workspace();
useStore.subscribe((s, prev) => {
  if (s.activePath !== prev.activePath) {
    const f = sharedWorkspace.getActiveFile();
    sharedWorkspace.trigger('file-open', f);
    sharedWorkspace.trigger('active-leaf-change', null);
  }
});

export class App {
  vault = new Vault();
  workspace = sharedWorkspace;
  metadataCache = Object.assign(new Events(), { getFileCache: (_f: unknown) => null as unknown, getCache: (_p: string) => null as unknown, resolvedLinks: {} as Record<string, unknown>, unresolvedLinks: {} as Record<string, unknown>,
    getCachedFiles: (): string[] => flattenFiles().map((f) => f.path),
    /** Resolve `[[link]]` text to a file: exact path, then path + .md, then unique basename. */
    getFirstLinkpathDest: (linkpath: string, _sourcePath?: string): TFile | null => {
      const lp = normalizePath(utils.getLinkpath(linkpath));
      const files = flattenFiles();
      return files.find((f) => f.path === lp) ?? files.find((f) => f.path === `${lp}.md`)
        ?? files.find((f) => f.basename.toLowerCase() === lp.toLowerCase() || f.path.toLowerCase().endsWith(`/${lp.toLowerCase()}.md`)) ?? null;
    },
    fileToLinktext: (file: TFile, _sourcePath: string, omitMdExtension = true): string => (omitMdExtension ? file.path.replace(/\.md$/i, '') : file.path),
  });
  keymap = {};
  secretStorage = new SecretStorage();
  /** Plugin manager as seen by other plugins (`app.plugins.plugins[id]`, `getPlugin`). */
  plugins = { plugins: {} as Record<string, unknown>, enabledPlugins: new Set<string>(), manifests: {} as Record<string, unknown>, getPlugin(id: string): unknown { return this.plugins[id] ?? null; } };
  internalPlugins = { plugins: {} as Record<string, unknown>, getPluginById(_id: string): unknown { return null; }, getEnabledPluginById(_id: string): unknown { return null; } };
  commands = {
    commands: {} as Record<string, unknown>,
    listCommands: () => pluginHost.commands().map((c) => ({ id: c.id, name: c.name })),
    findCommand: (id: string) => pluginHost.commands().find((c) => c.id === id) ?? null,
    executeCommandById: (id: string) => { const c = pluginHost.commands().find((x) => x.id === id); if (c && c.available()) { c.run(); return true; } return false; },
  };
  hotkeyManager = { getHotkeys: (_id: string): unknown[] => [], getDefaultHotkeys: (_id: string): unknown[] => [], addDefaultHotkeys: (_id: string, _keys: unknown[]) => {}, removeDefaultHotkeys: (_id: string) => {}, setHotkeys: (_id: string, _keys: unknown[]) => {}, printHotkeyForCommand: (_id: string) => '' };
  scope = new Scope();
  lastEvent: UIEvent | null = null;
  setting = { open() {}, close() {}, openTabById(_id: string) {} };
  fileManager = new FileManager();
  get isDarkMode(): boolean { return document.documentElement.classList.contains('theme-dark') || document.body.classList.contains('theme-dark') || document.documentElement.dataset.theme === 'dark'; }
  loadLocalStorage(key: string): unknown {
    try { const v = localStorage.getItem(`wo-plugin:${key}`); return v === null ? null : JSON.parse(v); } catch { return null; }
  }
  saveLocalStorage(key: string, data: unknown | null): void {
    try { if (data === null || data === undefined) localStorage.removeItem(`wo-plugin:${key}`); else localStorage.setItem(`wo-plugin:${key}`, JSON.stringify(data)); } catch { /* storage unavailable */ }
  }
}

/** Minimal hotkey scope: plugins register handlers; modals/suggesters dispatch keydown to them. */
export class Scope {
  /** Registered handlers (Obsidian calls them `keys`; plugins inspect/unregister them). */
  keys: { modifiers: string[]; key: string | null; func: (e: KeyboardEvent, ctx: unknown) => any; scope?: Scope }[] = [];
  constructor(public parent?: Scope) {}
  register(modifiers: string[] | null, key: string | null, fn: (e: KeyboardEvent, ctx: unknown) => any) {
    const h = { modifiers: modifiers ?? [], key, func: fn, scope: this }; this.keys.push(h); return h;
  }
  unregister(h: unknown) { this.keys = this.keys.filter((x) => x !== h); }
  /** Returns true when a handler consumed the event. */
  handle(e: KeyboardEvent): boolean {
    for (const h of this.keys) {
      const want = new Set(h.modifiers.map((m) => (m === 'Mod' ? (Platform.isMacOS ? 'Meta' : 'Ctrl') : m)));
      const have = new Set<string>([e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]);
      if (want.size !== have.size || [...want].some((m) => !have.has(m))) continue;
      if (h.key !== null && h.key.toLowerCase() !== e.key.toLowerCase()) continue;
      if (h.func(e, {}) !== false) return true;
    }
    return this.parent?.handle(e) ?? false;
  }
}

export class FileManager {
  async renameFile(file: TAbstractFile, to: string) { await api.rename(file.path, to); }
  async trashFile(file: TAbstractFile) { await api.remove(file.path); }
  async promptForDeletion(file: TAbstractFile): Promise<boolean> {
    if (!window.confirm(`Delete "${file.name}"?`)) return false;
    await api.remove(file.path); return true;
  }
  getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
    const f = useStore.getState().activePath;
    const base = sourcePath || f || '';
    const i = base.lastIndexOf('/');
    return new TFolder(i < 0 ? '' : base.slice(0, i));
  }
  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string {
    const isMd = /\.md$/i.test(file.path);
    const target = isMd ? file.path.replace(/\.md$/i, '') : file.path;
    const bare = isMd && !flattenFiles().some((f) => f !== file && f.basename === file.basename);
    const link = `${bare ? file.basename : target}${subpath ?? ''}`;
    void sourcePath;
    return `${isMd ? '' : '!'}[[${link}${alias ? '|' + alias : ''}]]`;
  }
  async getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    const dir = sourcePath && sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    const dot = filename.lastIndexOf('.');
    const stem = dot < 0 ? filename : filename.slice(0, dot), ext = dot < 0 ? '' : filename.slice(dot);
    const taken = new Set(flattenFiles().map((f) => f.path));
    let candidate = normalizePath(`${dir}/${filename}`), n = 0;
    while (taken.has(candidate)) candidate = normalizePath(`${dir}/${stem} ${++n}${ext}`);
    return candidate;
  }
}

// ---- UI: Notice, Modal, Setting widgets ---------------------------------------------------
export class Notice {
  noticeEl: HTMLElement;
  get containerEl(): HTMLElement { return this.noticeEl; }
  get messageEl(): HTMLElement { return this.noticeEl; }
  constructor(message: string | DocumentFragment, timeout = 4000) {
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'toast notice';
    this.noticeEl.append(message as any);
    // Notices stack instead of covering each other.
    let box = document.querySelector('.notice-container');
    if (!box) { box = document.createElement('div'); box.className = 'notice-container'; document.body.appendChild(box); }
    box.appendChild(this.noticeEl);
    if (timeout > 0) setTimeout(() => this.hide(), timeout);
  }
  setMessage(m: string | DocumentFragment) { this.noticeEl.empty?.(); this.noticeEl.append(m as any); return this; }
  hide() { this.noticeEl.remove(); }
}

// Escape closes the most recently opened modal even when focus is elsewhere on the page.
const openModals: Modal[] = [];
document.addEventListener('keydown', (e) => {
  const top = openModals[openModals.length - 1];
  if (!top || e.key !== 'Escape' || e.defaultPrevented) return;
  if (top.scope.handle(e)) { e.preventDefault(); return; }
  top.close();
}, true);

export class Modal {
  containerEl = document.createElement('div');
  modalEl = document.createElement('div');
  titleEl = document.createElement('div');
  contentEl = document.createElement('div');
  scope = new Scope();
  shouldRestoreSelection = false;
  private closeCb: (() => void) | null = null;
  constructor(public app: App) {
    this.containerEl.className = 'modal-bg plugin-modal-container';
    this.modalEl.className = 'modal plugin-modal';
    this.titleEl.className = 'modal-title';
    this.contentEl.className = 'modal-content';
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    this.containerEl.addEventListener('mousedown', (e) => { if (e.target === this.containerEl) this.close(); });
    this.modalEl.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Escape' && this.scope.handle(e as KeyboardEvent)) e.preventDefault();
    });
  }
  setCloseCallback(cb: () => void) { this.closeCb = cb; return this; }
  onHistoryBack(): boolean { return false; }
  setTitle(t: string) { this.titleEl.setText(t); return this; }
  setContent(c: string | DocumentFragment) { this.contentEl.setText(c as any); return this; }
  open() {
    document.body.appendChild(this.containerEl);
    openModals.push(this);
    void this.onOpen();
  }
  close() { if (!this.containerEl.isConnected) return; const i = openModals.indexOf(this); if (i >= 0) openModals.splice(i, 1); this.containerEl.remove(); void this.onClose(); this.closeCb?.(); }
  onOpen(): void | Promise<void> {}
  onClose(): void | Promise<void> {}
}

export class BaseComponent {
  disabled = false;
  then(cb: (c: this) => any) { cb(this); return this; }
  setDisabled(d: boolean) { this.disabled = d; return this; }
}
export class ValueComponent<T> extends BaseComponent {
  protected cbs: ((v: T) => any)[] = [];
  protected fire(v: T) { this.cbs.forEach((c) => c(v)); }
  getValue(): T { throw new Error('not implemented'); }
  setValue(_v: T): this { return this; }
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string) {
    const prev = this.getValue();
    void prev; this.setValue(listeners[key]()); this.cbs.push((v) => listeners[key](v)); return this;
  }
}
export class DisplayValueComponent extends BaseComponent {
  el: HTMLElement;
  get valueEl() { return this.el; }
  constructor(public containerEl: HTMLElement) { super(); this.el = containerEl.createSpan('setting-item-display-value'); }
  setStatus(status: string | null) { this.el.dataset.status = status ?? ''; return this; }
  setValue(v: string) { this.el.setText(v); return this; }
  getValue() { return this.el.textContent ?? ''; }
}
export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
  constructor(public inputEl: T) { super(); inputEl.addEventListener('input', () => this.fire(inputEl.value)); }
  getValue() { return this.inputEl.value; }
  setValue(v: string) { this.inputEl.value = v; return this; }
  setPlaceholder(p: string) { this.inputEl.placeholder = p; return this; }
  setDisabled(d: boolean) { this.inputEl.disabled = d; this.disabled = d; return this; }
  onChange(cb: (v: string) => any) { this.cbs.push(cb); return this; }
  onChanged() { this.fire(this.inputEl.value); }
}
export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  clearButtonEl: HTMLElement;
  constructor(public containerEl: HTMLElement) {
    const wrap = containerEl.createDiv('search-input-container');
    super(wrap.createEl('input', { type: 'search' }));
    this.clearButtonEl = wrap.createDiv('search-input-clear-button');
    this.clearButtonEl.addEventListener('click', () => { this.setValue(''); this.fire(''); });
  }
}
export class ColorComponent extends ValueComponent<string> {
  colorPickerEl: HTMLInputElement;
  constructor(public containerEl: HTMLElement) { super(); this.colorPickerEl = containerEl.createEl('input', { type: 'color' }); this.colorPickerEl.addEventListener('input', () => this.fire(this.colorPickerEl.value)); }
  getValue() { return this.colorPickerEl.value; }
  setValue(v: string) { this.colorPickerEl.value = v; return this; }
  getValueRgb() { const h = this.colorPickerEl.value.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }
  getValueHsl() {
    const { r, g, b } = this.getValueRgb(); const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
    let h = 0, sat = 0;
    if (d) { sat = d / (1 - Math.abs(2 * l - 1)); h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4; h = (h * 60 + 360) % 360; }
    return { h: Math.round(h), s: Math.round(sat * 100), l: Math.round(l * 100) };
  }
  setValueHsl(c: { h: number; s: number; l: number }) {
    const s2 = c.s / 100, l2 = c.l / 100, k = (n: number) => (n + c.h / 30) % 12, a = s2 * Math.min(l2, 1 - l2);
    const f = (n: number) => l2 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return this.setValueRgb({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
  }
  setValueRgb(c: { r: number; g: number; b: number }) { const x = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); return this.setValue(`#${x(c.r)}${x(c.g)}${x(c.b)}`); }
  setDisabled(d: boolean) { this.colorPickerEl.disabled = d; this.disabled = d; return this; }
  onChange(cb: (v: string) => any) { this.cbs.push(cb); return this; }
}
export class ProgressBarComponent extends ValueComponent<number> {
  progressBar: HTMLProgressElement;
  constructor(public containerEl: HTMLElement) { super(); this.progressBar = containerEl.createEl('progress'); this.progressBar.max = 100; }
  getValue() { return this.progressBar.value; }
  setValue(v: number) { this.progressBar.value = v; return this; }
}
export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(public containerEl: HTMLElement) { super(containerEl.createEl('input', { type: 'text' })); }
}
export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(public containerEl: HTMLElement) { super(containerEl.createEl('textarea')); }
}
export class MomentFormatComponent extends TextComponent {
  sampleEl: HTMLElement;
  private fmt = 'YYYY-MM-DD';
  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.sampleEl = containerEl.createSpan('moment-format-sample');
    this.inputEl.addEventListener('input', () => this.updateSample());
  }
  setDefaultFormat(f: string) { this.fmt = f; this.setPlaceholder(f); this.updateSample(); return this; }
  setSampleEl(el: HTMLElement) { this.sampleEl = el; this.updateSample(); return this; }
  updateSample() { this.sampleEl.setText(moment().format(this.inputEl.value || this.fmt)); }
  setValue(v: string) { super.setValue(v); this.updateSample?.(); return this; }
}
export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLInputElement;
  constructor(public containerEl: HTMLElement) { super(); this.toggleEl = containerEl.createEl('input', { type: 'checkbox' }); this.toggleEl.addEventListener('change', () => this.fire(this.toggleEl.checked)); }
  getValue() { return this.toggleEl.checked; }
  setValue(v: boolean) { this.toggleEl.checked = v; return this; }
  setDisabled(d: boolean) { this.toggleEl.disabled = d; return this; }
  setTooltip(t: string) { this.toggleEl.title = t; return this; }
  onClick() { this.toggleEl.click(); }
  onChange(cb: (v: boolean) => any) { this.cbs.push(cb); return this; }
}
export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  constructor(public containerEl: HTMLElement) { super(); this.selectEl = containerEl.createEl('select'); this.selectEl.addEventListener('change', () => this.fire(this.selectEl.value)); }
  addOption(value: string, display: string) { this.selectEl.createEl('option', { value, text: display }); return this; }
  addOptions(o: Record<string, string>) { for (const [k, v] of Object.entries(o)) this.addOption(k, v); return this; }
  getValue() { return this.selectEl.value; }
  setValue(v: string) { this.selectEl.value = v; return this; }
  setDisabled(d: boolean) { this.selectEl.disabled = d; return this; }
  onChange(cb: (v: string) => any) { this.cbs.push(cb); return this; }
}
export class SliderComponent extends ValueComponent<number> {
  sliderEl: HTMLInputElement;
  constructor(public containerEl: HTMLElement) { super(); this.sliderEl = containerEl.createEl('input', { type: 'range' }); this.sliderEl.addEventListener('input', () => this.fire(Number(this.sliderEl.value))); }
  setLimits(min: number, max: number, step: number | 'any') { this.sliderEl.min = String(min); this.sliderEl.max = String(max); this.sliderEl.step = String(step); return this; }
  getValue() { return Number(this.sliderEl.value); }
  setValue(v: number) { this.sliderEl.value = String(v); return this; }
  private fmtFn: (v: number) => string = (v) => String(v);
  setInstant(instant: boolean) { this.sliderEl.dataset.instant = String(instant); return this; }
  getValuePretty() { return this.fmtFn(this.getValue()); }
  setDisplayFormat(fn: (v: number) => string) { this.fmtFn = fn; this.sliderEl.title = this.getValuePretty(); return this; }
  setDynamicTooltip() {
    const upd = () => { this.sliderEl.title = this.getValuePretty(); };
    this.sliderEl.addEventListener('input', upd); upd(); return this;
  }
  setDisabled(d: boolean) { this.sliderEl.disabled = d; return this; }
  onChange(cb: (v: number) => any) { this.cbs.push(cb); return this; }
}
export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  constructor(public containerEl: HTMLElement) { super(); this.buttonEl = containerEl.createEl('button'); }
  setButtonText(t: string) { this.buttonEl.setText(t); return this; }
  setCta() { this.buttonEl.classList.add('mod-cta'); return this; }
  setWarning() { this.buttonEl.classList.add('mod-warning'); return this; }
  removeCta() { this.buttonEl.classList.remove('mod-cta'); return this; }
  setDestructive() { this.buttonEl.classList.add('mod-destructive'); return this; }
  removeDestructive() { this.buttonEl.classList.remove('mod-destructive'); return this; }
  setDisabled(d: boolean) { this.buttonEl.disabled = d; return this; }
  setIcon(i: string) { this.buttonEl.innerHTML = iconSvg(i, 14); return this; }
  setTooltip(t: string) { this.buttonEl.title = t; return this; }
  setClass(c: string) { this.buttonEl.classList.add(c); return this; }
  onClick(cb: (e: MouseEvent) => any) { this.buttonEl.addEventListener('click', cb); return this; }
}
export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;
  constructor(public containerEl: HTMLElement) { super(); this.extraSettingsEl = containerEl.createEl('button', { cls: 'clickable-icon' }); }
  setIcon(i: string) { this.extraSettingsEl.innerHTML = iconSvg(i, 16); return this; }
  setTooltip(t: string) { this.extraSettingsEl.title = t; return this; }
  setDisabled(d: boolean) { (this.extraSettingsEl as HTMLButtonElement).disabled = d; return this; }
  onClick(cb: () => any) { this.extraSettingsEl.addEventListener('click', () => cb()); return this; }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  errorEl: HTMLElement | null = null;
  components: BaseComponent[] = [];
  constructor(public containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv('setting-item');
    this.infoEl = this.settingEl.createDiv('setting-item-info');
    this.nameEl = this.infoEl.createDiv('setting-item-name');
    this.descEl = this.infoEl.createDiv('setting-item-description');
    this.controlEl = this.settingEl.createDiv('setting-item-control');
  }
  setName(n: string | DocumentFragment) { this.nameEl.setText(n as any); return this; }
  setDesc(d: string | DocumentFragment) { this.descEl.setText(d as any); return this; }
  setClass(c: string) { this.settingEl.classList.add(c); return this; }
  setTooltip(t: string) { this.settingEl.title = t; return this; }
  setHeading() { this.settingEl.classList.add('setting-item-heading'); return this; }
  setDisabled(d: boolean) { this.settingEl.classList.toggle('is-disabled', d); return this; }
  private add<C extends BaseComponent>(c: C, cb?: (c: C) => any) { this.components.push(c); cb?.(c); return this; }
  addText(cb: (c: TextComponent) => any) { return this.add(new TextComponent(this.controlEl), cb); }
  addTextArea(cb: (c: TextAreaComponent) => any) { return this.add(new TextAreaComponent(this.controlEl), cb); }
  addToggle(cb: (c: ToggleComponent) => any) { return this.add(new ToggleComponent(this.controlEl), cb); }
  addDropdown(cb: (c: DropdownComponent) => any) { return this.add(new DropdownComponent(this.controlEl), cb); }
  addSlider(cb: (c: SliderComponent) => any) { return this.add(new SliderComponent(this.controlEl), cb); }
  addButton(cb: (c: ButtonComponent) => any) { return this.add(new ButtonComponent(this.controlEl), cb); }
  addExtraButton(cb: (c: ExtraButtonComponent) => any) { return this.add(new ExtraButtonComponent(this.controlEl), cb); }
  addSearch(cb: (c: SearchComponent) => any) { return this.add(new SearchComponent(this.controlEl), cb); }
  addColorPicker(cb: (c: ColorComponent) => any) { return this.add(new ColorComponent(this.controlEl), cb); }
  addProgressBar(cb: (c: ProgressBarComponent) => any) { return this.add(new ProgressBarComponent(this.controlEl), cb); }
  addMomentFormat(cb: (c: MomentFormatComponent) => any) { return this.add(new MomentFormatComponent(this.controlEl), cb); }
  addDisplayValue(cb: (c: DisplayValueComponent) => any) { return this.add(new DisplayValueComponent(this.controlEl), cb); }
  addComponent<C extends BaseComponent>(cb: (el: HTMLElement) => C) { return this.add(cb(this.controlEl)); }
  setErrorMessage(msg: string | DocumentFragment | null) {
    this.errorEl?.remove(); this.errorEl = null;
    this.settingEl.classList.toggle('has-error', !!msg);
    if (msg) { this.errorEl = this.infoEl.createDiv('setting-item-error'); this.errorEl.append(msg as any); }
    return this;
  }
  clear() { this.controlEl.empty(); this.components = []; return this; }
  then(cb: (s: Setting) => any) { cb(this); return this; }
}

export abstract class SettingPage {
  rootEl: HTMLElement = document.createElement('div');
  titlebarEl: HTMLElement = document.createElement('div');
  containerEl: HTMLElement = document.createElement('div');
  title = '';
  constructor() {
    this.rootEl.className = 'setting-page';
    this.titlebarEl.className = 'setting-page-titlebar';
    this.containerEl.className = 'setting-page-content';
    this.rootEl.append(this.titlebarEl, this.containerEl);
  }
  abstract display(): void;
  hide(): void {}
}
export abstract class SettingTab {
  icon = '';
  app!: App;
  containerEl: HTMLElement = document.createElement('div');
  settingItems: unknown[] = [];
  getSettingDefinitions(): unknown[] { return []; }
  update(): void { this.settingItems = this.getSettingDefinitions(); }
  getControlValue(_key: string): unknown { return undefined; }
  setControlValue(_key: string, _value: unknown): void | Promise<void> {}
  abstract display(): void;
  hide(): void {}
}
export class PluginSettingTab extends SettingTab {
  constructor(public app: App, public plugin: Plugin) { super(); this.containerEl.className = 'vertical-tab-content'; }
  display(): void {}
}

// ---- Plugin -------------------------------------------------------------------------------
export interface Command {
  id: string;
  name: string;
  icon?: string;
  hotkeys?: unknown[];
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => any;
  editorCheckCallback?: (checking: boolean, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => boolean | void;
}

export interface DataBackend { load(id: string): Promise<unknown>; save(id: string, data: unknown): Promise<void> }
let dataBackend: DataBackend | null = null;
export const setPluginDataBackend = (b: DataBackend) => { dataBackend = b; };

export class Plugin extends Component {
  constructor(public app: App, public manifest: { id: string; name: string; [k: string]: unknown }) { super(); }
  private pid() { return this.manifest.id; }
  addCommand(cmd: Command): Command {
    const editorOk = () => !!getActiveEditor() && useStore.getState().viewMode !== 'reading';
    const ctx = () => new MarkdownView();
    pluginHost.addCommand({
      id: `${this.pid()}:${cmd.id}`,
      pluginId: this.pid(),
      name: `${this.manifest.name}: ${cmd.name}`,
      available: () => {
        try {
          if (cmd.editorCheckCallback) return editorOk() && cmd.editorCheckCallback(true, new Editor(), ctx()) !== false;
          if (cmd.editorCallback) return editorOk();
          if (cmd.checkCallback) return cmd.checkCallback(true) !== false;
        } catch { return false; }
        return true;
      },
      run: () => {
        try {
          if (cmd.editorCheckCallback) cmd.editorCheckCallback(false, new Editor(), ctx());
          else if (cmd.editorCallback) cmd.editorCallback(new Editor(), ctx());
          else if (cmd.checkCallback) cmd.checkCallback(false);
          else cmd.callback?.();
        } catch (e) {
          console.warn(`[plugin] command ${cmd.id} failed:`, e);
          useStore.getState().notify(`${this.manifest.name}: command failed — ${(e as Error).message}`);
        }
      },
    });
    return cmd;
  }
  removeCommand(id: string) { pluginHost.removeCommand(`${this.pid()}:${id}`); }
  onUserEnable(): void {}
  onExternalSettingsChange(): void | Promise<void> {}
  addRibbonIcon(icon: string, title: string, cb: (e: MouseEvent) => any): HTMLElement {
    const el = document.createElement('div');
    el.className = 'clickable-icon side-dock-ribbon-action';
    el.innerHTML = iconSvg(icon, 18);
    const id = `${this.pid()}:${title}:${Math.random()}`;
    pluginHost.addRibbon({ id, pluginId: this.pid(), icon, title, onClick: (e) => { try { cb(e); } catch (err) { console.warn(`[plugin] ribbon action failed:`, err); } } });
    return el;
  }
  addStatusBarItem(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'status-bar-item plugin-status-item';
    pluginHost.addStatus(`${this.pid()}:${Math.random()}`, this.pid(), el);
    return el;
  }
  addSettingTab(tab: PluginSettingTab) { pluginHost.addTab(this.pid(), this.manifest.name, tab); }
  async loadData(): Promise<any> { return dataBackend ? dataBackend.load(this.pid()) : null; }
  async saveData(data: unknown): Promise<void> { await dataBackend?.save(this.pid(), data); }
  registerMarkdownPostProcessor(fn: any, sortOrder?: number) { const f = typeof fn === 'function' ? fn : () => {}; f.sortOrder = sortOrder; return f; }
  registerMarkdownCodeBlockProcessor(_lang: string, fn: any, sortOrder?: number) { const f = (typeof fn === 'function' ? fn : () => {}) as any; f.sortOrder = sortOrder; return f; }
  registerEditorExtension(_ext: unknown) {}
  registerEditorSuggest(_s: unknown) {}
  registerBasesView(_id: string, _reg: unknown) {}
  registerCliHandler(_id: string, _d: string, _f: unknown, _h: unknown) {}
  registerView(_type: string, _creator: unknown) {}
  registerExtensions(_exts: string[], _viewType: string) {}
  registerObsidianProtocolHandler(_action: string, _handler: unknown) {}
  registerHoverLinkSource(_id: string, _info: unknown) {}
  /** Remove everything this plugin attached (commands, ribbon, status bar, settings tab, listeners, timers). */
  teardown() { this.unload(); pluginHost.removePlugin(this.pid()); }
}

// ---- Small utilities ------------------------------------------------------------------------
export const Platform = { isDesktop: true, isMobile: false, isDesktopApp: false, isMobileApp: false, isIosApp: false, isAndroidApp: false, isPhone: false, isTablet: false, isMacOS: /Mac/.test(navigator.platform), isWin: /Win/.test(navigator.platform), isLinux: /Linux/.test(navigator.platform), isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent) };

export function debounce<T extends (...a: any[]) => any>(cb: T, timeout = 0, resetTimer = false) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const fn = (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = undefined; cb(...args); }, timeout);
    return fn;
  };
  (fn as any).cancel = () => { if (t) clearTimeout(t); t = undefined; return fn; };
  (fn as any).run = () => { if (t) { clearTimeout(t); t = undefined; } };
  return fn as unknown as T & { cancel(): void };
}

export async function requestUrl(req: string | { url: string; method?: string; headers?: Record<string, string>; body?: string; contentType?: string }) {
  const r = typeof req === 'string' ? { url: req } : req;
  const res = await fetch(r.url, { method: (r as any).method, headers: { ...(r as any).headers, ...((r as any).contentType ? { 'Content-Type': (r as any).contentType } : {}) }, body: (r as any).body });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), arrayBuffer: buf, text, get json() { return JSON.parse(text); } };
}

export function setIcon(el: HTMLElement, name: string) { el.innerHTML = iconSvg(name, 16); }
export const getIcon = (name: string): SVGSVGElement | null => { const t = document.createElement('div'); t.innerHTML = iconSvg(name, 16); return t.firstElementChild as SVGSVGElement | null; };
export const addIcon = (name: string, svg: string) => { registerCustomIcon(name, svg); };
export const removeIcon = (name: string) => { unregisterCustomIcon(name); };
export async function request(req: string | { url: string; method?: string; headers?: Record<string, string>; body?: string; contentType?: string }): Promise<string> { return (await requestUrl(req)).text; }
export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
  const root: Node = typeof html === 'string' ? new DOMParser().parseFromString(html, 'text/html').body : html;
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').replace(/\s+/g, ' ');
    if (!(n instanceof Element)) return Array.from(n.childNodes).map(walk).join('');
    const inner = () => Array.from(n.childNodes).map(walk).join('');
    const tag = n.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner().trim()}\n\n`;
    switch (tag) {
      case 'p': case 'div': return `\n\n${inner().trim()}\n\n`;
      case 'br': return '\n';
      case 'strong': case 'b': return `**${inner()}**`;
      case 'em': case 'i': return `*${inner()}*`;
      case 'code': return n.parentElement?.tagName === 'PRE' ? inner() : `\`${inner()}\``;
      case 'pre': return `\n\n\`\`\`\n${n.textContent ?? ''}\n\`\`\`\n\n`;
      case 'a': return `[${inner()}](${n.getAttribute('href') ?? ''})`;
      case 'img': return `![${n.getAttribute('alt') ?? ''}](${n.getAttribute('src') ?? ''})`;
      case 'li': return `\n${n.parentElement?.tagName === 'OL' ? '1.' : '-'} ${inner().trim()}`;
      case 'ul': case 'ol': return `\n${inner()}\n`;
      case 'blockquote': return `\n\n> ${inner().trim().replace(/\n/g, '\n> ')}\n\n`;
      case 'hr': return '\n\n---\n\n';
      case 'script': case 'style': return '';
      default: return inner();
    }
  };
  return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}
export const getAllTags = (cache: { tags?: { tag: string }[]; frontmatter?: Record<string, unknown> } | null): string[] | null => {
  if (!cache) return null;
  const out = new Set<string>((cache.tags ?? []).map((t) => t.tag));
  for (const t of utils.parseFrontMatterTags(cache.frontmatter ?? null) ?? []) out.add(t);
  return [...out];
};
export const getIconIds = (): string[] => listIconNames();
export const resolveSubpath = (_cache: unknown, _subpath: string): null => null;
export async function loadPdfJs(): Promise<never> { throw new Error('PDF rendering is not available in WebObsidian'); }
export const getLanguage = (): string => (document.documentElement.lang || navigator.language || 'en').split('-')[0].toLowerCase();
export async function loadMermaid(): Promise<any> { return (await import('mermaid')).default; }

// ---- tooltips (one shared bubble, shown on hover / focus) ----------------------------------
let tipEl: HTMLElement | null = null;
export function displayTooltip(el: HTMLElement | { x: number; y: number }, content: string | DocumentFragment, options?: { placement?: 'top' | 'bottom' | 'left' | 'right'; delay?: number; classes?: string[] }) {
  hideTooltip();
  const tip = (tipEl = document.createElement('div'));
  tip.className = ['tooltip', ...(options?.classes ?? [])].join(' ');
  tip.append(content as any);
  tip.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;';
  document.body.appendChild(tip);
  const r = el instanceof HTMLElement ? el.getBoundingClientRect() : new DOMRect(el.x, el.y, 0, 0);
  const t = tip.getBoundingClientRect(), pl = options?.placement ?? 'bottom';
  let x = r.left + r.width / 2 - t.width / 2, y = pl === 'top' ? r.top - t.height - 6 : r.bottom + 6;
  if (pl === 'left') { x = r.left - t.width - 6; y = r.top + r.height / 2 - t.height / 2; }
  if (pl === 'right') { x = r.right + 6; y = r.top + r.height / 2 - t.height / 2; }
  tip.style.left = `${Math.max(4, Math.min(x, window.innerWidth - t.width - 4))}px`;
  tip.style.top = `${Math.max(4, Math.min(y, window.innerHeight - t.height - 4))}px`;
}
const hideTooltip = () => { tipEl?.remove(); tipEl = null; };
export function setTooltip(el: HTMLElement, tooltip: string, options?: { placement?: 'top' | 'bottom' | 'left' | 'right'; delay?: number; classes?: string[] }) {
  el.setAttribute('aria-label', tooltip);
  const w = el as HTMLElement & { __woTip?: { show: () => void } };
  if (w.__woTip) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = () => { timer = setTimeout(() => displayTooltip(el, el.getAttribute('aria-label') ?? '', options), options?.delay ?? 300); };
  const hide = () => { if (timer) clearTimeout(timer); hideTooltip(); };
  el.addEventListener('mouseenter', show); el.addEventListener('mouseleave', hide); el.addEventListener('click', hide);
  w.__woTip = { show };
}
export const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
/** Subset of moment.js format tokens (YYYY MM DD HH mm ss, month/day names, A/a, [escaped]). */
function formatDate(d: Date, fmt: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const h12 = d.getHours() % 12 || 12;
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()), YY: p(d.getFullYear() % 100), MMMM: months[d.getMonth()], MMM: months[d.getMonth()].slice(0, 3),
    MM: p(d.getMonth() + 1), M: String(d.getMonth() + 1), DD: p(d.getDate()), D: String(d.getDate()),
    dddd: days[d.getDay()], ddd: days[d.getDay()].slice(0, 3), d: String(d.getDay()),
    HH: p(d.getHours()), H: String(d.getHours()), hh: p(h12), h: String(h12),
    mm: p(d.getMinutes()), m: String(d.getMinutes()), ss: p(d.getSeconds()), s: String(d.getSeconds()),
    A: d.getHours() < 12 ? 'AM' : 'PM', a: d.getHours() < 12 ? 'am' : 'pm',
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|d|HH|H|hh|h|mm|m|ss|s|A|a/g, (m, esc) => (esc !== undefined ? esc : map[m] ?? m));
}
export const moment: any = (d?: any) => {
  const date = d ? new Date(d) : new Date();
  return { format: (f?: string) => (f === undefined ? date.toISOString() : formatDate(date, f)), valueOf: () => date.valueOf(), toDate: () => date, isValid: () => !isNaN(date.valueOf()) };
};
export const sanitizeHTMLToDom = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.content; };

export class MenuItem {
  title: string | DocumentFragment = '';
  icon = '';
  checked: boolean | null = false;
  disabled = false;
  warning = false;
  isLabel = false;
  section = '';
  submenu: Menu | null = null;
  cb: ((e: MouseEvent | KeyboardEvent) => any) | null = null;
  setTitle(t: string | DocumentFragment) { this.title = t; return this; }
  setIcon(i: string | null) { this.icon = i ?? ''; return this; }
  setChecked(c: boolean | null) { this.checked = c; return this; }
  setDisabled(d: boolean) { this.disabled = d; return this; }
  setWarning(w: boolean) { this.warning = w; return this; }
  setIsLabel(l: boolean) { this.isLabel = l; return this; }
  setSection(s: string) { this.section = s; return this; }
  onClick(cb: (e: MouseEvent | KeyboardEvent) => any) { this.cb = cb; return this; }
  setSubmenu(): Menu { return (this.submenu = new Menu()); }
}
export class MenuSeparator {}

export class Menu extends Component {
  private items: (MenuItem | MenuSeparator)[] = [];
  private hideCb: (() => void) | null = null;
  addItem(cb: (i: MenuItem) => any) { const it = new MenuItem(); cb(it); this.items.push(it); return this; }
  addSeparator() { this.items.push(new MenuSeparator()); return this; }
  setNoIcon() { return this; }
  setUseNativeMenu(_native: boolean) { return this; }
  setParentElement(_el: HTMLElement | null) { return this; }
  onHide(cb: () => any) { this.hideCb = cb; }
  onHistoryBack(): boolean { return false; }
  hide() { useStore.getState().closeContextMenu(); this.hideCb?.(); return this; }
  close() { this.hide(); }
  private build(items = this.items): ContextMenuItem[] {
    // Items are grouped by `section`: a separator is drawn between different sections.
    const out: ContextMenuItem[] = [];
    let prev: string | null = null;
    for (const it of items) {
      if (it instanceof MenuSeparator) { out.push({ label: '', separator: true }); prev = null; continue; }
      if (prev !== null && it.section !== prev && out.length) out.push({ label: '', separator: true });
      prev = it.section;
      const label = typeof it.title === 'string' ? it.title : it.title.textContent ?? '';
      out.push({
        label: it.checked ? `✓ ${label}` : label,
        icon: it.icon || undefined,
        danger: it.warning,
        submenu: it.submenu ? this.build(it.submenu.items) : undefined,
        onClick: it.disabled || it.isLabel ? undefined : () => it.cb?.(new MouseEvent('click')),
      });
    }
    return out;
  }
  showAtMouseEvent(e: MouseEvent) { useStore.getState().openContextMenu({ x: e.clientX, y: e.clientY, items: this.build() }); return this; }
  showAtPosition(p: { x: number; y: number }) { useStore.getState().openContextMenu({ x: p.x, y: p.y, items: this.build() }); return this; }
  static forEvent(evt: MouseEvent): Menu { void evt; return new Menu(); }
}

// ---- Suggesters ------------------------------------------------------------------------------
/** Shared list logic: keyboard navigation + rendering of suggestions into `listEl`. */
abstract class SuggestList<T> {
  protected suggestions: T[] = [];
  protected selected = 0;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
  protected paint(listEl: HTMLElement) {
    listEl.empty();
    this.suggestions.forEach((v, i) => {
      const el = listEl.createDiv('suggestion-item');
      el.classList.toggle('is-selected', i === this.selected);
      this.renderSuggestion(v, el);
      el.addEventListener('mousedown', (e) => { e.preventDefault(); this.selectSuggestion(v, e); });
      el.addEventListener('mousemove', () => { if (this.selected !== i) { this.selected = i; this.paint(listEl); } });
    });
    listEl.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }
  protected onKey(e: KeyboardEvent, listEl: HTMLElement): boolean {
    if (!this.suggestions.length) return false;
    if (e.key === 'ArrowDown') this.selected = (this.selected + 1) % this.suggestions.length;
    else if (e.key === 'ArrowUp') this.selected = (this.selected - 1 + this.suggestions.length) % this.suggestions.length;
    else if (e.key === 'Enter') { this.selectSuggestion(this.suggestions[this.selected], e); return true; }
    else return false;
    this.paint(listEl);
    return true;
  }
}

export class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  limit = 100;
  emptyStateText = 'No results found.';
  private list: SuggestList<T>;
  constructor(app: App) {
    super(app);
    this.modalEl.classList.add('prompt');
    this.titleEl.remove();
    this.inputEl = this.modalEl.createEl('input', { cls: 'prompt-input', type: 'text' });
    this.resultContainerEl = this.modalEl.createDiv('prompt-results');
    this.contentEl.remove();
    const self = this;
    this.list = new (class extends SuggestList<T> {
      renderSuggestion(v: T, el: HTMLElement) { self.renderSuggestion(v, el); }
      selectSuggestion(v: T, e: MouseEvent | KeyboardEvent) { self.choose(v, e); }
      async refresh() {
        const q = self.inputEl.value;
        const got = await self.getSuggestions(q);
        this.suggestions = got.slice(0, self.limit);
        this.selected = 0;
        if (!this.suggestions.length) { self.resultContainerEl.empty(); self.resultContainerEl.createDiv({ cls: 'prompt-empty', text: self.emptyStateText }); self.onNoSuggestion(); }
        else this.paint(self.resultContainerEl);
      }
      key(e: KeyboardEvent) { return this.onKey(e, self.resultContainerEl); }
      selectActive(e: MouseEvent | KeyboardEvent) { const v = this.suggestions[this.selected]; if (v !== undefined) this.selectSuggestion(v, e); }
    })();
    this.inputEl.addEventListener('input', () => void (this.list as any).refresh());
    this.inputEl.addEventListener('keydown', (e) => { if ((this.list as any).key(e)) { e.preventDefault(); e.stopPropagation(); } });
  }
  setPlaceholder(p: string) { this.inputEl.placeholder = p; }
  setInstructions(_i: { command: string; purpose: string }[]) {}
  open() { super.open(); this.inputEl.focus(); void (this.list as any).refresh(); }
  getSuggestions(_query: string): T[] | Promise<T[]> { return []; }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  onNoSuggestion(): void {}
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent) { this.choose(value, evt); }
  selectActiveSuggestion(evt: MouseEvent | KeyboardEvent) { (this.list as any).selectActive(evt); }
  private choose(v: T, e: MouseEvent | KeyboardEvent) { this.close(); this.onChooseSuggestion(v, e); }
}

export interface FuzzyMatch<T> { item: T; match: utils.SearchResult }
export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
  getSuggestions(query: string): FuzzyMatch<T>[] {
    const items = this.getItems();
    if (!query.trim()) return items.map((item) => ({ item, match: { score: 0, matches: [] } }));
    const fuzzy = utils.prepareFuzzySearch(query);
    const out: FuzzyMatch<T>[] = [];
    for (const item of items) { const m = fuzzy(this.getItemText(item)); if (m) out.push({ item, match: m }); }
    return out.sort((a, b) => b.match.score - a.match.score);
  }
  renderSuggestion(v: FuzzyMatch<T>, el: HTMLElement) { utils.renderResults(el, this.getItemText(v.item), v.match); }
  onChooseSuggestion(v: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent) { this.onChooseItem(v.item, evt); }
}

export class PopoverSuggest<T> extends SuggestList<T> {
  isOpen = false;
  scope = new Scope();
  protected listEl = document.createElement('div');
  constructor(public app: App, scope?: Scope) {
    super();
    if (scope) this.scope = scope;
    // Obsidian's suggest popovers ship a default Escape handler (plugins patch its `func`).
    if (!this.scope.keys.length) this.scope.register([], 'Escape', () => { this.close(); return false; });
    this.listEl.className = 'suggestion-container suggestion';
    this.listEl.style.cssText = 'position:fixed;z-index:10000;';
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}
  onHistoryBack(): boolean { return false; }
  open() { this.isOpen = true; if (!this.listEl.isConnected) document.body.appendChild(this.listEl); }
  close() { this.isOpen = false; this.listEl.remove(); }
  setSuggestions(values: T[]) { this.suggestions = values; this.selected = 0; this.paint(this.listEl); }
  handleKey(e: KeyboardEvent) { return this.isOpen && this.onKey(e, this.listEl); }
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  constructor(app: App, public textInputEl: HTMLInputElement | HTMLDivElement) {
    super(app);
    const run = async () => {
      const all = await this.getSuggestions(this.getValue());
      const list = all.slice(0, this.limit);
      if (!list.length) return this.close();
      const r = textInputEl.getBoundingClientRect();
      this.listEl.style.left = `${r.left}px`; this.listEl.style.top = `${r.bottom + 2}px`; this.listEl.style.minWidth = `${r.width}px`;
      this.open(); this.setSuggestions(list);
    };
    textInputEl.addEventListener('input', () => void run());
    textInputEl.addEventListener('focus', () => void run());
    textInputEl.addEventListener('blur', () => setTimeout(() => this.close(), 100));
    textInputEl.addEventListener('keydown', (e) => { if (this.handleKey(e as KeyboardEvent)) { e.preventDefault(); e.stopPropagation(); } else if ((e as KeyboardEvent).key === 'Escape') this.close(); });
  }
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  getValue(): string { return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : this.textInputEl.textContent ?? ''; }
  setValue(v: string) { if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = v; else this.textInputEl.textContent = v; }
  onSelect(cb: (value: T, evt: MouseEvent | KeyboardEvent) => any) { this.onSelectCb = cb; return this; }
  private onSelectCb: ((value: T, evt: MouseEvent | KeyboardEvent) => any) | null = null;
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent) { this.onSelectCb?.(value, evt); }
}

// ---- Editor suggest (autocomplete popups driven by the editor) -----------------------------
export interface EditorSuggestContext { editor: Editor; file: TFile | null; start: EditorPosition; end: EditorPosition; query: string }
export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  context: EditorSuggestContext | null = null;
  limit = 100;
  constructor(app: App) { super(app); }
  setInstructions(_i: { command: string; purpose: string }[]) {}
  abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): { start: EditorPosition; end: EditorPosition; query: string } | null;
  abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;
}

export class SecretComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;
  constructor(public app: App, public containerEl: HTMLElement) {
    super();
    this.inputEl = containerEl.createEl('input', { type: 'password' });
    this.inputEl.addEventListener('input', () => this.fire(this.inputEl.value));
  }
  getValue() { return this.inputEl.value; }
  setValue(v: string) { this.inputEl.value = v; return this; }
  onChange(cb: (v: string) => any) { this.cbs.push(cb); return this; }
}

/**
 * Older plugins are compiled to ES5, where a subclass calls its base as a plain function
 * (`Plugin.apply(this, arguments)`). ES6 classes refuse that, so every class we export is
 * wrapped in a Proxy whose call form constructs an instance with the caller's prototype and
 * returns it — which is exactly what the ES5 `_super.apply(this, …) || this` idiom expects.
 * `new` and `class X extends Base` keep working unchanged.
 */
const originals = new Set<unknown>();
function callable<T extends Function>(cls: T): T {
  originals.add(cls);
  return new Proxy(cls, {
    apply(target, thisArg, args) {
      // `thisArg` was created by `new Sub()`, so its constructor is Sub: construct with it as new.target
      // and the result gets Sub's prototype chain.
      const sub = thisArg && typeof thisArg === 'object' && typeof thisArg.constructor === 'function' ? thisArg.constructor : target;
      return Reflect.construct(target, args, sub);
    },
  });
}
/** True when `type` is `cls` or its callable wrapper (plugins pass the wrapper back to us). */
const isType = (type: unknown, cls: unknown) => type === cls || (typeof type === 'function' && originals.has(cls) && (type as any).prototype === (cls as any).prototype);

const rawModule = {
  App, Plugin, Component, Notice, TFile, TFolder, TAbstractFile, Vault, Workspace, Events,
  PluginSettingTab, Modal, Setting, Menu, Editor, MarkdownView, ItemView,
  TextComponent, TextAreaComponent, ToggleComponent, DropdownComponent, SliderComponent, ButtonComponent, ExtraButtonComponent,
  Platform, debounce, requestUrl, setIcon, getIcon, addIcon, removeIcon, normalizePath, moment, sanitizeHTMLToDom,
  request, htmlToMarkdown, getAllTags, getIconIds, resolveSubpath, loadPdfJs,
  View, FileView, TextFileView, EditableFileView, WorkspaceItem, WorkspaceParent, WorkspaceSplit, WorkspaceLeaf,
  MarkdownRenderChild, MarkdownRenderer, EditorSuggest, SettingGroup, SecretStorage, SecretComponent,
  SettingPage, SettingTab,
  Value, NullValue, StringValue, NumberValue, BooleanValue, DateValue, ListValue,
  getLanguage, loadMermaid, setTooltip, displayTooltip, FileManager, Scope, MenuItem, MenuSeparator,
  SuggestModal, FuzzySuggestModal, PopoverSuggest, AbstractInputSuggest,
  BaseComponent, ValueComponent, DisplayValueComponent, AbstractTextComponent, SearchComponent, ColorComponent, ProgressBarComponent, MomentFormatComponent,
  ...utils, apiVersion: utils.API_VERSION,
};

export const obsidianModule: Record<string, unknown> = Object.fromEntries(
  Object.entries(rawModule).map(([k, v]) => [k, typeof v === 'function' && /^class\b/.test(Function.prototype.toString.call(v)) ? callable(v as Function) : v]),
);
