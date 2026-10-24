import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
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
