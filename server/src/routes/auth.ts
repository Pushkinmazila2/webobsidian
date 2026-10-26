import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth, sessionToken } from '../middleware/auth.js';
import {
  isPasswordSet,
  ownerMustChangePassword,
  loginWithPassword,
  changePassword,
  authenticateToken,
  startSession,
  MIN_PASSWORD_LEN,
  SESSION_TTL_SECONDS,
} from '../services/auth.js';
import { getUserStore } from '../db/index.js';
import { loginRateLimit, recordLoginFailure, clearLoginFailures } from '../middleware/ratelimit.js';

export const authRouter = Router();

// A `Secure` cookie is silently dropped by browsers over plain http://, so tying
// it to NODE_ENV broke HTTP-only self-hosting (every API call 401'd → blank UI).
// Default 'auto' = match the request's actual transport (honours X-Forwarded-Proto
// via `trust proxy`); set COOKIE_SECURE=true/false to force.
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();

function cookieOpts(req: Request) {
  const secure =
    COOKIE_SECURE === 'true' ? true : COOKIE_SECURE === 'false' ? false : req.secure;
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  };
}

authRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    // mustChangePassword=true ⇒ still on the default 123456; the UI forces a change.
    res.json({ passwordSet: await isPasswordSet(), mustChangePassword: await ownerMustChangePassword() });
  }),
);

authRouter.post(
  '/setup',
  asyncHandler(async (req, res) => {
    if (await isPasswordSet()) {
      res.status(409).json({ error: 'Password already set' });
      return;
    }
    const { password } = req.body ?? {};
    if (typeof password !== 'string') {
      res.status(400).json({ error: 'password required' });
      return;
    }
    res.status(409).json({ error: 'Password already set' });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'currentPassword and newPassword required' });
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
      return;
    }
    try {
      await changePassword(req.user!.id, currentPassword, newPassword, req.user!.sessionId);
    } catch {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/login',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    // `username` is optional: a bare password signs in as the owner (single-user behaviour).
    const { username, password } = req.body ?? {};
    if (typeof password !== 'string' || (username !== undefined && typeof username !== 'string')) {
      res.status(400).json({ error: 'password required' });
      return;
    }
    const user = await loginWithPassword(username, password);
    if (!user) {
      recordLoginFailure(req);
      res.status(401).json({ error: username ? 'Invalid username or password' : 'Invalid password' });
      return;
    }
    clearLoginFailures(req);
    const { token } = await startSession(user, { userAgent: req.headers['user-agent'] ?? null, ip: req.socket.remoteAddress ?? null });
    res
      .cookie(COOKIE_NAME, token, cookieOpts(req))
      .json({ ok: true, mustChangePassword: user.mustChangePassword, user: publicUser(user) });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = sessionToken(req);
    const user = token ? await authenticateToken(token) : null;
    if (user) await getUserStore().revokeSession(user.sessionId);
    res.clearCookie(COOKIE_NAME, { path: '/' }).json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const u = req.user!;
    const groups = (await getUserStore().listGroupsOfUser(u.id)).map((g) => g.name);
    res.json({
      authenticated: true,
      mustChangePassword: u.mustChangePassword,
      user: { id: u.id, username: u.username, displayName: u.displayName, email: u.email, isAdmin: u.isAdmin, groups },
    });
  }),
);

/** The caller's own active sessions (devices). */
authRouter.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const list = await getUserStore().listSessions(req.user!.id);
    res.json({
      sessions: list.map((x) => ({
        id: x.id, createdAt: x.createdAt, lastSeenAt: x.lastSeenAt, userAgent: x.userAgent, ip: x.ip, current: x.id === req.user!.sessionId,
      })),
    });
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    const target = await store.getSession(String(req.params.id));
    if (!target || target.userId !== req.user!.id) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await store.revokeSession(target.id);
    res.json({ ok: true });
  }),
);

/** Sign out everywhere else. */
authRouter.post(
  '/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, revoked: await getUserStore().revokeUserSessions(req.user!.id, req.user!.sessionId) });
  }),
);

function publicUser(u: { id: string; username: string; displayName: string; email: string | null; isAdmin: boolean }) {
  return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, isAdmin: u.isAdmin };
}
