import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getUserStore, type Group, type User } from '../db/index.js';
import { hashPassword, MIN_PASSWORD_LEN } from '../services/auth.js';

/**
 * User & group administration (administrators only): /api/admin/*.
 * Objects declared in the config file (`managed`) are read-only here.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

const USERNAME = /^[a-z0-9][a-z0-9._@+-]{0,63}$/i;

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const adminUser = (u: User, groups: string[] = []) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  displayName: u.displayName,
  isAdmin: u.isAdmin,
  disabled: u.disabled,
  mustChangePassword: u.mustChangePassword,
  source: u.source,
  managed: u.managed,
  hasPassword: Boolean(u.passwordHash),
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
  groups,
});

const adminGroup = (g: Group, members?: number) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  source: g.source,
  managed: g.managed,
  members,
  createdAt: g.createdAt,
});

const password = z.string().min(MIN_PASSWORD_LEN, `Password must be at least ${MIN_PASSWORD_LEN} characters`).max(256);

const NewUserBody = z.object({
  username: z.string().regex(USERNAME, 'Username: letters, digits and . _ @ + - (max 64)'),
  email: z.string().email().nullish(),
  displayName: z.string().max(120).optional(),
  password: password.optional(),
  isAdmin: z.boolean().optional(),
  // Force a new password at first sign-in (default when an admin sets the password).
  mustChangePassword: z.boolean().optional(),
});

const PatchUserBody = z.object({
  username: z.string().regex(USERNAME).optional(),
  email: z.string().email().nullable().optional(),
  displayName: z.string().max(120).optional(),
  password: password.optional(),
  isAdmin: z.boolean().optional(),
  disabled: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
});

const GroupBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(400).optional() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw httpError(400, r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

/** Refuse changes that would leave the instance without an enabled administrator. */
async function assertNotLastAdmin(target: User): Promise<void> {
  if (target.isAdmin && !target.disabled && (await getUserStore().countAdmins()) <= 1) {
    throw httpError(409, 'This is the last enabled administrator');
  }
}

function assertEditable(o: { managed: boolean }): void {
  if (o.managed) throw httpError(409, 'Managed by the configuration file — change it there');
}

// ---- users -------------------------------------------------------------------
adminRouter.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const store = getUserStore();
    const [users, groups] = await Promise.all([store.listUsers(), store.listGroups()]);
    const names = new Map<string, string[]>();
    for (const g of groups) {
      for (const m of await store.listMembers(g.id)) names.set(m.id, [...(names.get(m.id) ?? []), g.name]);
    }
    res.json({ users: users.map((u) => adminUser(u, names.get(u.id) ?? [])) });
  }),
);

adminRouter.post(
  '/users',
  asyncHandler(async (req, res) => {
    const b = parse(NewUserBody, req.body);
    const store = getUserStore();
    if (await store.getUserByUsername(b.username)) throw httpError(409, 'Username already taken');
    if (b.email && (await store.getUserByEmail(b.email))) throw httpError(409, 'E-mail already in use');
    const u = await store.createUser({
      username: b.username,
      email: b.email ?? null,
      displayName: b.displayName ?? '',
      isAdmin: b.isAdmin ?? false,
      passwordHash: b.password ? await hashPassword(b.password) : null,
      mustChangePassword: b.password ? (b.mustChangePassword ?? true) : false,
    });
    res.status(201).json({ user: adminUser(u) });
  }),
);

