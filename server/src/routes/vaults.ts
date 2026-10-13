import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import { verifyToken } from '../services/auth.js';
import { getSettings, updateSettings, VaultSchema, type VaultConfig } from '../services/settings.js';
import { applyStoragePatch, badRequest } from '../services/storagepatch.js';
import { DEFAULT_VAULT_ID, runInVault } from '../services/vaultals.js';
import { dropVault, ensureReady, extraVaultConfigs, getVaultContext, listVaults } from '../services/vaults.js';
import { assertVaultPathAllowed } from './settings.js';

const MASK = '••••••••';
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Picks the vault a request works on: `X-Vault` header, or `?vault=` for URLs the browser
 * loads itself (images, downloads). No selector = the main vault, so existing clients are
 * unaffected. Only authenticated requests start a vault; the route's own guard still
 * decides access. Management routes (/vaults, /settings, /keys) are vault-independent.
 */
export async function vaultMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = (req.headers['x-vault'] as string | undefined) ?? (typeof req.query.vault === 'string' ? req.query.vault : undefined);
    const id = raw?.trim();
    if (!id || id === DEFAULT_VAULT_ID || /^\/(vaults|settings|keys)(\/|$)/.test(req.path)) return next();
    if (!SLUG.test(id)) {
      res.status(404).json({ error: 'Unknown vault' });
      return;
    }
    const token = req.cookies?.[COOKIE_NAME] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
    const isAgent = req.path.startsWith('/v1/');
    // Session requests must be signed in before a vault is touched; agent (API-key) requests
    // are validated by their own guard, which runs inside the vault scope.
    if (!isAgent && !(token && (await verifyToken(token)))) return next();
    const ctx = await getVaultContext(id);
    if (!ctx) {
      res.status(404).json({ error: 'Unknown vault' });
      return;
    }
    await ensureReady(ctx);
    // Git sync (a local clone + remote) belongs to the main vault; a GitHub vault maps the same
    // endpoints onto its driver (status bar, "save now").
    if (req.path.startsWith('/git') && ctx.storage.kind !== 'github') {
      res.status(400).json({ error: 'Git sync is only available for the main vault' });
      return;
    }
    runInVault(ctx, next);
  } catch (e: any) {
    res.status(502).json({ error: `Vault could not be opened: ${e?.message ?? e}` });
  }
}

const redact = (c: VaultConfig, fromEnv: boolean) => ({
  ...c,
  fromEnv,
  storage: { ...c.storage, github: { ...c.storage.github, token: c.storage.github.token ? MASK : '' } },
});

const slugify = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');

async function build(body: any, existing?: VaultConfig): Promise<VaultConfig> {
  const base: VaultConfig = existing
    ? JSON.parse(JSON.stringify(existing))
    : VaultSchema.parse({ id: 'tmp', name: 'tmp' });
  if (typeof body.name === 'string') base.name = body.name.trim();
  if (!base.name) badRequest('name is required');
  if (typeof body.path === 'string') base.path = body.path.trim();
  if (typeof body.tokenEnv === 'string') {
    if (body.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.tokenEnv)) badRequest('tokenEnv is not a valid variable name');
    base.tokenEnv = body.tokenEnv;
  }
  if (body.storage && typeof body.storage === 'object') applyStoragePatch(base.storage, body.storage);
  if (base.storage.driver === 'local') {
    if (!base.path) badRequest('a local vault needs a folder path');
    await assertVaultPathAllowed({ path: base.path });
  } else if (!base.storage.github.owner || !base.storage.github.repo) {
    badRequest('a GitHub vault needs the repository owner and name');
  }
  return base;
}

export const vaultsRouter = Router();
vaultsRouter.use(requireAuth);

vaultsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ vaults: await listVaults() });
}));

vaultsRouter.get('/:id', asyncHandler(async (req, res) => {
  const s = await getSettings();
  const f = extraVaultConfigs(s).find((v) => v.conf.id === req.params.id);
  if (!f) return void res.status(404).json({ error: 'Unknown vault' });
  res.json({ vault: redact(f.conf, f.fromEnv) });
}));

vaultsRouter.post('/', asyncHandler(async (req, res) => {
  const s = await getSettings();
  const taken = new Set([DEFAULT_VAULT_ID, ...extraVaultConfigs(s).map((v) => v.conf.id)]);
  let id = String(req.body?.id ?? '').trim() || slugify(String(req.body?.name ?? ''));
  if (!id) badRequest('give the vault a name');
  if (!SLUG.test(id) || id === DEFAULT_VAULT_ID) badRequest('id may contain only a-z, 0-9 and "-" (max 32), and cannot be "default"');
  if (taken.has(id)) throw Object.assign(new Error(`A vault "${id}" already exists`), { status: 409 });
  const conf = await build(req.body ?? {});
  conf.id = id;
  VaultSchema.parse(conf);
  await updateSettings((d) => { d.vaults.push(conf); });
  res.json({ vault: redact(conf, false) });
}));

vaultsRouter.put('/:id', asyncHandler(async (req, res) => {
  const s = await getSettings();
  const f = extraVaultConfigs(s).find((v) => v.conf.id === req.params.id);
  if (!f) return void res.status(404).json({ error: 'Unknown vault' });
  if (f.fromEnv) return void res.status(409).json({ error: 'This vault is defined by WEBOBSIDIAN_VAULTS and cannot be edited here' });
  const conf = await build(req.body ?? {}, f.conf);
  VaultSchema.parse(conf);
  await updateSettings((d) => { d.vaults = d.vaults.map((v) => (v.id === conf.id ? conf : v)); });
  await getVaultContext(conf.id); // hot reload: a changed config replaces the running vault
  res.json({ vault: redact(conf, false) });
}));

vaultsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const s = await getSettings();
  const f = extraVaultConfigs(s).find((v) => v.conf.id === req.params.id);
  if (!f) return void res.status(404).json({ error: 'Unknown vault' });
  if (f.fromEnv) return void res.status(409).json({ error: 'This vault is defined by WEBOBSIDIAN_VAULTS and cannot be removed here' });
  await dropVault(f.conf.id); // saves buffered changes first; the folder / repository itself is untouched
  await updateSettings((d) => { d.vaults = d.vaults.filter((v) => v.id !== f.conf.id); });
  res.json({ ok: true });
}));

vaultsRouter.get('/:id/status', asyncHandler(async (req, res) => {
  const ctx = await getVaultContext(req.params.id);
  if (!ctx) return void res.status(404).json({ error: 'Unknown vault' });
  try {
    await ensureReady(ctx);
  } catch (e: any) {
    return void res.json({ id: ctx.id, active: ctx.storage.kind, error: String(e?.message ?? e), remote: null });
  }
  res.json({ id: ctx.id, active: ctx.storage.kind, remote: runInVault(ctx, () => ctx.storage.remoteInfo?.() ?? null) });
}));
