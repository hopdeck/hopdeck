const TOKEN_KEY = 'nftm.token';

/**
 * `nftm` prints the panel URL with the token in the fragment, which is never
 * sent to the server or leaked in Referer. Move it to sessionStorage and
 * remove it from the address bar.
 */
function takeToken(): string | null {
  const fromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    history.replaceState(null, '', location.pathname + location.search);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

const token = takeToken();

/** The server answers errors with `{ error: { code, message } }`; the UI translates `code`. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ApiError(res.status, payload.error?.code ?? 'unknown', payload.error?.message ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  delete: (path: string) => request<void>('DELETE', path),
};
