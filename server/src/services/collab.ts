import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { config } from '../config.js';
import { diffOps, merge3 } from '../lib/textdiff.js';
import { asSystem, levelFor, principalFor, type Principal } from './acl.js';
import { levelNum } from '../db/aclstore.js';
import { getEditLogStore, getUserStore } from '../db/index.js';
import { authenticateToken, type AuthUser } from './auth.js';
import { runInVault, type VaultCtx } from './vaultals.js';
import { reindex } from './indexing.js';
import { setCollabHooks } from './collabhooks.js';
import { broadcast } from './realtime.js';

/**
 * Real-time co-editing of notes (Yjs).
 *
 * One room per open file. The server is the only seeder of a room's text and the only writer of the file: editors talk to the
 * room, the room saves to the vault's storage (debounced), so a GitHub/Git vault gets one write per pause, not one per keystroke.
 * Anything that changes the file from outside (REST, plugins, git pull) is merged into the room, never the other way round.
 */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_ACCESS = 4; // ours: varUint(4) varUint(canWrite ? 1 : 0)
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const READ = levelNum('read');
const WRITE = levelNum('write');
export const MAX_DOC_CHARS = 2 * 1024 * 1024;
const MAX_CONNS_PER_ROOM = 200;
const MAX_AWARENESS_IDS = 4;
const PERSIST_DELAY = 1000;
const PERSIST_MAX_WAIT = 5000;
const IDLE_DESTROY = 30_000;
const PING_EVERY = 30_000;
const STATE_TTL_DAYS = 30;
const ORIGIN_LOAD = 'collab:load';
const LOG_IDLE = 30_000;
const LOG_MAX_AGE = 5 * 60_000;
const SAMPLE_CHARS = 200;

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5a5', '#d6336c', '#7f8c00', '#9a6324', '#5c6bc0', '#008080', '#c2185b'];
const colorFor = (id: string) => COLORS[createHash('sha1').update(id).digest()[0] % COLORS.length];

const sha = (s: string) => createHash('sha1').update(s).digest('hex');
const isEligible = (rel: string) => /\.(md|markdown|txt)$/i.test(rel) && !rel.split('/').some((s) => s === '..');
export const collabEligible = isEligible;

interface Identity {
  id: string;
  name: string;
  color: string;
}
interface Conn {
  ws: WebSocket;
  token: string;
  user: Identity;
  canWrite: boolean;
  ids: Set<number>;
  alive: boolean;
}
interface Bucket {
  userId: string | null;
  name: string;
  kind: 'edit' | 'rest' | 'external';
  started: number;
  ended: number;
  inserted: number;
  deleted: number;
  sample: string;
  deletedSample: string;
}
interface Author {
  id: string;
  name: string;
}
interface Room {
  key: string;
  ctx: VaultCtx;
  rel: string;
  doc: Y.Doc;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Conn>;
  owners: Map<number, Conn>;
  /** The text the storage has (or is about to have): the base for merging outside changes. */
  saved: string;
  ready: Promise<void>;
  chain: Promise<unknown>;
  dirtySince: number;
  timer: NodeJS.Timeout | null;
  idle: NodeJS.Timeout | null;
  closed: boolean;
  lastError: string | null;
  /** Who wrote which Yjs client's text (so a selection can be traced to people even after a restart). */
  authors: Map<number, Author>;
  buckets: Map<string, Bucket>;
  logTimer: NodeJS.Timeout | null;
}

const rooms = new Map<string, Room>();
const keyOf = (vaultId: string, rel: string) => `${vaultId}\0${rel}`;
const stateBase = (key: string) => path.join(config.dataDir, 'collab', sha(key));

const log = (...a: unknown[]) => console.error('[collab]', ...a);

// ---- access ----------------------------------------------------------------------------
export function accessFor(principal: Principal, vaultId: string, rel: string): { enabled: boolean; canWrite: boolean } {
  if (!isEligible(rel)) return { enabled: false, canWrite: false };
  const lvl = levelFor(principal, vaultId, rel);
  return { enabled: lvl >= READ, canWrite: lvl >= WRITE };
}

