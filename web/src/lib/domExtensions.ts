/**
 * Obsidian extends the browser's built-ins (Array.first, Node.detach, HTMLElement.on, createSvg …) and
 * plugins rely on them without importing anything. Everything here is added only when the property
 * does not exist already, so a native implementation always wins.
 */
type Dict = Record<string, any>;

function def(proto: object, name: string, fn: unknown) {
  if (!(name in proto)) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
}

interface Listener { type: string; selector: string; listener: Function; wrapped: EventListener; options?: boolean | AddEventListenerOptions }
const delegated = new WeakMap<EventTarget, Listener[]>();

function addDelegated(el: Node, type: string, selector: string, listener: Function, options?: boolean | AddEventListenerOptions) {
  const wrapped: EventListener = (ev) => {
    const t = ev.target as Element | null;
    const hit = t && 'closest' in t ? (t.closest(selector) as Element | null) : null;
    if (hit && (el as Element).contains(hit)) listener.call(hit, ev, hit);
  };
  el.addEventListener(type, wrapped, options);
  const l = delegated.get(el) ?? [];
  l.push({ type, selector, listener, wrapped, options });
  delegated.set(el, l);
}
function removeDelegated(el: Node, type: string, selector: string, listener: Function, options?: boolean | EventListenerOptions) {
  const l = delegated.get(el) ?? [];
  const i = l.findIndex((x) => x.type === type && x.selector === selector && x.listener === listener);
  if (i < 0) return;
  el.removeEventListener(type, l[i].wrapped, options ?? l[i].options);
  l.splice(i, 1);
}

function applyStyles(el: ElementCSSInlineStyle, styles: Dict) {
  for (const [k, v] of Object.entries(styles)) (el.style as unknown as Dict)[k] = v;
}
function applyProps(el: ElementCSSInlineStyle, props: Dict) {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
}

