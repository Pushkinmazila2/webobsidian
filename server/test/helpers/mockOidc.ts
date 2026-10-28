import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/** A tiny OpenID Provider: discovery, authorize (auto-approves as `user`), token (PKCE + client secret checked), JWKS. */
export class MockOidc {
  server!: http.Server;
  url = '';
  clientId = 'webobsidian';
  clientSecret = 'mock-secret';
  /** Who the next authorize call signs in as — claims of the ID token. */
  user: Record<string, unknown> = { sub: 'sub-1', preferred_username: 'carol', email: 'carol@example.com', email_verified: true, name: 'Carol C.', groups: [] };
  /** Tamper switches for negative tests. */
  badNonce = false;
  private codes = new Map<string, { nonce: string; challenge: string; redirect: string; claims: Record<string, unknown> }>();
  private key!: Awaited<ReturnType<typeof generateKeyPair>>;
  private jwk!: JWK;

  async start(): Promise<void> {
    this.key = await generateKeyPair('RS256');
    this.jwk = { ...(await exportJWK(this.key.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> {
    await new Promise((r) => this.server.close(r));
  }

  private json(res: http.ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', this.url);
    if (u.pathname === '/.well-known/openid-configuration') {
      return this.json(res, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        jwks_uri: `${this.url}/jwks`,
        userinfo_endpoint: `${this.url}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (u.pathname === '/jwks') return this.json(res, { keys: [this.jwk] });
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== this.clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return this.json(res, { error: 'invalid_request' }, 400);
      }
      const code = randomBytes(12).toString('hex');
      this.codes.set(code, { nonce: q.get('nonce') ?? '', challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')!, claims: { ...this.user } });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      back.searchParams.set('iss', this.url);
      res.writeHead(302, { location: back.href });
      return void res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const f = new URLSearchParams(body);
      const entry = this.codes.get(f.get('code') ?? '');
      this.codes.delete(f.get('code') ?? '');
      const verifier = f.get('code_verifier') ?? '';
      const ok = entry && f.get('client_secret') === this.clientSecret && f.get('redirect_uri') === entry.redirect &&
        createHash('sha256').update(verifier).digest('base64url') === entry.challenge;
      if (!ok) return this.json(res, { error: 'invalid_grant' }, 400);
      const id = await new SignJWT({ ...entry.claims, nonce: this.badNonce ? 'wrong' : entry.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(this.url)
        .setAudience(this.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.key.privateKey);
      return this.json(res, { access_token: 'at-' + randomBytes(6).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: id });
    }
    if (u.pathname === '/userinfo') return this.json(res, { ...this.user });
    this.json(res, { error: 'not_found' }, 404);
  }
}
