// Central API helper: attaches the signed session token to every request.
// Use apiFetch('/api/...') everywhere instead of raw fetch().

const TOKEN_KEY = 'shutfey_session_token';
const KIOSK_DEVICE_KEY = 'kiosk_device';
const KIOSK_VENUE_NAME_KEY = 'kiosk_venue_name';

/** The paired-tablet credential ('<deviceId>.<deviceSecret>'), stored only on the tablet. */
export function getKioskDevice(): string | null {
  try {
    return localStorage.getItem(KIOSK_DEVICE_KEY);
  } catch {
    return null;
  }
}

export function setKioskDevice(device: string | null): void {
  try {
    if (device) localStorage.setItem(KIOSK_DEVICE_KEY, device);
    else localStorage.removeItem(KIOSK_DEVICE_KEY);
  } catch {
    // storage unavailable — the tablet will return to pairing
  }
}

export function clearKioskDevice(): void {
  setKioskDevice(null);
  try {
    localStorage.removeItem(KIOSK_VENUE_NAME_KEY);
  } catch {
    // ignore
  }
}

export function getKioskVenueName(): string | null {
  try {
    return localStorage.getItem(KIOSK_VENUE_NAME_KEY);
  } catch {
    return null;
  }
}

export function setKioskVenueName(name: string | null): void {
  try {
    if (name) localStorage.setItem(KIOSK_VENUE_NAME_KEY, name);
    else localStorage.removeItem(KIOSK_VENUE_NAME_KEY);
  } catch {
    // ignore
  }
}

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
/**
 * QA2 Q2: Change password answers a wrong current password with 401. That is
 * not a session problem. Recognised by the code CURRENT_PASSWORD_WRONG, or by
 * today's exact server words on that one endpoint (the session-expired 401 on
 * the same endpoint says "Sign in required…" and still signs out).
 */
export const WRONG_CURRENT_PASSWORD_TEXT = 'Current password is incorrect.';
async function isWrongCurrentPassword401(input: string, res: Response): Promise<boolean> {
  try {
    const body = await res.clone().json();
    if (!body || typeof body !== 'object') return false;
    if (body.code === 'CURRENT_PASSWORD_WRONG') return true;
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    return path === '/api/auth/change-password' && body.error === WRONG_CURRENT_PASSWORD_TEXT;
  } catch {
    return false;
  }
}

/**
 * Item 11 client part 1 (server #134): timing knobs, one place (tests shorten them).
 * - storeRetryDelaysMs: a GET answered 503 SESSION_STORE_UNAVAILABLE ("could not
 *   check your sign-in right now") is tried again after these waits. It is never
 *   a sign-out; only 401 signs out.
 * - authSettleGraceMs: after a refused WebSocket (4401), wait this long once no
 *   sign-in-changing request is in flight, so a fresh token from that request
 *   (change password, merge accounts) is stored before the session is judged.
 */
export const sessionTiming = { storeRetryDelaysMs: [1000, 3000], authSettleGraceMs: 1500, authSettleMaxMs: 60000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function apiPath(input: string): string {
  return String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
}

/** True for a 503 whose body says the server could not check the sign-in (try again, never sign out). */
export async function isSessionStoreUnavailable(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body = await res.clone().json();
    return !!body && body.code === 'SESSION_STORE_UNAVAILABLE';
  } catch {
    return false;
  }
}

// Requests that can replace this device's token (change password, merge, activate…).
// Counted from the request until its whole answer has arrived; lastSignInChangeAt
// is when the last one finished (its caller stores the new token right after).
let authChangesInFlight = 0;
let lastSignInChangeAt = 0;
function canChangeSignIn(input: string, method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && /^\/api\/(auth|account)\//.test(apiPath(input));
}

/** True while a sign-in-changing request is on its way, or finished less than the grace ago. */
export function signInChangePending(): boolean {
  return authChangesInFlight > 0 || Date.now() - lastSignInChangeAt < sessionTiming.authSettleGraceMs;
}

