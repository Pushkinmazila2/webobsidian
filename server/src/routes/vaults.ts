import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth, requireAdmin } from '../middleware/auth.js';
import { authenticateToken } from '../services/auth.js';
import { principalFor, vaultAccessible, currentPrincipal } from '../services/acl.js';
import { getSettings, updateSettings, VaultSchema, type VaultConfig } from '../services/settings.js';
import { applyStoragePatch, badRequest } from '../services/storagepatch.js';
import { DEFAULT_VAULT_ID, runInVault } from '../services/vaultals.js';
import { dropVault, ensureReady, extraVaultConfigs, getDefaultContext, getVaultContext, listVaults, pluginsModeOf } from '../services/vaults.js';
import * as pluginsSvc from '../services/plugins.js';
import type { VaultCtx } from '../services/vaultals.js';
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
    const user = !isAgent && token ? await authenticateToken(token) : null;
    if (!isAgent && !user) return next();
    // A person without any access to this vault is told it does not exist.
    if (user && !vaultAccessible(await principalFor(user), id)) {
      res.status(404).json({ error: 'Unknown vault' });
      return;
    }
    const ctx = await getVaultContext(id);
    if (!ctx) {
      res.status(404).json({ error: 'Unknown vault' });
      return;
    }
    await ensureReady(ctx);
    // Git sync (a local clone + remote) belongs to the main vault; a GitHub vault maps the same
    // endpoints onto its driver (status bar, "save now").
    if (req.path.startsWith('/git') && ctx.storage.kind === 'local') {
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
  storage: { ...c.storage, github: { ...c.storage.github, token: c.storage.github.token ? MASK : '' }, git: { ...c.storage.git, token: c.storage.git.token ? MASK : '' } },
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
  if (body.plugins && typeof body.plugins === 'object' && body.plugins.mode !== undefined) {
    if (body.plugins.mode !== 'own' && body.plugins.mode !== 'shared') badRequest('plugins.mode must be "own" or "shared"');
    base.plugins.mode = body.plugins.mode;
  }
  if (body.storage && typeof body.storage === 'object') applyStoragePatch(base.storage, body.storage);
  if (base.storage.driver === 'local') {
    if (!base.path) badRequest('a local vault needs a folder path');
    await assertVaultPathAllowed({ path: base.path });
  } else if (base.storage.driver === 'git') {
    if (!base.storage.git.url) badRequest('a Git vault needs the remote URL');
  } else if (!base.storage.github.owner || !base.storage.github.repo) {
    badRequest('a GitHub vault needs the repository owner and name');
  }
  return base;
}

export const vaultsRouter = Router();
vaultsRouter.use(requireAuth);

// Listing is for everyone (only vaults they can open); everything else is the administrator's.
vaultsRouter.use((req, res, next) => (req.method === 'GET' && req.path === '/' ? next() : requireAdmin(req, res, next)));

vaultsRouter.get('/', asyncHandler(async (_req, res) => {
  const p = currentPrincipal();
  res.json({ vaults: (await listVaults()).filter((v) => vaultAccessible(p, v.id)) });
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

// ---- plugins: which ones a vault has -----------------------------------------------------------------------

const PLUGIN_ID = /^[a-zA-Z0-9._-]+$/;
const PLUGINS_DIR = '.obsidian/plugins';

async function openCtx(id: string): Promise<VaultCtx> {
  const ctx = id === DEFAULT_VAULT_ID ? getDefaultContext() : await getVaultContext(id);
  if (!ctx) throw Object.assign(new Error('Unknown vault'), { status: 404 });
  await ensureReady(ctx);
  return ctx;
}

/** Every file of a plugin folder (code, styles, manifest and its saved settings). */
async function readPluginFiles(ctx: VaultCtx, id: string): Promise<{ rel: string; data: Buffer }[]> {
  const out: { rel: string; data: Buffer }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await ctx.storage.listDir(dir)) {
      const rel = `${dir}/${e.name}`;
      if (e.isDir) await walk(rel);
      else out.push({ rel, data: await ctx.storage.readBuffer(rel) });
    }
  };
  await walk(`${PLUGINS_DIR}/${id}`);
  return out;
}

/** Plugins the vault itself has, and those another vault has that it could take over. */
vaultsRouter.get('/:id/plugins', asyncHandler(async (req, res) => {
  const mode = await pluginsModeOf(req.params.id);
  const from = String(req.query.from ?? DEFAULT_VAULT_ID);
  const list = async (id: string) => {
    const ctx = await openCtx(id);
    return runInVault(ctx, () => pluginsSvc.listInstalled());
  };
  const own = mode === 'shared' ? [] : await list(req.params.id);
  const source = from === req.params.id ? [] : await list(from);
  const have = new Set(own.map((p) => p.id));
  const pick = (p: any) => ({ id: p.id, name: p.name, version: p.version, enabled: p.enabled });
  res.json({ mode, from, own: own.map(pick), available: source.filter((p) => !have.has(p.id)).map(pick) });
}));

/**
 * Take chosen plugins over from another vault (default: the main one): the whole folder is copied — code and the plugin's saved
 * settings — and switched on if it was on. `move: true` removes them from the source afterwards.
 */
vaultsRouter.post('/:id/plugins/transfer', asyncHandler(async (req, res) => {
  const target = req.params.id;
  const from = String(req.body?.from ?? DEFAULT_VAULT_ID);
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((x) => typeof x === 'string' && PLUGIN_ID.test(x) && x !== '.' && x !== '..')) {
    badRequest('ids must be a list of plugin ids');
  }
  if (from === target) badRequest('choose a different source vault');
  if ((await pluginsModeOf(target)) === 'shared') badRequest('This vault uses the main vault’s plugins; switch it to “own plugins” first');
  if ((await pluginsModeOf(from)) === 'shared') badRequest('The source vault uses the main vault’s plugins; take them from the main vault instead');
  const src = await openCtx(from);
  const dst = await openCtx(target);
  const done: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids as string[]) {
    try {
      const wasEnabled = await runInVault(src, async () => (await pluginsSvc.listInstalled()).find((p) => p.id === id)?.enabled ?? false);
      const files = await readPluginFiles(src, id);
      if (!files.length) throw new Error('not installed in the source vault');
      for (const f of files) await dst.storage.writeBuffer(f.rel, f.data);
      if (wasEnabled) await runInVault(dst, () => pluginsSvc.setEnabled(id, true));
      if (req.body?.move) await runInVault(src, () => pluginsSvc.uninstall(id));
      done.push(id);
    } catch (e: any) {
      failed.push({ id, error: String(e?.message ?? e) });
    }
  }
  res.json({ done, failed });
}));
