import { useState, type FormEvent } from 'react';
import { ApiProblem, type Api } from '../../lib/api.ts';

export interface SignedIn {
  accessToken: string;
}

type LoginResponse =
  SignedIn | { challengeId: string; methods: string[] } | { challengeId: string; enrolmentRequired: true };

type Step =
  | { kind: 'password' }
  | { kind: 'code'; challengeId: string }
  | { kind: 'enrol'; challengeId: string; secret: string; otpauthUri: string; recoveryCodes: string[] };

/** Password, then a TOTP challenge or, for an administrator without MFA, enrolment by challenge (06 §6.5). */
export function Login({ api, onSignedIn }: { api: Api; onSignedIn: (s: SignedIn) => Promise<void> }) {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<string | null>(null);

  const run = (fn: (form: FormData) => Promise<void>) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      await fn(new FormData(e.currentTarget));
    } catch (err) {
      setError(err instanceof ApiProblem ? err.problem.detail : 'Something went wrong');
    }
  };

  const submitPassword = run(async (form) => {
    const res = await api.request<LoginResponse>('POST', '/auth/login', {
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    if ('accessToken' in res) return onSignedIn(res);
    if ('enrolmentRequired' in res) {
      const e = await api.request<{ secret: string; otpauthUri: string; recoveryCodes: string[] }>(
        'POST',
        '/auth/mfa/enroll',
        { challengeId: res.challengeId },
      );
      setStep({ kind: 'enrol', challengeId: res.challengeId, ...e });
      return;
    }
    setStep({ kind: 'code', challengeId: res.challengeId });
  });

  const submitCode = run(async (form) => {
    if (step.kind === 'password') return;
    const path = step.kind === 'enrol' ? '/auth/mfa/confirm' : '/auth/mfa/verify';
    onSignedIn(
      await api.request<SignedIn>('POST', path, {
        challengeId: step.challengeId,
        code: String(form.get('code')),
      }),
    );
  });

  return (
    <main style={{ maxWidth: 360, margin: '10vh auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>TradeSoft</h1>
      {error && <p role="alert">{error}</p>}
      {step.kind === 'password' ? (
        <form onSubmit={(e) => void submitPassword(e)}>
          <label>
            Email <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit">Sign in</button>
        </form>
      ) : (
        <form onSubmit={(e) => void submitCode(e)}>
          {step.kind === 'enrol' && (
            <section>
              <p>Your role requires two-factor authentication. Add this key to your authenticator app:</p>
              <code>{step.secret}</code>
              <p>
                Or open <a href={step.otpauthUri}>this link</a> on your phone. Keep these recovery codes; they
                are shown once:
              </p>
              <ul>
                {step.recoveryCodes.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <label>
            Six-digit code{' '}
            <input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required />
          </label>
          <button type="submit">Verify</button>
        </form>
      )}
    </main>
  );
}
