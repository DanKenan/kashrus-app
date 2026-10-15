// Central API helper: attaches the signed session token to every request.
// Use apiFetch('/api/...') everywhere instead of raw fetch().

const TOKEN_KEY = 'shutfey_session_token';

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — requests will just be unauthenticated
  }
}

export function clearSession(): void {
  setSessionToken(null);
  try {
    localStorage.removeItem('current_user');
  } catch {
    // ignore
  }
}

/** Drop-in fetch replacement for /api calls — adds Authorization automatically. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getSessionToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 && token) {
    // Token expired or revoked — clear it and tell the app to show login.
    clearSession();
    try {
      window.dispatchEvent(new CustomEvent('shutfey:unauthorized'));
    } catch {
      // ignore
    }
  }
  return res;
}