/**
 * Resolves true once no sign-in-changing request has been in flight for a full
 * grace period (re-checked after the grace, so one started meanwhile is waited
 * for too); false when that did not happen within authSettleMaxMs — the caller
 * then treats the session as unknown and tries again later, never signs out.
 */
export async function waitForSignInChangesToSettle(): Promise<boolean> {
  const started = Date.now();
  while (signInChangePending()) {
    if (Date.now() - started >= sessionTiming.authSettleMaxMs) return false;
    await sleep(Math.min(100, sessionTiming.authSettleGraceMs));
  }
  return true;
}

/** The code of a 401 answer, if it carries one. */
async function unauthorizedCode(res: Response): Promise<string | undefined> {
  try {
    const body = await res.clone().json();
    if (body && typeof body.code === 'string') return body.code;
  } catch {
    // ignore — not every 401 carries a JSON body
  }
  return undefined;
}

function applyKioskUnpaired(responseCode: string | undefined): void {
  if (responseCode === 'KIOSK_UNPAIRED') {
    // The tablet is no longer paired: drop the stored device credential so
    // the tablet returns to the pairing screen.
    clearKioskDevice();
    try {
      window.dispatchEvent(new CustomEvent('shutfey:kiosk-unpaired'));
    } catch {
      // ignore
    }
  }
}

function signOutLocally(): void {
  // Token expired or revoked — clear it and tell the app to show login.
  clearSession();
  try {
    window.dispatchEvent(new CustomEvent('shutfey:unauthorized'));
  } catch {
    // ignore
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const callerHeaders = new Headers(init.headers || {});
  const callerSetAuth = callerHeaders.has('Authorization');
  // Headers for one attempt, built from the token stored NOW (a retry after a
  // wait must not carry a token that was replaced meanwhile).
  const attemptHeaders = (): { headers: Headers; token: string | null } => {
    const headers = new Headers(callerHeaders);
    const token = getSessionToken();
    if (token && !callerSetAuth) headers.set('Authorization', `Bearer ${token}`);
    const kioskDevice = getKioskDevice();
    if (kioskDevice && !headers.has('X-Kiosk-Device')) headers.set('X-Kiosk-Device', kioskDevice);
    return { headers, token };
  };
  const method = (init.method || 'GET').toUpperCase();
  const signInChange = canChangeSignIn(input, method);
  if (signInChange) authChangesInFlight++;
  let res: Response;
  let usedToken: string | null;
  try {
    let attempt = attemptHeaders();
    usedToken = attempt.token;
    res = await fetch(input, { ...init, headers: attempt.headers });
    // Item 11: the server could not check the sign-in (session store down).
    // A read is simply tried again a little later; a write is handed back to
    // its caller as a failed save ("try again"). Never a sign-out.
    if (method === 'GET' || method === 'HEAD') {
      for (const waitMs of sessionTiming.storeRetryDelaysMs) {
        if (!(await isSessionStoreUnavailable(res)) || init.signal?.aborted) break;
        await sleep(waitMs);
        if (init.signal?.aborted) break;
        attempt = attemptHeaders();
        usedToken = attempt.token;
        res = await fetch(input, { ...init, headers: attempt.headers });
      }
    }
    // A sign-in-changing answer counts until its whole body has arrived (the
    // caller's json() then resolves at once and it stores the new token).
    if (signInChange) {
      try {
        await res.clone().text();
      } catch {
        // ignore — the caller reads (or fails to read) the body itself
      }
    }
  } finally {
    if (signInChange) {
      authChangesInFlight--;
      lastSignInChangeAt = Date.now();
    }
  }
  // Track the server's document version from every API response so writes
  // can send back the version this client last saw (version contract).
  trackVersionHeader(res);
  if (res.status === 401) {
    applyKioskUnpaired(await unauthorizedCode(res));
    // QA2 Q2: a wrong CURRENT password on Change password is the person's
    // typo, not an expired session — keep them signed in (the form says so).
    const wrongCurrentPassword = await isWrongCurrentPassword401(input, res);
    // Item 11: only the session this request was sent with is over; a token
    // stored while it was on its way (a fresh sign-in, a changed password) is
    // kept. Checked after the last await, right before clearing.
    if (usedToken && !wrongCurrentPassword && getSessionToken() === usedToken) signOutLocally();
  }
  return res;
}

/**
 * Item 11 client part 1: end this device's session on the server (POST
 * /api/auth/logout with its token) before the app forgets the token. Best
 * effort: a network error or any non-2xx answer still signs out locally (the
 * caller clears the token right after starting this). A plain fetch, not
 * apiFetch, so a 401 here (an already-ended session) never re-enters sign-out.
 * keepalive lets the request finish if the page navigates away (kiosk mode).
 */
export function endServerSession(token: string | null = getSessionToken()): Promise<void> {
  if (!token) return Promise.resolve();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const kioskDevice = getKioskDevice();
  if (kioskDevice) headers['X-Kiosk-Device'] = kioskDevice;
  try {
    return fetch('/api/auth/logout', { method: 'POST', headers, keepalive: true }).then(
      () => undefined,
      () => undefined
    );
  } catch {
    return Promise.resolve();
  }
}

/**
 * Item 11: the WebSocket was closed 4401 ("session ended"). Confirm over HTTP
 * with the socket's own token before signing out, so a socket the server closed
 * while handing this device a fresh token (change password, merge) never signs
 * the person out. 'ended' = a 401 for the token this device still holds (signed
 * out here, the same way as any 401); 'valid' = the session works; 'unknown' =
 * no answer, 503, a newer token or a sign-in change meanwhile (reconnect later).
 */
export async function confirmSessionAfterSocketRefusal(
  token: string,
  stillWanted: () => boolean = () => true
): Promise<'ended' | 'valid' | 'unknown'> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const kioskDevice = getKioskDevice();
  if (kioskDevice) headers['X-Kiosk-Device'] = kioskDevice;
  let res: Response;
  try {
    res = await fetch('/api/agencies/current', { headers });
  } catch {
    return 'unknown';
  }
  if (res.status === 401) {
    const code = await unauthorizedCode(res);
    // After the last await: a token stored meanwhile is a newer session, a
    // sign-in change on its way may store one, and a socket the client dropped
    // or replaced no longer speaks for this device — in each case keep it.
    if (getSessionToken() !== token || signInChangePending() || !stillWanted()) return 'unknown';
    applyKioskUnpaired(code);
    signOutLocally();
    return 'ended';
  }
  return res.ok ? 'valid' : 'unknown';
}