// ---- who is in which note --------------------------------------------------------------
const writersOf = (room: Room) => {
  const seen = new Map<string, Identity>();
  for (const c of room.conns.values()) if (c.canWrite && !seen.has(c.user.id)) seen.set(c.user.id, c.user);
  return [...seen.values()];
};
/** Tell everyone's file tree who is editing this note (the receiving side filters by read access). */
function announce(room: Room): void {
  broadcast({ type: 'presence', vault: room.ctx.id, path: room.rel, users: room.closed ? [] : writersOf(room) });
}
/** Every note somebody is editing right now (sent to a socket when it connects). */
export const presenceSnapshot = () =>
  [...rooms.values()].map((r) => ({ vault: r.ctx.id, path: r.rel, users: writersOf(r) })).filter((x) => x.users.length);

// ---- who changed what ----------------------------------------------------------------
function actorOf(room: Room, origin: unknown): { userId: string | null; name: string; kind: Bucket['kind'] } | null {
  if (origin === ORIGIN_LOAD) return null;
  const conn = origin as Conn | null;
  if (conn && typeof conn === 'object' && 'user' in conn && 'ws' in conn) return { userId: conn.user.id, name: conn.user.name, kind: 'edit' };
  const o = origin as { rest?: string | null; external?: boolean } | null;
  if (o && typeof o === 'object' && 'rest' in o) return { userId: o.rest ?? null, name: restNames.get(o.rest ?? '') ?? 'API', kind: 'rest' };
  if (o && typeof o === 'object' && o.external) return { userId: null, name: 'Outside change', kind: 'external' };
  return null;
}
const restNames = new Map<string, string>();

function noteTransaction(room: Room, tr: Y.Transaction): void {
  const who = actorOf(room, tr.origin);
  if (!who || !tr.changed.has(room.text as unknown as Y.AbstractType<any>)) return;
  if (who.userId && who.kind === 'edit') {
    for (const [client, clock] of tr.afterState) {
      if (clock > (tr.beforeState.get(client) ?? 0)) room.authors.set(client, { id: who.userId, name: who.name });
    }
  }
  let ins = 0;
  let del = 0;
  let sample = '';
  for (const e of tr.changedParentTypes.get(room.text as unknown as Y.AbstractType<any>) ?? []) {
    if (e.target !== room.text) continue;
    for (const d of (e as Y.YTextEvent).delta) {
      if (typeof d.insert === 'string') { ins += d.insert.length; if (sample.length < SAMPLE_CHARS) sample += d.insert; }
      else if (d.delete) del += d.delete;
    }
  }
  if (!ins && !del) return;
  let delText = '';
  if (del) {
    Y.iterateDeletedStructs(tr, tr.deleteSet, (st) => {
      if (delText.length < SAMPLE_CHARS && st instanceof Y.Item && st.parent === room.text && st.content instanceof Y.ContentString) delText += st.content.str;
    });
  }
  const key = `${who.kind}:${who.userId ?? ''}`;
  const now = Date.now();
  let b = room.buckets.get(key);
  if (b && now - b.started > LOG_MAX_AGE) { void flushBucket(room, key); b = undefined; }
  if (!b) {
    b = { userId: who.userId, name: who.name, kind: who.kind, started: now, ended: now, inserted: 0, deleted: 0, sample: '', deletedSample: '' };
    room.buckets.set(key, b);
  }
  b.ended = now;
  b.inserted += ins;
  b.deleted += del;
  if (b.sample.length < SAMPLE_CHARS) b.sample = (b.sample + sample).slice(0, SAMPLE_CHARS);
  if (b.deletedSample.length < SAMPLE_CHARS) b.deletedSample = (b.deletedSample + delText).slice(0, SAMPLE_CHARS);
  if (room.logTimer) clearTimeout(room.logTimer);
  room.logTimer = setTimeout(() => void flushLog(room), LOG_IDLE);
  room.logTimer.unref();
}

async function flushBucket(room: Room, key: string): Promise<void> {
  const b = room.buckets.get(key);
  if (!b) return;
  room.buckets.delete(key);
  try {
    await getEditLogStore().add({
      vaultId: room.ctx.id, path: room.rel, userId: b.userId, userName: b.name, kind: b.kind,
      startedAt: new Date(b.started).toISOString(), endedAt: new Date(b.ended).toISOString(),
      inserted: b.inserted, deleted: b.deleted, sample: b.sample, deletedSample: b.deletedSample,
    });
  } catch (e: any) {
    log('could not write the edit log:', e?.message ?? e);
  }
}

