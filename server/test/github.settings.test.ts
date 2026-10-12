import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// config.ts reads DATA_DIR at import time, so set it before importing anything that uses it.
const dataDir = await mkdtemp(path.join(tmpdir(), 'wobs-settings-'));
process.env.DATA_DIR = dataDir;
delete process.env.WEBOBSIDIAN_GITHUB_TOKEN;
const { loadSettings, updateSettings, redactSettings } = await import('../src/services/settings.js');
const vault = await import('../src/services/vault.js');

test('[settings] storage defaults: local driver, in-memory cache, sensible rules', async () => {
  const s = await loadSettings();
  assert.equal(s.storage.driver, 'local');
  assert.equal(s.storage.cache.persist, 'memory');
  assert.equal(s.storage.github.pollSec, 30);
  assert.deepEqual(s.storage.rules.map((r) => r.mode), ['mirror', 'mirror', 'lazy']);
  assert.equal(vault.getStorage().kind, 'local');
});

test('[settings] the GitHub token is masked in anything sent to the client', async () => {
  const secret = 'github_pat_SUPER_SECRET_123';
  const s = await updateSettings((d) => {
    d.storage.github.token = secret;
    d.git.token = 'another-secret';
  });
  const out = JSON.stringify(redactSettings(s));
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes('another-secret'));
  assert.equal(redactSettings(s).storage.github.token, '••••••••');
  await updateSettings((d) => {
    d.storage.github.token = '';
  });
  assert.equal(redactSettings(await loadSettings()).storage.github.token, '');
});

test('[vault] driver is chosen from settings; a GitHub vault without a token fails loudly', async () => {
  await updateSettings((d) => {
    d.storage.driver = 'github';
    d.storage.github.owner = 'o';
    d.storage.github.repo = 'r';
  });
  vault.setStorage(null);
  assert.throws(() => vault.getStorage(), /WEBOBSIDIAN_GITHUB_TOKEN/);

  process.env.WEBOBSIDIAN_GITHUB_TOKEN = 'from-env';
  vault.setStorage(null);
  const s = vault.getStorage();
  assert.equal(s.kind, 'github');
  await assert.rejects(() => s.localRoot(), (e: any) => e.status === 501);

  delete process.env.WEBOBSIDIAN_GITHUB_TOKEN;
  vault.setStorage(null);
  await updateSettings((d) => {
    d.storage.driver = 'local';
  });
  assert.equal(vault.getStorage().kind, 'local');
  await rm(dataDir, { recursive: true, force: true });
});

test('[github] commit author: token owner by default; env or settings identity when configured', async () => {
  const { createGithubStorage } = await import('../src/storage/github/index.js');
  const base = await loadSettings();
  const mk = (git: Partial<typeof base.git>, env: NodeJS.ProcessEnv) => {
    const s = JSON.parse(JSON.stringify(base));
    s.storage.github.owner = 'o';
    s.storage.github.repo = 'r';
    Object.assign(s.git, git);
    return (createGithubStorage(s, { dataDir, trashDir: async () => '.trash', env: { WEBOBSIDIAN_GITHUB_TOKEN: 't', ...env } }) as any).o.author;
  };
  assert.equal(mk({}, {}), undefined);
  assert.deepEqual(mk({ authorName: 'Me', authorEmail: 'me@x.org' }, {}), { name: 'Me', email: 'me@x.org' });
  assert.deepEqual(mk({}, { WEBOBSIDIAN_GIT_AUTHOR_EMAIL: 'bot@x.org' }), { name: 'WebObsidian', email: 'bot@x.org' });
  assert.deepEqual(mk({ authorName: 'Me', authorEmail: 'me@x.org' }, { WEBOBSIDIAN_GIT_AUTHOR_NAME: 'Bot', WEBOBSIDIAN_GIT_AUTHOR_EMAIL: 'bot@x.org' }), { name: 'Bot', email: 'bot@x.org' });
});
