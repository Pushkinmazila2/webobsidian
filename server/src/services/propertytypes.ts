import * as vault from './vault.js';

/**
 * Obsidian stores per-vault property type assignments in `.obsidian/types.json`
 * ({ "types": { "<key>": "<type>" } } with types text|multitext|number|checkbox|
 * date|datetime|tags|aliases). We read/write the same file so WebObsidian's
 * property types interoperate with the Obsidian app.
 */

const TYPES_FILE = '.obsidian/types.json';

export async function readPropertyTypes(): Promise<Record<string, string>> {
  try {
    const raw = await vault.readFileText(TYPES_FILE);
    const data = JSON.parse(raw);
    return data && typeof data.types === 'object' ? (data.types as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function setPropertyType(key: string, type: string): Promise<Record<string, string>> {
  let data: { types: Record<string, string> } = { types: {} };
  try {
    const parsed = JSON.parse(await vault.readFileText(TYPES_FILE));
    if (parsed && typeof parsed === 'object') data = { ...parsed, types: { ...(parsed.types ?? {}) } };
  } catch {
    /* no existing file */
  }
  data.types[key] = type;
  await vault.writeFileText(TYPES_FILE, JSON.stringify(data, null, 2));
  return data.types;
}
