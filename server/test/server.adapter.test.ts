import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** `app.vault.adapter.list/stat` need to see hidden folders (.obsidian) that the file tree hides — and never `.git`. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'adapter-test-password-1';

test('[server] /api/files/list and /stat expose hidden folders but not .git', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-adapter-'));
  const vaultDir = path.join(tmp, 'vault'), dataDir = path.join(tmp, 'data');
  await mkdir(path.join(vaultDir, '.obsidian/plugins/x'), { recursive: true });
  await mkdir(path.join(vaultDir, '.git'), { recursive: true });
  await writeFile(path.join(vaultDir, '.obsidian/plugins/x/data.json'), '{"a":1}');
  await writeFile(path.join(vaultDir, 'note.md'), 'hello');
  await mkdir(dataDir, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, VAULT_PATH: vaultDir, WEBOBSIDIAN_PASSWORD: PASSWORD, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${base}/auth/status`)).ok; } catch { await sleep(150); } }
    assert.ok(up, 'server did not start');
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const get = (p: string) => fetch(base + p, { headers: { cookie } });

    const root = (await (await get('/api/files/list?path=')).json()) as any;
    assert.ok(root.folders.includes('.obsidian'), JSON.stringify(root));
    assert.ok(root.files.includes('note.md'));
    assert.ok(!root.folders.includes('.git'), '.git is never listed');

    const plug = (await (await get('/api/files/list?path=.obsidian/plugins')).json()) as any;
    assert.deepEqual(plug.folders, ['.obsidian/plugins/x']);

    const st = (await (await get('/api/files/stat?path=.obsidian/plugins/x/data.json')).json()) as any;
    assert.equal(st.type, 'file');
    assert.equal(st.size, 7);
    assert.ok(st.mtime > 0);
    assert.equal(((await (await get('/api/files/stat?path=.obsidian')).json()) as any).type, 'folder');
    assert.equal((await get('/api/files/stat?path=nope.md')).status, 404);
    assert.equal((await get('/api/files/list?path=.git')).status, 400);
    assert.equal((await get('/api/files/stat?path=../etc/passwd')).status, 400);
  } finally {
    proc.kill();
    await rm(tmp, { recursive: true, force: true });
  }
});
