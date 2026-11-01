import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

/** Real-time co-editing end to end, with minimal Yjs clients speaking the same protocol as y-websocket. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await cond()) return; await sleep(50); }
  assert.fail(`timed out waiting for ${what}`);
};
const RECOVERY = 'recovery-pass-3';

function start(dataDir: string, vault: string) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  let log = '';
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, VAULT_PATH: vault, ALLOWED_ROOTS: path.dirname(vault), WEBOBSIDIAN_PASSWORD: RECOVERY, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const kill = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } };
  return { proc, kill, base: `http://127.0.0.1:${port}`, log: () => log };
}

class Client {
  doc = new Y.Doc();
  text = this.doc.getText('content');
  awareness = new awarenessProtocol.Awareness(this.doc);
  ws: WebSocket;
  synced = false;
  canWrite: boolean | null = null;
  closed: number | null = null;
  constructor(base: string, cookie: string, rel: string) {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/collab?path=${encodeURIComponent(rel)}`, { headers: { cookie } });
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('close', (code) => (this.closed = code));
    this.ws.on('open', () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, this.doc);
      this.ws.send(encoding.toUint8Array(e));
    });
    this.ws.on('message', (data: Buffer) => {
      const d = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(d);
      if (type === 4) {
        this.canWrite = decoding.readVarUint(d) === 1;
      } else if (type === 0) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        const sub = syncProtocol.readSyncMessage(d, e, this.doc, this);
        if (sub === syncProtocol.messageYjsSyncStep2) this.synced = true;
        if (encoding.length(e) > 1) this.ws.send(encoding.toUint8Array(e));
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this);
      }
    });
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === this || this.ws.readyState !== 1) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, u);
      this.ws.send(encoding.toUint8Array(e));
    });
    this.awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
      if (origin === this || this.ws.readyState !== 1) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 1);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.ws.send(encoding.toUint8Array(e));
    });
  }
  ready() { return until(() => this.synced, 'sync'); }
  get value() { return this.text.toString(); }
  close() { this.ws.close(); }
}

test('[server+collab] people edit the same note together', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-collab-'));
  const dataDir = path.join(tmp, 'data');
  const vault = path.join(tmp, 'vault');
  for (const d of ['Notes', 'Private']) await mkdir(path.join(vault, d), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(vault, 'Notes/a.md'), 'line one\nline two\nline three\n');
  await writeFile(path.join(vault, 'Private/p.md'), 'secret');
  const s = start(dataDir, vault);
  const clients: Client[] = [];
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());

    const call = async (cookie: string, p: string, method = 'GET', body?: unknown) => {
      const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    };
    const login = async (body: object) => {
      const r = await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return (r.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const admin = await login({ password: RECOVERY });
    const mk = async (username: string, displayName: string) =>
      (await call(admin, '/api/admin/users', 'POST', { username, displayName, password: 'password-1', mustChangePassword: false })).json.user.id as string;
    const aliceId = await mk('alice', 'Alice A');
    const bobId = await mk('bob', 'Bob B');
    await mk('carol', 'Carol C');
    const rule = (b: object) => call(admin, '/api/admin/acl/rules', 'POST', b);
    await rule({ subjectType: 'user', subjectId: aliceId, pattern: 'Notes', level: 'write' });
    await rule({ subjectType: 'user', subjectId: bobId, pattern: 'Notes', level: 'read' });
    const alice = await login({ username: 'alice', password: 'password-1' });
    const bob = await login({ username: 'bob', password: 'password-1' });
    const carol = await login({ username: 'carol', password: 'password-1' });
    const open = (cookie: string, rel = 'Notes/a.md') => { const c = new Client(s.base, cookie, rel); clients.push(c); return c; };

    // REST tells the editor whether to switch on co-editing
    assert.deepEqual((await call(alice, '/api/collab/access?path=Notes/a.md')).json, { enabled: true, canWrite: true });
    assert.deepEqual((await call(bob, '/api/collab/access?path=Notes/a.md')).json, { enabled: true, canWrite: false });
    assert.equal((await call(carol, '/api/collab/access?path=Notes/a.md')).json.enabled, false);
    assert.equal((await call(alice, '/api/collab/access?path=Notes/pic.png')).json.enabled, false, 'only text notes');

    // refused without a session, without access, and for non-notes
    for (const [cookie, rel] of [['', 'Notes/a.md'], [carol, 'Notes/a.md'], [alice, 'Private/p.md'], [alice, 'Notes/pic.png']] as const) {
      const ws = new WebSocket(`${s.base.replace('http', 'ws')}/collab?path=${encodeURIComponent(rel)}`, { headers: cookie ? { cookie } : {} });
      const status = await new Promise<number>((r) => { ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)); ws.on('open', () => r(200)); ws.on('error', () => {}); });
      assert.ok(status === 401 || status === 403 || status === 404, `${rel} as ${cookie ? 'user' : 'nobody'}: ${status}`);
    }

    // two people see the file's text and each other's typing
    const a = open(alice);
    const b = open(admin);
    await Promise.all([a.ready(), b.ready()]);
    assert.equal(a.value, 'line one\nline two\nline three\n');
    assert.equal(b.value, a.value);
    assert.equal(a.canWrite, true);
    a.text.insert(0, 'ALICE ');
    b.text.insert(b.value.length, 'ADMIN\n');
    await until(() => a.value === b.value && a.value.startsWith('ALICE line one') && a.value.endsWith('ADMIN\n'), 'convergence');
    const merged = a.value;

    // the room, not the keystroke, writes the file (debounced)
    await until(async () => (await readFile(path.join(vault, 'Notes/a.md'), 'utf8')) === merged, 'file saved');

    // REST readers see unsaved edits
    a.text.insert(0, '>');
    await until(async () => (await call(admin, '/api/files/content?path=Notes/a.md')).json.content === '>' + merged, 'live REST read');

    // a reader may look but not type
    const r = open(bob);
    await r.ready();
    assert.equal(r.canWrite, false);
    assert.equal(r.value, '>' + merged);
    r.text.insert(0, 'HACK');
    await sleep(500);
    assert.ok(!a.value.includes('HACK') && !b.value.includes('HACK'), 'read-only edit leaked');
    a.text.insert(a.value.length, 'x');
    await until(() => r.value.endsWith('x'), 'reader receives edits');

    // cursors: shown with the identity the server vouches for, whatever the client claims
    a.awareness.setLocalState({ user: { name: 'Totally The Admin', color: '#000' }, cursor: { anchor: 1, head: 3 } });
    await until(() => [...b.awareness.getStates().values()].some((v: any) => v.cursor?.anchor === 1), 'cursor shared');
    const seen = [...b.awareness.getStates().values()].find((v: any) => v.cursor?.anchor === 1) as any;
    assert.equal(seen.user.name, 'Alice A');
    assert.equal(seen.user.id, aliceId);
    assert.match(seen.user.color, /^#[0-9a-f]{6}$/i);

    // REST write while the note is open is merged into the room
    const before = a.value;
    assert.equal((await call(admin, '/api/files/content', 'PUT', { path: 'Notes/a.md', content: before + 'from REST\n' })).status, 200);
    await until(() => a.value === before + 'from REST\n' && b.value === a.value, 'REST write reached editors');
    await until(async () => (await readFile(path.join(vault, 'Notes/a.md'), 'utf8')) === a.value, 'REST write saved');
    assert.equal((await call((bob), '/api/files/content', 'PUT', { path: 'Notes/a.md', content: 'nope' })).status, 403);

    // a change made outside (git pull, another editor) is merged with what people typed since
    await sleep(300);
    const disk = await readFile(path.join(vault, 'Notes/a.md'), 'utf8');
    a.text.insert(0, 'TOP-');
    await writeFile(path.join(vault, 'Notes/a.md'), disk + 'from disk\n');
    await until(() => a.value.startsWith('TOP->') && a.value.endsWith('from disk\n') && b.value === a.value, 'outside change merged', 10000);

    // who changed what: the selection is traced to the people who typed it
    {
      const v = a.value;
      const at = v.indexOf('ALICE');
      const bl = (await call(admin, `/api/collab/blame?path=Notes/a.md&from=${at}&to=${at + 5}`)).json;
      assert.equal(bl.segments.length, 1, JSON.stringify(bl));
      assert.equal(bl.segments[0].user?.name, 'Alice A');
      const ad = v.indexOf('ADMIN');
      const bl2 = (await call(alice, `/api/collab/blame?path=Notes/a.md&from=${ad}&to=${ad + 5}`)).json;
      assert.equal(bl2.segments[0].user?.name, 'Administrator', JSON.stringify(bl2));
      const seed = (await call(alice, `/api/collab/blame?path=Notes/a.md&from=${v.indexOf('line one') + 2}&to=${v.indexOf('line one') + 6}`)).json;
      assert.equal(seed.segments[0].user, null, 'file text written before co-editing has no author');
      assert.equal((await call(carol, `/api/collab/blame?path=Notes/a.md&from=0&to=3`)).status, 403);
      assert.equal((await call(bob, '/api/collab/history?path=Notes/a.md')).status, 200);
    }

    // permissions are rechecked: revoking write turns an open editor read-only
    // (rechecked every 30 s — covered by the unit of accessFor; here we only make sure the socket stays healthy)
    assert.equal(a.closed, null);

    // the log is written when the typing pauses (30 s) or the room closes: closing the room flushes it
    // deleting the note closes the room
    assert.equal((await call(admin, '/api/files?path=Notes/a.md', 'DELETE')).status, 200);
    await until(() => a.closed !== null && b.closed !== null, 'sockets closed after delete');
    await until(async () => {
      const h = (await call(admin, '/api/collab/history?path=Notes/a.md')).json.entries ?? [];
      return h.some((e: any) => e.userName === 'Alice A' && e.kind === 'edit' && e.inserted > 0) &&
        h.some((e: any) => e.kind === 'rest') && h.some((e: any) => e.kind === 'external');
    }, 'edit log entries');
  } catch (e) {
    console.error('--- server log ---\n' + s.log());
    throw e;
  } finally {
    for (const c of clients) { c.ws.terminate(); c.awareness.destroy(); }
    s.kill();
  }
});
