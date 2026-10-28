import type { Db } from './types.js';

/**
 * Ordered, append-only schema migrations. Dialect-neutral SQL: TEXT ids (UUID),
 * ISO-8601 TEXT timestamps, INTEGER 0/1 booleans. Never edit an applied migration —
 * add a new one.
 */
export interface Migration {
  id: string;
  up: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_identity',
    up: [
      `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         username TEXT NOT NULL UNIQUE,
         email TEXT,
         display_name TEXT NOT NULL DEFAULT '',
         password_hash TEXT,
         is_admin INTEGER NOT NULL DEFAULT 0,
         disabled INTEGER NOT NULL DEFAULT 0,
         must_change_password INTEGER NOT NULL DEFAULT 0,
         source TEXT NOT NULL DEFAULT 'local',
         managed INTEGER NOT NULL DEFAULT 0,
         external_id TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         last_login_at TEXT
       )`,
      `CREATE INDEX idx_users_email ON users(email)`,
      `CREATE TABLE identities (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         provider TEXT NOT NULL,
         issuer TEXT NOT NULL,
         subject TEXT NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE (provider, issuer, subject)
       )`,
      `CREATE INDEX idx_identities_user ON identities(user_id)`,
      `CREATE TABLE user_groups (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         description TEXT NOT NULL DEFAULT '',
         source TEXT NOT NULL DEFAULT 'local',
         managed INTEGER NOT NULL DEFAULT 0,
         external_id TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      // source: 'local' = added by an admin, 'idp' = granted by an identity provider / SCIM (re-synced at login).
      `CREATE TABLE user_group_members (
         group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         source TEXT NOT NULL DEFAULT 'local',
         PRIMARY KEY (group_id, user_id)
       )`,
      `CREATE INDEX idx_group_members_user ON user_group_members(user_id)`,
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         last_seen_at TEXT,
         revoked_at TEXT,
         user_agent TEXT,
         ip TEXT
       )`,
      `CREATE INDEX idx_sessions_user ON sessions(user_id)`,
    ],
  },
  {
    id: '002_acl',
    up: [
      // One row per rule. subject_type: user | group | everyone (subject_id is NULL for everyone).
      // level: none < read < comment < write < manage. effect: allow grants up to `level`; deny caps access below `level`.
      `CREATE TABLE acl_rules (
         id TEXT PRIMARY KEY,
         vault_id TEXT NOT NULL,
         subject_type TEXT NOT NULL,
         subject_id TEXT,
         pattern TEXT NOT NULL,
         level TEXT NOT NULL,
         effect TEXT NOT NULL DEFAULT 'allow',
         managed INTEGER NOT NULL DEFAULT 0,
         note TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX idx_acl_rules_vault ON acl_rules(vault_id)`,
      // What a signed-in non-administrator gets where no rule matches (absent row = none).
      `CREATE TABLE vault_defaults (
         vault_id TEXT PRIMARY KEY,
         level TEXT NOT NULL,
         managed INTEGER NOT NULL DEFAULT 0
       )`,
    ],
  },
];

export async function migrate(db: Db, migrations: Migration[] = MIGRATIONS): Promise<string[]> {
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied: string[] = [];
  for (const m of migrations) {
    await db.tx(async (t) => {
      // Two instances starting together on one PostgreSQL server must not both apply a migration.
      if (t.dialect === 'postgres') await t.run('SELECT pg_advisory_xact_lock(7340211)');
      if (await t.get('SELECT id FROM schema_migrations WHERE id = ?', [m.id])) return;
      for (const stmt of m.up) await t.run(stmt);
      await t.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, new Date().toISOString()]);
      applied.push(m.id);
    });
  }
  return applied;
}
