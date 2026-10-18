/**
 * Obsidian-style `CachedMetadata` for markdown notes: front matter, headings, links, embeds, tags,
 * sections and list items — each with line/column/offset positions. The web client builds
 * `app.metadataCache` from this (plugins such as Dataview index the vault through it).
 *
 * `computeMetadata` is pure (and unit-tested); `vaultMetadata` reads the current vault and caches the
 * result per file content so repeated calls only re-parse what changed.
 */
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import yaml from 'js-yaml';

/** Obsidian keeps front-matter dates as plain strings (`2026-10-17`); js-yaml's default schema would turn them into Dates. */
const PLAIN_DATES = { engines: { yaml: { parse: (s: string) => yaml.load(s, { schema: yaml.CORE_SCHEMA }) as object, stringify: (o: object) => yaml.dump(o, { schema: yaml.CORE_SCHEMA }) } } };
import { currentVault } from './vaultals.js';
import { listIndexedMarkdownFiles, readFileText } from './vault.js';

export interface Pos { line: number; col: number; offset: number }
export interface Position { start: Pos; end: Pos }
export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: Position;
  headings?: { heading: string; level: number; position: Position }[];
  links?: { link: string; original: string; displayText?: string; position: Position }[];
  embeds?: { link: string; original: string; displayText?: string; position: Position }[];
  tags?: { tag: string; position: Position }[];
  sections?: { type: string; position: Position; id?: string }[];
  listItems?: { position: Position; parent: number; task?: string; id?: string }[];
  blocks?: Record<string, { id: string; position: Position }>;
}

