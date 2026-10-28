import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getSettings, updateSettings, redactSettings, ensureVaultBrowsable, storageLockedBy } from '../services/settings.js';
import { config } from '../config.js';
import { getStorage } from '../services/vault.js';
import { extraVaultConfigs, storageRestartRequired } from '../services/vaults.js';
import { GithubClient, GithubError, TOKEN_ENV } from '../storage/github/index.js';
import { applyStoragePatch } from '../services/storagepatch.js';
import { GIT_TOKEN_ENV, testGitRemote } from '../storage/gitrepo/index.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// Everything except GET / is the administrator's (tokens, storage, vault paths, plugin switches…).
settingsRouter.use((req, res, next) => (req.method === 'GET' && req.path === '/' ? next() : requireAdmin(req, res, next)));

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const full = redactSettings(await getSettings());
    if (req.user?.isAdmin) return void res.json(full);
    // Other people get what the editor needs (theme, view mode, trash/attachment behaviour, plugin switches) and nothing about
    // where the vault lives, how it is reached or how anyone signs in.
    res.json({
      ui: full.ui,
      search: full.search,
      vault: { trash: full.vault.trash, deleteMode: full.vault.deleteMode, attachmentDir: full.vault.attachmentDir },
      plugins: { enabled: full.plugins.enabled, installed: full.plugins.installed, allowUnsafeEval: full.plugins.allowUnsafeEval },
    });
  }),
);

// Patch a subset of settings. Secret fields are only overwritten when present.
settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    // A changed vault.path turns the whole files API into read/write over that
    // tree, so constrain it to the allowed roots (same gate as Browse…) and
    // require it to be an existing directory before persisting.
    if (body.vault && typeof body.vault.path === 'string' && body.vault.path) {
      await assertVaultPathAllowed(body.vault);
    }
    const updated = await updateSettings((d) => {
      if (body.vault) {
        Object.assign(d.vault, sanitizeVault(body.vault));
        ensureVaultBrowsable(d);
      }
      if (body.git) {
        const { token, ...rest } = body.git;
        Object.assign(d.git, rest);
        if (typeof token === 'string' && token && token !== '••••••••') d.git.token = token;
      }
      if (body.storage) applyStoragePatch(d.storage, body.storage);
      if (body.search) Object.assign(d.search, body.search);
      if (body.ui) Object.assign(d.ui, body.ui);
      if (body.api && typeof body.api.rateLimitPerMin === 'number') {
        d.api.rateLimitPerMin = body.api.rateLimitPerMin;
      }
      if (body.plugins && body.plugins.catalogRefreshHours !== undefined) {
        const h = body.plugins.catalogRefreshHours;
        if (typeof h !== 'number' || !Number.isFinite(h) || h < 0 || h > 24 * 30) {
          throw Object.assign(new Error('plugins.catalogRefreshHours must be a number from 0 to 720'), { status: 400 });
        }
        d.plugins.catalogRefreshHours = h;
      }
      if (body.plugins && body.plugins.allowUnsafeEval !== undefined) {
        if (typeof body.plugins.allowUnsafeEval !== 'boolean') throw Object.assign(new Error('plugins.allowUnsafeEval must be a boolean'), { status: 400 });
        d.plugins.allowUnsafeEval = body.plugins.allowUnsafeEval;
      }
    });
    res.json(redactSettings(updated));
  }),
);

/** Token the driver will actually use: the env var wins over settings.json. */
function tokenSource(stored: string): 'env' | 'settings' | 'none' {
  return process.env[TOKEN_ENV] ? 'env' : stored ? 'settings' : 'none';
}

settingsRouter.get(
  '/storage/status',
  asyncHandler(async (_req, res) => {
    const s = await getSettings();
    const st = getStorage();
    res.json({
      active: st.kind,
      configured: s.storage.driver,
      restartRequired: storageRestartRequired(s),
      tokenSource: tokenSource(s.storage.github.token),
      tokenEnvVar: TOKEN_ENV,
      gitTokenSource: process.env[GIT_TOKEN_ENV] ? 'env' : s.storage.git.token ? 'settings' : 'none',
      gitTokenEnvVar: GIT_TOKEN_ENV,
      locked: storageLockedBy(), // settings path → environment variable that sets it (read-only in the UI)
      remote: st.remoteInfo?.() ?? null,
    });
  }),
);

