import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { currentVault } from './vaultals.js';

/**
 * Persisted UI/workspace state (open tabs, active note, expanded folders, panel
 * layout, bookmarks, recents). Stored server-side as a plain JSON file so the
 * workspace follows a person across browsers/devices — not tied to one browser's
 * localStorage. One file per person and vault: people no longer share tabs.
 */

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** `uistate[-<vault>]-<userId>.json`. */
const fileFor = (userId: string) => {
  const v = currentVault();
  return path.join(config.dataDir, `uistate${v.isDefault ? '' : `-${v.id}`}-${safe(userId)}.json`);
};

/** The shared file of the single-user versions (main vault: `uistate.json`, others: `uistate-<vault>.json`). */
const legacyFile = () => {
  const v = currentVault();
  return path.join(config.dataDir, v.isDefault ? 'uistate.json' : `uistate-${v.id}.json`);
};

/**
 * `inheritLegacy`: until an administrator has saved a workspace of their own, they continue
 * from the one the single-user install had. Nobody else gets it — it names the owner's open notes.
 */
export async function readUiState(userId: string, inheritLegacy = false): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(fileFor(userId), 'utf8'));
  } catch {
    if (!inheritLegacy) return {};
  }
  try {
    return JSON.parse(await fs.readFile(legacyFile(), 'utf8'));
  } catch {
    return {};
  }
}

export async function writeUiState(userId: string, state: Record<string, unknown>): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const FILE = fileFor(userId);
  const tmp = `${FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, FILE);
}
