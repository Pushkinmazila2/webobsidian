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
import { runStorageContract } from './storage.contract.js';
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
  flushDelayMs?: number;
  flushMaxWaitMs?: number;
  flushMaxBytes?: number;
  flushRetryMaxMs?: number;
  holdMatch?: string[];
  holdDelayMs?: number;
  holdMaxWaitMs?: number;
  author?: { name: string; email: string };
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
    flushDelayMs: over.flushDelayMs ?? 3_600_000, // tests flush explicitly unless they say otherwise
    flushMaxWaitMs: over.flushMaxWaitMs ?? 3_600_000,
    flushMaxBytes: over.flushMaxBytes,
    flushRetryMaxMs: over.flushRetryMaxMs,
    holdMatch: over.holdMatch,
    holdDelayMs: over.holdDelayMs,
    holdMaxWaitMs: over.holdMaxWaitMs,
    author: over.author,
    tarballThreshold: over.tarballThreshold,
    log: () => {},
  });
  return { mock, storage, cache, client, stop: () => mock.stop() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for condition');
    await sleep(10);
  }
}
const manyMd = (n: number): SeedFiles => Object.fromEntries(Array.from({ length: n }, (_, i) => [`notes/n${i}.md`, `note ${i}`]));

// ---- shared write contract, GitHub driver (overlay only; flushing is tested below) --

runStorageContract('github', async () => {
  const { storage, stop } = await setup();
  return { storage, cleanup: async () => { await storage.flush(); await stop(); } };
});

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

test('[github] localRoot is refused (no folder on disk)', async () => {
  const { storage, stop } = await setup({ files: { 'a.md': '1' } });
  try {
    await storage.init();
    await assert.rejects(() => storage.localRoot(), (e: any) => e.status === 501);
  } finally {
    await stop();
  }
});

// ---- writing: write-behind overlay, one commit per flush -----------------------------

test('[github] writes are visible at once, cost nothing until flushed, then land as ONE commit', async () => {
  const { mock, storage, stop } = await setup({ files: { 'keep.md': 'k' } });
  try {
    await storage.init();
    const before = mock.count('commit-create');
    await storage.writeText('new/a.md', 'A');
    await storage.writeText('new/b.md', 'B');
    await storage.writeText('keep.md', 'K2');
    await storage.writeBuffer('img/p.png', Buffer.from([1, 2, 3]));
    assert.equal(await storage.readText('new/a.md'), 'A');
    assert.equal(storage.pendingChanges(), 4);
    assert.equal(mock.count('commit-create'), before, 'nothing was sent yet');
    assert.equal(mock.count('blob-create'), 0);

    await storage.flush();
    assert.equal(storage.pendingChanges(), 0);
    assert.equal(mock.apiCommits.length, 1, 'one commit for the whole batch');
    const c = mock.apiCommits[0];
    assert.deepEqual(c.changed, ['img/p.png', 'keep.md', 'new/a.md', 'new/b.md']);
    assert.match(c.message, /^Update 4 files \(3 added, 1 modified\)/);
    assert.equal(mock.fileAtHead('keep.md')!.toString(), 'K2');
    assert.deepEqual([...mock.fileAtHead('img/p.png')!], [1, 2, 3]);
    assert.equal(mock.count('blob-create'), 4);
    assert.equal(await storage.readText('new/b.md'), 'B', 'still readable after the swap to the committed snapshot');
  } finally {
    await stop();
  }
});

test('[github] a flush with nothing to do, or only no-op writes, sends nothing', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'same' } });
  try {
    await storage.init();
    await storage.flush();
    await storage.writeText('a.md', 'same'); // identical content
    assert.equal(storage.pendingChanges(), 0, 'rewriting identical content is not a change');
    await storage.writeText('tmp.md', 'x');
    await storage.remove('tmp.md'); // created and deleted before ever being saved
    assert.equal(storage.pendingChanges(), 0);
    await storage.flush();
    assert.equal(mock.apiCommits.length, 0);
    assert.equal(mock.count('blob-create'), 0);
  } finally {
    await stop();
  }
});

