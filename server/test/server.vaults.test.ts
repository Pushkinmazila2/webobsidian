import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockGithub } from './helpers/mockGithub.js';

/** Several vaults in one server: a local main vault, a local extra, and a GitHub extra. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'vaults-test-password-1';

function start(env: Record<string, string>, dataDir: string) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  let log = '';
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, WEBOBSIDIAN_PASSWORD: PASSWORD, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
  return { proc, base: `http://127.0.0.1:${port}`, log: () => log, exited };
}

test('[server+vaults] isolated vaults of different types, per-request selection, env + UI management', async () => {
  const mock = new MockGithub();
  await mock.start();
  mock.commit({ 'Remote.md': '# Remote\nlinks to [[Shared]] okapi', 'Shared.md': 'remote shared' });
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-vaults-'));
  const dataDir = path.join(tmp, 'data');
  const main = path.join(tmp, 'main');
  const second = path.join(tmp, 'second');
  const third = path.join(tmp, 'third');
  for (const d of [dataDir, main, second, third]) await mkdir(d, { recursive: true });
  await writeFile(path.join(main, 'Main.md'), '# Main\nzebra [[Shared]]');
  await writeFile(path.join(main, 'Shared.md'), 'main shared');
  await writeFile(path.join(second, 'Second.md'), '# Second\nlemur');
  const s = start({
    VAULT_PATH: main,
    ALLOWED_ROOTS: tmp,
    WEBOBSIDIAN_GITHUB_FLUSH_SEC: '3600',
    KB_TOKEN: mock.token,
    WEBOBSIDIAN_VAULTS: JSON.stringify([
      { id: 'second', name: 'Second', driver: 'local', path: second },
      { id: 'kb', name: 'Knowledge base', repo: `${mock.owner}/${mock.repo}`, tokenEnv: 'KB_TOKEN', apiUrl: mock.url, flushSec: 3600, pollSec: 5 },
    ]),
  }, dataDir);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());
    const login = await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const api = (p: string, vault?: string, init: RequestInit = {}) =>
      fetch(s.base + p, { ...init, headers: { cookie, 'content-type': 'application/json', ...(vault ? { 'x-vault': vault } : {}), ...(init.headers as object) } });
    const json = async (p: string, vault?: string, init?: RequestInit) => (await api(p, vault, init)).json() as Promise<any>;

    // list
    const list = (await json('/api/vaults')).vaults;
    assert.deepEqual(list.map((v: any) => [v.id, v.driver, v.fromEnv]), [['default', 'local', false], ['second', 'local', true], ['kb', 'github', true]]);

    // no selector = main vault (unchanged behaviour); each vault only sees its own files
    const t0 = JSON.stringify(await json('/api/files'));
    assert.ok(t0.includes('Main.md') && !t0.includes('Second.md') && !t0.includes('Remote.md'), t0);
    const t1 = JSON.stringify(await json('/api/files', 'second'));
    assert.ok(t1.includes('Second.md') && !t1.includes('Main.md'), t1);
    const t2 = JSON.stringify(await json('/api/files', 'kb'));
    assert.ok(t2.includes('Remote.md') && !t2.includes('Main.md'), t2);

    // search is per vault
    assert.equal((await json('/api/search?q=zebra')).hits.length, 1);
    assert.equal((await json('/api/search?q=zebra', 'second')).hits.length, 0);
    assert.equal((await json('/api/search?q=lemur', 'second')).hits[0].path, 'Second.md');
    assert.equal((await json('/api/search?q=okapi', 'kb')).hits[0].path, 'Remote.md');
    assert.equal((await json('/api/search?q=okapi')).hits.length, 0);

    // link graph / backlinks are per vault (same note name "Shared" in two vaults)
    const g0 = await json('/api/graph');
    const g2 = await json('/api/graph', 'kb');
    assert.ok(JSON.stringify(g0).includes('Main.md') && !JSON.stringify(g0).includes('Remote.md'));
    assert.ok(JSON.stringify(g2).includes('Remote.md') && !JSON.stringify(g2).includes('Main.md'));

    // concurrent requests to different vaults never mix
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const v = ['default', 'second', 'kb'][i % 3];
      return json('/api/files', v === 'default' ? undefined : v).then((t) => [v, JSON.stringify(t)] as const);
    }));
    for (const [v, t] of results) {
      const want = { default: 'Main.md', second: 'Second.md', kb: 'Remote.md' }[v]!;
      assert.ok(t.includes(want), `${v}: ${t}`);
      for (const other of ['Main.md', 'Second.md', 'Remote.md'].filter((x) => x !== want)) assert.ok(!t.includes(other), `${v} leaked ${other}`);
    }

    // writes go to the selected vault only: local extra on disk, GitHub extra buffered then committed
    assert.equal((await api('/api/files/content', 'second', { method: 'PUT', body: JSON.stringify({ path: 'New.md', content: 'fresh' }) })).status, 200);
    assert.equal(await readFile(path.join(second, 'New.md'), 'utf8'), 'fresh');
    await assert.rejects(readFile(path.join(main, 'New.md'), 'utf8'));
    assert.equal((await api('/api/files/content', 'kb', { method: 'PUT', body: JSON.stringify({ path: 'Gh.md', content: 'to github' }) })).status, 200);
    assert.equal(mock.apiCommits.length, 0, 'write-behind: not committed yet');

    // plugin settings are per vault (kept inside each vault)
    assert.equal((await api('/api/plugins/demo/data', 'second', { method: 'PUT', body: JSON.stringify({ data: { a: 1 } }) })).status, 200);
    assert.deepEqual((await json('/api/plugins/demo/data', 'second')).data, { a: 1 });
    assert.deepEqual((await json('/api/plugins/demo/data')).data, {});

    // UI state is per vault
    await api('/api/uistate', 'second', { method: 'PUT', body: JSON.stringify({ tabs: ['x'] }) });
    assert.deepEqual(await json('/api/uistate', 'second'), { tabs: ['x'] });
    assert.deepEqual(await json('/api/uistate'), {});

    // shares: created in a vault, served from that vault with no auth and no selector
    const sh = (await json('/api/shares', 'second', { method: 'POST', body: JSON.stringify({ path: 'Second.md' }) })).share;
    assert.ok(sh.id);
    assert.equal((await json('/api/shares')).shares.length, 0, 'main vault does not list it');
    const pub = await fetch(`${s.base}/public/shares/${sh.id}`);
    assert.equal(pub.status, 200);
    assert.ok(JSON.stringify(await pub.json()).includes('lemur'));

    // unknown vault, git on an extra vault
    assert.equal((await api('/api/files', 'nope')).status, 404);
    assert.equal((await api('/api/git/status', 'second')).status, 400);
    const gst = await json('/api/git/status', 'kb');
    assert.equal(gst.driver, 'github');
    assert.equal(gst.ahead, 1, 'the buffered write of this vault is reported as unsaved');
    // unauthenticated requests cannot start or reach a vault
    assert.equal((await fetch(`${s.base}/api/files`, { headers: { 'x-vault': 'kb' } })).status, 401);

    // management: env vaults are read-only; UI vaults are added/changed/removed at runtime
    assert.equal((await api('/api/vaults/kb', undefined, { method: 'DELETE' })).status, 409);
    assert.equal((await api('/api/vaults', undefined, { method: 'POST', body: JSON.stringify({ name: 'Third', storage: { driver: 'local' }, path: '/etc' }) })).status, 403);
    const made = await api('/api/vaults', undefined, { method: 'POST', body: JSON.stringify({ name: 'Third', storage: { driver: 'local' }, path: third }) });
    assert.equal(made.status, 200, await made.text());
    assert.equal((await api('/api/vaults', undefined, { method: 'POST', body: JSON.stringify({ name: 'x', id: 'second', path: third, storage: { driver: 'local' } }) })).status, 409);
    await json('/api/files/content', 'third', { method: 'PUT', body: JSON.stringify({ path: 'T.md', content: 'tee' }) });
    assert.equal(await readFile(path.join(third, 'T.md'), 'utf8'), 'tee');
    assert.equal((await api('/api/vaults/third', undefined, { method: 'PUT', body: JSON.stringify({ name: 'Third!' }) })).status, 200);
    assert.equal((await json('/api/vaults')).vaults.find((v: any) => v.id === 'third').name, 'Third!');
    assert.equal((await json('/api/vaults/third')).vault.storage.github.token, '');
    assert.equal((await api('/api/vaults/third', undefined, { method: 'DELETE' })).status, 200);
    assert.equal((await api('/api/files', 'third')).status, 404);
    await readFile(path.join(third, 'T.md'), 'utf8'); // the folder itself is left alone

    // saved settings never contain env vaults
    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual(onDisk.vaults, []);

    // shutdown saves buffered changes of every vault
    s.proc.kill('SIGTERM');
    await s.exited;
    assert.equal(mock.apiCommits.length, 1, s.log());
    assert.equal(mock.fileAtHead('Gh.md')?.toString(), 'to github');
  } finally {
    s.proc.kill('SIGKILL');
    await mock.stop();
  }
});

test('[server+vaults] a malformed WEBOBSIDIAN_VAULTS stops the server with a clear message', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-vaults-bad-'));
  const dataDir = path.join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  for (const bad of ['not json', '[{"id":"A b","name":"x","path":"/tmp"}]', '[{"id":"kb","repo":"nonsense"}]']) {
    const s = start({ VAULT_PATH: tmp, WEBOBSIDIAN_VAULTS: bad }, dataDir);
    const code = await Promise.race([s.exited, sleep(15000).then(() => 'timeout')]);
    s.proc.kill('SIGKILL');
    assert.equal(code, 1, `${bad}\n${s.log()}`);
    assert.match(s.log(), /WEBOBSIDIAN_VAULTS/);
  }
});
