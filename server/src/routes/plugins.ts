import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import * as plugins from '../services/plugins.js';
import * as catalog from '../services/plugincatalog.js';
import { getStorage } from '../services/vault.js';
import { currentVault, runInVault } from '../services/vaultals.js';
import { ensureReady, getDefaultContext, pluginsModeOf } from '../services/vaults.js';

export const pluginsRouter = Router();
pluginsRouter.use(requireAuth);
// Installing, enabling and configuring plugins is the administrator's call; everyone may list them.
pluginsRouter.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : requireAdmin(req, res, next)));

// A vault set to "same plugins as the main vault" reads and writes the main vault's plugin folder, so the plugin list, the
// code and every plugin's saved settings are literally the same files.
pluginsRouter.use(asyncHandler(async (_req, _res, next) => {
  const cur = currentVault();
  if (cur.isDefault || (await pluginsModeOf(cur.id)) !== 'shared') return next();
  const main = getDefaultContext();
  await ensureReady(main);
  runInVault(main, next);
}));

pluginsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const remote = getStorage().remoteInfo?.();
    // `compat`: rating from the cached catalogue (no network), undefined for plugins it does not know
    const installed = await Promise.all(
      (await plugins.listInstalled()).map(async (p) => ({ ...p, ...(await catalog.compatOf(p.id)) })),
    );
    // `unsaved`: plugin changes the server is still holding back before committing them (GitHub storage)
    res.json({ plugins: installed, unsaved: remote?.held ?? 0 });
  }),
);

// Community catalogue with compatibility ratings: filtered and paged here (the list has thousands of plugins).
pluginsRouter.get(
  '/catalog',
  asyncHandler(async (req, res) => {
    const s = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
    const n = (k: string) => (s(k) !== undefined && Number.isFinite(Number(s(k))) ? Number(s(k)) : undefined);
    res.json(
      await catalog.query(
        { q: s('q'), status: s('status'), compat: s('compat'), sort: s('sort'), offset: n('offset'), limit: n('limit') },
        await plugins.listInstalled(),
      ),
    );
  }),
);

// "Check now": download the catalogue regardless of the refresh interval.
pluginsRouter.post(
  '/catalog/refresh',
  asyncHandler(async (_req, res) => {
    try {
      await catalog.refresh();
    } catch (e: any) {
      res.status(502).json({ error: e.message, info: await catalog.info() });
      return;
    }
    res.json({ info: await catalog.info() });
  }),
);

pluginsRouter.post(
  '/install',
  asyncHandler(async (req, res) => {
    const repo = String(req.body?.repo ?? '');
    if (!repo) {
      res.status(400).json({ error: 'repo required (owner/name)' });
      return;
    }
    res.json({ plugin: await plugins.installFromGithub(repo) });
  }),
);

pluginsRouter.patch(
  '/:id/enabled',
  asyncHandler(async (req, res) => {
    await plugins.setEnabled(req.params.id, Boolean(req.body?.enabled));
    res.json({ ok: true });
  }),
);

pluginsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const removed = await plugins.uninstall(req.params.id);
    res.status(removed ? 200 : 404).json(removed ? { ok: true } : { error: 'plugin not installed' });
  }),
);

// Per-plugin settings: Plugin.loadData()/saveData() in the browser shim.
pluginsRouter.get(
  '/:id/data',
  asyncHandler(async (req, res) => res.json({ data: await plugins.getPluginData(req.params.id) })),
);
pluginsRouter.put(
  '/:id/data',
  asyncHandler(async (req, res) => {
    await plugins.savePluginData(req.params.id, req.body?.data);
    res.json({ ok: true });
  }),
);

// Serve plugin assets to the browser loader.
pluginsRouter.get(
  '/:id/:asset',
  asyncHandler(async (req, res) => {
    const asset = req.params.asset;
    if (!['main.js', 'styles.css', 'manifest.json'].includes(asset)) {
      res.status(400).json({ error: 'invalid asset' });
      return;
    }
    let body = await plugins.getPluginAsset(req.params.id, asset as any);
    // `?wrap=1`: the plugin's CommonJS code wrapped so the browser can run it with a plain
    // <script src> (allowed by the CSP `script-src 'self'`). Evaluating it from a string
    // (new Function) would need 'unsafe-eval', which the CSP deliberately does not grant.
    if (asset === 'main.js' && req.query.wrap) {
      body = plugins.wrapPluginCode(req.params.id, body);
      res.setHeader('Cache-Control', 'no-store');
    }
    const type =
      asset === 'main.js'
        ? 'application/javascript'
        : asset === 'styles.css'
          ? 'text/css'
          : 'application/json';
    res.setHeader('Content-Type', type).send(body);
  }),
);
