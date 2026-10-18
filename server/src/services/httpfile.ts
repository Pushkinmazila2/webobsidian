import type { Request, Response } from 'express';
import type { ReadHandle } from '../storage/types.js';

/**
 * Serve a binary file with HTTP Range support so embedded `<video>`/`<audio>`
 * can seek: browsers (Safari especially) request `Range: bytes=…` and need a
 * 206 partial response, otherwise the scrubber and playback break. Streams the
 * file instead of buffering it — vault media can be hundreds of MB.
 *
 * Storage-agnostic: takes a `ReadHandle` (from `vault.openFile`) rather than a
 * disk path, so it works for any storage driver.
 */
export async function sendFileWithRange(
  req: Request,
  res: Response,
  file: ReadHandle,
  mime: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const { size } = file;
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    if (!Number.isFinite(start) || start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    pipeSafely(file.createReadStream({ start, end }), res);
    return;
  }
  res.setHeader('Content-Length', String(size));
  pipeSafely(file.createReadStream(), res);
}

/** Pipe a file stream to the response; a read error ends the response instead of hanging it (or crashing the process). */
function pipeSafely(stream: NodeJS.ReadableStream, res: Response) {
  stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Read failed' }); else res.destroy(); });
  stream.pipe(res);
}
