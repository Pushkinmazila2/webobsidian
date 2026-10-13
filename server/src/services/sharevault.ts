import type { NextFunction, Request, Response } from 'express';
import { findShare, shareVaultId } from './shares.js';
import { ensureReady, getVaultContext } from './vaults.js';
import { runInVault } from './vaultals.js';

/**
 * `router.param('id', …)` for the public share routes: a share token identifies the vault
 * its note lives in, so the rest of the request runs inside that vault. Unknown tokens fall
 * through untouched (the handlers answer 404 as before).
 */
export async function bindShareVault(req: Request, res: Response, next: NextFunction, id: string): Promise<void> {
  try {
    const rec = await findShare(id);
    const ctx = rec ? await getVaultContext(shareVaultId(rec)) : null;
    if (!rec || !ctx) return next();
    await ensureReady(ctx);
    runInVault(ctx, next);
  } catch (e) {
    next(e);
  }
}
