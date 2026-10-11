import type { TreeNode } from '../types.js';
import type { TreeEntry } from './client.js';

export interface FileEntry {
  sha: string;
  size: number;
}

/** Names hidden from listings, like Obsidian (and like the local driver). */
const HIDDEN_NAMES = new Set(['.git', 'node_modules']);
export function isHiddenName(name: string): boolean {
  return HIDDEN_NAMES.has(name) || name.startsWith('.');
}
export function isHiddenPath(rel: string): boolean {
  return rel.split('/').some(isHiddenName);
}

/**
 * Immutable snapshot of the vault tree at one commit. Paths are vault-relative
 * (the configured basePath has already been stripped). Git has no empty
 * directories, so a directory exists iff it contains something.
 */
export class TreeIndex {
  readonly files = new Map<string, FileEntry>();
  /** dir → (child name → isDir). The root is ''. */
  readonly children = new Map<string, Map<string, boolean>>();
  private treeCache: TreeNode | null = null;

  static build(entries: TreeEntry[]): TreeIndex {
    const idx = new TreeIndex();
    idx.children.set('', new Map());
    for (const e of entries) {
      if (e.type === 'blob') {
        if (e.mode === '120000') continue; // symlinks aren't files, same as the local driver
        idx.files.set(e.path, { sha: e.sha, size: e.size ?? 0 });
        idx.link(e.path, false);
      } else if (e.type === 'tree') {
        idx.link(e.path, true);
      } // 'commit' (submodule) entries are ignored
    }
    return idx;
  }

  /** Register `p` under its parent, creating missing ancestor directories. */
  private link(p: string, isDir: boolean): void {
    const parts = p.split('/');
    let dir = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const last = i === parts.length - 1;
      let kids = this.children.get(dir);
      if (!kids) this.children.set(dir, (kids = new Map()));
      const childIsDir = last ? isDir : true;
      if (!kids.has(name) || childIsDir) kids.set(name, childIsDir);
      dir = dir ? `${dir}/${name}` : name;
      if (childIsDir && !this.children.has(dir)) this.children.set(dir, new Map());
    }
  }

  hasFile(rel: string): boolean {
    return this.files.has(rel);
  }
  hasDir(rel: string): boolean {
    return this.children.has(rel);
  }

  /** Nested tree for the UI: hidden entries skipped, folders first then alphabetical. */
  tree(rootName: string): TreeNode {
    if (this.treeCache) return this.treeCache;
    const build = (dir: string): TreeNode[] => {
      const nodes: TreeNode[] = [];
      for (const [name, isDir] of this.children.get(dir) ?? []) {
        if (isHiddenName(name)) continue;
        const p = dir ? `${dir}/${name}` : name;
        if (isDir) nodes.push({ name, path: p, type: 'folder', children: build(p) });
        else {
          const f = this.files.get(p);
          if (!f) continue;
          const dot = name.lastIndexOf('.');
          nodes.push({ name, path: p, type: 'file', ext: dot > 0 ? name.slice(dot).toLowerCase() : '', size: f.size });
        }
      }
      nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)));
      return nodes;
    };
    return (this.treeCache = { name: rootName, path: '', type: 'folder', children: build('') });
  }

  /** Every visible file, sorted by path. */
  visibleFiles(): string[] {
    const out: string[] = [];
    for (const p of this.files.keys()) if (!isHiddenPath(p)) out.push(p);
    return out.sort();
  }
}

export interface TreeDiff {
  added: string[];
  changed: string[];
  removed: string[];
  addedDirs: string[];
  removedDirs: string[];
}

export function diffTrees(a: TreeIndex, b: TreeIndex): TreeDiff {
  const d: TreeDiff = { added: [], changed: [], removed: [], addedDirs: [], removedDirs: [] };
  for (const [p, f] of b.files) {
    const old = a.files.get(p);
    if (!old) d.added.push(p);
    else if (old.sha !== f.sha) d.changed.push(p);
  }
  for (const p of a.files.keys()) if (!b.files.has(p)) d.removed.push(p);
  for (const p of b.children.keys()) if (p && !a.children.has(p)) d.addedDirs.push(p);
  for (const p of a.children.keys()) if (p && !b.children.has(p)) d.removedDirs.push(p);
  return d;
}
