/**
 * Browser stand-ins for the Node/Electron built-ins that desktop-oriented community plugins `require()`.
 * Pure-JS modules (buffer, events, util, stream, string_decoder, punycode, path, os, url, querystring, a
 * Web-Crypto-backed slice of crypto) are real or faithful; modules that need an OS (fs, net, http, child_process…)
 * return a stub that only throws if the plugin actually *calls* it, so a plugin that merely imports them still starts.
 */
import { Buffer } from 'buffer';
import EventEmitter from 'events';
import * as util from 'util';
import * as stream from 'stream-browserify';
import * as stringDecoder from 'string_decoder';
import * as punycode from 'punycode';
import processShim from 'process';
import createHash from 'create-hash';
import createHmac from 'create-hmac';
import * as cipher from 'browserify-cipher';
import { pbkdf2Sync } from 'pbkdf2';
import { makeHttp } from './nodeHttp';

export { Buffer };

/**
 * `process` as Electron presents it to plugins. Passed to each plugin's scope only (never put on `window`):
 * libraries in the app itself feature-detect `process.versions.node` and must keep seeing a browser.
 */
let pluginProc: any;
export function pluginProcess() {
  if (!pluginProc) {
    const base: any = processShim;
    pluginProc = Object.assign(Object.create(base), {
      browser: false, platform: 'linux', arch: 'x64', pid: 1, argv: [], execPath: '/', title: 'obsidian', env: {}, cwd: () => '/',
      version: 'v20.18.0', versions: { node: '20.18.0', electron: '33.0.0', v8: '12.0.0' }, release: { name: 'node' },
      hrtime: Object.assign((prev?: [number, number]) => { const t = performance.now(); const s = Math.floor(t / 1000), n = Math.floor((t % 1000) * 1e6); return prev ? [s - prev[0], n - prev[1]] : [s, n]; }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
      emitWarning: (w: unknown) => console.warn(w),
      exit: () => { throw new Error('process.exit() is not available in WebObsidian'); },
    });
  }
  return pluginProc;
}

/** `Buffer` is a global in Obsidian; plugins also reference it as `window.Buffer`/`globalThis.Buffer`. */
export function installNodeGlobals() {
  const w = window as any;
  w.Buffer ??= Buffer;
  w.global ??= window;
}

const pathShim = {
  sep: '/', delimiter: ':',
  join: (...p: string[]) => p.filter(Boolean).join('/').replace(/\/+/g, '/'),
  resolve: (...p: string[]) => p.filter(Boolean).join('/').replace(/\/+/g, '/'),
  basename: (p: string, ext?: string) => { const b = p.split('/').pop() ?? ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
  dirname: (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); },
  extname: (p: string) => { const b = p.split('/').pop() ?? ''; const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
  normalize: (p: string) => p.replace(/\/+/g, '/'),
  isAbsolute: (p: string) => p.startsWith('/'),
  relative: (_a: string, b: string) => b,
  parse: (p: string) => { const base = p.split('/').pop() ?? ''; const i = base.lastIndexOf('.'); return { root: p.startsWith('/') ? '/' : '', dir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', base, ext: i <= 0 ? '' : base.slice(i), name: i <= 0 ? base : base.slice(0, i) }; },
};

const osShim = {
  EOL: '\n', platform: () => 'linux', type: () => 'Linux', arch: () => 'x64', release: () => '', homedir: () => '/', tmpdir: () => '/tmp',
  hostname: () => 'webobsidian', cpus: () => [] as unknown[], totalmem: () => 0, freemem: () => 0, endianness: () => 'LE', userInfo: () => ({ username: 'user', homedir: '/' }),
};

const qs = {
  parse: (s: string) => { const o: Record<string, string | string[]> = {}; for (const [k, v] of new URLSearchParams(s)) { const cur = o[k]; o[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v]; } return o; },
  stringify: (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]))).toString(),
  escape: encodeURIComponent, unescape: decodeURIComponent,
};

const urlShim = {
  URL, URLSearchParams,
  parse: (u: string) => { try { const x = new URL(u, 'http://localhost'); return { href: u, protocol: x.protocol, host: x.host, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, query: x.search.slice(1), hash: x.hash, path: x.pathname + x.search }; } catch { return {}; } },
  format: (u: any) => (typeof u === 'string' ? u : u?.href ?? String(u)),
  fileURLToPath: (u: string | URL) => decodeURIComponent(new URL(String(u)).pathname),
  pathToFileURL: (p: string) => new URL('file://' + p),
};

/** `crypto`: the synchronous random helpers plugins use; hashing/ciphers need real implementations and throw if called. */
const cryptoShim = {
  randomBytes: (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))),
  randomInt: (a: number, b?: number) => { const [lo, hi] = b === undefined ? [0, a] : [a, b]; return lo + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (hi - lo)); },
  randomUUID: () => crypto.randomUUID(),
  getRandomValues: (a: ArrayBufferView) => crypto.getRandomValues(a as any),
  webcrypto: crypto, subtle: crypto.subtle,
  createHash: (alg: string) => createHash(alg as any), createHmac: (alg: string, key: any) => createHmac(alg as any, key),
  createCipheriv: (alg: string, key: any, iv: any) => (cipher as any).createCipheriv(alg, key, iv),
  createDecipheriv: (alg: string, key: any, iv: any) => (cipher as any).createDecipheriv(alg, key, iv),
  getCiphers: () => (cipher as any).getCiphers?.() ?? [],
  pbkdf2Sync: (pw: any, salt: any, iter: number, len: number, digest: string) => pbkdf2Sync(pw, salt, iter, len, digest),
  timingSafeEqual: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]),
  getHashes: () => ['md5', 'sha1', 'sha256', 'sha512'],
};

