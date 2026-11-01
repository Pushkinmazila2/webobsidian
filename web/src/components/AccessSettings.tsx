import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Note, Row } from './StorageSettings';

/** Settings → Users & access (administrators): people, groups, folder permissions, single sign-on. */
type Tab = 'users' | 'groups' | 'access' | 'sso';
const LEVELS = ['none', 'read', 'comment', 'write', 'manage'];

const box = { border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: 10, margin: '8px 0' } as const;
const line = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const;
const muted = { color: 'var(--text-muted)', fontSize: 12 } as const;

function useAction() {
  const notify = useStore((s) => s.notify);
  return useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) notify(ok);
      return true;
    } catch (e: any) {
      notify(e?.message ?? String(e), 5000);
      return false;
    }
  }, [notify]);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div style={{ marginTop: 16 }}><div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>{children}</div>;
}

// ---- users ------------------------------------------------------------------------------
function Users() {
  const [users, setUsers] = useState<any[]>([]);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', isAdmin: false });
  const [sessions, setSessions] = useState<{ id: string; list: any[] } | null>(null);
  const act = useAction();
  const load = () => api.admin('/users').then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => { void load(); }, []);

  const create = async () => {
    const ok = await act(() => api.admin('/users', 'POST', { ...form, displayName: form.displayName || undefined, password: form.password || undefined }), 'User created');
    if (ok) { setForm({ username: '', displayName: '', password: '', isAdmin: false }); void load(); }
  };
  const patch = async (id: string, body: object, ok: string) => { if (await act(() => api.admin(`/users/${id}`, 'PATCH', body), ok)) void load(); };

  return (
    <>
      <Section title="Add a person">
        <div style={line}>
          <input className="text-input" placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className="text-input" placeholder="display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <input className="text-input" type="password" placeholder="password (blank = SSO only)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <label><input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} /> admin</label>
          <button className="btn" disabled={!form.username} onClick={create}>Add</button>
        </div>
        <Note kind="info">A person given a password must choose a new one at first sign-in.</Note>
      </Section>
      <Section title={`People (${users.length})`}>
        {users.map((u) => (
          <div key={u.id} style={box}>
            <div style={line}>
              <b>{u.displayName || u.username}</b>
              <span style={muted}>{u.username}{u.email ? ` · ${u.email}` : ''} · {u.source}{u.managed ? ' · managed' : ''}</span>
              {u.isAdmin && <span className="tag">admin</span>}
              {u.disabled && <span className="tag">disabled</span>}
              <span style={{ ...muted, marginLeft: 'auto' }}>{u.lastLoginAt ? `last sign-in ${new Date(u.lastLoginAt).toLocaleString()}` : 'never signed in'}</span>
            </div>
            <div style={muted}>Groups: {u.groups.length ? u.groups.join(', ') : '—'}</div>
            {!u.managed && (
              <div style={{ ...line, marginTop: 6 }}>
                <button className="btn secondary" onClick={() => patch(u.id, { disabled: !u.disabled }, u.disabled ? 'Enabled' : 'Disabled and signed out')}>{u.disabled ? 'Enable' : 'Disable'}</button>
                <button className="btn secondary" onClick={() => patch(u.id, { isAdmin: !u.isAdmin }, 'Updated')}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                <button className="btn secondary" onClick={() => { const pw = window.prompt(`New password for ${u.username} (min 6 characters)`); if (pw) void patch(u.id, { password: pw }, 'Password set; the person was signed out'); }}>Reset password</button>
                <button className="btn secondary" onClick={async () => setSessions(sessions?.id === u.id ? null : { id: u.id, list: (await api.admin(`/users/${u.id}/sessions`)).sessions })}>Sessions</button>
                <button className="btn secondary" onClick={async () => { if (window.confirm(`Delete ${u.username}?`) && await act(() => api.admin(`/users/${u.id}`, 'DELETE'), 'Deleted')) void load(); }}>Delete</button>
              </div>
            )}
            {sessions && sessions.id === u.id && (
              <div style={{ marginTop: 6 }}>
                {sessions.list.length === 0 && <span style={muted}>No active sessions.</span>}
                {sessions.list.map((x) => <div key={x.id} style={muted}>{x.ip ?? '?'} · {x.userAgent ?? '?'} · last seen {new Date(x.lastSeenAt).toLocaleString()}</div>)}
                {sessions.list.length > 0 && <button className="btn secondary" onClick={async () => { await act(() => api.admin(`/users/${u.id}/revoke-sessions`, 'POST'), 'Signed out everywhere'); setSessions(null); }}>Sign out everywhere</button>}
              </div>
            )}
          </div>
        ))}
      </Section>
    </>
  );
}

