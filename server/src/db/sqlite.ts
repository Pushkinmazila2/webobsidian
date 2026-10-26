import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Mutex, type Db, type SqlValue } from './types.js';

/** SQLite through Node's built-in `node:sqlite` (Node >= 22.5) — no native addon to build. */
export async function openSqlite(file: string): Promise<Db> {
  let mod: typeof import('node:sqlite');
  try {
    mod = await import('node:sqlite');
  } catch {
    throw new Error('SQLite needs Node.js >= 22.5 (node:sqlite). Upgrade Node or set DATABASE_URL to a PostgreSQL server.');
  }
  if (file !== ':memory:') await fs.mkdir(path.dirname(file), { recursive: true });
  const raw = new mod.DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return new SqliteDb(raw, new Mutex(), false);
}

class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  constructor(
    private readonly raw: DatabaseSync,
    private readonly mutex: Mutex,
    /** True for the handle passed into `tx()`: the lock is already held by the transaction. */
    private readonly inTx: boolean,
  ) {}

  private async exec<T>(fn: () => T): Promise<T> {
    if (this.inTx) return fn();
    const release = await this.mutex.lock();
    try {
      return fn();
    } finally {
      release();
    }
  }

  all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.exec(() => this.raw.prepare(sql).all(...params) as T[]);
  }
  get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return this.exec(() => this.raw.prepare(sql).get(...params) as T | undefined);
  }
  run(sql: string, params: SqlValue[] = []): Promise<number> {
    return this.exec(() => Number(this.raw.prepare(sql).run(...params).changes));
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    const release = await this.mutex.lock();
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(new SqliteDb(this.raw, this.mutex, true));
        this.raw.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (!this.inTx) this.raw.close();
  }
}
