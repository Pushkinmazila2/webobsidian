import { Notice, requestUrl } from './obsidianApi';
import { getSharedApp } from './obsidianApi';

/**
 * Excalidraw's "Browse libraries" opens libraries.excalidraw.com with `referrer=app://obsidian.md` (the desktop app). On the
 * web that address is a dead end, so "Add to Excalidraw" would go nowhere. Point the referrer at this server instead: the site
 * then sends the browser back here with `#addLibrary=<library url>`, which `importLibraryFromHash` adds to Excalidraw.
 */
const LIB_HOST = 'libraries.excalidraw.com';

export function installLibraryLinkRewrite(): void {
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    let u: URL;
    try { u = new URL(a.href); } catch { return; }
    if (u.hostname !== LIB_HOST || !u.searchParams.has('referrer')) return;
    u.searchParams.set('referrer', `${location.origin}/`);
    a.href = u.toString();
  }, true);
}

/** Add the library named in `#addLibrary=…` to an Excalidraw view (opening a new drawing when none is open). */
export async function importLibraryFromHash(): Promise<void> {
  const hash = location.hash.replace(/^#/, '');
  if (!hash.includes('addLibrary=')) return;
  const params = new URLSearchParams(hash);
  const libUrl = params.get('addLibrary') ?? '';
  history.replaceState(null, '', location.pathname + location.search);
  let u: URL;
  try { u = new URL(libUrl); } catch { new Notice('That library link is not valid.'); return; }
  if (u.protocol !== 'https:' || u.hostname !== LIB_HOST) { new Notice('Only libraries from libraries.excalidraw.com can be added this way.'); return; }

  const app = getSharedApp() as any;
  if (!app.plugins?.plugins?.['obsidian-excalidraw-plugin']) { new Notice('Enable the Excalidraw plugin to add libraries.'); return; }
  let text: string;
  try {
    const r = await requestUrl({ url: u.toString() });
    text = r.text;
    JSON.parse(text);
  } catch (e: any) { new Notice(`Could not download the library: ${e?.message ?? e}`); return; }

  const findApi = () => (app.workspace.getLeavesOfType('excalidraw') as any[]).map((l) => l.view?.excalidrawAPI).find(Boolean);
  let api = findApi();
  if (!api) {
    new Notice('Opening a new drawing to add the library…');
    await app.commands.executeCommandById('obsidian-excalidraw-plugin:excalidraw-autocreate');
    for (let i = 0; i < 60 && !(api = findApi()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  if (!api) { new Notice('Open an Excalidraw drawing first, then add the library again.'); return; }
  await api.updateLibrary({
    libraryItems: new Blob([text], { type: 'application/json' }),
    merge: true, prompt: true, defaultStatus: 'published', openLibraryMenu: true,
  });
}
