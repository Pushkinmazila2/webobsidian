import { Router, type NextFunction, type Request, type Response } from 'express';
import { getUserStore, getSsoStore, getAclStore, type Group, type User } from '../db/index.js';
import { hashApiKey } from '../services/auth.js';
import { refreshAcl } from '../services/acl.js';

/**
 * SCIM 2.0 (RFC 7643/7644) — lets an identity provider create, update and deactivate accounts and groups without anyone
 * signing in. Authenticated with a bearer token made in the admin API (`/api/admin/scim-tokens`).
 *
 * Boundaries: SCIM only manages accounts and groups that came from the directory (source scim/oidc/saml). It can never touch
 * local or config-file accounts, never grants administrator rights (that is `adminGroups` of the provider) and never
 * deactivates the last administrator.
 */
export const scimRouter = Router();

const CT = 'application/scim+json';
const S = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
};
const DIRECTORY = new Set(['scim', 'oidc', 'saml']);
const USERNAME_OK = /^[a-z0-9][a-z0-9._@+-]{0,63}$/i;

class ScimError extends Error {
  constructor(readonly status: number, message: string, readonly scimType?: string) {
    super(message);
  }
}

const send = (res: Response, status: number, body: unknown) => res.status(status).type(CT).send(JSON.stringify(body));

scimRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  const raw = h?.startsWith('Bearer ') ? h.slice(7) : '';
  const tok = raw ? await getSsoStore().findScimToken(hashApiKey(raw)) : undefined;
  if (!tok) return void send(res, 401, { schemas: [S.error], status: '401', detail: 'Invalid or missing bearer token' });
  void getSsoStore().touchScimToken(tok.id).catch(() => {});
  next();
});

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((e) => {
    if (e instanceof ScimError) return void send(res, e.status, { schemas: [S.error], status: String(e.status), ...(e.scimType ? { scimType: e.scimType } : {}), detail: e.message });
    next(e);
  });
};

const loc = (req: Request, kind: 'Users' | 'Groups', id: string) => `${req.protocol}://${req.get('host')}/scim/v2/${kind}/${id}`;

// ---- discovery ------------------------------------------------------------------------
scimRouter.get('/ServiceProviderConfig', (_req, res) =>
  send(res, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Token from Settings → Users → SCIM' }],
  }),
);
scimRouter.get('/ResourceTypes', (_req, res) =>
  send(res, 200, {
    schemas: [S.list], totalResults: 2, startIndex: 1, itemsPerPage: 2,
    Resources: [
      { id: 'User', name: 'User', endpoint: '/Users', schema: S.user },
      { id: 'Group', name: 'Group', endpoint: '/Groups', schema: S.group },
    ],
  }),
);
scimRouter.get('/Schemas', (_req, res) => send(res, 200, { schemas: [S.list], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }));

// ---- helpers ---------------------------------------------------------------------------
function userJson(req: Request, u: User) {
  return {
    schemas: [S.user],
    id: u.id,
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: u.username,
    displayName: u.displayName || u.username,
    name: { formatted: u.displayName || u.username },
    ...(u.email ? { emails: [{ value: u.email, primary: true, type: 'work' }] } : {}),
    active: !u.disabled,
    meta: { resourceType: 'User', created: u.createdAt, lastModified: u.updatedAt, location: loc(req, 'Users', u.id) },
  };
}

async function groupJson(req: Request, g: Group) {
  const members = await getUserStore().listMembers(g.id);
  return {
    schemas: [S.group],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.name,
    members: members.map((m) => ({ value: m.id, display: m.username, $ref: loc(req, 'Users', m.id) })),
    meta: { resourceType: 'Group', created: g.createdAt, lastModified: g.updatedAt, location: loc(req, 'Groups', g.id) },
  };
}

/** `attr eq "value"` — the only filter identity providers use to look an object up. */
function parseFilter(raw: unknown): { attr: string; value: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const m = /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  if (!m) throw new ScimError(400, 'Only filters of the form: attribute eq "value"', 'invalidFilter');
  return { attr: m[1].toLowerCase(), value: m[2].replace(/\\(.)/g, '$1') };
}

