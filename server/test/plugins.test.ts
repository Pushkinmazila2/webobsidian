import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// config.ts reads DATA_DIR at import time → set it first.
const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-plugins-'));
process.env.DATA_DIR = path.join(tmp, 'data');
const vaultDir = path.join(tmp, 'vault');
await mkdir(vaultDir, { recursive: true });
const { LocalFsStorage } = await import('../src/storage/local.js');
const vault = await import('../src/services/vault.js');
const { loadSettings, updateSettings } = await import('../src/services/settings.js');
const plugins = await import('../src/services/plugins.js');
await loadSettings();
vault.setStorage(new LocalFsStorage({ root: async () => vaultDir, trashDir: async () => '.trash' }));

const manifest = (id: string) => JSON.stringify({ id, name: id.toUpperCase(), version: '1.0.0' });
const enabledOnDisk = async () => JSON.parse(await readFile(path.join(vaultDir, '.obsidian/community-plugins.json'), 'utf8'));
const status = (e: unknown) => (e as { status?: number })?.status;

test('[plugins] enabled state lives in the vault (.obsidian/community-plugins.json), in Obsidian\'s format', async () => {
  await vault.writeFileText('.obsidian/plugins/alpha/manifest.json', manifest('alpha'));
  await vault.writeFileText('.obsidian/plugins/beta/manifest.json', manifest('beta'));
  assert.deepEqual((await plugins.listInstalled()).map((p) => [p.id, p.enabled]), [['alpha', false], ['beta', false]]);

  await plugins.setEnabled('beta', true);
  await plugins.setEnabled('alpha', true);
  assert.deepEqual(await enabledOnDisk(), ['alpha', 'beta']);
  assert.deepEqual((await plugins.listInstalled()).map((p) => [p.id, p.enabled]), [['alpha', true], ['beta', true]]);

  await plugins.setEnabled('alpha', false);
  assert.deepEqual(await enabledOnDisk(), ['beta']);
  const before = await readFile(path.join(vaultDir, '.obsidian/community-plugins.json'), 'utf8');
  await plugins.setEnabled('alpha', false); // already off → no write
  assert.equal(await readFile(path.join(vaultDir, '.obsidian/community-plugins.json'), 'utf8'), before);
});

test('[plugins] a change made to the file outside the app (git pull, another device) is picked up on the next read', async () => {
  await writeFile(path.join(vaultDir, '.obsidian/community-plugins.json'), '["alpha"]');
  assert.deepEqual((await plugins.listInstalled()).map((p) => [p.id, p.enabled]), [['alpha', true], ['beta', false]]);
});

test('[plugins] a corrupt enabled file means "none enabled", not a broken plugin list', async () => {
  await writeFile(path.join(vaultDir, '.obsidian/community-plugins.json'), '{not json');
  assert.deepEqual((await plugins.listInstalled()).map((p) => p.enabled), [false, false]);
  await writeFile(path.join(vaultDir, '.obsidian/community-plugins.json'), '{"not":"an array"}');
  assert.deepEqual((await plugins.listInstalled()).map((p) => p.enabled), [false, false]);
});

test('[plugins] legacy list in settings.json is used until migrated into the vault, then the vault wins', async () => {
  await (await import('node:fs/promises')).rm(path.join(vaultDir, '.obsidian/community-plugins.json'));
  await updateSettings((d) => { d.plugins.enabled = ['beta']; });
  assert.deepEqual((await plugins.listInstalled()).map((p) => [p.id, p.enabled]), [['alpha', false], ['beta', true]], 'fallback to the old list');
  await plugins.migrateLegacyEnabled();
  assert.deepEqual(await enabledOnDisk(), ['beta']);
  await updateSettings((d) => { d.plugins.enabled = []; }); // settings no longer matter
  assert.deepEqual((await plugins.listInstalled()).map((p) => [p.id, p.enabled]), [['alpha', false], ['beta', true]]);
  // toggling starts from the legacy-migrated state, not from nothing
  await plugins.setEnabled('alpha', true);
  assert.deepEqual(await enabledOnDisk(), ['alpha', 'beta']);
});

test('[plugins] per-plugin data: defaults to {}, round-trips any JSON, lives in data.json, tolerates corruption', async () => {
  assert.deepEqual(await plugins.getPluginData('alpha'), {});
  await plugins.savePluginData('alpha', { theme: 'dark', list: [1, 2, { a: 'ы' }] });
  assert.deepEqual(await plugins.getPluginData('alpha'), { theme: 'dark', list: [1, 2, { a: 'ы' }] });
  assert.deepEqual(JSON.parse(await readFile(path.join(vaultDir, '.obsidian/plugins/alpha/data.json'), 'utf8')), { theme: 'dark', list: [1, 2, { a: 'ы' }] });
  await plugins.savePluginData('alpha', [1, 2]);
  assert.deepEqual(await plugins.getPluginData('alpha'), [1, 2], 'not limited to objects');
  await writeFile(path.join(vaultDir, '.obsidian/plugins/alpha/data.json'), '{broken');
  assert.deepEqual(await plugins.getPluginData('alpha'), {});
  assert.deepEqual(await plugins.getPluginData('beta'), {}, 'plugin without a data file');
});

test('[plugins] data endpoints validate: unsafe ids → 400, missing data → 400, oversize → 413', async () => {
  for (const bad of ['..', '../x', 'a/b', '']) {
    await assert.rejects(() => plugins.getPluginData(bad), (e) => status(e) === 400, `get ${bad}`);
    await assert.rejects(() => plugins.savePluginData(bad, {}), (e) => status(e) === 400, `save ${bad}`);
  }
  await assert.rejects(() => plugins.savePluginData('alpha', undefined), (e) => status(e) === 400);
  await assert.rejects(() => plugins.savePluginData('alpha', { blob: 'x'.repeat(5 * 1024 * 1024) }), (e) => status(e) === 413);
  await assert.rejects(() => plugins.setEnabled('../evil', true), (e) => status(e) === 400);
});

test('[plugins] wrapPluginCode: a classic-script wrapper (CSP forbids eval) that survives trailing comments and keeps "use strict"', async () => {
  const code = '"use strict";\nmodule.exports = { hello: () => 42 };\n//# sourceMappingURL=main.js.map';
  const g: any = { window: {} as any };
  new Function('window', plugins.wrapPluginCode('demo-1', code))(g.window); // register
  const mod = { exports: {} as any };
  g.window.__woPlugins['demo-1'](mod, mod.exports, () => ({}));
  assert.equal(mod.exports.hello(), 42);
  // strict mode survived: assigning to an undeclared variable throws
  const strict = { exports: {} as any };
  new Function('window', plugins.wrapPluginCode('s', '"use strict"; undeclared = 1;'))(g.window);
  assert.throws(() => g.window.__woPlugins.s(strict, strict.exports, () => ({})), ReferenceError);
  assert.throws(() => plugins.wrapPluginCode('../x', ''), (e) => status(e) === 400);
});
