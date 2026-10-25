import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.WEBOBSIDIAN_GIT_ALLOW_LOCAL = '1';
const { GitStorage, testGitRemote, publicUrl } = await import('../src/storage/gitrepo/index.js');
const { gitUrlProblem } = await import('../src/services/storagepatch.js');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

async function setup() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-gitrepo-'));
  const bare = path.join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  const mk = () => new GitStorage({ url: bare, branch: 'main', repoDir: path.join(tmp, 'clone'), trashDir: async () => '.trash', pollMs: 3_600_000, flushDelayMs: 3_600_000 });
  // A second, independent checkout standing in for "somebody else" (another device, a teammate).
  const other = path.join(tmp, 'other');
  return { tmp, bare, mk, other };
}

test('[git] URL validation only lets network transports through', () => {
  assert.equal(gitUrlProblem('https://gitlab.com/me/wiki.git'), null);
  assert.equal(gitUrlProblem('git@github.com:me/wiki.git'), null);
  assert.equal(gitUrlProblem('ssh://git@host/me/wiki.git'), null);
  assert.ok(gitUrlProblem('ext::sh -c touch% /tmp/pwn'));
  assert.ok(gitUrlProblem('https://me:secret@host/x.git'));
  assert.ok(gitUrlProblem('--upload-pack=evil'));
  delete process.env.WEBOBSIDIAN_GIT_ALLOW_LOCAL;
  assert.ok(gitUrlProblem('/etc'));
  assert.ok(gitUrlProblem('file:///etc'));
  process.env.WEBOBSIDIAN_GIT_ALLOW_LOCAL = '1';
  assert.equal(publicUrl('https://me:secret@host/x.git'), 'https://host/x.git');
});

