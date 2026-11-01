import { randomUUID } from 'node:crypto';
import type { Db } from './types.js';

export interface EditLogEntry {
  id: string;
  vaultId: string;
  path: string;
  userId: string | null;
  userName: string;
  kind: 'edit' | 'rest' | 'external';
  startedAt: string;
  endedAt: string;
  inserted: number;
  deleted: number;
  sample: string;
}

export interface EditLogStore {
  add(e: Omit<EditLogEntry, 'id'>): Promise<void>;
  /** Newest first. */
  list(vaultId: string, path: string, limit: number): Promise<EditLogEntry[]>;
}

export class SqlEditLogStore implements EditLogStore {
  constructor(private readonly db: Db) {}
  async add(e: Omit<EditLogEntry, 'id'>): Promise<void> {
    await this.db.run(
      `INSERT INTO edit_log (id, vault_id, path, user_id, user_name, kind, started_at, ended_at, inserted, deleted, sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), e.vaultId, e.path, e.userId, e.userName, e.kind, e.startedAt, e.endedAt, e.inserted, e.deleted, e.sample],
    );
  }
  async list(vaultId: string, path: string, limit: number): Promise<EditLogEntry[]> {
    const rows = await this.db.all('SELECT * FROM edit_log WHERE vault_id = ? AND path = ? ORDER BY ended_at DESC LIMIT ?', [vaultId, path, limit]);
    return rows.map((r) => ({
      id: String(r.id), vaultId: String(r.vault_id), path: String(r.path),
      userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
      userName: String(r.user_name), kind: String(r.kind) as EditLogEntry['kind'],
      startedAt: String(r.started_at), endedAt: String(r.ended_at),
      inserted: Number(r.inserted), deleted: Number(r.deleted), sample: String(r.sample),
    }));
  }
}
