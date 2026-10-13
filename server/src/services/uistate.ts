import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { currentVault } from './vaultals.js';

/**
 * Persisted UI/workspace state (open tabs, active note, expanded folders, panel
 * layout, bookmarks, recents). Stored server-side as a plain JSON file so the
 * workspace is shared across browsers/devices — not tied to one browser's
 * localStorage. Single-user app → one shared state file.
 */

/** The main vault keeps the original file; extra vaults get their own (tabs differ per vault). */
const fileFor = () => {
  const v = currentVault();
  return path.join(config.dataDir, v.isDefault ? 'uistate.json' : `uistate-${v.id}.json`);
};

export async function readUiState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(fileFor(), 'utf8'));
  } catch {
    return {};
  }
}

export async function writeUiState(state: Record<string, unknown>): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const FILE = fileFor();
  const tmp = `${FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, FILE);
}
