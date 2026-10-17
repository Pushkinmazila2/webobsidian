/**
 * Link hovering: fires the workspace `hover-link` event (what plugins listen to) for internal links in the
 * editor (needs Ctrl/Cmd, like Obsidian's Page preview) and in Reading view, and — if no plugin showed its own
 * popover — falls back to a built-in page preview of the linked note.
 */
import { api } from './api';
import { useStore } from './store';
import { renderMarkdown } from './markdown';
import { runPluginProcessors } from './markdownProcessing';
import { getSharedApp, HoverPopover, type HoverParent } from './obsidianApi';

const LINK_SEL = 'a.internal-link, .cm-hmd-internal-link, .cm-wikilink';
const parents = new WeakMap<HTMLElement, HoverParent>();
let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function linkTextOf(el: HTMLElement): string {
  return el.getAttribute('data-href') ?? el.getAttribute('data-wikilink') ?? (el.textContent ?? '');
}

async function previewInto(popover: HoverPopover, linkText: string) {
  const target = linkText.split('|')[0].trim();
  if (!target || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return false;
  const { path } = await api.resolve(target.split('#')[0]).catch(() => ({ path: null }));
  if (!path || !/\.(md|markdown)$/i.test(path)) return false;
  const r: any = await api.read(path);
  const text: string = typeof r === 'string' ? r : r.content;
  const html = await renderMarkdown(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''), { rawUrl: (p) => api.rawUrl(p) });
  const card = popover.hoverEl;
  card.classList.add('popover-preview', 'markdown-embed');
  const body = card.createDiv({ cls: 'markdown-embed-content markdown-preview' });
  body.innerHTML = html; // sanitized by the renderer
  const kids: { unload(): void }[] = [];
  runPluginProcessors(body, path, text, kids);
  popover.register(() => kids.forEach((k) => k.unload()));
  return true;
}

export function installHoverLinks() {
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.(LINK_SEL) as HTMLElement | null;
    if (!el || el === current) return;
    current = el;
    clearTimeout(timer);
    const inEditor = !!el.closest('.cm-editor');
    const source = inEditor ? 'editor' : 'preview';
    const mod = e.ctrlKey || e.metaKey;
    if (inEditor && !mod) return; // Page preview requires Mod in the editor
    timer = setTimeout(() => {
      if (current !== el || !el.isConnected) return;
      const app = getSharedApp();
      const hoverParent = parents.get(el) ?? { hoverPopover: null };
      parents.set(el, hoverParent);
      const linkText = linkTextOf(el);
      const sourcePath = useStore.getState().activePath ?? '';
      app.workspace.trigger('hover-link', { event: e, source, hoverParent, targetEl: el, linkText, sourcePath });
      if (hoverParent.hoverPopover) return; // a plugin handled it
      const pop = new HoverPopover(hoverParent, el, 600000);
      void previewInto(pop, linkText).then((ok) => { if (ok) pop.show(); else pop.hide(); }).catch(() => pop.hide());
    }, 250);
  });
  document.addEventListener('mouseout', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.(LINK_SEL);
    if (el && el === current) { current = null; clearTimeout(timer); }
  });
}
