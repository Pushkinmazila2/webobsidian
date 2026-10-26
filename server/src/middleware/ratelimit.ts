import type { Request, Response, NextFunction } from 'express';

/**
 * In-memory sliding-window brute-force guard for the login endpoint. Only FAILED
 * attempts count (successful sign-ins never lock anyone out), in two buckets:
 *  - per account name: 10 failures / 15 min — stops guessing one person's password;
 *  - per client address: 50 failures / 15 min — stops spraying many names. It is looser
 *    because behind a reverse proxy or office NAT many users share one address.
 * Resets on restart, which is fine for throttling interactive guessing.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 10;
const MAX_PER_IP = 50;

const attempts = new Map<string, number[]>();

function clientIp(req: Request): string {
  // Key on the real TCP peer address, NOT req.ip. req.ip derives from
  // X-Forwarded-For when `trust proxy` is enabled, which a directly-connected
  // attacker can spoof per request to get a fresh bucket and bypass the limit
  // (security report F-03). The socket address can't be forged at this layer,
  // so the throttle holds regardless of how `trust proxy` is configured.
  return req.socket.remoteAddress || 'unknown';
}

const nameOf = (req: Request): string => {
  const u = (req.body as { username?: unknown } | undefined)?.username;
  return typeof u === 'string' && u.trim() ? u.trim().toLowerCase().slice(0, 128) : '';
};

const keys = (req: Request): [string, number][] => {
  const out: [string, number][] = [[`ip:${clientIp(req)}`, MAX_PER_IP]];
  // A bare-password sign-in (no username) is the owner account.
  out.push([`user:${nameOf(req) || '(owner)'}`, MAX_PER_USER]);
  return out;
};

const recent = (key: string, now: number): number[] => (attempts.get(key) ?? []).filter((t) => t > now - WINDOW_MS);

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  for (const [key, max] of keys(req)) {
    const r = recent(key, now);
    if (r.length >= max) {
      const retryAfter = Math.ceil((r[0] + WINDOW_MS - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many login attempts. Try again later.', retryAfter });
      return;
    }
  }
  next();
}

/** Call after a rejected sign-in. */
export function recordLoginFailure(req: Request): void {
  const now = Date.now();
  for (const [key] of keys(req)) attempts.set(key, [...recent(key, now), now]);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) if (v.every((t) => t <= now - WINDOW_MS)) attempts.delete(k);
  }
}

/** Call after a successful sign-in: the account's own failure count starts over. */
export function clearLoginFailures(req: Request): void {
  attempts.delete(`user:${nameOf(req) || '(owner)'}`);
}
