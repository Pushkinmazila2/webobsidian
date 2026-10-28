import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockOidc } from './helpers/mockOidc.js';
import { MockSaml } from './helpers/mockSaml.js';

/** OIDC sign-in and SCIM provisioning against a mock identity provider. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECOVERY = 'recovery-pass-3';

function start(dataDir: string, vault: string, env: Record<string, string> = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  let log = '';
  const proc: ChildProcess = spawn(path.join(serverDir, '../node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, VAULT_PATH: vault, ALLOWED_ROOTS: path.dirname(vault), WEBOBSIDIAN_PASSWORD: RECOVERY, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const kill = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } };
  return { proc, kill, base: `http://127.0.0.1:${port}`, log: () => log };
}

test('[server+sso] OIDC sign-in, provisioning, groups, SCIM', async () => {
  const idp = new MockOidc();
  await idp.start();
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-sso-'));
  const dataDir = path.join(tmp, 'data');
  const vault = path.join(tmp, 'vault');
  await mkdir(dataDir, { recursive: true });
  await mkdir(vault, { recursive: true });
  const s = start(dataDir, vault);
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());

    const call = async (cookie: string, p: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    };
    const admin = await (async () => {
      const r = await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: RECOVERY }) });
      return (r.headers.get('set-cookie') ?? '').split(';')[0];
    })();

    // ---- configure the provider (admin only), secrets are masked on read
    const cfg = { issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, allowInsecureHttp: true, adminGroups: ['wiki-admins'], groupMap: { devs: 'Developers' } };
    assert.equal((await call('', '/api/admin/idps', 'POST', { type: 'oidc', name: 'Mock', config: cfg })).status, 401);
    assert.equal((await call(admin, '/api/admin/idps', 'POST', { type: 'oidc', name: 'Bad', config: { issuer: 'not a url' } })).status, 400);
    const created = await call(admin, '/api/admin/idps', 'POST', { type: 'oidc', name: 'Mock', id: 'mock', config: cfg });
    assert.equal(created.status, 201);
    assert.equal(created.json.provider.config.clientSecret, '••••••••');
    assert.ok(!JSON.stringify((await call(admin, '/api/admin/idps')).json).includes(idp.clientSecret), 'secret is never returned');
    assert.deepEqual((await call('', '/auth/sso/providers')).json.providers, [{ id: 'mock', name: 'Mock', type: 'oidc' }]);

    // ---- the browser dance: login → IdP → callback
    const signIn = async (returnTo = '/') => {
      const login = await fetch(`${s.base}/auth/sso/mock/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
      assert.equal(login.status, 302, await login.text());
      const stateCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const authz = await fetch(login.headers.get('location')!, { redirect: 'manual' });
      assert.equal(authz.status, 302);
      const cb = await fetch(authz.headers.get('location')!.replace(idp.url, s.base).replace(/^[^/]+\/\/[^/]+/, s.base), { redirect: 'manual', headers: { cookie: stateCookie } });
      const cookies = (cb.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
      return { cb, location: cb.headers.get('location') ?? '', session: cookies.find((c) => c.startsWith('webobsidian_token=')) ?? '', stateCookie, authzLocation: authz.headers.get('location')! };
    };

    idp.user = { sub: 'sub-1', preferred_username: 'carol', email: 'carol@example.com', email_verified: true, name: 'Carol C.', groups: ['devs', 'qa'] };
    const first = await signIn('/Notes/a.md');
    assert.equal(first.cb.status, 302);
    assert.equal(first.location, '/Notes/a.md', 'returns to where the person was going');
    assert.ok(first.session, 'session cookie set');
    const me = (await call(first.session, '/auth/me')).json;
    assert.equal(me.user.username, 'carol');
    assert.equal(me.user.displayName, 'Carol C.');
    assert.equal(me.user.isAdmin, false);
    assert.deepEqual([...me.user.groups].sort(), ['Developers', 'qa'], 'groupMap renames devs; others keep their name');
    assert.equal((await call(first.session, '/api/admin/users')).status, 403);

    // same person again → same account; groups follow the IdP, admin comes from adminGroups
    idp.user = { ...idp.user, groups: ['qa', 'wiki-admins'] };
    const second = await signIn();
    const me2 = (await call(second.session, '/auth/me')).json;
    assert.equal(me2.user.id, me.user.id, 'no duplicate account');
    assert.deepEqual([...me2.user.groups].sort(), ['qa', 'wiki-admins']);
    assert.equal(me2.user.isAdmin, true, 'member of an admin group');
    assert.equal((await call(second.session, '/api/admin/users')).status, 200);
    idp.user = { ...idp.user, groups: ['qa'] };
    assert.equal((await call((await signIn()).session, '/auth/me')).json.user.isAdmin, false, 'demoted when the IdP drops the group');
    assert.equal((await call(admin, '/api/admin/users')).json.users.filter((u: any) => u.username.startsWith('carol')).length, 1);

    // a returnTo that leaves the site is ignored
    assert.equal((await signIn('//evil.example/x')).location, '/');
    assert.equal((await signIn('https://evil.example/')).location, '/');

    // an unverified e-mail never takes over a local account; a different subject with a taken username gets a fresh one
    await call(admin, '/api/admin/users', 'POST', { username: 'dave', email: 'dave@example.com', password: 'password-1', mustChangePassword: false });
    idp.user = { sub: 'sub-2', preferred_username: 'dave', email: 'dave@example.com', email_verified: true, name: 'Dave IdP', groups: [] };
    const dave = await signIn();
    const daveMe = (await call(dave.session, '/auth/me')).json.user;
    assert.notEqual(daveMe.username, 'dave', 'not merged into the local account (autoLinkByEmail is off)');
    assert.match(daveMe.username, /^dave-\d+$/);

    // security: tampered state / replayed / missing cookie / wrong nonce → refused, no session
    const login = await fetch(`${s.base}/auth/sso/mock/login`, { redirect: 'manual' });
    const stateCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const authz = await fetch(login.headers.get('location')!, { redirect: 'manual' });
    const back = new URL(authz.headers.get('location')!);
    const cbPath = `${back.pathname}${back.search}`;
    const noCookie = await fetch(s.base + cbPath, { redirect: 'manual' });
    assert.match(noCookie.headers.get('location') ?? '', /sso_error/);
    assert.ok(!(noCookie.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('webobsidian_token=')));
    const tampered = await fetch(s.base + cbPath.replace(/state=[^&]+/, 'state=forged'), { redirect: 'manual', headers: { cookie: stateCookie } });
    assert.match(tampered.headers.get('location') ?? '', /sso_error/);
    idp.badNonce = true;
    const wrongNonce = await signIn();
    idp.badNonce = false;
    assert.match(wrongNonce.location, /sso_error/);
    assert.equal(wrongNonce.session, '');

    // disabled accounts cannot sign in through the IdP either
    const carolId = me.user.id as string;
    await call(admin, `/api/admin/users/${carolId}`, 'PATCH', { disabled: true });
    idp.user = { sub: 'sub-1', preferred_username: 'carol', email: 'carol@example.com', email_verified: true, groups: [] };
    const blocked = await signIn();
    assert.match(blocked.location, /sso_error=.*disabled/i);
    assert.equal(blocked.session, '');
    await call(admin, `/api/admin/users/${carolId}`, 'PATCH', { disabled: false });

    // provisioning off: only people who already exist may come in
    await call(admin, '/api/admin/idps/mock', 'PATCH', { config: { autoProvision: false } });
    idp.user = { sub: 'sub-9', preferred_username: 'nobody', email: 'nobody@example.com', email_verified: true, groups: [] };
    const denied = await signIn();
    assert.match(denied.location, /sso_error=.*provision/i);
    await call(admin, '/api/admin/idps/mock', 'PATCH', { config: { autoProvision: true } });
    assert.equal((await call(admin, '/api/admin/idps')).json.providers[0].config.autoProvision, true);
    assert.equal((await call(admin, '/api/admin/idps')).json.providers[0].config.clientSecret, '••••••••', 'update without a secret keeps the stored one');
    const nobody = await signIn();
    assert.equal((await call(nobody.session, '/auth/me')).json.user.username, 'nobody', 'provisioning back on: the account is created')

    // ---- SCIM
    const tok = await call(admin, '/api/admin/scim-tokens', 'POST', { name: 'Entra' });
    assert.equal(tok.status, 201);
    const scim = (p: string, method = 'GET', body?: unknown) => call('', '/scim/v2' + p, method, body, { authorization: `Bearer ${tok.json.token}`, 'content-type': 'application/scim+json' });
    assert.equal((await call('', '/scim/v2/Users')).status, 401);
    assert.equal((await call('', '/scim/v2/Users', 'GET', undefined, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await scim('/ServiceProviderConfig')).json.patch.supported, true);

    const u1 = await scim('/Users', 'POST', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'erin@example.com', externalId: 'ext-erin', displayName: 'Erin E.', emails: [{ value: 'Erin@Example.com', primary: true }], active: true });
    assert.equal(u1.status, 201, JSON.stringify(u1.json));
    assert.equal(u1.json.userName, 'erin@example.com');
    assert.equal(u1.json.active, true);
    assert.equal((await scim('/Users', 'POST', { userName: 'erin@example.com' })).status, 409);
    const found = await scim(`/Users?filter=${encodeURIComponent('userName eq "erin@example.com"')}`);
    assert.equal(found.json.totalResults, 1);
    assert.equal((await scim(`/Users?filter=${encodeURIComponent('externalId eq "ext-erin"')}`)).json.Resources[0].id, u1.json.id);

    // the SCIM-created person signs in via the IdP and lands on THAT account (matched by e-mail, no password needed)
    idp.user = { sub: 'sub-erin', preferred_username: 'erin', email: 'erin@example.com', email_verified: true, name: 'Erin E.', groups: [] };
    const erin = await signIn();
    assert.equal((await call(erin.session, '/auth/me')).json.user.id, u1.json.id);

    // groups via SCIM, and the group's ACL meaning
    const g = await scim('/Groups', 'POST', { displayName: 'Engineering', members: [{ value: u1.json.id }] });
    assert.equal(g.status, 201);
    assert.deepEqual((await call(erin.session, '/auth/me')).json.user.groups, ['Engineering']);
    assert.equal((await scim(`/Groups/${g.json.id}`, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: `members[value eq "${u1.json.id}"]` }] })).json.members.length, 0);
    assert.equal((await scim(`/Groups/${g.json.id}`, 'PATCH', { Operations: [{ op: 'add', path: 'members', value: [{ value: u1.json.id }] }] })).json.members.length, 1);
    assert.equal((await scim('/Groups', 'POST', { displayName: 'engineering' })).status, 409);

    // a rule on the group, then deleting the group removes the rule
    await call(admin, '/api/admin/acl/rules', 'POST', { subjectType: 'group', subjectId: g.json.id, pattern: 'Eng', level: 'write' });
    assert.equal((await call(admin, '/api/admin/acl')).json.rules.length, 1);
    assert.equal((await scim(`/Groups/${g.json.id}`, 'DELETE')).status, 204);
    assert.equal((await call(admin, '/api/admin/acl')).json.rules.length, 0, 'rules of a deleted group are removed');

    // deprovisioning: active=false signs the person out at once and blocks the next sign-in (Entra style string "False")
    assert.equal((await call(erin.session, '/auth/me')).status, 200);
    const off = await scim(`/Users/${u1.json.id}`, 'PATCH', { Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    assert.equal(off.json.active, false);
    assert.equal((await call(erin.session, '/auth/me')).status, 401, 'existing session revoked');
    assert.match((await signIn()).location, /sso_error/);
    assert.equal((await scim(`/Users/${u1.json.id}`, 'PATCH', { Operations: [{ op: 'replace', value: { active: true, displayName: 'Erin Renamed' } }] })).json.displayName, 'Erin Renamed');

    // boundaries: local accounts and the last administrator are out of reach
    const local = (await call(admin, '/api/admin/users')).json.users.find((u: any) => u.username === 'admin');
    assert.equal((await scim(`/Users/${local.id}`, 'PATCH', { Operations: [{ op: 'replace', path: 'active', value: false }] })).status, 403);
    assert.equal((await scim(`/Users/${local.id}`, 'DELETE')).status, 403);
    assert.equal((await scim('/Users/does-not-exist')).status, 404);
    assert.equal((await scim(`/Users/${u1.json.id}`, 'DELETE')).status, 204);
    assert.equal((await scim(`/Users/${u1.json.id}`)).status, 404);

    // revoked tokens stop working
    assert.equal((await call(admin, `/api/admin/scim-tokens/${tok.json.id}`, 'DELETE')).status, 200);
    assert.equal((await scim('/Users')).status, 401);
  } finally {
    s.kill();
    await idp.stop();
  }
});

test('[server+sso] SAML sign-in: signed assertions only, bound to our request', async () => {
  const idp = new MockSaml();
  const tmp = await mkdtemp(path.join(tmpdir(), 'wobs-saml-'));
  const dataDir = path.join(tmp, 'data');
  const vault = path.join(tmp, 'vault');
  await mkdir(dataDir, { recursive: true });
  await mkdir(vault, { recursive: true });
  const s = start(dataDir, vault, { PUBLIC_URL: 'https://notes.example.com' });
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${s.base}/auth/status`)).ok; } catch { await sleep(150); }
    }
    assert.ok(up, 'did not start:\n' + s.log());
    const call = async (cookie: string, p: string, method = 'GET', body?: unknown) => {
      const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, text: await r.text(), json: undefined as any };
    };
    const jcall = async (cookie: string, p: string, method = 'GET', body?: unknown) => {
      const r = await call(cookie, p, method, body);
      try { r.json = JSON.parse(r.text); } catch { /* not json */ }
      return r;
    };
    const admin = (await (await fetch(`${s.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: RECOVERY }) })).headers.get('set-cookie') ?? '').split(';')[0];

    const SP = 'https://notes.example.com/auth/sso/corp/metadata';
    const ACS = 'https://notes.example.com/auth/sso/corp/acs';
    assert.equal((await jcall(admin, '/api/admin/idps', 'POST', { type: 'saml', id: 'corp', name: 'Corp SAML', config: { entryPoint: idp.entryPoint, issuer: SP, idpIssuer: idp.entityId, cert: 'short' } })).status, 400, 'certificate required');
    const made = await jcall(admin, '/api/admin/idps', 'POST', {
      type: 'saml', id: 'corp', name: 'Corp SAML',
      config: { entryPoint: idp.entryPoint, issuer: SP, idpIssuer: idp.entityId, cert: idp.cert, groupsClaim: 'groups', adminGroups: ['SAML-Admins'], emailAttribute: 'email', nameAttribute: 'displayName' },
    });
    assert.equal(made.status, 201, made.text);

    // SP metadata for the IdP administrator
    const meta = await call('', '/auth/sso/corp/metadata');
    assert.equal(meta.status, 200);
    assert.ok(meta.text.includes(ACS) && meta.text.includes(SP), meta.text.slice(0, 400));

    const start1 = async () => {
      const r = await fetch(`${s.base}/auth/sso/corp/login?returnTo=${encodeURIComponent('/Docs/x.md')}`, { redirect: 'manual' });
      assert.equal(r.status, 302);
      const loc = r.headers.get('location')!;
      assert.ok(loc.startsWith(idp.entryPoint), loc);
      return { reqId: idp.requestId(loc), relay: new URL(loc).searchParams.get('RelayState')! };
    };
    const post = async (SAMLResponse: string, RelayState: string) => {
      const r = await fetch(`${s.base}/auth/sso/corp/acs`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse, RelayState }).toString() });
      const cookies = r.headers.getSetCookie?.() ?? [];
      return { status: r.status, location: r.headers.get('location') ?? '', session: (cookies.find((c) => c.startsWith('webobsidian_token=')) ?? '').split(';')[0] };
    };
    const base = { destination: ACS, audience: SP, nameId: 'frank@corp.example' };
    const attrs = { email: ['frank@corp.example'], displayName: ['Frank F.'], groups: ['Staff', 'SAML-Admins'] };

    // a good, signed response bound to our request
    const a = await start1();
    const ok = await post(idp.response({ ...base, inResponseTo: a.reqId, attrs }), a.relay);
    assert.equal(ok.status, 302, JSON.stringify(ok) + s.log().slice(-600));
    assert.equal(ok.location, '/Docs/x.md');
    const me = (await jcall(ok.session, '/auth/me')).json.user;
    assert.equal(me.username, 'frank');
    assert.equal(me.displayName, 'Frank F.');
    assert.equal(me.isAdmin, true, 'SAML-Admins → administrator');
    assert.deepEqual([...me.groups].sort(), ['SAML-Admins', 'Staff']);

    // replay of the very same response
    assert.match((await post(idp.response({ ...base, inResponseTo: a.reqId, attrs }), a.relay)).location, /sso_error/);

    // refused: unsigned, signed with someone else's key, wrong audience, expired, IdP-initiated, forged relay state
    const refuse = async (label: string, mk: (reqId: string) => string, relay?: (r: string) => string) => {
      const x = await start1();
      const r = await post(mk(x.reqId), relay ? relay(x.relay) : x.relay);
      assert.match(r.location, /sso_error/, label);
      assert.equal(r.session, '', label);
    };
    await refuse('unsigned', (id) => idp.response({ ...base, inResponseTo: id, attrs, sign: 'none' }));
    await refuse('wrong key', (id) => idp.response({ ...base, inResponseTo: id, attrs, sign: 'wrong-key' }));
    await refuse('wrong audience', (id) => idp.response({ ...base, audience: 'https://other.example/sp', inResponseTo: id, attrs }));
    await refuse('wrong issuer', (id) => idp.response({ ...base, inResponseTo: id, attrs, issuer: 'https://evil.example/idp' }));
    await refuse('expired', (id) => idp.response({ ...base, inResponseTo: id, attrs, validForSeconds: -3600 }));
    await refuse('answers a request we never made', () => idp.response({ ...base, inResponseTo: '_never-asked', attrs }));
    await refuse('IdP-initiated (no InResponseTo)', () => idp.response({ ...base, attrs }));
    await refuse('forged relay state', (id) => idp.response({ ...base, inResponseTo: id, attrs }), () => 'f'.repeat(32));
    assert.equal((await post(idp.response({ ...base, inResponseTo: 'x', attrs }), '')).session, '', 'no relay state');
    assert.equal((await fetch(`${s.base}/auth/sso/corp/acs`, { method: 'POST', redirect: 'manual' })).status, 302, 'empty POST is handled, not a crash');

    // a disabled provider is not reachable
    await jcall(admin, '/api/admin/idps/corp', 'PATCH', { enabled: false });
    assert.equal((await fetch(`${s.base}/auth/sso/corp/login`, { redirect: 'manual' })).status, 404);
    assert.deepEqual((await jcall('', '/auth/sso/providers')).json.providers, []);
  } finally {
    s.kill();
  }
});
