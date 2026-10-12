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

  /** Independent copy (the pending-changes view is built from a clone of the committed snapshot). */
  clone(): TreeIndex {
    const c = new TreeIndex();
    for (const [p, f] of this.files) c.files.set(p, { ...f });
    for (const [d, kids] of this.children) c.children.set(d, new Map(kids));
    return c;
  }

  /** Add or replace one file (creating ancestor directories). */
  setFile(rel: string, f: FileEntry): void {
    this.files.set(rel, f);
    this.link(rel, false);
    this.treeCache = null;
  }

  /** Remove one file; directories that become empty disappear (git has no empty dirs). */
  deleteFile(rel: string): void {
    if (!this.files.delete(rel)) return;
    this.treeCache = null;
    const parts = rel.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const dir = parts.slice(0, i).join('/');
      const kids = this.children.get(dir);
      if (!kids) return;
      kids.delete(parts[i]);
      if (dir === '' || kids.size > 0) return;
      this.children.delete(dir); // dir is now empty → remove it from its parent next round
    }
  }

  /** Every file at or below `rel` (the file itself if `rel` is a file). Empty if it doesn't exist. */
  filesUnder(rel: string): string[] {
    if (this.files.has(rel)) return [rel];
    const kids = this.children.get(rel);
    if (!kids) return [];
    const out: string[] = [];
    const walk = (dir: string, entries: Map<string, boolean>): void => {
      for (const [name, isDir] of entries) {
        const p = dir ? `${dir}/${name}` : name;
        if (isDir) walk(p, this.children.get(p) ?? new Map());
        else out.push(p);
      }
    };
    walk(rel, kids);
    return out;
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
