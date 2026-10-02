import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VaultStorage } from '../src/storage/types.js';

/**
 * Driver-agnostic contract for `VaultStorage`. Every driver (local FS, GitHub, …)
 * must pass this suite unchanged. `make()` returns a fresh, empty, initialised
 * storage plus an optional cleanup.
 */
export function runStorageContract(
  name: string,
  make: () => Promise<{ storage: VaultStorage; cleanup?: () => Promise<void> }>,
): void {
  const t = (title: string, fn: (s: VaultStorage) => Promise<void>) =>
    test(`[${name}] ${title}`, async () => {
      const { storage, cleanup } = await make();
      try {
        await storage.init();
        await fn(storage);
      } finally {
        await cleanup?.();
      }
    });

  const status = (e: unknown) => (e as { status?: number })?.status;

  t('write/read roundtrip creates parent folders', async (s) => {
    await s.writeText('a/b/c.md', '# hi ✓');
    assert.equal(await s.readText('a/b/c.md'), '# hi ✓');
    assert.equal(await s.exists('a/b/c.md'), true);
    assert.equal(await s.exists('a/b'), true);
    assert.equal(await s.exists('nope.md'), false);
  });

  t('overwrite replaces content', async (s) => {
    await s.writeText('n.md', 'one');
    await s.writeText('n.md', 'two');
    assert.equal(await s.readText('n.md'), 'two');
  });

  t('reading a missing file throws', async (s) => {
    await assert.rejects(() => s.readText('missing.md'));
  });

  t('binary roundtrip + ranged streaming', async (s) => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255]);
    await s.writeBuffer('img/x.bin', bytes);
    assert.deepEqual(await s.readBuffer('img/x.bin'), bytes);
    const h = await s.openFile('img/x.bin');
    assert.equal(h.size, bytes.length);
    const chunks: Buffer[] = [];
    for await (const c of h.createReadStream({ start: 2, end: 5 })) chunks.push(c as Buffer);
    assert.deepEqual(Buffer.concat(chunks), bytes.subarray(2, 6));
  });

  t('path traversal and .git are refused with status 400', async (s) => {
    for (const bad of ['../escape.md', '../../etc/passwd', 'a/../../x.md', '.git/config', 'sub/.git/hooks/x']) {
      await assert.rejects(() => s.writeText(bad, 'x'), (e) => status(e) === 400, `write ${bad}`);
    }
    assert.equal(await s.exists('../escape.md'), false);
  });

  t('listFiles hides dotfiles, .git and node_modules; includes nested', async (s) => {
    await s.writeText('top.md', '1');
    await s.writeText('dir/nested.md', '2');
    await s.writeText('.obsidian/app.json', '{}');
    await s.writeText('.hidden/x.md', '3');
    await s.writeText('node_modules/pkg/i.md', '4');
    assert.deepEqual((await s.listFiles()).sort(), ['dir/nested.md', 'top.md']);
  });

  t('listTree: folders first, alphabetical, hidden skipped', async (s) => {
    await s.writeText('b.md', '1');
    await s.writeText('a.md', '2');
    await s.writeText('z/inner.md', '3');
    await s.writeText('.obsidian/x.json', '{}');
    const tree = await s.listTree();
    assert.equal(tree.type, 'folder');
    assert.equal(tree.path, '');
    assert.deepEqual(tree.children!.map((c) => c.path), ['z', 'a.md', 'b.md']);
    assert.deepEqual(tree.children![0].children!.map((c) => c.path), ['z/inner.md']);
    assert.equal(tree.children![1].ext, '.md');
  });

  t('listDir includes hidden entries and reports dirs', async (s) => {
    await s.writeText('.obsidian/plugins/p/manifest.json', '{}');
    await s.writeText('.obsidian/types.json', '{}');
    const d = (await s.listDir('.obsidian')).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(d, [
      { name: 'plugins', isDir: true },
      { name: 'types.json', isDir: false },
    ]);
    await assert.rejects(() => s.listDir('nope'));
  });

  t('mkdir is idempotent and creates nested folders', async (s) => {
    await s.mkdir('x/y/z');
    await s.mkdir('x/y/z');
    assert.equal(await s.exists('x/y/z'), true);
  });

  t('resolveDirCaseInsensitive reuses an existing folder, keeps new segments', async (s) => {
    await s.mkdir('Attachments/Sub');
    assert.equal(await s.resolveDirCaseInsensitive('attachments'), 'Attachments');
    assert.equal(await s.resolveDirCaseInsensitive('ATTACHMENTS/sub/new'), 'Attachments/Sub/new');
    assert.equal(await s.resolveDirCaseInsensitive('fresh/dir'), 'fresh/dir');
  });

  t('rename moves files and folders (creating parents)', async (s) => {
    await s.writeText('old/n.md', 'body');
    await s.rename('old/n.md', 'new/deeper/n2.md');
    assert.equal(await s.exists('old/n.md'), false);
    assert.equal(await s.readText('new/deeper/n2.md'), 'body');
    await s.rename('new', 'moved');
    assert.equal(await s.readText('moved/deeper/n2.md'), 'body');
  });

  t('copy: file, folder (returns created files), and refuses existing target', async (s) => {
    await s.writeText('src/a.md', 'A');
    await s.writeText('src/sub/b.md', 'B');
    assert.deepEqual(await s.copy('src/a.md', 'a-copy.md'), ['a-copy.md']);
    const made = (await s.copy('src', 'dst')).sort();
    assert.deepEqual(made, ['dst/a.md', 'dst/sub/b.md']);
    assert.equal(await s.readText('dst/sub/b.md'), 'B');
    assert.equal(await s.readText('src/sub/b.md'), 'B'); // source untouched
    await assert.rejects(() => s.copy('src', 'dst'));
  });

  t('remove deletes files and folders, and is a no-op when missing', async (s) => {
    await s.writeText('d/x.md', '1');
    await s.remove('d');
    assert.equal(await s.exists('d'), false);
    await s.remove('never-existed');
  });

  t('trash → list → restore round trip, with collision handling', async (s) => {
    await s.writeText('f/note.md', 'v1');
    const inTrash = await s.trash('f/note.md');
    assert.match(inTrash, /^\.trash\/f\/note\.md$/);
    assert.equal(await s.exists('f/note.md'), false);

    const items = await s.listTrash();
    assert.equal(items.length, 1);
    assert.equal(items[0].original, 'f/note.md');
    assert.equal(items[0].name, 'note.md');
    assert.equal(items[0].ext, '.md');

    // recreate at the original path → restore must not clobber it
    await s.writeText('f/note.md', 'v2');
    const restored = await s.restoreFromTrash(inTrash);
    assert.match(restored, /^f\/note\.restored-\d+\.md$/);
    assert.equal(await s.readText('f/note.md'), 'v2');
    assert.equal(await s.readText(restored), 'v1');
    assert.equal((await s.listTrash()).length, 0);
  });

  t('trashing the same path twice avoids collision', async (s) => {
    await s.writeText('n.md', '1');
    await s.trash('n.md');
    await s.writeText('n.md', '2');
    await s.trash('n.md');
    assert.equal((await s.listTrash()).length, 2);
  });

  t('deleteFromTrash / emptyTrash; non-trash paths are rejected', async (s) => {
    await s.writeText('a.md', '1');
    await s.writeText('b.md', '2');
    const a = await s.trash('a.md');
    await s.trash('b.md');
    await s.deleteFromTrash(a);
    assert.deepEqual((await s.listTrash()).map((i) => i.original), ['b.md']);
    await assert.rejects(() => s.deleteFromTrash('b.md'), (e) => status(e) === 400);
    await assert.rejects(() => s.restoreFromTrash('b.md'), (e) => status(e) === 400);
    await s.emptyTrash();
    assert.equal((await s.listTrash()).length, 0);
    await s.emptyTrash(); // nothing to empty — must not throw
  });

  t('trash is excluded from listFiles/listTree', async (s) => {
    await s.writeText('keep.md', '1');
    await s.writeText('gone.md', '2');
    await s.trash('gone.md');
    assert.deepEqual(await s.listFiles(), ['keep.md']);
    assert.deepEqual((await s.listTree()).children!.map((c) => c.path), ['keep.md']);
  });
}
