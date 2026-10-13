import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRepoRef, parseRules, readStorageEnv } from '../src/services/storageenv.js';

test('env: repository reference forms', () => {
  assert.deepEqual(parseRepoRef('Pushkinmazila2/BZ'), ['Pushkinmazila2', 'BZ']);
  assert.deepEqual(parseRepoRef('https://github.com/Pushkinmazila2/BZ.git'), ['Pushkinmazila2', 'BZ']);
  assert.deepEqual(parseRepoRef('https://github.com/o/r/'), ['o', 'r']);
  assert.deepEqual(parseRepoRef('git@github.com:o/my.repo.git'), ['o', 'my.repo']);
  assert.deepEqual(parseRepoRef('github.example.com/o/r'), ['o', 'r']);
  assert.throws(() => parseRepoRef('just-a-name'));
  assert.throws(() => parseRepoRef('a/b/c'));
});

test('env: compact rules and JSON rules', () => {
  assert.deepEqual(parseRules('.obsidian/**=mirror:noindex; **/*.{md,canvas}=mirror:index ;Private/**=remote;**=lazy'), [
    { match: '.obsidian/**', mode: 'mirror', index: false },
    { match: '**/*.{md,canvas}', mode: 'mirror', index: true },
    { match: 'Private/**', mode: 'remote' },
    { match: '**', mode: 'lazy' },
  ]);
  assert.deepEqual(parseRules('**=remote\n'), [{ match: '**', mode: 'remote' }]);
  assert.deepEqual(parseRules('[{"match":"**","mode":"lazy","index":false}]'), [{ match: '**', mode: 'lazy', index: false }]);
  assert.throws(() => parseRules('no-equals-sign'));
  assert.throws(() => parseRules('**=mirror:maybe'));
  assert.throws(() => parseRules('{"not":"array"}'));
});

test('env: everything maps to settings paths, locks them, and a repository implies the github driver', () => {
  const e = readStorageEnv({
    WEBOBSIDIAN_GITHUB_REPO: 'Pushkinmazila2/BZ',
    WEBOBSIDIAN_GITHUB_BRANCH: 'notes',
    WEBOBSIDIAN_GITHUB_BASE_PATH: 'docs',
    WEBOBSIDIAN_GITHUB_FLUSH_SEC: '20',
    WEBOBSIDIAN_GITHUB_POLL_SEC: '60',
    WEBOBSIDIAN_CACHE: 'DISK',
    WEBOBSIDIAN_CACHE_MAX_MB: '512',
    WEBOBSIDIAN_STORAGE_RULES: '**=remote',
    WEBOBSIDIAN_GITHUB_TOKEN: 'ghp_secret',
  });
  assert.deepEqual(e.patch, {
    driver: 'github',
    github: { owner: 'Pushkinmazila2', repo: 'BZ', branch: 'notes', basePath: 'docs', flushSec: 20, pollSec: 60 },
    cache: { persist: 'disk', maxMB: 512 },
    rules: [{ match: '**', mode: 'remote' }],
  });
  assert.equal(e.lockedBy['github.owner'], 'WEBOBSIDIAN_GITHUB_REPO');
  assert.equal(e.lockedBy['github.token'], 'WEBOBSIDIAN_GITHUB_TOKEN');
  assert.equal(e.lockedBy['driver'], 'WEBOBSIDIAN_GITHUB_REPO');
  assert.ok(!JSON.stringify(e.patch).includes('ghp_secret'), 'the token is never copied into settings');
});

test('env: separate OWNER + REPO, explicit driver wins, presets, rules beat presets, empty values ignored', () => {
  const a = readStorageEnv({ WEBOBSIDIAN_GITHUB_OWNER: 'o', WEBOBSIDIAN_GITHUB_REPO: 'r', WEBOBSIDIAN_STORAGE: 'local', WEBOBSIDIAN_STORAGE_PRESET: 'remote-only', WEBOBSIDIAN_GITHUB_BRANCH: '  ' });
  assert.deepEqual(a.patch.github, { owner: 'o', repo: 'r' });
  assert.equal(a.patch.driver, 'local');
  assert.deepEqual(a.patch.rules, [{ match: '**', mode: 'remote', index: false }]);
  assert.equal(a.lockedBy['github.branch'], undefined);
  const b = readStorageEnv({ WEBOBSIDIAN_STORAGE_PRESET: 'mirror-all', WEBOBSIDIAN_STORAGE_RULES: 'x/**=lazy' });
  assert.deepEqual(b.patch.rules, [{ match: 'x/**', mode: 'lazy' }]);
  assert.equal(b.lockedBy.rules, 'WEBOBSIDIAN_STORAGE_RULES');
  assert.deepEqual(readStorageEnv({}).patch, {});
});

test('env: bad values fail loudly and name the variable', () => {
  const bad = (env: Record<string, string>, name: string) =>
    assert.throws(() => readStorageEnv(env), (e: Error) => e.message.includes(name), JSON.stringify(env));
  bad({ WEBOBSIDIAN_STORAGE: 'ftp' }, 'WEBOBSIDIAN_STORAGE');
  bad({ WEBOBSIDIAN_GITHUB_REPO: 'nonsense' }, 'WEBOBSIDIAN_GITHUB_REPO');
  bad({ WEBOBSIDIAN_GITHUB_BASE_PATH: '../etc' }, 'WEBOBSIDIAN_GITHUB_BASE_PATH');
  bad({ WEBOBSIDIAN_GITHUB_API_URL: 'file:///x' }, 'WEBOBSIDIAN_GITHUB_API_URL');
  bad({ WEBOBSIDIAN_GITHUB_FLUSH_SEC: 'soon' }, 'WEBOBSIDIAN_GITHUB_FLUSH_SEC');
  bad({ WEBOBSIDIAN_CACHE: 'ram' }, 'WEBOBSIDIAN_CACHE');
  bad({ WEBOBSIDIAN_STORAGE_RULES: '**=bogus' }, 'WEBOBSIDIAN_STORAGE_RULES');
  bad({ WEBOBSIDIAN_STORAGE_PRESET: 'everything' }, 'WEBOBSIDIAN_STORAGE_PRESET');
});

test('env: held paths for plugins/config', () => {
  const a = readStorageEnv({ WEBOBSIDIAN_GITHUB_HOLD_SEC: '600', WEBOBSIDIAN_GITHUB_HOLD_MATCH: '.obsidian/**; Templates/**' });
  assert.deepEqual(a.patch.github, { holdSec: 600, holdMatch: ['.obsidian/**', 'Templates/**'] });
  assert.equal(a.lockedBy['github.holdMatch'], 'WEBOBSIDIAN_GITHUB_HOLD_MATCH');
  assert.deepEqual(readStorageEnv({ WEBOBSIDIAN_GITHUB_HOLD_MATCH: 'none' }).patch.github.holdMatch, [], '"none" disables holding');
  assert.throws(() => readStorageEnv({ WEBOBSIDIAN_GITHUB_HOLD_SEC: '0' }), /WEBOBSIDIAN_GITHUB_HOLD_SEC|holdSec/);
});
