import type { Request, Response, NextFunction } from 'express';
import { authenticateToken, type AuthUser } from '../services/auth.js';
import { principalFor, runAs } from '../services/acl.js';

export const COOKIE_NAME = 'webobsidian_token';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in user (set by requireAuth). */
      user?: AuthUser;
    }
  }
}

export function sessionToken(req: Request): string | undefined {
  return req.cookies?.[COOKIE_NAME] || bearer(req);
}

/** Require a valid session cookie for web/session routes. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = sessionToken(req);
  const user = token ? await authenticateToken(token) : null;
  if (user) {
    req.user = user;
    // From here on every vault call of this request is checked against this person's permissions.
    const principal = await principalFor(user);
    runAs(principal, next);
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

/** Administrators only (after requireAuth). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.isAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: 'Administrator access required' });
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return undefined;
}