// ---- groups -----------------------------------------------------------------------------
function Groups() {
  const [groups, setGroups] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState<{ id: string; members: any[] } | null>(null);
  const act = useAction();
  const load = () => {
    api.admin('/groups').then((r) => setGroups(r.groups)).catch(() => {});
    api.admin('/users').then((r) => setUsers(r.users)).catch(() => {});
  };
  useEffect(load, []);
  const members = async (id: string) => setOpen({ id, members: (await api.admin(`/groups/${id}/members`)).members });

  return (
    <>
      <Section title="New group">
        <div style={line}>
          <input className="text-input" placeholder="group name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={!name.trim()} onClick={async () => { if (await act(() => api.admin('/groups', 'POST', { name: name.trim() }), 'Group created')) { setName(''); load(); } }}>Create</button>
        </div>
      </Section>
      <Section title={`Groups (${groups.length})`}>
        {groups.map((g) => (
          <div key={g.id} style={box}>
            <div style={line}>
              <b>{g.name}</b><span style={muted}>{g.members ?? 0} member(s) · {g.source}{g.managed ? ' · managed' : ''}</span>
              <button className="btn secondary" style={{ marginLeft: 'auto' }} onClick={() => (open?.id === g.id ? setOpen(null) : void members(g.id))}>Members</button>
              {!g.managed && <button className="btn secondary" onClick={async () => { if (window.confirm(`Delete group ${g.name}? Its access rules are removed too.`) && await act(() => api.admin(`/groups/${g.id}`, 'DELETE'), 'Deleted')) { setOpen(null); load(); } }}>Delete</button>}
            </div>
            {open && open.id === g.id && (
              <div style={{ marginTop: 6 }}>
                {open.members.map((m) => (
                  <div key={m.id} style={line}>
                    {m.displayName || m.username}
                    {!g.managed && <button className="btn secondary" style={{ padding: '0 8px' }} onClick={async () => { await act(() => api.admin(`/groups/${g.id}/members/${m.id}`, 'DELETE')); void members(g.id); load(); }}>remove</button>}
                  </div>
                ))}
                {!g.managed && (
                  <select className="dropdown" value="" onChange={async (e) => { if (e.target.value) { await act(() => api.admin(`/groups/${g.id}/members/${e.target.value}`, 'PUT')); void members(g.id); load(); } }}>
                    <option value="">Add a person…</option>
                    {users.filter((u) => !open.members.some((m) => m.id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName || u.username}</option>)}
                  </select>
                )}
              </div>
            )}
          </div>
        ))}
      </Section>
    </>
  );
}

