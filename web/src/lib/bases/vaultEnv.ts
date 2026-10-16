/** Feeds the Bases engine from the live vault: file tree (stat) + MetadataCache (front matter, tags, links). */
import { flattenFiles, sharedMetadataCache } from '../obsidianApi';
import { getLinkpath, parseFrontMatterTags } from '../obsidianUtils';
import type { BaseFile, Env } from './engine';

export function buildBaseEnv(): Env {
  const mc = sharedMetadataCache;
  const files: BaseFile[] = flattenFiles().map((f) => {
    const c = mc.getFileCache(f);
    const tags = new Set<string>();
    for (const t of c?.tags ?? []) tags.add(t.tag.replace(/^#/, ''));
    for (const t of parseFrontMatterTags(c?.frontmatter ?? null) ?? []) tags.add(t.replace(/^#/, ''));
    return {
      path: f.path, name: f.name, basename: f.basename, ext: f.extension,
      folder: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
      size: f.stat.size, ctime: f.stat.ctime, mtime: f.stat.mtime,
      tags: [...tags],
      links: (c?.links ?? []).map((l) => getLinkpath(l.link)),
      embeds: (c?.embeds ?? []).map((l) => getLinkpath(l.link)),
      frontmatter: (c?.frontmatter ?? {}) as Record<string, unknown>,
    };
  });
  return { files, resolve: (link, from) => mc.getFirstLinkpathDest(link, from)?.path ?? null };
}
