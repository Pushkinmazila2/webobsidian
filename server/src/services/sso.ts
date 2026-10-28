import { z } from 'zod';
import * as oidc from 'openid-client';
import { getUserStore, type IdentityProvider, type User, type UserSource } from '../db/index.js';
import { config } from '../config.js';

/**
 * Single sign-on: OIDC (this file) and SAML (services/saml.ts) both end in `signInExternal`, which turns what the
 * identity provider asserted (who, e-mail, groups) into a local account, keeps its groups in step and returns the user.
 */

// ---- provider settings ------------------------------------------------------------
const Provisioning = {
  // Create a local account the first time someone signs in. Off = only accounts that already exist (or SCIM created) may sign in.
  autoProvision: z.boolean().default(true),
  // Attach the sign-in to an existing LOCAL account with the same (verified) e-mail. Off by default: it lets the IdP take over that account.
  autoLinkByEmail: z.boolean().default(false),
  // IdP group name → local group name. Unmapped groups keep their own name.
  groupMap: z.record(z.string()).default({}),
  // Create local groups for IdP groups that do not exist yet.
  createGroups: z.boolean().default(true),
  // Members of any of these IdP groups are administrators (re-evaluated at every sign-in, for externally managed accounts only).
  adminGroups: z.array(z.string()).default([]),
  groupsClaim: z.string().default('groups'),
};

export const OidcConfig = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  // Prefer `clientSecretEnv` (name of an environment variable) over storing the secret itself.
  clientSecret: z.string().default(''),
  clientSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).or(z.literal('')).default(''),
  scopes: z.string().default('openid profile email'),
  usernameClaim: z.string().default('preferred_username'),
  emailClaim: z.string().default('email'),
  nameClaim: z.string().default('name'),
  // Ask the userinfo endpoint for groups when the ID token has none.
  groupsFromUserinfo: z.boolean().default(false),
  // Development only: allow an http:// issuer.
  allowInsecureHttp: z.boolean().default(false),
  ...Provisioning,
});
export type OidcConfig = z.infer<typeof OidcConfig>;

export const SamlConfig = z.object({
  entryPoint: z.string().url(), // IdP single sign-on URL
  issuer: z.string().min(1), // our SP entity id
  idpIssuer: z.string().default(''), // expected <Issuer> of the IdP (empty = not checked)
  cert: z.string().min(20), // IdP signing certificate (PEM or bare base64)
  emailAttribute: z.string().default('email'),
  usernameAttribute: z.string().default(''), // empty = e-mail / NameID
  nameAttribute: z.string().default('displayName'),
  wantAssertionsSigned: z.boolean().default(true),
  ...Provisioning,
  groupsClaim: z.string().default('groups'),
});
export type SamlConfig = z.infer<typeof SamlConfig>;

export type ProviderConfig = OidcConfig | SamlConfig;

export function parseProviderConfig(type: 'oidc' | 'saml', raw: unknown): OidcConfig | SamlConfig {
  return (type === 'oidc' ? OidcConfig : SamlConfig).parse(raw) as OidcConfig | SamlConfig;
}

/** The client secret a provider uses: its environment variable wins over the stored value. */
export const oidcSecret = (c: OidcConfig): string => (c.clientSecretEnv ? (process.env[c.clientSecretEnv] ?? '') : c.clientSecret);

/** Secrets never leave the server. */
export function redactProvider(p: IdentityProvider) {
  const c = { ...p.config };
  const had = Boolean(c.clientSecret);
  if ('clientSecret' in c) c.clientSecret = had ? '••••••••' : '';
  return { id: p.id, type: p.type, name: p.name, enabled: p.enabled, managed: p.managed, config: c, createdAt: p.createdAt };
}

// ---- external sign-in --------------------------------------------------------------
export interface ExternalProfile {
  provider: IdentityProvider;
  /** Stable id of the IdP (OIDC issuer / SAML IdP entity id) — with `subject` it identifies the person. */
  issuer: string;
  subject: string;
  email?: string | null;
  emailVerified?: boolean;
  username?: string | null;
  displayName?: string | null;
  groups: string[];
}

export class SsoError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message);
  }
}

const USERNAME_OK = /^[a-z0-9][a-z0-9._@+-]{0,63}$/i;

async function freeUsername(candidates: (string | null | undefined)[]): Promise<string> {
  const store = getUserStore();
  const base =
    candidates
      .map((c) => (c ?? '').trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, '-'))
      .find((c) => USERNAME_OK.test(c)) ?? 'user';
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? base : `${base.slice(0, 58)}-${i + 1}`;
    if (!(await store.getUserByUsername(name))) return name;
  }
  throw new SsoError('Could not pick a username', 500);
}

