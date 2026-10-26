import { randomUUID } from 'node:crypto';
import type { Db, SqlValue } from './types.js';

export type UserSource = 'local' | 'oidc' | 'saml' | 'scim' | 'config';

export interface User {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  passwordHash: string | null;
  isAdmin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  source: UserSource;
  /** Declared in the config file: not editable from the UI. */
  managed: boolean;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  source: UserSource;
  managed: boolean;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  userAgent: string | null;
  ip: string | null;
}

export interface Identity {
  id: string;
  userId: string;
  provider: string;
  issuer: string;
  subject: string;
  createdAt: string;
}

export type MemberSource = 'local' | 'idp';

export type NewUser = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt' | 'lastLoginAt'>> & { username: string };
export type UserPatch = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>;
export type NewGroup = Partial<Omit<Group, 'id' | 'createdAt' | 'updatedAt'>> & { name: string };
export type GroupPatch = Partial<Omit<Group, 'id' | 'createdAt' | 'updatedAt'>>;

/** Usernames and group names are unique case-insensitively: stored lower-cased / trimmed. */
export const normUsername = (s: string): string => s.trim().toLowerCase();

/** Everything the server knows about people: accounts, external identities, groups and login sessions. */
export interface UserStore {
  // users
  createUser(u: NewUser): Promise<User>;
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByExternalId(externalId: string): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  countUsers(): Promise<number>;
  /** Enabled administrators. */
  countAdmins(): Promise<number>;
  /** The oldest enabled administrator — the account the recovery password logs into. */
  getOwner(): Promise<User | undefined>;
  updateUser(id: string, patch: UserPatch): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  touchLogin(id: string): Promise<void>;
  // external identities (OIDC / SAML subjects)
  findByIdentity(provider: string, issuer: string, subject: string): Promise<User | undefined>;
  linkIdentity(userId: string, provider: string, issuer: string, subject: string): Promise<Identity>;
  listIdentities(userId: string): Promise<Identity[]>;
  // groups
  createGroup(g: NewGroup): Promise<Group>;
  getGroup(id: string): Promise<Group | undefined>;
  getGroupByName(name: string): Promise<Group | undefined>;
  getGroupByExternalId(externalId: string): Promise<Group | undefined>;
  listGroups(): Promise<Group[]>;
  updateGroup(id: string, patch: GroupPatch): Promise<Group | undefined>;
  deleteGroup(id: string): Promise<boolean>;
  addMember(groupId: string, userId: string, source?: MemberSource): Promise<void>;
  removeMember(groupId: string, userId: string): Promise<boolean>;
  listMembers(groupId: string): Promise<User[]>;
  listGroupsOfUser(userId: string): Promise<Group[]>;
  /**
   * Replace a user's memberships of the given `source` with exactly `groupIds`
   * (memberships of other sources are untouched). Used when an IdP reports groups at login.
   */
  syncUserGroups(userId: string, groupIds: string[], source: MemberSource): Promise<void>;
  // sessions
  createSession(s: { userId: string; ttlMs: number; userAgent?: string | null; ip?: string | null }): Promise<Session>;
  getSession(id: string): Promise<Session | undefined>;
  listSessions(userId: string): Promise<Session[]>;
  touchSession(id: string): Promise<void>;
  revokeSession(id: string): Promise<boolean>;
  revokeUserSessions(userId: string, exceptId?: string): Promise<number>;
  purgeSessions(): Promise<number>;
}