function page<T>(req: Request, items: T[]) {
  const start = Math.max(1, Number(req.query.startIndex ?? 1) || 1);
  const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100) || 0));
  return { start, slice: items.slice(start - 1, start - 1 + count) };
}

const boolish = (v: unknown): boolean => (typeof v === 'string' ? v.toLowerCase() === 'true' : Boolean(v));

async function assertLastAdmin(u: User): Promise<void> {
  if (u.isAdmin && !u.disabled && (await getUserStore().countAdmins()) <= 1) throw new ScimError(409, 'This is the last enabled administrator', 'mutability');
}

async function managedUser(id: string): Promise<User> {
  const u = await getUserStore().getUser(id);
  if (!u) throw new ScimError(404, 'User not found');
  if (!DIRECTORY.has(u.source)) throw new ScimError(403, 'This account is managed locally, not by the directory', 'mutability');
  return u;
}

async function managedGroup(id: string): Promise<Group> {
  const g = await getUserStore().getGroup(id);
  if (!g) throw new ScimError(404, 'Group not found');
  if (!DIRECTORY.has(g.source)) throw new ScimError(403, 'This group is managed locally, not by the directory', 'mutability');
  return g;
}

interface UserFields {
  userName?: string;
  externalId?: string | null;
  displayName?: string;
  email?: string | null;
  active?: boolean;
}

/** Read the writable attributes out of a User resource (POST/PUT body). */
function userFields(b: Record<string, unknown>): UserFields {
  const out: UserFields = {};
  if (typeof b.userName === 'string') out.userName = b.userName;
  if ('externalId' in b) out.externalId = typeof b.externalId === 'string' && b.externalId ? b.externalId : null;
  const name = b.name as Record<string, unknown> | undefined;
  if (typeof b.displayName === 'string') out.displayName = b.displayName;
  else if (name && typeof name.formatted === 'string') out.displayName = name.formatted;
  else if (name && (typeof name.givenName === 'string' || typeof name.familyName === 'string')) out.displayName = [name.givenName, name.familyName].filter((x) => typeof x === 'string').join(' ');
  if (Array.isArray(b.emails)) {
    const e = (b.emails as { value?: unknown; primary?: unknown }[]).find((x) => x.primary) ?? (b.emails as { value?: unknown }[])[0];
    out.email = e && typeof e.value === 'string' ? e.value : null;
  }
  if ('active' in b) out.active = boolish(b.active);
  return out;
}

async function applyUser(req: Request, u: User, f: UserFields): Promise<User> {
  const store = getUserStore();
  if (f.userName !== undefined) {
    if (!USERNAME_OK.test(f.userName)) throw new ScimError(400, 'userName: letters, digits and . _ @ + - only', 'invalidValue');
    const other = await store.getUserByUsername(f.userName);
    if (other && other.id !== u.id) throw new ScimError(409, 'userName already taken', 'uniqueness');
  }
  if (f.email) {
    const other = await store.getUserByEmail(f.email);
    if (other && other.id !== u.id) throw new ScimError(409, 'e-mail already used by another account', 'uniqueness');
  }
  if (f.active === false && !u.disabled) await assertLastAdmin(u);
  const next = await store.updateUser(u.id, {
    ...(f.userName !== undefined ? { username: f.userName } : {}),
    ...(f.externalId !== undefined ? { externalId: f.externalId } : {}),
    ...(f.displayName !== undefined ? { displayName: f.displayName } : {}),
    ...(f.email !== undefined ? { email: f.email } : {}),
    ...(f.active !== undefined ? { disabled: !f.active } : {}),
  });
  if (f.active === false) await store.revokeUserSessions(u.id); // deprovisioned = signed out everywhere, at once
  void req;
  return next ?? u;
}

// ---- Users --------------------------------------------------------------------------------
scimRouter.get('/Users', wrap(async (req, res) => {
  const f = parseFilter(req.query.filter);
  let users = await getUserStore().listUsers();
  if (f) {
    users = users.filter((u) =>
      f.attr === 'username' ? u.username === f.value.toLowerCase()
      : f.attr === 'externalid' ? u.externalId === f.value
      : f.attr === 'emails.value' || f.attr === 'email' ? u.email === f.value.toLowerCase()
      : f.attr === 'id' ? u.id === f.value
      : false,
    );
  }
  const { start, slice } = page(req, users);
  send(res, 200, { schemas: [S.list], totalResults: users.length, startIndex: start, itemsPerPage: slice.length, Resources: slice.map((u) => userJson(req, u)) });
}));

