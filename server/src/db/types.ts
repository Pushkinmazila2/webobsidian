/**
 * Minimal SQL access layer shared by the SQLite and PostgreSQL drivers.
 *
 * Queries are written once, with `?` placeholders and dialect-neutral SQL (TEXT ids,
 * ISO-8601 TEXT timestamps, INTEGER booleans). The PostgreSQL driver rewrites `?` to `$n`.
 */
export type SqlValue = string | number | null;

export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  /** Runs a statement; resolves to the number of affected rows. */
  run(sql: string, params?: SqlValue[]): Promise<number>;
  /** Runs `fn` in a transaction (commit on resolve, rollback on throw). Nested calls join the outer one. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Serialises async work (SQLite has one connection, so a transaction must not interleave with other queries). */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    return release;
  }
}