// ---------------------------------------------------------------------------
// Stage 2 version contract (client side).
//
// The server stamps every /api response with X-State-Version (the _v of the
// single app-state/main Firestore document) and every WebSocket message with
// `version`. This module remembers the highest version seen.
//
// WRITE BASELINE CONTRACT (round 5 — the core rule):
//   expectedVersion sent with a write = the document version the data being
//   written was RENDERED FROM. Full stop.
//
//   For form-based edits (task edit modal, notes editor, etc.): capture the
//   baseline when the form LOADS/OPENS via captureEditBaseline(), keep it
//   until the save succeeds, and pass it as expectedVersion explicitly.
//   NEVER use the latest-observed version (lastKnownVersion) as a write
//   baseline for a form: the browser may have heard a newer version over
//   WebSocket AFTER the form rendered, and sending that newer version would
//   silently overwrite someone else's change with stale form data.
//
//   lastKnownVersion remains useful for optimistic UI freshness (e.g.
//   "newer data available" banners) — but it is NOT a write baseline.
//
// The server rejects with 409 VERSION_CONFLICT (version sent but outdated)
// or 428 STALE_CLIENT (no version sent at all — e.g. an old cached PWA
// client).
// ---------------------------------------------------------------------------

let lastKnownVersion: number | undefined = undefined;

