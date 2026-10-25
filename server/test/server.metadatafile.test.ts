import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** `GET /api/metadata/file`: one note's metadata even when the full list skips it (plugins redirect notes by front matter). */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'metadata-file-test-pw-1';

test('[server] /api/metadata/file answers for a single note, refuses non-notes', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-metafile-'));
  const vault = path.join(tmp, 'vault'), dataDir = path.join(tmp, 'data');
  await mkdir(path.join(vault, 'Excalidraw'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(vault, 'Excalidraw/D.excalidraw.md'), '---\nexcalidraw-plugin: parsed\n---\n# Text Elements\n');
  await writeFile(path.join(vault, 'img.png'), 'x');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, VAULT_PATH: vault, WEBOBSIDIAN_PASSWORD: PASSWORD, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${base}/auth/status`)).ok; } catch { await sleep(150); } }
    assert.ok(up, 'server did not start');
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const get = (p: string) => fetch(base + p, { headers: { cookie } });
    const ok = await get('/api/metadata/file?path=' + encodeURIComponent('Excalidraw/D.excalidraw.md'));
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.equal(body.cache.frontmatter['excalidraw-plugin'], 'parsed');
    assert.ok(body.size > 0);
    assert.equal((await get('/api/metadata/file?path=img.png')).status, 400);
    assert.ok((await get('/api/metadata/file?path=' + encodeURIComponent('../../etc/passwd.md'))).status >= 400);
  } finally { proc.kill(); }
});
