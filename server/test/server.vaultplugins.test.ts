import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Per-vault plugin mode: "same as the main vault" shares the plugin folder, "own" keeps a separate set that can take plugins over. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'vault-plugins-test-pw-1';

test('[server] vault plugin mode: shared uses the main vault’s plugins; own can take chosen ones over', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-vplug-'));
  const main = path.join(tmp, 'main'), a = path.join(tmp, 'a'), b = path.join(tmp, 'b'), dataDir = path.join(tmp, 'data');
  for (const d of [a, b]) await mkdir(d, { recursive: true });
  const plug = (id: string) => path.join(main, '.obsidian/plugins', id);
  for (const id of ['alpha', 'beta']) {
    await mkdir(plug(id), { recursive: true });
    await writeFile(path.join(plug(id), 'manifest.json'), JSON.stringify({ id, name: id.toUpperCase(), version: '1.0.0', minAppVersion: '1.0.0', author: 'x', description: 'd' }));
    await writeFile(path.join(plug(id), 'main.js'), `// ${id}`);
    await writeFile(path.join(plug(id), 'data.json'), JSON.stringify({ setting: id }));
  }
  await writeFile(path.join(main, '.obsidian/community-plugins.json'), '["alpha"]');
  await mkdir(dataDir, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, VAULT_PATH: main, WEBOBSIDIAN_PASSWORD: PASSWORD, NODE_ENV: 'test',
      WEBOBSIDIAN_VAULTS: JSON.stringify([{ id: 'same', name: 'Same', path: a, plugins: 'shared' }, { id: 'mine', name: 'Mine', path: b }]),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${base}/auth/status`)).ok; } catch { await sleep(150); } }
    assert.ok(up, 'server did not start');
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const call = (p: string, vault?: string, init: RequestInit = {}) =>
      fetch(base + p, { ...init, headers: { cookie, 'content-type': 'application/json', ...(vault ? { 'x-vault': vault } : {}) } });
    const json = async (p: string, vault?: string, init?: RequestInit) => (await call(p, vault, init)).json() as Promise<any>;

    const ids = (r: any) => r.plugins.map((p: any) => p.id).sort();
    assert.deepEqual(ids(await json('/api/plugins/')), ['alpha', 'beta']);
    assert.deepEqual(ids(await json('/api/plugins/', 'same')), ['alpha', 'beta'], 'shared vault sees the main vault’s plugins');
    assert.deepEqual(ids(await json('/api/plugins/', 'mine')), [], 'own vault starts empty');
    // plugin settings are the very same file in a shared vault
    assert.deepEqual((await json('/api/plugins/alpha/data', 'same')).data, { setting: 'alpha' });

    const avail = await json('/api/vaults/mine/plugins');
    assert.equal(avail.mode, 'own');
    assert.deepEqual(avail.available.map((p: any) => p.id).sort(), ['alpha', 'beta']);
    assert.equal((await json('/api/vaults/same/plugins')).mode, 'shared');
    // a shared vault cannot receive plugins
    assert.equal((await call('/api/vaults/same/plugins/transfer', undefined, { method: 'POST', body: JSON.stringify({ ids: ['alpha'] }) })).status, 400);
    // bad ids are refused
    assert.equal((await call('/api/vaults/mine/plugins/transfer', undefined, { method: 'POST', body: JSON.stringify({ ids: ['../x'] }) })).status, 400);

    const t = await json('/api/vaults/mine/plugins/transfer', undefined, { method: 'POST', body: JSON.stringify({ ids: ['alpha'] }) });
    assert.deepEqual(t, { done: ['alpha'], failed: [] });
    const mine = (await json('/api/plugins/', 'mine')).plugins;
    assert.deepEqual(mine.map((p: any) => [p.id, p.enabled]), [['alpha', true]], 'copied and kept enabled');
    assert.equal(await readFile(path.join(b, '.obsidian/plugins/alpha/data.json'), 'utf8'), JSON.stringify({ setting: 'alpha' }));
    assert.ok((await readFile(path.join(main, '.obsidian/plugins/alpha/main.js'), 'utf8')), 'copy leaves the source in place');

    const mv = await json('/api/vaults/mine/plugins/transfer', undefined, { method: 'POST', body: JSON.stringify({ ids: ['beta'], move: true }) });
    assert.deepEqual(mv.done, ['beta']);
    assert.deepEqual(ids(await json('/api/plugins/')), ['alpha'], 'moved plugin is gone from the main vault');
    assert.deepEqual(ids(await json('/api/plugins/', 'mine')), ['alpha', 'beta']);
  } finally {
    proc.kill();
    await rm(tmp, { recursive: true, force: true });
  }
});
