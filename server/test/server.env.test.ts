import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockGithub } from './helpers/mockGithub.js';

/** A container started with nothing but environment variables: no settings.json, no UI. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'env-smoke-password-1';

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

test('[server+env] a container configured only by environment variables', async () => {
  const mock = new MockGithub();
  await mock.start();
  mock.commit({ 'docs/Welcome.md': '# Hi [[Zebras]]', 'docs/Zebras.md': 'zebras', 'docs/Private/Secret.md': 'platypus', 'docs/pic.png': Buffer.from('png') });
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-env-'));
  const dataDir = path.join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const env = {
    WEBOBSIDIAN_GITHUB_REPO: `${mock.owner}/${mock.repo}`,
    WEBOBSIDIAN_GITHUB_BASE_PATH: 'docs',
    WEBOBSIDIAN_GITHUB_API_URL: mock.url,
    WEBOBSIDIAN_GITHUB_TOKEN: mock.token,
    WEBOBSIDIAN_GITHUB_FLUSH_SEC: '3600',
    WEBOBSIDIAN_GITHUB_POLL_SEC: '5',
    WEBOBSIDIAN_STORAGE_RULES: 'Private/**=remote:noindex;**/*.md=mirror:index;**=lazy',
  };
  const s = start(env, dataDir);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());
    const login = await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const api = (p: string, init: RequestInit = {}) => fetch(s.base + p, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers as object) } });
    const json = async (p: string, init?: RequestInit) => (await api(p, init)).json() as Promise<any>;

    // the vault is the GitHub folder, with the rules from the environment (Private/** not indexed)
    const tree = JSON.stringify(await json('/api/files'));
    assert.ok(tree.includes('Welcome.md') && tree.includes('Private/Secret.md'), tree);
    assert.equal((await json('/api/search?q=zebras')).hits[0].path, 'Zebras.md');
    assert.equal((await json('/api/search?q=platypus')).hits.length, 0, 'noindex rule from env is applied');

    // status reports what is locked, and by which variable
    const st = await json('/api/settings/storage/status');
    assert.equal(st.active, 'github');
    assert.equal(st.restartRequired, false);
    assert.equal(st.locked['github.repo'], 'WEBOBSIDIAN_GITHUB_REPO');
    assert.equal(st.locked['github.basePath'], 'WEBOBSIDIAN_GITHUB_BASE_PATH');
    assert.equal(st.locked.rules, 'WEBOBSIDIAN_STORAGE_RULES');
    assert.equal(st.locked['github.token'], 'WEBOBSIDIAN_GITHUB_TOKEN');
    assert.equal(st.locked['github.branch'], undefined, 'unset variables stay editable');
    const shown = (await json('/api/settings')).storage;
    assert.equal(shown.driver, 'github');
    assert.equal(shown.github.repo, mock.repo);
    assert.equal(shown.rules.length, 3);

    // the UI cannot override a locked field; unlocked ones still save
    const put = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ storage: { driver: 'local', github: { repo: 'other', branch: 'dev' }, rules: [{ match: '**', mode: 'mirror' }], cache: { maxMB: 64 } } }) });
    assert.equal(put.status, 200);
    const after = (await put.json()).storage;
    assert.equal(after.driver, 'github');
    assert.equal(after.github.repo, mock.repo, 'locked field kept');
    assert.equal(after.rules.length, 3, 'locked rules kept');
    assert.equal(after.github.branch, 'dev', 'unlocked field saved');
    assert.equal(after.cache.maxMB, 64);

    // settings.json holds only what the user saved — nothing from the environment, no token
    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(onDisk.storage.github.branch, 'dev');
    assert.equal(onDisk.storage.github.repo, '', 'env value was not persisted');
    assert.equal(onDisk.storage.github.basePath, '');
    assert.equal(onDisk.storage.driver, 'local');
    assert.equal(onDisk.storage.github.token, '');
    assert.ok(!(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).includes(mock.token));

    // writes still go to GitHub, under the base folder
    await api('/api/files/content', { method: 'PUT', body: JSON.stringify({ path: 'Env note.md', content: 'from env container' }) });
    assert.equal((await json('/api/git/sync', { method: 'POST' })).ok, true);
    assert.equal(mock.fileAtHead('docs/Env note.md')!.toString(), 'from env container');
  } finally {
    s.proc.kill('SIGTERM');
    await s.exited;
  }

  // restart WITHOUT the variables: the saved (local) settings apply again — env really was only an overlay
  const s2 = start({}, dataDir);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s2.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, s2.log());
    assert.match(s2.log(), /Vault: /);
    const login = await fetch(`${s2.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const st = await (await fetch(`${s2.base}/api/settings/storage/status`, { headers: { cookie } })).json();
    assert.equal(st.active, 'local');
    assert.deepEqual(st.locked, {});
    // with nothing locked, a token typed in the UI is saved, masked in responses, and not overwritten by the mask
    const put = (body: object) => fetch(`${s2.base}/api/settings`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const saved = await put({ storage: { github: { token: 'ghp_from_ui_secret' } } });
    assert.equal(saved.status, 200);
    const text = await saved.text();
    assert.ok(!text.includes('ghp_from_ui_secret'));
    assert.equal(JSON.parse(text).storage.github.token, '••••••••');
    await put({ storage: { github: { token: '••••••••' } } });
    assert.equal(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).storage.github.token, 'ghp_from_ui_secret');
  } finally {
    s2.proc.kill('SIGTERM');
    await s2.exited;
    await mock.stop();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('[server+env] a malformed variable stops the server with a message naming it', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-env-bad-'));
  const s = start({ WEBOBSIDIAN_GITHUB_REPO: 'o/r', WEBOBSIDIAN_GITHUB_TOKEN: 't', WEBOBSIDIAN_STORAGE_RULES: '**=sometimes' }, path.join(tmp, 'data'));
  try {
    const code = await Promise.race([s.exited, sleep(30000).then(() => 'timeout' as const)]);
    assert.notEqual(code, 'timeout', 'server kept running with a bad variable');
    assert.notEqual(code, 0);
    assert.match(s.log(), /WEBOBSIDIAN_STORAGE_RULES/);
  } finally {
    s.proc.kill('SIGKILL');
    await rm(tmp, { recursive: true, force: true });
  }
});
