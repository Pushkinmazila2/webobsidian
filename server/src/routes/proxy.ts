import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { proxyRequest } from '../services/proxy.js';

/** `POST /api/proxy/request` — the server makes a plugin's HTTP request (browsers block it with CORS). */
export const proxyRouter = Router();
proxyRouter.use(requireAuth);

proxyRouter.post(
  '/request',
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.url !== 'string' || !b.url) {
      res.status(400).json({ error: 'url required' });
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((b.headers ?? {}) as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v;
    if (typeof b.contentType === 'string' && b.contentType) headers['content-type'] = b.contentType;
    const body = typeof b.bodyBase64 === 'string' ? Buffer.from(b.bodyBase64, 'base64') : typeof b.body === 'string' ? Buffer.from(b.body, 'utf8') : undefined;
    const r = await proxyRequest({ url: b.url, method: typeof b.method === 'string' ? b.method : 'GET', headers, body });
    res.json({ status: r.status, headers: r.headers, bodyBase64: r.body.toString('base64'), url: r.url });
  }),
);
