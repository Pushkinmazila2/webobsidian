import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Mode = 'mirror' | 'lazy' | 'remote';
interface RuleRow {
  match: string;
  mode: Mode;
  index?: boolean;
}

const MODE_HELP: Record<Mode, string> = {
  mirror: 'Downloaded up front and kept (fast; uses server memory/disk)',
  lazy: 'Fetched when opened, then kept in a size-limited cache',
  remote: 'Never kept — fetched from GitHub every time (slowest, nothing stored)',
};

export const PRESETS: { name: string; desc: string; rules: RuleRow[] }[] = [
  {
    name: 'Notes local, files on demand',
    desc: 'Notes are mirrored and searchable; images, PDFs and the rest are fetched when opened.',
    rules: [
      { match: '.obsidian/**', mode: 'mirror', index: false },
      { match: '**/*.{md,markdown,canvas}', mode: 'mirror', index: true },
      { match: '**', mode: 'lazy', index: false },
    ],
  },
  {
    name: 'Everything only in GitHub',
    desc: 'Nothing is kept on the server. Slower; search and backlinks are unavailable.',
    rules: [{ match: '**', mode: 'remote', index: false }],
  },
  {
    name: 'Mirror everything',
    desc: 'Downloads the whole vault. Fastest, but needs space for every file.',
    rules: [{ match: '**', mode: 'mirror', index: true }],
  },
];

const effIndex = (r: RuleRow) => r.index ?? r.mode === 'mirror';

