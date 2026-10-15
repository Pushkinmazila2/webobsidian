import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { vaultMetadata } from '../services/metadata.js';

export const metadataRouter = Router();
metadataRouter.use(requireAuth);

/** Obsidian-style CachedMetadata of every note — the web client builds app.metadataCache from it. */
metadataRouter.get('/', asyncHandler(async (_req, res) => { res.json({ files: await vaultMetadata() }); }));
