import { describe, expect, it } from 'vitest';
import { ApiProblem, createApi } from '../src/lib/api.ts';
import { visibleNav } from '../src/lib/nav.ts';
import { readResetToken } from '../src/lib/reset-token.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SPA API client (06 §5.9)', () => {
  it('refreshes once for concurrent expired requests, then retries each with the new token', async () => {
    const seen: string[] = [];
    let refreshes = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['authorization'];
      seen.push(`${url} ${auth ?? ''}`);
      if (url.endsWith('/auth/refresh')) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { accessToken: 'new' });
      }
      return auth === 'Bearer new'
        ? json(200, { ok: true })
        : json(401, { status: 401, code: 'AUTH_TOKEN_EXPIRED', detail: 'x' });
    }) as typeof fetch;
    const api = createApi(fetchImpl, { readCookie: () => 'csrf-1' });
    api.setToken('old');
    const results = await Promise.all([
      api.request('GET', '/a'),
      api.request('GET', '/b'),
      api.request('GET', '/c'),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
  });

  it('surfaces problem documents and does not refresh for other 401 codes', async () => {
    let refreshes = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/auth/refresh')) refreshes++;
      return json(401, { status: 401, code: 'AUTH_SESSION_REVOKED', detail: 'The session has ended' });
    }) as typeof fetch;
    const api = createApi(fetchImpl);
    api.setToken('t');
    await expect(api.request('GET', '/x')).rejects.toBeInstanceOf(ApiProblem);
    expect(refreshes).toBe(0);
  });

  it('shows only the navigation the permissions allow', () => {
    const labels = visibleNav(new Set(['chart:read', 'user:read'])).map((i) => i.label);
    expect(labels).toEqual(['Charts', 'Renko', 'Users']);
  });
});

describe('reset link (06 §4.2)', () => {
  const token = 'A'.repeat(40) + '_-9';

  it('reads the token from the fragment and rejects anything else', () => {
    expect(readResetToken(`#token=${token}`)).toBe(token);
    expect(readResetToken('')).toBeNull();
    expect(readResetToken('#token=short')).toBeNull();
    expect(readResetToken(`#token=${token.slice(1)}%2F`)).toBeNull();
  });
});
