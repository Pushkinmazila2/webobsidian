/**
 * Post-processing of rendered Markdown shared by the Reading view and `MarkdownRenderer.render`:
 * built-in Bases embeds, plugin code-block processors, then plugin post-processors.
 */
import { pluginHost, type PostProcessorCtx } from './pluginHost';
import { getFrontMatterInfo, parseYaml } from './obsidianUtils';

/** `![[x.base]]` / `![[x.base#View]]` */
export const BASE_EMBED_RE = /\.base(#.*)?$/i;

export function runPluginProcessors(root: HTMLElement, sourcePath: string, content: string, children: { unload(): void }[]) {
  let frontmatter: Record<string, unknown> | undefined;
  try {
    const fm = getFrontMatterInfo(content);
    if (fm.exists) frontmatter = parseYaml(fm.frontmatter) ?? undefined;
  } catch { /* malformed front matter: processors just get none */ }
  const ctx: PostProcessorCtx = {
    sourcePath, frontmatter, docId: sourcePath, containerEl: root,
    addChild: (c) => { children.push(c); try { c.load(); } catch (e) { console.warn('[plugin] child load failed', e); } },
    getSectionInfo: () => null,
  };
  const fail = (el: HTMLElement, e: unknown) => {
    console.warn('[plugin] markdown processor failed:', e);
    el.createDiv?.({ cls: 'markdown-error', text: `Plugin error: ${(e as Error)?.message ?? e}` });
  };
  const call = (el: HTMLElement, fn: () => unknown) => {
    try { const r = fn(); if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => fail(el, e)); } catch (e) { fail(el, e); }
  };
  const mountBase = (el: HTMLElement, o: { path?: string; source?: string; viewName?: string }) => {
    const render = pluginHost.baseEmbedRenderer();
    if (!render) return false;
    children.push({ unload: render(el, { ...o, thisPath: sourcePath }) });
    return true;
  };
  // Bases: ![[x.base]] embeds (left as links by the renderer) and ```base blocks
  for (const a of root.querySelectorAll<HTMLElement>('a.internal-link.embed[data-wikilink]')) {
    const target = a.getAttribute('data-wikilink') ?? '';
    if (!BASE_EMBED_RE.test(target)) continue;
    const [file, ...view] = target.split('#');
    const el = document.createElement('div');
    el.className = 'internal-embed bases-embed';
    a.replaceWith(el);
    mountBase(el, { path: file, viewName: view.join('#') || undefined });
  }
  for (const codeEl of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const lang = [...codeEl.classList].find((c) => c.startsWith('language-'))?.slice(9);
    if (!lang) continue;
    const proc = pluginHost.codeBlockProcessor(lang);
    const source = (codeEl.textContent ?? '').replace(/\n$/, '');
    if (!proc && lang !== 'base') continue;
    const pre = codeEl.parentElement!;
    const el = document.createElement('div');
    el.className = `block-language-${lang}`;
    if (!proc) { pre.replaceWith(el); if (!mountBase(el, { source })) el.replaceWith(pre); continue; }
    pre.replaceWith(el);
    call(el, () => proc.fn(source, el, ctx));
  }
  for (const pp of pluginHost.postProcessors()) call(root, () => pp.fn(root, ctx));
}
