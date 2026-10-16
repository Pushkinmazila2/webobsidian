import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as plugins from '../services/plugins.js';
import { getStorage } from '../services/vault.js';

export const pluginsRouter = Router();
pluginsRouter.use(requireAuth);

pluginsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const remote = getStorage().remoteInfo?.();
    // `unsaved`: plugin changes the server is still holding back before committing them (GitHub storage)
    res.json({ plugins: await plugins.listInstalled(), unsaved: remote?.held ?? 0 });
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
