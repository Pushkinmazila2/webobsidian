import { useState } from 'react';
import { api, takeTypedPassword } from '../lib/api';
import { useStore } from '../lib/store';
import Icon from './Icon';

const MIN_LEN = 6;

/**
 * Blocking screen shown right after login when the account is still on the
 * default password (server reports `mustChangePassword`). The vault can't be
 * used until a custom password is set — there is no dismiss.
 */
export default function ForceChangePassword() {
  const setMustChangePassword = useStore((s) => s.setMustChangePassword);
  // The password typed a moment ago at sign-in; after a page reload it is gone and the person types it again.
  const [typed] = useState(() => takeTypedPassword());
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (next.length < MIN_LEN) {
      setErr(`Password must be at least ${MIN_LEN} characters`);
      return;
    }
    if (next === (typed ?? current)) {
      setErr('Choose a password different from the current one');
      return;
    }
    if (next !== confirm) {
      setErr('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(typed ?? current, next);
      setMustChangePassword(false);
    } catch (e: any) {
      setErr(e.message ?? 'Failed to change password');
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
        <h1>Set a new password</h1>
        <p>
          Your password was set by an administrator (or is still the default). Choose your
          own password before continuing.
        </p>
        <div className="err">{err}</div>
        {typed === null && (
          <input
            className="text-input"
            type="password"
            placeholder="Current password"
            autoFocus
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
        <input
          className="text-input"
          type="password"
          placeholder="New password"
          autoFocus={typed !== null}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          className="text-input"
          type="password"
          placeholder="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set password & continue'}
        </button>
      </form>
    </div>
  );
}