// Try the given (or saved) GitHub settings without saving or switching anything.
settingsRouter.post(
  '/storage/test',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    // `vault` = test an extra vault (its saved settings + env token), else the main one.
    const extra = req.body?.vault ? extraVaultConfigs(s).find((v) => v.conf.id === req.body.vault)?.conf : undefined;
    const draft: any = JSON.parse(JSON.stringify(extra ? extra.storage : s.storage));
    if (req.body?.git !== undefined) {
      // Git remote: `git ls-remote` with the given (or saved) URL + credentials; nothing is cloned or saved.
      applyStoragePatch(draft, { git: req.body.git ?? {} });
      const gt = draft.git;
      if (!gt.url) return res.json({ ok: false, error: 'Enter the remote URL first' });
      const tokenVar = (typeof req.body?.tokenEnv === 'string' && req.body.tokenEnv) || extra?.tokenEnv || GIT_TOKEN_ENV;
      const r = await testGitRemote({ url: gt.url, branch: gt.branch || undefined, username: gt.username || undefined, token: process.env[tokenVar] || gt.token || undefined });
      return res.json(r.ok ? { ...r, branch: gt.branch || r.defaultBranch } : r);
    }
    applyStoragePatch(draft, { github: req.body?.github ?? {} });
    const g = draft.github;
    const tokenVar = (typeof req.body?.tokenEnv === 'string' && req.body.tokenEnv) || extra?.tokenEnv || TOKEN_ENV;
    const token = process.env[tokenVar] || g.token;
    if (!g.owner || !g.repo) return res.json({ ok: false, error: 'Enter the repository owner and name first' });
    if (!token) return res.json({ ok: false, error: `No token: set ${tokenVar} on the server or paste one here` });
    const client = new GithubClient({ apiUrl: g.apiUrl, token, maxRetries: 1, maxRateWaitMs: 2000 });
    try {
      const repo = await client.getRepo(g.owner, g.repo);
      const branch = g.branch || repo.default_branch;
      const commit = await client.getBranchSha(g.owner, g.repo, branch);
      const tree = await client.getTree(g.owner, g.repo, await client.getCommitTreeSha(g.owner, g.repo, commit), true);
      const base = g.basePath ? `${g.basePath}/` : '';
      const files = tree.tree.filter((e: any) => e.type === 'blob' && e.path.startsWith(base));
      res.json({
        ok: true,
        private: repo.private,
        defaultBranch: repo.default_branch,
        branch,
        canWrite: repo.permissions?.push ?? null, // null = GitHub did not say (e.g. fine-grained token)
        basePathFound: !g.basePath || tree.tree.some((e: any) => e.path === g.basePath && e.type === 'tree'),
        files: files.length,
        notes: files.filter((e: any) => /\.(md|markdown|canvas)$/i.test(e.path)).length,
        truncated: Boolean(tree.truncated),
        rateRemaining: client.rate?.remaining ?? null,
      });
    } catch (e: any) {
      const upstream = e instanceof GithubError ? e.upstream ?? e.status : undefined;
      const hint =
        upstream === 401 ? 'GitHub rejected the token (bad or expired).'
        : upstream === 403 ? 'The token is not allowed to read this repository (needs Contents: Read, plus Write for editing).'
        : upstream === 404 ? 'Repository or branch not found — or the token cannot see it.'
        : '';
      res.json({ ok: false, error: [hint, String(e?.message ?? e)].filter(Boolean).join(' ') });
    }
  }),
);

function sanitizeVault(v: any) {
  const out: any = {};
  if (typeof v.path === 'string') out.path = v.path;
  if (typeof v.trash === 'string') out.trash = v.trash;
  if (v.deleteMode === 'trash' || v.deleteMode === 'permanent') out.deleteMode = v.deleteMode;
  if (typeof v.attachmentDir === 'string') out.attachmentDir = v.attachmentDir;
  if (Array.isArray(v.allowedRoots)) {
    // allowedRoots is the gate for vault.path / Browse, so keep it well-formed:
    // only non-empty strings, normalised to absolute paths. Drops anything else
    // instead of persisting garbage (objects/numbers) that later crash path.* .
    out.allowedRoots = v.allowedRoots
      .filter((r: unknown): r is string => typeof r === 'string' && r.trim() !== '')
      .map((r: string) => path.resolve(r));
  }
  return out;
}

/** The roots a new vault path may live under — mirrors GET /browse. */
async function effectiveRoots(newAllowed?: unknown): Promise<string[]> {
  const s = await getSettings();
  const fromBody = Array.isArray(newAllowed)
    ? (newAllowed as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  const roots = fromBody.length
    ? fromBody
    : s.vault.allowedRoots.length
      ? s.vault.allowedRoots
      : config.allowedRoots.length
        ? config.allowedRoots
        : [os.homedir()];
  return roots.map((r) => path.resolve(r));
}

export async function assertVaultPathAllowed(v: any): Promise<void> {
  const target = path.resolve(String(v.path));
  const roots = await effectiveRoots(v.allowedRoots);
  const within = roots.some((r) => target === r || target.startsWith(r + path.sep));
  if (!within) {
    throw Object.assign(new Error('Vault path is outside the allowed roots'), { status: 403 });
  }
  const st = await fs.stat(target).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw Object.assign(new Error('Vault path is not an existing directory'), { status: 400 });
  }
}


/** Safe folder browser for picking a vault path, limited to allowed roots. */
settingsRouter.get(
  '/browse',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const roots = s.vault.allowedRoots.length
      ? s.vault.allowedRoots
      : config.allowedRoots.length
        ? config.allowedRoots
        : [os.homedir()];
    const dir = req.query.dir ? path.resolve(String(req.query.dir)) : roots[0];

    const allowed = roots.some((r) => {
      const rr = path.resolve(r);
      return dir === rr || dir.startsWith(rr + path.sep);
    });
    if (!allowed) {
      res.status(403).json({ error: 'Path outside allowed roots', roots });
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ dir, parent: path.dirname(dir), roots, folders });
  }),
);
