import path from 'node:path';
import { config } from '../config.js';
import { migrate } from './migrations.js';
import { openSqlite } from './sqlite.js';
import { openPostgres } from './postgres.js';
import { SqlUserStore, type UserStore } from './userstore.js';
import { SqlAclStore, type AclStore } from './aclstore.js';
import type { Db } from './types.js';

export type { Db } from './types.js';
export * from './userstore.js';
export * from './aclstore.js';

let db: Db | null = null;
let users: UserStore | null = null;
let acl: AclStore | null = null;

/**
 * `DATABASE_URL`: `postgres://…` / `postgresql://…`, `sqlite:<file>` (or `sqlite::memory:`), or empty =
 * SQLite in `<DATA_DIR>/webobsidian.db`.
 */
export async function openDb(url: string = config.databaseUrl): Promise<Db> {
  const u = url.trim();
  if (/^postgres(ql)?:\/\//i.test(u)) return openPostgres(u);
  if (!u) return openSqlite(path.join(config.dataDir, 'webobsidian.db'));
  if (/^sqlite:/i.test(u)) {
    const f = u.replace(/^sqlite:(\/\/)?/i, '');
    return openSqlite(f === ':memory:' ? f : path.resolve(f));
  }
  throw new Error(`Unsupported DATABASE_URL (use postgres://…, sqlite:<file> or leave empty): ${u.replace(/:\/\/.*@/, '://***@')}`);
}

/** Open the database, apply migrations and install the shared UserStore. Call once at boot. */
export async function initDb(url?: string): Promise<UserStore> {
  if (db) return users!;
  const opened = await openDb(url);
  await migrate(opened);
  db = opened;
  users = new SqlUserStore(opened);
  acl = new SqlAclStore(opened);
  return users;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not initialised (initDb() was not called)');
  return db;
}

export function getUserStore(): UserStore {
  if (!users) throw new Error('Database not initialised (initDb() was not called)');
  return users;
}

export function getAclStore(): AclStore {
  if (!acl) throw new Error('Database not initialised (initDb() was not called)');
  return acl;
}

/** Tests: drop the shared handles (closing the database). */
export async function closeDb(): Promise<void> {
  const d = db;
  db = null;
  users = null;
  acl = null;
  await d?.close();
}
