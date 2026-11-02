import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Blame = Awaited<ReturnType<typeof api.collabBlame>>;
type Entry = Awaited<ReturnType<typeof api.collabHistory>>['entries'][number];

const KIND: Record<Entry['kind'], string> = { edit: 'typed in the editor', rest: 'saved through the API / a plugin', external: 'changed outside (git, another editor)' };
const when = (iso: string) => new Date(iso).toLocaleString();
const cut = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
const mono = { fontFamily: 'var(--font-monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as const;

function EntryRow({ e }: { e: Entry }) {
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid var(--bg-modifier-border)' }}>
      <div><b>{e.userName}</b> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{when(e.endedAt)} · {KIND[e.kind]}</span></div>
      {e.inserted > 0 && <div style={{ color: '#2e9e4f' }}>+{e.inserted} <span style={mono}>“{cut(e.sample)}”</span></div>}
      {e.deleted > 0 && <div style={{ color: '#d1453b' }}>−{e.deleted} {e.deletedSample && <span style={mono}>“{cut(e.deletedSample)}”</span>}</div>}
    </div>
  );
}

/** "Who changed this?" for a selection, or the whole note's edit history. */
export default function ChangesDialog({ path, range, onClose }: { path: string; range: { from: number; to: number } | null; onClose: () => void }) {
  const [blame, setBlame] = useState<Blame | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.collabHistory(path, 200).then((r) => setEntries(r.entries)).catch((e) => setErr(e.message));
    if (range) api.collabBlame(path, range.from, range.to).then(setBlame).catch((e) => setErr(e.message));
  }, [path, range]);

  const people = new Set((blame?.segments ?? []).map((s) => s.user?.name).filter(Boolean) as string[]);
  const shown = range ? (entries ?? []).filter((e) => people.has(e.userName)) : (entries ?? []);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640, maxHeight: '80vh', overflow: 'auto', padding: 16 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h3 style={{ margin: 0, flex: 1 }}>{range ? 'Who changed this?' : 'Edit history'}</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
        {err && <div style={{ color: '#e5534b' }}>{err}</div>}
        {range && blame && (
          <>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0' }}>The selected text, piece by piece:</div>
            {blame.segments.length === 0 && <div>Nothing selected.</div>}
            {blame.segments.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', marginTop: 6, flexShrink: 0, background: s.user?.color ?? 'var(--text-faint)' }} />
                <div>
                  <b>{s.user?.name ?? 'Written before co-editing'}</b> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{s.to - s.from} character{s.to - s.from === 1 ? '' : 's'}</span>
                  <div style={mono}>“{cut(s.text)}”</div>
                </div>
              </div>
            ))}
          </>
        )}
        <div style={{ color: 'var(--text-muted)', fontSize: 12, margin: '12px 0 4px' }}>{range ? 'Recent edits by these people in this note:' : 'Everything that was changed, newest first:'}</div>
        {entries === null && !err && <div>Loading…</div>}
        {entries && shown.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No recorded edits yet (they appear after a pause in typing).</div>}
        {shown.map((e) => <EntryRow key={e.id ?? e.endedAt + e.userName} e={e} />)}
      </div>
    </div>
  );
}
