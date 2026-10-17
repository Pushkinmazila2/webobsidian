/**
 * Outbound HTTP proxy for community plugins (`requestUrl` / `request`).
 *
 * Browsers enforce CORS, so plugin network calls are made by the server on the plugin's behalf. Because
 * that lets a logged-in user make the *server* fetch arbitrary URLs, it is fenced against SSRF:
 *  - http(s) only, a hard timeout and a response size cap;
 *  - every connection's address is validated at connect time (so DNS rebinding cannot slip a private
 *    address in after a check) and loopback / private / link-local / metadata ranges are refused;
 *  - redirects are followed manually (max 5) and re-validated; credentials are dropped on cross-origin hops.
 * Self-hosters who need plugins to reach services on their own network can set
 * `WEBOBSIDIAN_PROXY_ALLOW_PRIVATE=1`; `WEBOBSIDIAN_PROXY=off` disables the proxy altogether.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** Final URL after redirects. */
  url: string;
}
export interface ProxyOptions {
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export const proxyDisabled = () => /^(off|0|false|disabled)$/i.test(process.env.WEBOBSIDIAN_PROXY ?? '');
export const privateAllowed = () => /^(1|true|on|yes)$/i.test(process.env.WEBOBSIDIAN_PROXY_ALLOW_PRIVATE ?? '');

/** True for addresses a plugin must not reach: loopback, private, link-local, CGNAT, multicast, metadata, … */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isBlockedAddress(mapped[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
      return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(v.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true; // not an IP at all → refuse
}

/** `dns.lookup` that refuses to hand back a blocked address (checked at connect time). */
export const guardedLookup: typeof dns.lookup = ((hostname: string, options: any, cb: any) => {
  const opts = typeof options === 'function' ? {} : options ?? {};
  const done = typeof options === 'function' ? options : cb;
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return done(err);
    const list = addrs as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) return done(Object.assign(new Error(`Refusing to connect to ${hostname}: private or reserved address`), { code: 'EBLOCKED' }));
    if (opts.all) return done(null, list);
    return done(null, list[0].address, list[0].family);
  });
}) as typeof dns.lookup;

function assertAllowedUrl(u: URL, allowPrivate: boolean) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, `Unsupported protocol ${u.protocol}`);
  if (u.username || u.password) throw httpError(400, 'Credentials in the URL are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(host) && isBlockedAddress(host)) throw httpError(403, 'Refusing to connect to a private or reserved address');
  if (!allowPrivate && /^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) throw httpError(403, 'Refusing to connect to a local host name');
}

const DROP_REQ = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'cookie', 'proxy-authorization', 'upgrade', 'te', 'keep-alive']);

function once(req: ProxyRequest, u: URL, o: Required<ProxyOptions>): Promise<ProxyResponse & { location?: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'user-agent': 'WebObsidian', accept: '*/*', 'accept-encoding': 'gzip, deflate, br' };
    for (const [k, v] of Object.entries(req.headers ?? {})) if (!DROP_REQ.has(k.toLowerCase()) && typeof v === 'string') headers[k.toLowerCase()] = v;
    if (req.body && req.body.length) headers['content-length'] = String(req.body.length);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(
      u,
      { method: (req.method ?? 'GET').toUpperCase(), headers, lookup: o.allowPrivate ? undefined : guardedLookup, timeout: o.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) { r.destroy(httpError(502, `Response is larger than ${Math.round(o.maxBytes / 1048576)} MB`)); return; }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          let body: Buffer = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) hdrs[k] = Array.isArray(v) ? v.join(', ') : String(v);
          try {
            if (enc === 'gzip' || enc === 'x-gzip') body = zlib.gunzipSync(body);
            else if (enc === 'deflate') body = zlib.inflateSync(body);
            else if (enc === 'br') body = zlib.brotliDecompressSync(body);
            if (enc) { delete hdrs['content-encoding']; hdrs['content-length'] = String(body.length); }
          } catch { /* undecodable: hand the bytes back as received */ }
          resolve({ status: res.statusCode ?? 0, headers: hdrs, body, url: u.toString(), location: res.headers.location });
        });
      },
    );
    r.on('timeout', () => r.destroy(httpError(504, 'Request timed out')));
    r.on('error', (e: any) => reject(e?.status ? e : e?.code === 'EBLOCKED' ? httpError(403, e.message) : httpError(502, e?.message ?? 'Request failed')));
    if (req.body && req.body.length) r.write(req.body);
    r.end();
  });
}

export async function proxyRequest(req: ProxyRequest, opts: ProxyOptions = {}): Promise<ProxyResponse> {
  if (proxyDisabled()) throw httpError(403, 'The request proxy is disabled on this server');
  const o: Required<ProxyOptions> = {
    allowPrivate: opts.allowPrivate ?? privateAllowed(),
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxBytes: opts.maxBytes ?? 25 * 1048576,
    maxRedirects: opts.maxRedirects ?? 5,
  };
  let url: URL;
  try { url = new URL(req.url); } catch { throw httpError(400, 'Invalid URL'); }
  let cur: ProxyRequest = { ...req };
  for (let hop = 0; ; hop++) {
    assertAllowedUrl(url, o.allowPrivate);
    const res = await once(cur, url, o);
    const redirect = [301, 302, 303, 307, 308].includes(res.status) && res.location;
    if (!redirect) { const { location: _l, ...rest } = res; return rest; }
    if (hop >= o.maxRedirects) throw httpError(502, 'Too many redirects');
    const next = new URL(res.location!, url);
    const headers = { ...(cur.headers ?? {}) };
    if (next.origin !== url.origin) for (const k of Object.keys(headers)) if (/^(authorization|cookie)$/i.test(k)) delete headers[k];
    const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && (cur.method ?? 'GET').toUpperCase() === 'POST');
    cur = { url: next.toString(), method: toGet ? 'GET' : cur.method, headers, body: toGet ? undefined : cur.body };
    url = next;
  }
}
