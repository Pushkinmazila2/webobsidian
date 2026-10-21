/**
 * Node's `http` / `https` on top of the server-side request proxy (`requestUrl`), for plugins written against
 * Electron (`https.request`, `https.get`, libraries such as `request`/`axios`' node adapter/`node-fetch`).
 * Requests are buffered (no streaming bodies, no sockets): the whole request is sent on `end()`, the whole
 * response is delivered as an `IncomingMessage` stream. Subject to the proxy's SSRF limits and 30 s timeout.
 */
import EventEmitter from 'events';
import { Readable, Writable } from 'stream-browserify';
import { Buffer } from 'buffer';
import { requestUrl } from './obsidianApi';

const STATUS_CODES: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

function fakeSocket() {
  const s: any = new EventEmitter();
  Object.assign(s, { setTimeout() { return s; }, setKeepAlive() { return s; }, setNoDelay() { return s; }, ref() { return s; }, unref() { return s; }, destroy() { return s; }, end() {}, write() { return true; }, remoteAddress: '0.0.0.0', remotePort: 0, encrypted: true, authorized: true });
  return s;
}

class IncomingMessage extends (Readable as any) {
  statusCode = 0; statusMessage = ''; headers: Record<string, string> = {}; rawHeaders: string[] = []; httpVersion = '1.1'; url = ''; method: string | null = null; complete = false; aborted = false;
  socket: any = fakeSocket(); connection = this.socket; trailers = {};
  constructor() { super(); }
  _read() {}
  setTimeout(_ms: number, cb?: () => void) { if (cb) this.once('timeout', cb); return this; }
}

export function makeHttp(protocol: 'http:' | 'https:') {
  class Agent extends EventEmitter {
    options: any; maxSockets = Infinity; sockets = {}; requests = {}; freeSockets = {};
    constructor(options?: any) { super(); this.options = options ?? {}; }
    destroy() {}
    addRequest() {}
  }

  class ClientRequest extends (Writable as any) {
    private chunks: Buffer[] = []; private headers: Record<string, string> = {}; private opts: any; private sent = false; private cb?: (res: any) => void;
    socket: any = fakeSocket(); connection = this.socket; aborted = false; path = ''; method = 'GET'; host = ''; protocol = protocol;
    constructor(opts: any, cb?: (res: any) => void) {
      super();
      this.opts = opts; this.cb = cb; this.method = (opts.method ?? 'GET').toUpperCase(); this.path = opts.path ?? '/'; this.host = opts.hostname ?? opts.host ?? '';
      for (const [k, v] of Object.entries(opts.headers ?? {})) this.setHeader(k, v as any);
      if (cb) this.once('response', cb);
      queueMicrotask(() => this.emit('socket', this.socket));
    }
    setHeader(k: string, v: string | number | string[]) { this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v); return this; }
    getHeader(k: string) { return this.headers[k.toLowerCase()]; }
    removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
    getHeaders() { return { ...this.headers }; }
    hasHeader(k: string) { return k.toLowerCase() in this.headers; }
    flushHeaders() {}
    setTimeout(ms: number, cb?: () => void) { if (cb) this.once('timeout', cb); this.opts.__timeout = ms; return this; }
    setNoDelay() {} setSocketKeepAlive() {}
    _write(chunk: any, enc: string, done: (e?: Error) => void) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc as BufferEncoding)); done(); }
    _final(done: (e?: Error) => void) { void this.dispatch().then(() => done(), (e) => { this.emit('error', e); done(); }); }
    abort() { this.aborted = true; this.destroy(); }
    private url(): string {
      const o = this.opts;
      if (o.href) return o.href;
      const host = o.hostname ?? (o.host ? String(o.host).split(':')[0] : 'localhost');
      const port = o.port ? `:${o.port}` : (o.host && String(o.host).includes(':') ? `:${String(o.host).split(':')[1]}` : '');
      return `${o.protocol ?? protocol}//${host}${port}${o.path ?? '/'}`;
    }
    private async dispatch() {
      if (this.sent || this.aborted) return;
      this.sent = true;
      const body = Buffer.concat(this.chunks);
      const hdrs = { ...this.headers }; delete hdrs['content-length']; delete hdrs['host'];
      let to: ReturnType<typeof setTimeout> | undefined;
      if (this.opts.__timeout) to = setTimeout(() => this.emit('timeout'), this.opts.__timeout);
      try {
        const r = await requestUrl({ url: this.url(), method: this.method, headers: hdrs, body: body.length ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer : undefined, throw: false });
        if (this.aborted) return;
        const res = new IncomingMessage();
        res.statusCode = r.status; res.statusMessage = STATUS_CODES[r.status] ?? ''; res.headers = r.headers; res.rawHeaders = Object.entries(r.headers).flat(); res.complete = true;
        this.emit('response', res);
        const buf = Buffer.from(r.arrayBuffer);
        if (buf.length) res.push(buf);
        res.push(null);
      } finally { if (to) clearTimeout(to); }
    }
  }

  const norm = (a: any, b?: any, c?: any): [any, ((res: any) => void) | undefined] => {
    let opts: any = {}, cb: any;
    if (typeof a === 'string' || a instanceof URL) { const u = new URL(String(a)); opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, href: u.href }; if (typeof b === 'function') cb = b; else { Object.assign(opts, b ?? {}); cb = c; } }
    else { opts = { ...a }; cb = typeof b === 'function' ? b : undefined; }
    if (opts.protocol && !opts.href) { /* keep as given */ }
    return [opts, cb];
  };
  const request = (a: any, b?: any, c?: any) => { const [o, cb] = norm(a, b, c); return new ClientRequest(o, cb); };
  const get = (a: any, b?: any, c?: any) => { const r = request(a, b, c); r.end(); return r; };
  const globalAgent = new Agent();
  const unsupported = () => { throw new Error('Running an HTTP server is not available in WebObsidian'); };
  return { request, get, Agent, globalAgent, ClientRequest, IncomingMessage, STATUS_CODES, METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'], createServer: unsupported, Server: unsupported };
}