test('[github] repeated edits of one file are saved as one blob', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': '0' } });
  try {
    await storage.init();
    for (let i = 1; i <= 20; i++) await storage.writeText('a.md', `v${i}`);
    await storage.flush();
    assert.equal(mock.count('blob-create'), 1);
    assert.equal(mock.apiCommits.length, 1);
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'v20');
    assert.equal(mock.apiCommits[0].message.split('\n')[0], 'Update a.md');
  } finally {
    await stop();
  }
});

test('[github] rename and copy reuse existing blobs: no content is uploaded', async () => {
  const { mock, storage, stop } = await setup({ files: { 'dir/a.md': 'AAA', 'dir/b.md': 'BBB', 'x.md': 'X' } });
  try {
    await storage.init();
    await storage.rename('dir', 'moved');
    await storage.copy('x.md', 'x copy.md');
    await storage.flush();
    assert.equal(mock.count('blob-create'), 0, 'blobs already exist in the repo');
    assert.deepEqual(mock.filesAtHead(), ['moved/a.md', 'moved/b.md', 'x copy.md', 'x.md']);
    assert.equal(mock.fileAtHead('moved/b.md')!.toString(), 'BBB');
  } finally {
    await stop();
  }
});

test('[github] new content identical to a blob the repo already has is not uploaded again', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'shared body' } });
  try {
    await storage.init();
    await storage.writeText('b.md', 'shared body');
    await storage.writeText('c.md', 'fresh body');
    await storage.flush();
    assert.equal(mock.count('blob-create'), 1, 'only the genuinely new content is uploaded');
    assert.equal(mock.fileAtHead('b.md')!.toString(), 'shared body');
  } finally {
    await stop();
  }
});

test('[github] empty folders survive via .gitkeep, which stays hidden', async () => {
  const { mock, storage, stop } = await setup();
  try {
    await storage.init();
    await storage.mkdir('Inbox/Empty');
    await storage.flush();
    assert.deepEqual(mock.filesAtHead(), ['Inbox/Empty/.gitkeep']);
    assert.equal(await storage.exists('Inbox/Empty'), true);
    assert.deepEqual(await storage.listFiles(), []);
    await storage.writeText('Inbox/Empty/n.md', 'x'); // placeholder no longer needed but harmless
    await storage.flush();
    assert.equal(mock.fileAtHead('Inbox/Empty/n.md')!.toString(), 'x');
  } finally {
    await stop();
  }
});

test('[github] basePath: commits only touch files under the vault folder', async () => {
  const { mock, storage, stop } = await setup({ basePath: 'docs', files: { 'docs/a.md': '1', 'README.md': 'outside' } });
  try {
    await storage.init();
    await storage.writeText('b.md', '2');
    await storage.rename('a.md', 'sub/a.md');
    await storage.flush();
    assert.deepEqual(mock.filesAtHead(), ['README.md', 'docs/b.md', 'docs/sub/a.md']);
    assert.equal(mock.fileAtHead('README.md')!.toString(), 'outside');
  } finally {
    await stop();
  }
});

