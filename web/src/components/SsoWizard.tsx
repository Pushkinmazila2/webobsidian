import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Note, Row } from './StorageSettings';

/** Guided setup of an OpenID Connect sign-in for Authelia, Authentik or Keycloak (or any other OIDC provider). */
type Product = 'authelia' | 'authentik' | 'keycloak' | 'oidc';

const PRODUCTS: Record<Product, { label: string; blurb: string }> = {
  authelia: { label: 'Authelia', blurb: 'Self-hosted SSO portal with its own OIDC provider.' },
  authentik: { label: 'Authentik', blurb: 'Self-hosted identity provider (OAuth2/OpenID provider + application).' },
  keycloak: { label: 'Keycloak', blurb: 'Red Hat / CNCF identity server with realms.' },
  oidc: { label: 'Other OIDC', blurb: 'Any provider that publishes /.well-known/openid-configuration.' },
};

const trim = (s: string) => s.trim().replace(/\/+$/, '');
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

function Copy({ text }: { text: string }) {
  const notify = useStore((s) => s.notify);
  return (
    <pre style={{ background: 'var(--background-secondary)', padding: 8, borderRadius: 6, overflow: 'auto', fontSize: 12, userSelect: 'all', position: 'relative' }}>
      {text}
      <button className="btn secondary" style={{ position: 'absolute', top: 4, right: 4, padding: '0 8px' }}
        onClick={() => void navigator.clipboard.writeText(text).then(() => notify('Copied'))}>Copy</button>
    </pre>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ margin: '14px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{n}. {title}</div>
      {children}
    </div>
  );
}

function providerSteps(product: Product, p: { callback: string; clientId: string; realm: string; slug: string; group: string }): ReactNode {
  if (product === 'authelia') {
    return (
      <>
        <p>Generate a client secret (keep the plain secret for step 3, put the hash in Authelia):</p>
        <Copy text={'authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72 --random.charset rfc3986'} />
        <p>Add this client to <code>identity_providers.oidc.clients</code> in Authelia’s configuration and restart it:</p>
        <Copy text={`- client_id: '${p.clientId}'
  client_name: 'WebObsidian'
  client_secret: '$pbkdf2-sha512$…the digest from the command…'
  public: false
  authorization_policy: 'two_factor'   # or 'one_factor'
  redirect_uris:
    - '${p.callback}'
  scopes: ['openid', 'profile', 'email', 'groups']
  token_endpoint_auth_method: 'client_secret_post'`} />
        <Note kind="info">WebObsidian sends the secret in the request body, so Authelia must allow <code>client_secret_post</code> (set above). Authelia’s address must be https.</Note>
      </>
    );
  }
  if (product === 'authentik') {
    return (
      <ol style={{ paddingLeft: 18 }}>
        <li>Applications → <b>Create with Provider</b>; name it WebObsidian and set the slug to <code>{p.slug}</code>.</li>
        <li>Provider type <b>OAuth2/OpenID Provider</b>; Client type <b>Confidential</b>; Client ID <code>{p.clientId}</code>.</li>
        <li>Redirect URIs/Origins (strict): <code>{p.callback}</code></li>
        <li>Choose a <b>Signing key</b> (e.g. the authentik self-signed key) and keep scopes <code>openid</code>, <code>email</code>, <code>profile</code> (the profile scope carries <code>groups</code>).</li>
        <li>Save, open the provider and copy the <b>Client Secret</b> for step 3. Bind the application to the users or groups that may sign in.</li>
      </ol>
    );
  }
  if (product === 'keycloak') {
    return (
      <ol style={{ paddingLeft: 18 }}>
        <li>Realm <code>{p.realm || '…'}</code> → Clients → <b>Create client</b>: type OpenID Connect, Client ID <code>{p.clientId}</code>.</li>
        <li>Turn <b>Client authentication</b> ON; leave only <b>Standard flow</b> checked.</li>
        <li>Valid redirect URIs: <code>{p.callback}</code></li>
        <li>Credentials tab → copy the <b>Client secret</b> for step 3.</li>
        <li>For groups: Clients → {p.clientId} → Client scopes → <i>{p.clientId}-dedicated</i> → Add mapper → <b>Group Membership</b>; Token claim name <code>groups</code>, <b>Full group path OFF</b>, Add to ID token ON.</li>
      </ol>
    );
  }
  return (
    <ol style={{ paddingLeft: 18 }}>
      <li>Register a confidential client with the Authorization Code flow (PKCE is used).</li>
      <li>Redirect URI: <code>{p.callback}</code></li>
      <li>Allow the scopes below and, if you want groups, make the provider emit a <code>groups</code> claim.</li>
      <li>The token endpoint must accept the secret as <code>client_secret_post</code>.</li>
    </ol>
  );
}

