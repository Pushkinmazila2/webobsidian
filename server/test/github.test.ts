import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { DiskContentCache, GithubClient, GitHubStorage, MemoryContentCache, Rules, gitBlobSha } from '../src/storage/github/index.js';
import { tarFiles } from '../src/storage/github/tar.js';
import type { StorageEvent } from '../src/storage/types.js';
import { MockGithub, buildTar } from './helpers/mockGithub.js';
import { runReadContract, type SeedFiles } from './storage.read.contract.js';
import { gzipSync } from 'node:zlib';

const DEFAULT_RULES = [
  { match: '.obsidian/**', mode: 'mirror' as const },
  { match: '**/*.{md,markdown,canvas}', mode: 'mirror' as const },
  { match: '**', mode: 'lazy' as const },
];

interface Over {
  rules?: { match: string; mode: 'mirror' | 'lazy' | 'remote' }[];
  basePath?: string;
  cache?: MemoryContentCache | DiskContentCache;
  files?: SeedFiles;
  pollMs?: number;
  remoteTtlMs?: number;
  tarballThreshold?: number;
  token?: string;
  client?: Partial<ConstructorParameters<typeof GithubClient>[0]>;
}

async function setup(over: Over = {}) {
  const mock = new MockGithub();
  await mock.start();
  if (over.files) mock.commit(over.files);
  const cache = over.cache ?? new MemoryContentCache(64 * 1024 * 1024);
  const client = new GithubClient({
    apiUrl: mock.url,
    token: over.token ?? mock.token,
    retryBaseMs: 1,
    maxRateWaitMs: 50,
    sleep: async () => {},
    ...over.client,
  });
  const storage = new GitHubStorage({
    owner: mock.owner,
    repo: mock.repo,
    basePath: over.basePath,
    client,
    rules: new Rules(over.rules ?? DEFAULT_RULES),
    cache,
    pollMs: over.pollMs ?? 20,
    remoteTtlMs: over.remoteTtlMs,
    tarballThreshold: over.tarballThreshold,
    log: () => {},
  });
  return { mock, storage, cache, client, stop: () => mock.stop() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for condition');
    await sleep(10);
  }
}
const manyMd = (n: number): SeedFiles => Object.fromEntries(Array.from({ length: n }, (_, i) => [`notes/n${i}.md`, `note ${i}`]));

// ---- shared read contract, GitHub driver --------------------------------------

runReadContract('github', async () => {
  const { mock, storage, stop } = await setup();
  return {
    storage,
    seed: async (files) => {
      mock.commit(files);
      await storage.refresh();
    },
    cleanup: stop,
  };
});

// ---- request budget & caching ---------------------------------------------------

test('[github] init costs one recursive tree request; a large mirror set is warmed with ONE tarball', async () => {
  const files = { ...manyMd(40), 'img/pic.png': Buffer.from([1, 2, 3]) };
  const { mock, storage, stop } = await setup({ files });
  try {
    await storage.init();
    assert.equal(mock.count('tree-recursive'), 1);
    assert.equal(mock.count('tarball'), 1);
    assert.equal(mock.count('blob'), 0);
    for (let i = 0; i < 40; i++) assert.equal(await storage.readText(`notes/n${i}.md`), `note ${i}`);
    assert.equal(mock.count('blob'), 0, 'mirror notes are served from the cache');
    assert.equal(await storage.exists('img/pic.png'), true);
    assert.equal(mock.count('blob'), 0, 'lazy files are not fetched up front');
  } finally {
    await stop();
  }
});

test('[github] a small mirror set uses blob requests, not a tarball', async () => {
  const { mock, storage, stop } = await setup({ files: manyMd(3) });
  try {
    await storage.init();
    assert.equal(mock.count('tarball'), 0);
    assert.equal(mock.count('blob'), 3);
  } finally {
    await stop();
  }
});

