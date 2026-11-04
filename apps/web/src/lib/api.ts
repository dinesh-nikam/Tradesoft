// SPA API client (05 §15, 06 §5.9). The access token lives in memory only. A 401 AUTH_TOKEN_EXPIRED triggers
// one refresh shared by every concurrent request in the tab, and a Web Lock serialises refreshes across tabs.
export interface Problem {
  status: number;
  code: string;
  detail: string;
  errors?: { path: string; message: string }[];
}

export class ApiProblem extends Error {
  problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail);
    this.problem = problem;
  }
}

/** The first field error of a problem, else its detail; `fallback` for anything that is not a problem. */
export const problemMessage = (err: unknown, fallback: string) =>
  err instanceof ApiProblem ? (err.problem.errors?.[0]?.message ?? err.problem.detail) : fallback;

export interface ApiOptions {
  base?: string;
  locks?: Pick<LockManager, 'request'>;
  readCookie?: (name: string) => string | undefined;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(fetchImpl: typeof fetch, options: ApiOptions = {}) {
  const base = options.base ?? '/api/v1';
  let token: string | null = null;
  let refreshing: Promise<boolean> | null = null;
  const csrf = () => options.readCookie?.('ts_csrf');

  async function refreshOnce(): Promise<boolean> {
    const run = async () => {
      const res = await fetchImpl(`${base}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrf() ?? '' },
      });
      token = res.ok ? ((await res.json()) as { accessToken: string }).accessToken : null;
      return res.ok;
    };
    return options.locks ? options.locks.request('tradesoft-refresh', run) : run();
  }

  /** One refresh in flight per tab; every waiting request shares its result. */
  function refresh(): Promise<boolean> {
    refreshing ??= refreshOnce().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /**
   * A JSON body is serialised; a FormData body is sent as multipart, with the browser setting the boundary.
   * A CSV response comes back as its text.
   */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const form = body instanceof FormData;
    const send = () => {
      const headers: Record<string, string> = { ...extraHeaders };
      if (body !== undefined && !form) headers['content-type'] = 'application/json';
      if (token) headers['authorization'] = `Bearer ${token}`;
      const c = csrf();
      if (c) headers['x-csrf-token'] = c;
      return fetchImpl(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        headers,
        ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
      });
    };
    let res = await send();
    if (res.status === 401 && token) {
      const problem = (await res
        .clone()
        .json()
        .catch(() => ({}))) as Partial<Problem>;
      if (problem.code === 'AUTH_TOKEN_EXPIRED' && (await refresh())) res = await send();
    }
    if (res.status === 204) return undefined as T;
    if (res.ok && res.headers.get('content-type')?.startsWith('text/csv')) return (await res.text()) as T;
    const json = (await res.json()) as unknown;
    if (!res.ok) throw new ApiProblem(json as Problem);
    return json as T;
  }

  return {
    request,
    refresh,
    setToken: (t: string | null) => {
      token = t;
    },
  };
}