export async function flushLog(room: Room): Promise<void> {
  if (room.logTimer) clearTimeout(room.logTimer);
  room.logTimer = null;
  await Promise.all([...room.buckets.keys()].map((k) => flushBucket(room, k)));
}

/** Who wrote the characters in [from, to) of the note, plus the log of recent edits by those people. */
export async function blame(ctx: VaultCtx, rel: string, from: number, to: number) {
  const room = getRoom(ctx, rel);
  await room.ready;
  if (!room.conns.size && !room.idle) {
    room.idle = setTimeout(() => { if (!room.conns.size) void destroyRoom(room).catch(() => {}); }, IDLE_DESTROY);
    room.idle.unref();
  }
  const segs: { from: number; to: number; user: (Author & { color: string }) | null; text: string }[] = [];
  const full = room.text.toString();
  let pos = 0;
  for (let item = (room.text as unknown as { _start: Y.Item | null })._start; item && pos < to; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const start = pos;
    pos += item.length;
    if (pos <= from) continue;
    const a = Math.max(start, from);
    const z = Math.min(pos, to);
    const au = room.authors.get(item.id.client);
    const user = au ? { ...au, color: colorFor(au.id) } : null;
    const last = segs[segs.length - 1];
    if (last && last.to === a && last.user?.id === user?.id) last.to = z;
    else segs.push({ from: a, to: z, user, text: '' });
  }
  for (const sg of segs) sg.text = full.slice(sg.from, Math.min(sg.to, sg.from + 300));
  return { segments: segs, length: full.length };
}

// ---- room lifecycle --------------------------------------------------------------------
function inScope<T>(room: Room, fn: () => Promise<T>): Promise<T> {
  return runInVault(room.ctx, () => asSystem(fn));
}

function enqueue<T>(room: Room, fn: () => Promise<T>): Promise<T> {
  const p = room.chain.then(fn, fn);
  room.chain = p.catch(() => {});
  return p;
}

/** Replace the room's text with `next` using the smallest edits, so concurrent editors keep their cursors. */
function setText(room: Room, next: string, origin: unknown): void {
  const cur = room.text.toString();
  if (cur === next) return;
  room.doc.transact(() => {
    let pos = 0;
    for (const [op, t] of diffOps(cur, next)) {
      if (op === 0) pos += t.length;
      else if (op === -1) room.text.delete(pos, t.length);
      else {
        room.text.insert(pos, t);
        pos += t.length;
      }
    }
  }, origin);
}

async function loadRoom(room: Room): Promise<void> {
  const text = await inScope(room, () => room.ctx.storage.readText(room.rel));
  try {
    const meta = JSON.parse(await fs.readFile(`${stateBase(room.key)}.json`, 'utf8')) as { authors?: [number, Author][] };
    for (const [c, a] of meta.authors ?? []) room.authors.set(c, a);
  } catch { /* none yet */ }
  if (text.length > MAX_DOC_CHARS) throw Object.assign(new Error('File is too large for co-editing'), { status: 413 });
  try {
    const bin = await fs.readFile(`${stateBase(room.key)}.bin`);
    Y.applyUpdate(room.doc, new Uint8Array(bin), ORIGIN_LOAD);
  } catch {
    /* no saved state: the file is the only source */
  }
  setText(room, text, ORIGIN_LOAD);
  room.saved = text;
  room.dirtySince = 0;
}

function getRoom(ctx: VaultCtx, rel: string): Room {
  const key = keyOf(ctx.id, rel);
  const found = rooms.get(key);
  if (found) return found;
  const doc = new Y.Doc();
  const room: Room = {
    key, ctx, rel, doc, text: doc.getText('content'),
    awareness: new awarenessProtocol.Awareness(doc),
    conns: new Map(), owners: new Map(), saved: '', ready: Promise.resolve(), chain: Promise.resolve(),
    dirtySince: 0, timer: null, idle: null, closed: false, lastError: null,
    authors: new Map(), buckets: new Map(), logTimer: null,
  };
  room.awareness.setLocalState(null); // the server itself is not a participant
  room.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = [...added, ...updated, ...removed];
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
    const msg = encoding.toUint8Array(enc);
    for (const c of room.conns.values()) if (c.ws !== (origin as Conn | null)?.ws) send(c.ws, msg);
  });
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const c of room.conns.values()) if (c.ws !== (origin as Conn | null)?.ws) send(c.ws, msg);
    if (origin !== ORIGIN_LOAD) schedulePersist(room);
  });
  doc.on('afterTransaction', (tr: Y.Transaction) => noteTransaction(room, tr));
  rooms.set(key, room);
  room.ready = loadRoom(room).catch((e) => {
    rooms.delete(key);
    room.closed = true;
    throw e;
  });
  return room;
}