test('[github] tarball matching survives long, non-ASCII and spaced paths (pax headers)', async () => {
  const long = `${'очень-длинная-папка/'.repeat(8)}Заметка с пробелами №1.md`;
  const files = { ...manyMd(35), [long]: 'long body', 'a b/ё.md': 'yo' };
  const { mock, storage, stop } = await setup({ files });
  try {
    await storage.init();
    assert.equal(mock.count('tarball'), 1);
    assert.equal(await storage.readText(long), 'long body');
    assert.equal(await storage.readText('a b/ё.md'), 'yo');
    assert.equal(mock.count('blob'), 0);
  } finally {
    await stop();
  }
});

test('[github] lazy files are fetched once and cached', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.png': Buffer.from('PNGDATA') } });
  try {
    await storage.init();
    await storage.readBuffer('a.png');
    await storage.readBuffer('a.png');
    await (await storage.openFile('a.png')).createReadStream({ start: 0, end: 1 }).resume();
    assert.equal(mock.count('blob'), 1);
  } finally {
    await stop();
  }
});

test('[github] remote files are never cached, only held briefly in memory', async () => {
  const { mock, storage, cache, stop } = await setup({
    files: { 'v.mp4': Buffer.from('VIDEO') },
    rules: [{ match: '**', mode: 'remote' }],
    remoteTtlMs: 60,
  });
  try {
    await storage.init();
    await storage.readBuffer('v.mp4');
    await storage.readBuffer('v.mp4'); // within TTL → no refetch (e.g. successive Range requests)
    assert.equal(mock.count('blob'), 1);
    assert.equal(await cache.has(gitBlobSha(Buffer.from('VIDEO'))), false, 'nothing persisted');
    await sleep(120);
    await storage.readBuffer('v.mp4');
    assert.equal(mock.count('blob'), 2, 'refetched after the TTL');
  } finally {
    await stop();
  }
});

test('[github] LRU evicts lazy entries but never mirror (pinned) ones', async () => {
  const a = Buffer.alloc(2000, 1);
  const b = Buffer.alloc(2000, 2);
  const note = Buffer.from('# mirrored note');
  const cache = new MemoryContentCache(3000);
  const { storage, stop } = await setup({ cache, files: { 'n.md': note, 'a.bin': a, 'b.bin': b } });
  try {
    await storage.init();
    await storage.readBuffer('a.bin');
    await storage.readBuffer('b.bin'); // 4000 + note > 3000 → oldest unpinned (a) goes
    assert.equal(await cache.has(gitBlobSha(a)), false);
    assert.equal(await cache.has(gitBlobSha(b)), true);
    assert.equal(await cache.has(gitBlobSha(note)), true, 'mirror entry kept');
  } finally {
    await stop();
  }
});

