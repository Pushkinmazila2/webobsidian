import { useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';
import { currentVaultId } from './vault';

/**
 * Client side of real-time co-editing: one Yjs document + socket per open note (see server services/collab.ts).
 * The server seeds the text and writes the file; this module only joins the room and reports who else is in it.
 */

export interface Peer {
  id: string;
  name: string;
  color: string;
}
export interface Presence {
  /** Note currently edited together (null = classic single-user editing with autosave). */
  path: string | null;
  status: 'connecting' | 'connected' | 'offline';
  canWrite: boolean;
  peers: Peer[];
}

const MSG_ACCESS = 4;
let presence: Presence = { path: null, status: 'offline', canWrite: true, peers: [] };
const listeners = new Set<() => void>();
const publish = (p: Partial<Presence>) => {
  presence = { ...presence, ...p };
  listeners.forEach((l) => l());
};

export const usePresence = (): Presence =>
  useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => presence);

/** True while `path` lives in a room: its text is saved by the server, never by this tab's autosave. */
export const isCollabActive = (path: string | null): boolean => path !== null && presence.path === path;

export interface CollabSession {
  ytext: Y.Text;
  awareness: WebsocketProvider['awareness'];
  undoManager: Y.UndoManager;
  canWrite: () => boolean;
  /** Called once the document has been received from the server (and again after a reconnect). */
  onSynced: (cb: () => void) => void;
  destroy: () => void;
}

export function startCollab(path: string): CollabSession {
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const params: Record<string, string> = { path };
  if (currentVaultId() !== 'default') params.vault = currentVaultId();
  const provider = new WebsocketProvider(`${proto}://${window.location.host}/collab`, encodeURIComponent(path), doc, {
    params,
    disableBc: true, // every byte goes through the server, which is where permissions are enforced
  });
  let canWrite = true;
  let onSynced: (() => void) | null = null;
  let synced = false;

  provider.messageHandlers[MSG_ACCESS] = (_enc, dec) => {
    canWrite = decoding.readVarUint(dec) === 1;
    publish({ canWrite });
  };

  const refreshPeers = () => {
    const byUser = new Map<string, Peer>();
    for (const [id, st] of provider.awareness.getStates()) {
      const u = (st as { user?: Peer }).user;
      if (id !== doc.clientID && u?.id && !byUser.has(u.id)) byUser.set(u.id, { id: u.id, name: u.name, color: u.color });
    }
    publish({ peers: [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name)) });
  };
  provider.awareness.on('change', refreshPeers);
  provider.on('status', ({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) =>
    publish({ status: status === 'disconnected' ? 'offline' : status }));
  provider.on('sync', (isSynced: boolean) => {
    if (!isSynced) return;
    synced = true;
    publish({ path }); // from here on this tab no longer saves the note itself
    onSynced?.();
  });

  publish({ path: null, status: 'connecting', canWrite: true, peers: [] });
  return {
    ytext,
    awareness: provider.awareness,
    undoManager: new Y.UndoManager(ytext),
    canWrite: () => canWrite,
    onSynced: (cb) => {
      onSynced = cb;
      if (synced) cb();
    },
    destroy: () => {
      provider.awareness.off('change', refreshPeers);
      provider.destroy();
      doc.destroy();
      if (presence.path === path || presence.path === null) publish({ path: null, status: 'offline', canWrite: true, peers: [] });
    },
  };
}
