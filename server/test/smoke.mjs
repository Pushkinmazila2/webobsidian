#!/usr/bin/env node
/**
 * Behavioural smoke test for the storage layer.
 *
 * Boots the real server against a throw-away copy of sample-vault, drives every
 * fs-touching HTTP route and prints a normalised JSON transcript. Run it before
 * and after a storage refactor and diff the two transcripts:
 *
 *   node test/smoke.mjs > before.json   # ... refactor ...
 *   node test/smoke.mjs > after.json && diff before.json after.json
 *
 * Volatile values (timestamps, random ids, tmp paths) are normalised away.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoRoot = path.resolve(serverDir, '..');

const tmp = mkdtempSync(path.join(tmpdir(), 'wobs-smoke-'));
const vaultDir = path.join(tmp, 'vault');
const dataDir = path.join(tmp, 'data');
cpSync(path.join(repoRoot, 'sample-vault'), vaultDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
// Pre-existing hand-made plugin + differently-cased attachments folder.
mkdirSync(path.join(vaultDir, '.obsidian/plugins/demo'), { recursive: true });
writeFileSync(path.join(vaultDir, '.obsidian/plugins/demo/manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' }));
writeFileSync(path.join(vaultDir, '.obsidian/plugins/demo/main.js'), 'module.exports = class Demo {};');
mkdirSync(path.join(vaultDir, 'Attachments'), { recursive: true });

const PORT = 20000 + Math.floor(Math.random() * 20000);
const PASSWORD = 'smoke-password-123';
const base = `http://127.0.0.1:${PORT}`;

const proc = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), ['src/index.ts'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    VAULT_PATH: vaultDir,
    WEBOBSIDIAN_PASSWORD: PASSWORD,
    WEBOBSIDIAN_WATCH: process.env.WEBOBSIDIAN_WATCH ?? 'polling',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', (d) => (log += d));
proc.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const transcript = [];

function normalise(v) {
  const s = JSON.stringify(v, (k, val) => {
    if (k === 'mtime' || k === 'ctime') return typeof val === 'number' ? '<ts>' : val;
    if (k === 'id' || k === 'key' || k === 'createdAt' || k === 'created' || k === 'lastUsed' || k === 'prefix') return '<volatile>';
    return val;
  });
  return JSON.parse(
    s
      .split(vaultDir).join('<VAULT>')
      .split(tmp).join('<TMP>')
      .replace(/\.\d{13}(\.|")/g, '.<now>$1')
      .replace(/restored-\d{13}/g, 'restored-<now>'),
  );
}

async function call(label, method, url, { body, headers = {}, raw, auth = true } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined && !(body instanceof FormData)) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  } else payload = body;
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const ct = res.headers.get('content-type') ?? '';
  let out;
  if (raw) out = Buffer.from(await res.arrayBuffer()).toString('hex');
  else if (ct.includes('json')) out = await res.json();
  else out = (await res.text()).slice(0, 400);
  const entry = { label, status: res.status };
  for (const hn of ['content-range', 'accept-ranges', 'content-length', 'content-type']) {
    const hv = res.headers.get(hn);
    if (hv && raw) entry[hn] = hv;
  }
  entry.body = out;
  transcript.push(normalise(entry));
  return { res, out };
}

async function waitReady() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(base + '/auth/status');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not start:\n' + log);
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

async function run() {
  await waitReady();
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('login failed: ' + login.status + '\n' + log);

  await call('tree', 'GET', '/api/files');
  await call('read md', 'GET', '/api/files/content?path=Welcome.md');
  await call('read missing', 'GET', '/api/files/content?path=nope.md');
  await call('traversal', 'GET', '/api/files/content?path=../../etc/passwd');
  await call('git dir blocked', 'GET', '/api/files/content?path=.git/config');

  await call('write note', 'PUT', '/api/files/content', { body: { path: 'Notes/smoke.md', content: '# Smoke\n\nLinks to [[Welcome]] #smoketag\n\n![[pic.png]]\n' } });
  await call('write nested new dir', 'PUT', '/api/files/content', { body: { path: 'Deep/er/note.md', content: 'deep note about zebras' } });
  await call('read back', 'GET', '/api/files/content?path=Notes/smoke.md');
  await sleep(200);
  await call('search', 'GET', '/api/search?q=zebras');
  await call('backlinks', 'GET', '/api/backlinks?path=Welcome.md');
  await call('tags', 'GET', '/api/tags');

  await call('mkdir', 'POST', '/api/files/folder', { body: { path: 'Empty/Folder' } });

  // upload into a differently-cased dir → must reuse "Attachments"
  const fd = new FormData();
  fd.append('dir', 'attachments');
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'pic.png');
  await call('upload (case-insens dir)', 'POST', '/api/files/upload', { body: fd });
  await sleep(3000); // let the watcher index the new attachment (polling interval)
  await call('binary full', 'GET', '/api/files/content?path=Attachments/pic.png', { raw: true });
  await call('binary range', 'GET', '/api/files/content?path=Attachments/pic.png', { raw: true, headers: { range: 'bytes=2-5' } });
  await call('binary bad range', 'GET', '/api/files/content?path=Attachments/pic.png', { raw: true, headers: { range: 'bytes=9999-' } });
  await call('embed resolve by basename', 'GET', '/api/files/content?path=pic.png', { raw: true });
  await call('resolve link', 'GET', '/api/resolve?target=pic.png');

  await call('rename', 'PATCH', '/api/files/rename', { body: { from: 'Notes/smoke.md', to: 'Notes/smoke2.md' } });
  await call('copy folder', 'POST', '/api/files/copy', { body: { from: 'Deep', to: 'DeepCopy' } });
  await call('copy onto existing', 'POST', '/api/files/copy', { body: { from: 'Deep', to: 'DeepCopy' } });
  await sleep(200);
  await call('tree after ops', 'GET', '/api/files');
  await call('search after copy', 'GET', '/api/search?q=zebras');

  await call('delete → trash', 'DELETE', '/api/files?path=Deep/er/note.md');
  await call('trash list', 'GET', '/api/files/trash');
  await call('restore', 'POST', '/api/files/trash/restore', { body: { path: '.trash/Deep/er/note.md' } });
  await call('trash after restore', 'GET', '/api/files/trash');
  await call('delete again', 'DELETE', '/api/files?path=Deep/er/note.md');
  await call('trash purge item', 'DELETE', '/api/files/trash/item?path=.trash/Deep/er/note.md');
  await call('delete DeepCopy', 'DELETE', '/api/files?path=DeepCopy');
  await call('empty trash', 'DELETE', '/api/files/trash');
  await call('trash empty', 'GET', '/api/files/trash');

  await call('prop types set', 'POST', '/api/property-types', { body: { key: 'status', type: 'text' } });
  await call('prop types get', 'GET', '/api/property-types');

  await call('plugins list', 'GET', '/api/plugins');
  await call('plugin asset', 'GET', '/api/plugins/demo/main.js');
  await call('plugin asset traversal', 'GET', '/api/plugins/..%2f..%2fx/main.js');

  const share = await call('create share', 'POST', '/api/shares', { body: { path: 'Notes/smoke2.md' } });
  const sid = share.out?.share?.id;
  if (sid) {
    await call('share content', 'GET', `/public/shares/${sid}`, { auth: false });
    await call('share embed ok', 'GET', `/public/shares/${sid}/file?path=pic.png`, { auth: false, raw: true });
    await call('share embed range', 'GET', `/public/shares/${sid}/file?path=pic.png`, { auth: false, raw: true, headers: { range: 'bytes=0-3' } });
    await call('share embed not allowed', 'GET', `/public/shares/${sid}/file?path=Welcome.md`, { auth: false });
  }

  // agent API
  const key = await call('create key', 'POST', '/api/keys', { body: { name: 'smoke', scopes: ['read', 'write', 'search'] } });
  const hdr = { authorization: `Bearer ${key.out.key}` };
  await call('agent list', 'GET', '/api/v1/notes', { headers: hdr, auth: false });
  await call('agent put', 'PUT', '/api/v1/notes/Agent/a.md', { headers: hdr, auth: false, body: { content: 'agent wrote this' } });
  await call('agent get', 'GET', '/api/v1/notes/Agent/a.md', { headers: hdr, auth: false });
  await call('agent delete', 'DELETE', '/api/v1/notes/Agent/a.md', { headers: hdr, auth: false });

  // external modification → watcher must pick it up (search + tree)
  writeFileSync(path.join(vaultDir, 'External.md'), 'created outside the app about giraffes');
  await sleep(3500);
  await call('search external', 'GET', '/api/search?q=giraffes');
  await call('resolve external', 'GET', '/api/resolve?target=External');
  rmSync(path.join(vaultDir, 'External.md'));
  await sleep(3500);
  await call('search external removed', 'GET', '/api/search?q=giraffes');
}

let code = 0;
try {
  await run();
  process.stdout.write(JSON.stringify(transcript, null, 2) + '\n');
} catch (e) {
  console.error('SMOKE FAILED:', e);
  console.error(log.slice(-3000));
  code = 1;
} finally {
  proc.kill('SIGTERM');
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
