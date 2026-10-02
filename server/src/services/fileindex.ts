import { listFiles } from './vault.js';

/**
 * Vault-wide file index for Obsidian-style attachment resolution: an embed like
 * `![[image.jpg]]` or `![](image.jpg)` can reference a file living anywhere in
 * the vault (commonly an Attachments folder). We index every file by basename
 * and resolve by shortest path when a link doesn't include an explicit folder.
 */

let byBasename = new Map<string, string>();
let byBasenameNoExt = new Map<string, string>();

function depth(p: string): number {
  return p.split('/').length;
}

function record(maps: { b: Map<string, string>; bn: Map<string, string> }, rel: string): void {
  const name = (rel.split('/').pop() ?? rel).toLowerCase();
  const prev = maps.b.get(name);
  if (!prev || depth(rel) < depth(prev)) maps.b.set(name, rel); // prefer shortest path
  const noExt = name.replace(/\.[^.]+$/, '');
  const prevN = maps.bn.get(noExt);
  if (!prevN || depth(rel) < depth(prevN)) maps.bn.set(noExt, rel);
}

export async function buildFileIndex(): Promise<void> {
  const maps = { b: new Map<string, string>(), bn: new Map<string, string>() };
  for (const rel of await listFiles()) record(maps, rel);
  byBasename = maps.b;
  byBasenameNoExt = maps.bn;
}

/** Resolve a link target (basename or partial path) to a real vault path. */
export function resolveFile(name: string): string | undefined {
  const base = (name.split('/').pop() ?? name).toLowerCase();
  return byBasename.get(base) ?? byBasenameNoExt.get(base.replace(/\.[^.]+$/, ''));
}

export function indexFile(rel: string): void {
  record({ b: byBasename, bn: byBasenameNoExt }, rel);
}

export function unindexFile(rel: string): void {
  const name = (rel.split('/').pop() ?? rel).toLowerCase();
  if (byBasename.get(name) === rel) byBasename.delete(name);
  const noExt = name.replace(/\.[^.]+$/, '');
  if (byBasenameNoExt.get(noExt) === rel) byBasenameNoExt.delete(noExt);
}
