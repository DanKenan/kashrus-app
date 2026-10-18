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

// ---------------------------------------------------------------------------
// Structured write helper (Stage 2: transactional backend).
// Writes can now fail with 409 (version/conflict — someone else changed the
// data) or 503 (save failed — the database was unreachable). Every POST/PUT/
// DELETE/PATCH call should go through apiWrite instead of apiFetch so those
// failures surface as friendly messages instead of silent no-ops or fake
// success toasts.
// ---------------------------------------------------------------------------

export interface ApiWriteResult<T = any> {
  /** true only when the server confirmed the write (res.ok). */
  ok: boolean;
  status: number;
  /** Parsed response body on success; parsed error body (or null) on failure. */
  data: T;
  /** Friendly, display-ready error message when ok === false. */
  error: string | null;
  /** Server error code when provided (e.g. VERSION_CONFLICT, SAVE_FAILED). */
  code?: string;
}

/**
 * Friendly message for a failed write. Prefers the server's message when it
 * is user-facing (Stage 2 conflict/save-failure messages are), otherwise
 * falls back to plain wording for the status.
 */
export function describeWriteError(status: number, serverMessage?: string): string {
  if (serverMessage && serverMessage.trim()) return serverMessage.trim();
  if (status === 409) return 'Someone else changed this — please review and retry.';
  if (status === 503) return "Couldn't save — please check your connection and retry.";
  if (status === 0) return "Couldn't save — please check your connection and retry.";
  if (status === 401) return 'Your session expired — please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'That item no longer exists — it may have been deleted.';
  return "Couldn't save — please try again.";
}

/**
 * Generate a stable operation ID for ONE user action. Call this ONCE when the
 * user initiates the action (e.g., on button click), then pass the same ID to
 * apiWrite on every attempt including retries. Do NOT generate a new ID per
 * retry — the server uses it to detect duplicate submissions.
 *
 * Example:
 *   const actionId = newActionId();
 *   const attempt = async () => apiWrite('/api/tasks/123', {
 *     method: 'PUT',
 *     body: JSON.stringify({ ... }),
 *     operationId: actionId,  // same ID on retry
 *     expectedVersion: task._v,  // entity's last-known version
 *   });
 */
export function newActionId(): string {
  return crypto.randomUUID();
}

/**
 * POST/PUT/DELETE/PATCH wrapper: performs the request, parses the body, and
 * returns a structured result. Never throws for HTTP error statuses; only
 * throws on truly unexpected failures. Callers must check `result.ok` before
 * treating the write as successful or showing a success toast.
 *
 * Versioning & idempotency contract (Stage 2):
 * - `expectedVersion`: the entity's last-known `_v` (from when the UI loaded
 *   it). The server rejects with 409 VERSION_CONFLICT if it doesn't match —
 *   the caller's screen is stale and must refresh. CALLERS MUST PROVIDE THIS
 *   for updates to existing entities; apiWrite cannot know which entity you're
 *   editing. For creates (no existing entity), omit it.
 * - `operationId`: stable UUID per user action (see newActionId()). Generate
 *   ONCE per action in the UI component, reuse on retry. If omitted, apiWrite
 *   generates one — but then retries from the caller MUST pass the same ID
 *   back, or the retry becomes a separate operation.
 */
export async function apiWrite<T = any>(
  input: string,
  init: RequestInit & { expectedVersion?: number; operationId?: string } = {}
): Promise<ApiWriteResult<T>> {
  const { expectedVersion, operationId, ...fetchInit } = init;
  // Stable operationId: reuse the caller's (for retries) or generate once.
  const opId = operationId || crypto.randomUUID();

  let res: Response;
  try {
    // Inject versioning fields into the JSON body.
    let body = fetchInit.body;
    const headers = new Headers(fetchInit.headers || {});
    if (body && typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (expectedVersion !== undefined && parsed.expectedVersion === undefined) {
            parsed.expectedVersion = expectedVersion;
          }
          if (!parsed.operationId) {
            parsed.operationId = opId;
          }
          body = JSON.stringify(parsed);
        }
      } catch {
        // Not JSON — send as-is; server will handle missing fields.
      }
    }
    if (!headers.has('Content-Type') && typeof body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
    res = await apiFetch(input, { ...fetchInit, body, headers });
  } catch {
    return {
      ok: false,
      status: 0,
      data: null as T,
      error: describeWriteError(0),
      code: 'NETWORK_ERROR',
    };
  }
  const data = (await res.json().catch(() => ({}))) as T;
  if (res.ok) {
    return { ok: true, status: res.status, data, error: null };
  }
  const body = (data || {}) as Record<string, any>;
  const code = typeof body.code === 'string' ? body.code : undefined;
  const serverMessage = typeof body.error === 'string' ? body.error : undefined;
  return {
    ok: false,
    status: res.status,
    data,
    error: describeWriteError(res.status, serverMessage),
    code,
  };
}
