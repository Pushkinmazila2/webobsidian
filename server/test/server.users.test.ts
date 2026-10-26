import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Multi-user sign-in: bootstrap admin, users/groups admin API, instant session revocation. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECOVERY = 'recovery-pass-1';

function start(dataDir: string, vault: string) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  let log = '';
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, VAULT_PATH: vault, ALLOWED_ROOTS: path.dirname(vault), WEBOBSIDIAN_PASSWORD: RECOVERY, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group: tsx forwards no SIGKILL, so the whole group is killed below
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const kill = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } };
  return { proc, kill, base: `http://127.0.0.1:${port}`, log: () => log };
}

test('[server+users] bootstrap admin, user admin API, revocation', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-users-'));
  const dataDir = path.join(tmp, 'data');
  const vault = path.join(tmp, 'vault');
  await mkdir(dataDir, { recursive: true });
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'A.md'), '# A');
  const s = start(dataDir, vault);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());

    const post = (p: string, body: unknown, cookie = '', method = 'POST') =>
      fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const login = async (body: object) => {
      const r = await post('/auth/login', body);
      return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], json: (await r.json()) as any };
    };
    const call = async (cookie: string, p: string, method = 'GET', body?: unknown) => {
      const r = await post(p, body, cookie, method);
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    };

    // fresh install: the bootstrap admin signs in with the default password (and must change it) …
    assert.equal((await (await fetch(`${s.base}/auth/status`)).json() as any).mustChangePassword, true);
    const wrong = await login({ username: 'admin', password: 'nope' });
    assert.equal(wrong.status, 401);
    // … the recovery password always opens the owner account, with or without a username
    const bare = await login({ password: RECOVERY });
    assert.equal(bare.status, 200);
    assert.equal(bare.json.user.username, 'admin');
    assert.equal(bare.json.user.isAdmin, true);
    const admin = bare.cookie;
    assert.equal((await call(admin, '/api/files')).status, 200);
    assert.equal((await call('', '/api/admin/users')).status, 401);

    // the admin creates a user; the new user cannot use the admin API
    const created = await call(admin, '/api/admin/users', 'POST', { username: 'Bob', password: 'bob-secret-1', displayName: 'Bob B.' });
    assert.equal(created.status, 201);
    assert.equal(created.json.user.username, 'bob');
    assert.equal(created.json.user.mustChangePassword, true);
    assert.equal((await call(admin, '/api/admin/users', 'POST', { username: 'BOB' })).status, 409);
    assert.equal((await call(admin, '/api/admin/users', 'POST', { username: 'x y' })).status, 400);
    const bob = await login({ username: 'bob', password: 'bob-secret-1' });
    assert.equal(bob.status, 200);
    assert.equal(bob.json.mustChangePassword, true);
    assert.equal((await call(bob.cookie, '/auth/me')).json.user.isAdmin, false);
    assert.equal((await call(bob.cookie, '/api/admin/users')).status, 403);

    // groups
    const g = await call(admin, '/api/admin/groups', 'POST', { name: 'Writers' });
    assert.equal(g.status, 201);
    assert.equal((await call(admin, '/api/admin/groups', 'POST', { name: 'writers' })).status, 409);
    assert.equal((await call(admin, `/api/admin/groups/${g.json.group.id}/members/${created.json.user.id}`, 'PUT')).status, 200);
    assert.deepEqual((await call(bob.cookie, '/auth/me')).json.user.groups, ['Writers']);
    assert.equal((await call(admin, '/api/admin/groups')).json.groups[0].members, 1);
    const listed = (await call(admin, '/api/admin/users')).json.users.find((u: any) => u.username === 'bob');
    assert.deepEqual(listed.groups, ['Writers']);

    // password change: needs the current one, keeps this session, drops the others
    const bob2 = await login({ username: 'bob', password: 'bob-secret-1' });
    assert.equal((await call(bob.cookie, '/auth/change-password', 'POST', { currentPassword: 'bad', newPassword: 'bob-secret-2' })).status, 401);
    assert.equal((await call(bob.cookie, '/auth/change-password', 'POST', { currentPassword: 'bob-secret-1', newPassword: 'bob-secret-2' })).status, 200);
    assert.equal((await call(bob.cookie, '/auth/me')).status, 200, 'the current session survives');
    assert.equal((await call(bob2.cookie, '/auth/me')).status, 401, 'other sessions are revoked');
    assert.equal((await login({ username: 'bob', password: 'bob-secret-1' })).status, 401);

    // logout revokes the session server-side (a copied cookie stops working)
    const bob3 = await login({ username: 'bob', password: 'bob-secret-2' });
    assert.equal((await call(bob3.cookie, '/auth/me')).json.user.username, 'bob');
    assert.equal((await call(bob3.cookie, '/auth/logout', 'POST')).status, 200);
    assert.equal((await call(bob3.cookie, '/auth/me')).status, 401);

    // disabling a user signs them out at once and blocks sign-in
    const bob4 = await login({ username: 'bob', password: 'bob-secret-2' });
    assert.equal((await call(admin, `/api/admin/users/${created.json.user.id}`, 'PATCH', { disabled: true })).status, 200);
    assert.equal((await call(bob4.cookie, '/auth/me')).status, 401);
    assert.equal((await login({ username: 'bob', password: 'bob-secret-2' })).status, 401);

    // last-admin and self-protection
    const meId = (await call(admin, '/auth/me')).json.user.id;
    assert.equal((await call(admin, `/api/admin/users/${meId}`, 'DELETE')).status, 409);
    assert.equal((await call(admin, `/api/admin/users/${meId}`, 'PATCH', { isAdmin: false })).status, 409);
    assert.equal((await call(admin, `/api/admin/users/${created.json.user.id}`, 'DELETE')).status, 200);

    // brute force: failures lock that account only, and successes never count
    for (let i = 0; i < 10; i++) assert.equal((await login({ username: 'carol', password: 'x' })).status, 401);
    assert.equal((await login({ username: 'carol', password: 'x' })).status, 429);
    assert.equal((await login({ username: 'admin', password: RECOVERY })).status, 200, 'other accounts are unaffected');

    // tokens of the old single-user scheme and share-unlock tokens are not sessions
    assert.equal((await call('webobsidian_token=garbage', '/auth/me')).status, 401);
  } finally {
    s.kill();
  }
});

test('[server+users] a single-user install keeps its password across the upgrade', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-users-up-'));
  const dataDir = path.join(tmp, 'data');
  const vault = path.join(tmp, 'vault');
  await mkdir(dataDir, { recursive: true });
  await mkdir(vault, { recursive: true });
  // settings.json written by the previous (single-user) version, password "old-password-1"
  const { hashPassword } = await import('../src/services/auth.js');
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, auth: { userPasswordHash: await hashPassword('old-password-1'), passwordHash: '', jwtSecret: 'x'.repeat(64) } }));
  const s = start(dataDir, vault);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());
    assert.equal((await (await fetch(`${s.base}/auth/status`)).json() as any).mustChangePassword, false);
    const r = await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'old-password-1' }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).user.username, 'admin');
    const d = await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
    assert.equal(d.status, 401, 'the default password must not open an upgraded install');
  } finally {
    s.kill();
  }
});
