/**
 * The `obsidian` module for community plugins running in the browser (PRD FR-8).
 *
 * Plugins are written against Obsidian's API; this implements the commonly used subset on top
 * of WebObsidian: commands, ribbon, status bar, settings tabs, modals, notices, setting widgets,
 * DOM helpers (`createEl`, `setText`, …), a CodeMirror-backed Editor, vault access and events.
 * Anything not implemented is a no-op or throws a clear error — the loader reports it per plugin.
 */
import { api } from './api';
import { useStore } from './store';
import { getActiveEditor } from './activeEditor';
import { pluginHost } from './pluginHost';
import { iconSvg } from '../components/Icon';

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
export class TAbstractFile {
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

export class Vault extends Events {
  adapter = {
    exists: async (p: string) => { try { await api.read(p); return true; } catch { return false; } },
    read: (p: string) => readText(p),
    write: (p: string, data: string) => api.write(p, data),
    getName: () => 'WebObsidian',
  };
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
  getFileByPath(path: string) { return this.getAbstractFileByPath(path); }
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
  blur() {}
  hasFocus() { return this.v.hasFocus; }
  refresh() {}
  scrollIntoView() {}
  getScrollInfo() { return { top: 0, left: 0 }; }
}

export class MarkdownView {
  get editor() { return new Editor(); }
  get file(): TFile | null { return sharedWorkspace.getActiveFile(); }
  getViewType() { return 'markdown'; }
  getMode() { return useStore.getState().viewMode === 'reading' ? 'preview' : 'source'; }
  getViewData() { return useStore.getState().content; }
  getDisplayText() { return this.file?.basename ?? ''; }
}
export class ItemView extends Component { constructor(public leaf?: unknown) { super(); } getViewType() { return ''; } getDisplayText() { return ''; } }
export interface MarkdownFileInfo { file: TFile | null; editor?: Editor }

export class Workspace extends Events {
  getActiveFile(): TFile | null {
    const p = useStore.getState().activePath;
    return p && !p.startsWith('__') ? new TFile(p) : null;
  }
  get activeEditor() { return getActiveEditor() ? { editor: new Editor(), file: this.getActiveFile() } : null; }
  getActiveViewOfType<T>(type: new (...a: any[]) => T): T | null {
    if (type === (MarkdownView as any)) {
      return getActiveEditor() && useStore.getState().viewMode !== 'reading' ? (new MarkdownView() as unknown as T) : null;
    }
    return null;
  }
  getLeaf(_new?: boolean | string) {
    return { openFile: async (f: TFile) => { await useStore.getState().openFile(f.path); }, view: new MarkdownView() };
  }
  getMostRecentLeaf() { return this.getLeaf(); }
  async openLinkText(link: string, _src?: string) { await useStore.getState().openFile(/\.[a-z0-9]+$/i.test(link) ? link : `${link}.md`); }
  onLayoutReady(cb: () => void) { cb(); }
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
  metadataCache = Object.assign(new Events(), { getFileCache: (_f: unknown) => null as unknown, getCache: (_p: string) => null as unknown, resolvedLinks: {} as Record<string, unknown> });
  keymap = {};
  setting = { open() {}, close() {}, openTabById(_id: string) {} };
  fileManager = {
    async renameFile(file: TAbstractFile, to: string) { await api.rename(file.path, to); },
    async trashFile(file: TAbstractFile) { await api.remove(file.path); },
  };
}

// ---- UI: Notice, Modal, Setting widgets ---------------------------------------------------
export class Notice {
  noticeEl: HTMLElement;
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

export class Modal {
  containerEl = document.createElement('div');
  modalEl = document.createElement('div');
  titleEl = document.createElement('div');
  contentEl = document.createElement('div');
  constructor(public app: App) {
    this.containerEl.className = 'modal-bg plugin-modal-container';
    this.modalEl.className = 'modal plugin-modal';
    this.titleEl.className = 'modal-title';
    this.contentEl.className = 'modal-content';
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    this.containerEl.addEventListener('mousedown', (e) => { if (e.target === this.containerEl) this.close(); });
    this.modalEl.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') this.close(); });
  }
  setTitle(t: string) { this.titleEl.setText(t); return this; }
  setContent(c: string | DocumentFragment) { this.contentEl.setText(c as any); return this; }
  open() { document.body.appendChild(this.containerEl); void this.onOpen(); }
  close() { if (!this.containerEl.isConnected) return; this.containerEl.remove(); void this.onClose(); }
  onOpen(): void | Promise<void> {}
  onClose(): void | Promise<void> {}
}

class ValueComponent<T> {
  protected cbs: ((v: T) => any)[] = [];
  protected fire(v: T) { this.cbs.forEach((c) => c(v)); }
  disabled = false;
}
export class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;
  constructor(public containerEl: HTMLElement) { super(); this.inputEl = containerEl.createEl('input', { type: 'text' }); this.inputEl.addEventListener('input', () => this.fire(this.inputEl.value)); }
  getValue() { return this.inputEl.value; }
  setValue(v: string) { this.inputEl.value = v; return this; }
  setPlaceholder(p: string) { this.inputEl.placeholder = p; return this; }
  setDisabled(d: boolean) { this.inputEl.disabled = d; return this; }
  onChange(cb: (v: string) => any) { this.cbs.push(cb); return this; }
}
export class TextAreaComponent extends ValueComponent<string> {
  inputEl: HTMLTextAreaElement;
  constructor(public containerEl: HTMLElement) { super(); this.inputEl = containerEl.createEl('textarea'); this.inputEl.addEventListener('input', () => this.fire(this.inputEl.value)); }
  getValue() { return this.inputEl.value; }
  setValue(v: string) { this.inputEl.value = v; return this; }
  setPlaceholder(p: string) { this.inputEl.placeholder = p; return this; }
  setDisabled(d: boolean) { this.inputEl.disabled = d; return this; }
  onChange(cb: (v: string) => any) { this.cbs.push(cb); return this; }
}
export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLInputElement;
  constructor(public containerEl: HTMLElement) { super(); this.toggleEl = containerEl.createEl('input', { type: 'checkbox' }); this.toggleEl.addEventListener('change', () => this.fire(this.toggleEl.checked)); }
  getValue() { return this.toggleEl.checked; }
  setValue(v: boolean) { this.toggleEl.checked = v; return this; }
  setDisabled(d: boolean) { this.toggleEl.disabled = d; return this; }
  setTooltip(t: string) { this.toggleEl.title = t; return this; }
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
  setDynamicTooltip() { return this; }
  setDisabled(d: boolean) { this.sliderEl.disabled = d; return this; }
  onChange(cb: (v: number) => any) { this.cbs.push(cb); return this; }
}
export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  constructor(public containerEl: HTMLElement) { this.buttonEl = containerEl.createEl('button'); }
  setButtonText(t: string) { this.buttonEl.setText(t); return this; }
  setCta() { this.buttonEl.classList.add('mod-cta'); return this; }
  setWarning() { this.buttonEl.classList.add('mod-warning'); return this; }
  setDisabled(d: boolean) { this.buttonEl.disabled = d; return this; }
  setIcon(i: string) { this.buttonEl.innerHTML = iconSvg(i, 14); return this; }
  setTooltip(t: string) { this.buttonEl.title = t; return this; }
  setClass(c: string) { this.buttonEl.classList.add(c); return this; }
  onClick(cb: (e: MouseEvent) => any) { this.buttonEl.addEventListener('click', cb); return this; }
}
export class ExtraButtonComponent {
  extraSettingsEl: HTMLElement;
  constructor(public containerEl: HTMLElement) { this.extraSettingsEl = containerEl.createEl('button', { cls: 'clickable-icon' }); }
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
  addText(cb: (c: TextComponent) => any) { cb(new TextComponent(this.controlEl)); return this; }
  addTextArea(cb: (c: TextAreaComponent) => any) { cb(new TextAreaComponent(this.controlEl)); return this; }
  addToggle(cb: (c: ToggleComponent) => any) { cb(new ToggleComponent(this.controlEl)); return this; }
  addDropdown(cb: (c: DropdownComponent) => any) { cb(new DropdownComponent(this.controlEl)); return this; }
  addSlider(cb: (c: SliderComponent) => any) { cb(new SliderComponent(this.controlEl)); return this; }
  addButton(cb: (c: ButtonComponent) => any) { cb(new ButtonComponent(this.controlEl)); return this; }
  addExtraButton(cb: (c: ExtraButtonComponent) => any) { cb(new ExtraButtonComponent(this.controlEl)); return this; }
  then(cb: (s: Setting) => any) { cb(this); return this; }
}