scimRouter.get('/Users/:id', wrap(async (req, res) => {
  const u = await getUserStore().getUser(String(req.params.id));
  if (!u) throw new ScimError(404, 'User not found');
  send(res, 200, userJson(req, u));
}));

scimRouter.post('/Users', wrap(async (req, res) => {
  const f = userFields(req.body ?? {});
  if (!f.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
  if (!USERNAME_OK.test(f.userName)) throw new ScimError(400, 'userName: letters, digits and . _ @ + - only', 'invalidValue');
  const store = getUserStore();
  if (await store.getUserByUsername(f.userName)) throw new ScimError(409, 'userName already taken', 'uniqueness');
  if (f.email && (await store.getUserByEmail(f.email))) throw new ScimError(409, 'e-mail already used by another account', 'uniqueness');
  const u = await store.createUser({
    username: f.userName,
    email: f.email ?? null,
    displayName: f.displayName ?? '',
    externalId: f.externalId ?? null,
    disabled: f.active === false,
    source: 'scim',
  });
  send(res, 201, userJson(req, u));
}));

scimRouter.put('/Users/:id', wrap(async (req, res) => {
  const u = await managedUser(String(req.params.id));
  const f = userFields(req.body ?? {});
  if (f.active === undefined) f.active = true; // PUT replaces: absent means default
  send(res, 200, userJson(req, await applyUser(req, u, f)));
}));

/** PATCH operations → the same field set as PUT. */
function patchUserFields(ops: unknown): UserFields {
  if (!Array.isArray(ops)) throw new ScimError(400, 'Operations required', 'invalidSyntax');
  const merged: Record<string, unknown> = {};
  for (const op of ops as { op?: string; path?: string; value?: unknown }[]) {
    const kind = String(op.op ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw new ScimError(400, `Unsupported op ${op.op}`, 'invalidSyntax');
    const path = (op.path ?? '').toLowerCase();
    const value = kind === 'remove' ? null : op.value;
    if (!path) {
      if (value && typeof value === 'object') Object.assign(merged, value);
      continue;
    }
    if (path === 'active') merged.active = value;
    else if (path === 'username') merged.userName = value;
    else if (path === 'displayname' || path === 'name.formatted') merged.displayName = value ?? '';
    else if (path === 'externalid') merged.externalId = value;
    else if (path === 'name.givenname' || path === 'name.familyname') continue; // part of a name: displayName is what we keep
    else if (path === 'emails' || path.startsWith('emails[') || path === 'emails.value') merged.emails = Array.isArray(value) ? value : value === null ? [] : [{ value: typeof value === 'object' ? (value as { value?: unknown }).value : value, primary: true }];
  }
  return userFields(merged);
}

scimRouter.patch('/Users/:id', wrap(async (req, res) => {
  const u = await managedUser(String(req.params.id));
  send(res, 200, userJson(req, await applyUser(req, u, patchUserFields(req.body?.Operations))));
}));

scimRouter.delete('/Users/:id', wrap(async (req, res) => {
  const u = await managedUser(String(req.params.id));
  await assertLastAdmin(u);
  await getUserStore().deleteUser(u.id);
  await getAclStore().deleteRulesForSubject('user', u.id);
  await refreshAcl();
  res.status(204).end();
}));

// ---- Groups -------------------------------------------------------------------------------
async function setMembers(g: Group, ids: string[]): Promise<void> {
  const store = getUserStore();
  const want = new Set(ids);
  for (const m of await store.listMembers(g.id)) if (!want.has(m.id)) await store.removeMember(g.id, m.id);
  for (const id of want) {
    if (!(await store.getUser(id))) throw new ScimError(400, `Unknown member ${id}`, 'invalidValue');
    await store.addMember(g.id, id, 'scim');
  }
}

const memberIds = (v: unknown): string[] => (Array.isArray(v) ? (v as { value?: unknown }[]).map((m) => m.value).filter((x): x is string => typeof x === 'string') : []);

scimRouter.get('/Groups', wrap(async (req, res) => {
  const f = parseFilter(req.query.filter);
  let groups = await getUserStore().listGroups();
  if (f) groups = groups.filter((g) => (f.attr === 'displayname' ? g.name.toLowerCase() === f.value.toLowerCase() : f.attr === 'externalid' ? g.externalId === f.value : f.attr === 'id' ? g.id === f.value : false));
  const { start, slice } = page(req, groups);
  send(res, 200, { schemas: [S.list], totalResults: groups.length, startIndex: start, itemsPerPage: slice.length, Resources: await Promise.all(slice.map((g) => groupJson(req, g))) });
}));

scimRouter.get('/Groups/:id', wrap(async (req, res) => {
  const g = await getUserStore().getGroup(String(req.params.id));
  if (!g) throw new ScimError(404, 'Group not found');
  send(res, 200, await groupJson(req, g));
}));

scimRouter.post('/Groups', wrap(async (req, res) => {
  const name = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  if (!name) throw new ScimError(400, 'displayName is required', 'invalidValue');
  const store = getUserStore();
  if (await store.getGroupByName(name)) throw new ScimError(409, 'A group with this name already exists', 'uniqueness');
  const g = await store.createGroup({ name, source: 'scim', externalId: typeof req.body.externalId === 'string' ? req.body.externalId : null });
  await setMembers(g, memberIds(req.body.members));
  send(res, 201, await groupJson(req, g));
}));

scimRouter.put('/Groups/:id', wrap(async (req, res) => {
  const g = await managedGroup(String(req.params.id));
  const store = getUserStore();
  const name = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : g.name;
  if (name.toLowerCase() !== g.name.toLowerCase() && (await store.getGroupByName(name))) throw new ScimError(409, 'A group with this name already exists', 'uniqueness');
  const upd = (await store.updateGroup(g.id, { name, externalId: typeof req.body?.externalId === 'string' ? req.body.externalId : g.externalId })) ?? g;
  await setMembers(upd, memberIds(req.body?.members));
  send(res, 200, await groupJson(req, upd));
}));

scimRouter.patch('/Groups/:id', wrap(async (req, res) => {
  let g = await managedGroup(String(req.params.id));
  const store = getUserStore();
  const ops = req.body?.Operations;
  if (!Array.isArray(ops)) throw new ScimError(400, 'Operations required', 'invalidSyntax');
  for (const op of ops as { op?: string; path?: string; value?: unknown }[]) {
    const kind = String(op.op ?? '').toLowerCase();
    const path = op.path ?? '';
    if (/^displayname$/i.test(path) || (!path && op.value && typeof op.value === 'object' && 'displayName' in (op.value as object))) {
      const name = String(path ? op.value : (op.value as { displayName: unknown }).displayName).trim();
      if (name && name.toLowerCase() !== g.name.toLowerCase() && (await store.getGroupByName(name))) throw new ScimError(409, 'A group with this name already exists', 'uniqueness');
      if (name) g = (await store.updateGroup(g.id, { name })) ?? g;
    }
    const isMembers = /^members/i.test(path) || (!path && op.value && typeof op.value === 'object' && 'members' in (op.value as object));
    if (!isMembers) continue;
    const filter = /^members\[value eq "([^"]+)"\]$/i.exec(path);
    if (kind === 'remove') {
      const ids = filter ? [filter[1]] : memberIds(op.value);
      if (!filter && !ids.length) await setMembers(g, []); // "remove members" with no value clears the group
      else for (const id of ids) await store.removeMember(g.id, id);
    } else {
      const ids = memberIds(path ? op.value : (op.value as { members?: unknown }).members);
      if (kind === 'replace') await setMembers(g, ids);
      else for (const id of ids) {
        if (!(await store.getUser(id))) throw new ScimError(400, `Unknown member ${id}`, 'invalidValue');
        await store.addMember(g.id, id, 'scim');
      }
    }
  }
  send(res, 200, await groupJson(req, g));
}));

scimRouter.delete('/Groups/:id', wrap(async (req, res) => {
  const g = await managedGroup(String(req.params.id));
  await getUserStore().deleteGroup(g.id);
  await getAclStore().deleteRulesForSubject('group', g.id);
  await refreshAcl();
  res.status(204).end();
}));