// ---- folder permissions -----------------------------------------------------------------
function Access() {
  const [vaults, setVaults] = useState<{ id: string; name: string }[]>([]);
  const [vault, setVault] = useState('default');
  const [acl, setAcl] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [rule, setRule] = useState({ subject: 'everyone', pattern: '', level: 'read', effect: 'allow' });
  const [check, setCheck] = useState({ user: '', path: '' });
  const [checked, setChecked] = useState('');
  const act = useAction();
  const load = useCallback(() => api.admin(`/acl?vault=${encodeURIComponent(vault)}`).then(setAcl).catch(() => {}), [vault]);
  useEffect(() => {
    api.listVaults().then((r) => setVaults(r.vaults)).catch(() => {});
    api.admin('/users').then((r) => setUsers(r.users)).catch(() => {});
    api.admin('/groups').then((r) => setGroups(r.groups)).catch(() => {});
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    const [type, id] = rule.subject.split(':');
    const body = { vault, subjectType: type, subjectId: id, pattern: rule.pattern, level: rule.level, effect: rule.effect };
    if (await act(() => api.admin('/acl/rules', 'POST', body), 'Rule added')) { setRule({ ...rule, pattern: '' }); void load(); }
  };

  return (
    <>
      <Note kind="info">Nobody sees a vault until it is granted. The most specific folder rule wins; a deny caps access below its level. Administrators always have full access.</Note>
      <Row name="Vault" desc="Rules are per vault.">
        <select className="dropdown" value={vault} onChange={(e) => setVault(e.target.value)}>
          {vaults.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Row>
      {acl && (
        <>
          <Row name="Default access" desc="For people no rule mentions.">
            <select className="dropdown" value={acl.default} onChange={async (e) => { await act(() => api.admin('/acl/default', 'PUT', { vault, level: e.target.value })); void load(); }}>
              {LEVELS.map((l) => <option key={l}>{l}</option>)}
            </select>
          </Row>
          <Section title="Rules">
            <div style={{ ...line, ...box }}>
              <select className="dropdown" value={rule.subject} onChange={(e) => setRule({ ...rule, subject: e.target.value })}>
                <option value="everyone">Everyone</option>
                {groups.map((g) => <option key={g.id} value={`group:${g.id}`}>Group: {g.name}</option>)}
                {users.map((u) => <option key={u.id} value={`user:${u.id}`}>Person: {u.displayName || u.username}</option>)}
              </select>
              <input className="text-input" placeholder="folder or pattern, e.g. Projects/** (blank = whole vault)" style={{ width: 260 }} value={rule.pattern} onChange={(e) => setRule({ ...rule, pattern: e.target.value })} />
              <select className="dropdown" value={rule.effect} onChange={(e) => setRule({ ...rule, effect: e.target.value })}><option>allow</option><option>deny</option></select>
              <select className="dropdown" value={rule.level} onChange={(e) => setRule({ ...rule, level: e.target.value })}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select>
              <button className="btn" onClick={add}>Add rule</button>
            </div>
            {acl.rules.length === 0 && <span style={muted}>No rules yet.</span>}
            {acl.rules.map((r: any) => (
              <div key={r.id} style={line}>
                <span style={{ minWidth: 180 }}>{r.subjectType === 'everyone' ? 'Everyone' : `${r.subjectType}: ${r.subject ?? r.subjectId}`}</span>
                <code>{r.pattern || '(whole vault)'}</code>
                <span className="tag">{r.effect} {r.level}</span>
                {r.managed ? <span style={muted}>managed</span> : <button className="btn secondary" style={{ padding: '0 8px' }} onClick={async () => { await act(() => api.admin(`/acl/rules/${r.id}`, 'DELETE')); void load(); }}>delete</button>}
              </div>
            ))}
          </Section>
          <Section title="Check what a person can do">
            <div style={line}>
              <select className="dropdown" value={check.user} onChange={(e) => setCheck({ ...check, user: e.target.value })}>
                <option value="">Person…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.displayName || u.username}</option>)}
              </select>
              <input className="text-input" placeholder="path, e.g. HR/hr.md" value={check.path} onChange={(e) => setCheck({ ...check, path: e.target.value })} />
              <button className="btn secondary" disabled={!check.user} onClick={async () => { try { const r = await api.admin(`/acl/check?vault=${encodeURIComponent(vault)}&user=${check.user}&path=${encodeURIComponent(check.path)}`); setChecked(`Access level: ${r.level}`); } catch (e: any) { setChecked(e.message); } }}>Check</button>
              <span>{checked}</span>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

// ---- single sign-on ---------------------------------------------------------------------
const OIDC_TEMPLATE = { issuer: 'https://idp.example.com', clientId: '', clientSecret: '', autoProvision: true, autoLinkByEmail: false };
const SAML_TEMPLATE = { entryPoint: 'https://idp.example.com/sso', issuer: 'webobsidian', idpCert: '-----BEGIN CERTIFICATE-----…', autoProvision: true };

function Sso() {
  const [idps, setIdps] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any[]>([]);
  const [draft, setDraft] = useState<{ id: string; type: 'oidc' | 'saml'; name: string; config: string } | null>(null);
  const [newToken, setNewToken] = useState('');
  const [tokenName, setTokenName] = useState('');
  const act = useAction();
  const load = () => {
    api.admin('/idps').then((r) => setIdps(r.providers)).catch(() => {});
    api.admin('/scim-tokens').then((r) => setTokens(r.tokens)).catch(() => {});
  };
  useEffect(load, []);
  const start = (type: 'oidc' | 'saml') => setDraft({ id: '', type, name: type === 'oidc' ? 'Company SSO' : 'Company SAML', config: JSON.stringify(type === 'oidc' ? OIDC_TEMPLATE : SAML_TEMPLATE, null, 2) });
  const save = async () => {
    if (!draft) return;
    let config: unknown;
    try { config = JSON.parse(draft.config); } catch { return void act(() => Promise.reject(new Error('Settings are not valid JSON'))); }
    const ok = draft.id
      ? await act(() => api.admin(`/idps/${draft.id}`, 'PATCH', { name: draft.name, config }), 'Saved')
      : await act(() => api.admin('/idps', 'POST', { type: draft.type, name: draft.name, config }), 'Provider added');
    if (ok) { setDraft(null); load(); }
  };

  return (
    <>
      <Note kind="info">Sign-in buttons appear on the login page for each enabled provider. The callback address is shown once the provider is saved: {window.location.origin}/auth/sso/&lt;id&gt;/callback (SAML: …/acs).</Note>
      <Section title="Identity providers">
        {idps.map((p) => (
          <div key={p.id} style={box}>
            <div style={line}>
              <b>{p.name}</b><span className="tag">{p.type}</span>{p.managed && <span style={muted}>managed</span>}
              <code style={muted}>{p.id}</code>
              {!p.managed && (
                <span style={{ marginLeft: 'auto', ...line }}>
                  <button className="btn secondary" onClick={async () => { await act(() => api.admin(`/idps/${p.id}`, 'PATCH', { enabled: !p.enabled })); load(); }}>{p.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="btn secondary" onClick={() => setDraft({ id: p.id, type: p.type, name: p.name, config: JSON.stringify(p.config, null, 2) })}>Edit</button>
                  <button className="btn secondary" onClick={async () => { if (window.confirm(`Delete ${p.name}?`)) { await act(() => api.admin(`/idps/${p.id}`, 'DELETE')); load(); } }}>Delete</button>
                </span>
              )}
            </div>
            <div style={muted}>{p.enabled ? 'enabled' : 'disabled'} · {window.location.origin}/auth/sso/{p.id}/{p.type === 'saml' ? 'acs' : 'callback'}</div>
          </div>
        ))}
        <div style={line}>
          <button className="btn secondary" onClick={() => start('oidc')}>Add OpenID Connect</button>
          <button className="btn secondary" onClick={() => start('saml')}>Add SAML 2.0</button>
        </div>
        {draft && (
          <div style={box}>
            <Row name="Name" desc="Shown on the sign-in button."><input className="text-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Row>
            <div style={muted}>Settings (JSON). Secrets stay hidden after saving; leave a secret blank to keep it.</div>
            <textarea className="text-input" style={{ width: '100%', height: 200, fontFamily: 'monospace' }} value={draft.config} onChange={(e) => setDraft({ ...draft, config: e.target.value })} />
            <div style={line}><button className="btn" onClick={save}>Save</button><button className="btn secondary" onClick={() => setDraft(null)}>Cancel</button></div>
          </div>
        )}
      </Section>
      <Section title="SCIM provisioning">
        <Note kind="info">Point your identity provider at {window.location.origin}/scim/v2 with one of these tokens as the bearer token.</Note>
        <div style={line}>
          <input className="text-input" placeholder="token name (e.g. Okta)" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
          <button className="btn" disabled={!tokenName.trim()} onClick={async () => { try { const r = await api.admin('/scim-tokens', 'POST', { name: tokenName.trim() }); setNewToken(r.token); setTokenName(''); load(); } catch (e: any) { await act(() => Promise.reject(e)); } }}>Create token</button>
        </div>
        {newToken && <div style={box}>Copy it now — it is shown only once:<br /><code style={{ userSelect: 'all' }}>{newToken}</code></div>}
        {tokens.map((t) => (
          <div key={t.id} style={line}>
            <b>{t.name}</b><code>{t.prefix}…</code>
            <span style={muted}>{t.revoked ? 'revoked' : t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}</span>
            {!t.revoked && <button className="btn secondary" style={{ padding: '0 8px' }} onClick={async () => { await act(() => api.admin(`/scim-tokens/${t.id}`, 'DELETE')); load(); }}>revoke</button>}
          </div>
        ))}
      </Section>
    </>
  );
}

export default function AccessSettings() {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <div>
      <div className="plugin-tabs" role="tablist">
        {([['users', 'People'], ['groups', 'Groups'], ['access', 'Folder access'], ['sso', 'Single sign-on']] as [Tab, string][]).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>
      {tab === 'users' && <Users />}
      {tab === 'groups' && <Groups />}
      {tab === 'access' && <Access />}
      {tab === 'sso' && <Sso />}
    </div>
  );
}
