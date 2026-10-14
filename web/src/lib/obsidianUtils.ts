/**
 * Pure helpers from Obsidian's plugin API (no DOM, no app state) — kept apart so they can be unit-tested
 * in Node. See docs/PLUGIN_API.md for what is covered.
 */
import yaml from 'js-yaml';

/** The API level we declare to plugins (`apiVersion`, `requireApiVersion`). Only raise it when the matching surface exists. */
export const API_VERSION = '1.8.10';

// ---- binary <-> text ------------------------------------------------------------------------
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
export function arrayBufferToHex(data: ArrayBuffer): string {
  return Array.from(new Uint8Array(data), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const h = hex.replace(/\s+/g, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('Invalid hex string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}
export const getBlobArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => blob.arrayBuffer();

// ---- YAML / front matter ----------------------------------------------------------------------
export function parseYaml(text: string): any {
  return yaml.load(text);
}
export function stringifyYaml(obj: unknown): string {
  return yaml.dump(obj, { lineWidth: -1 });
}

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}
/** Locate the `---` front matter block at the top of a file. */
export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const m = /^---[ \t]*\r?\n/.exec(content);
  if (m) {
    const from = m[0].length;
    const close = /\r?\n---[ \t]*(?=\r?\n|$)/.exec(content.slice(from - 1));
    if (close) {
      const to = from - 1 + close.index;
      const end = from - 1 + close.index + close[0].length;
      const contentStart = content.slice(end).startsWith('\r\n') ? end + 2 : content.slice(end).startsWith('\n') ? end + 1 : end;
      return { exists: true, frontmatter: content.slice(from, Math.max(from, to)), from, to: Math.max(from, to), contentStart };
    }
  }
  return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function parseFrontMatterEntry(frontmatter: any | null, key: string | RegExp): any | null {
  if (!isObj(frontmatter)) return null;
  if (key instanceof RegExp) {
    const k = Object.keys(frontmatter).find((x) => key.test(x));
    return k === undefined ? null : (frontmatter[k] ?? null);
  }
  if (key in frontmatter) return frontmatter[key] ?? null;
  const lower = key.toLowerCase();
  const k = Object.keys(frontmatter).find((x) => x.toLowerCase() === lower);
  return k === undefined ? null : (frontmatter[k] ?? null);
}
export function parseFrontMatterStringArray(frontmatter: any | null, key: string | RegExp): string[] | null {
  const v = parseFrontMatterEntry(frontmatter, key);
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x !== '');
  if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()];
  return [String(v).trim()];
}
const splitList = (vals: string[]) => vals.flatMap((s) => s.split(/[,\s]+/)).map((s) => s.trim()).filter(Boolean);
export function parseFrontMatterAliases(frontmatter: any | null): string[] | null {
  const a = parseFrontMatterStringArray(frontmatter, /^alias(es)?$/i);
  if (!a) return null;
  const out = a.flatMap((x) => (typeof x === 'string' ? [x] : []));
  return out.length ? out : null;
}
export function parseFrontMatterTags(frontmatter: any | null): string[] | null {
  const t = parseFrontMatterStringArray(frontmatter, /^tags?$/i);
  if (!t) return null;
  const tags = splitList(t).map((x) => '#' + x.replace(/^#+/, ''));
  return tags.length ? tags : null;
}

// ---- links / headings --------------------------------------------------------------------------
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const i = linktext.indexOf('#');
  return i < 0 ? { path: linktext, subpath: '' } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}
export const getLinkpath = (linktext: string): string => parseLinktext(linktext).path;

export function stripHeading(heading: string): string {
  return heading.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function stripHeadingForLink(heading: string): string {
  return heading.replace(/[:#|^\\\r\n]|%%|\[\[|\]\]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---- search helpers ----------------------------------------------------------------------------------
export type SearchMatchPart = [number, number];
export interface SearchResult { score: number; matches: SearchMatchPart[] }

function mergeRanges(r: SearchMatchPart[]): SearchMatchPart[] {
  const sorted = [...r].sort((a, b) => a[0] - b[0]);
  const out: SearchMatchPart[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Every space-separated word must occur (case-insensitive). Higher (closer to 0) score = better. */
export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const lower = text.toLowerCase();
    const ranges: SearchMatchPart[] = [];
    let score = 0;
    for (const w of words) {
      const i = lower.indexOf(w);
      if (i < 0) return null;
      ranges.push([i, i + w.length]);
      score -= i / Math.max(1, text.length);
    }
    return { score: words.length ? score : 0, matches: mergeRanges(ranges) };
  };
}

/** Subsequence match: the query's characters must appear in order. Tighter, earlier, word-start matches score higher. */
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  return (text) => {
    if (!q) return { score: 0, matches: [] };
    const lower = text.toLowerCase();
    // try the match anchored at each occurrence of the first char, keep the best
    let best: SearchResult | null = null;
    for (let start = lower.indexOf(q[0]); start >= 0 && start < lower.length; start = lower.indexOf(q[0], start + 1)) {
      let pos = start;
      let score = 0;
      const idx: number[] = [];
      let ok = true;
      for (const ch of q) {
        const at = lower.indexOf(ch, pos);
        if (at < 0) { ok = false; break; }
        if (idx.length) score -= at - idx[idx.length - 1] - 1; // gap penalty
        else score -= at * 0.1;                                 // late start penalty
        if (at === 0 || /[\s\-_/.]/.test(text[at - 1])) score += 0.5; // word start bonus
        idx.push(at);
        pos = at + 1;
      }
      if (!ok) break; // no later anchor can match either
      score -= (text.length - q.length) * 0.01;
      if (!best || score > best.score) best = { score, matches: mergeRanges(idx.map((i) => [i, i + 1] as SearchMatchPart)) };
    }
    return best;
  };
}

export function sortSearchResults(results: { match: SearchResult }[]): void {
  results.sort((a, b) => b.match.score - a.match.score);
}

/** Append `text` to `el`, wrapping the matched ranges in `<span class="suggestion-highlight">`. */
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatchPart[] | null, offset = 0): void {
  let pos = 0;
  for (const [s0, e0] of matches ?? []) {
    const s = Math.max(pos, s0 + offset), e = e0 + offset;
    if (e <= s || s >= text.length) continue;
    if (s > pos) el.appendChild(document.createTextNode(text.slice(pos, s)));
    const span = document.createElement('span');
    span.className = 'suggestion-highlight';
    span.textContent = text.slice(s, Math.min(e, text.length));
    el.appendChild(span);
    pos = Math.min(e, text.length);
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
}
export const renderResults = (el: HTMLElement | DocumentFragment, text: string, result: SearchResult, offset = 0) => renderMatches(el, text, result.matches, offset);

// ---- versions ---------------------------------------------------------------------------------------------
export function requireApiVersion(version: string): boolean {
  const a = API_VERSION.split('.').map(Number), b = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** `note.prop` / `formula.x` / `file.name` → { type, name }. */
export function parsePropertyId(id: string): { type: 'note' | 'formula' | 'file'; name: string } {
  const i = id.indexOf('.');
  const head = i < 0 ? '' : id.slice(0, i);
  if (head === 'note' || head === 'formula' || head === 'file') return { type: head, name: id.slice(i + 1) };
  return { type: 'note', name: id };
}