test('[github] disk cache survives a restart: no content requests on the second start', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wobs-cache-'));
  const { mock, storage, stop } = await setup({ files: { ...manyMd(35), 'x.png': Buffer.from('PNG') }, cache: new DiskContentCache(dir, 10_000_000) });
  try {
    await storage.init();
    await storage.readBuffer('x.png');
    const before = { blob: mock.count('blob'), tar: mock.count('tarball') };
    const second = new GitHubStorage({
      owner: mock.owner, repo: mock.repo,
      client: new GithubClient({ apiUrl: mock.url, token: mock.token, sleep: async () => {} }),
      rules: new Rules(DEFAULT_RULES), cache: new DiskContentCache(dir, 10_000_000), log: () => {},
    });
    await second.init();
    assert.equal(mock.count('blob'), before.blob);
    assert.equal(mock.count('tarball'), before.tar);
    assert.equal(await second.readText('notes/n7.md'), 'note 7');
    assert.equal(Buffer.compare(await second.readBuffer('x.png'), Buffer.from('PNG')), 0);
    assert.equal(mock.count('blob'), before.blob);
    // content-addressed layout, no stray temp files
    const subs = await readdir(dir);
    assert.ok(subs.every((s) => /^[0-9a-f]{2}$/.test(s)));
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('[github] disk cache evicts least-recently-used unpinned entries over budget', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wobs-cache-'));
  try {
    const c = new DiskContentCache(dir, 2500);
    await c.init();
    const bufs = [1, 2, 3].map((n) => Buffer.alloc(1000, n));
    const shas = bufs.map(gitBlobSha);
    await c.put(shas[0], bufs[0]);
    await new Promise((r) => setTimeout(r, 5));
    await c.put(shas[1], bufs[1]);
    await new Promise((r) => setTimeout(r, 5));
    await c.get(shas[0]); // touch 0 → 1 is now the oldest
    await c.put(shas[2], bufs[2]);
    assert.equal(await c.has(shas[1]), false);
    assert.equal(await c.has(shas[0]), true);
    assert.equal(await c.has(shas[2]), true);
    c.pin(shas[0]);
    await c.put(gitBlobSha(Buffer.alloc(2000, 9)), Buffer.alloc(2000, 9));
    assert.equal(await c.has(shas[0]), true, 'pinned entry survives eviction');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- tree handling --------------------------------------------------------------

test('[github] basePath makes a repo subfolder the vault root', async () => {
  const files = { 'docs/a.md': 'A', 'docs/sub/b.md': 'B', 'other/c.md': 'C', 'root.md': 'R' };
  const { storage, stop } = await setup({ files, basePath: 'docs' });
  try {
    await storage.init();
    assert.deepEqual(await storage.listFiles(), ['a.md', 'sub/b.md']);
    assert.equal(await storage.readText('sub/b.md'), 'B');
    assert.equal(await storage.exists('other'), false);
    assert.equal(await storage.exists('root.md'), false);
    assert.equal((await storage.listTree()).name, 'docs');
  } finally {
    await stop();
  }
  const nested = await setup({ files, basePath: 'docs/sub' });
  try {
    await nested.storage.init();
    assert.deepEqual(await nested.storage.listFiles(), ['b.md']);
  } finally {
    await nested.stop();
  }
  const missing = await setup({ files, basePath: 'nope/at/all' });
  try {
    await missing.storage.init();
    assert.deepEqual(await missing.storage.listFiles(), []);
  } finally {
    await missing.stop();
  }
});

test('[github] a truncated recursive tree falls back to walking directories', async () => {
  const files = { 'a.md': '1', 'x/b.md': '2', 'x/y/c.md': '3', 'x/y/z/d.md': '4', 'w/e.md': '5', 'w/f.md': '6' };
  const { mock, storage, stop } = await setup({ files });
  mock.truncateRecursiveAt = 2;
  try {
    await storage.init();
    assert.deepEqual(await storage.listFiles(), ['a.md', 'w/e.md', 'w/f.md', 'x/b.md', 'x/y/c.md', 'x/y/z/d.md']);
    assert.ok(mock.count('tree') > mock.count('tree-recursive'));
    assert.equal(await storage.readText('x/y/z/d.md'), '4');
  } finally {
    await stop();
  }
});

// ---- change feed ----------------------------------------------------------------

test('[github] poller turns outside commits into add/change/unlink events, mirror content already readable', async () => {
  const { mock, storage, stop } = await setup({
    files: { 'keep.md': 'k', 'edit.md': 'v1', 'gone.md': 'x', '.obsidian/workspace.json': '{}' },
  });
  const events: StorageEvent[] = [];
  const seen: Record<string, string> = {};
  let blobsAtEvent = -1;
  let stopWatch: (() => Promise<void>) | undefined;
  try {
    await storage.init();
    stopWatch = await storage.watch(async (e) => {
      events.push(e);
      if (e.type === 'change' || e.type === 'add') {
        if (blobsAtEvent < 0) blobsAtEvent = mock.count('blob');
        seen[e.path] = await storage.readText(e.path);
      }
    });
    const blobsBefore = mock.count('blob');
    mock.commit({
      'edit.md': 'v2',
      'gone.md': null,
      'new/dir/added.md': 'fresh',
      '.obsidian/workspace.json': '{"changed":1}', // hidden/ignored → must not be reported
      '.trash/old.md': 'trashed', // ignored too
    });
    await until(() => events.some((e) => e.type === 'unlink'));
    await sleep(60);
    const key = (e: StorageEvent) => `${e.type}:${e.path}`;
    assert.deepEqual(events.map(key).sort(), [
      'add:new/dir/added.md',
      'addDir:new',
      'addDir:new/dir',
      'change:edit.md',
      'unlink:gone.md',
    ]);
    assert.equal(seen['edit.md'], 'v2');
    assert.equal(seen['new/dir/added.md'], 'fresh');
    assert.equal(mock.count('blob') - blobsBefore, blobsAtEvent - blobsBefore, 'reading inside the handler cost no extra blob requests');
    assert.deepEqual(await storage.listFiles(), ['edit.md', 'keep.md', 'new/dir/added.md']);
  } finally {
    await stopWatch?.();
    await stop();
  }
});

test('[github] an idle branch costs only conditional ref requests (304), no tree fetches', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': '1' } });
  let stopWatch: (() => Promise<void>) | undefined;
  try {
    await storage.init();
    const trees = mock.count('tree');
    stopWatch = await storage.watch(() => {});
    await until(() => mock.refNotModified >= 3);
    assert.equal(mock.count('tree'), trees);
    assert.equal(mock.count('commit'), 1);
  } finally {
    await stopWatch?.();
    await stop();
  }
});

test('[github] stopping the watcher stops polling', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': '1' } });
  try {
    await storage.init();
    const s = await storage.watch(() => {});
    await until(() => mock.count('ref') >= 3);
    await s();
    await sleep(60);
    const n = mock.count('ref');
    await sleep(120);
    assert.equal(mock.count('ref'), n);
  } finally {
    await stop();
  }
});

// ---- errors, rate limits, secrets ------------------------------------------------

test('[github] rate limiting surfaces as 429 (never 401/403) and short waits are retried', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.png': Buffer.from('P') }, client: { maxRateWaitMs: 5000 } });
  try {
    await storage.init();
    // short Retry-After → waited out and retried transparently
    mock.inject(/\/git\/blobs\//, 429, { headers: { 'retry-after': '1' }, body: { message: 'secondary rate limit' } });
    assert.equal((await storage.readBuffer('a.png')).toString(), 'P');
    assert.equal(mock.count('blob'), 1, 'served by the retry; the rejected attempt never reached the blob handler');
  } finally {
    await stop();
  }
  const slow = await setup({ files: { 'b.png': Buffer.from('Q') }, client: { maxRateWaitMs: 50 } });
  try {
    await slow.storage.init();
    slow.mock.inject(/\/git\/blobs\//, 403, {
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000) },
      body: { message: 'API rate limit exceeded' },
      times: 10,
    });
    await assert.rejects(() => slow.storage.readBuffer('b.png'), (e: any) => e.status === 429 && /rate limit/i.test(e.message));
  } finally {
    await slow.stop();
  }
});

