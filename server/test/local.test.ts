import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalFsStorage } from '../src/storage/local.js';
import type { StorageEvent } from '../src/storage/types.js';
import { runStorageContract } from './storage.contract.js';
import { runReadContract } from './storage.read.contract.js';

async function makeLocal() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wobs-local-'));
  const vault = path.join(dir, 'vault');
  const storage = new LocalFsStorage({ root: async () => vault, trashDir: async () => '.trash' });
  return { dir, vault, storage, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

runStorageContract('local', async () => {
  const { storage, cleanup } = await makeLocal();
  return { storage, cleanup };
});

runReadContract('local', async () => {
  const { vault, storage, cleanup } = await makeLocal();
  return {
    storage,
    seed: async (files) => {
      for (const [rel, data] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
        await writeFile(path.join(vault, rel), data);
      }
    },
    cleanup,
  };
});

// ---- local-only behaviour -------------------------------------------------

test('[local] symlink pointing outside the vault is refused', async () => {
  const { dir, vault, storage, cleanup } = await makeLocal();
  try {
    await storage.init();
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.md'), 'top secret');
    await symlink(outside, path.join(vault, 'link'));
    await assert.rejects(() => storage.readText('link/secret.md'), (e: any) => e.status === 400);
    await assert.rejects(() => storage.writeText('link/new.md', 'x'), (e: any) => e.status === 400);
  } finally {
    await cleanup();
  }
});

test('[local] localRoot is the absolute vault folder', async () => {
  const { vault, storage, cleanup } = await makeLocal();
  try {
    await storage.init();
    assert.equal(await realpath(await storage.localRoot()), await realpath(vault));
  } finally {
    await cleanup();
  }
});

test('[local] watch reports external add/change/unlink and ignores .obsidian/.trash', async () => {
  process.env.WEBOBSIDIAN_WATCH = 'polling';
  const { vault, storage, cleanup } = await makeLocal();
  const events: StorageEvent[] = [];
  let stop: (() => Promise<void>) | undefined;
  try {
    await storage.init();
    stop = await storage.watch((e) => void events.push(e));
    const wait = async (pred: () => boolean, ms = 6000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) assert.fail('timed out; events: ' + JSON.stringify(events));
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await new Promise((r) => setTimeout(r, 1200)); // let chokidar finish its initial scan
    await mkdir(path.join(vault, '.obsidian'), { recursive: true });
    await writeFile(path.join(vault, '.obsidian/workspace.json'), '{}'); // must be ignored
    await writeFile(path.join(vault, 'ext.md'), 'one');
    await wait(() => events.some((e) => e.type === 'add' && e.path === 'ext.md'));
    await writeFile(path.join(vault, 'ext.md'), 'two, changed');
    await wait(() => events.some((e) => e.type === 'change' && e.path === 'ext.md'));
    await rm(path.join(vault, 'ext.md'));
    await wait(() => events.some((e) => e.type === 'unlink' && e.path === 'ext.md'));
    assert.equal(events.some((e) => e.path.startsWith('.obsidian')), false);
  } finally {
    await stop?.();
    await cleanup();
  }
});