/**
 * `child_process`: nothing can be spawned in a browser. The one thing libraries commonly shell out for — a
 * machine id (`node-machine-id`) — is answered with a stable per-browser id; every other command fails.
 */
const childProcessShim = (plugin: string) => {
  const machineId = () => {
    try { let id = localStorage.getItem('wo-machine-id'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('wo-machine-id', id); } return id; } catch { return 'webobsidian-machine'; }
  };
  const run = (cmd: string): Buffer => {
    if (/machine-id|hostname|IOPlatformUUID|MachineGuid/i.test(cmd)) return Buffer.from(machineId() + '\n');
    throw new Error(`Running commands is not available in WebObsidian (plugin "${plugin}" ran: ${cmd.slice(0, 60)})`);
  };
  return {
    execSync: (cmd: string) => run(cmd),
    exec: (cmd: string, _o?: unknown, cb?: (e: Error | null, out?: string, err?: string) => void) => { const f = typeof _o === 'function' ? _o as typeof cb : cb; try { f?.(null, run(cmd).toString(), ''); } catch (e) { f?.(e as Error, '', ''); } return new EventEmitter(); },
    spawn: () => { throw new Error(`Spawning processes is not available in WebObsidian (plugin "${plugin}")`); },
    spawnSync: () => { throw new Error(`Spawning processes is not available in WebObsidian (plugin "${plugin}")`); },
    execFile: () => { throw new Error(`Spawning processes is not available in WebObsidian (plugin "${plugin}")`); },
    execFileSync: () => { throw new Error(`Spawning processes is not available in WebObsidian (plugin "${plugin}")`); },
    fork: () => { throw new Error(`Spawning processes is not available in WebObsidian (plugin "${plugin}")`); },
  };
};

const unavailable = (mod: string, plugin: string) =>
  new Proxy({}, {
    get: (_t, key) => {
      if (key === '__esModule' || key === 'then' || typeof key === 'symbol') return undefined;
      // a plain function (not an arrow): libraries subclass these (`class X extends net.Socket`, `util.inherits(X, http.Agent)`)
      return function unavailableApi() { throw new Error(`"${mod}" is not available in WebObsidian (plugin "${plugin}" called ${String(key)}())`); };
    },
  });

const MODULES: Record<string, unknown> = {
  buffer: { Buffer, SlowBuffer: Buffer, kMaxLength: 2 ** 31 - 1, constants: { MAX_LENGTH: 2 ** 31 - 1 } },
  events: Object.assign(EventEmitter, { EventEmitter }),
  util, stream, string_decoder: stringDecoder, punycode, path: pathShim, 'path/posix': pathShim, os: osShim, querystring: qs, url: urlShim,
  assert: Object.assign((v: unknown, m?: string) => { if (!v) throw new Error(m || 'Assertion failed'); }, {
    ok: (v: unknown, m?: string) => { if (!v) throw new Error(m || 'Assertion failed'); },
    equal: (a: unknown, b: unknown, m?: string) => { if (a != b) throw new Error(m || `${a} != ${b}`); },
    strictEqual: (a: unknown, b: unknown, m?: string) => { if (a !== b) throw new Error(m || `${a} !== ${b}`); },
    notStrictEqual: (a: unknown, b: unknown, m?: string) => { if (a === b) throw new Error(m || `${a} === ${b}`); },
    deepStrictEqual: (a: unknown, b: unknown, m?: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || 'not deep equal'); },
    throws: (fn: () => void) => { try { fn(); } catch { return; } throw new Error('Missing expected exception'); },
    fail: (m?: string) => { throw new Error(m || 'Failed'); },
  }),
  crypto: cryptoShim,
};
let httpMod: unknown, httpsMod: unknown;

/** Modules that exist in Node but not here: required without error, fail only when called. */
const STUBBED = new Set([
  'fs', 'fs/promises', 'zlib', 'http2', 'net', 'tls', 'dns', 'dgram', 'electron', 'original-fs', 'readline',
  'worker_threads', 'module', 'vm', 'constants', 'tty', 'v8', 'perf_hooks', 'async_hooks', 'timers', 'cluster', 'inspector', 'repl', 'domain', 'diagnostics_channel',
]);

/** Resolve a Node built-in for a plugin; `undefined` when `name` is not a Node built-in. */
export function nodeBuiltin(name: string, plugin: string): unknown {
  const bare = name.replace(/^node:/, '').replace(/\/$/, '');
  if (bare === 'process') return pluginProcess();
  if (bare === 'child_process') return childProcessShim(plugin);
  if (bare === 'http') return (httpMod ??= makeHttp('http:'));
  if (bare === 'https') return (httpsMod ??= makeHttp('https:'));
  if (bare in MODULES) return MODULES[bare];
  if (STUBBED.has(bare)) return unavailable(bare, plugin);
  return undefined;
}