test('[github] a bad token is reported as 502 with a clear message, never 401, and never echoed', async () => {
  const { storage, stop } = await setup({ token: 'ghp_WRONG_SECRET_VALUE' });
  try {
    await assert.rejects(
      () => storage.init(),
      (e: any) => e.status === 502 && /token is invalid or expired/i.test(e.message) && !e.message.includes('ghp_WRONG_SECRET_VALUE'),
    );
  } finally {
    await stop();
  }
});

test('[github] missing repo / branch give actionable errors', async () => {
  const mock = new MockGithub();
  await mock.start();
  try {
    const mk = (repo: string, branch?: string) =>
      new GitHubStorage({
        owner: mock.owner, repo, branch,
        client: new GithubClient({ apiUrl: mock.url, token: mock.token, sleep: async () => {} }),
        rules: new Rules(DEFAULT_RULES), cache: new MemoryContentCache(1e6), log: () => {},
      });
    await assert.rejects(() => mk('nope').init(), /repository o\/nope was not found/i);
    await assert.rejects(() => mk('r', 'no-such-branch').init(), /Branch "no-such-branch" was not found/);
    await assert.rejects(() => mk('').init(), /"owner" and "repo" must be set/);
  } finally {
    await mock.stop();
  }
});

test('[github] transient 5xx is retried; persistent 5xx becomes 502', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.png': Buffer.from('P') } });
  try {
    await storage.init();
    mock.inject(/\/git\/blobs\//, 503, { times: 2 });
    assert.equal((await storage.readBuffer('a.png')).toString(), 'P');
  } finally {
    await stop();
  }
  const dead = await setup({ files: { 'b.png': Buffer.from('Q') } });
  try {
    await dead.storage.init();
    dead.mock.inject(/\/git\/blobs\//, 500, { times: 99 });
    await assert.rejects(() => dead.storage.readBuffer('b.png'), (e: any) => e.status === 502);
  } finally {
    await dead.stop();
  }
});

test('[github] the token only ever travels in the Authorization header', async () => {
  const { mock, storage, stop } = await setup({ files: { ...manyMd(35), 'a.png': Buffer.from('P') } });
  try {
    await storage.init();
    await storage.readBuffer('a.png');
    await storage.refresh();
    assert.ok(mock.urls.length > 5);
    assert.ok(mock.urls.every((u) => !u.includes(mock.token)));
  } finally {
    await stop();
  }
});

test('[github] Git LFS pointers are detected and reported (501) instead of served as content', async () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123456\n';
  const { storage, stop } = await setup({ files: { 'big.pdf': pointer, 'ok.png': Buffer.from('real') } });
  try {
    await storage.init();
    await assert.rejects(() => storage.readBuffer('big.pdf'), (e: any) => e.status === 501 && /LFS/.test(e.message) && e.message.includes('big.pdf'));
    await assert.rejects(() => storage.openFile('big.pdf'), (e: any) => e.status === 501);
    assert.equal((await storage.readBuffer('ok.png')).toString(), 'real');
  } finally {
    await stop();
  }
});

