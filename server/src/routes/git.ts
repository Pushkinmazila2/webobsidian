import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as git from '../services/git.js';
import { getStorage } from '../services/vault.js';
import { getSettings } from '../services/settings.js';

export const gitRouter = Router();
gitRouter.use(requireAuth);

// With the GitHub storage driver there is no local repository: "sync" means
// "commit what is buffered" and "pull" means "look at the branch now". The same
// endpoints (and the status bar) keep working, mapped onto the driver.
const remote = () => (getStorage().kind === 'github' ? getStorage() : null);

async function remoteStatus() {
  const st = getStorage();
  const info = st.remoteInfo!();
  const pending = st.pendingChanges?.() ?? 0;
  const s = await getSettings();
  return {
    enabled: true,
    isRepo: true,
    branch: info.branch,
    ahead: pending, // changes not on GitHub yet
    behind: 0,
    staged: 0,
    modified: pending,
    notAdded: 0,
    conflicted: [] as string[],
    lfsAvailable: false,
    remote: info.repo,
    clean: pending === 0,
    driver: 'github' as const,
    lastError: info.lastError,
    conflictCopies: info.conflicts,
    autoSyncEnabled: s.git.enabled,
  };
}

gitRouter.use((req, res, next) => {
  const st = remote();
  if (!st) return next();
  void (async () => {
    try {
      const route = `${req.method} ${req.path}`;
      if (route === 'GET /status') return res.json(await remoteStatus());
      if (route === 'GET /log' || route === 'GET /show') {
        return res.status(501).json({ error: 'File history is not available yet for GitHub storage' });
      }
      if (route === 'POST /init' || route === 'POST /clone') {
        return res.status(400).json({ error: 'Not applicable: the vault is stored in a GitHub repository, there is nothing to initialise or clone' });
      }
      if (route === 'POST /pull') {
        await st.refresh!();
        return res.json({ message: 'Checked GitHub for new commits' });
      }
      if (route === 'POST /commit' || route === 'POST /push') {
        const n = st.pendingChanges?.() ?? 0;
        await st.flush!();
        return res.json({ message: n ? `Committed ${n} change(s) to GitHub` : 'Nothing to commit' });
      }
      if (route === 'POST /sync') {
        const n = st.pendingChanges?.() ?? 0;
        const log: string[] = [];
        let ok = true;
        try {
          await st.flush!();
          log.push(n ? `committed ${n} change(s)` : 'nothing to commit');
          await st.refresh!();
          log.push('up to date with GitHub');
        } catch (e: any) {
          ok = false;
          log.push(String(e?.message ?? e));
        }
        return res.json({ ok, log });
      }
      next();
    } catch (e) {
      next(e);
    }
  })();
});

gitRouter.get('/status', asyncHandler(async (_req, res) => res.json(await git.status())));

gitRouter.get(
  '/log',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '').trim();
    if (!path) return res.status(400).json({ error: 'path required' });
    res.json({ commits: await git.log(path) });
  }),
);

gitRouter.get(
  '/show',
  asyncHandler(async (req, res) => {
    const hash = String(req.query.hash ?? '').trim();
    const path = String(req.query.path ?? '').trim();
    if (!hash || !path) return res.status(400).json({ error: 'hash and path required' });
    res.json({ content: await git.showFile(hash, path) });
  }),
);

gitRouter.post(
  '/init',
  asyncHandler(async (_req, res) => {
    await git.init();
    res.json(await git.status());
  }),
);

gitRouter.post(
  '/clone',
  asyncHandler(async (_req, res) => {
    await git.clone();
    res.json(await git.status());
  }),
);

gitRouter.post(
  '/pull',
  asyncHandler(async (_req, res) => {
    const message = await git.pull();
    console.log('[git] pull:', message);
    res.json({ message });
  }),
);

gitRouter.post(
  '/commit',
  asyncHandler(async (req, res) => {
    const message = await git.commitAll(String(req.body?.message ?? ''));
    console.log('[git] commit:', message);
    res.json({ message });
  }),
);

gitRouter.post(
  '/push',
  asyncHandler(async (_req, res) => {
    const message = await git.push();
    console.log('[git] push:', message);
    res.json({ message });
  }),
);

gitRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    console.log('[git] manual sync requested');
    const result = await git.sync(req.body?.message);
    console.log(`[git] sync ${result.ok ? 'ok' : 'not-ok'}:`, result.log.join(' | '));
    res.json(result);
  }),
);
