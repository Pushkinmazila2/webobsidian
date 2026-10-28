import { randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata } from '@node-saml/node-saml';
import type { IdentityProvider } from '../db/index.js';
import { callbackUrl, SamlConfig, SsoError, type ExternalProfile } from './sso.js';

/**
 * SAML 2.0 service provider (SP-initiated Web Browser SSO, HTTP-Redirect request, HTTP-POST response).
 * The IdP's signature on the assertion is mandatory unless the provider is configured otherwise; audience, time window and
 * InResponseTo are checked by node-saml.
 */

const instances = new Map<string, SAML>();

export function samlFor(p: IdentityProvider, reqBase: string): { saml: SAML; c: SamlConfig; acs: string } {
  const c = SamlConfig.parse(p.config);
  const acs = callbackUrl(reqBase, p.id, 'acs');
  const key = `${p.id}:${p.updatedAt}:${acs}`;
  let saml = instances.get(key);
  if (!saml) {
    saml = new SAML({
      callbackUrl: acs,
      entryPoint: c.entryPoint,
      issuer: c.issuer,
      audience: c.issuer,
      idpCert: c.cert,
      ...(c.idpIssuer ? { idpIssuer: c.idpIssuer } : {}),
      wantAssertionsSigned: c.wantAssertionsSigned,
      wantAuthnResponseSigned: false,
      // Responses to requests we made must answer them; an IdP-initiated response (no InResponseTo) is refused.
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 10 * 60_000,
      acceptedClockSkewMs: 60_000,
      disableRequestedAuthnContext: true,
    });
    instances.set(key, saml);
  }
  return { saml, c, acs };
}

/** RelayState is opaque and short; what it stands for is kept here for the ten minutes a sign-in may take. */
const relay = new Map<string, { pid: string; returnTo: string; exp: number }>();
export function newRelay(pid: string, returnTo: string): string {
  const now = Date.now();
  for (const [k, v] of relay) if (v.exp < now) relay.delete(k);
  const id = randomBytes(16).toString('hex');
  relay.set(id, { pid, returnTo, exp: now + 10 * 60_000 });
  return id;
}
export function takeRelay(id: unknown): { pid: string; returnTo: string } | null {
  if (typeof id !== 'string') return null;
  const v = relay.get(id);
  relay.delete(id);
  return v && v.exp >= Date.now() ? v : null;
}

export async function samlLoginUrl(p: IdentityProvider, reqBase: string, relayState: string): Promise<string> {
  const { saml } = samlFor(p, reqBase);
  return saml.getAuthorizeUrlAsync(relayState, undefined, {});
}

export function samlMetadata(p: IdentityProvider, reqBase: string): string {
  const { c, acs } = samlFor(p, reqBase);
  return generateServiceProviderMetadata({ issuer: c.issuer, callbackUrl: acs, wantAssertionsSigned: c.wantAssertionsSigned });
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => asStrings(x)) : typeof v === 'string' && v ? [v] : typeof v === 'number' ? [String(v)] : [];

/** Validate the POSTed response and turn the assertion into a profile. Throws SsoError when it does not hold up. */
export async function samlProfile(p: IdentityProvider, reqBase: string, body: Record<string, unknown>): Promise<ExternalProfile> {
  const { saml, c } = samlFor(p, reqBase);
  let result;
  try {
    result = await saml.validatePostResponseAsync({ SAMLResponse: String(body.SAMLResponse ?? ''), RelayState: String(body.RelayState ?? '') });
  } catch (e) {
    throw new SsoError(`SAML response rejected: ${e instanceof Error ? e.message : e}`, 401);
  }
  const profile = result.profile;
  if (!profile || result.loggedOut) throw new SsoError('SAML response carried no sign-in', 401);
  const attrs = ((profile as { attributes?: Record<string, unknown> }).attributes ?? profile) as Record<string, unknown>;
  const first = (name: string): string | null => (name ? (asStrings(attrs[name])[0] ?? null) : null);
  const nameId = String(profile.nameID ?? '');
  if (!nameId) throw new SsoError('SAML assertion has no subject', 502);
  const email = first(c.emailAttribute) ?? (nameId.includes('@') ? nameId : null);
  return {
    provider: p,
    issuer: c.idpIssuer || String(profile.issuer ?? p.id),
    subject: nameId,
    email,
    // A signed assertion from the IdP we trust is as good as a verified address.
    emailVerified: email ? true : undefined,
    username: first(c.usernameAttribute) ?? (email ? email.split('@')[0] : null),
    displayName: first(c.nameAttribute),
    groups: asStrings(attrs[c.groupsClaim]),
  };
}