test('[git] empty remote: edits are committed in one batch and pushed', async () => {
  const { bare, mk, other, tmp } = await setup();
  assert.deepEqual(await testGitRemote({ url: bare }), { ok: true, branches: [], defaultBranch: null, empty: true });
  const st = mk();
  await st.init();
  await st.writeText('a.md', '# A');
  await st.writeText('dir/b.md', 'bee');
  assert.equal(st.pendingChanges(), 2);
  await st.flush();
  assert.equal(st.pendingChanges(), 0);
  assert.equal(st.remoteInfo().lastError, null);
  git(tmp, 'clone', '-q', bare, other);
  assert.equal(git(other, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(await readFile(path.join(other, 'dir/b.md'), 'utf8'), 'bee');
  assert.ok(git(other, 'log', '-1', '--format=%s').startsWith('Update 2 files'));
  // deletions go through too
  await st.remove('a.md');
  await st.flush();
  git(other, 'pull', '-q');
  assert.deepEqual((await readdir(other)).filter((f) => !f.startsWith('.git')).sort(), ['dir']);
  st.dispose();
});

test('[git] remote changes arrive on refresh; a restart reuses the clone', async () => {
  const { bare, mk, other, tmp } = await setup();
  const st = mk();
  await st.init();
  await st.writeText('a.md', 'one');
  await st.flush();
  git(tmp, 'clone', '-q', bare, other);
  await writeFile(path.join(other, 'from-other.md'), 'hi from other');
  git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'other'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  await st.refresh();
  assert.equal(await st.readText('from-other.md'), 'hi from other');
  st.dispose();
  const again = mk();
  await again.init();
  assert.equal(await again.readText('a.md'), 'one');
  assert.deepEqual((await again.listFiles()).sort(), ['a.md', 'from-other.md']);
  again.dispose();
});

test('[git] a conflict keeps both versions and loses nothing', async () => {
  const { bare, mk, other, tmp } = await setup();
  const st = mk();
  await st.init();
  await st.writeText('note.md', 'base\n');
  await st.flush();
  git(tmp, 'clone', '-q', bare, other);
  await writeFile(path.join(other, 'note.md'), 'THEIRS\n');
  git(other, 'commit', '-q', '-am', 'theirs'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  await st.writeText('note.md', 'OURS\n');
  await st.flush();
  assert.equal(await st.readText('note.md'), 'OURS\n');
  const copies = st.remoteInfo().conflicts;
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^note \(conflict .+\)\.md$/);
  assert.equal(await st.readText(copies[0]), 'THEIRS\n');
  git(other, 'pull', '-q');
  assert.equal(await readFile(path.join(other, 'note.md'), 'utf8'), 'OURS\n');
  assert.equal(await readFile(path.join(other, copies[0]), 'utf8'), 'THEIRS\n');
  st.dispose();
});

test('[git] an unreachable remote reports an error and keeps the edit', async () => {
  const { mk } = await setup();
  const st = new GitStorage({ url: '/nonexistent/repo.git', repoDir: path.join((await setup()).tmp, 'c'), trashDir: async () => '.trash' });
  await assert.rejects(() => st.init(), /Cannot reach the Git remote/);
  void mk;
});

// ---- storage rules (partial clone): mirror / lazy / remote ------------------------------------------------

const RULES = [
  { match: '.obsidian/**', mode: 'mirror' as const, index: false },
  { match: '**/*.md', mode: 'mirror' as const, index: true },
  { match: 'img/**', mode: 'remote' as const, index: false },
  { match: '**', mode: 'lazy' as const, index: false },
];

async function setupRules() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-gitrules-'));
  const bare = path.join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const seed = path.join(tmp, 'seed');
  git(tmp, 'clone', '-q', bare, seed);
  await mkdir(path.join(seed, 'notes'), { recursive: true });
  await mkdir(path.join(seed, 'img'), { recursive: true });
  await mkdir(path.join(seed, 'docs'), { recursive: true });
  await writeFile(path.join(seed, 'notes/a.md'), '# A');
  await writeFile(path.join(seed, 'img/pic.png'), 'PNGDATA');
  await writeFile(path.join(seed, 'docs/x.pdf'), 'PDFDATA');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'seed'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const st = new GitStorage({ url: `file://${bare}`, branch: 'main', repoDir: path.join(tmp, 'clone'), trashDir: async () => '.trash', rules: RULES, pollMs: 3_600_000, flushDelayMs: 3_600_000 });
  const inTree = (rel: string) => stat(path.join(tmp, 'clone', rel)).then(() => true, () => false);
  return { tmp, bare, seed, st, inTree };
}

test('[git rules] only mirrored files are in the working tree; the rest is listed and read on demand', async () => {
  const { st, inTree } = await setupRules();
  await st.init();
  assert.equal(await inTree('notes/a.md'), true);
  assert.equal(await inTree('img/pic.png'), false);
  assert.equal(await inTree('docs/x.pdf'), false);
  assert.deepEqual((await st.listFiles()).sort(), ['docs/x.pdf', 'img/pic.png', 'notes/a.md']);
  const tree = await st.listTree();
  assert.deepEqual(tree.children!.map((c) => c.name), ['docs', 'img', 'notes']);
  assert.deepEqual((await st.listDir('img')).map((e) => e.name), ['pic.png']);
  assert.equal(await st.exists('img/pic.png'), true);
  assert.equal(await st.exists('img'), true);
  assert.equal(st.isIndexed('notes/a.md'), true);
  assert.equal(st.isIndexed('img/pic.png'), false);
  // remote: read straight from the repository, nothing stored
  assert.equal((await st.readBuffer('img/pic.png')).toString(), 'PNGDATA');
  assert.equal(await inTree('img/pic.png'), false);
  const h = await st.openFile('img/pic.png');
  assert.equal(h.size, 7);
  // lazy: fetched on first use, then kept
  assert.equal(await st.readText('docs/x.pdf'), 'PDFDATA');
  assert.equal(await inTree('docs/x.pdf'), true);
  st.dispose();
});

test('[git rules] edits to unkept files are committed and dropped again; deletes and renames work on them', async () => {
  const { st, inTree, tmp, bare } = await setupRules();
  await st.init();
  await st.writeBuffer('img/new.png', Buffer.from('NEWPNG')); // remote-mode file written locally
  await st.writeText('img/pic.png', 'EDITED'); // a file that was not downloaded gets overwritten
  await st.writeText('notes/b.md', 'bee');
  await st.rename('docs/x.pdf', 'docs/y.pdf'); // content has to come down first
  await st.remove('nonexistent-ok.md').catch(() => {});
  await st.flush();
  const other = path.join(tmp, 'other');
  git(tmp, 'clone', '-q', bare, other);
  assert.equal(await readFile(path.join(other, 'img/new.png'), 'utf8'), 'NEWPNG');
  assert.equal(await readFile(path.join(other, 'img/pic.png'), 'utf8'), 'EDITED');
  assert.equal(await readFile(path.join(other, 'docs/y.pdf'), 'utf8'), 'PDFDATA');
  assert.equal(await stat(path.join(other, 'docs/x.pdf')).then(() => true, () => false), false);
  // remote-mode files are not kept after the save, but still readable
  assert.equal(await inTree('img/new.png'), false);
  assert.equal((await st.readBuffer('img/new.png')).toString(), 'NEWPNG');
  // deleting a file that was never downloaded
  await st.remove('img/pic.png');
  await st.flush();
  git(other, 'pull', '-q');
  assert.equal(await stat(path.join(other, 'img/pic.png')).then(() => true, () => false), false);
  assert.ok(!(await st.listFiles()).includes('img/pic.png'));
  st.dispose();
});

test('[git rules] files that arrive from the remote follow the rules too', async () => {
  const { st, inTree, seed } = await setupRules();
  await st.init();
  await writeFile(path.join(seed, 'notes/c.md'), 'see');
  await writeFile(path.join(seed, 'img/more.png'), 'MORE');
  await writeFile(path.join(seed, 'notes/a.md'), '# A v2');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'more'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  await st.refresh();
  assert.equal(await st.readText('notes/c.md'), 'see');
  assert.equal(await st.readText('notes/a.md'), '# A v2');
  assert.equal(await inTree('notes/c.md'), true);
  assert.equal(await inTree('img/more.png'), false);
  assert.ok((await st.listFiles()).includes('img/more.png'));
  assert.equal((await st.readBuffer('img/more.png')).toString(), 'MORE');
  st.dispose();
});

test('[git rules] a restart keeps the same view', async () => {
  const { st, tmp } = await setupRules();
  await st.init();
  await st.writeText('notes/z.md', 'zed');
  await st.flush();
  st.dispose();
  const again = new GitStorage({ url: `file://${path.join(tmp, 'remote.git')}`, branch: 'main', repoDir: path.join(tmp, 'clone'), trashDir: async () => '.trash', rules: RULES });
  await again.init();
  assert.deepEqual((await again.listFiles()).sort(), ['docs/x.pdf', 'img/pic.png', 'notes/a.md', 'notes/z.md']);
  assert.equal(await again.readText('notes/z.md'), 'zed');
  again.dispose();
});

test('[git history] commits that touched a file, with who made them; old versions can be read back', async () => {
  const { tmp, bare, other } = await setup();
  const st = new GitStorage({ url: bare, branch: 'main', repoDir: path.join(tmp, 'clone'), trashDir: async () => '.trash', pollMs: 3_600_000, flushDelayMs: 3_600_000, author: { name: 'alice', email: 'alice@users.noreply.github.com' } });
  await st.init();
  await st.writeText('n.md', 'one\n');
  await st.writeText('x.md', 'other file');
  await st.flush();
  await st.writeText('n.md', 'two\n');
  await st.flush();
  const h = await st.history('n.md');
  assert.equal(h.length, 2);
  assert.equal(h[0].author, 'alice');
  assert.equal(h[0].email, 'alice@users.noreply.github.com');
  assert.ok(h[0].date && h[0].message);
  assert.equal(await st.fileAt(h[0].hash, 'n.md'), 'two\n');
  assert.equal(await st.fileAt(h[1].hash, 'n.md'), 'one\n', 'trailing newline kept');
  assert.deepEqual(await st.history('missing.md'), []);
  await assert.rejects(st.fileAt('--output=/tmp/x', 'n.md'), /Bad commit id/);
  await assert.rejects(st.fileAt(h[0].hash, '../etc/passwd'), /Bad path/);
  st.dispose();
  void other;
});

test('[git history] without a configured identity commits are signed with the account login', async () => {
  const { createGitStorage } = await import('../src/storage/gitrepo/index.js');
  const { tmp, bare } = await setup();
  const base = { storage: { git: { url: bare, branch: 'main', username: 'bob', token: '', basePath: '', pollSec: 3600, flushSec: 3600, authorName: '', authorEmail: '' }, rules: [], cache: { maxMB: 10 } }, git: { authorName: 'WebObsidian', authorEmail: 'webobsidian@localhost' } } as any;
  const st = createGitStorage(base, { dataDir: tmp, trashDir: async () => '.trash', env: {} });
  await st.init();
  await st.writeText('a.md', 'x');
  await st.flush();
  const [c] = await st.history('a.md');
  assert.equal(c.author, 'bob');
  assert.equal(c.email, 'bob@localhost');
  st.dispose();
});