/** Highest document version observed from API responses / WS messages. */
export function getLastKnownVersion(): number | undefined {
  return lastKnownVersion;
}

/** Record a version seen from the server (keeps the max). */
export function observeVersion(v: unknown): void {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (Number.isFinite(n) && n >= 0 && (lastKnownVersion === undefined || n > lastKnownVersion)) {
    lastKnownVersion = n;
  }
}

/**
 * Capture the write baseline for an edit form. Call this when the form
 * LOADS or OPENS (not when the user hits save) — it snapshots the document
 * version the form's data was rendered from. Pass the returned value as
 * `expectedVersion` to apiWrite when saving.
 *
 * Why a snapshot, not getLastKnownVersion() at save time: a WebSocket update
 * can arrive while the form is open, bumping lastKnownVersion past what the
 * form shows. Saving with that newer version would silently overwrite the
 * other user's change with this form's stale data. The snapshot freezes the
 * baseline at what the user actually saw.
 *
 * If the baseline is stale by save time, the server answers 409 and the
 * existing conflict flow (draft preserved, re-apply banner) handles it.
 */
export function captureEditBaseline(): number | undefined {
  return lastKnownVersion;
}

/**
 * Read the document version from a specific fetch Response's
 * X-State-Version header — WITHOUT touching the global tracker. Use this
 * for the precise pattern: the version that came with the exact response
 * whose body populated the form.
 *
 *   const res = await apiFetch('/api/tasks/123');
 *   const baseline = versionFromResponse(res); // version this data came from
 *   const task = await res.json();
 *   // ... later, on save:
 *   await apiWrite('/api/tasks/123', { method: 'PUT', expectedVersion: baseline, ... });
 */
