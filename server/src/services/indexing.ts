import { qmd } from './search.js';
import { updateLinkGraphForFile } from './links.js';
import { scheduleAutoCommitOnSave } from './git.js';
import { asSystem } from './acl.js';

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

/**
 * Refresh derived indexes after a mutation (best-effort, non-blocking). Incremental: only the touched file(s) are reparsed,
 * not the whole vault. Indexes are shared by everyone, so this runs as the system, not with one person's view of the vault.
 * Must be called inside the vault's scope (runInVault).
 */
export function reindex(opts: { upsert?: string; added?: string; removed?: string } = {}): void {
  asSystem(() => {
    if (opts.upsert) void qmd.upsert(opts.upsert).catch(() => {});
    if (opts.added && isMd(opts.added)) void updateLinkGraphForFile(opts.added).catch(() => {});
    if (opts.removed && isMd(opts.removed)) void updateLinkGraphForFile(opts.removed, true).catch(() => {});
    scheduleAutoCommitOnSave();
  });
}