export function installDomExtensions() {
  const w = window as unknown as Dict;

  // ---- built-in types ----
  def(Object, 'isEmpty', (o: Dict) => Object.keys(o).length === 0);
  def(Object, 'each', (o: Dict, cb: (v: any, k: string) => boolean | void) => { for (const k of Object.keys(o)) if (cb(o[k], k) === false) return false; return true; });
  def(Array, 'combine', (arrays: any[][]) => ([] as any[]).concat(...arrays));
  def(Array.prototype, 'first', function (this: any[]) { return this[0]; });
  def(Array.prototype, 'last', function (this: any[]) { return this[this.length - 1]; });
  def(Array.prototype, 'contains', function (this: any[], t: any) { return this.includes(t); });
  def(Array.prototype, 'remove', function (this: any[], t: any) { const i = this.indexOf(t); if (i >= 0) this.splice(i, 1); });
  def(Array.prototype, 'shuffle', function (this: any[]) { for (let i = this.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this[i], this[j]] = [this[j], this[i]]; } return this; });
  def(Array.prototype, 'unique', function (this: any[]) { return [...new Set(this)]; });
  def(Array.prototype, 'findLastIndex', function (this: any[], p: (v: any) => boolean) { for (let i = this.length - 1; i >= 0; i--) if (p(this[i])) return i; return -1; });
  def(Math, 'clamp', (v: number, min: number, max: number) => Math.min(Math.max(v, min), max));
  def(Math, 'square', (v: number) => v * v);
  def(String, 'isString', (o: unknown) => typeof o === 'string');
  def(String.prototype, 'contains', function (this: string, t: string) { return this.includes(t); });
  def(String.prototype, 'format', function (this: string, ...args: string[]) { return this.replace(/\{(\d+)\}/g, (m, i) => args[Number(i)] ?? m); });
  def(Number, 'isNumber', (o: unknown) => typeof o === 'number');

  // ---- DOM: Node / Element / HTMLElement ----
  def(Node.prototype, 'detach', function (this: Node) { this.parentNode?.removeChild(this); });
  def(Node.prototype, 'insertAfter', function (this: Node, node: Node, child: Node | null) { return this.insertBefore(node, child ? child.nextSibling : this.firstChild); });
  def(Node.prototype, 'indexOf', function (this: Node, other: Node) { return Array.prototype.indexOf.call(this.childNodes, other); });
  def(Node.prototype, 'setChildrenInPlace', function (this: Node, children: Node[]) {
    // Keep matching nodes, only touch what changed (keeps focus/scroll in re-rendered lists).
    let cur = this.firstChild;
    for (const c of children) {
      if (cur === c) { cur = cur.nextSibling; continue; }
      this.insertBefore(c, cur);
    }
    while (cur) { const next = cur.nextSibling; this.removeChild(cur); cur = next; }
  });
  // `el.win` / `el.doc`: the window and document an element lives in (popout-window aware plugins use them; here always the one window).
  for (const [k, get] of [['win', function (this: Node) { return this.ownerDocument?.defaultView ?? window; }], ['doc', function (this: Node) { return this.ownerDocument ?? document; }]] as const) {
    if (!(k in Node.prototype)) Object.defineProperty(Node.prototype, k, { get, configurable: true });
  }
  def(Node.prototype, 'instanceOf', function (this: Node, type: { new (...a: any[]): any }) { return this instanceof type; });
  def(Node.prototype, 'createSvg', function (this: Node, tag: string, o?: any, cb?: any) {
    const info = typeof o === 'string' ? { cls: o } : o ?? {};
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (info.cls) el.classList.add(...([] as string[]).concat(info.cls));
    for (const [k, v] of Object.entries(info.attr ?? {})) el.setAttribute(k, String(v));
    this.appendChild(el);
    cb?.(el);
    return el;
  });
  def(Element.prototype, 'matchParent', function (this: Element, selector: string, lastParent?: Element) {
    let e: Element | null = this.parentElement;
    while (e) { if (e.matches(selector)) return e; if (e === lastParent) return null; e = e.parentElement; }
    return null;
  });
  def(Element.prototype, 'getCssPropertyValue', function (this: Element, prop: string, pseudo?: string) { return getComputedStyle(this, pseudo).getPropertyValue(prop).trim(); });
  def(Element.prototype, 'isActiveElement', function (this: Element) { return this.ownerDocument.activeElement === this; });
  def(Element.prototype, 'findAllSelf', function (this: Element, selector: string) { return [...(this.matches(selector) ? [this] : []), ...this.querySelectorAll(selector)]; });
  def(DocumentFragment.prototype, 'find', function (this: DocumentFragment, s: string) { return this.querySelector(s); });
  def(DocumentFragment.prototype, 'findAll', function (this: DocumentFragment, s: string) { return Array.from(this.querySelectorAll(s)); });
  def(HTMLElement.prototype, 'toggle', function (this: HTMLElement, show: boolean) { this.style.display = show ? '' : 'none'; });
  def(HTMLElement.prototype, 'toggleVisibility', function (this: HTMLElement, visible: boolean) { this.style.visibility = visible ? '' : 'hidden'; });
  def(HTMLElement.prototype, 'setCssStyles', function (this: HTMLElement, s: Dict) { applyStyles(this, s); });
  def(HTMLElement.prototype, 'setCssProps', function (this: HTMLElement, p: Dict) { applyProps(this, p); });
  def(SVGElement.prototype, 'setCssStyles', function (this: SVGElement, s: Dict) { applyStyles(this, s); });
  def(SVGElement.prototype, 'setCssProps', function (this: SVGElement, p: Dict) { applyProps(this, p); });
  for (const proto of [HTMLElement.prototype, Document.prototype] as Node[]) {
    def(proto, 'on', function (this: Node, type: string, selector: string, listener: Function, options?: any) { addDelegated(this, type, selector, listener, options); });
    def(proto, 'off', function (this: Node, type: string, selector: string, listener: Function, options?: any) { removeDelegated(this, type, selector, listener, options); });
  }
  def(HTMLElement.prototype, 'onClickEvent', function (this: HTMLElement, listener: (e: MouseEvent) => any, options?: any) {
    this.addEventListener('click', listener as EventListener, options);
    this.addEventListener('auxclick', listener as EventListener, options);
  });
  def(HTMLElement.prototype, 'onNodeInserted', function (this: HTMLElement, listener: () => any, once = false) {
    let obs: MutationObserver | null = null;
    const fire = () => { listener(); if (once) stop(); };
    const stop = () => { obs?.disconnect(); obs = null; };
    if (this.isConnected) queueMicrotask(fire);
    obs = new MutationObserver(() => { if (this.isConnected) fire(); });
    obs.observe(document, { childList: true, subtree: true });
    return stop;
  });
  def(HTMLElement.prototype, 'onWindowMigrated', function (this: HTMLElement, _listener: (win: Window) => any) { return () => {}; });
  def(HTMLElement.prototype, 'trigger', function (this: HTMLElement, type: string) { this.dispatchEvent(new Event(type, { bubbles: true })); });
  // Obsidian adds `event.targetNode` (the event target typed as a Node); Kanban, Tasks & co. read it in click handlers.
  // `event.win` / `event.doc`: the window/document the event happened in.
  if (!('win' in Event.prototype)) Object.defineProperty(Event.prototype, 'win', { get(this: Event) { return (this.target as Node | null)?.ownerDocument?.defaultView ?? window; }, configurable: true });
  if (!('doc' in Event.prototype)) Object.defineProperty(Event.prototype, 'doc', { get(this: Event) { return (this.target as Node | null)?.ownerDocument ?? document; }, configurable: true });
  if (!('targetNode' in Event.prototype)) Object.defineProperty(Event.prototype, 'targetNode', { get(this: Event) { return this.target as Node | null; }, configurable: true });
  def(UIEvent.prototype, 'instanceOf', function (this: UIEvent, type: { new (...a: any[]): any }) { return this instanceof type; });

  // ---- globals ----
  w.isBoolean ??= (o: unknown) => typeof o === 'boolean';
  w.fish ??= (selector: string) => document.querySelector(selector);
  w.fishAll ??= (selector: string) => Array.from(document.querySelectorAll(selector));
  w.ready ??= (fn: () => any) => { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', () => fn(), { once: true }); };
  w.ajaxPromise ??= async (o: { url: string; method?: string; headers?: Record<string, string>; data?: any; contentType?: string; req?: any }) => {
    const res = await fetch(o.url, { method: o.method ?? 'GET', headers: { ...(o.headers ?? {}), ...(o.contentType ? { 'Content-Type': o.contentType } : {}) }, body: o.data });
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText}`), { status: res.status });
    return res.text();
  };
  w.ajax ??= (o: { success?: (d: any) => any; error?: (e: any) => any } & Dict) => {
    w.ajaxPromise(o).then((d: any) => o.success?.(d), (e: any) => o.error?.(e));
  };
}
