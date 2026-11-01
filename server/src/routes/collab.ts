import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { accessFor, blame } from '../services/collab.js';
import { getEditLogStore } from '../db/index.js';
import { currentPrincipal } from '../services/acl.js';
import { currentVault } from '../services/vaultals.js';

export const collabRouter = Router();
collabRouter.use(requireAuth);

/** Whether the open note is co-edited, and whether this person may type in it. */
collabRouter.get(
  '/access',
  asyncHandler(async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const p = currentPrincipal();
    // Agent (API-key) requests have no person: they never join a room.
    res.json(p && rel ? accessFor(p, currentVault().id, rel) : { enabled: false, canWrite: false });
  }),
);

const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);

/** Who wrote the selected text (needs read access). */
collabRouter.get(
  '/blame',
  asyncHandler(async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const from = num(req.query.from);
    const to = num(req.query.to);
    const p = currentPrincipal();
    if (!rel || !p || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return void res.status(400).json({ error: 'path, from and to required' });
    if (!accessFor(p, currentVault().id, rel).enabled) return void res.status(403).json({ error: 'No access' });
    res.json(await blame(currentVault(), rel, from, to));
  }),
);

/** Recent edits of a note, newest first (needs read access). */
collabRouter.get(
  '/history',
  asyncHandler(async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const p = currentPrincipal();
    if (!rel || !p) return void res.status(400).json({ error: 'path required' });
    if (!accessFor(p, currentVault().id, rel).enabled) return void res.status(403).json({ error: 'No access' });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ entries: await getEditLogStore().list(currentVault().id, rel, limit) });
  }),
);