adminRouter.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    const id = String(req.params.id);
    const target = await store.getUser(id);
    if (!target) throw httpError(404, 'User not found');
    assertEditable(target);
    const b = parse(PatchUserBody, req.body);
    const loses = (b.isAdmin === false && target.isAdmin) || (b.disabled === true && !target.disabled);
    if (loses) {
      if (id === req.user!.id) throw httpError(409, 'You cannot remove your own administrator access or disable yourself');
      await assertNotLastAdmin(target);
    }
    if (b.username && b.username.toLowerCase() !== target.username) {
      if (await store.getUserByUsername(b.username)) throw httpError(409, 'Username already taken');
    }
    if (b.email && b.email.toLowerCase() !== target.email) {
      const other = await store.getUserByEmail(b.email);
      if (other && other.id !== id) throw httpError(409, 'E-mail already in use');
    }
    const { password: pw, ...rest } = b;
    const updated = await store.updateUser(id, {
      ...rest,
      ...(pw ? { passwordHash: await hashPassword(pw), mustChangePassword: b.mustChangePassword ?? true } : {}),
    });
    // Disabling or resetting a password signs the person out everywhere, immediately.
    if (b.disabled === true || pw) await store.revokeUserSessions(id);
    res.json({ user: adminUser(updated!) });
  }),
);

adminRouter.delete(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    const id = String(req.params.id);
    const target = await store.getUser(id);
    if (!target) throw httpError(404, 'User not found');
    assertEditable(target);
    if (id === req.user!.id) throw httpError(409, 'You cannot delete yourself');
    await assertNotLastAdmin(target);
    await store.deleteUser(id);
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/users/:id/sessions',
  asyncHandler(async (req, res) => {
    const list = await getUserStore().listSessions(String(req.params.id));
    res.json({ sessions: list.map((x) => ({ id: x.id, createdAt: x.createdAt, lastSeenAt: x.lastSeenAt, userAgent: x.userAgent, ip: x.ip })) });
  }),
);

adminRouter.post(
  '/users/:id/revoke-sessions',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, revoked: await getUserStore().revokeUserSessions(String(req.params.id)) });
  }),
);

// ---- groups ------------------------------------------------------------------
adminRouter.get(
  '/groups',
  asyncHandler(async (_req, res) => {
    const store = getUserStore();
    const groups = await store.listGroups();
    const out = [];
    for (const g of groups) out.push(adminGroup(g, (await store.listMembers(g.id)).length));
    res.json({ groups: out });
  }),
);

adminRouter.post(
  '/groups',
  asyncHandler(async (req, res) => {
    const b = parse(GroupBody, req.body);
    const store = getUserStore();
    if (await store.getGroupByName(b.name)) throw httpError(409, 'A group with this name already exists');
    res.status(201).json({ group: adminGroup(await store.createGroup({ name: b.name, description: b.description }), 0) });
  }),
);

adminRouter.patch(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    const id = String(req.params.id);
    const g = await store.getGroup(id);
    if (!g) throw httpError(404, 'Group not found');
    assertEditable(g);
    const b = parse(GroupBody.partial(), req.body);
    if (b.name && b.name.toLowerCase() !== g.name.toLowerCase()) {
      if (await store.getGroupByName(b.name)) throw httpError(409, 'A group with this name already exists');
    }
    res.json({ group: adminGroup((await store.updateGroup(id, b))!) });
  }),
);

adminRouter.delete(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    const g = await store.getGroup(String(req.params.id));
    if (!g) throw httpError(404, 'Group not found');
    assertEditable(g);
    await store.deleteGroup(g.id);
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/groups/:id/members',
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    if (!(await store.getGroup(String(req.params.id)))) throw httpError(404, 'Group not found');
    res.json({ members: (await store.listMembers(String(req.params.id))).map((u) => adminUser(u)) });
  }),
);

adminRouter.put(
  '/groups/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    const g = await store.getGroup(String(req.params.id));
    if (!g) throw httpError(404, 'Group not found');
    assertEditable(g);
    if (!(await store.getUser(String(req.params.userId)))) throw httpError(404, 'User not found');
    await store.addMember(g.id, String(req.params.userId), 'local');
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  '/groups/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const store = getUserStore();
    const g = await store.getGroup(String(req.params.id));
    if (!g) throw httpError(404, 'Group not found');
    assertEditable(g);
    await store.removeMember(g.id, String(req.params.userId));
    res.json({ ok: true });
  }),
);
