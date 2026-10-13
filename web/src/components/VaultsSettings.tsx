import { useEffect, useState } from 'react';
import { api, type VaultInfo } from '../lib/api';
import { currentVaultId, switchVault } from '../lib/vault';
import { Note, PRESETS, Row } from './StorageSettings';

interface Form {
  id?: string; // set when editing
  name: string;
  driver: 'local' | 'github';
  path: string;
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
  token: string;
  tokenEnv: string;
  preset: number;
}

const EMPTY: Form = { name: '', driver: 'local', path: '', owner: '', repo: '', branch: '', basePath: '', token: '', tokenEnv: '', preset: 0 };

function presetOf(rules: any[]): number {
  const i = PRESETS.findIndex((p) => JSON.stringify(p.rules) === JSON.stringify((rules ?? []).map((r: any) => ({ match: r.match, mode: r.mode, ...(r.index === undefined ? {} : { index: r.index }) }))));
  return i < 0 ? 0 : i;
}

/** Settings → Vaults: the list of vaults this server offers (each tab can open a different one). */
export default function VaultsSettings() {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<any>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const cur = currentVaultId();

  const load = () => api.listVaults().then((r) => setVaults(r.vaults)).catch(() => {});
  useEffect(() => { load(); }, []);

  const set = (k: keyof Form, v: any) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const edit = async (id: string) => {
    setMsg(null);
    setTest(null);
    const { vault } = await api.getVault(id);
    setForm({
      id,
      name: vault.name,
      driver: vault.storage.driver,
      path: vault.path,
      owner: vault.storage.github.owner,
      repo: vault.storage.github.repo,
      branch: vault.storage.github.branch,
      basePath: vault.storage.github.basePath,
      token: vault.storage.github.token,
      tokenEnv: vault.tokenEnv,
      preset: presetOf(vault.storage.rules),
    });
  };

  const github = (f: Form) => ({ owner: f.owner.trim(), repo: f.repo.trim(), branch: f.branch.trim(), basePath: f.basePath.trim(), token: f.token });

  const payload = (f: Form) => ({
    name: f.name.trim(),
    path: f.driver === 'local' ? f.path.trim() : '',
    tokenEnv: f.tokenEnv.trim(),
    storage: { driver: f.driver, ...(f.driver === 'github' ? { github: github(f), rules: PRESETS[f.preset].rules } : {}) },
  });

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      if (form.id) await api.updateVault(form.id, payload(form));
      else await api.createVault(payload(form));
      setForm(null);
      setMsg({ kind: 'ok', text: 'Saved. The vault is available in the switcher at the bottom of the sidebar.' });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (v: VaultInfo) => {
    if (!confirm(`Remove "${v.name}" from the list? Its ${v.driver === 'github' ? 'repository' : 'folder'} is not touched. Unsaved changes are saved first.`)) return;
    try {
      await api.deleteVault(v.id);
      if (v.id === cur) switchVault('default');
      else await load();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    }
  };

  const runTest = async () => {
    if (!form) return;
    setTest(null);
    try {
      setTest(await api.storageTest(github(form), { vault: form.id, tokenEnv: form.tokenEnv.trim() || undefined }));
    } catch (e: any) {
      setTest({ ok: false, error: e.message });
    }
  };

  return (
    <div>
      <h3>Vaults</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Each browser tab works on one vault; switch with the vault name at the bottom of the sidebar. A vault can be a folder on
        this server or a GitHub repository. The main vault is configured under <b>Vault &amp; Files</b> and <b>Storage</b>.
      </p>
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}

      {vaults.map((v) => (
        <Row
          key={v.id}
          name={`${v.name}${v.id === cur ? ' · this tab' : ''}`}
          desc={`${v.driver === 'github' ? 'GitHub' : 'Folder'}: ${v.location || '—'}${v.isDefault ? ' · main vault' : ''}${v.fromEnv ? ' · set by WEBOBSIDIAN_VAULTS (read-only)' : ''}`}
        >
          {v.id !== cur && <button onClick={() => switchVault(v.id)}>Open</button>}
          {!v.isDefault && !v.fromEnv && (
            <>
              {' '}
              <button onClick={() => edit(v.id)}>Edit</button> <button onClick={() => remove(v)}>Remove</button>
            </>
          )}
        </Row>
      ))}

      {!form && (
        <p>
          <button onClick={() => { setMsg(null); setTest(null); setForm({ ...EMPTY }); }}>Add vault…</button>
        </p>
      )}

      {form && (
        <div style={{ borderTop: '1px solid var(--background-modifier-border)', marginTop: 12, paddingTop: 8 }}>
          <h4>{form.id ? `Edit “${form.name}”` : 'New vault'}</h4>
          <Row name="Name">
            <input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Row>
          <Row name="Type">
            <select value={form.driver} disabled={!!form.id} onChange={(e) => set('driver', e.target.value)}>
              <option value="local">Folder on this server</option>
              <option value="github">GitHub repository</option>
            </select>
          </Row>
          {form.driver === 'local' ? (
            <Row name="Folder" desc="Must be inside the allowed roots (see Vault & Files).">
              <input value={form.path} placeholder="/data/notes" onChange={(e) => set('path', e.target.value)} />
            </Row>
          ) : (
            <>
              <Row name="Owner">
                <input value={form.owner} onChange={(e) => set('owner', e.target.value)} />
              </Row>
              <Row name="Repository">
                <input value={form.repo} onChange={(e) => set('repo', e.target.value)} />
              </Row>
              <Row name="Branch" desc="Empty = the default branch.">
                <input value={form.branch} onChange={(e) => set('branch', e.target.value)} />
              </Row>
              <Row name="Folder in repo" desc="Empty = the repository root.">
                <input value={form.basePath} onChange={(e) => set('basePath', e.target.value)} />
              </Row>
              <Row name="Token" desc="Fine-grained token: Contents read (+ write for editing).">
                <input type="password" value={form.token} onChange={(e) => set('token', e.target.value)} />
              </Row>
              <Row name="Token variable" desc="Name of a server environment variable that holds the token (preferred). Empty = WEBOBSIDIAN_GITHUB_TOKEN.">
                <input value={form.tokenEnv} placeholder="KB_TOKEN" onChange={(e) => set('tokenEnv', e.target.value)} />
              </Row>
              <Row name="What is kept on the server" desc={PRESETS[form.preset].desc}>
                <select value={form.preset} onChange={(e) => set('preset', Number(e.target.value))}>
                  {PRESETS.map((p, i) => (
                    <option key={p.name} value={i}>{p.name}</option>
                  ))}
                </select>
              </Row>
              {test && (
                <Note kind={test.ok ? 'ok' : 'error'}>
                  {test.ok
                    ? `Connected · branch ${test.branch} · ${test.files} files (${test.notes} notes)${test.canWrite === false ? ' · read-only token' : ''}`
                    : test.error}
                </Note>
              )}
            </>
          )}
          <p>
            <button disabled={busy || !form.name.trim()} onClick={save}>{form.id ? 'Save' : 'Add'}</button>{' '}
            {form.driver === 'github' && <button onClick={runTest}>Test connection</button>}{' '}
            <button onClick={() => setForm(null)}>Cancel</button>
          </p>
        </div>
      )}
    </div>
  );
}
