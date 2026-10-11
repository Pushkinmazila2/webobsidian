/**
 * Live check of the GitHub storage driver against a REAL repository.
 * READ-ONLY: only GET requests are made, nothing is written.
 *
 *   WEBOBSIDIAN_GITHUB_TOKEN=github_pat_… \
 *     node --import tsx test/github.live.ts owner/repo [basePath] [branch]
 *
 * Prints a JSON report; the token is never printed.
 */
import assert from 'node:assert/strict';
import { GithubClient, GitHubStorage, MemoryContentCache, Rules, gitBlobSha } from '../src/storage/github/index.js';
import type { StorageEvent } from '../src/storage/types.js';

const [slug, basePathArg = '', branchArg = ''] = process.argv.slice(2);
const token = process.env.WEBOBSIDIAN_GITHUB_TOKEN;
if (!slug?.includes('/') || !token) {
  console.error('usage: WEBOBSIDIAN_GITHUB_TOKEN=… node --import tsx test/github.live.ts owner/repo [basePath] [branch]');
  process.exit(2);
}
const [owner, repo] = slug.split('/');
const basePath = basePathArg.replace(/^\/+|\/+$/g, '');

// Count and time every API request by kind.
const stats: Record<string, { n: number; ms: number }> = {};
const methods = new Set<string>();
const countingFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const kind =
    /\/git\/trees\//.test(url) ? (url.includes('recursive') ? 'tree-recursive' : 'tree')
    : /\/git\/blobs\//.test(url) ? 'blob'
    : /\/tarball\//.test(url) ? 'tarball'
    : /\/git\/ref\//.test(url) ? 'ref'
    : /\/git\/commits\//.test(url) ? 'commit'
    : /codeload/.test(url) ? 'codeload'
    : 'repo';
  methods.add((init?.method ?? 'GET').toUpperCase());
  const t0 = performance.now();
  const res = await fetch(input, init);
  (stats[kind] ??= { n: 0, ms: 0 }).n++;
  stats[kind].ms += Math.round(performance.now() - t0);
  return res;
};

const client = new GithubClient({ apiUrl: 'https://api.github.com', token, fetchImpl: countingFetch });
const storage = new GitHubStorage({
  owner, repo, branch: branchArg || undefined, basePath, client,
  rules: new Rules([
    { match: '.obsidian/**', mode: 'mirror' },
    { match: '**/*.{md,markdown,canvas}', mode: 'mirror' },
    { match: '**', mode: 'lazy' },
  ]),
  cache: new MemoryContentCache(256 * 1024 * 1024),
  pollMs: 1000,
  log: () => {},
});

const report: Record<string, unknown> = {};
const snap = () => JSON.parse(JSON.stringify(stats));

// ---- init -------------------------------------------------------------------------
let t0 = performance.now();
await storage.init();
report.init = { ms: Math.round(performance.now() - t0), requests: snap(), status: { ...storage.status(), rate: undefined } };

// ---- listing ----------------------------------------------------------------------
const files = await storage.listFiles();
const md = files.filter((f) => /\.md$/i.test(f));
report.listing = {
  files: files.length,
  markdown: md.length,
  nonAsciiPaths: files.filter((f) => /[^\x00-\x7f]/.test(f)).length,
  treeRootName: (await storage.listTree()).name,
};

// ---- integrity: every file's bytes must hash to the sha git has for it ----------------
// Independent tree fetch (not via the driver) → expected shas.
const branch = storage.status().branch;
const head = await client.getBranchSha(owner, repo, branch);
let treeSha = await client.getCommitTreeSha(owner, repo, head);
for (const seg of basePath ? basePath.split('/') : []) {
  treeSha = (await client.getTree(owner, repo, treeSha, false)).tree.find((e) => e.path === seg && e.type === 'tree')!.sha;
}
const expected = new Map((await client.getTree(owner, repo, treeSha, true)).tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));

const before = snap();
t0 = performance.now();
let mismatches = 0;
let checkedMd = 0;
for (const f of md) {
  const buf = await storage.readBuffer(f);
  if (gitBlobSha(buf) !== expected.get(f)) mismatches++;
  checkedMd++;
}
const mdReadMs = Math.round(performance.now() - t0);
const blobsDuringMdReads = (stats.blob?.n ?? 0) - (before.blob?.n ?? 0);
report.mirrorReads = { notesChecked: checkedMd, shaMismatches: mismatches, ms: mdReadMs, blobRequestsWhileReading: blobsDuringMdReads };
assert.equal(mismatches, 0, 'cached content differs from what git holds');

// ---- lazy files: first read hits the API, the second doesn't ----------------------------
const others = files.filter((f) => !/\.(md|markdown|canvas)$/i.test(f));
const lazy: Record<string, unknown>[] = [];
for (const f of others.slice(0, 3)) {
  const b0 = stats.blob?.n ?? 0;
  const a = performance.now();
  const buf = await storage.readBuffer(f);
  const first = Math.round(performance.now() - a);
  const b1 = stats.blob?.n ?? 0;
  const c = performance.now();
  await storage.readBuffer(f);
  const second = Math.round(performance.now() - c);
  assert.equal(gitBlobSha(buf), expected.get(f));
  lazy.push({ file: f.split('/').pop(), bytes: buf.length, firstMs: first, secondMs: second, blobRequests: [b1 - b0, (stats.blob?.n ?? 0) - b1] });
}
report.lazyReads = lazy;

// ---- range + handle on a lazy binary ----------------------------------------------------
if (others[0]) {
  const h = await storage.openFile(others[0]);
  const chunks: Buffer[] = [];
  for await (const c of h.createReadStream({ start: 0, end: 7 })) chunks.push(c as Buffer);
  report.range = { file: others[0].split('/').pop(), size: h.size, first8: Buffer.concat(chunks).toString('hex') };
}

// ---- guards -------------------------------------------------------------------------------
const guards: Record<string, string> = {};
for (const [label, fn] of Object.entries({
  traversal: () => storage.readText('../x.md'),
  dotGit: () => storage.readText('.git/config'),
  write: () => storage.writeText('x.md', 'x'),
  missing: () => storage.readText('definitely-not-here.md'),
})) {
  try { await fn(); guards[label] = 'NO ERROR (!)'; } catch (e: any) { guards[label] = `${e.status}`; }
}
report.guards = guards;

// ---- idle polling must be free ---------------------------------------------------------------
const events: StorageEvent[] = [];
const rateBefore = client.rate?.remaining;
const refBefore = stats.ref?.n ?? 0;
const treeBefore = (stats['tree-recursive']?.n ?? 0) + (stats.tree?.n ?? 0);
const stop = await storage.watch((e) => void events.push(e));
await new Promise((r) => setTimeout(r, 4500));
await stop();
report.idlePolling = {
  polls: (stats.ref?.n ?? 0) - refBefore,
  treeRequests: (stats['tree-recursive']?.n ?? 0) + (stats.tree?.n ?? 0) - treeBefore,
  rateLimitSpent: rateBefore !== undefined && client.rate ? rateBefore - client.rate.remaining : 'n/a',
  eventsEmitted: events.length,
};

report.totals = { requests: snap(), httpMethodsUsed: [...methods], rateLimitRemaining: client.rate?.remaining };
const out = JSON.stringify(report, null, 2);
assert.ok(!out.includes(token), 'token leaked into the report');
console.log(out);
assert.deepEqual([...methods], ['GET'], 'live check must be read-only');