const b = (v: unknown): boolean => v === 1 || v === true || v === '1';
const n = (v: boolean | undefined, d = false): number => ((v ?? d) ? 1 : 0);
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toUser(r: Record<string, unknown>): User {
  return {
    id: String(r.id),
    username: String(r.username),
    email: s(r.email),
    displayName: String(r.display_name ?? ''),
    passwordHash: s(r.password_hash),
    isAdmin: b(r.is_admin),
    disabled: b(r.disabled),
    mustChangePassword: b(r.must_change_password),
    source: String(r.source) as UserSource,
    managed: b(r.managed),
    externalId: s(r.external_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastLoginAt: s(r.last_login_at),
  };
}

function toGroup(r: Record<string, unknown>): Group {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ''),
    source: String(r.source) as UserSource,
    managed: b(r.managed),
    externalId: s(r.external_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toSession(r: Record<string, unknown>): Session {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    lastSeenAt: s(r.last_seen_at),
    revokedAt: s(r.revoked_at),
    userAgent: s(r.user_agent),
    ip: s(r.ip),
  };
}

const USER_COLS: Record<keyof UserPatch, string> = {
  username: 'username',
  email: 'email',
  displayName: 'display_name',
  passwordHash: 'password_hash',
  isAdmin: 'is_admin',
  disabled: 'disabled',
  mustChangePassword: 'must_change_password',
  source: 'source',
  managed: 'managed',
  externalId: 'external_id',
  lastLoginAt: 'last_login_at',
};

const GROUP_COLS: Record<keyof GroupPatch, string> = {
  name: 'name',
  description: 'description',
  source: 'source',
  managed: 'managed',
  externalId: 'external_id',
};

function colValue(v: unknown): SqlValue {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return (v ?? null) as SqlValue;
}

export class SqlUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  // ---- users -----------------------------------------------------------------
  async createUser(u: NewUser): Promise<User> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const username = normUsername(u.username);
    if (!username) throw new Error('username required');
    await this.db.run(
      `INSERT INTO users (id, username, email, display_name, password_hash, is_admin, disabled, must_change_password,
                          source, managed, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        username,
        u.email ? u.email.trim().toLowerCase() : null,
        u.displayName ?? '',
        u.passwordHash ?? null,
        n(u.isAdmin),
        n(u.disabled),
        n(u.mustChangePassword),
        u.source ?? 'local',
        n(u.managed),
        u.externalId ?? null,
        now,
        now,
      ],
    );
    return (await this.getUser(id))!;
  }

  private async userWhere(where: string, params: SqlValue[]): Promise<User | undefined> {
    const r = await this.db.get(`SELECT * FROM users WHERE ${where}`, params);
    return r ? toUser(r) : undefined;
  }
  getUser(id: string) {
    return this.userWhere('id = ?', [id]);
  }
  getUserByUsername(username: string) {
    return this.userWhere('username = ?', [normUsername(username)]);
  }
  getUserByEmail(email: string) {
    return this.userWhere('email = ?', [email.trim().toLowerCase()]);
  }
  getUserByExternalId(externalId: string) {
    return this.userWhere('external_id = ?', [externalId]);
  }
  async listUsers(): Promise<User[]> {
    return (await this.db.all('SELECT * FROM users ORDER BY username')).map(toUser);
  }
  async countUsers(): Promise<number> {
    return Number((await this.db.get<{ c: number | string }>('SELECT COUNT(*) AS c FROM users'))?.c ?? 0);
  }
  async countAdmins(): Promise<number> {
    const r = await this.db.get<{ c: number | string }>('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND disabled = 0');
    return Number(r?.c ?? 0);
  }
  getOwner() {
    return this.userWhere('is_admin = 1 AND disabled = 0 ORDER BY created_at, id LIMIT 1', []);
  }

  async updateUser(id: string, patch: UserPatch): Promise<User | undefined> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof UserPatch, unknown][]) {
      if (v === undefined || !(k in USER_COLS)) continue;
      sets.push(`${USER_COLS[k]} = ?`);
      params.push(k === 'username' ? normUsername(String(v)) : k === 'email' && v ? String(v).trim().toLowerCase() : colValue(v));
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString(), id);
      await this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    return this.getUser(id);
  }
  async deleteUser(id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM users WHERE id = ?', [id])) > 0;
  }
  async touchLogin(id: string): Promise<void> {
    await this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }

  // ---- identities ------------------------------------------------------------
  async findByIdentity(provider: string, issuer: string, subject: string): Promise<User | undefined> {
    const r = await this.db.get(
      `SELECT u.* FROM users u JOIN identities i ON i.user_id = u.id
        WHERE i.provider = ? AND i.issuer = ? AND i.subject = ?`,
      [provider, issuer, subject],
    );
    return r ? toUser(r) : undefined;
  }
  async linkIdentity(userId: string, provider: string, issuer: string, subject: string): Promise<Identity> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.db.run('INSERT INTO identities (id, user_id, provider, issuer, subject, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id, userId, provider, issuer, subject, createdAt,
    ]);
    return { id, userId, provider, issuer, subject, createdAt };
  }
  async listIdentities(userId: string): Promise<Identity[]> {
    const rows = await this.db.all('SELECT * FROM identities WHERE user_id = ? ORDER BY created_at', [userId]);
    return rows.map((r) => ({
      id: String(r.id), userId: String(r.user_id), provider: String(r.provider),
      issuer: String(r.issuer), subject: String(r.subject), createdAt: String(r.created_at),
    }));
  }

  // ---- groups ----------------------------------------------------------------
  async createGroup(g: NewGroup): Promise<Group> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const name = g.name.trim();
    if (!name) throw new Error('group name required');
    await this.db.run(
      `INSERT INTO user_groups (id, name, description, source, managed, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, g.description ?? '', g.source ?? 'local', n(g.managed), g.externalId ?? null, now, now],
    );
    return (await this.getGroup(id))!;
  }
  private async groupWhere(where: string, params: SqlValue[]): Promise<Group | undefined> {
    const r = await this.db.get(`SELECT * FROM user_groups WHERE ${where}`, params);
    return r ? toGroup(r) : undefined;
  }
  getGroup(id: string) {
    return this.groupWhere('id = ?', [id]);
  }
  getGroupByName(name: string) {
    return this.groupWhere('LOWER(name) = ?', [name.trim().toLowerCase()]);
  }
  getGroupByExternalId(externalId: string) {
    return this.groupWhere('external_id = ?', [externalId]);
  }
  async listGroups(): Promise<Group[]> {
    return (await this.db.all('SELECT * FROM user_groups ORDER BY name')).map(toGroup);
  }
  async updateGroup(id: string, patch: GroupPatch): Promise<Group | undefined> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof GroupPatch, unknown][]) {
      if (v === undefined || !(k in GROUP_COLS)) continue;
      sets.push(`${GROUP_COLS[k]} = ?`);
      params.push(k === 'name' ? String(v).trim() : colValue(v));
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString(), id);
      await this.db.run(`UPDATE user_groups SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    return this.getGroup(id);
  }
  async deleteGroup(id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM user_groups WHERE id = ?', [id])) > 0;
  }
  async addMember(groupId: string, userId: string, source: MemberSource = 'local'): Promise<void> {
    if (await this.db.get('SELECT 1 AS x FROM user_group_members WHERE group_id = ? AND user_id = ?', [groupId, userId])) return;
    await this.db.run('INSERT INTO user_group_members (group_id, user_id, source) VALUES (?, ?, ?)', [groupId, userId, source]);
  }
  async removeMember(groupId: string, userId: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?', [groupId, userId])) > 0;
  }
  async listMembers(groupId: string): Promise<User[]> {
    const rows = await this.db.all(
      `SELECT u.* FROM users u JOIN user_group_members m ON m.user_id = u.id WHERE m.group_id = ? ORDER BY u.username`,
      [groupId],
    );
    return rows.map(toUser);
  }
  async listGroupsOfUser(userId: string): Promise<Group[]> {
    const rows = await this.db.all(
      `SELECT g.* FROM user_groups g JOIN user_group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name`,
      [userId],
    );
    return rows.map(toGroup);
  }
  async syncUserGroups(userId: string, groupIds: string[], source: MemberSource): Promise<void> {
    const want = new Set(groupIds);
    await this.db.tx(async (t) => {
      const have = await t.all<{ group_id: string }>(
        'SELECT group_id FROM user_group_members WHERE user_id = ? AND source = ?',
        [userId, source],
      );
      const haveIds = new Set(have.map((r) => r.group_id));
      for (const gid of haveIds) {
        if (!want.has(gid)) await t.run('DELETE FROM user_group_members WHERE group_id = ? AND user_id = ? AND source = ?', [gid, userId, source]);
      }
      for (const gid of want) {
        if (haveIds.has(gid)) continue;
        // A manual (local) membership already covers it: don't add a second row.
        if (await t.get('SELECT 1 AS x FROM user_group_members WHERE group_id = ? AND user_id = ?', [gid, userId])) continue;
        await t.run('INSERT INTO user_group_members (group_id, user_id, source) VALUES (?, ?, ?)', [gid, userId, source]);
      }
    });
  }

  // ---- sessions --------------------------------------------------------------
  async createSession(x: { userId: string; ttlMs: number; userAgent?: string | null; ip?: string | null }): Promise<Session> {
    const id = randomUUID();
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + x.ttlMs).toISOString();
    await this.db.run(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, x.userId, createdAt, expiresAt, createdAt, x.userAgent?.slice(0, 300) ?? null, x.ip ?? null],
    );
    return (await this.getSession(id))!;
  }
  async getSession(id: string): Promise<Session | undefined> {
    const r = await this.db.get('SELECT * FROM sessions WHERE id = ?', [id]);
    return r ? toSession(r) : undefined;
  }
  async listSessions(userId: string): Promise<Session[]> {
    const rows = await this.db.all(
      'SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
      [userId, new Date().toISOString()],
    );
    return rows.map(toSession);
  }
  async touchSession(id: string): Promise<void> {
    await this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }
  async revokeSession(id: string): Promise<boolean> {
    return (await this.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [new Date().toISOString(), id])) > 0;
  }
  async revokeUserSessions(userId: string, exceptId?: string): Promise<number> {
    const now = new Date().toISOString();
    return exceptId
      ? this.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [now, userId, exceptId])
      : this.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
  }
  async purgeSessions(): Promise<number> {
    // Keep revoked rows for a week so "revoked" can be told apart from "unknown" in logs.
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    return this.db.run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [cutoff, cutoff]);
  }
}