test('[github] author is sent only when configured', async () => {
  const a = await setup({ author: { name: 'Me', email: 'me@x.org' } });
  const b = await setup();
  try {
    for (const t of [a, b]) {
      await t.storage.init();
      await t.storage.writeText('n.md', '1');
      await t.storage.flush();
    }
    assert.deepEqual(a.mock.apiCommits[0].author, { name: 'Me', email: 'me@x.org' });
    assert.equal(b.mock.apiCommits[0].author, undefined);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('[github] automatic flush after the quiet period; max-wait caps a never-quiet editor', async () => {
  const { mock, storage, stop } = await setup({ flushDelayMs: 40, flushMaxWaitMs: 150 });
  try {
    await storage.init();
    await storage.writeText('a.md', '1');
    await until(() => mock.apiCommits.length === 1 && storage.pendingChanges() === 0);

    // keep writing every 20ms: the 40ms quiet period never elapses, the 150ms cap must fire
    const t0 = Date.now();
    let i = 0;
    while (mock.apiCommits.length < 2 && Date.now() - t0 < 6000) {
      await storage.writeText('busy.md', `v${i++}`);
      await sleep(20);
    }
    assert.ok(mock.apiCommits.length >= 2, 'flushed despite continuous edits');
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    await storage.flush().catch(() => {});
    await stop();
  }
});

test('[github] held paths (plugins) wait longer: notes are saved on time and alone, plugin changes go later', async () => {
  const { mock, storage, stop } = await setup({ flushDelayMs: 30, flushMaxWaitMs: 5000, holdMatch: ['.obsidian/**'], holdDelayMs: 400, holdMaxWaitMs: 5000 });
  try {
    await storage.init();
    await storage.writeText('.obsidian/community-plugins.json', '["a"]');
    await storage.writeText('.obsidian/plugins/a/data.json', '{"x":1}');
    await storage.writeText('Note.md', 'hello');
    assert.equal(storage.remoteInfo().held, 2);
    await until(() => mock.apiCommits.length === 1 && storage.pendingChanges() === 2);
    assert.deepEqual(mock.apiCommits[0].changed, ['Note.md'], 'the note went out without the held plugin files');
    assert.equal(storage.remoteInfo().held, 2, 'plugin changes are still waiting');
    // reads see them meanwhile
    assert.equal(await storage.readText('.obsidian/plugins/a/data.json'), '{"x":1}');
    await until(() => mock.apiCommits.length === 2 && storage.pendingChanges() === 0);
    assert.deepEqual(mock.apiCommits[1].changed, ['.obsidian/community-plugins.json', '.obsidian/plugins/a/data.json'], 'held files saved together, later');
  } finally {
    await stop();
  }
});

test('[github] a burst of plugin writes becomes one commit; the quiet period restarts on each write', async () => {
  const { mock, storage, stop } = await setup({ flushDelayMs: 20, holdMatch: ['.obsidian/**'], holdDelayMs: 150, holdMaxWaitMs: 60_000 });
  try {
    await storage.init();
    for (let i = 0; i < 8; i++) {
      await storage.writeText('.obsidian/plugins/a/data.json', `{"n":${i}}`);
      await sleep(60); // shorter than the hold delay → keeps postponing
    }
    assert.equal(mock.apiCommits.length, 0, 'still held while the plugin keeps writing');
    await until(() => mock.apiCommits.length === 1 && storage.pendingChanges() === 0);
    assert.equal(mock.fileAtHead('.obsidian/plugins/a/data.json')!.toString(), '{"n":7}');
    assert.equal(mock.apiCommits.length, 1);
  } finally {
    await stop();
  }
});

test('[github] hold max-wait caps a plugin that never stops writing', async () => {
  const { mock, storage, stop } = await setup({ holdMatch: ['.obsidian/**'], holdDelayMs: 300, holdMaxWaitMs: 400 });
  try {
    await storage.init();
    const t0 = Date.now();
    let i = 0;
    while (mock.apiCommits.length < 1 && Date.now() - t0 < 6000) {
      await storage.writeText('.obsidian/plugins/a/data.json', `{"n":${i++}}`);
      await sleep(50);
    }
    assert.ok(mock.apiCommits.length >= 1, 'saved despite continuous writes');
  } finally {
    await storage.flush().catch(() => {});
    await stop();
  }
});

test('[github] an explicit flush (Sync, shutdown) saves held changes too, in one commit', async () => {
  const { mock, storage, stop } = await setup({ holdMatch: ['.obsidian/**'], holdDelayMs: 3_600_000, holdMaxWaitMs: 3_600_000 });
  try {
    await storage.init();
    await storage.writeText('.obsidian/plugins/a/data.json', '{}');
    await storage.writeText('Note.md', 'n');
    await storage.flush();
    assert.equal(mock.apiCommits.length, 1);
    assert.deepEqual(mock.apiCommits[0].changed, ['.obsidian/plugins/a/data.json', 'Note.md']);
    assert.equal(storage.remoteInfo().held, 0);
  } finally {
    await stop();
  }
});

test('[github] without holdMatch nothing is held (notes behaviour unchanged)', async () => {
  const { mock, storage, stop } = await setup({ flushDelayMs: 20 });
  try {
    await storage.init();
    await storage.writeText('.obsidian/plugins/a/data.json', '{}');
    await until(() => mock.apiCommits.length === 1);
    assert.equal(storage.remoteInfo().held, 0);
  } finally {
    await stop();
  }
});

test('[github] buffering past flushMaxBytes commits immediately', async () => {
  const { mock, storage, stop } = await setup({ flushMaxBytes: 1000 });
  try {
    await storage.init();
    await storage.writeBuffer('big.bin', Buffer.alloc(2000, 7));
    await until(() => mock.apiCommits.length === 1 && storage.pendingChanges() === 0);
    assert.equal(mock.fileAtHead('big.bin')!.length, 2000);
  } finally {
    await stop();
  }
});

test('[github] writes emit exactly one event each; the commit round trip does not echo them back', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': '1' }, pollMs: 15 });
  try {
    await storage.init();
    const events: StorageEvent[] = [];
    const unwatch = await storage.watch((e) => void events.push(e));
    await storage.writeText('a.md', '2');
    await storage.writeText('n/b.md', 'b');
    await storage.remove('a.md');
    const own = events.map((e) => `${e.type}:${e.path}`);
    assert.ok(own.includes('change:a.md') && own.includes('add:n/b.md') && own.includes('unlink:a.md'), own.join(','));
    const n = events.length;
    await storage.flush();
    await sleep(120); // several polls
    assert.equal(events.length, n, `no echo after flushing: ${events.slice(n).map((e) => e.type + ':' + e.path)}`);
    await unwatch();
    assert.equal(mock.headSha, mock.apiCommits[0].sha);
  } finally {
    await stop();
  }
});

test('[github] a remote commit on other files is merged under our unsaved changes', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'a', 'b.md': 'b' } });
  try {
    await storage.init();
    await storage.writeText('a.md', 'a-ours');
    mock.commit({ 'b.md': 'b-theirs', 'c.md': 'c-theirs' });
    await storage.flush();
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'a-ours');
    assert.equal(mock.fileAtHead('b.md')!.toString(), 'b-theirs', 'their change is kept');
    assert.equal(mock.fileAtHead('c.md')!.toString(), 'c-theirs');
    assert.equal(await storage.readText('b.md'), 'b-theirs');
    assert.equal(mock.apiCommits[0].parents[0], mock.apiCommits[0].parents[0]);
    assert.deepEqual(mock.apiCommits[0].changed, ['a.md'], 'our commit only contains our change');
  } finally {
    await stop();
  }
});