test('[github] write operations are not implemented yet and say so (501)', async () => {
  const { storage, stop } = await setup({ files: { 'a.md': '1' } });
  try {
    await storage.init();
    const is501 = (e: any) => e.status === 501;
    await assert.rejects(() => storage.writeText('a.md', 'x'), is501);
    await assert.rejects(() => storage.writeBuffer('a.bin', Buffer.from('x')), is501);
    await assert.rejects(() => storage.mkdir('d'), is501);
    await assert.rejects(() => storage.rename('a.md', 'b.md'), is501);
    await assert.rejects(() => storage.copy('a.md', 'b.md'), is501);
    await assert.rejects(() => storage.remove('a.md'), is501);
    await assert.rejects(() => storage.trash('a.md'), is501);
    await assert.rejects(() => storage.localRoot(), is501);
    assert.equal(await storage.readText('a.md'), '1', 'nothing changed');
  } finally {
    await stop();
  }
});

// ---- rules ------------------------------------------------------------------------

test('rules: first match wins, globs behave, unmatched paths are lazy', () => {
  const r = new Rules([
    { match: '.obsidian/**', mode: 'mirror', index: false },
    { match: '**/*.{md,canvas}', mode: 'mirror' },
    { match: 'media/**/*.mp4', mode: 'remote' },
    { match: '**/*.png', mode: 'lazy', index: false },
  ]);
  assert.deepEqual(r.resolve('.obsidian/plugins/x/main.js'), { mode: 'mirror', index: false });
  assert.deepEqual(r.resolve('top.md'), { mode: 'mirror', index: true });
  assert.deepEqual(r.resolve('a/b/c.CANVAS'), { mode: 'mirror', index: true }); // case-insensitive
  assert.equal(r.modeFor('media/2024/clip.mp4'), 'remote');
  assert.equal(r.modeFor('media/clip.mp4'), 'remote'); // ** may match zero directories
  assert.equal(r.modeFor('other/clip.mp4'), 'lazy'); // no rule → lazy
  assert.equal(r.modeFor('a/Pic.PNG'), 'lazy');
  assert.equal(r.modeFor('notes.md.png'), 'lazy'); // not mistaken for .md
  assert.throws(() => new Rules([{ match: 'a{b', mode: 'lazy' }]), /Unbalanced/);
  const all = new Rules([{ match: '**', mode: 'remote' }]);
  assert.equal(all.modeFor('anything/at/all.bin'), 'remote');
});

