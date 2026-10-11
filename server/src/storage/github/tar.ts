import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { gitBlobSha } from './cache.js';

/**
 * Minimal streaming tar reader for GitHub's `/tarball/{ref}`.
 *
 * We deliberately never look at entry NAMES: GitHub prefixes every path with
 * `<owner>-<repo>-<sha>/` and uses pax headers for long / non-ASCII paths, which
 * is easy to get subtly wrong. Instead each regular file is identified by its git
 * blob sha, computed from the bytes, and matched against the shas we already know
 * from the tree. That also verifies integrity for free.
 */

export interface TarFile {
  /** git blob sha of the content (undefined when the file was too big to buffer). */
  sha?: string;
  size: number;
  /** Content, or undefined if skipped for exceeding `maxFileBytes`. */
  data?: Buffer;
}

class ByteReader {
  private chunks: Buffer[] = [];
  private len = 0;
  private done = false;
  private it: AsyncIterator<Buffer>;

  constructor(src: AsyncIterable<Buffer>) {
    this.it = src[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.len < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) this.done = true;
      else {
        this.chunks.push(value);
        this.len += value.length;
      }
    }
  }

  /** Read exactly n bytes, or fewer at EOF. */
  async read(n: number): Promise<Buffer> {
    await this.fill(n);
    const take = Math.min(n, this.len);
    const out = Buffer.allocUnsafe(take);
    let off = 0;
    while (off < take) {
      const c = this.chunks[0];
      const need = take - off;
      if (c.length <= need) {
        c.copy(out, off);
        off += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, off, 0, need);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.len -= take;
    return out;
  }

  /** Discard n bytes without materialising them. */
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      if (this.len === 0) return;
      const c = this.chunks[0];
      if (c.length <= left) {
        left -= c.length;
        this.len -= c.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = c.subarray(left);
        this.len -= left;
        left = 0;
      }
    }
  }
}

function parseSize(h: Buffer): number {
  // GNU base-256 for huge files, otherwise NUL/space-terminated octal.
  if (h[124] & 0x80) {
    let v = 0;
    for (let i = 125; i < 136; i++) v = v * 256 + h[i];
    return v;
  }
  const s = h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

/**
 * Iterate the regular files of a (possibly gzipped) tar stream. Pax/GNU metadata
 * entries and non-regular entries (dirs, symlinks) are skipped.
 */
export async function* tarFiles(
  source: Readable,
  opts: { gzip?: boolean; maxFileBytes?: number } = {},
): AsyncGenerator<TarFile> {
  const maxFileBytes = opts.maxFileBytes ?? 50 * 1024 * 1024;
  const stream = opts.gzip === false ? source : source.pipe(createGunzip());
  const r = new ByteReader(stream as AsyncIterable<Buffer>);
  try {
    for (;;) {
      const h = await r.read(512);
      if (h.length < 512 || h.every((b) => b === 0)) return; // EOF / end-of-archive marker
      const size = parseSize(h);
      const type = String.fromCharCode(h[156] || 0x30); // NUL = regular (old tar)
      const padded = Math.ceil(size / 512) * 512;
      if (type === '0') {
        if (size > maxFileBytes) {
          await r.skip(padded);
          yield { size };
        } else {
          const body = await r.read(padded);
          const data = body.subarray(0, size);
          yield { sha: gitBlobSha(data), size, data };
        }
      } else {
        await r.skip(padded); // 'x'/'g' pax, 'L'/'K' GNU long names, dirs, links, …
      }
    }
  } finally {
    stream.destroy();
    if (stream !== source) source.destroy();
  }
}
