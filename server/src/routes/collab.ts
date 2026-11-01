import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { accessFor } from '../services/collab.js';
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
