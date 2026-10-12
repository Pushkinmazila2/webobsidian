import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitBlobSha } from '../src/storage/github/index.js';
import { MockGithub } from './helpers/mockGithub.js';

/**
 * End-to-end: the real server process, GitHub storage driver, mock GitHub API.
 * Covers the glue the unit tests can't: facade wiring, startup indexing, the
 * watcher → search-index pipeline, HTTP status mapping and secret redaction.
 */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('[server+github] routes, search, Range, writes + commit, external commits, shutdown flush, no secrets', async () => {
  const mock = new MockGithub();
  await mock.start();
  mock.commit({
    'vault/Welcome.md': '# Welcome\n\nSee [[Zebras]] and ![[pic.png]]\n',
    'vault/Notes/Zebras.md': 'a note about zebras #animals\n',
    'vault/Работа/Заметка №1.md': 'кириллица и пробелы',
    'vault/Attachments/pic.png': PNG,
    'vault/.obsidian/types.json': '{"types":{"status":"text"}}',
    'vault/.obsidian/plugins/demo/manifest.json': '{"id":"demo","name":"Demo","version":"1.0.0"}',
    'vault/.obsidian/plugins/demo/main.js': 'module.exports = class Demo {};',
    'vault/.trash/Old.md': 'deleted earlier',
    'vault/Private/Secret.md': 'the platypus is a secret [[Zebras]]',
    'outside-the-vault.md': 'must not be visible',
  });

  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-srv-gh-'));
  const dataDir = path.join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ storage: { driver: 'github', github: { owner: mock.owner, repo: mock.repo, basePath: 'vault', apiUrl: mock.url, pollSec: 5, flushSec: 3600 },
        rules: [
          { match: '.obsidian/**', mode: 'mirror', index: false },
          { match: 'Private/**', mode: 'remote', index: false },
          { match: '**/*.{md,markdown,canvas}', mode: 'mirror', index: true },
          { match: '**', mode: 'lazy', index: false },
        ] } }),
  );
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const PASSWORD = 'gh-smoke-password-1';
  let log = '';
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, WEBOBSIDIAN_PASSWORD: PASSWORD, WEBOBSIDIAN_GITHUB_TOKEN: mock.token, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));

  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'server did not start:\n' + log);

    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie, 'login failed');
    const api = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.headers as object) } });
    const json = async (p: string, init?: RequestInit) => (await api(p, init)).json() as Promise<any>;

    // tree: basePath applied, hidden + outside files absent, Cyrillic intact
    const tree = await json('/api/files');
    const paths: string[] = [];
    const walk = (n: any) => (n.children ?? []).forEach((c: any) => (paths.push(c.path), walk(c)));
    walk(tree);
    assert.deepEqual(paths.sort(), ['Attachments', 'Attachments/pic.png', 'Notes', 'Notes/Zebras.md', 'Private', 'Private/Secret.md', 'Welcome.md', 'Работа', 'Работа/Заметка №1.md'].sort());

    assert.match((await json('/api/files/content?path=' + encodeURIComponent('Работа/Заметка №1.md'))).content ?? '', /кириллица/);

    // search/backlinks/resolve are built from the mirrored notes
    assert.equal((await json('/api/search?q=zebras')).hits[0].path, 'Notes/Zebras.md');
    assert.ok((await json('/api/backlinks?path=Notes/Zebras.md')).backlinks.length >= 1);
    assert.equal((await json('/api/resolve?target=pic.png')).path, 'Attachments/pic.png');

    // index:false → visible in the tree and readable on demand, but NOT in search/graph, and not downloaded up front
    const secretSha = gitBlobSha(Buffer.from('the platypus is a secret [[Zebras]]'));
    assert.ok(!mock.urls.some((u) => u.includes(secretSha)), 'an unindexed remote note was downloaded at startup');
    assert.equal((await json('/api/search?q=platypus')).hits.length, 0);
    assert.ok(!(await json('/api/backlinks?path=Notes/Zebras.md')).backlinks.includes('Private/Secret.md'));
    assert.match((await json('/api/files/content?path=Private/Secret.md')).content, /platypus/);
    assert.ok(mock.urls.some((u) => u.includes(secretSha)), 'reading it should fetch it from GitHub');
    assert.equal((await json('/api/search?q=platypus')).hits.length, 0);

    // binary: full, Range, bad Range, resolved by basename
    const full = await api('/api/files/content?path=Attachments/pic.png');
    assert.equal(Buffer.compare(Buffer.from(await full.arrayBuffer()), PNG), 0);
    const part = await api('/api/files/content?path=Attachments/pic.png', { headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(Buffer.compare(Buffer.from(await part.arrayBuffer()), PNG.subarray(2, 6)), 0);
    assert.equal((await api('/api/files/content?path=Attachments/pic.png', { headers: { range: 'bytes=9999-' } })).status, 416);
    assert.equal(Buffer.compare(Buffer.from(await (await api('/api/files/content?path=pic.png')).arrayBuffer()), PNG), 0);

    // plugins + property types come out of .obsidian through the same driver
    const plugins = await json('/api/plugins');
    assert.deepEqual(plugins.plugins.map((p: any) => p.id), ['demo']);
    assert.match(await (await api('/api/plugins/demo/main.js')).text(), /class Demo/);
    assert.deepEqual((await json('/api/property-types')).types ?? (await json('/api/property-types')), { status: 'text' });
    assert.equal((await json('/api/files/trash')).items?.[0]?.original ?? (await json('/api/files/trash'))[0]?.original, 'Old.md');

    // writes: instantly visible + searchable, buffered (nothing sent), then ONE commit on sync
    const putJson = (p: string, body: object, method = 'PUT') => api(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await putJson('/api/files/content', { path: 'Notes/Ocelot.md', content: 'ocelots link to [[Zebras]]' })).status, 200);
    assert.equal((await putJson('/api/files/content', { path: 'Welcome.md', content: '# Welcome\n\nedited [[Zebras]]\n' })).status, 200);
    assert.equal((await putJson('/api/files/rename', { from: 'Работа/Заметка №1.md', to: 'Работа/Заметка №2.md' }, 'PATCH')).status, 200);
    assert.equal((await api('/api/files?path=Notes/Zebras.md', { method: 'DELETE' })).status, 200);
    assert.equal((await json('/api/search?q=ocelots')).hits[0]?.path, 'Notes/Ocelot.md');
    assert.match((await json('/api/files/content?path=Welcome.md')).content, /edited/);
    assert.equal(mock.apiCommits.length, 0, 'nothing is sent to GitHub while editing');
    const st1 = await json('/api/git/status');
    assert.equal(st1.driver, 'github');
    assert.equal(st1.clean, false);
    assert.equal(st1.ahead, 6); // 2 saves + rename (2 paths) + trash (2 paths)
    assert.equal(st1.remote, `${mock.owner}/${mock.repo}`);
    assert.equal((await api('/api/git/init', { method: 'POST' })).status, 400);
    assert.equal((await api('/api/git/log?path=Welcome.md')).status, 501);

    const sync = await json('/api/git/sync', { method: 'POST' });
    assert.equal(sync.ok, true, JSON.stringify(sync));
    assert.equal(mock.apiCommits.length, 1);
    assert.deepEqual(mock.apiCommits[0].changed, ['vault/.trash/Notes/Zebras.md', 'vault/Notes/Ocelot.md', 'vault/Notes/Zebras.md', 'vault/Welcome.md', 'vault/Работа/Заметка №1.md', 'vault/Работа/Заметка №2.md']);
    assert.equal(mock.fileAtHead('vault/Notes/Ocelot.md')!.toString(), 'ocelots link to [[Zebras]]');
    assert.equal(mock.fileAtHead('outside-the-vault.md')!.toString(), 'must not be visible', 'files outside basePath untouched');
    const st2 = await json('/api/git/status');
    assert.equal(st2.clean, true);
    assert.equal(st2.ahead, 0);
    assert.equal((await api('/api/files/content?path=Welcome.md')).status, 200);

    // settings never expose the token (it came from the environment here)
    const settings = await api('/api/settings');
    const text = await settings.text();
    assert.ok(!text.includes(mock.token));
    assert.equal(JSON.parse(text).storage.driver, 'github');

    // an outside commit shows up through the poller → watcher → search index pipeline
    const blobsBefore = mock.count('blob');
    mock.commit({ 'vault/Giraffe.md': 'a note about giraffes', 'vault/Notes/Zebras.md': 'zebras are now striped horses' });
    let hit = false;
    for (let i = 0; i < 40 && !hit; i++) {
      await sleep(250);
      hit = (await json('/api/search?q=giraffes')).hits.length > 0;
    }
    assert.ok(hit, 'new file never reached the search index:\n' + log.slice(-1500));
    assert.match((await json('/api/files/content?path=Notes/Zebras.md')).content, /striped horses/);
    assert.ok(mock.count('blob') - blobsBefore <= 2, 'only the two changed notes were downloaded');
    // an outside edit to an unindexed note must not leak it into the index either
    mock.commit({ 'vault/Private/Secret.md': 'the platypus is now a pangolin', 'vault/Private/Another.md': 'pangolin diary, see [[Zebras]]' });
    await sleep(7000); // > pollSec
    assert.equal((await json('/api/search?q=pangolin')).hits.length, 0, 'unindexed file reached the search index');
    assert.ok(!(await json('/api/backlinks?path=Notes/Zebras.md')).backlinks.some((b: string) => b.startsWith('Private/')), 'unindexed file reached the link graph');
    mock.commit({ 'vault/Giraffe.md': null });
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250);
      gone = (await json('/api/search?q=giraffes')).hits.length === 0;
    }
    assert.ok(gone, 'deleted file stayed in the search index');

    // memory mode: no note text on disk — DATA_DIR holds app config only, never an index or cache
    await sleep(500);
    const onDisk = (await readdir(dataDir)).sort();
    assert.ok(!onDisk.includes('qmd-index.json'), 'search index was written to disk: ' + onDisk);
    assert.ok(!onDisk.includes('cache'), 'content cache was written to disk: ' + onDisk);

    // settings UI backend: status, connection test, validated saves, token never echoed
    const stat = await json('/api/settings/storage/status');
    assert.deepEqual([stat.active, stat.configured, stat.restartRequired, stat.tokenSource], ['github', 'github', false, 'env']);
    assert.equal(stat.remote.repo, `${mock.owner}/${mock.repo}`);
    const t1 = await json('/api/settings/storage/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ github: { basePath: 'vault' } }) });
    assert.equal(t1.ok, true, JSON.stringify(t1));
    assert.equal(t1.branch, 'main');
    assert.ok(t1.files >= 5 && t1.notes >= 3 && t1.basePathFound === true);
    const t2 = await json('/api/settings/storage/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ github: { repo: 'missing' } }) });
    assert.equal(t2.ok, false);
    assert.match(t2.error, /not found|Not Found/i);
    const bad = (body: object) => putJson('/api/settings', body).then((r) => r.status);
    assert.equal(await bad({ storage: { github: { basePath: '../etc' } } }), 400);
    assert.equal(await bad({ storage: { github: { owner: 'a b' } } }), 400);
    assert.equal(await bad({ storage: { github: { apiUrl: 'file:///etc/passwd' } } }), 400);
    assert.equal(await bad({ storage: { rules: [{ match: '**', mode: 'bogus' }] } }), 400);
    assert.equal(await bad({ storage: { driver: 'ftp' } }), 400);
    assert.equal(await bad({ storage: { github: { flushSec: 0 } } }) >= 400, true, 'out-of-range numbers are rejected by the schema');
    const saved = await putJson('/api/settings', { storage: { github: { flushSec: 30, token: 'ghp_from_ui_secret' }, rules: [{ match: '**/*.md', mode: 'mirror', index: true }, { match: '**', mode: 'remote', index: false }] } });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.ok(!savedText.includes('ghp_from_ui_secret'), 'token echoed back');
    assert.equal(JSON.parse(savedText).storage.github.token, '', 'token comes from the environment here, so the UI cannot set it');
    assert.equal(JSON.parse(savedText).storage.rules.length, 2);
    await putJson('/api/settings', { storage: { github: { token: '••••••••' } } }); // masked value must not overwrite
    const onDiskSettings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(onDiskSettings.storage.github.token, '', 'an env-locked token is neither overridden nor persisted');
    assert.equal((await json('/api/settings/storage/status')).restartRequired, true, 'saved settings differ from the running driver');
    assert.equal((await api('/api/files/content?path=Welcome.md')).status, 200, 'running vault is unaffected until restart');

    // graceful shutdown commits what is still buffered
    assert.equal((await putJson('/api/files/content', { path: 'Last words.md', content: 'saved on SIGTERM' })).status, 200);
    const before = mock.apiCommits.length;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
    });
    assert.equal(mock.apiCommits.length, before + 1, 'SIGTERM did not flush:\n' + log.slice(-800));
    assert.equal(mock.fileAtHead('vault/Last words.md')!.toString(), 'saved on SIGTERM');

    // the token never appears in any request URL or in the server log
    assert.ok(mock.urls.every((u) => !u.includes(mock.token)));
    assert.ok(!log.includes(mock.token));
  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    await mock.stop();
    await rm(tmp, { recursive: true, force: true });
  }
});
