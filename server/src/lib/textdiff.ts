import DiffMatchPatch from 'diff-match-patch';

/**
 * Text diff / three-way merge that never splits a surrogate pair (emoji): Yjs and the network encode strings as UTF-8,
 * where half a pair would turn into U+FFFD. Each astral character is swapped for one private-use character before diffing
 * and swapped back afterwards; if the text already uses that private-use range we fall back to a single replaced region.
 */

export type DiffOp = [op: -1 | 0 | 1, text: string];

const PUA_START = 0xe000;
const PUA_END = 0xf8ff;
const hasPua = (s: string) => /[-]/.test(s);
const ASTRAL = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

class Codec {
  private toPua = new Map<string, string>();
  private fromPua = new Map<string, string>();
  ok = true;

  encode(s: string): string {
    return s.replace(ASTRAL, (pair) => {
      let c = this.toPua.get(pair);
      if (!c) {
        const code = PUA_START + this.toPua.size;
        if (code > PUA_END) {
          this.ok = false;
          return pair;
        }
        c = String.fromCharCode(code);
        this.toPua.set(pair, c);
        this.fromPua.set(c, pair);
      }
      return c;
    });
  }
  decode(s: string): string {
    if (!this.fromPua.size) return s;
    return s.replace(/[-]/g, (c) => this.fromPua.get(c) ?? c);
  }
}

function newDmp(): DiffMatchPatch {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 1; // seconds: a pathological pair of texts must not stall the server
  dmp.Match_Threshold = 0.5;
  dmp.Patch_DeleteThreshold = 0.5;
  return dmp;
}

/** One replaced region between the common prefix and suffix, never inside a surrogate pair. */
function coarse(a: string, b: string): DiffOp[] {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && /[\uD800-\uDBFF]/.test(a[p - 1])) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && /[\uDC00-\uDFFF]/.test(a[a.length - s])) s--;
  const ops: DiffOp[] = [];
  if (p) ops.push([0, a.slice(0, p)]);
  const del = a.slice(p, a.length - s);
  const ins = b.slice(p, b.length - s);
  if (del) ops.push([-1, del]);
  if (ins) ops.push([1, ins]);
  if (s) ops.push([0, a.slice(a.length - s)]);
  return ops;
}

export function diffOps(a: string, b: string): DiffOp[] {
  if (a === b) return a ? [[0, a]] : [];
  if (hasPua(a) || hasPua(b)) return coarse(a, b);
  const codec = new Codec();
  const ea = codec.encode(a);
  const eb = codec.encode(b);
  if (!codec.ok) return coarse(a, b);
  const dmp = newDmp();
  const d = dmp.diff_main(ea, eb);
  dmp.diff_cleanupEfficiency(d);
  return d.map(([op, t]) => [op as -1 | 0 | 1, codec.decode(t)]);
}

/** Apply the changes between `base` and `theirs` onto `ours`. `conflicts` > 0 when some hunk could not be placed. */
export function merge3(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
  if (ours === base) return { text: theirs, conflicts: 0 };
  if (theirs === base || ours === theirs) return { text: ours, conflicts: 0 };
  if (hasPua(base) || hasPua(ours) || hasPua(theirs)) return { text: ours, conflicts: 1 };
  const codec = new Codec();
  const [eb, eo, et] = [codec.encode(base), codec.encode(ours), codec.encode(theirs)];
  if (!codec.ok) return { text: ours, conflicts: 1 };
  const dmp = newDmp();
  const patches = dmp.patch_make(eb, et);
  const [merged, applied] = dmp.patch_apply(patches, eo);
  return { text: codec.decode(merged), conflicts: applied.filter((x) => !x).length };
}