export default function SsoWizard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const notify = useStore((s) => s.notify);
  const [product, setProduct] = useState<Product>('authelia');
  const [base, setBase] = useState('');
  const [slug, setSlug] = useState('webobsidian'); // Authentik application slug
  const [realm, setRealm] = useState('');
  const [issuerManual, setIssuerManual] = useState('');
  const [clientId, setClientId] = useState('webobsidian');
  const [secret, setSecret] = useState('');
  const [useEnv, setUseEnv] = useState(false);
  const [envName, setEnvName] = useState('');
  const [adminGroup, setAdminGroup] = useState('');
  const [autoProvision, setAutoProvision] = useState(true);
  const [autoLink, setAutoLink] = useState(false);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [callback, setCallback] = useState('');
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  // Sensible names follow the product until the person types their own.
  useEffect(() => { setName(PRODUCTS[product].label); setId(product === 'oidc' ? 'sso' : product); setCheck(null); }, [product]);
  useEffect(() => { setEnvName(`SSO_${id.toUpperCase().replace(/-/g, '_')}_SECRET`); }, [id]);
  useEffect(() => {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return setCallback('');
    api.admin(`/idps/redirect-uri?id=${encodeURIComponent(id)}`).then((r) => setCallback(r.callback)).catch(() => setCallback(''));
  }, [id]);

  const issuer = useMemo(() => {
    const b = trim(base);
    if (product === 'authelia') return b;
    if (product === 'authentik') return b ? `${b}/application/o/${slug}/` : '';
    if (product === 'keycloak') return b && realm ? `${b}/realms/${realm}` : '';
    return trim(issuerManual);
  }, [product, base, slug, realm, issuerManual]);

  const scopes = product === 'authelia' ? 'openid profile email groups' : 'openid profile email';
  const ready = Boolean(issuer && clientId && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && name.trim() && (useEnv ? envName : secret));

  const test = async () => {
    setBusy(true);
    try { setCheck(await api.admin('/idps/test', 'POST', { issuer, allowInsecureHttp: issuer.startsWith('http://') })); }
    catch (e: any) { setCheck({ ok: false, error: e.message }); }
    finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true);
    try {
      await api.admin('/idps', 'POST', {
        id, type: 'oidc', name: name.trim(),
        config: {
          issuer, clientId, scopes, groupsFromUserinfo: true,
          clientSecret: useEnv ? '' : secret, clientSecretEnv: useEnv ? envName : '',
          allowInsecureHttp: issuer.startsWith('http://'),
          autoProvision, autoLinkByEmail: autoLink,
          adminGroups: adminGroup.trim() ? [adminGroup.trim()] : [],
        },
      });
      notify(`${name} added — the sign-in button is on the login page`, 5000);
      onDone();
    } catch (e: any) { notify(e.message ?? String(e), 6000); }
    finally { setBusy(false); }
  };

  const box = { border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: 12, margin: '8px 0' } as const;
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, fontSize: 15 }}>Single sign-on setup</div>
      <Step n={1} title="Which identity provider?">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(Object.keys(PRODUCTS) as Product[]).map((k) => (
            <button key={k} className={k === product ? 'btn' : 'btn secondary'} title={PRODUCTS[k].blurb} onClick={() => setProduct(k)}>{PRODUCTS[k].label}</button>
          ))}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{PRODUCTS[product].blurb}</div>
      </Step>

      <Step n={2} title="Where is it?">
        {product === 'oidc' ? (
          <Row name="Issuer address" desc="Exactly the issuer the provider publishes."><input className="text-input" style={{ width: 300 }} placeholder="https://idp.example.com" value={issuerManual} onChange={(e) => setIssuerManual(e.target.value)} /></Row>
        ) : (
          <Row name={`${PRODUCTS[product].label} address`} desc={product === 'keycloak' ? 'Server address without /realms (Keycloak up to 16: include /auth).' : 'Public address people use to reach it.'}>
            <input className="text-input" style={{ width: 300 }} placeholder={product === 'authelia' ? 'https://auth.example.com' : 'https://sso.example.com'} value={base} onChange={(e) => setBase(e.target.value)} />
          </Row>
        )}
        {product === 'authentik' && <Row name="Application slug" desc="The slug you give the application in authentik."><input className="text-input" value={slug} onChange={(e) => setSlug(slugOf(e.target.value))} /></Row>}
        {product === 'keycloak' && <Row name="Realm" desc="Name of the realm that holds your users."><input className="text-input" value={realm} onChange={(e) => setRealm(e.target.value.trim())} /></Row>}
        <Row name="Client ID" desc="You will create a client with this ID in the provider."><input className="text-input" value={clientId} onChange={(e) => setClientId(e.target.value.trim())} /></Row>
        <Row name="Button name" desc="Shown on the sign-in page."><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} /></Row>
        <Row name="Short id" desc="Part of the return address (letters, digits, dashes)."><input className="text-input" value={id} onChange={(e) => setId(slugOf(e.target.value))} /></Row>
        {issuer && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Issuer: <code>{issuer}</code></div>}
      </Step>

      <Step n={3} title={`Create the client in ${PRODUCTS[product].label}`}>
        {callback ? (
          <>
            <div>Return (redirect) address to register:</div>
            <Copy text={callback} />
            {providerSteps(product, { callback, clientId, realm, slug, group: adminGroup })}
            <Note kind="info">If WebObsidian runs behind a proxy, set <code>PUBLIC_URL</code> so this address is the public one.</Note>
          </>
        ) : <span style={{ color: 'var(--text-muted)' }}>Enter a valid short id first.</span>}
        <Row name="Client secret" desc={useEnv ? 'Name of the environment variable that holds it (recommended).' : 'Stored in the database; hidden after saving.'}>
          {useEnv
            ? <input className="text-input" value={envName} onChange={(e) => setEnvName(e.target.value)} />
            : <input className="text-input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}
        </Row>
        <label style={{ fontSize: 12 }}><input type="checkbox" checked={useEnv} onChange={(e) => setUseEnv(e.target.checked)} /> Read the secret from an environment variable instead of storing it</label>
      </Step>

      <Step n={4} title="People">
        <Row name="Administrator group" desc="Members of this provider group become administrators (optional)."><input className="text-input" placeholder="e.g. webobsidian-admins" value={adminGroup} onChange={(e) => setAdminGroup(e.target.value)} /></Row>
        <label style={{ display: 'block' }}><input type="checkbox" checked={autoProvision} onChange={(e) => setAutoProvision(e.target.checked)} /> Create an account the first time someone signs in</label>
        <label style={{ display: 'block' }}><input type="checkbox" checked={autoLink} onChange={(e) => setAutoLink(e.target.checked)} /> Link to an existing local account with the same verified e-mail</label>
        {autoLink && <Note kind="warn">Only enable this if the provider verifies e-mail addresses: otherwise someone could take over an account by registering its address.</Note>}
      </Step>

      <Step n={5} title="Check and save">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn secondary" disabled={!issuer || busy} onClick={test}>Check connection</button>
          <button className="btn" disabled={!ready || busy} onClick={create}>Add provider</button>
          <button className="btn secondary" onClick={onCancel}>Cancel</button>
        </div>
        {check && (
          check.ok
            ? <Note kind="ok">Connected. {check.pkce === false ? 'The provider does not advertise PKCE (S256) — sign-in may be refused. ' : ''}{product === 'authelia' && Array.isArray(check.scopes) && !check.scopes.includes('groups') ? 'It does not list the “groups” scope: groups will not sync.' : ''}</Note>
            : <Note kind="error">{check.error}</Note>
        )}
      </Step>
    </div>
  );
}