export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: App, public plugin: Plugin) { this.containerEl.className = 'vertical-tab-content'; }
  display(): void {}
  hide(): void {}
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
  removeCommand(_id: string) {}
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
  registerMarkdownPostProcessor(_fn: unknown) {}
  registerMarkdownCodeBlockProcessor(_lang: string, _fn: unknown) {}
  registerEditorExtension(_ext: unknown) {}
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
export const addIcon = (_name: string, _svg: string) => {};
export const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
export const moment: any = (d?: any) => {
  const date = d ? new Date(d) : new Date();
  return { format: (_f?: string) => date.toISOString(), valueOf: () => date.valueOf(), toDate: () => date, isValid: () => !isNaN(date.valueOf()) };
};
export const sanitizeHTMLToDom = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.content; };
export const parseYaml = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };

export class Menu {
  private items: { title?: string; cb?: () => void }[] = [];
  addItem(cb: (i: any) => any) { const it: any = { title: '', setTitle(t: string) { it.title = t; return it; }, setIcon() { return it; }, onClick(f: () => void) { it.cb = f; return it; }, setSection() { return it; } }; cb(it); this.items.push(it); return this; }
  addSeparator() { return this; }
  showAtMouseEvent(e: MouseEvent) {
    useStore.getState().openContextMenu({ x: e.clientX, y: e.clientY, items: this.items.map((i) => ({ label: i.title ?? '', onClick: i.cb })) });
  }
  showAtPosition(p: { x: number; y: number }) {
    useStore.getState().openContextMenu({ x: p.x, y: p.y, items: this.items.map((i) => ({ label: i.title ?? '', onClick: i.cb })) });
  }
}

export const obsidianModule = {
  App, Plugin, Component, Notice, TFile, TFolder, TAbstractFile, Vault, Workspace, Events,
  PluginSettingTab, Modal, Setting, Menu, Editor, MarkdownView, ItemView,
  TextComponent, TextAreaComponent, ToggleComponent, DropdownComponent, SliderComponent, ButtonComponent, ExtraButtonComponent,
  Platform, debounce, requestUrl, setIcon, addIcon, normalizePath, moment, sanitizeHTMLToDom, parseYaml,
};
