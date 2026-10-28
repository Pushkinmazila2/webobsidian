import express, { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME } from '../middleware/auth.js';
import { cookieOpts } from './auth.js';
import { getSsoStore, type IdentityProvider } from '../db/index.js';
import { getSettings } from '../services/settings.js';
import { startSession } from '../services/auth.js';
import {
  oidc, oidcConfiguration, callbackUrl, claimString, claimStrings, signInExternal, SsoError, type ExternalProfile,
} from '../services/sso.js';
import { newRelay, takeRelay, samlLoginUrl, samlMetadata, samlProfile } from '../services/saml.js';

/**
 * Single sign-on entry points (no session needed):
 *   GET  /auth/sso/providers        enabled providers, for the sign-in page
 *   GET  /auth/sso/:id/login        start (redirect to the identity provider)
 *   GET  /auth/sso/:id/callback     OIDC redirect back
 */
export const ssoRouter = Router();

const STATE_COOKIE = 'wo_sso';
const STATE_TTL_S = 600;

interface FlowState {
  pid: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

/** Only same-site paths: `returnTo` must not become an open redirect. */
export function safeReturnTo(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') ? s : '/';
}

const baseUrl = (req: Request): string => `${req.protocol}://${req.get('host')}`;

async function signState(s: FlowState): Promise<string> {
  return jwt.sign({ ...s, aud: 'sso' }, (await getSettings()).auth.jwtSecret, { algorithm: 'HS256', expiresIn: STATE_TTL_S });
}
async function readState(req: Request): Promise<FlowState | null> {
  const raw = req.cookies?.[STATE_COOKIE];
  if (typeof raw !== 'string') return null;
  try {
    const p = jwt.verify(raw, (await getSettings()).auth.jwtSecret, { algorithms: ['HS256'], audience: 'sso' }) as FlowState;
    return typeof p.pid === 'string' ? p : null;
  } catch {
    return null;
  }
}

const stateCookieOpts = (req: Request) => ({ ...cookieOpts(req), maxAge: STATE_TTL_S * 1000, path: '/auth/sso' });

async function loadProvider(id: string, type: 'oidc' | 'saml'): Promise<IdentityProvider> {
  const p = await getSsoStore().getProvider(id);
  if (!p || !p.enabled || p.type !== type) throw Object.assign(new Error('Unknown sign-in provider'), { status: 404 });
  return p;
}

/** Back to the app with a short, generic reason (details stay in the server log). */
function failure(res: Response, e: unknown, where: string): void {
  const status = e instanceof SsoError ? e.status : 0;
  console.warn(`[sso] ${where} failed:`, e instanceof Error ? e.message : e);
  const msg = e instanceof SsoError && status === 403 ? e.message : 'Sign-in failed';
  res.clearCookie(STATE_COOKIE, { path: '/auth/sso' }).redirect(`/?sso_error=${encodeURIComponent(msg)}`);
}

/** Finish: session cookie + back to where the person was going. */
export async function completeSignIn(req: Request, res: Response, profile: ExternalProfile, returnTo: string): Promise<void> {
  const user = await signInExternal(profile);
  const { token } = await startSession(user, { userAgent: req.headers['user-agent'] ?? null, ip: req.socket.remoteAddress ?? null });
  res.clearCookie(STATE_COOKIE, { path: '/auth/sso' }).cookie(COOKIE_NAME, token, cookieOpts(req)).redirect(safeReturnTo(returnTo));
}

ssoRouter.get(
  '/providers',
  asyncHandler(async (_req, res) => {
    const list = (await getSsoStore().listProviders()).filter((p) => p.enabled);
    res.json({ providers: list.map((p) => ({ id: p.id, name: p.name, type: p.type })) });
  }),
);

ssoRouter.get(
  '/:id/login',
  asyncHandler(async (req, res) => {
    const found = await getSsoStore().getProvider(String(req.params.id));
    if (found?.enabled && found.type === 'saml') {
      try {
        res.redirect(await samlLoginUrl(found, baseUrl(req), newRelay(found.id, safeReturnTo(req.query.returnTo))));
      } catch (e) {
        failure(res, e, 'saml login');
      }
      return;
    }
    const p = await loadProvider(String(req.params.id), 'oidc');
    try {
      const { conf, c } = await oidcConfiguration(p);
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(conf, {
        redirect_uri: callbackUrl(baseUrl(req), p.id),
        scope: c.scopes,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      res.cookie(STATE_COOKIE, await signState({ pid: p.id, state, nonce, verifier, returnTo: safeReturnTo(req.query.returnTo) }), stateCookieOpts(req));
      res.redirect(url.href);
    } catch (e) {
      failure(res, e, 'login');
    }
  }),
);

ssoRouter.get(
  '/:id/callback',
  asyncHandler(async (req, res) => {
    const p = await loadProvider(String(req.params.id), 'oidc');
    try {
      const st = await readState(req);
      if (!st || st.pid !== p.id) throw new SsoError('The sign-in expired. Try again.');
      const { conf, c } = await oidcConfiguration(p);
      const current = new URL(`${callbackUrl(baseUrl(req), p.id)}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
      const tokens = await oidc.authorizationCodeGrant(conf, current, {
        pkceCodeVerifier: st.verifier,
        expectedState: st.state,
        expectedNonce: st.nonce,
        idTokenExpected: true,
      });
      const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
      const sub = claimString(claims, 'sub');
      if (!sub) throw new SsoError('The identity provider sent no subject', 502);
      let groups = claimStrings(claims, c.groupsClaim);
      if (!groups.length && c.groupsFromUserinfo) {
        const info = (await oidc.fetchUserInfo(conf, tokens.access_token, sub)) as Record<string, unknown>;
        groups = claimStrings(info, c.groupsClaim);
      }
      const email = claimString(claims, c.emailClaim);
      await completeSignIn(req, res, {
        provider: p,
        issuer: c.issuer,
        subject: sub,
        email,
        emailVerified: typeof claims.email_verified === 'boolean' ? claims.email_verified : undefined,
        username: claimString(claims, c.usernameClaim),
        displayName: claimString(claims, c.nameClaim),
        groups,
      }, st.returnTo);
    } catch (e) {
      failure(res, e, 'callback');
    }
  }),
);

// ---- SAML ---------------------------------------------------------------------------------
// The IdP POSTs the response from another site, so no cookie of ours comes along: RelayState ties it back to the request.
ssoRouter.post(
  '/:id/acs',
  express.urlencoded({ extended: false, limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const p = await loadProvider(String(req.params.id), 'saml');
    try {
      const relay = takeRelay(req.body?.RelayState);
      if (!relay || relay.pid !== p.id) throw new SsoError('The sign-in expired. Try again.');
      await completeSignIn(req, res, await samlProfile(p, baseUrl(req), req.body ?? {}), relay.returnTo);
    } catch (e) {
      failure(res, e, 'saml acs');
    }
  }),
);

/** Service-provider metadata to hand to the IdP administrator. */
ssoRouter.get(
  '/:id/metadata',
  asyncHandler(async (req, res) => {
    const p = await loadProvider(String(req.params.id), 'saml');
    res.type('application/samlmetadata+xml').send(samlMetadata(p, baseUrl(req)));
  }),
);
