import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { computeMetadata, vaultMetadata } from '../services/metadata.js';
import { readFileText } from '../services/vault.js';

export const metadataRouter = Router();
metadataRouter.use(requireAuth);

/** Obsidian-style CachedMetadata of every note — the web client builds app.metadataCache from it. */
metadataRouter.get('/', asyncHandler(async (_req, res) => { res.json({ files: await vaultMetadata() }); }));

/**
 * One note's metadata, whether or not the vault's storage rules index it. Plugins decide what a note is from its front matter
 * (Excalidraw drawings, Kanban boards…), so the file being opened must be answerable even when search skips its folder.
 */
metadataRouter.get('/file', asyncHandler(async (req, res) => {
  const rel = String(req.query.path ?? '');
  if (!/\.(md|markdown)$/i.test(rel)) return void res.status(400).json({ error: 'a note path is required' });
  const raw = await readFileText(rel);
  res.json({ size: Buffer.byteLength(raw), cache: computeMetadata(raw) });
}));
