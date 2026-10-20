import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// config.ts reads DATA_DIR at import time, the catalogue URL on every use → set both before importing.
const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-catalog-'));
process.env.DATA_DIR = path.join(tmp, 'data');

const entry = (id: string, compat: string, extra: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), author: 'someone', description: `${id} does things`, repo: `o/${id}`, compat, ...extra,
});
let body = {
  schema: 1,
  generatedAt: '2026-10-19T03:20:00.000Z',
  capabilities: { hash: 'abc', api: '1.12.7', dts: '1.14.4' },
  plugins: [
    entry('dataview', 'full', { downloads: 500, version: '0.5.68' }),
    entry('git', 'partial', { downloads: 300, reasons: ['Uses Obsidian API missing in WebObsidian: FileSystemAdapter'], flags: ['eval'] }),
    entry('shell', 'broken', { downloads: 100, desktopOnly: true, reasons: ['Needs Node/Electron (child_process)'] }),
    entry('fresh', 'unknown', { downloads: 1 }),
    entry('zebra', 'full', { downloads: 50 }),
  ],
};
let text = JSON.stringify(body);
let mode: 'ok' | 'fail' = 'ok';
let hits = 0, conditional = 0;
const etag = () => `"${createHash('sha1').update(text).digest('hex').slice(0, 8)}"`;
const srv = http.createServer((req, res) => {
  hits++;
  if (mode === 'fail') { res.writeHead(500).end('boom'); return; }
  if (req.headers['if-none-match'] === etag()) { conditional++; res.writeHead(304).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', etag: etag() }).end(text);
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
process.env.WEBOBSIDIAN_PLUGIN_CATALOG_URL = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/community-plugins.json`;
after(async () => { srv.close(); await rm(tmp, { recursive: true, force: true }); });

const { loadSettings, updateSettings } = await import('../src/services/settings.js');
const cat = await import('../src/services/plugincatalog.js');
await loadSettings();

const installed = [
  { id: 'dataview', name: 'Dataview', version: '0.5.60', enabled: true, hasStyles: false, dir: '' },
  { id: 'handmade', name: 'Handmade', version: '1.0.0', enabled: false, hasStyles: false, dir: '' },
];
const ids = (p: { items: { id: string }[] }) => p.items.map((x) => x.id);

test('[catalog] first use downloads the list, rates and orders it by popularity', async () => {
  const page = await cat.query({}, installed);
  assert.equal(hits, 1);
  assert.equal(page.total, 5);
  assert.deepEqual(ids(page), ['dataview', 'git', 'shell', 'zebra', 'fresh']);
  assert.deepEqual(page.info.totals, { full: 2, partial: 1, broken: 1, unknown: 1 });
  assert.equal(page.info.apiVersion, '1.12.7');
  assert.equal(page.info.refreshHours, 24);
  const dv = page.items[0];
  assert.deepEqual([dv.installed, dv.enabled, dv.installedVersion], [true, true, '0.5.60']);
  assert.equal(page.items[1].installed, false);
  assert.deepEqual(page.items[1].flags, ['eval']);
  assert.equal(page.items[2].desktopOnly, true);
});

test('[catalog] within the refresh interval nothing is fetched again', async () => {
  await cat.query({}, installed);
  await cat.query({ q: 'git' }, installed);
  assert.equal(hits, 1);
});

test('[catalog] filters: installed / not installed, compatibility (one or several), text, sort, paging', async () => {
  assert.deepEqual(ids(await cat.query({ status: 'installed' }, installed)), ['dataview']);
  assert.deepEqual(ids(await cat.query({ status: 'not-installed' }, installed)), ['git', 'shell', 'zebra', 'fresh']);
  assert.deepEqual(ids(await cat.query({ compat: 'full' }, installed)), ['dataview', 'zebra']);
  assert.deepEqual(ids(await cat.query({ compat: 'partial,broken' }, installed)), ['git', 'shell']);
  assert.deepEqual(ids(await cat.query({ compat: 'full', status: 'not-installed' }, installed)), ['zebra']);
  assert.deepEqual(ids(await cat.query({ compat: 'nonsense' }, installed)), ['dataview', 'git', 'shell', 'zebra', 'fresh'], 'an unknown value is ignored, not an empty result');
  assert.deepEqual(ids(await cat.query({ q: 'SHELL' }, installed)), ['shell']);
  assert.deepEqual(ids(await cat.query({ q: 'does things zeb' }, installed)), ['zebra'], 'every word must match, anywhere');
  assert.deepEqual(ids(await cat.query({ sort: 'name' }, installed)), ['dataview', 'fresh', 'git', 'shell', 'zebra']);
  assert.deepEqual(ids(await cat.query({ sort: 'compat' }, installed)), ['dataview', 'zebra', 'git', 'shell', 'fresh']);
  const page = await cat.query({ offset: 1, limit: 2 }, installed);
  assert.deepEqual([page.total, ...ids(page)], [5, 'git', 'shell']);
  assert.equal((await cat.query({ limit: 100000 }, installed)).items.length, 5, 'limit is capped, not an error');
  const counts = (await cat.query({ q: 'does', compat: 'full', status: 'installed' }, installed)).counts;
  assert.deepEqual(counts, { compat: { full: 2, partial: 1, broken: 1, unknown: 1 }, installed: 1, notInstalled: 4 }, 'counts ignore the chip filters, so chips can show what each would give');
});

test('[catalog] the installed list gets ratings from the cached catalogue without touching the network', async () => {
  const before = hits;
  assert.equal((await cat.compatOf('git'))?.compat, 'partial');
  assert.deepEqual((await cat.compatOf('git'))?.flags, ['eval']);
  assert.equal(await cat.compatOf('handmade'), undefined);
  assert.equal(hits, before);
});

test('[catalog] "check now" revalidates with the ETag: unchanged → 304, changed → new data', async () => {
  await cat.refresh();
  assert.equal(conditional, 1);
  assert.equal((await cat.query({}, installed)).total, 5);

  body = { ...body, generatedAt: '2026-10-20T03:20:00.000Z', plugins: [...body.plugins, entry('newcomer', 'full', { downloads: 999 })] };
  text = JSON.stringify(body);
  await cat.refresh();
  const page = await cat.query({}, installed);
  assert.equal(page.total, 6);
  assert.equal(page.items[0].id, 'newcomer');
  assert.equal(page.info.generatedAt, '2026-10-20T03:20:00.000Z');
});

test('[catalog] a failing source keeps serving the last copy, reports the error, and is not retried for a while', async () => {
  mode = 'fail';
  await assert.rejects(cat.refresh(), /HTTP 500/);
  const page = await cat.query({}, installed);
  assert.equal(page.total, 6, 'stale copy still served');
  assert.match(page.info.error ?? '', /HTTP 500/);
  const afterFail = hits;
  await updateSettings((d) => { d.plugins.catalogRefreshHours = 1; });
  // make the copy look old: reload from a rewritten disk copy
  const file = path.join(tmp, 'data', 'plugin-catalog.json');
  const env = JSON.parse(await readFile(file, 'utf8'));
  env.fetchedAt = Date.now() - 2 * 3_600_000;
  await (await import('node:fs/promises')).writeFile(file, JSON.stringify(env));
  cat._resetForTests();
  // after _resetForTests the 10-minute back-off is forgotten, so this is a fresh decision: stale → background refresh (fails again)
  const stale = await cat.query({}, installed);
  assert.equal(stale.total, 6, 'answered immediately from the disk copy');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(hits > afterFail, 'a background refresh was attempted');
  const again = hits;
  await cat.query({}, installed);
  await cat.query({}, installed);
  await new Promise((r) => setTimeout(r, 150)); // background refreshes would have reached the server by now
  assert.equal(hits, again, 'back-off: no retry on every page load after a failure');
  mode = 'ok';
});

test('[catalog] refresh interval 0 means manual only; a longer interval is honoured', async () => {
  await updateSettings((d) => { d.plugins.catalogRefreshHours = 0; });
  const file = path.join(tmp, 'data', 'plugin-catalog.json');
  const env = JSON.parse(await readFile(file, 'utf8'));
  env.fetchedAt = 1; // ancient
  await (await import('node:fs/promises')).writeFile(file, JSON.stringify(env));
  cat._resetForTests();
  const before = hits;
  const page = await cat.query({}, installed);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(page.total, 6);
  assert.equal(hits, before, 'never refreshed automatically');
  assert.equal(page.info.nextCheckAt, undefined);

  await updateSettings((d) => { d.plugins.catalogRefreshHours = 24 * 7; });
  const recent = JSON.parse(await readFile(file, 'utf8'));
  recent.fetchedAt = Date.now() - 3 * 24 * 3_600_000; // 3 days old, interval 7 days
  await (await import('node:fs/promises')).writeFile(file, JSON.stringify(recent));
  cat._resetForTests();
  await cat.query({}, installed);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hits, before, 'not yet due');
});

test('[catalog] survives a restart: the disk copy is used with no network at all', async () => {
  cat._resetForTests();
  mode = 'fail';
  const before = hits;
  const page = await cat.query({}, installed);
  assert.equal(page.total, 6);
  assert.equal(hits, before);
  mode = 'ok';
});

test('[catalog] untrusted input: bad entries are dropped, odd values normalised, garbage rejected', () => {
  const parsed = cat.parseCatalog(JSON.stringify({
    schema: 1,
    plugins: [
      entry('ok', 'full'),
      { id: '../etc', name: 'x', repo: 'o/x', compat: 'full' },
      { id: 'norepo', name: 'x', repo: 'not a repo', compat: 'full' },
      { id: 'ok', name: 'dup', repo: 'o/dup', compat: 'broken' },
      { id: 'weird', name: 5, description: null, repo: 'o/weird', compat: 'excellent', reasons: ['a', 7, 'b'], downloads: 'many' },
    ],
  }));
  assert.deepEqual(parsed.plugins.map((p) => p.id), ['ok', 'weird']);
  const weird = parsed.plugins[1];
  assert.deepEqual([weird.name, weird.description, weird.compat, weird.reasons, weird.downloads], ['weird', '', 'unknown', ['a', 'b'], undefined]);
  assert.throws(() => cat.parseCatalog('not json'), /not valid JSON/);
  assert.throws(() => cat.parseCatalog('{"schema":2,"plugins":[]}'), /unknown format/);
  assert.throws(() => cat.parseCatalog('{"schema":1,"plugins":[]}'), /empty/);
});

test('[catalog] settings: refresh interval defaults to a day and is validated by the settings API schema', async () => {
  await updateSettings((d) => { d.plugins.catalogRefreshHours = 24; });
  assert.equal((await (await import('../src/services/settings.js')).getSettings()).plugins.catalogRefreshHours, 24);
  await assert.rejects(updateSettings((d) => { d.plugins.catalogRefreshHours = -1; }));
});

test('[catalog] first download failing: empty result with the reason, and the source is not hammered on every page load', async () => {
  await rm(path.join(tmp, 'data', 'plugin-catalog.json'), { force: true });
  cat._resetForTests();
  mode = 'fail';
  const before = hits;
  const page = await cat.query({}, installed);
  assert.equal(page.total, 0);
  assert.equal(page.info.available, false);
  assert.match(page.info.error ?? '', /HTTP 500/);
  await cat.query({}, installed);
  await cat.query({}, installed);
  assert.equal(hits, before + 1, 'one attempt, then back-off');
  // "Check now" ignores the back-off and recovers as soon as the source does
  mode = 'ok';
  await cat.refresh();
  assert.equal((await cat.query({}, installed)).total, 6);
  assert.equal((await cat.query({}, installed)).info.error, undefined);
});