export async function signInExternal(p: ExternalProfile): Promise<User> {
  const store = getUserStore();
  const cfg = p.provider.config as unknown as Pick<OidcConfig, 'autoProvision' | 'autoLinkByEmail'>;
  const source: UserSource = p.provider.type;
  const email = p.email?.trim().toLowerCase() || null;

  let user = await store.findByIdentity(p.provider.type, p.issuer, p.subject);
  if (!user) {
    // An account an administrator (or SCIM) prepared for this person: same external id, or same e-mail.
    const prepared = (p.subject ? await store.getUserByExternalId(p.subject) : undefined) ?? (email && p.emailVerified !== false ? await store.getUserByEmail(email) : undefined);
    if (prepared && (prepared.source === 'scim' || prepared.source === 'config' || prepared.externalId === p.subject)) user = prepared;
    // …or a local account, only when the provider is explicitly trusted to vouch for e-mails.
    else if (prepared && cfg.autoLinkByEmail && p.emailVerified === true && email) user = prepared;
    if (user) await store.linkIdentity(user.id, p.provider.type, p.issuer, p.subject);
  }
  if (!user) {
    if (!cfg.autoProvision) throw new SsoError('This account is not provisioned for sign-in. Ask an administrator.');
    const hint = p.username || (email ? email.split('@')[0] : null);
    user = await store.createUser({
      username: await freeUsername([p.username, hint, p.subject]),
      email,
      displayName: p.displayName ?? '',
      source,
      isAdmin: false,
      mustChangePassword: false,
    });
    await store.linkIdentity(user.id, p.provider.type, p.issuer, p.subject);
    console.log(`[sso] created account "${user.username}" from ${p.provider.name}`);
  }
  if (user.disabled) throw new SsoError('This account is disabled.');

  // Keep the profile fresh without overriding what an administrator typed for local accounts.
  const patch: Parameters<typeof store.updateUser>[1] = {};
  if (user.source !== 'local' && user.source !== 'config') {
    if (p.displayName && p.displayName !== user.displayName) patch.displayName = p.displayName;
    if (email && email !== user.email && !(await store.getUserByEmail(email))) patch.email = email;
  }
  if (Object.keys(patch).length) user = (await store.updateUser(user.id, patch)) ?? user;

  return syncGroups(user, p);
}

/** Mirror the IdP's group claims into local memberships (source `idp`) and the admin flag. */
async function syncGroups(user: User, p: ExternalProfile): Promise<User> {
  const store = getUserStore();
  const c = p.provider.config as unknown as Pick<OidcConfig, 'groupMap' | 'createGroups' | 'adminGroups'>;
  const ids: string[] = [];
  for (const raw of new Set(p.groups)) {
    const name = c.groupMap?.[raw] ?? raw;
    let g = await store.getGroupByName(name);
    if (!g && c.createGroups) g = await store.createGroup({ name, source: p.provider.type });
    if (g) ids.push(g.id);
  }
  await store.syncUserGroups(user.id, ids, 'idp');

  const adminGroups = c.adminGroups ?? [];
  if (adminGroups.length && user.source !== 'local') {
    const shouldBeAdmin = p.groups.some((g) => adminGroups.includes(g));
    if (shouldBeAdmin !== user.isAdmin) {
      // Never leave the instance without an administrator because of a directory change.
      if (shouldBeAdmin || (await store.countAdmins()) > 1) user = (await store.updateUser(user.id, { isAdmin: shouldBeAdmin })) ?? user;
    }
  }
  return user;
}

// ---- OIDC ----------------------------------------------------------------------------
const discovered = new Map<string, { at: number; cfg: oidc.Configuration }>();
const DISCOVERY_TTL_MS = 3600_000;

export async function oidcConfiguration(p: IdentityProvider): Promise<{ conf: oidc.Configuration; c: OidcConfig }> {
  const c = OidcConfig.parse(p.config);
  const key = `${p.id}:${p.updatedAt}`;
  const hit = discovered.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return { conf: hit.cfg, c };
  const secret = oidcSecret(c);
  const conf = await oidc.discovery(
    new URL(c.issuer),
    c.clientId,
    secret ? { client_secret: secret } : undefined,
    secret ? oidc.ClientSecretPost(secret) : oidc.None(),
    c.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
  discovered.set(key, { at: Date.now(), cfg: conf });
  return { conf, c };
}

/** Where the IdP sends people back to: PUBLIC_URL, or the address the request came in on. */
export function callbackUrl(reqBase: string, providerId: string, kind: 'callback' | 'acs' = 'callback'): string {
  return `${config.publicUrl || reqBase}/auth/sso/${encodeURIComponent(providerId)}/${kind}`;
}

export const claimString = (claims: Record<string, unknown>, name: string): string | null => {
  const v = claims[name];
  return typeof v === 'string' && v ? v : null;
};

export function claimStrings(claims: Record<string, unknown>, name: string): string[] {
  const v = claims[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return typeof v === 'string' && v ? [v] : [];
}

export { oidc };
