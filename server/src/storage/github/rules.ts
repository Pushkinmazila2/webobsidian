/**
 * Per-path storage rules: decide how each vault file is handled by the GitHub driver.
 *
 *   mirror  prefetched at startup / on change, never evicted (notes, plugins)
 *   lazy    fetched on first use, kept in the size-capped LRU cache (images, PDFs)
 *   remote  never cached; only a short in-memory TTL to absorb repeated reads
 *
 * First matching rule wins; paths with no match are `lazy`.
 */

export type StorageMode = 'mirror' | 'lazy' | 'remote';

export interface RuleConfig {
  match: string;
  mode: StorageMode;
  /** Include in search / backlinks / graph. Default: true for mirror, false otherwise. */
  index?: boolean;
}

export interface Resolved {
  mode: StorageMode;
  index: boolean;
}

/**
 * Glob → RegExp. Supports `**` (any depth), `*`, `?`, `{a,b}`; everything else is
 * literal. `**​/` also matches zero directories, so `**​/*.md` matches `top.md`.
 * Case-insensitive, because attachments often arrive as `.PNG`/`.JPG`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/[{}]/g, '\\$&');
    }
  }
  if (braceDepth !== 0) throw new Error(`Unbalanced { } in glob: ${glob}`);
  return new RegExp(`^${re}$`, 'i');
}

export class Rules {
  private compiled: { re: RegExp; mode: StorageMode; index: boolean }[];

  constructor(rules: RuleConfig[]) {
    this.compiled = rules.map((r) => ({
      re: globToRegExp(r.match.replace(/^\/+/, '')),
      mode: r.mode,
      index: r.index ?? r.mode === 'mirror',
    }));
  }

  resolve(rel: string): Resolved {
    for (const r of this.compiled) {
      if (r.re.test(rel)) return { mode: r.mode, index: r.index };
    }
    return { mode: 'lazy', index: false };
  }

  modeFor(rel: string): StorageMode {
    return this.resolve(rel).mode;
  }
}
