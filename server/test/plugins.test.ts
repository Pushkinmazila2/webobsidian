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

test('[plugins] uninstall: switches the plugin off, deletes its folder (code + data), refuses unsafe ids and unknown plugins', async () => {
  await vault.writeFileText('.obsidian/plugins/gone/manifest.json', manifest('gone'));
  await vault.writeFileText('.obsidian/plugins/gone/main.js', 'module.exports = {}');
  await plugins.savePluginData('gone', { a: 1 });
  await plugins.setEnabled('gone', true);
  assert.equal((await enabledOnDisk()).includes('gone'), true);

  assert.equal(await plugins.uninstall('gone'), true);
  assert.equal((await enabledOnDisk()).includes('gone'), false);
  assert.equal(await vault.exists('.obsidian/plugins/gone'), false);
  assert.equal((await plugins.listInstalled()).some((p) => p.id === 'gone'), false);
  assert.equal(await plugins.uninstall('gone'), false); // already gone
  await assert.rejects(() => plugins.uninstall('../x'), (e) => status(e) === 400);
});

// ---- install from GitHub: Obsidian's own resolution (root manifest version → tagged release), then API, then latest ----
interface GhWorld {
  /** root manifest.json of the default branch (null = none) */
  head?: { id: string; version: string } | null;
  /** is there a release tagged with head.version */
  tag?: boolean;
  /** GitHub API answer for releases/latest */
  api?: number | 'throw';
  /** does releases/latest/download/* work */
  latest?: boolean;
  hasStyles?: boolean;
  /** id inside the latest release's manifest (differs from head.id for beta channels) */
  latestId?: string;
}
function fakeGithub(w: GhWorld) {
  const o = { head: { id: 'gh-plug', version: '2.0.0' }, tag: true, api: 200 as number | 'throw', latest: true, hasStyles: false, latestId: 'gh-plug', ...w };
  const calls: string[] = [];
  const real = globalThis.fetch;
  const manifest = (id: string, version: string) => JSON.stringify({ id, name: id.toUpperCase(), version });
  const file = (name: string, id: string, version: string) =>
    name === 'manifest.json' ? manifest(id, version) : name === 'main.js' ? `module.exports = "${id}@${version}";` : '.x{}';
  const serve = (name: string, id: string, version: string) =>
    name === 'styles.css' && !o.hasStyles ? new Response('nf', { status: 404 }) : new Response(file(name, id, version), { status: 200 });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    let m: RegExpExecArray | null;
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      return o.head ? new Response(manifest(o.head.id, o.head.version), { status: 200 }) : new Response('nf', { status: 404 });
    }
    if (url.startsWith('https://api.github.com/')) {
      if (o.api === 'throw') throw new Error('network down');
      if (o.api !== 200) return new Response('x', { status: o.api });
      const assets = ['manifest.json', 'main.js', ...(o.hasStyles ? ['styles.css'] : [])].map((name) => ({ name, browser_download_url: `https://dl.example/${name}` }));
      return new Response(JSON.stringify({ assets }), { status: 200 });
    }
    if ((m = /^https:\/\/dl\.example\/(.+)$/.exec(url))) return serve(m[1], o.latestId, '9.9.9');
    if ((m = /github\.com\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/(.+)$/.exec(url))) {
      return o.tag && o.head && m[1] === o.head.version ? serve(m[2], o.head.id, o.head.version) : new Response('nf', { status: 404 });
    }
    if ((m = /releases\/latest\/download\/(.+)$/.exec(url))) return o.latest ? serve(m[1], o.latestId, '9.9.9') : new Response('nf', { status: 404 });
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const installWith = async (w: GhWorld) => {
  const gh = fakeGithub(w);
  try { return { gh, plugin: await plugins.installFromGithub('o/gh-plug') }; }
  finally { gh.restore(); }
};
const cleanup = async (id: string) => { await plugins.uninstall(id).catch(() => {}); };
const usedApi = (calls: string[]) => calls.some((c) => c.includes('api.github.com'));

test('[plugins] install: the release tagged with the root manifest version is used — no API call at all', async () => {
  const { gh, plugin } = await installWith({ hasStyles: true });
  try {
    assert.equal(plugin.id, 'gh-plug');
    assert.equal(plugin.version, '2.0.0');
    assert.equal(plugin.hasStyles, true);
    assert.equal(await vault.readFileText('.obsidian/plugins/gh-plug/main.js'), 'module.exports = "gh-plug@2.0.0";');
    assert.equal(usedApi(gh.calls), false, 'not rate-limited by the API');
  } finally { await cleanup('gh-plug'); }
});

test('[plugins] install: a beta "latest release" with another id does not replace the plugin the catalogue lists', async () => {
  const { gh, plugin } = await installWith({ head: { id: 'calendar', version: '1.5.10' }, latestId: 'calendar-beta' });
  try {
    assert.equal(plugin.id, 'calendar', 'installed the stable release, not the beta channel');
    assert.equal(plugin.version, '1.5.10');
    assert.equal(usedApi(gh.calls), false);
  } finally { await cleanup('calendar'); }
});

test('[plugins] install: no tagged release for the root version (or no root manifest) → the GitHub API\'s latest release', async () => {
  for (const w of [{ tag: false }, { head: null }]) {
    const { gh, plugin } = await installWith({ ...w, hasStyles: true });
    try {
      assert.equal(plugin.id, 'gh-plug', JSON.stringify(w));
      assert.ok(gh.calls.some((c) => c.includes('dl.example/main.js')), 'assets listed by the API');
      assert.equal(plugin.hasStyles, true);
    } finally { await cleanup('gh-plug'); }
  }
});

test('[plugins] install: API rate-limited (403/429), down, or erroring → releases/latest/download', async () => {
  for (const api of [403, 429, 502, 'throw'] as const) {
    const { gh, plugin } = await installWith({ head: null, api });
    try {
      assert.equal(plugin.id, 'gh-plug', `api=${api}`);
      assert.equal(plugin.hasStyles, false, 'a 404 on styles.css just means the plugin has none');
      assert.ok(gh.calls.some((c) => c === 'HEAD https://github.com/o/gh-plug/releases/latest/download/main.js'));
      assert.equal(await vault.readFileText('.obsidian/plugins/gh-plug/main.js'), 'module.exports = "gh-plug@9.9.9";');
    } finally { await cleanup('gh-plug'); }
  }
  const { plugin } = await installWith({ head: null, api: 403, hasStyles: true });
  try { assert.equal(plugin.hasStyles, true, 'styles.css fetched through the fallback too'); } finally { await cleanup('gh-plug'); }
});

test('[plugins] install: no release is a clear error, with or without the API; nothing is left half-installed', async () => {
  const fail = async (w: GhWorld, re: RegExp) => {
    const gh = fakeGithub(w);
    try { await assert.rejects(plugins.installFromGithub('o/gh-plug'), re); } finally { gh.restore(); }
  };
  await fail({ head: null, api: 404 }, /no release/);
  await fail({ head: null, api: 403, latest: false }, /403.*no downloadable release/);
  await fail({ tag: false, api: 404 }, /no release/);
  assert.equal((await plugins.listInstalled()).some((p) => p.id === 'gh-plug'), false);
});

test('[plugins] install: repo must look like owner/name', async () => {
  await assert.rejects(plugins.installFromGithub('../../etc'), (e: unknown) => status(e) === 400);
  await assert.rejects(plugins.installFromGithub('just-a-name'), (e: unknown) => status(e) === 400);
});
