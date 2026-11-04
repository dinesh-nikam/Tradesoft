import { useEffect, useState, type FormEvent } from 'react';
import { ApiProblem, type Api } from '../../lib/api.ts';
import { readResetToken } from '../../lib/reset-token.ts';

/** Consumes a reset or invitation link (06 §4.2, §4.5); a user with MFA also gives a current code. */
export function ResetPassword({ api, onDone }: { api: Api; onDone: () => void }) {
  const [token] = useState(() => readResetToken(window.location.hash));
  const [needsCode, setNeedsCode] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  // Drop the token from the address bar and history once it is in memory.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get('newPassword'));
    if (newPassword !== String(form.get('confirm'))) return setErrors(['The two passwords do not match']);
    setErrors([]);
    const code = form.get('totpCode');
    try {
      await api.request('POST', '/auth/password/reset', {
        token,
        newPassword,
        ...(code ? { totpCode: String(code) } : {}),
      });
      setDone(true);
    } catch (err) {
      if (!(err instanceof ApiProblem)) return setErrors(['Something went wrong']);
      if (err.problem.code === 'AUTH_MFA_REQUIRED') setNeedsCode(true);
      setErrors(err.problem.errors?.map((x) => x.message) ?? [err.problem.detail]);
    }
  };

  return (
    <main style={{ maxWidth: 360, margin: '10vh auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>TradeSoft</h1>
      {done ? (
        <p>
          Your password is set.{' '}
          <button type="button" onClick={onDone}>
            Sign in
          </button>
        </p>
      ) : !token ? (
        <p role="alert">
          This link is incomplete. Open the link from your email again, or ask for a new one.
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <h2>Choose a password</h2>
          {errors.length > 0 && (
            <ul role="alert">
              {errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <label>
            New password <input name="newPassword" type="password" autoComplete="new-password" required />
          </label>
          <label>
            Repeat it <input name="confirm" type="password" autoComplete="new-password" required />
          </label>
          {needsCode && (
            <label>
              Six-digit code{' '}
              <input
                name="totpCode"
                inputMode="numeric"
                pattern="[0-9]{6}"
                autoComplete="one-time-code"
                required
              />
            </label>
          )}
          <button type="submit">Set password</button>
        </form>
      )}
    </main>
  );
}