function sendAccess(ws: WebSocket, canWrite: boolean): void {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_ACCESS);
  encoding.writeVarUint(e, canWrite ? 1 : 0);
  send(ws, encoding.toUint8Array(e));
}

function send(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === 1) ws.send(data, (err) => err && ws.terminate());
}

function schedulePersist(room: Room): void {
  if (room.closed) return;
  const now = Date.now();
  if (!room.dirtySince) room.dirtySince = now;
  if (room.timer) clearTimeout(room.timer);
  const wait = Math.max(0, Math.min(PERSIST_DELAY, room.dirtySince + PERSIST_MAX_WAIT - now));
  room.timer = setTimeout(() => void persist(room), wait);
  room.timer.unref();
}

/** Save the room's text to the storage (and the room's state next to it). Resolves when the work queued so far is done. */
export function persist(room: Room): Promise<void> {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  return enqueue(room, async () => {
    const text = room.text.toString();
    const update = Y.encodeStateAsUpdate(room.doc);
    room.dirtySince = 0;
    if (text !== room.saved) {
      const prev = room.saved;
      room.saved = text; // set first: the storage's own change event must read as "ours"
      try {
        await inScope(room, async () => {
          await room.ctx.storage.writeText(room.rel, text);
          reindex({ upsert: room.rel, added: room.rel });
        });
        room.lastError = null;
      } catch (e: any) {
        room.saved = prev;
        room.lastError = e?.message ?? String(e);
        log(`could not save ${room.ctx.id}:${room.rel}:`, room.lastError);
        if (!room.closed) {
          room.dirtySince = Date.now();
          room.timer = setTimeout(() => void persist(room), 5000);
          room.timer.unref();
        }
        return;
      }
    }
    await saveState(room, update, text);
  });
}

async function saveState(room: Room, update: Uint8Array, text: string): Promise<void> {
  try {
    const base = stateBase(room.key);
    await fs.mkdir(path.dirname(base), { recursive: true });
    await fs.writeFile(`${base}.bin`, update);
    await fs.writeFile(`${base}.json`, JSON.stringify({ vault: room.ctx.id, path: room.rel, fileHash: sha(text), at: Date.now(), authors: [...room.authors] }));
  } catch (e: any) {
    log('could not save room state:', e?.message ?? e);
  }
}

async function destroyRoom(room: Room, code = 1000, reason = ''): Promise<void> {
  if (room.closed && !rooms.has(room.key)) return;
  if (room.idle) clearTimeout(room.idle);
  for (const c of [...room.conns.values()]) c.ws.close(code, reason);
  room.conns.clear();
  await persist(room);
  await flushLog(room);
  room.closed = true;
  announce(room);
  if (rooms.get(room.key) === room) rooms.delete(room.key);
  room.awareness.destroy();
  room.doc.destroy();
}

function dropConn(room: Room, conn: Conn): void {
  if (!room.conns.delete(conn.ws)) return;
  announce(room);
  awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.ids], null);
  for (const id of conn.ids) room.owners.delete(id);
  if (!room.conns.size && !room.closed) {
    room.idle = setTimeout(() => {
      if (!room.conns.size) void destroyRoom(room).catch((e) => log('close failed:', e?.message ?? e));
    }, IDLE_DESTROY);
    room.idle.unref();
  }
}