test('[github] conflict: both sides edited the same file → remote kept, ours saved as a "(conflict …)" copy', async () => {
  const { mock, storage, stop } = await setup({ files: { 'Note.md': 'base' } });
  try {
    await storage.init();
    await storage.writeText('Note.md', 'ours');
    mock.commit({ 'Note.md': 'theirs' });
    await storage.flush();
    assert.equal(mock.fileAtHead('Note.md')!.toString(), 'theirs');
    const copies = mock.filesAtHead().filter((p) => /^Note \(conflict .+\)\.md$/.test(p));
    assert.equal(copies.length, 1, mock.filesAtHead().join(','));
    assert.equal(mock.fileAtHead(copies[0])!.toString(), 'ours');
    assert.equal(await storage.readText('Note.md'), 'theirs');
    assert.equal(await storage.readText(copies[0]), 'ours');
    assert.equal(storage.remoteInfo().conflicts.length, 1);
  } finally {
    await stop();
  }
});

test('[github] conflict: we deleted a file the remote edited → their edit survives', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'base', 'z.md': 'z' } });
  try {
    await storage.init();
    await storage.remove('a.md');
    await storage.writeText('z.md', 'z2');
    mock.commit({ 'a.md': 'theirs' });
    await storage.flush();
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'theirs');
    assert.equal(mock.fileAtHead('z.md')!.toString(), 'z2');
    assert.equal(await storage.readText('a.md'), 'theirs');
  } finally {
    await stop();
  }
});

