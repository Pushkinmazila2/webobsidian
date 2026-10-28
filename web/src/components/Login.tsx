import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import Icon from './Icon';

export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const setMustChangePassword = useStore((s) => s.setMustChangePassword);
  const [needSetup, setNeedSetup] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    api.authStatus().then((s) => setNeedSetup(!s.passwordSet)).catch(() => {});
    api.ssoProviders().then((r) => setProviders(r.providers)).catch(() => {});
    // The server sends people back here with a short reason when single sign-on did not work.
    const q = new URLSearchParams(location.search);
    const why = q.get('sso_error');
    if (why) {
      setErr(why);
      q.delete('sso_error');
      const rest = q.toString();
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (needSetup && password !== confirm) {
      setErr('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (needSetup) {
        await api.setup(password);
        setMustChangePassword(false); // a freshly-set password is already custom
      } else {
        const r = await api.login(password, username);
        setMustChangePassword(Boolean(r.mustChangePassword));
      }
      onAuthed();
    } catch (e: any) {
      setErr(e.message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">
          <Icon name="gem" size={40} />
        </div>
        <h1>WebObsidian</h1>
        <p>{needSetup ? 'Set a master password to secure your vault' : 'Enter your password to unlock'}</p>
        <div className="err">{err}</div>
        {!needSetup && (
          <input
            className="text-input"
            type="text"
            placeholder="Username (empty = owner)"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        )}
        <input
          className="text-input"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needSetup && (
          <input
            className="text-input"
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        <button className="btn" type="submit" disabled={busy}>
          {needSetup ? 'Create & Unlock' : 'Unlock'}
        </button>
        {!needSetup &&
          providers.map((p) => (
            <a
              key={p.id}
              className="btn"
              style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
              href={`/auth/sso/${encodeURIComponent(p.id)}/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
            >
              Sign in with {p.name}
            </a>
          ))}
      </form>
    </div>
  );
}
