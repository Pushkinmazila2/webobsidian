import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings } from '../services/settings.js';
import { qmd } from '../services/search.js';
import { updateLinkGraphForFile } from '../services/links.js';
import { scheduleAutoCommitOnSave } from '../services/git.js';
import { resolveFile } from '../services/fileindex.js';
import { onFileRenamed } from '../services/shares.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';
import { asSystem } from '../services/acl.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

// Refresh derived indexes after a mutation (best-effort, non-blocking).
// Incremental: only the touched file(s) are reparsed, not the whole vault.
function reindex(opts: { upsert?: string; added?: string; removed?: string } = {}) {
  // Indexes are shared by everyone: update them as the system, not with this person's view of the vault.
  asSystem(() => {
    if (opts.upsert) void qmd.upsert(opts.upsert).catch(() => {});
    if (opts.added && isMd(opts.added)) void updateLinkGraphForFile(opts.added).catch(() => {});
    if (opts.removed && isMd(opts.removed)) void updateLinkGraphForFile(opts.removed, true).catch(() => {});
    scheduleAutoCommitOnSave();
  });
}

filesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await vault.listTree());
  }),
);

// Raw directory access for plugins (`app.vault.adapter.list/stat/exists`): unlike the tree, hidden entries
// such as `.obsidian/plugins/x` are visible here. `.git` is never exposed.
const adapterPath = (raw: unknown): string => {
  const rel = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel.split('/').some((seg) => seg === '..' || seg === '.git')) throw Object.assign(new Error('forbidden path'), { status: 400 });
  return rel;
};

filesRouter.get(
  '/list',
  asyncHandler(async (req, res) => {
    const rel = adapterPath(req.query.path);
    let entries;
    try { entries = await vault.listDir(rel); } catch { res.status(404).json({ error: 'not a folder' }); return; }
    const join = (n: string) => (rel ? `${rel}/${n}` : n);
    res.json({
      files: entries.filter((e) => !e.isDir && e.name !== '.git').map((e) => join(e.name)),
      folders: entries.filter((e) => e.isDir && e.name !== '.git').map((e) => join(e.name)),
    });
  }),
);

filesRouter.get(
  '/stat',
  asyncHandler(async (req, res) => {
    const rel = adapterPath(req.query.path);
    if (rel === '') { res.json({ type: 'folder', size: 0, ctime: 0, mtime: 0 }); return; }
    const i = rel.lastIndexOf('/');
    const parent = i < 0 ? '' : rel.slice(0, i);
    const name = rel.slice(i + 1);
    let entry;
    try { entry = (await vault.listDir(parent)).find((e) => e.name === name); } catch { /* parent missing */ }
    if (!entry) { res.status(404).json({ error: 'not found' }); return; }
    if (entry.isDir) { res.json({ type: 'folder', size: 0, ctime: 0, mtime: 0 }); return; }
    let size = 0, mtime = 0, ctime = 0;
    try {
      const root = await vault.getVaultRoot();
      const st = await fsp.stat(path.resolve(root, rel));
      size = st.size; mtime = st.mtimeMs; ctime = st.birthtimeMs || st.mtimeMs;
    } catch {
      try { size = (await vault.readFileBuffer(rel)).length; } catch { /* leave zeros */ }
    }
    res.json({ type: 'file', size, ctime, mtime });
  }),
);

filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    let rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    // Obsidian-style resolution: if the exact path doesn't exist (e.g. an embed
    // `![[image.jpg]]` that lives in Attachments/), resolve it by basename.
    if (!(await vault.exists(rel))) {
      const resolved = resolveFile(rel);
      if (resolved) rel = resolved;
    }
    if (vault.isTextFile(rel)) {
      res.json({ path: rel, content: await vault.readFileText(rel), encoding: 'utf8' });
    } else {
      // Stream with Range support so embedded <video>/<audio> can seek.
      await sendFileWithRange(req, res, await vault.openFile(rel), mimeFor(rel));
    }
  }),
);

filesRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path: rel, content } = req.body ?? {};
    if (typeof rel !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'path and content required' });
      return;
    }
    await vault.writeFileText(rel, content);
    reindex({ upsert: rel, added: rel });
    res.json({ ok: true, path: rel });
  }),
);

filesRouter.post(
  '/folder',
  asyncHandler(async (req, res) => {
    const { path: rel } = req.body ?? {};
    if (typeof rel !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.createFolder(rel);
    res.json({ ok: true, path: rel });
  }),
);

filesRouter.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const dir = String(req.body?.dir ?? '');
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file required' });
      return;
    }
    // Reuse an existing folder that differs only in case (e.g. an Obsidian vault's
    // "Attachments") instead of creating a duplicate "attachments". See vault.ts.
    const resolvedDir = dir ? await vault.resolveDirCaseInsensitive(dir) : '';
    const rel = path.posix.join(resolvedDir, file.originalname);
    await vault.writeFileBuffer(rel, file.buffer);
    res.json({ ok: true, path: rel, size: file.size });
  }),
);

filesRouter.patch(
  '/rename',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    await vault.rename(from, to);
    await qmd.rename(from, to);
    await onFileRenamed(from, to).catch(() => {}); // keep public share links pointing at the note
    reindex({ added: to, removed: from });
    res.json({ ok: true, from, to });
  }),
);

filesRouter.post(
  '/copy',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    const copied = await vault.copy(from, to);
    for (const f of copied) {
      if (isMd(f)) {
        void qmd.upsert(f).catch(() => {});
        void updateLinkGraphForFile(f).catch(() => {});
      }
    }
    scheduleAutoCommitOnSave();
    res.json({ ok: true, from, to });
  }),
);

// --- Trash (FR-1) -----------------------------------------------------------
// Listed/mutated via dedicated /trash* routes; the plain DELETE / below either
// trashes or permanently removes depending on settings.vault.deleteMode.

filesRouter.get(
  '/trash',
  asyncHandler(async (_req, res) => {
    res.json({ items: await vault.listTrash() });
  }),
);

filesRouter.post(
  '/trash/restore',
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const restored = await vault.restoreFromTrash(rel);
    reindex({ upsert: restored, added: restored });
    res.json({ ok: true, restored });
  }),
);

// Permanently delete one trashed item.
filesRouter.delete(
  '/trash/item',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.deleteFromTrash(rel);
    res.json({ ok: true });
  }),
);

// Empty the whole trash.
filesRouter.delete(
  '/trash',
  asyncHandler(async (_req, res) => {
    await vault.emptyTrash();
    res.json({ ok: true });
  }),
);

filesRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const s = await getSettings();
    qmd.remove(rel);
    if (s.vault.deleteMode === 'permanent') {
      await vault.remove(rel);
      reindex({ removed: rel });
      res.json({ ok: true, deleted: rel });
      return;
    }
    const dest = await vault.trash(rel);
    reindex({ removed: rel });
    res.json({ ok: true, trashed: dest });
  }),
);