test('[github] conflict: remote deleted what we edited → ours is kept; both deleted → just gone', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'base', 'b.md': 'base' } });
  try {
    await storage.init();
    await storage.writeText('a.md', 'ours');
    await storage.remove('b.md');
    mock.commit({ 'a.md': null, 'b.md': null });
    await storage.flush();
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'ours');
    assert.equal(mock.fileAtHead('b.md'), undefined);
    assert.equal(storage.pendingChanges(), 0);
  } finally {
    await stop();
  }
});

test('[github] identical content arriving from the remote is not a conflict', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'base' } });
  try {
    await storage.init();
    await storage.writeText('a.md', 'same');
    mock.commit({ 'a.md': 'same' });
    await storage.flush();
    assert.deepEqual(mock.filesAtHead(), ['a.md']);
    assert.equal(mock.apiCommits.length, 0, 'nothing left to commit');
  } finally {
    await stop();
  }
});

test('[github] branch moves between our commit and the ref update → re-read, re-apply, retry', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'a', 'b.md': 'b' } });
  try {
    await storage.init();
    await storage.writeText('a.md', 'a-ours');
    mock.racing = { 'b.md': 'b-theirs' }; // lands just before our ref update is evaluated
    await storage.flush();
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'a-ours');
    assert.equal(mock.fileAtHead('b.md')!.toString(), 'b-theirs');
    assert.equal(mock.count('ref-update'), 2, 'first attempt rejected, second accepted');
    assert.equal(storage.pendingChanges(), 0);
  } finally {
    await stop();
  }
});

test('[github] failed flush keeps the changes, reports the problem, and a later flush succeeds', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'a' }, flushDelayMs: 3_600_000 });
  try {
    await storage.init();
    await storage.writeText('a.md', 'edited');
    mock.inject(/\/git\/trees$/, 403, { body: { message: 'Resource not accessible by personal access token' }, times: 1 });
    await assert.rejects(() => storage.flush(), (e: any) => e.status === 502, 'GitHub 403 maps to 502, never 401');
    assert.equal(storage.pendingChanges(), 1, 'nothing was lost');
    assert.equal(await storage.readText('a.md'), 'edited');
    assert.match(storage.remoteInfo().lastError ?? '', /Contents: Read and write/);
    await storage.flush();
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'edited');
    assert.ok(!storage.remoteInfo().lastError);
  } finally {
    await stop();
  }
});

test('[github] a failing flush is retried automatically in the background', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'a' }, flushDelayMs: 10, flushRetryMaxMs: 30 });
  try {
    await storage.init();
    mock.inject(/\/git\/commits$/, 500, { times: 1_000_000 }); // 5xx is retried inside the client too
    await storage.writeText('a.md', 'edited');
    await sleep(120);
    assert.equal(mock.apiCommits.length, 0);
    assert.equal(storage.pendingChanges(), 1);
    mock.failures_clear();
    await until(() => mock.apiCommits.length === 1 && mock.headSha === mock.apiCommits[0].sha, 15_000);
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'edited');
  } finally {
    await stop();
  }
});

test('[github] edits made while a flush is in flight are not lost; flush() drains them in a follow-up commit', async () => {
  const { mock, storage, stop } = await setup({ files: { 'a.md': 'a' } });
  try {
    await storage.init();
    await storage.writeText('a.md', 'first');
    const slow = new Promise<void>((r) => mock.onNext('blob-create', async () => { await storage.writeText('a.md', 'second'); r(); }));
    const f = storage.flush();
    await slow;
    await f;
    assert.equal(await storage.readText('a.md'), 'second');
    assert.equal(storage.pendingChanges(), 0, 'flush() drains edits that arrived while it ran');
    assert.equal(mock.fileAtHead('a.md')!.toString(), 'second');
    assert.equal(mock.apiCommits.length, 2, 'the in-flight batch, then the newer edit');
    assert.equal(mock.apiCommits[0].changed.length, 1);
  } finally {
    await stop();
  }
});

