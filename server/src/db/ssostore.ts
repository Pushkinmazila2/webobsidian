import { randomUUID } from 'node:crypto';
import type { Db } from './types.js';

export type IdpType = 'oidc' | 'saml';

export interface IdentityProvider {
  id: string;
  type: IdpType;
  name: string;
  enabled: boolean;
  /** Provider-specific settings (validated by services/sso.ts). */
  config: Record<string, unknown>;
  managed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScimToken {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface SsoStore {
  listProviders(): Promise<IdentityProvider[]>;
  getProvider(id: string): Promise<IdentityProvider | undefined>;
  createProvider(p: { id?: string; type: IdpType; name: string; enabled?: boolean; config: Record<string, unknown>; managed?: boolean }): Promise<IdentityProvider>;
  updateProvider(id: string, patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> }): Promise<IdentityProvider | undefined>;
  deleteProvider(id: string): Promise<boolean>;
  listScimTokens(): Promise<ScimToken[]>;
  createScimToken(t: { name: string; hash: string; prefix: string }): Promise<ScimToken>;
  findScimToken(hash: string): Promise<ScimToken | undefined>;
  touchScimToken(id: string): Promise<void>;
  revokeScimToken(id: string): Promise<boolean>;
}

const toProvider = (r: Record<string, unknown>): IdentityProvider => ({
  id: String(r.id),
  type: String(r.type) as IdpType,
  name: String(r.name),
  enabled: r.enabled === 1 || r.enabled === true,
  config: JSON.parse(String(r.config)) as Record<string, unknown>,
  managed: r.managed === 1 || r.managed === true,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toToken = (r: Record<string, unknown>): ScimToken => ({
  id: String(r.id),
  name: String(r.name),
  hash: String(r.hash),
  prefix: String(r.prefix),
  createdAt: String(r.created_at),
  lastUsedAt: r.last_used_at === null || r.last_used_at === undefined ? null : String(r.last_used_at),
  revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : String(r.revoked_at),
});

export class SqlSsoStore implements SsoStore {
  constructor(private readonly db: Db) {}

  async listProviders(): Promise<IdentityProvider[]> {
    return (await this.db.all('SELECT * FROM identity_providers ORDER BY name')).map(toProvider);
  }
  async getProvider(id: string): Promise<IdentityProvider | undefined> {
    const r = await this.db.get('SELECT * FROM identity_providers WHERE id = ?', [id]);
    return r ? toProvider(r) : undefined;
  }
  async createProvider(p: { id?: string; type: IdpType; name: string; enabled?: boolean; config: Record<string, unknown>; managed?: boolean }): Promise<IdentityProvider> {
    const id = p.id ?? randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      'INSERT INTO identity_providers (id, type, name, enabled, config, managed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, p.type, p.name, p.enabled === false ? 0 : 1, JSON.stringify(p.config), p.managed ? 1 : 0, now, now],
    );
    return (await this.getProvider(id))!;
  }
  async updateProvider(id: string, patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> }): Promise<IdentityProvider | undefined> {
    const cur = await this.getProvider(id);
    if (!cur) return undefined;
    await this.db.run('UPDATE identity_providers SET name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?', [
      patch.name ?? cur.name,
      (patch.enabled ?? cur.enabled) ? 1 : 0,
      JSON.stringify(patch.config ?? cur.config),
      new Date().toISOString(),
      id,
    ]);
    return this.getProvider(id);
  }
  async deleteProvider(id: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM identity_providers WHERE id = ?', [id])) > 0;
  }

  async listScimTokens(): Promise<ScimToken[]> {
    return (await this.db.all('SELECT * FROM scim_tokens ORDER BY created_at DESC')).map(toToken);
  }
  async createScimToken(t: { name: string; hash: string; prefix: string }): Promise<ScimToken> {
    const id = randomUUID();
    await this.db.run('INSERT INTO scim_tokens (id, name, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)', [id, t.name, t.hash, t.prefix, new Date().toISOString()]);
    return toToken((await this.db.get('SELECT * FROM scim_tokens WHERE id = ?', [id]))!);
  }
  async findScimToken(hash: string): Promise<ScimToken | undefined> {
    const r = await this.db.get('SELECT * FROM scim_tokens WHERE hash = ? AND revoked_at IS NULL', [hash]);
    return r ? toToken(r) : undefined;
  }
  async touchScimToken(id: string): Promise<void> {
    await this.db.run('UPDATE scim_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }
  async revokeScimToken(id: string): Promise<boolean> {
    return (await this.db.run('UPDATE scim_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [new Date().toISOString(), id])) > 0;
  }
}
