import { useEffect, useState } from 'react';
import type { Api } from '../lib/api.ts';
import { NAV, visibleNav } from '../lib/nav.ts';
import { Login, type SignedIn } from '../features/auth/Login.tsx';
import { ResetPassword } from '../features/auth/ResetPassword.tsx';
import { Users } from '../features/admin/Users.tsx';
import { DataManagement } from '../features/data/DataManagement.tsx';
import { Imports } from '../features/imports/Imports.tsx';
import { Jobs } from '../features/admin/Jobs.tsx';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  permissions: string[];
}

function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return [
    path,
    (next) => {
      window.history.pushState(null, '', next);
      setPath(next);
    },
  ];
}

export function App({ api }: { api: Api }) {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [path, navigate] = usePath();

  // A reload has no access token; the refresh cookie restores the session silently (06 §5.9).
  useEffect(() => {
    void (async () => {
      if (await api.refresh()) setMe(await api.request<Me>('GET', '/auth/me'));
      setChecking(false);
    })();
  }, [api]);

  // Mail links open here with or without a session (06 §4.2).
  if (path === '/reset-password') return <ResetPassword api={api} onDone={() => navigate('/')} />;
  if (checking) return <p>Loading…</p>;
  if (!me) {
    const signedIn = async (s: SignedIn) => {
      api.setToken(s.accessToken);
      setMe(await api.request<Me>('GET', '/auth/me'));
    };
    return <Login api={api} onSignedIn={signedIn} />;
  }

  const perms = new Set(me.permissions);
  const items = visibleNav(perms);
  const current = NAV.find((i) => i.path === path);
  const logout = async () => {
    await api.request('POST', '/auth/logout').catch(() => undefined);
    api.setToken(null);
    setMe(null);
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <nav aria-label="Main" style={{ width: 200, borderRight: '1px solid #ddd', padding: 12 }}>
        <strong>TradeSoft</strong>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {items.map((i) => (
            <li key={i.path}>
              <a
                href={i.path}
                aria-current={i.path === path ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(i.path);
                }}
              >
                {i.label}
              </a>
            </li>
          ))}
        </ul>
        <p>{me.displayName}</p>
        <button type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </nav>
      <main style={{ flex: 1, padding: 16 }}>
        {!current || !perms.has(current.permission) ? (
          <p>Choose a section.</p>
        ) : current.path === '/data' ? (
          <DataManagement api={api} perms={perms} />
        ) : current.path === '/imports' ? (
          <Imports api={api} perms={perms} />
        ) : current.path === '/admin/jobs' ? (
          <Jobs api={api} perms={perms} />
        ) : current.path === '/admin/users' ? (
          <Users
            api={api}
            canWrite={perms.has('user:write')}
            canAssignRoles={perms.has('user:write') && perms.has('role:read')}
          />
        ) : (
          <p>
            {current.label} arrives in Phase {current.phase}.
          </p>
        )}
      </main>
    </div>
  );
}
