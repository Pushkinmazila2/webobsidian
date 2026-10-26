import type { Pool, PoolClient } from 'pg';
import type { Db, SqlValue } from './types.js';

/** `?` → `$1, $2, …` (our SQL never contains a literal `?`). */
export function toPgSql(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Fail at boot (not on the first request) when the server is unreachable.
  const c = await pool.connect();
  c.release();
  return new PgDb(pool, null);
}

class PgDb implements Db {
  readonly dialect = 'postgres' as const;
  constructor(
    private readonly pool: Pool,
    private readonly client: PoolClient | null,
  ) {}

  private async q(sql: string, params: SqlValue[]) {
    return (this.client ?? this.pool).query(toPgSql(sql), params);
  }
  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return (await this.q(sql, params)).rows as T[];
  }
  async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return (await this.q(sql, params)).rows[0] as T | undefined;
  }
  async run(sql: string, params: SqlValue[] = []): Promise<number> {
    return (await this.q(sql, params)).rowCount ?? 0;
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(new PgDb(this.pool, client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }
}