// ---- protocol --------------------------------------------------------------------------
/** Awareness is the one thing clients say about themselves: keep only cursor + the identity the server vouches for. */
function sanitizeAwareness(update: Uint8Array, conn: Conn, room: Room): Uint8Array | null {
  const d = decoding.createDecoder(update);
  const n = decoding.readVarUint(d);
  const e = encoding.createEncoder();
  const out: [number, number, string][] = [];
  for (let i = 0; i < n; i++) {
    const id = decoding.readVarUint(d);
    const clock = decoding.readVarUint(d);
    const raw = decoding.readVarString(d);
    const owner = room.owners.get(id);
    if (owner && owner !== conn) continue; // cannot speak for someone else's cursor
    if (!owner) {
      if (conn.ids.size >= MAX_AWARENESS_IDS) continue;
      conn.ids.add(id);
      room.owners.set(id, conn);
    }
    let state: unknown = null;
    try {
      state = JSON.parse(raw);
    } catch {
      continue;
    }
    if (state && typeof state === 'object') {
      const s = state as { cursor?: unknown };
      const cur = s.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
      const clean: Record<string, unknown> = { user: { id: conn.user.id, name: conn.user.name, color: conn.user.color, colorLight: conn.user.color + '33' } };
      if (cur && typeof cur === 'object') clean.cursor = { anchor: cur.anchor, head: cur.head };
      out.push([id, clock, JSON.stringify(clean)]);
    } else out.push([id, clock, 'null']);
  }
  if (!out.length) return null;
  encoding.writeVarUint(e, out.length);
  for (const [id, clock, s] of out) {
    encoding.writeVarUint(e, id);
    encoding.writeVarUint(e, clock);
    encoding.writeVarString(e, s);
  }
  return encoding.toUint8Array(e);
}

function onMessage(room: Room, conn: Conn, data: Uint8Array): void {
  const dec = decoding.createDecoder(data);
  const type = decoding.readVarUint(dec);
  if (type === MSG_SYNC) {
    const sub = decoding.peekVarUint(dec);
    if (!conn.canWrite && (sub === SYNC_STEP2 || sub === SYNC_UPDATE)) return; // a reader's edits never reach the document
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
    if (encoding.length(enc) > 1) send(conn.ws, encoding.toUint8Array(enc));
  } else if (type === MSG_AWARENESS) {
    const clean = sanitizeAwareness(decoding.readVarUint8Array(dec), conn, room);
    if (clean) awarenessProtocol.applyAwarenessUpdate(room.awareness, clean, conn);
  }
}

/** Attach a (already authorised) socket to the file's room. */
export async function join(ws: WebSocket, ctx: VaultCtx, rel: string, who: { token: string; user: AuthUser; principal: Principal }): Promise<void> {
  const acc = accessFor(who.principal, ctx.id, rel);
  if (!acc.enabled) return void ws.close(4403, 'no access');
  // The editor speaks first (sync step 1) — possibly while the room is still loading: keep what it says until it is attached.
  let attached: ((raw: Buffer) => void) | null = null;
  const early: Buffer[] = [];
  ws.binaryType = 'nodebuffer';
  ws.on('message', (raw: Buffer) => (attached ? attached(raw) : early.push(raw)));
  ws.on('error', () => ws.terminate());
  const room = getRoom(ctx, rel);
  try {
    await room.ready;
  } catch (e: any) {
    return void ws.close(e?.status === 413 ? 4413 : 4404, String(e?.message ?? 'cannot open').slice(0, 100));
  }
  if (room.closed || room.conns.size >= MAX_CONNS_PER_ROOM) return void ws.close(4429, 'room unavailable');
  if (room.idle) clearTimeout(room.idle);
  room.idle = null;
  const name = who.user.displayName || who.user.username;
  const conn: Conn = { ws, token: who.token, user: { id: who.user.id, name, color: colorFor(who.user.id) }, canWrite: acc.canWrite, ids: new Set(), alive: true };
  room.conns.set(ws, conn);
  announce(room);
  attached = (raw) => {
    try {
      onMessage(room, conn, new Uint8Array(raw));
    } catch (e: any) {
      log('bad message:', e?.message ?? e);
      ws.close(4400, 'bad message');
    }
  };
  ws.on('pong', () => { conn.alive = true; });
  ws.on('close', () => dropConn(room, conn));

  // Tell the editor whether it may write, then open the sync handshake.
  sendAccess(ws, conn.canWrite);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, room.doc);
  send(ws, encoding.toUint8Array(enc));
  const states = room.awareness.getStates();
  if (states.size) {
    const a = encoding.createEncoder();
    encoding.writeVarUint(a, MSG_AWARENESS);
    encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    send(ws, encoding.toUint8Array(a));
  }
  for (const raw of early.splice(0)) attached(raw);
}

