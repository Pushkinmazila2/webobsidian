import { randomUUID } from 'node:crypto';
import type { Db } from './types.js';

export const LEVELS = ['none', 'read', 'comment', 'write', 'manage'] as const;
export type Level = (typeof LEVELS)[number];
export const levelNum = (l: Level): number => LEVELS.indexOf(l);
export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v);

export type SubjectType = 'user' | 'group' | 'everyone';
export type Effect = 'allow' | 'deny';

export interface AclRule {
  id: string;
  vaultId: string;
  subjectType: SubjectType;
  /** User or group id; null for `everyone`. */
  subjectId: string | null;
  /** Folder/file path or glob (`Projects`, `Projects/**`, `**\/*.private.md`); empty = the whole vault. */
  pattern: string;
  level: Level;
  effect: Effect;
  managed: boolean;
  note: string | null;
  createdAt: string;
}

export type NewAclRule = Omit<AclRule, 'id' | 'createdAt' | 'managed' | 'note'> & { managed?: boolean; note?: string | null };

export interface VaultDefault {
  vaultId: string;
  level: Level;
  managed: boolean;
}

export interface AclStore {
  listRules(vaultId?: string): Promise<AclRule[]>;
  getRule(id: string): Promise<AclRule | undefined>;
  createRule(r: NewAclRule): Promise<AclRule>;
  deleteRule(id: string): Promise<boolean>;
  listDefaults(): Promise<VaultDefault[]>;
  setDefault(vaultId: string, level: Level, managed?: boolean): Promise<void>;
}

const toRule = (r: Record<string, unknown>): AclRule => ({
  id: String(r.id),
  vaultId: String(r.vault_id),
  subjectType: String(r.subject_type) as SubjectType,
  subjectId: r.subject_id === null || r.subject_id === undefined ? null : String(r.subject_id),
  pattern: String(r.pattern),
  level: String(r.level) as Level,
  effect: String(r.effect) as Effect,
  managed: r.managed === 1 || r.managed === true,
  note: r.note === null || r.note === undefined ? null : String(r.note),
  createdAt: String(r.created_at),
});

/** Normalise a rule pattern: forward slashes, no leading/trailing slash. */
export const normPattern = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export class SqlAclStore implements AclStore {
  constructor(private readonly db: Db) {}

  async listRules(vaultId?: string): Promise<AclRule[]> {
    const rows = vaultId
      ? await this.db.all('SELECT * FROM acl_rules WHERE vault_id = ? ORDER BY created_at, id', [vaultId])
      : await this.db.all('SELECT * FROM acl_rules ORDER BY vault_id, created_at, id');
    return rows.map(toRule);
  }
  async getRule(id: string): Promise<AclRule | undefined> {
    const r = await this.db.get('SELECT * FROM acl_rules WHERE id = ?', [id]);
    return r ? toRule(r) : undefined;
  }
  async createRule(r: NewAclRule): Promise<AclRule> {
    if (r.subjectType !== 'everyone' && !r.subjectId) throw new Error('subjectId required for user/group rules');
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO acl_rules (id, vault_id, subject_type, subject_id, pattern, level, effect, managed, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, r.vaultId, r.subjectType, r.subjectType === 'everyone' ? null : r.subjectId, normPattern(r.pattern), r.level, r.effect, r.managed ? 1 : 0, r.note ?? null, new Date().toISOString()],
    );
    return (await this.getRule(id))!;
  }
  async deleteRule(id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM acl_rules WHERE id = ?', [id])) > 0;
  }
  async listDefaults(): Promise<VaultDefault[]> {
    const rows = await this.db.all('SELECT * FROM vault_defaults');
    return rows.map((r) => ({ vaultId: String(r.vault_id), level: String(r.level) as Level, managed: r.managed === 1 || r.managed === true }));
  }
  async setDefault(vaultId: string, level: Level, managed = false): Promise<void> {
    await this.db.tx(async (t) => {
      await t.run('DELETE FROM vault_defaults WHERE vault_id = ?', [vaultId]);
      await t.run('INSERT INTO vault_defaults (vault_id, level, managed) VALUES (?, ?, ?)', [vaultId, level, managed ? 1 : 0]);
    });
  }
}