export function versionFromResponse(res: Response): number | undefined {
  try {
    const h = res.headers.get('X-State-Version');
    if (!h) return undefined;
    const n = Number(h);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function trackVersionHeader(res: Response): void {
  try {
    const h = res.headers.get('X-State-Version');
    if (h) observeVersion(h);
  } catch {
    // ignore — version tracking is best-effort
  }
}

// ---------------------------------------------------------------------------
// Stale-client drafts: when the server answers 428 STALE_CLIENT, the user's
// screen is older than the version contract and must refresh — but the
// user's unsaved input must NOT be silently discarded. Callers pass
// `draft: { key, label, data }`; apiWrite persists it to localStorage and the
// app offers to re-apply it after refresh (see App.tsx stale-draft banner).
// ---------------------------------------------------------------------------

export interface StaleDraft {
  /** Stable key, e.g. 'checkin:task-123'. One draft per key (latest wins). */
  key: string;
  /** Human-readable label shown in the restore banner. */
  label: string;
  /** Endpoint + method + JSON body needed to re-apply the write. */
  endpoint: string;
  method: string;
  body: unknown;
  savedAt: string;
}

const DRAFTS_KEY = 'shutfey_stale_drafts';

export function loadStaleDrafts(): StaleDraft[] {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveStaleDraft(draft: StaleDraft): void {
  try {
    const rest = loadStaleDrafts().filter((d) => d.key !== draft.key);
    localStorage.setItem(DRAFTS_KEY, JSON.stringify([...rest, draft]));
    try {
      window.dispatchEvent(new CustomEvent('shutfey:stale-draft'));
    } catch {
      // ignore
    }
  } catch {
    // storage unavailable — the in-memory form state is still intact
  }
}

export function discardStaleDraft(key: string): void {
  try {
    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify(loadStaleDrafts().filter((d) => d.key !== key))
    );
  } catch {
    // ignore
  }
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
  if (status === 428)
    return 'Your app is out of date — please refresh the app, then try again. Your input was saved.';
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
 *     // expectedVersion: pass the form's captured baseline explicitly for
 *     // edits (captureEditBaseline() at form load). The auto-injected
 *     // last-seen version is only a fallback for non-form writes.
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
 * - `expectedVersion`: the DOCUMENT version the data being written was
 *   RENDERED FROM (the write baseline — see the contract above). For
 *   form-based edits, capture it with captureEditBaseline() when the form
 *   loads and pass it explicitly. If omitted on PUT/PATCH/DELETE, apiWrite
 *   falls back to the last version this client saw — correct only for
 *   writes whose data was just fetched or re-rendered from the latest
 *   state; form saves MUST pass an explicit baseline.
 *   The server rejects with 409 VERSION_CONFLICT if it doesn't match the
 *   current version — the screen is stale and must refresh. For creates
 *   (POST to a collection), omit it.
 * - If the server answers 428 STALE_CLIENT, no version was sent at all (old
 *   cached client). The write is rejected safely — never silently applied.
 * - `operationId`: stable UUID per user action (see newActionId()). Generate
 *   ONCE per action in the UI component, reuse on retry. If omitted, apiWrite
 *   generates one — but then retries from the caller MUST pass the same ID
 *   back, or the retry becomes a separate operation.
 * - `draft`: on 428 STALE_CLIENT, persist the user's input so a refresh does
 *   not silently discard it. The app restores it from localStorage.
 */
/** Writes sent and not answered yet (the update bar waits for 0: lib/updateSafety.ts). */
let inFlightWrites = 0;
export function writesInFlight(): number {
  return inFlightWrites;
}

type ApiWriteInit = RequestInit & {
  expectedVersion?: number;
  operationId?: string;
  draft?: { key: string; label: string; data: () => unknown };
};

export async function apiWrite<T = any>(input: string, init: ApiWriteInit = {}): Promise<ApiWriteResult<T>> {
  inFlightWrites++;
  try {
    return await apiWriteOnce<T>(input, init);
  } finally {
    inFlightWrites = Math.max(0, inFlightWrites - 1);
  }
}

async function apiWriteOnce<T = any>(input: string, init: ApiWriteInit): Promise<ApiWriteResult<T>> {
  const { expectedVersion, operationId, draft, ...fetchInit } = init;
  // Stable operationId: reuse the caller's (for retries) or generate once.
  const opId = operationId || crypto.randomUUID();
  const method = (fetchInit.method || 'POST').toUpperCase();
  // Version contract: updates automatically carry the last version this
  // client saw. An explicit expectedVersion from the caller wins.
  const versionToSend =
    expectedVersion !== undefined
      ? expectedVersion
      : method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? getLastKnownVersion()
        : undefined;

  let res: Response;
  let sentBody: unknown = undefined;
  // For body-less updates (e.g. DELETE with no body), the version and
  // operation ID travel as query params — the server reads both places.
  let url = input;
  if (!fetchInit.body && versionToSend !== undefined) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}expectedVersion=${encodeURIComponent(String(versionToSend))}&operationId=${encodeURIComponent(opId)}`;
  }
  try {
    // Inject versioning fields into the JSON body.
    let body = fetchInit.body;
    const headers = new Headers(fetchInit.headers || {});
    if (body && typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (versionToSend !== undefined && parsed.expectedVersion === undefined) {
            parsed.expectedVersion = versionToSend;
          }
          if (!parsed.operationId) {
            parsed.operationId = opId;
          }
          body = JSON.stringify(parsed);
          sentBody = parsed;
        }
      } catch {
        // Not JSON — send as-is; server will handle missing fields.
      }
    }
    if (!headers.has('Content-Type') && typeof body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
    res = await apiFetch(url, { ...fetchInit, body, headers });
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
  // Stale client: the write was rejected safely. Preserve the user's input
  // so the required refresh does not silently discard it.
  if (res.status === 428 && draft) {
    try {
      saveStaleDraft({
        key: draft.key,
        label: draft.label,
        endpoint: input,
        method,
        body: sentBody !== undefined ? sentBody : draft.data(),
        savedAt: new Date().toISOString(),
      });
    } catch {
      // ignore — the form state in memory is still intact
    }
  }
  return {
    ok: false,
    status: res.status,
    data,
    error: describeWriteError(res.status, serverMessage),
    code,
  };
}