// ---- changes from outside the editors ----------------------------------------------------
function peek(vaultId: string, rel: string): string | undefined {
  const r = rooms.get(keyOf(vaultId, rel));
  return r && !r.closed && r.conns.size ? r.text.toString() : undefined;
}

async function write(vaultId: string, rel: string, content: string, userId: string | null): Promise<boolean> {
  const room = rooms.get(keyOf(vaultId, rel));
  if (!room || room.closed || !room.conns.size) return false;
  try {
    await room.ready;
  } catch {
    return false;
  }
  if (content.length > MAX_DOC_CHARS) return false;
  if (userId && !restNames.has(userId)) {
    const u = await getUserStore().getUser(userId).catch(() => undefined);
    if (u) restNames.set(userId, u.displayName || u.username);
  }
  setText(room, content, { rest: userId });
  await persist(room);
  return true;
}

function external(vaultId: string, rel: string, type: 'add' | 'change' | 'unlink'): void {
  const room = rooms.get(keyOf(vaultId, rel));
  if (!room || room.closed) return;
  if (type === 'unlink') return void destroyRoom(room, 4404, 'file removed').catch(() => {});
  void enqueue(room, async () => {
    await room.ready;
    const theirs = await inScope(room, () => room.ctx.storage.readText(room.rel));
    if (theirs === room.saved) return; // our own write coming back
    if (theirs.length > MAX_DOC_CHARS) return;
    const { text, conflicts } = merge3(room.saved, room.text.toString(), theirs);
    room.saved = theirs;
    setText(room, text, { external: true });
    if (conflicts) log(`outside change to ${room.ctx.id}:${room.rel} was merged with ${conflicts} unplaced hunk(s)`);
    if (room.text.toString() !== theirs) schedulePersist(room);
  }).catch((e) => log('merge failed:', e?.message ?? e));
}

function gone(vaultId: string, rel: string): void {
  const prefix = rel.replace(/\/+$/, '');
  for (const room of [...rooms.values()]) {
    if (room.ctx.id !== vaultId) continue;
    if (room.rel === prefix || room.rel.startsWith(prefix + '/')) void destroyRoom(room, 4404, 'file moved or removed').catch(() => {});
  }
}

setCollabHooks({ peek, write, external, gone });

// ---- housekeeping ----------------------------------------------------------------------
let timers: NodeJS.Timeout[] = [];

/** Pings, permission rechecks and old saved-state cleanup. Call once at boot. */
export function startCollab(): void {
  stopTimers();
  timers.push(setInterval(() => {
    for (const room of rooms.values()) for (const c of room.conns.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, PING_EVERY));
  timers.push(setInterval(() => {
    for (const room of rooms.values()) for (const c of room.conns.values()) {
      void (async () => {
        const user = await authenticateToken(c.token);
        if (!user) return void c.ws.close(4401, 'session ended');
        const acc = accessFor(await principalFor(user), room.ctx.id, room.rel);
        if (!acc.enabled) return void c.ws.close(4403, 'no access');
        if (acc.canWrite !== c.canWrite) {
          c.canWrite = acc.canWrite;
          announce(room);
          sendAccess(c.ws, acc.canWrite);
        }
      })().catch(() => {});
    }
  }, 30_000));
  for (const t of timers) t.unref();
  void purgeOldState();
}

function stopTimers(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

async function purgeOldState(): Promise<void> {
  const dir = path.join(config.dataDir, 'collab');
  try {
    const cutoff = Date.now() - STATE_TTL_DAYS * 86_400_000;
    for (const f of await fs.readdir(dir)) {
      const p = path.join(dir, f);
      if ((await fs.stat(p)).mtimeMs < cutoff) await fs.rm(p, { force: true });
    }
  } catch {
    /* nothing saved yet */
  }
}

/** Save every open room (shutdown). */
export async function stopCollab(): Promise<void> {
  stopTimers();
  await Promise.all([...rooms.values()].map((r) => destroyRoom(r, 1001, 'server stopping').catch(() => {})));
}

export const collabStats = () => [...rooms.values()].map((r) => ({ vault: r.ctx.id, path: r.rel, clients: r.conns.size, error: r.lastError }));
