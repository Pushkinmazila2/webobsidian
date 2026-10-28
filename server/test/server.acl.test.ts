import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

/** Folder permissions end to end: files, search, tags, graph, sharing, settings, events, workspace state. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECOVERY = 'recovery-pass-2';

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

test('[server+acl] folder permissions are enforced everywhere', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-acl-'));
  const dataDir = path.join(tmp, 'data');
  const vault = path.join(tmp, 'vault');
  for (const d of ['Public', 'Notes', 'Private', 'HR/Open', '.obsidian']) await mkdir(path.join(vault, d), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const put = (rel: string, body: string) => writeFile(path.join(vault, rel), body);
  await put('Public/a.md', '# Public A\nhello pubword #shared');
  await put('Notes/n.md', '# N\nnotes noteword #shared');
  await put('Private/secret.md', '# Secret\nsecretword #topsecret links [[a]]');
  await put('HR/hr.md', '# HR\nhrword');
  await put('HR/Open/o.md', '# Open\nopenword');
  await put('.obsidian/app.json', '{}');
  const s = start(dataDir, vault);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());

    const raw = (cookie: string, p: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
      fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const call = async (cookie: string, p: string, method = 'GET', body?: unknown) => {
      const r = await raw(cookie, p, method, body);
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    };
    const login = async (body: object) => {
      const r = await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
    };

    const admin = (await login({ password: RECOVERY })).cookie;
    const mk = async (username: string) => (await call(admin, '/api/admin/users', 'POST', { username, password: 'password-1', mustChangePassword: false })).json.user.id as string;
    const aliceId = await mk('alice');
    await mk('bob');
    const staff = (await call(admin, '/api/admin/groups', 'POST', { name: 'staff' })).json.group.id as string;
    await call(admin, `/api/admin/groups/${staff}/members/${aliceId}`, 'PUT');
    const alice = (await login({ username: 'alice', password: 'password-1' })).cookie;
    const bob = (await login({ username: 'bob', password: 'password-1' })).cookie;

    // nothing granted yet: default is "none"
    assert.equal((await call(alice, '/api/files/content?path=Public/a.md')).status, 403);
    assert.deepEqual((await call(alice, '/api/files')).json.children, []);
    assert.equal((await call(alice, '/api/vaults')).json.vaults.length, 0);
    assert.equal((await call(admin, '/api/vaults')).json.vaults.length, 1);

    // rules (administrators only)
    const rule = (b: object) => call(admin, '/api/admin/acl/rules', 'POST', b);
    assert.equal((await call(alice, '/api/admin/acl')).status, 403);
    assert.equal((await rule({ subjectType: 'group', subjectId: staff, pattern: 'Public', level: 'read' })).status, 201);
    assert.equal((await rule({ subjectType: 'group', subjectId: staff, pattern: 'Notes', level: 'write' })).status, 201);
    assert.equal((await rule({ subjectType: 'user', subjectId: aliceId, pattern: 'HR/Open', level: 'read' })).status, 201);
    assert.equal((await rule({ subjectType: 'user', subjectId: 'nope', pattern: 'x', level: 'read' })).status, 404);
    assert.equal((await rule({ subjectType: 'everyone', pattern: 'x', level: 'none' })).status, 400);
    const chk = await call(admin, `/api/admin/acl/check?user=${aliceId}&path=HR/Open/o.md`);
    assert.equal(chk.json.level, 'read');

    // tree: only what is granted, plus the folders on the way to it
    const tree = JSON.stringify((await call(alice, '/api/files')).json);
    for (const ok of ['Public', 'a.md', 'Notes', 'n.md', 'HR', 'Open', 'o.md']) assert.ok(tree.includes(`"${ok}"`), `${ok} should be visible: ${tree}`);
    for (const hidden of ['Private', 'secret.md', 'hr.md']) assert.ok(!tree.includes(hidden), `${hidden} must be hidden: ${tree}`);

    // read / write / move
    assert.equal((await call(alice, '/api/files/content?path=Public/a.md')).status, 200);
    assert.equal((await call(alice, '/api/files/content?path=Private/secret.md')).status, 403);
    assert.equal((await call(alice, '/api/files/content?path=HR/hr.md')).status, 403);
    assert.equal((await call(alice, '/api/files/content?path=HR/Open/o.md')).status, 200);
    assert.equal((await call(alice, '/api/files/content', 'PUT', { path: 'Public/a.md', content: 'x' })).status, 403, 'read-only folder');
    assert.equal((await call(alice, '/api/files/content', 'PUT', { path: 'Notes/n.md', content: '# N\nnoteword edited' })).status, 200);
    assert.equal((await call(alice, '/api/files/content', 'PUT', { path: 'Private/new.md', content: 'x' })).status, 403);
    assert.equal((await call(alice, '/api/files/content', 'PUT', { path: '.obsidian/app.json', content: '{"x":1}' })).status, 403, '.obsidian is read-only');
    assert.equal((await call(alice, '/api/files/content?path=.obsidian/app.json')).status, 200, 'but readable');
    const mv = await call(alice, '/api/files/rename', 'PATCH', { from: 'Notes/n.md', to: 'Private/n.md' });
    assert.ok(mv.status === 403, `moving into a closed folder: ${mv.status} ${JSON.stringify(mv.json)}`);
    assert.equal((await call(alice, '/api/files/content?path=Notes/n.md')).status, 200, 'it did not move');

    // search, tags, backlinks, graph
    assert.equal((await call(alice, '/api/search?q=secretword')).json.hits.length, 0);
    assert.equal((await call(admin, '/api/search?q=secretword')).json.hits.length, 1);
    assert.equal((await call(alice, '/api/search?q=pubword')).json.hits.length, 1);
    const tags = (await call(alice, '/api/tags')).json.tags.map((t: any) => t.tag);
    assert.ok(tags.some((t: string) => t.includes('shared')) && !tags.some((t: string) => t.includes('topsecret')), JSON.stringify(tags));
    assert.ok((await call(admin, '/api/tags')).json.tags.some((t: any) => t.tag.includes('topsecret')));
    assert.deepEqual((await call(alice, '/api/backlinks?path=Public/a.md')).json.backlinks, [], 'the linking note is hidden');
    assert.deepEqual((await call(admin, '/api/backlinks?path=Public/a.md')).json.backlinks, ['Private/secret.md']);
    assert.equal((await call(alice, '/api/backlinks?path=Private/secret.md')).status, 403);
    const g = JSON.stringify((await call(alice, '/api/graph')).json);
    assert.ok(g.includes('Public/a.md') && !g.includes('secret'), g);
    assert.equal((await call(alice, '/api/reindex', 'POST')).status, 403);
    assert.equal((await call(alice, '/api/metadata')).status, 200);
    assert.ok(!JSON.stringify((await call(alice, '/api/metadata')).json).includes('Private/'), 'metadata cache hides closed notes');

    // sharing needs write access to the note
    assert.equal((await call(alice, '/api/shares', 'POST', { path: 'Public/a.md' })).status, 403);
    assert.equal((await call(alice, '/api/shares', 'POST', { path: 'Notes/n.md' })).status, 200);
    assert.equal((await call(alice, '/api/shares')).json.shares.length, 1);

    // administration stays with administrators
    const cfg = await call(alice, '/api/settings');
    assert.equal(cfg.status, 200);
    assert.ok(!('auth' in cfg.json) && !('storage' in cfg.json) && !('git' in cfg.json) && !('api' in cfg.json), JSON.stringify(Object.keys(cfg.json)));
    assert.ok(!JSON.stringify(cfg.json).includes(vault), 'vault path is not shown');
    assert.equal((await call(alice, '/api/settings', 'PUT', { ui: { theme: 'obsidian-dark' } })).status, 403);
    assert.equal((await call(alice, '/api/keys')).status, 403);
    assert.equal((await call(alice, '/api/git/sync', 'POST')).status, 403);
    assert.equal((await call(alice, '/api/plugins/x/enabled', 'PATCH', { enabled: true })).status, 403);
    assert.equal((await call(alice, '/api/vaults', 'POST', { name: 'x' })).status, 403);
    assert.ok('auth' in (await call(admin, '/api/settings')).json);

    // someone with no grant at all sees nothing and cannot even read .obsidian
    assert.deepEqual((await call(bob, '/api/files')).json.children, []);
    assert.equal((await call(bob, '/api/files/content?path=.obsidian/app.json')).status, 403);
    assert.equal((await call(bob, '/api/search?q=pubword')).json.hits.length, 0);

    // each person has their own workspace
    assert.equal((await call(alice, '/api/uistate', 'PUT', { tabs: ['Notes/n.md'] })).status, 200);
    assert.deepEqual((await call(alice, '/api/uistate')).json, { tabs: ['Notes/n.md'] });
    assert.deepEqual((await call(bob, '/api/uistate')).json, {});
    assert.deepEqual((await call(admin, '/api/uistate')).json.tabs ?? null, null);

    // live events only about what the person may read
    const events: any[] = [];
    const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws', { headers: { cookie: alice } });
    ws.on('message', (d) => events.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    await sleep(500);
    await call(admin, '/api/files/content', 'PUT', { path: 'Private/secret2.md', content: '# hidden event' });
    await call(admin, '/api/files/content', 'PUT', { path: 'Notes/visible-event.md', content: '# visible event' });
    for (let i = 0; i < 40 && !events.some((e) => e.path === 'Notes/visible-event.md'); i++) await sleep(250);
    ws.close();
    assert.ok(events.some((e) => e.type === 'fs' && e.path === 'Notes/visible-event.md'), 'visible event arrives: ' + JSON.stringify(events));
    assert.ok(!events.some((e) => String(e.path ?? '').startsWith('Private/')), 'hidden path never reaches the client: ' + JSON.stringify(events));

    // changing rules takes effect at once; deleting the grant closes the door again
    const rules = (await call(admin, '/api/admin/acl')).json.rules as any[];
    const notes = rules.find((r) => r.pattern === 'Notes');
    assert.equal((await call(admin, `/api/admin/acl/rules/${notes.id}`, 'DELETE')).status, 200);
    assert.equal((await call(alice, '/api/files/content?path=Notes/n.md')).status, 403);
    await call(admin, '/api/admin/acl/default', 'PUT', { level: 'read' });
    assert.equal((await call(alice, '/api/files/content?path=Private/secret.md')).status, 200, 'vault default now applies');
    assert.equal((await call(bob, '/api/files/content?path=Notes/n.md')).status, 200);
    assert.equal((await call(bob, '/api/files/content', 'PUT', { path: 'Notes/n.md', content: 'x' })).status, 403);
  } finally {
    s.kill();
  }
});
