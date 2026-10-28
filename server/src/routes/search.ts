import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { qmd } from '../services/search.js';
import { backlinksFor, graphData, resolveLink, buildLinkGraph } from '../services/links.js';
import { resolveFile } from '../services/fileindex.js';
import { readPropertyTypes, setPropertyType } from '../services/propertytypes.js';
import { asSystem, canRead, currentPrincipal, assertRead } from '../services/acl.js';
import { requireAdmin } from '../middleware/auth.js';
import type { GraphData } from '../services/links.js';

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    // limit omitted / 0 → return every match; the client renders them incrementally.
    const limit = Math.max(0, Number(req.query.limit ?? 0) || 0);
    // The index covers the whole vault: drop what this person may not read before applying the limit.
    const all = await qmd.search(q, 0);
    const hits = currentPrincipal()?.isAdmin === false ? all.filter((h) => canRead(h.path)) : all;
    res.json({ query: q, hits: limit > 0 ? hits.slice(0, limit) : hits });
  }),
);

// Per-note match contexts for the rendered batch of results (Obsidian-style
// grouped search). Reads bodies lazily so broad queries stay cheap.
searchRouter.post(
  '/search/matches',
  asyncHandler(async (req, res) => {
    const { query, paths, matchCase, phrase } = req.body ?? {};
    // phrase=true → match the whole query as one needle (e.g. unlinked mentions
    // look for the exact note title, not each word of it).
    const terms = phrase
      ? [String(query ?? '').trim()].filter((t) => t.length >= 2)
      : qmd.queryTerms(String(query ?? ''));
    const list = (Array.isArray(paths) ? paths : []).map((p) => String(p)).filter((p) => canRead(p)).slice(0, 80);
    const matches = await Promise.all(
      list.map((p) => qmd.matchesFor(p, terms, { caseSensitive: !!matchCase })),
    );
    res.json({ matches });
  }),
);

searchRouter.get(
  '/tags',
  asyncHandler(async (_req, res) => {
    res.json({ tags: qmd.allTags(currentPrincipal()?.isAdmin === false ? canRead : undefined) });
  }),
);

searchRouter.get(
  '/properties',
  asyncHandler(async (_req, res) => {
    res.json({ properties: qmd.allProperties(currentPrincipal()?.isAdmin === false ? canRead : undefined) });
  }),
);

searchRouter.get(
  '/property-types',
  asyncHandler(async (_req, res) => {
    res.json({ types: await readPropertyTypes() });
  }),
);

searchRouter.post(
  '/property-types',
  asyncHandler(async (req, res) => {
    const { key, type } = req.body ?? {};
    if (typeof key !== 'string' || typeof type !== 'string') {
      res.status(400).json({ error: 'key and type required' });
      return;
    }
    res.json({ types: await setPropertyType(key, type) });
  }),
);

searchRouter.get(
  '/backlinks',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    assertRead(rel);
    res.json({ path: rel, backlinks: backlinksFor(rel).filter((b) => canRead(b)) });
  }),
);

searchRouter.get(
  '/resolve',
  asyncHandler(async (req, res) => {
    const target = String(req.query.target ?? '');
    // The link graph only indexes markdown notes, so a wikilink that points at a
    // non-markdown file with an explicit extension (e.g. `[[Foo.canvas]]`) misses.
    // Fall back to the vault-wide file index for those — but only when an explicit
    // non-markdown extension is present, so a bare `[[Foo]]` still resolves to a
    // note (or stays unresolved so the client can offer to create one).
    let resolved = resolveLink(target);
    if (!resolved && /\.[^./]+$/.test(target) && !/\.(md|markdown)$/i.test(target)) {
      resolved = resolveFile(target);
    }
    res.json({ target, path: resolved && canRead(resolved) ? resolved : null });
  }),
);

searchRouter.get(
  '/graph',
  asyncHandler(async (_req, res) => {
    res.json(visibleGraph(graphData()));
  }),
);

/** The graph without notes (and their edges) the caller may not read; links/tags nodes survive only if a visible edge uses them. */
function visibleGraph(g: GraphData): GraphData {
  if (currentPrincipal()?.isAdmin !== false) return g;
  const notes = new Set(g.nodes.filter((n) => n.kind === 'note' && canRead(n.id)).map((n) => n.id));
  const isNote = new Set(g.nodes.filter((n) => n.kind === 'note').map((n) => n.id));
  const edges = g.edges.filter((e) => notes.has(e.source) && (!isNote.has(e.target) || notes.has(e.target)));
  const used = new Set(edges.flatMap((e) => [e.source, e.target]));
  return { ...g, nodes: g.nodes.filter((n) => (n.kind === 'note' ? notes.has(n.id) : used.has(n.id))), edges };
}

searchRouter.post(
  '/reindex',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    // The shared index must always be built from the whole vault, never from one person's view of it.
    await asSystem(async () => {
      await qmd.build();
      await buildLinkGraph();
    });
    res.json({ ok: true });
  }),
);