// ---- tar / sha ---------------------------------------------------------------------

test('gitBlobSha matches `git hash-object`', () => {
  for (const content of ['', 'hello\n', 'Привет, мир ✓', Buffer.from([0, 255, 10, 13, 0])]) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const expected = execFileSync('git', ['hash-object', '--stdin'], { input: buf }).toString().trim();
    assert.equal(gitBlobSha(buf), expected);
  }
});

test('tarFiles: regular files only, pax headers skipped, oversize files skipped, early exit is clean', async () => {
  const big = Buffer.alloc(5000, 7);
  const files: [string, Buffer][] = [
    ['a.txt', Buffer.from('alpha')],
    [`${'d/'.repeat(60)}long.txt`, Buffer.from('long path')],
    ['ё.txt', Buffer.from('cyrillic')],
    ['big.bin', big],
    ['empty.txt', Buffer.alloc(0)],
    ['z.txt', Buffer.from('zulu')],
  ];
  const tgz = gzipSync(buildTar('o-r-abc1234', files));

  const got: { sha?: string; size: number; hasData: boolean }[] = [];
  for await (const f of tarFiles(Readable.from(tgz, { objectMode: false }), { maxFileBytes: 1000 })) {
    got.push({ sha: f.sha, size: f.size, hasData: f.data !== undefined });
  }
  assert.deepEqual(
    got.map((g) => g.size),
    [5, 9, 8, 5000, 0, 4],
  );
  assert.deepEqual(got.map((g) => g.hasData), [true, true, true, false, true, true]);
  assert.equal(got[0].sha, gitBlobSha(Buffer.from('alpha')));
  assert.equal(got[1].sha, gitBlobSha(Buffer.from('long path')));
  assert.equal(got[3].sha, undefined);

  // chunked delivery (header split across chunks) + breaking out early must not hang or throw
  const chunks: Buffer[] = [];
  for (let i = 0; i < tgz.length; i += 37) chunks.push(tgz.subarray(i, i + 37));
  let n = 0;
  for await (const f of tarFiles(Readable.from(chunks, { objectMode: false }))) {
    n++;
    assert.ok(f.sha);
    if (n === 2) break;
  }
  assert.equal(n, 2);
});

test('[github] isIndexed follows the rules: mirror notes yes, index:false / lazy / remote no, traversal no', async () => {
  const { storage, stop } = await setup({
    files: { 'a.md': '1' },
    rules: [
      { match: '.obsidian/**', mode: 'mirror' },
      { match: 'Private/**', mode: 'remote' },
      { match: '**/*.md', mode: 'mirror' },
      { match: '**', mode: 'lazy' },
    ],
  });
  try {
    assert.equal(storage.isIndexed('a.md'), true); // mirror → indexed by default
    assert.equal(storage.isIndexed('deep/er/b.md'), true);
    assert.equal(storage.isIndexed('Private/secret.md'), false); // remote → not indexed by default
    assert.equal(storage.isIndexed('pic.png'), false); // lazy → not indexed by default
    assert.equal(storage.isIndexed('../x.md'), false);
  } finally {
    await stop();
  }
  // explicit flag overrides the mode default in both directions
  const r = new Rules([
    { match: 'Public/**', mode: 'remote', index: true },
    { match: 'Draft/**', mode: 'mirror', index: false },
  ]);
  assert.deepEqual(r.resolve('Public/x.md'), { mode: 'remote', index: true });
  assert.deepEqual(r.resolve('Draft/x.md'), { mode: 'mirror', index: false });
});