const WIKI_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu;
const FENCE_RE = /^\s{0,3}(```+|~~~+)/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(?:\[(.)\]\s+)?/;
const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)\s*$/;

/** Blank out `inline code` so links/tags inside it are not picked up (offsets are preserved). */
const maskInlineCode = (line: string) => line.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));

export function computeMetadata(raw: string): CachedMetadata {
  const out: CachedMetadata = {};
  const text = raw.replace(/^﻿/, '');
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lines = text.split('\n');
  const eolLen = (i: number) => (lines[i].endsWith('\r') ? 1 : 0);
  const pos = (line: number, col: number): Pos => ({ line, col, offset: lineStarts[line] + col });
  const lineEnd = (line: number) => lines[line].length - eolLen(line);
  const span = (l1: number, c1: number, l2: number, c2: number): Position => ({ start: pos(l1, c1), end: pos(l2, c2) });

  let first = 0;
  // ---- front matter
  if (/^---[ \t]*\r?$/.test(lines[0] ?? '')) {
    let close = -1;
    for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)[ \t]*\r?$/.test(lines[i])) { close = i; break; }
    if (close > 0) {
      try { out.frontmatter = (matter(text, PLAIN_DATES).data ?? {}) as Record<string, unknown>; } catch { out.frontmatter = {}; }
      out.frontmatterPosition = span(0, 0, close, lineEnd(close));
      out.sections = [{ type: 'yaml', position: out.frontmatterPosition }];
      first = close + 1;
    }
  }

  const headings: NonNullable<CachedMetadata['headings']> = [];
  const links: NonNullable<CachedMetadata['links']> = [];
  const embeds: NonNullable<CachedMetadata['embeds']> = [];
  const tags: NonNullable<CachedMetadata['tags']> = [];
  const sections: NonNullable<CachedMetadata['sections']> = out.sections ?? [];
  const listItems: NonNullable<CachedMetadata['listItems']> = [];
  const blocks: NonNullable<CachedMetadata['blocks']> = {};

  let fence: string | null = null;
  let sec = null as { type: string; start: number; end: number } | null;
  const closeSec = () => {
    if (!sec) return;
    const position = span(sec.start, 0, sec.end, lineEnd(sec.end));
    const entry: { type: string; position: Position; id?: string } = { type: sec.type, position };
    // a trailing `^id` on the section's last line names the block
    const m = BLOCK_ID_RE.exec(' ' + lines[sec.end].replace(/\r$/, ''));
    if (m && sec.type !== 'code') { entry.id = m[1]; blocks[m[1].toLowerCase()] = { id: m[1], position }; }
    sections.push(entry);
    sec = null;
  };
  const touch = (type: string, i: number) => {
    if (sec && (sec.type !== type || type === 'heading' || type === 'thematicBreak')) closeSec();
    if (sec) sec.end = i; else sec = { type, start: i, end: i };
  };

  const listStack: { indent: number; line: number }[] = [];
  let listStart = -1;

  for (let i = first; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const fm = FENCE_RE.exec(line);
    if (fence !== null) {
      touch('code', i);
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && /^\s{0,3}(```+|~~~+)\s*$/.test(line)) { fence = null; closeSec(); }
      continue;
    }
    if (fm) { fence = fm[1]; touch('code', i); listStack.length = 0; continue; }
    if (line.trim() === '') { closeSec(); listStack.length = 0; listStart = -1; continue; }

    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hm) {
      closeSec(); listStack.length = 0; listStart = -1;
      touch('heading', i); closeSec();
      headings.push({ heading: hm[2], level: hm[1].length, position: span(i, 0, i, line.length) });
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) && !LIST_RE.test(line.replace(/^\s*[-*_]/, '- x'))) {
      touch('thematicBreak', i); closeSec();
    } else {
      const lm = LIST_RE.exec(line);
      if (lm) {
        if (sec && sec.type !== 'list') closeSec();
        touch('list', i);
        const indent = lm[1].replace(/\t/g, '    ').length;
        while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
        if (listStart < 0) listStart = i;
        const parent = listStack.length ? listStack[listStack.length - 1].line : -listStart;
        const item: NonNullable<CachedMetadata['listItems']>[number] = { position: span(i, lm[1].length, i, line.length), parent };
        if (lm[3] !== undefined) item.task = lm[3];
        const bid = BLOCK_ID_RE.exec(' ' + line);
        if (bid) { item.id = bid[1]; blocks[bid[1].toLowerCase()] = { id: bid[1], position: item.position }; }
        listItems.push(item);
        listStack.push({ indent, line: i });
      } else if (/^\s*>/.test(line)) {
        const callout = /^\s*>\s*\[!/.test(line) || (sec?.type === 'callout');
        touch(callout ? 'callout' : 'blockquote', i);
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        touch('table', i);
      } else if (sec?.type === 'list' && /^\s+\S/.test(line)) {
        touch('list', i); // continuation of a list item
      } else {
        touch('paragraph', i);
      }
    }

    // links / embeds / tags (outside inline code)
    const masked = maskInlineCode(line);
    for (const m of masked.matchAll(WIKI_RE)) {
      const inner = m[2];
      const bar = inner.indexOf('|');
      const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
      const alias = bar < 0 ? undefined : inner.slice(bar + 1).trim();
      const entry = { link: target, original: m[0], displayText: alias ?? target, position: span(i, m.index!, i, m.index! + m[0].length) };
      (m[1] ? embeds : links).push(entry);
    }
    for (const m of masked.matchAll(MDLINK_RE)) {
      const href = m[3];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') && href.length === 1) continue; // external / mailto
      let target = href;
      try { target = decodeURIComponent(href); } catch { /* keep raw */ }
      const entry = { link: target, original: m[0], displayText: m[2], position: span(i, m.index!, i, m.index! + m[0].length) };
      (m[1] ? embeds : links).push(entry);
    }
    const noLinks = masked.replace(WIKI_RE, (s) => ' '.repeat(s.length)).replace(MDLINK_RE, (s) => ' '.repeat(s.length));
    for (const m of noLinks.matchAll(TAG_RE)) {
      if (/^\d+$/.test(m[2])) continue; // "#1" is not a tag
      const col = m.index! + m[1].length;
      tags.push({ tag: '#' + m[2], position: span(i, col, i, col + 1 + m[2].length) });
    }
  }
  closeSec();

  sections.sort((a, b) => a.position.start.offset - b.position.start.offset);
  if (headings.length) out.headings = headings;
  if (links.length) out.links = links;
  if (embeds.length) out.embeds = embeds;
  if (tags.length) out.tags = tags;
  if (sections.length) out.sections = sections;
  if (listItems.length) out.listItems = listItems;
  if (Object.keys(blocks).length) out.blocks = blocks;
  return out;
}

// ---- per-vault cache -------------------------------------------------------------------------
const caches = new Map<string, Map<string, { hash: string; meta: CachedMetadata; size: number }>>();

/** Metadata of every indexed note in the current vault. */
export async function vaultMetadata(): Promise<Record<string, { size: number; cache: CachedMetadata }>> {
  const id = currentVault().id;
  let cache = caches.get(id);
  if (!cache) caches.set(id, (cache = new Map()));
  const files = await listIndexedMarkdownFiles();
  const out: Record<string, { size: number; cache: CachedMetadata }> = {};
  const seen = new Set(files);
  for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
  const queue = [...files];
  const worker = async () => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      try {
        const raw = await readFileText(rel);
        const hash = createHash('sha1').update(raw).digest('hex');
        let hit = cache!.get(rel);
        if (!hit || hit.hash !== hash) { hit = { hash, meta: computeMetadata(raw), size: Buffer.byteLength(raw) }; cache!.set(rel, hit); }
        out[rel] = { size: hit.size, cache: hit.meta };
      } catch { /* unreadable file: leave it out */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}
