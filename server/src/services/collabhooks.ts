/**
 * Late-bound link between the vault facade / vault registry and the co-editing rooms (services/collab.ts).
 * Kept apart so neither of them imports the room manager (which imports them) — no import cycles.
 */
export interface CollabHooks {
  /** Live text of an open room, if there is one (REST readers see unsaved edits). */
  peek(vaultId: string, rel: string): string | undefined;
  /** A write through REST/plugins to a file that is open in a room: merged into the room instead. True = handled. */
  write(vaultId: string, rel: string, content: string, userId: string | null): Promise<boolean>;
  /** The storage reported a change made outside this process. */
  external(vaultId: string, rel: string, type: 'add' | 'change' | 'unlink'): void;
  /** A file or folder was renamed, deleted or trashed: rooms below it are closed. */
  gone(vaultId: string, rel: string): void;
}

export let collabHooks: CollabHooks | null = null;
export const setCollabHooks = (h: CollabHooks | null): void => {
  collabHooks = h;
};
