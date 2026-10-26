import { proxyRouter } from './routes/proxy.js';
import { metadataRouter } from './routes/metadata.js';
import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { loadSettings, getSettings, setPasswordIfInitial } from './bootstrap.js';
import { peekSettings } from './services/settings.js';
import { errorHandler } from './middleware/error.js';
import { COOKIE_NAME } from './middleware/auth.js';
import { verifyToken, ensureBootstrapAdmin } from './services/auth.js';
import { initDb, closeDb, getUserStore } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { gitRouter } from './routes/git.js';
import { keysRouter } from './routes/keys.js';
import { pluginsRouter } from './routes/plugins.js';
import { agentRouter } from './routes/agent.js';
import { uiStateRouter } from './routes/uistate.js';
import { sharesRouter, publicSharesRouter } from './routes/shares.js';
import { sharePageRouter } from './routes/sharepage.js';
import { vaultsRouter, vaultMiddleware } from './routes/vaults.js';
import { adminRouter } from './routes/admin.js';
import { ensureReady, envVaultList, flushAll, getDefaultContext } from './services/vaults.js';
import { setBroadcaster, broadcast } from './services/realtime.js';
import { startAutoSync } from './services/autosync.js';
import { runInVault } from './services/vaultals.js';
import { migrateLegacyEnabled } from './services/plugins.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep the local server alive on stray async errors (e.g. a deferred library task
// throwing) instead of crashing the whole process — log loudly so bugs aren't hidden.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

async function main() {
  await loadSettings();
  await setPasswordIfInitial();
  await initDb(); // users, groups, sessions (SQLite by default, PostgreSQL via DATABASE_URL)
  await ensureBootstrapAdmin();
  setInterval(() => void getUserStore().purgeSessions().catch(() => {}), 6 * 3600_000).unref();
  envVaultList(); // a malformed WEBOBSIDIAN_VAULTS stops startup here

  const app = express();
  // Honour X-Forwarded-* per the deployment's proxy topology (TRUST_PROXY).
  // Default true (trust the immediate hop) so X-Forwarded-Proto-based `Secure`
  // cookies work behind the recommended reverse-proxy setup without extra config.
  // This is safe against F-03: the login rate limiter keys on the TCP socket
  // address (see middleware/ratelimit.ts), not the spoofable X-Forwarded-For.
  // Set TRUST_PROXY=false for a directly-exposed instance with no proxy.
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '32mb' }));
  app.use(cookieParser());

  // Per-request CSP nonce — used by the SSR share page's inline <script>.
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });
  // Security headers. The CSP intentionally does NOT emit `upgrade-insecure-requests`
  // (it would break plain-HTTP self-hosting). `script-src` is 'self' + per-request
  // nonce; `style-src` allows inline styles (React inline styles + the SSR page's
  // <style>). Note: inline <script> inside ```html render-blocks won't execute under
  // this policy — acceptable for the marginal XSS hardening it buys.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            (_req, res) => `'nonce-${(res as Response).locals.cspNonce}'`,
            // Opt-in: some plugins (Excalidraw, …) evaluate strings. Off by default — it weakens XSS protection.
            // Enabled by WEBOBSIDIAN_ALLOW_UNSAFE_EVAL=1 or the "Allow unsafe-eval" switch in Settings → Community plugins.
            () => (process.env.WEBOBSIDIAN_ALLOW_UNSAFE_EVAL === '1' || peekSettings()?.plugins.allowUnsafeEval ? "'unsafe-eval'" : ''),
          ],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          // https: — plugins load web fonts from CDNs (Excalidraw's handwriting fonts); fonts cannot run code.
          fontSrc: ["'self'", 'data:', 'https:'],
          // Loopback targets of requestUrl (Ollama & co. on the user's own machine); other hosts go through the server proxy.
          connectSrc: ["'self'", 'ws:', 'wss:', 'http://localhost:*', 'http://127.0.0.1:*', 'https://localhost:*', 'https://127.0.0.1:*'],
          objectSrc: ["'none'"],
          frameSrc: ["'self'", 'blob:'],
          // Plugins (and the PDF/graph libs) spin up Web Workers from blob: URLs.
          workerSrc: ["'self'", 'blob:'],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      // Allow social crawlers / other sites to load public share og:images.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  if (!config.isProd) {
    app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  }

  // Health (no auth) — for docker healthcheck
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Routes. NOTE: specific /api/* routers must be registered BEFORE the broad
  // '/api' search router, whose router-level requireAuth middleware would
  // otherwise gate every /api/* path (incl. /api/v1 and /api/keys) by prefix.
  app.use('/auth', authRouter);
  app.use('/api/vaults', vaultsRouter); // vault list + management (auth)
  app.use('/api/admin', adminRouter); // users & groups (administrators)
  app.use('/api', vaultMiddleware); // picks the vault of the request (X-Vault / ?vault=)
  app.use('/api/v1', agentRouter); // agent API (api-key auth)
  app.use('/api/files', filesRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/git', gitRouter);
  app.use('/api/keys', keysRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/metadata', metadataRouter);
  app.use('/api/proxy', proxyRouter); // plugin requestUrl() — SSRF-fenced
  app.use('/api/uistate', uiStateRouter);
  app.use('/api/shares', sharesRouter); // manage public share links (auth)
  app.use('/public/shares', publicSharesRouter); // shared-note content (NO auth)
  app.use('/share', sharePageRouter); // SSR public share page (NO auth, SEO/OG meta)
  app.use('/api', searchRouter); // /api/search, /api/tags, /api/backlinks, /api/graph...

  // Static SPA (built into server/public)
  const publicDir = path.join(__dirname, '..', 'public');
  if (await dirExists(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/public')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  // Build search index + link graph
  console.log('[boot] indexing vault...');
  const main = getDefaultContext();
  await ensureReady(main);
  console.log('[boot] index ready');
  await runInVault(main, () => migrateLegacyEnabled());

  const server = http.createServer(app);
  setupWebsocket(server);
  startAutoSync();

  // Remote storage buffers edits (write-behind): commit them before the process exits.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[boot] ${sig}: saving buffered changes...`);
    const done = () => process.exit(0);
    flushAll()
      .catch((e) => console.error('[boot] could not save buffered changes:', e?.message ?? e))
      .then(() => closeDb())
      .catch(() => {})
      .finally(done);
    setTimeout(done, 20_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.port, config.host, () => {
    console.log(`\n  WebObsidian server → http://${config.host}:${config.port}`);
    console.log(`  Vault: ${config.defaultVaultPath}`);
    console.log(`  Data:  ${config.dataDir}\n`);
  });
}

// --- WebSocket: broadcast filesystem & UI-state events to connected clients ----
// Auth-gated: the WS stream leaks vault structure (paths of created/changed/deleted
// files), so the upgrade is rejected unless the request carries a valid session.
function setupWebsocket(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = cookieValue(req.headers.cookie, COOKIE_NAME) ?? bearerToken(req.headers.authorization);
    void (async () => {
      if (!token || !(await verifyToken(token))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    })();
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  setBroadcaster((msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  });
}

/** Parse a single cookie value out of a raw `Cookie:` header (no cookie-parser on upgrade). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