test('[github] trash round trip is committed; restore of a not-yet-committed trash is a no-op in git', async () => {
  const { mock, storage, stop } = await setup({ files: { 'n.md': 'body' } });
  try {
    await storage.init();
    const t = await storage.trash('n.md');
    assert.equal(t.startsWith('.trash/'), true);
    await storage.flush();
    assert.deepEqual(mock.filesAtHead(), [t]);
    const back = await storage.restoreFromTrash(t);
    assert.equal(back, 'n.md');
    await storage.flush();
    assert.deepEqual(mock.filesAtHead(), ['n.md']);
    await storage.trash('n.md');
    await storage.restoreFromTrash(back.replace('n.md', '.trash/n.md'));
    assert.equal(storage.pendingChanges(), 0, 'trash + restore before any flush cancels out');
  } finally {
    await stop();
  }
});

test('[github] oversize files are refused up-front (413) instead of failing at commit time', async () => {
  const { mock, storage, stop } = await setup({});
  try {
    (storage as any).o.maxBlobBytes = 10;
    await storage.init();
    await assert.rejects(() => storage.writeBuffer('big.bin', Buffer.alloc(11)), (e: any) => e.status === 413);
    await storage.writeBuffer('ok.bin', Buffer.alloc(10));
    await storage.flush();
    assert.deepEqual(mock.filesAtHead(), ['ok.bin']);
  } finally {
    await stop();
  }
});

test('[github] a file/folder clash is rejected immediately (409)', async () => {
  const { storage, stop } = await setup({ files: { 'a.md': '1', 'd/x.md': '2' } });
  try {
    await storage.init();
    await assert.rejects(() => storage.writeText('a.md/child.md', 'x'), (e: any) => e.status === 409 || e.status === 400);
    await assert.rejects(() => storage.writeText('d', 'x'), (e: any) => e.status === 409 || e.status === 400);
  } finally {
    await stop();
  }
});

test('[github] written files obey the rules: lazy content is not kept after saving, mirror content is', async () => {
  const cache = new MemoryContentCache(64 * 1024 * 1024);
  const { mock, storage, stop } = await setup({ cache });
  try {
    await storage.init();
    await storage.writeText('n.md', 'mirror body');
    await storage.writeBuffer('a.png', Buffer.from('lazy body'));
    await storage.flush();
    assert.equal(await cache.has(gitBlobSha(Buffer.from('mirror body'))), true);
    const reads = mock.count('blob');
    assert.equal((await storage.readText('n.md')), 'mirror body');
    assert.equal(mock.count('blob'), reads, 'mirror file served from cache');
    assert.equal((await storage.readBuffer('a.png')).toString(), 'lazy body');
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

// ---- version history ----------------------------------------------------------

test('[github] file history lists the commits that touched the file with the GitHub login, and reads old versions', async () => {
  const { mock, storage, stop } = await setup({ files: { 'n.md': 'one' }, basePath: undefined });
  try {
    mock.loginFor = (a) => (a?.email === 'alice@example.com' ? 'alice-gh' : 'token-owner');
    await storage.init();
    const first = mock.commit({ 'other.md': 'x' }); // does not touch n.md
    await storage.refresh();
    await storage.writeText('n.md', 'two');
    await storage.flush();
    const h = await storage.history('n.md');
    assert.equal(h.length, 2, 'the seed commit and our edit; the unrelated commit is skipped');
    assert.equal(h[0].login, 'token-owner');
    assert.ok(h[0].date);
    assert.notEqual(h[0].hash, first);
    assert.equal(await storage.fileAt(h[0].hash, 'n.md'), 'two');
    assert.equal(await storage.fileAt(h[1].hash, 'n.md'), 'one');
    await assert.rejects(storage.fileAt('../x', 'n.md'), /Bad commit id/);
  } finally { await storage.flush().catch(() => {}); await stop(); }
});
