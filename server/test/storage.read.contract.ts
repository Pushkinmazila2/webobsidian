import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VaultStorage } from '../src/storage/types.js';

export type SeedFiles = Record<string, string | Buffer>;

/**
 * Read-side contract for `VaultStorage`, shared by every driver. Unlike the write
 * contract it never calls a mutating method: the backend is populated through
 * `seed`, which writes straight into whatever backs the driver (a folder, or a
 * commit on the mock GitHub) and makes the driver notice.
 */
export function runReadContract(
  name: string,
  make: () => Promise<{ storage: VaultStorage; seed: (files: SeedFiles) => Promise<void>; cleanup?: () => Promise<void> }>,
): void {
  const t = (title: string, fn: (s: VaultStorage, seed: (f: SeedFiles) => Promise<void>) => Promise<void>) =>
    test(`[${name}] read: ${title}`, async () => {
      const { storage, seed, cleanup } = await make();
      try {
        await storage.init();
        await fn(storage, seed);
      } finally {
        await cleanup?.();
      }
    });
  const status = (e: unknown) => (e as { status?: number })?.status;

  t('text roundtrip incl. unicode; exists for files, dirs, missing', async (s, seed) => {
    await seed({ 'a/b/c.md': '# hi ✓' });
    assert.equal(await s.readText('a/b/c.md'), '# hi ✓');
    assert.equal(await s.exists('a/b/c.md'), true);
    assert.equal(await s.exists('a/b'), true);
    assert.equal(await s.exists('a'), true);
    assert.equal(await s.exists(''), true);
    assert.equal(await s.exists('nope.md'), false);
  });

  t('unicode folder names and spaces', async (s, seed) => {
    const p = 'Работа/Мониторинг Observability/Заметка №1.md';
    await seed({ [p]: 'привет' });
    assert.equal(await s.readText(p), 'привет');
    assert.deepEqual(await s.listFiles(), [p]);
    assert.equal(await s.exists('Работа/Мониторинг Observability'), true);
  });

  t('reading a missing file throws', async (s) => {
    await assert.rejects(() => s.readText('missing.md'));
    await assert.rejects(() => s.readBuffer('missing.bin'));
  });

  t('binary roundtrip + ranged streaming', async (s, seed) => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255]);
    await seed({ 'img/x.bin': bytes });
    assert.deepEqual(await s.readBuffer('img/x.bin'), bytes);
    const h = await s.openFile('img/x.bin');
    assert.equal(h.size, bytes.length);
    const part: Buffer[] = [];
    for await (const c of h.createReadStream({ start: 2, end: 5 })) part.push(c as Buffer);
    assert.deepEqual(Buffer.concat(part), bytes.subarray(2, 6));
    const all: Buffer[] = [];
    for await (const c of h.createReadStream()) all.push(c as Buffer);
    assert.deepEqual(Buffer.concat(all), bytes);
  });

  t('path traversal and .git are refused with status 400', async (s) => {
    for (const bad of ['../escape.md', '../../etc/passwd', 'a/../../x.md', '.git/config', 'sub/.git/hooks/x']) {
      await assert.rejects(() => s.readText(bad), (e) => status(e) === 400, `read ${bad}`);
    }
    assert.equal(await s.exists('../escape.md'), false);
  });

  t('listFiles hides dotfiles and node_modules; includes nested', async (s, seed) => {
    await seed({
      'top.md': '1',
      'dir/nested.md': '2',
      '.obsidian/app.json': '{}',
      '.hidden/x.md': '3',
      'node_modules/pkg/i.md': '4',
    });
    assert.deepEqual((await s.listFiles()).sort(), ['dir/nested.md', 'top.md']);
  });

  t('listTree: folders first, alphabetical, hidden skipped, ext set', async (s, seed) => {
    await seed({ 'b.md': '1', 'a.md': '2', 'z/inner.md': '3', '.obsidian/x.json': '{}' });
    const tree = await s.listTree();
    assert.equal(tree.type, 'folder');
    assert.equal(tree.path, '');
    assert.deepEqual(tree.children!.map((c) => c.path), ['z', 'a.md', 'b.md']);
    assert.deepEqual(tree.children![0].children!.map((c) => c.path), ['z/inner.md']);
    assert.equal(tree.children![1].ext, '.md');
  });

  t('listDir includes hidden entries and reports dirs; missing dir rejects', async (s, seed) => {
    await seed({ '.obsidian/plugins/p/manifest.json': '{}', '.obsidian/types.json': '{}' });
    const d = (await s.listDir('.obsidian')).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(d, [
      { name: 'plugins', isDir: true },
      { name: 'types.json', isDir: false },
    ]);
    await assert.rejects(() => s.listDir('nope'));
  });

  t('resolveDirCaseInsensitive reuses an existing folder, keeps new segments', async (s, seed) => {
    await seed({ 'Attachments/Sub/f.png': 'x' });
    assert.equal(await s.resolveDirCaseInsensitive('attachments'), 'Attachments');
    assert.equal(await s.resolveDirCaseInsensitive('ATTACHMENTS/sub/new'), 'Attachments/Sub/new');
    assert.equal(await s.resolveDirCaseInsensitive('fresh/dir'), 'fresh/dir');
  });

  t('trash folder: listed by listTrash, excluded from listFiles/listTree', async (s, seed) => {
    await seed({ 'keep.md': '1', '.trash/f/note.md': 'old body' });
    assert.deepEqual(await s.listFiles(), ['keep.md']);
    assert.deepEqual((await s.listTree()).children!.map((c) => c.path), ['keep.md']);
    const items = await s.listTrash();
    assert.equal(items.length, 1);
    assert.equal(items[0].path, '.trash/f/note.md');
    assert.equal(items[0].original, 'f/note.md');
    assert.equal(items[0].name, 'note.md');
    assert.equal(items[0].ext, '.md');
    assert.equal(items[0].size, 'old body'.length);
  });
}