export function Row({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="info">
        <div className="name">{name}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

export function Note({ kind, children }: { kind: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  const color = { info: 'var(--text-muted)', warn: '#d9a21b', error: '#e5534b', ok: '#3fb950' }[kind];
  return (
    <div
      style={{
        border: `1px solid ${color}`,
        borderRadius: 6,
        padding: '8px 10px',
        margin: '10px 0',
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

export default function StorageSettings({ s, reload }: { s: any; reload: () => Promise<void> | void }) {
  const [driver, setDriver] = useState<'local' | 'github'>(s.storage.driver);
  const [g, setG] = useState({ ...s.storage.github });
  const [cache, setCache] = useState({ ...s.storage.cache });
  const [rules, setRules] = useState<RuleRow[]>(s.storage.rules.map((r: any) => ({ ...r })));
  const [status, setStatus] = useState<any>(null);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const setGh = (k: string, v: any) => setG((p: any) => ({ ...p, [k]: v }));

  const loadStatus = () => api.storageStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    loadStatus();
    const id = setInterval(loadStatus, 5000);
    return () => clearInterval(id);
  }, []);

  const updateRule = (i: number, patch: Partial<RuleRow>) =>
    setRules((p) => p.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const moveRule = (i: number, d: -1 | 1) =>
    setRules((p) => {
      const j = i + d;
      if (j < 0 || j >= p.length) return p;
      const n = [...p];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const catchAll = rules.some((r) => r.match.trim() === '**');
  const lastIsCatchAll = rules.length > 0 && rules[rules.length - 1].match.trim() === '**';
  const shadowed = rules.findIndex((r, i) => r.match.trim() === '**' && i < rules.length - 1);

  const ghPayload = () => ({
    owner: g.owner.trim(),
    repo: g.repo.trim(),
    branch: g.branch.trim(),
    basePath: g.basePath.trim(),
    apiUrl: g.apiUrl.trim(),
    pollSec: Number(g.pollSec),
    flushSec: Number(g.flushSec),
    holdSec: Number(g.holdSec),
    holdMatch: g.holdMatch,
    token: g.token, // masked value is ignored by the server
  });

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.storageTest(ghPayload()));
    } catch (e: any) {
      setTest({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.putSettings({
        storage: {
          driver,
          github: ghPayload(),
          cache: { persist: cache.persist, maxMB: Number(cache.maxMB), dir: cache.dir },
          rules: rules.map((r) => ({ match: r.match.trim(), mode: r.mode, index: effIndex(r) })),
        },
      });
      await reload();
      await loadStatus();
      setMsg({ kind: 'ok', text: 'Saved. Restart the server to apply storage changes.' });
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const locked: Record<string, string> = status?.locked ?? {};
  const lock = (path: string) => (locked[path] ? { disabled: true, title: `Set by the ${locked[path]} environment variable` } : {});
  const remote = status?.remote;
  const pending = remote?.pending ?? 0;

  return (
    <div>
      <h2>Storage</h2>

      {Object.keys(locked).length > 0 && (
        <Note kind="info">
          Some settings are fixed by environment variables ({[...new Set(Object.values(locked))].join(', ')}) and are greyed out. Remove the
          variable and restart the server to edit them here.
        </Note>
      )}

      {status?.restartRequired && (
        <Note kind="warn">
          Saved storage settings differ from what the server is running. <b>Restart the server</b> to apply them — until then the
          vault keeps using <b>{status.active === 'github' ? 'GitHub' : 'the local folder'}</b>.
        </Note>
      )}

      {status?.active === 'github' && (
        <Note kind={remote?.lastError ? 'error' : 'info'}>
          Connected to <b>{remote?.repo}</b> ({remote?.branch}).{' '}
          {pending > 0 ? <b>{pending} change(s) not yet saved to GitHub{remote?.held > 0 ? ` (${remote.held} of them plugin/app settings, held back on purpose)` : ''}.</b> : 'Everything is saved to GitHub.'}
          {remote?.lastError && <div style={{ marginTop: 4 }}>Last save failed: {remote.lastError}. It will be retried automatically.</div>}
          {remote?.conflicts?.length > 0 && (
            <div style={{ marginTop: 4 }}>
              Edited on both sides — your version was kept as: {remote.conflicts.map((c: string) => `“${c}”`).join(', ')}
            </div>
          )}
        </Note>
      )}

      <Row name="Where the vault lives" desc="Local folder on the server, or a repository reached through the GitHub API (no clone is made).">
        <select className="text-input" style={{ width: 220 }} value={driver} onChange={(e) => setDriver(e.target.value as any)} {...lock('driver')}>
          <option value="local">Local folder</option>
          <option value="github">GitHub repository</option>
        </select>
      </Row>

      {driver === 'github' && (
        <>
          <Row name="Repository" desc="Owner and name, e.g. Pushkinmazila2 / BZ">
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="text-input" style={{ width: 130 }} placeholder="owner" value={g.owner} onChange={(e) => setGh('owner', e.target.value)} {...lock('github.owner')} />
              <span style={{ alignSelf: 'center' }}>/</span>
              <input className="text-input" style={{ width: 130 }} placeholder="repo" value={g.repo} onChange={(e) => setGh('repo', e.target.value)} {...lock('github.repo')} />
            </div>
          </Row>
          <Row name="Branch" desc="Empty = the repository's default branch">
            <input className="text-input" style={{ width: 275 }} placeholder="(default branch)" value={g.branch} onChange={(e) => setGh('branch', e.target.value)} {...lock('github.branch')} />
          </Row>
          <Row name="Folder inside the repo" desc="Use a subfolder as the vault root, e.g. docs. Empty = whole repository.">
            <input className="text-input" style={{ width: 275 }} placeholder="(repository root)" value={g.basePath} onChange={(e) => setGh('basePath', e.target.value)} {...lock('github.basePath')} />
          </Row>
          <Row
            name="Access token"
            desc={
              status?.tokenSource === 'env'
                ? `Using ${status.tokenEnvVar} from the server environment (takes precedence over this field).`
                : `Fine-grained token for this one repository: Contents “Read and write”. Safer: set ${status?.tokenEnvVar ?? 'WEBOBSIDIAN_GITHUB_TOKEN'} on the server instead.`
            }
          >
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              style={{ width: 275 }}
              placeholder={g.token ? '' : 'github_pat_…'}
              value={g.token}
              onChange={(e) => setGh('token', e.target.value)}
              {...lock('github.token')}
            />
          </Row>
          <Row name="Saving to GitHub" desc="Edits are batched into one commit after this many seconds without typing (also on Sync and on shutdown).">
            <input className="text-input" type="number" min={1} style={{ width: 90 }} value={g.flushSec} onChange={(e) => setGh('flushSec', e.target.value)} {...lock('github.flushSec')} />
            <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>sec</span>
          </Row>
          <Row name="Plugins & app settings" desc="Changes under these paths are held back longer so a busy plugin can't flood the repository with commits. Notes are not affected.">
            <input className="text-input" type="number" min={1} style={{ width: 90 }} value={g.holdSec} onChange={(e) => setGh('holdSec', e.target.value)} {...lock('github.holdSec')} />
            <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>sec</span>
          </Row>
          <Row name="Held paths" desc="One pattern per line. Empty = hold nothing (everything follows the saving delay above).">
            <textarea
              className="text-input"
              rows={2}
              style={{ width: 275, fontFamily: 'var(--font-monospace, monospace)' }}
              value={(g.holdMatch ?? []).join('\n')}
              onChange={(e) => setGh('holdMatch', e.target.value.split('\n').map((x: string) => x.trim()).filter(Boolean))}
              {...lock('github.holdMatch')}
            />
          </Row>
          <Row name="Check for outside changes" desc="How often GitHub is polled for commits made elsewhere (minimum 5).">
            <input className="text-input" type="number" min={5} style={{ width: 90 }} value={g.pollSec} onChange={(e) => setGh('pollSec', e.target.value)} {...lock('github.pollSec')} />
            <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>sec</span>
          </Row>
          <div style={{ margin: '6px 0' }}>
            <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? 'Hide' : 'Show'} advanced
            </button>
          </div>
          {showAdvanced && (
            <Row name="API URL" desc="Only change for GitHub Enterprise Server, e.g. https://github.example.com/api/v3">
              <input className="text-input" style={{ width: 275 }} value={g.apiUrl} onChange={(e) => setGh('apiUrl', e.target.value)} {...lock('github.apiUrl')} />
            </Row>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
            <button className="btn secondary" onClick={runTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Doesn’t save or change anything.</span>
          </div>
          {test && !test.ok && <Note kind="error">{test.error}</Note>}
          {test?.ok && (
            <Note kind="ok">
              Connected: {test.private ? 'private' : 'public'} repository, branch <b>{test.branch}</b>, {test.files} file(s) of which{' '}
              {test.notes} note(s).
              {test.canWrite === false && <div style={{ color: '#d9a21b' }}>The token can only read — editing will not be saved.</div>}
              {test.canWrite === null && <div style={{ color: 'var(--text-muted)' }}>Write access can’t be checked here; it is verified on the first save.</div>}
              {!test.basePathFound && <div style={{ color: '#d9a21b' }}>The folder “{g.basePath}” doesn’t exist in this branch — the vault would be empty.</div>}
              {test.truncated && <div style={{ color: 'var(--text-muted)' }}>Large repository: listing is read folder by folder (slower start).</div>}
            </Note>
          )}

          <h3 style={{ marginTop: 22 }}>What is kept on the server</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Rules are checked top to bottom; the first match wins. Files that match nothing are fetched on demand.
          </div>
          {locked.rules && <Note kind="info">The rules are set by the {locked.rules} environment variable and can’t be edited here.</Note>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {PRESETS.map((p) => (
              <button key={p.name} className="btn secondary" title={p.desc} disabled={!!locked.rules} onClick={() => setRules(p.rules.map((r) => ({ ...r })))}>
                {p.name}
              </button>
            ))}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                <th style={{ padding: '4px 4px' }}>Files matching</th>
                <th>Keep</th>
                <th title="Include in search, backlinks and the graph. Indexed files are read in full.">Search</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--bg-modifier-border)' }}>
                  <td style={{ padding: '4px 4px' }}>
                    <input
                      className="text-input"
                      style={{ width: '100%', fontFamily: 'var(--font-monospace, monospace)' }}
                      value={r.match}
                      disabled={!!locked.rules}
                      onChange={(e) => updateRule(i, { match: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="text-input"
                      title={MODE_HELP[r.mode]}
                      value={r.mode}
                      disabled={!!locked.rules}
                      onChange={(e) => {
                        const mode = e.target.value as Mode;
                        // keep the "searchable" default in step with the mode until the user decides
                        updateRule(i, { mode, index: r.index === undefined || r.index === (r.mode === 'mirror') ? mode === 'mirror' : r.index });
                      }}
                    >
                      <option value="mirror">Always (mirror)</option>
                      <option value="lazy">When used (cache)</option>
                      <option value="remote">Never (GitHub only)</option>
                    </select>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={effIndex(r)} disabled={!!locked.rules} onChange={(e) => updateRule(i, { index: e.target.checked })} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button className="btn secondary" style={{ padding: '2px 6px' }} disabled={!!locked.rules || i === 0} onClick={() => moveRule(i, -1)} title="Move up">↑</button>{' '}
                    <button className="btn secondary" style={{ padding: '2px 6px' }} disabled={!!locked.rules || i === rules.length - 1} onClick={() => moveRule(i, 1)} title="Move down">↓</button>{' '}
                    <button className="btn secondary" style={{ padding: '2px 6px' }} disabled={!!locked.rules} onClick={() => setRules((p) => p.filter((_, j) => j !== i))} title="Remove">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <button className="btn secondary" disabled={!!locked.rules} onClick={() => setRules((p) => [...p, { match: '', mode: 'lazy', index: false }])}>
              + Add rule
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            Patterns: <code>**</code> any folders, <code>*</code> within a folder, <code>{'{md,png}'}</code> alternatives — e.g.{' '}
            <code>Attachments/**</code>, <code>**/*.{'{png,jpg}'}</code>, <code>Private/**</code>.
          </div>
          {rules.some((r) => !r.match.trim()) && <Note kind="error">Every rule needs a pattern.</Note>}
          {shadowed >= 0 && <Note kind="warn">The rule “**” on row {shadowed + 1} matches everything, so the rules below it never apply.</Note>}
          {!catchAll && rules.length > 0 && !lastIsCatchAll && (
            <Note kind="info">Files matching no rule are fetched when opened (like “When used”).</Note>
          )}
          {rules.length > 0 && !rules.some((r) => effIndex(r)) && (
            <Note kind="warn">No rule is searchable: search, backlinks and the graph will be empty. That’s fine if it’s intended.</Note>
          )}
          {rules.some((r) => effIndex(r) && r.mode !== 'mirror') && (
            <Note kind="info">Searchable files that aren’t mirrored are downloaded when the server starts so they can be indexed.</Note>
          )}

          <h3 style={{ marginTop: 22 }}>Cache</h3>
          <Row name="Where kept files live" desc="In memory: nothing is ever written to the server’s disk. On disk: survives restarts, so startup is faster.">
            <select className="text-input" style={{ width: 220 }} value={cache.persist} onChange={(e) => setCache({ ...cache, persist: e.target.value })} {...lock('cache.persist')}>
              <option value="memory">Memory only (no files on disk)</option>
              <option value="disk">Disk</option>
            </select>
          </Row>
          <Row name="Size limit" desc="Least recently used files are dropped above this. Mirrored files are never dropped.">
            <input className="text-input" type="number" min={1} style={{ width: 90 }} value={cache.maxMB} onChange={(e) => setCache({ ...cache, maxMB: e.target.value })} {...lock('cache.maxMB')} />
            <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>MB</span>
          </Row>
        </>
      )}

      {driver === 'local' && s.storage.driver === 'github' && (
        <Note kind="info">Switching back to the local folder uses the path set under “Vault &amp; Files”.</Note>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
        <button className="btn" onClick={save} disabled={saving || rules.some((r) => !r.match.trim())}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Takes effect after a server restart.</span>
      </div>
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
    </div>
  );
}
