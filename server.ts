import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { initializeApp, getApps, getApp } from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import webpush from 'web-push';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as media from './src/server/media.js';
import {
  agencyPublicProfile,
  agencyAdminView,
  agencyIdForVerifiedHost,
  normalizeSlug,
  validateSlug,
  slugBase,
  uniqueSlug,
  normalizeDomain,
  validateDomain,
  validateBrandName,
  validateLogoUrl,
  findSlugClash,
  findDomainClash,
  withCustomDomain,
} from './src/server/agency-fields.js';
import { classifySessionClaims, resolveSessionRow, sessionClaimsFor, type SessionClaims } from './src/server/session-token.ts';
import { agencyIsCleared } from './src/server/agency-flags.ts';
import { buildAdminExport } from './src/server/admin-export.js';
import { isPlatformOperator, PLATFORM_OPERATOR_FORBIDDEN } from './src/server/platform-auth.js';
import { log } from './src/server/log.ts';
import {
  DEFAULT_TIME_ZONE,
  effectiveTimeZone,
  isValidTimeZone,
  isWorkDate,
  workDateIn,
  minutesIn,
  addDays,
  nextResetDate,
} from './src/lib/workday.ts';
// 6c: shared any-time recognition and write normalization.
import { isAnyTimeTask, normalizeAnyTimeTask } from './src/lib/anyTime.ts';
import { mountStaticFiles } from './src/server/static-files.ts';
import { consistencyRoute } from './src/server/consistency-route.js';

// ---------------------------------------------------------------------------
// Auth: bcrypt passwords + signed session tokens (HMAC-SHA256 JWT)
// ---------------------------------------------------------------------------

// JWT signing secret: env first, else generated once and persisted with state
// (same pattern as VAPID keys) so tokens survive restarts and deploys.
let jwtSecret: string | null = null;

function getJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!jwtSecret) {
    jwtSecret = crypto.randomBytes(48).toString('hex');
    commitState(
      (freshDoc) => ({ doc: { ...freshDoc, jwtSecret }, result: null }),
      { label: 'persist-jwt-secret' }
    ).catch((err) => log.warn('[getJwtSecret] Persist failed:', (err as any)?.message));
  }
  return jwtSecret;
}

function isBcryptHash(s: unknown): boolean {
  return (
    typeof s === 'string' &&
    (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$'))
  );
}

// ---------------------------------------------------------------------------
// Password-reset code hashing + rate limiting (Stage 2 hardening).
// ---------------------------------------------------------------------------

/** SHA-256 hex of `reset-code:<pepper>:<code>`.
 *
 * Pepper is a DEDICATED secret, separate from the JWT signing secret.
 * Priority: RESET_CODE_PEPPER env var → Firestore-stored `resetPepper`
 * (initialized once at startup, before any request handling).
 *
 * Why not reuse the JWT secret? The JWT secret is stored IN the Firestore
 * document alongside the code hashes. If an attacker reads the document
 * (e.g., via open Firestore rules), they'd get both the hashes AND the
 * pepper, defeating the hashing. A dedicated pepper from an env var lives
 * outside Firestore.
 *
 * STARTUP INITIALIZATION (no async race): initResetPepper() runs during
 * startServer(), AFTER Firestore loads and BEFORE the server accepts requests.
 * The pepper is therefore STABLE before any verification happens. There is
 * no async generation during request handling.
 *
 * Rotation: set a new RESET_CODE_PEPPER env var and redeploy. All outstanding
 * reset codes become invalid (they were hashed with the old pepper) — users
 * simply request new codes. No data migration needed.
 *
 * TECH DEBT: On Cloud Run without RESET_CODE_PEPPER set, we fall back to the
 * Firestore-persisted pepper (better than crashing, but the pepper lives
 * alongside the hashes). Don should set the env var in production.
 */
let _resetPepper: string | null = null;

async function initResetPepper(): Promise<void> {
  // 1. Env var wins (production configuration).
  if (process.env.RESET_CODE_PEPPER) {
    _resetPepper = process.env.RESET_CODE_PEPPER;
    console.log('[Security] Using RESET_CODE_PEPPER from environment.');
    return;
  }
  // 2. Firestore-persisted pepper (stable across restarts).
  // Read it synchronously during startup — no race.
  if (firestoreDb) {
    try {
      const snap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
      const stored = snap.exists ? (snap.data() as any)?.resetPepper : null;
      if (stored && typeof stored === 'string') {
        _resetPepper = stored;
        console.log('[Security] Using Firestore-persisted reset pepper.');
        return;
      }
    } catch (err: any) {
      log.warn('[Security] Could not read reset pepper from Firestore:', err?.message);
    }
  }
  // 3. Generate and persist (first boot only).
  _resetPepper = crypto.randomBytes(32).toString('hex');
  if (!process.env.K_SERVICE) {
    log.warn('[Security] Generated ephemeral reset pepper for local dev. Set RESET_CODE_PEPPER env var for production.');
  } else {
    log.error('[Security] WARNING: No RESET_CODE_PEPPER env var on Cloud Run. Using generated pepper persisted to Firestore. Set the env var to fix this (see docs).');
  }
  // Persist transactionally so it survives restarts.
  if (firestoreDb) {
    try {
      await commitState(
        (freshDoc) => {
          // Another instance may have written it concurrently — prefer existing.
          if (freshDoc.resetPepper && typeof freshDoc.resetPepper === 'string') {
            _resetPepper = freshDoc.resetPepper;
            return { doc: freshDoc, result: null };
          }
          return { doc: { ...freshDoc, resetPepper: _resetPepper }, result: null };
        },
        { label: 'init-reset-pepper' }
      );
    } catch (err: any) {
      log.warn('[Security] Could not persist reset pepper:', err?.message);
    }
  }
}

function getResetPepper(): string {
  if (!_resetPepper) {
    throw new Error('[Security] Reset pepper not initialized. initResetPepper() must run during startup before any request handling.');
  }
  return _resetPepper;
}

function hashResetCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(`reset-code:${getResetPepper()}:${code}`)
    .digest('hex');
}

/** Constant-time comparison of a submitted code against a stored request.
 *  Handles both new `codeHash` entries and legacy plaintext `code` entries. */
function verifyResetCode(code: string, stored: PasswordResetRequest): boolean {
  const submitted = String(code || '').trim();
  if (!submitted) return false;
  if (stored.codeHash) {
    const expected = Buffer.from(stored.codeHash, 'hex');
    const actual = Buffer.from(hashResetCode(submitted), 'hex');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }
  // Legacy plaintext entry (pre-hardening). Expires naturally via 15-min TTL.
  if (stored.code) {
    const expected = Buffer.from(stored.code);
    const actual = Buffer.from(submitted);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }
  return false;
}

/**
 * Test-mode gate for /api/__test__ endpoints.
 * BOTH conditions required:
 *   1. STAGE2_TEST_MODE=true (explicit opt-in)
 *   2. NOT on Cloud Run (K_SERVICE is always set there)
 *
 * Defense-in-depth: even if STAGE2_TEST_MODE is accidentally set in
 * production, the endpoints remain unreachable on Cloud Run. These endpoints
 * can reveal full database state and reset codes — they must never exist
 * in production.
 */
function isTestMode(): boolean {
  return process.env.STAGE2_TEST_MODE === 'true' && !process.env.K_SERVICE;
}

/**
 * Item 6 — the one clock every work-day decision uses (rollover tick, daily
 * reset, overdue check, new-venue workday). Real time, except in test mode,
 * where /api/__test__/clock can pin it (a fake clock for DST/rollover tests).
 */
let testNowOverrideMs: number | null = null;
function serverNow(): Date {
  return new Date(isTestMode() && testNowOverrideMs !== null ? testNowOverrideMs : Date.now());
}

/**
 * ROUND 5 — staged-revision guard state.
 * Production reads STAGED_REVISION from the environment (baked into the
 * staged revision by the deploy workflow; removed to go live). The test
 * suite toggles it at runtime via /api/__test__/staged (test mode only)
 * because the server runs in a child process the tests cannot restart
 * with different env vars.
 */
let stagedOverride: boolean | undefined = undefined;
function isStagedRevision(): boolean {
  if (stagedOverride !== undefined) return stagedOverride;
  return process.env.STAGED_REVISION === 'true';
}

/**
 * Client IP for rate limiting.
 *
 * Cloud Run sits behind Google's load balancer, which appends the real client
 * IP to X-Forwarded-For. We configure `trust proxy` (see server startup) so
 * Express's req.ip returns the leftmost UNTRUSTED address — i.e., the real
 * client IP, not a spoofed value. A client that sends a fake X-Forwarded-For
 * cannot bypass rate limits because Express strips trusted proxy hops.
 *
 * Fallback order: req.ip (trust-aware) → socket address → 'unknown'.
 */
function getClientIp(req: any): string {
  // req.ip is trust-proxy aware (see app.set('trust proxy') at startup).
  const ip = req.ip;
  if (typeof ip === 'string' && ip.trim() && ip !== 'unknown') {
    return ip.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour sliding window

function emptyRateLimits(): PasswordResetRateLimits {
  return { emailRequests: {}, ipRequests: {}, ipVerifies: {} };
}

/** Prune timestamps older than the window; returns pruned array. */
function pruneWindow(timestamps: string[], nowMs: number): string[] {
  return (Array.isArray(timestamps) ? timestamps : []).filter(
    (t) => nowMs - new Date(t).getTime() < RATE_LIMIT_WINDOW_MS
  );
}

/**
 * Check a sliding-window rate limit inside a transaction mutator.
 * Throws RateLimitError (never retried) when over the limit; otherwise
 * returns the updated rate-limit state with this hit recorded.
 */
function checkRateLimit(
  limits: PasswordResetRateLimits,
  bucket: keyof PasswordResetRateLimits,
  key: string,
  maxPerHour: number,
  nowMs: number
): PasswordResetRateLimits {
  const pruned = pruneWindow(limits[bucket][key], nowMs);
  if (pruned.length >= maxPerHour) {
    const oldest = new Date(pruned[0]).getTime();
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - nowMs) / 1000)
    );
    throw new RateLimitError(
      `Too many requests. Please try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
      retryAfterSec
    );
  }
  return {
    ...limits,
    [bucket]: {
      ...limits[bucket],
      [key]: [...pruned, new Date(nowMs).toISOString()],
    },
  };
}

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}


/** Returns 'valid' | 'valid-needs-upgrade' (legacy plaintext matched) | 'invalid'. */
async function checkPassword(
  plain: string,
  stored?: string
): Promise<'valid' | 'valid-needs-upgrade' | 'invalid'> {
  if (!stored || typeof stored !== 'string') return 'invalid';
  if (isBcryptHash(stored)) {
    return (await bcrypt.compare(plain, stored)) ? 'valid' : 'invalid';
  }
  // Legacy plaintext password: verify, then the caller upgrades it to bcrypt.
  return stored === plain ? 'valid-needs-upgrade' : 'invalid';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const TOKEN_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const KIOSK_TOKEN_TTL_SECONDS = 12 * 3600; // 12 hours

/** Legacy v1 token { sub, iat, exp }. Item 8d: only signSessionToken calls
 * this shape now (for rows without personId) and the compatibility tests. */
function signToken(userId: string): string {
  return signClaims({ sub: userId });
}

function signClaims(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ ...claims, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const sig = base64url(
    crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${sig}`;
}

/** Item 8d: the session token login / reset-password / register issue.
 * v2 { v:2, sub: personId, mem: row id, ep: tokenEpoch||0 } for a migrated
 * row (personId === id); the legacy v1 { sub } for any other row. */
function signSessionToken(row: { id: string; personId?: string; tokenEpoch?: unknown }): string {
  return signClaims(sessionClaimsFor(row));
}

/** Kiosk session token: venue-scoped, 12h expiry, kiosk:true claim.
 * pv = the kiosk PIN version (String(kioskPinRev), 2b — a PIN change
 * increments the revision and revokes old tokens; pre-2b tokens carrying a
 * kioskPinSetAt timestamp as pv simply fail re-validation).
 * dev = the DEVICE id this session is bound to (2b): the token is valid
 * only while that device exists and still points at the same agency/venue. */
function signKioskToken(userId: string, agencyId: string, venueId: string, pv: string, dev: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({ sub: userId, kiosk: true, agencyId, venueId, pv, dev, iat: now, exp: now + KIOSK_TOKEN_TTL_SECONDS })
  );
  const sig = base64url(
    crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${sig}`;
}

function verifyToken(token: string): SessionClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const expected = base64url(
      crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest()
    );
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    // Item 8d: strict classification (kiosk | v1 | v2, anything else null).
    return classifySessionClaims(data);
  } catch {
    return null;
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();
const server = http.createServer(app);

// Trust Cloud Run's proxy chain for correct client IP detection.
// Cloud Run terminates TLS at Google's load balancer and forwards with
// X-Forwarded-For. `trust proxy` (1 hop) makes req.ip return the real client
// IP. Without this, req.ip would return the load balancer's internal address
// and per-IP rate limiting would be useless (all clients share one IP).
// In local dev (no proxy), this is harmless — req.ip falls back to socket.
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));

// Stage 2 version contract: every /api response carries the current document
// version in the X-State-Version header. Clients track it (see
// src/lib/api.ts) and send it back as expectedVersion on updates, so a stale
// screen can never silently overwrite newer data. (stateVersion is declared
// further below at module level; this closure only reads it per-request,
// long after module load.)
app.use('/api', (_req, res, next) => {
  const origJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    try {
      if (typeof stateVersion === 'number') {
        res.setHeader('X-State-Version', String(stateVersion));
      }
    } catch {
      /* header best-effort; never break the response */
    }
    return origJson(body);
  };
  next();
});

// ---------------------------------------------------------------------------
// Request authentication + custom-domain agency resolution.
// Every /api route except the public ones below requires a signed session
// token (issued at login / kiosk PIN login). The middleware verifies the
// token and FORCES the verified user's email into the request, so the
// existing per-endpoint agency-scoping logic (which keys off userEmail)
// becomes trustworthy — clients can no longer impersonate anyone by
// sending an arbitrary email address.
// ---------------------------------------------------------------------------

const PUBLIC_API_ROUTES: Array<{ method: string; path: string }> = [
  // Note: req.path inside app.use('/api') is stripped of the /api prefix.
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/setup' },
  { method: 'POST', path: '/auth/forgot-password' },
  { method: 'POST', path: '/auth/verify-reset-code' },
  { method: 'POST', path: '/auth/reset-password' },
  { method: 'POST', path: '/agencies/register' },
  { method: 'GET', path: '/push/public-key' },
  { method: 'GET', path: '/agencies/by-domain' },
  // Kiosk (2b): a tablet is paired to one venue by an admin/coordinator.
  // Pairing start/status and the device record are authenticated by the
  // secrets they carry; login requires the device header. The old public
  // venue picker and staff list are GONE.
  { method: 'POST', path: '/kiosk/pairing/start' },
  { method: 'GET', path: '/kiosk/pairing/status' },
  { method: 'GET', path: '/kiosk/device' },
  { method: 'POST', path: '/kiosk/device/unpair' },
  { method: 'POST', path: '/kiosk/login' },
  // Test-only endpoints (registered only when STAGE2_TEST_MODE=true; the
  // routes themselves don't exist in production, but list them here so the
  // auth middleware doesn't 401 them in test mode).
  ...(isTestMode()
    ? [
        { method: 'GET', path: '/__test__/firestore-doc' },
        { method: 'GET', path: '/__test__/last-reset-code' },
        { method: 'POST', path: '/__test__/expire-reset' },
        { method: 'POST', path: '/__test__/inject-fixture' },
        { method: 'POST', path: '/__test__/staged' },
        { method: 'POST', path: '/__test__/revoke-user-silent' },
        { method: 'POST', path: '/__test__/drop-socket-meta' },
        { method: 'POST', path: '/__test__/mint-token' },
        { method: 'POST', path: '/__test__/set-password' },
        { method: 'POST', path: '/__test__/mint-kiosk-token' },
        { method: 'GET', path: '/__test__/alert-routing' },
      ]
    : []),
];

function isPublicApiRoute(method: string, path: string): boolean {
  return PUBLIC_API_ROUTES.some((r) => r.method === method && r.path === path);
}

// Custom domains: agencyId -> hostname (e.g. app.hartfordkashrut.org).
// Item 8a: only a VERIFIED domain held by exactly one agency matches (fail
// closed). Nothing in this release can verify a domain, so an admin-typed,
// unverified customDomain never influences a request or the public lookup.
function agencyIdForHostname(hostname: string): string | null {
  return agencyIdForVerifiedHost(agencies as any[], hostname);
}

app.use('/api', async (req, res, next) => {
  // MAINTENANCE HOTFIX (2026-10-18, from main): operator cutover switch.
  // Refuses all mutations with 503 so old-version writes stop before cutover.
  if (process.env.MAINTENANCE_MODE === 'true' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(503).json({
      error: 'Shutfey is briefly down for maintenance. Please try again in a few minutes.',
      code: 'MAINTENANCE',
    });
  }

  // BLOCKER 2 fix: FORCE_LOCAL_MODE is a READ-ONLY maintenance mode.
  // All mutating requests (POST/PUT/DELETE/PATCH) are rejected with 503 —
  // never claim success for writes that only hit ephemeral local disk.
  // GET requests continue to work (read-only maintenance).
  if (process.env.FORCE_LOCAL_MODE === 'true' && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    return res.status(503).json({
      error: 'Maintenance mode — writes are temporarily disabled. Your data is safe; please try again shortly.',
      code: 'MAINTENANCE',
    });
  }

  // ROUND 5 — staged-revision guard. A revision deployed with
  // STAGED_REVISION=true is staged for cutover verification: it serves reads
  // and health checks, but MUST NOT write to production before the operator
  // flips it live (CUTOVER.md). This guarantees old unversioned writers and
  // new transactional writers can never be live simultaneously, even if the
  // staged revision's direct URL is hit before cutover. The flag is removed
  // with `gcloud run services update --remove-env-vars STAGED_REVISION
  // --no-traffic` (which creates the live revision); it is never flipped
  // in-place on a serving revision.
  // Exemption: the test-only toggle endpoint itself must stay reachable so
  // the suite can turn the guard off again (test endpoints don't exist in
  // production — see isTestMode()).
  const isStagedToggle = req.path === '/__test__/staged';
  if (isStagedRevision() && !isStagedToggle && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    return res.status(503).json({
      error: 'This app revision is staged for verification and is not live yet. Please wait for the cutover to complete.',
      code: 'NOT_YET_LIVE',
    });
  }

  // Resolve agency from custom domain when present (used by login/agency pages).
  const domainAgencyId = agencyIdForHostname(req.hostname || '');
  if (domainAgencyId) {
    (req as any).domainAgencyId = domainAgencyId;
  }

  if (isPublicApiRoute(req.method, req.path)) return next();

  // Scheduler exception: POST /api/media/sweep and POST /api/internal/consistency-check
  // accept a verified Google OIDC token from Cloud Scheduler INSTEAD OF a session
  // token. This is narrowly scoped — only these exact routes, only POST, only with
  // a valid OIDC token. All other routes require session auth as before.
  if (req.method === 'POST' && (req.path === '/media/sweep' || req.path === '/internal/consistency-check')) {
    const oidcValid = await verifySchedulerOidc(req);
    if (oidcValid) {
      // Mark as scheduler-authenticated; the route handler checks this
      // flag instead of requiring an admin session.
      (req as any).schedulerAuth = true;
      return next();
    }
    // If OIDC invalid, fall through to normal session auth (admin can still
    // trigger manually). Do NOT return 401 here — let the session check run.
  }

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const payload = token ? verifyToken(token) : null;
  // Item 8d: ONE row resolver for HTTP and WS (v2 binding + epoch, v1 epoch 0, kiosk by id).
  const user = resolveSessionRow(payload, users as any[]) as UserProfile | undefined;

  if (!user) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }

  // Kiosk session: mark the request; the scope middleware enforces the allowlist.
  // Re-validate the user on every kiosk request (revocation without a token
  // store): the token is valid only while the user still exists, still has a
  // kioskPinHash (PIN removed = kiosk access revoked), still belongs to the
  // token's agencyId, and is still assigned to the token's venueId. Any
  // mismatch → 401 so the tablet returns to the PIN screen.
  if (payload?.kind === 'kiosk') {
    const tokenAgencyId = payload.agencyId;
    const tokenVenueId = payload.venueId;
    const tokenPv = payload.pv;
    const tokenDev = payload.dev;
    // Fail closed: a kiosk token without agencyId, venueId, pv or dev is
    // invalid — never fall through as a phone session. pv must match the
    // current PIN revision (a PIN re-save revokes old tokens; pre-2b tokens
    // carrying a timestamp pv fail here, as do 2a-era tokens with no dev).
    // C1: the session is bound to its DEVICE — the device must still exist
    // and still point at the token's agency and venue (unpair kills it).
    // Addendum finding 1: device PROOF on every request — the request must
    // also carry X-Kiosk-Device, and the device it resolves to (hash
    // compare, timing-safe) must be the token's own device. A valid token
    // with no header, or with ANOTHER tablet's credential, is a 401.
    // K1: one shared re-validation (kioskSessionStillValid) for HTTP and WS.
    const provedDevice = resolveKioskDevice(req);
    const stillValid =
      typeof tokenDev === 'string' &&
      !!provedDevice &&
      provedDevice.id === tokenDev &&
      kioskSessionStillValid(user, { agencyId: tokenAgencyId, venueId: tokenVenueId, pv: tokenPv, deviceId: tokenDev });
    if (!stillValid) {
      return res.status(401).json({ error: 'Sign in required. Please log in again.' });
    }
    (req as any).kiosk = true;
    (req as any).kioskVenueId = tokenVenueId;
    (req as any).kioskDeviceId = tokenDev;
  }

  // Force the verified identity: endpoints keying off userEmail now see the
  // authenticated user, never a client-supplied impersonation.
  // K1: on a kiosk token the identity is the ACTING user — an admin on a
  // kiosk is a mashgiach at the tablet's venue (kioskActingUser).
  (req as any).authUser = (req as any).kiosk === true ? kioskActingUser(user, (req as any).kioskVenueId) : user;
  if (req.query && typeof req.query === 'object') {
    (req.query as any).userEmail = user.email;
  }
  if (req.body && typeof req.body === 'object') {
    (req.body as any).userEmail = user.email;
  }

  // Kiosk scope enforcement: a kiosk token is accepted ONLY on the allowlist.
  // Everything else → 403 KIOSK_SCOPE (never 401, so the tablet doesn't bounce
  // to login). The venue scoping within allowlisted routes is handled by
  // scopedVenueIds (kiosk branch) and the per-route venue checks.
  if ((req as any).kiosk === true) {
    const method = req.method;
    const path = req.path; // stripped of /api prefix
    const allowed =
      (method === 'GET' && path === '/tasks') ||
      (method === 'PUT' && /^\/tasks\/[^/]+$/.test(path)) ||
      (method === 'POST' && /^\/tasks\/[^/]+\/check-in$/.test(path)) ||
      (method === 'DELETE' && /^\/tasks\/[^/]+\/check-in\/[^/]+$/.test(path)) ||
      (method === 'GET' && path === '/history') ||
      // 5a: the kiosk Updates sheet is READ-ONLY — no note writes, no read marks.
      (method === 'GET' && path === '/handoff-notes') ||
      (method === 'GET' && path === '/announcements') ||
      (method === 'GET' && path === '/venues') ||
      (method === 'GET' && path === '/users') ||
      (method === 'GET' && path === '/health');
    if (!allowed) {
      return res.status(403).json({
        error: 'This kiosk session can only clock in and out.',
        code: 'KIOSK_SCOPE',
      });
    }
  }
  next();
});

// ---------------------------------------------------------------------------
// Stage 2 Section A: server-side authorization helpers.
// The auth middleware above resolves the signed session token into
// req.authUser (the VERIFIED user record). These helpers standardize on that
// — handlers must NEVER trust role/agencyId from the request body.
// ---------------------------------------------------------------------------

/** The authenticated user from the session token (set by the auth middleware). */
function getAuthUser(req: any): UserProfile | undefined {
  return (req as any).authUser as UserProfile | undefined;
}

/** The caller's agency, from the verified session user.
 *
 * Throws when there is no authenticated user — an unauthenticated request
 * must NEVER silently become an HKC caller. The 'agency-hkc' fallback applies
 * ONLY to an authenticated legacy user record with no agencyId set.
 * Every /api route is behind the auth middleware (401 before handlers run),
 * so the throw is unreachable in normal flow; it is fail-closed by design. */
function callerAgencyId(req: any): string {
  const user = getAuthUser(req);
  if (!user) {
    throw new Error('callerAgencyId: no authenticated user on request');
  }
  return user.agencyId || 'agency-hkc';
}

/**
 * Require an authenticated session user. Sends 401 and returns null when
 * there is none; otherwise returns the verified user record. Use at the top
 * of every handler that keys data or attribution off the caller.
 */
function requireAuthUser(req: any, res: any): UserProfile | null {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: 'Sign in required. Please log in again.' });
    return null;
  }
  return user;
}

/**
 * RULE T — venue scope for a caller (rule N: one helper, used everywhere).
 * "Coordinators only lead in the venues they are assigned to. Only the admin
 * is over everything." Don's decision, Oct 19 2026.
 *
 * Admin → 'agency' (the whole agency).
 * Any other role → [their own venueId] (an ARRAY so multi-venue coordinators
 * in PR 9 are a one-line change), or [] when no venue is assigned.
 * Unknown/missing user or role → [] (fail closed).
 */
/**
 * 9a: does this person (non-admin) work at venueId? Their scope decides —
 * home venue plus any server-granted venue of their own agency. A payload
 * row (stripped of server-only fields) is resolved against the cached full
 * row by id, so the answer never depends on what a client or broadcast saw.
 */
function personAtVenue(u: any, venueId: string | undefined | null): boolean {
  if (!u || typeof venueId !== 'string' || !venueId) return false;
  // The row's OWN role and home decide (a kiosk acting copy keeps its tablet
  // venue); only the server-only list is borrowed from the cached row, and
  // only when that row is the same person-state (same role and home).
  let full: any = u;
  if (u.personId === undefined && typeof u.id === 'string') {
    const stored: any = users.find((x: any) => x && x.id === u.id);
    if (stored && stored.personId && stored.role === u.role && stored.venueId === u.venueId) {
      full = { ...u, personId: stored.personId, venueAccess: stored.venueAccess };
    }
  }
  const s = venueScopeFor(full as any);
  return s !== 'agency' && s.includes(venueId);
}

/** 9a: does this person's scope meet a non-admin viewer's scope list? */
function personInScope(u: any, scope: string[]): boolean {
  if (!u) return false;
  return scope.some((v) => personAtVenue(u, v));
}

function venueScopeFor(user: UserProfile | null | undefined): 'agency' | string[] {
  // 9a: a migrated person's server-only venueAccess, intersected with the
  // venues CURRENTLY owned by their agency (fail closed; never all venues).
  // Unmigrated rows and empty/malformed lists: the valid home venue only.
  return venueScopeOf(user as any, venues as any);
}

/** A7/B6: field-write gate for ingredients/factory-reports — admin, or a
 * coordinator at the venue, or a canFill mashgiach/worker (or owner with
 * canFillTasks) at the venue. The venue check is separate from the role
 * grant: both must pass for a non-admin. */
function mayDoFieldWrite(user: UserProfile | null | undefined, venueId: string): boolean {
  if (!user) return false;
  if ((user as any).role === 'admin') return true;
  if (!callerMaySeeVenue(user, venueId)) return false;
  if ((user as any).role === 'coordinator') return true;
  return canFillTasks(user);
}

/** Event task-work gate (toggle + tasks-only PUT): admin, the venue's
 * coordinator, or a canFill caller at the event's venue or assigned to the
 * event. (A mashgiach assigned to supervise an event at another venue may
 * work its tasks — own records — per the documented exception; fix round 1.) */
/**
 * Normalize one STORED user record the same way hydration does (legacy
 * role 'worker' → 'mashgiach', default permissions, legacy agencyId and
 * venueId defaults, never reset passwords). Rule N: one function, used in
 * hydration AND on freshCaller inside the PUT /api/events transaction
 * before the caller-change compare — comparing the raw stored record
 * against the hydrated cache false-fires for legacy records (the doc
 * keeps 'worker'/missing fields forever; the cache is normalized).
 */
function normalizeStoredUser(u: any): any {
  let assignedVenue = u.venueId;
  if (!assignedVenue && u.role !== 'admin') {
    assignedVenue = 'venue-crown-market';
  }
  // Convert legacy role 'worker' to 'mashgiach'
  const role = u.role === 'worker' ? 'mashgiach' : (u.role || 'mashgiach');
  const permissions = u.permissions || {
    canFillTasks: role === 'admin' || role === 'coordinator' || role === 'mashgiach',
    canAssignTasks: role === 'admin' || role === 'coordinator',
  };
  return {
    ...u,
    role,
    permissions,
    agencyId: u.agencyId || 'agency-hkc',
    venueId: assignedVenue,
    // NEVER reset passwords on state load. Passwords are only set
    // via explicit flows (setup, change-password, forgot-password).
    password: u.password || '',
  };
}

/**
 * Event visibility — ONE rule used by GET /api/events, agencyStateFor
 * (INITIAL_STATE), DEMO_RESTORED snapshots, and the EVENT_* broadcasts
 * (item 7, fix round 1). Admin sees everything. Anyone sees events at
 * venues in their scope (rule T). PLUS the documented exception: a
 * mashgiach or worker ASSIGNED to an event sees that one event even at
 * another venue — "own records": the agency assigned them to supervise a
 * catered event at another location. The assignment email comes from the
 * STORED event and the recipient email from the AUTHENTICATED record —
 * never from a client-supplied field. The exception grants THAT ONE EVENT
 * only: never the other venue's tasks, roster, incidents, or history.
 */
function canSeeEventServer(event: any, recipient: UserProfile | null | undefined): boolean {
  if (!recipient) return false;
  const r = recipient as any;
  if (r.role === 'admin') return true;
  if (callerMaySeeVenue(recipient, event?.venueId)) return true;
  if ((r.role === 'mashgiach' || r.role === 'worker') &&
      (event?.assignedMashgiachEmail || '').toLowerCase() === r.email.toLowerCase()) return true;
  return false;
}

/**
 * True when the recipient is the email named by an EVENT payload as the
 * event's assigned mashgiach (current or previous assignee).
 */
function eventAssigneeIs(recipient: any, email: any): boolean {
  return typeof email === 'string' && !!email &&
    (email || '').toLowerCase() === (recipient?.email || '').toLowerCase();
}

function mayFillEventTasks(user: UserProfile | null | undefined, event: any): boolean {
  if (!user) return false;
  if ((user as any).role === 'admin') return true;
  if ((user as any).role === 'coordinator' && callerMaySeeVenue(user, (event as any)?.venueId)) return true;
  return canFillTasks(user) && (
    callerMaySeeVenue(user, (event as any)?.venueId) ||
    ((event as any)?.assignedMashgiachEmail || '').toLowerCase() === (user as any).email.toLowerCase()
  );
}

/** canFillTasks mirrors the role defaults: admin always; coordinator,
 * mashgiach and worker unless explicitly revoked; owner only when granted.
 * Used where the UI lets a role fill/check (task check-ins, event toggles). */
function canFillTasks(user: UserProfile | null | undefined): boolean {
  if (!user) return false;
  const role = (user as any).role;
  const perms = (user as any).permissions;
  if (role === 'admin') return true;
  if (role === 'coordinator' || role === 'mashgiach' || role === 'worker') {
    return perms?.canFillTasks !== false;
  }
  return perms?.canFillTasks === true;
}

/**
 * 5a — ONE rule for who sees an announcement (rule N), used by GET
 * /api/announcements, the WS staff + kiosk filters, POST /api/updates/seen
 * and GET /api/updates/unread. Fail closed.
 * - same agency, not expired;
 * - kiosk session: agency-wide or the TABLET's venue, AND role targeting
 *   for the logged-in user, whatever the role (an admin on a wall tablet
 *   gets the tablet's scope, not the agency);
 * - admin: every announcement of the own agency (they manage/delete them);
 * - everyone else: agency-wide or own venue(s) (venueScopeFor), AND
 *   targetRoles has 'all' or the user's role (or they wrote it).
 */
function announcementVisibleTo(user: UserProfile | null | undefined, ann: any, kioskVenueId?: string): boolean {
  if (!user || !ann || typeof ann !== 'object') return false;
  if ((ann.agencyId || 'agency-hkc') !== ((user as any).agencyId || 'agency-hkc')) return false;
  if (ann.expiresAt && String(ann.expiresAt) <= new Date().toISOString()) return false;
  const roles: string[] = Array.isArray(ann.targetRoles) ? ann.targetRoles : [];
  const roleOk = roles.includes('all') || roles.includes((user as any).role);
  if (kioskVenueId !== undefined) {
    if (!kioskVenueId) return false;
    return roleOk && (!ann.venueId || ann.venueId === kioskVenueId);
  }
  if ((user as any).role === 'admin') return true;
  const venueOk = !ann.venueId || (venueScopeFor(user) as string[]).includes(ann.venueId);
  const own = typeof ann.authorEmail === 'string' && ann.authorEmail === (user as any).email;
  return venueOk && (roleOk || own);
}

/** 5a: readBy is server-only — strip it from every response and broadcast. */
function publicUpdate<T extends { readBy?: string[] }>(item: T): Omit<T, 'readBy'> {
  if (!item || typeof item !== 'object') return item as any;
  const { readBy: _drop, ...rest } = item as any;
  return rest;
}

const KNOWN_ANNOUNCEMENT_ROLES = ['all', 'admin', 'coordinator', 'owner', 'mashgiach', 'worker'];

/**
 * 5a (review round 1): an ANNOUNCEMENT_DELETED event carries only { id, venueId },
 * but it must reach exactly the sockets that were allowed to see the item.
 * The delete handler records the deleted item's visibility metadata here
 * (agency, venue, targetRoles, author — no content) for a short while, and
 * both WS filters decide with announcementVisibleTo(). No entry = drop
 * (fail closed).
 */
const deletedAnnouncementMeta = new Map<string, { agencyId?: string; venueId?: string; targetRoles: string[]; authorEmail?: string }>();
function rememberDeletedAnnouncement(a: any) {
  if (!a?.id) return;
  deletedAnnouncementMeta.set(a.id, {
    agencyId: a.agencyId,
    venueId: a.venueId,
    targetRoles: Array.isArray(a.targetRoles) ? a.targetRoles : ['all'],
    authorEmail: a.authorEmail,
  });
  const t = setTimeout(() => deletedAnnouncementMeta.delete(a.id), 5 * 60 * 1000);
  (t as any).unref?.();
}

/**
 * 5b — ONE rule for who sees an alert (an incident), used by GET
 * /api/incidents, GET /api/incidents/:id/media, the WS staff filter,
 * POST /api/updates/seen, GET /api/updates/unread and the receipts routes.
 * Fail closed.
 * - same agency;
 * - a kiosk session never (the routes are off the kiosk allowlist and
 *   kioskMaySee drops INCIDENT_*): the kiosk sheet stays read-only;
 * - admin: every alert of the own agency;
 * - everyone else, coordinator included: alerts at their own venue(s) (rule T).
 */
function incidentVisibleTo(user: UserProfile | null | undefined, inc: any): boolean {
  if (!user || !inc || typeof inc !== 'object') return false;
  if ((inc.agencyId || 'agency-hkc') !== ((user as any).agencyId || 'agency-hkc')) return false;
  if ((user as any).role === 'admin') return true;
  return typeof inc.venueId === 'string' && callerMaySeeVenue(user, inc.venueId);
}

const sameEmail = (a: any, b: any) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * 5b — who an alert is ROUTED to, and whose read marks its ✓✓ count: the
 * agency's admins plus the coordinators of the alert's venue — never the
 * reporter, never another venue's coordinator, never another agency. One
 * helper for both, so the push list and the receipt list cannot drift.
 * Delivery is immediate and 24/7 (Don, Oct 19): there are no server-side
 * quiet hours; a recipient's own mute makes the push silent, never absent.
 */
function alertRecipients(inc: any): UserProfile[] {
  if (!inc || typeof inc.venueId !== 'string') return [];
  const agencyId = inc.agencyId || 'agency-hkc';
  return users.filter((u) =>
    (u.agencyId || 'agency-hkc') === agencyId &&
    (u.role === 'admin' || (u.role === 'coordinator' && callerMaySeeVenue(u, inc.venueId))) &&
    !sameEmail(u.email, inc.reporterEmail)
  );
}

/**
 * 5b (plan v2, A2) — ONE recipient predicate for alert read marks, the
 * unread badge, ✓✓ counts, reader lists and "Seen by a recipient": a user
 * counts for an alert only if the alert is routed to them. Viewing is
 * broader (rule T) — a venue mashgiach can open the Alerts tab but never
 * adds to a count and gets no alert badge.
 */
function isAlertRecipient(user: UserProfile | null | undefined, inc: any): boolean {
  if (!user || !inc) return false;
  return alertRecipients(inc).some((u) => u.id === user.id);
}

/**
 * 5b — an alert as a viewer may see it. No media bytes (fetched on demand
 * from GET /api/incidents/:id/media, behind the same visibility rule) and no
 * email addresses (reporter / acknowledger / resolver are names only;
 * `mine` tells the viewer which alerts they raised).
 */
function publicIncident(inc: any, viewer?: UserProfile | null) {
  return {
    id: inc.id,
    agencyId: inc.agencyId,
    venueId: inc.venueId,
    title: inc.title,
    description: inc.description,
    severity: inc.severity,
    status: inc.status,
    createdAt: inc.createdAt,
    linkedTaskId: inc.linkedTaskId,
    reporterName: inc.reporterName,
    acknowledgedAt: inc.acknowledgedAt,
    acknowledgedByName: inc.acknowledgedByName,
    resolvedAt: inc.resolvedAt,
    resolvedByName: inc.resolvedByName,
    hasPhoto: typeof inc.photoData === 'string' && inc.photoData.length > 0,
    hasVoice: typeof inc.voiceNoteData === 'string' && inc.voiceNoteData.length > 0,
    mine: !!viewer && sameEmail(inc.reporterEmail, (viewer as any).email),
  };
}

/** 5b — WS INCIDENT_* carry a refetch signal only (REST is the authority). */
function incidentSignal(inc: any) {
  return { incident: { id: inc.id, agencyId: inc.agencyId, venueId: inc.venueId, status: inc.status } };
}

/** Non-admin callers may see only venues inside their own scope. */
function callerMaySeeVenue(user: UserProfile | null | undefined, venueId: string): boolean {
  if (!user || typeof venueId !== 'string' || venueId.length === 0) return false;
  if ((user as any).role === 'admin') return true;
  return venueScopeFor(user).includes(venueId);
}

/**
 * requireOwnVenue PLUS rule-T venue access for non-admins.
 * Kiosk sessions are untouched: a kiosk token stays the tablet's venue.
 * Returns false and 403s when the caller may not act on the venue:
 * "You can only work in your own venue."
 */
function requireVenueAccess(req: any, res: any, venueId: string): boolean {
  if (!requireOwnVenue(req, res, venueId, venues)) return false;
  const caller = getAuthUser(req);
  if (!callerMaySeeVenue(caller, venueId)) {
    res.status(403).json({ error: 'You can only work in your own venue.' });
    return false;
  }
  return true;
}

/**
 * Venue scoping for read endpoints (rule N: one helper so the rule can't drift).
 * RULE T: ADMIN ONLY is agency-wide. A coordinator takes the own-venue branch
 * (a different ?venueId → 403; no own venue → []).
 * Every other role: own venue only. A different ?venueId → 403. No own
 * venue → empty list (never the whole agency).
 * Returns 'agency' for agency-wide, a venue-id array otherwise, or null
 * when the response was already sent (401/403).
 */
function scopedVenueIds(req: any, res: any): string[] | 'agency' | null {
  const caller = getAuthUser(req);
  if (!caller) {
    res.status(401).json({ error: 'Sign in required. Please log in again.' });
    return null;
  }
  // Kiosk session: always venue-scoped to the token's venue, never agency-wide,
  // regardless of the user's role. A coordinator on a wall tablet gets the
  // tablet's scope, not coordinator powers.
  if ((req as any).kiosk === true) {
    const kioskVenueId: string | undefined = (req as any).kioskVenueId;
    if (!kioskVenueId) return []; // fail closed: no venue → empty
    const queryVenueId = String(req.query.venueId || '');
    if (queryVenueId && queryVenueId !== kioskVenueId) {
      res.status(403).json({
        error: 'This kiosk session can only clock in and out.',
        code: 'KIOSK_SCOPE',
      });
      return null;
    }
    return [kioskVenueId];
  }
  const queryVenueId = String(req.query.venueId || '');

  // RULE T: agency-wide belongs to the admin alone. Every other role —
  // coordinator included — takes the own-venue branch below.
  if (caller.role === 'admin') {
    if (queryVenueId) {
      if (!requireOwnVenue(req, res, queryVenueId, venues)) return null;
      return [queryVenueId];
    }
    return 'agency';
  }

  const scope = venueScopeFor(caller);
  if (scope.length === 0) return []; // no venue assigned → empty, never agency-wide
  if (queryVenueId && !scope.includes(queryVenueId)) {
    res.status(403).json({ error: 'You can only view your own venue.' });
    return null;
  }
  return queryVenueId ? [queryVenueId] : scope;
}

/**
 * Require the caller to be an agency admin. Sends 403 and returns null when
 * the check fails; otherwise returns the verified admin user.
 */
function requireAdmin(req: any, res: any): UserProfile | null {
  const user = getAuthUser(req);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Only administrators can perform this action.' });
    return null;
  }
  return user;
}

/**
 * 8i: require the pinned platform operator (src/server/platform-auth.ts) for
 * routes that act on the WHOLE platform. Decided on the current stored user
 * record; kiosk sessions never qualify. Sends 403 and returns null otherwise.
 */
function requirePlatformOperator(req: any, res: any): UserProfile | null {
  const sessionUser = getAuthUser(req);
  if (!isPlatformOperator(sessionUser?.id, (req as any).kiosk === true, users as any)) {
    res.status(403).json({ error: PLATFORM_OPERATOR_FORBIDDEN });
    return null;
  }
  return users.find((u) => u.id === sessionUser!.id) || null;
}

/** 8i: re-check right before a long platform operation executes (after awaits). */
function stillPlatformOperator(req: any): boolean {
  return isPlatformOperator(getAuthUser(req)?.id, (req as any).kiosk === true, users as any);
}

/**
 * Require the target entity to belong to the caller's agency. Sends 403 and
 * returns false on a cross-agency attempt; returns true otherwise. Entities
 * without an agencyId are treated as belonging to the default agency.
 */
function requireSameAgency(req: any, res: any, entity: any, entityLabel = 'item'): boolean {
  const agency = callerAgencyId(req);
  const entityAgency = (entity && entity.agencyId) || 'agency-hkc';
  if (entityAgency !== agency) {
    res.status(403).json({ error: `You can only modify ${entityLabel} in your own agency.` });
    return false;
  }
  return true;
}

/**
 * Require a venue to belong to the caller's agency — but only when the venue
 * exists. Dangling venue references are tolerated (legacy data and tests use
 * venue IDs that may not resolve); a venue that DOES exist must belong to the
 * caller's agency. Returns false (after sending 403) on a cross-agency venue.
 */
function requireOwnVenue(req: any, res: any, venueId: string | undefined, venueList: any[]): boolean {
  if (!venueId) return true;
  const venue = venueList.find((v) => v && v.id === venueId);
  if (!venue) return true; // dangling reference — nothing cross-agency to protect
  return requireSameAgency(req, res, venue, 'venues');
}

// In-memory + file-backed storage
interface Agency {
  id: string;
  name: string;
  shortCode: string;
  adminEmail: string;
  certificationSeal: string;
  region: string;
  contactPhone?: string;
  createdAt: string;
  /** Custom hostname for this agency's portal (e.g. app.hartfordkashrut.org). */
  customDomain?: string;
  /** Item 6: IANA zone for the agency's venues (absent = America/New_York). */
  timeZone?: string;
  /** Item 8a (data only, for #12): unique short address, branding. */
  slug?: string;
  brandName?: string;
  logoUrl?: string;
  /** Item 8a: SERVER-ONLY domain verification state (never accepted from a
   * request body; domainVerificationToken never leaves the server). */
  domainStatus?: 'none' | 'pending' | 'verified' | 'failed';
  domainVerificationToken?: string;
  domainVerifiedAt?: string;
  domainLastCheckedAt?: string;
}

interface Venue {
  id: string;
  agencyId: string;
  name: string;
  category: string;
  address: string;
  certification: string;
  ownerEmail?: string;
  createdAt: string;
  /** Item 6: IANA zone for this venue's work day (absent = the agency's zone). */
  timeZone?: string;
}

interface TaskItem {
  id: string;
  agencyId?: string;
  venueId: string;
  title: string;
  description: string;
  category: string;
  categories?: string[]; // All assigned categories; categories[0] is the primary
  inputType: 'toggle' | 'yes_no' | 'status_select' | 'checkbox' | 'check_in';
  customStatusOptions?: string[];
  completedStatusValues?: string[];
  assignedTo: string[]; // ['all'] or array of worker emails
  scheduleType?: 'recurring' | 'specific_dates';
  daysOfWeek: number[]; // 0-6
  specificDates?: string[]; // 'YYYY-MM-DD'
  targetTime?: string;
  targetTimeMinutes?: number; // minutes since midnight, set by the structured time picker
  targetTime2?: string; // optional second daily time (e.g. morning + afternoon)
  targetTime2Minutes?: number;
  priority?: 'low' | 'medium' | 'high';
  enableOverdueAlert?: boolean; // if true, send push notification when overdue
  currentStatus: string;
  isCompleted: boolean;
  notes: string;
  updatedByEmail: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  createdAt: string;
  checkIns?: TaskCheckInItem[];
  sortOrder?: number;
  isPrivate?: boolean;
}

interface TaskCheckInItem {
  id: string;
  byName: string | null;
  byEmail: string | null;
  at: string; // ISO timestamp
  photoData?: string; // base64 data URL (optional photo evidence)
  photoCaption?: string;
}

/** Minutes after midnight for a target time like "09:00 AM" / "14:30"; Infinity when none. */
function targetTimeMinutes(t: string | undefined | null): number {
  if (!t) return Infinity;
  const s = t.trim();
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/);
  if (m12) {
    let h = parseInt(m12[1], 10) % 12;
    if (/^[Pp]/.test(m12[3])) h += 12;
    return h * 60 + parseInt(m12[2], 10);
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
  return Infinity;
}

interface HistoryLog {
  id: string;
  agencyId?: string;
  venueId: string;
  date: string;
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  entries: Array<{
    id: string;
    taskId: string;
    taskTitle: string;
    category: string;
    status: string;
    isCompleted: boolean;
    notes: string;
    completedByEmail: string | null;
    completedByName: string | null;
    completedAt: string | null;
  }>;
  resetAt: string;
  resetBy: string;
  /**
   * Item 6: set only when a scheduled rollover closed a workday more than one
   * day after it began (e.g. the server was down): the number of calendar
   * days between the closed workday and the new one. One snapshot covers the
   * whole gap; no empty days are synthesized.
   */
  catchUpDays?: number;
}

interface HandoffNote {
  id: string;
  agencyId?: string;
  venueId: string;
  authorEmail: string;
  authorName: string;
  content: string;
  shift: string; // e.g. "Morning", "Afternoon", "Evening"
  voiceNoteData?: string; // base64 audio
  createdAt: string;
  /** 5a: user ids that have SEEN this note (server-only; stripped from every response/broadcast). */
  readBy?: string[];
}

interface TaskTemplate {
  id: string;
  agencyId: string;
  name: string;
  description?: string;
  tasks: Array<{
    title: string;
    description?: string;
    category?: string;
    targetTime?: string;
    priority?: 'low' | 'medium' | 'high';
    enableOverdueAlert?: boolean;
  }>;
  createdByEmail: string;
  createdAt: string;
}

interface Incident {
  id: string;
  agencyId: string;
  venueId: string;
  reporterEmail: string;
  reporterName: string;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  photoData?: string;
  voiceNoteData?: string; // base64 audio
  status: 'open' | 'acknowledged' | 'resolved';
  linkedTaskId?: string;
  createdAt: string;
  // 5b: who moved it along, recorded from the VERIFIED session user.
  acknowledgedAt?: string;
  acknowledgedBy?: string; // email — server-only, never in a payload
  acknowledgedByName?: string;
  resolvedAt?: string;
  resolvedBy?: string; // email — server-only, never in a payload
  resolvedByName?: string;
}

interface Announcement {
  id: string;
  agencyId: string;
  authorEmail: string;
  authorName: string;
  title: string;
  body: string;
  category: 'assignment' | 'update' | 'notice' | 'urgent';
  targetRoles: string[]; // ['admin','coordinator','owner','mashgiach','worker'] or ['all']
  venueId?: string; // optional: scoped to a specific venue
  createdAt: string;
  expiresAt?: string;
  /** 5a: user ids that have SEEN this item (server-only; stripped from every response/broadcast). */
  readBy?: string[];
}

interface PasswordResetRequest {
  email: string;
  /** Legacy plaintext code (pre-hardening). New writes use codeHash only. */
  code?: string;
  /** SHA-256 hex of `reset-code:<pepper>:<code>`. */
  codeHash?: string;
  expiresAt: string;
  verified: boolean;
  resetToken?: string;
  /** Failed verification attempts (5 → request invalidated). */
  attempts?: number;
  lastAttemptAt?: string;
}

/** Sliding-window rate-limit timestamps, persisted in Firestore so limits
 *  survive restarts and work across instances. */
interface PasswordResetRateLimits {
  /** email -> ISO timestamps of forgot-password requests (last hour window) */
  emailRequests: Record<string, string[]>;
  /** ip -> ISO timestamps of forgot-password requests */
  ipRequests: Record<string, string[]>;
  /** ip -> ISO timestamps of verify attempts */
  ipVerifies: Record<string, string[]>;
}

export interface UserPermissions {
  canFillTasks?: boolean;
  canAssignTasks?: boolean;
}

export interface EventTaskItem {
  id: string;
  title: string;
  description?: string;
  category?: string;
  isCompleted: boolean;
  completedAt?: string | null;
  completedByName?: string | null;
  completedByEmail?: string | null;
  notes?: string;
}

export interface ExternalMashgiachInfo {
  name: string;
  phone: string;
  email: string;
}

export interface KosherEventItem {
  id: string;
  agencyId: string;
  venueId: string;
  venueName?: string;
  title: string;
  location: string;
  date: string; // YYYY-MM-DD
  endDate?: string;
  startTime?: string;
  endTime?: string;
  mashgiachType: 'assigned_user' | 'external' | 'unassigned';
  assignedMashgiachEmail?: string;
  assignedMashgiachName?: string;
  externalMashgiach?: ExternalMashgiachInfo;
  menuAttachmentName?: string;
  menuAttachmentData?: string;
  notes?: string;
  status: 'pending_review' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  tasks: EventTaskItem[];
  createdByEmail: string;
  createdByName: string;
  createdAt: string;
  updatedAt?: string;
}

export interface AirtableConfigItem {
  id?: string;
  agencyId: string;
  venueId?: string; // Venue/factory specific or agency-wide
  apiKey?: string; // Airtable Personal Access Token (pat...)
  baseId: string; // app...
  tableName: string; // e.g. "Approved Ingredients"
  viewName?: string; // e.g. "Grid view"
  fieldNameMapping?: {
    ingredientName?: string;
    brandOrSupplier?: string;
    kashrutAgency?: string;
    kosherStatus?: string;
    lotNumber?: string;
    approvalDate?: string;
    approvedBy?: string;
    factoryFacility?: string;
    notes?: string;
    status?: string;
  };
  lastSyncedAt?: string;
  autoSyncEnabled?: boolean;
}

export interface ApprovedIngredientItem {
  id: string;
  airtableRecordId?: string;
  venueId: string;
  agencyId: string;
  name: string;
  brandOrSupplier?: string;
  kashrutAgency?: string;
  kosherStatus: 'Parve' | 'Dairy' | 'Meat' | 'Cholov Yisroel' | 'Pas Yisroel' | 'Glatt' | 'Other';
  lotOrBatch?: string;
  approvalStatus: 'approved' | 'pending_approval' | 'discontinued' | 'flagged';
  approvalDate?: string;
  approvedBy?: string;
  notes?: string;
  verificationStatus?: 'verified_present' | 'verified_not_found' | 'unverified' | 'flagged_discrepancy';
  verifiedAt?: string | null;
  verifiedByName?: string | null;
  verifiedByEmail?: string | null;
  verificationNotes?: string;
}

export interface UnapprovedDiscrepancyItem {
  id: string;
  name: string;
  brandOrSupplier?: string;
  kashrutSymbolFound?: string;
  lotOrBatch?: string;
  locationInFactory?: string;
  severity: 'critical' | 'warning' | 'inquiry';
  notes: string;
  actionTaken?: string;
  photoUrl?: string;
  reportedAt: string;
  reportedByName: string;
  reportedByEmail: string;
}

export interface FactoryAuditReportItem {
  id: string;
  agencyId: string;
  venueId: string;
  venueName?: string;
  auditDate: string; // YYYY-MM-DD
  startTime?: string;
  endTime?: string;
  mashgiachName: string;
  mashgiachEmail: string;
  factoryRepresentative?: string;
  totalApprovedChecked: number;
  totalPresent: number;
  totalDiscrepancies: number;
  auditedIngredients: Array<{
    ingredientId: string;
    name: string;
    brandOrSupplier?: string;
    status: 'verified_present' | 'verified_not_found' | 'flagged_discrepancy';
    notes?: string;
  }>;
  discrepancies: UnapprovedDiscrepancyItem[];
  summaryNotes: string;
  status: 'passed' | 'passed_with_notes' | 'critical_violation_found' | 'in_progress';
  mashgiachSigned: boolean;
  signatureTimestamp?: string;
  createdAt: string;
}

interface UserProfile {
  id: string;
  agencyId?: string;
  email: string;
  name: string;
  role: 'admin' | 'coordinator' | 'mashgiach' | 'owner' | 'worker';
  avatarColor: string;
  password?: string;
  kioskPin?: string; // 4-6 digit PIN for shared kiosk tablets (never sent to clients)
  kioskPinHash?: string; // bcrypt hash of the kiosk PIN (cost 10); kioskPin is legacy plain
  kioskPinSetAt?: string; // ISO timestamp of the last PIN write (informational; stripped from safe users)
  kioskPinRev?: number; // PIN revision counter (2b): kiosk tokens carry String(kioskPinRev) as pv; any PIN set/clear/legacy-upgrade increments it, revoking old tokens
  venueId?: string; // Mashgichim, Coordinators and Owners belong to a specific venue; Admins have access to all in their agency
  permissions?: UserPermissions;
  // K1: optional mobile number (E.164) so an admin/coordinator can send a
  // kiosk code from their own phone. Personal data: stripped from every
  // safe user; only managerViewOf() adds it back for a recipient who manages
  // this user (rule T). NOT named `phone` — /api/admin/dashboard reads
  // (u as any).phone into a wide list.
  phoneNumber?: string;
  // Item 8b — server-only identity fields (src/server/identity.ts). Set only
  // by commitState's enforcement point; never accepted from a request body;
  // stripped by getSafeUser.
  personId?: string;
  venueAccess?: string[];
  isPrimaryAdmin?: boolean;
  tokenEpoch?: number;
}

// Test hook: DATA_DIR_OVERRIDE lets the Stage 2 test suite run the server
// against an isolated data directory (never touches the real ./data).
const DATA_DIR = process.env.DATA_DIR_OVERRIDE
  ? path.resolve(process.env.DATA_DIR_OVERRIDE)
  : path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_AGENCIES: Agency[] = [
  {
    id: 'agency-hkc',
    name: 'Hartford Kashrut Commission (HKC)',
    shortCode: 'HKC',
    adminEmail: 'kenan@hartfordkashrut.org',
    certificationSeal: 'Hartford Kashrut Commission (HKC) - Glatt Meat & Mehadrin',
    region: 'Hartford, CT & New England',
    contactPhone: '(860) 236-1241',
    createdAt: new Date(Date.now() - 90 * 86400000).toISOString(),
  },
];

const DEFAULT_VENUES: Venue[] = [];

const DEFAULT_USERS: UserProfile[] = [
  { id: 'usr_admin', agencyId: 'agency-hkc', email: 'kenan@hartfordkashrut.org', name: 'Kenan (Admin)', role: 'admin', avatarColor: '#3b82f6', password: '' },
];

function generateTemplateTasks(venueId: string, templateType: string = 'restaurant', agencyId: string = 'agency-hkc'): TaskItem[] {
  const now = new Date().toISOString();
  if (templateType === 'bakery') {
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Morning Pas Yisroel Heating Element Inspection',
        description: 'Verify Mashgiach or Jewish owner energized the primary baking ovens and pilot ignition switches.',
        category: 'Pas Yisroel',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '06:00 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Flour Sifting Log (Kashrut Insect Infestation Control)',
        description: 'Sift 50lb flour bags through 70-mesh electric sifter screen. Inspect mesh under lightbox before production.',
        category: 'Ingredient Inspection',
        inputType: 'status_select',
        customStatusOptions: ['Pending', 'Inspected & Clear', 'Flagged / Debris Found', 'Completed'],
        completedStatusValues: ['Inspected & Clear', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '07:30 AM',
        priority: 'high',
        currentStatus: 'Pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'Dairy / Parve Equipment & Baking Sheet Separation',
        description: 'Ensure blue-coded trays remain dedicated strictly to Parve breads; red trays for Cholov Yisroel pastries.',
        category: 'Kashrut Segregation',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '09:00 AM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Proofer & Walk-in Retarder Temperature Verification',
        description: 'Verify dough proofer humidity (80-85%) and temperature (95°F - 100°F). Retarder at 36°F.',
        category: 'Food Safety',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '11:00 AM',
        priority: 'medium',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-5`,
        venueId,
        title: 'Affix Kosher Certification Stickers to Packaged Goods',
        description: 'Seal all retail pastry boxes and bread bags with tamper-evident Hartford Kashrut certification hologram labels.',
        category: 'Packaging & Seals',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '15:00 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  } else if (templateType === 'catering') {
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Inspect Kosher Mashgiach Tamper Tape & Box Seals',
        description: 'Confirm all insulated transport carriers and Cambro boxes retain intact stamped red seal tape before transit.',
        category: 'Kashrut Security',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '08:00 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Hot Holding Transport Box Temperature Log (Min 140°F)',
        description: 'Probe internal core temperatures of transport cambros prior to leaving commissary kitchen.',
        category: 'Food Safety',
        inputType: 'status_select',
        customStatusOptions: ['Pending', 'Logged > 140°F Compliant', 'Reheated Required', 'Completed'],
        completedStatusValues: ['Logged > 140°F Compliant', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '11:30 AM',
        priority: 'high',
        currentStatus: 'Pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'Segregate Meat vs Dairy Event Flatware & Serving Pieces',
        description: 'Double check color bands on chaffing dishes and serving tongs at venue staging area.',
        category: 'Kashrut Segregation',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '13:00 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Post-Event Sealed Kosher Food Return Manifest',
        description: 'Reseal unopened kosher pans with signature tape and record return inventory count.',
        category: 'Logistics',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '22:00 PM',
        priority: 'medium',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  } else if (templateType === 'industrial') {
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Factory Raw Material Intake & Kosher Certificate Audit',
        description: 'Verify incoming bulk totes, drums, and dry sacks against the agency-approved Airtable ingredient matrix. Inspect kosher letters of certification (LoC) validity.',
        category: 'Ingredient Verification',
        inputType: 'status_select',
        customStatusOptions: ['Pending Verification', 'All Raw Materials Approved', 'Unapproved Item Quarantined', 'Completed'],
        completedStatusValues: ['All Raw Materials Approved', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '08:30 AM',
        priority: 'high',
        currentStatus: 'Pending Verification',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Factory Floor Physical Walkthrough & Unapproved Ingredient Audit',
        description: 'Check active production lines, staging racks, flavoring shelves, and blending kettles. Ensure no unauthorized sub-ingredients or undocumented processing aids are present on-site.',
        category: 'Factory Floor Audit',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '10:30 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'CIP (Clean-In-Place) & Kosher Steam Line Temperature Check',
        description: 'Confirm clean-in-place chemical wash cycle and boiling water / live steam purge reached 212°F on continuous pasteurizer before kosher batch start.',
        category: 'Equipment Kosherization',
        inputType: 'status_select',
        customStatusOptions: ['Pending Clean', 'CIP Complete (>212°F Verified)', 'Sanitization Failed', 'Completed'],
        completedStatusValues: ['CIP Complete (>212°F Verified)', 'Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '13:00 PM',
        priority: 'high',
        currentStatus: 'Pending Clean',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Submit Factory Mashgiach Ingredient Inspection Report',
        description: 'Complete the factory inspection report summarizing approved ingredients verified, unauthorized discrepancies flagged, and signed off with QA.',
        category: 'Audit & Compliance',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '16:00 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  } else if (templateType === 'blank') {
    return [];
  } else {
    // Standard Restaurant / Deli template
    return [
      {
        id: `task-${venueId}-1`,
        venueId,
        title: 'Check Morning Deliveries & Kosher Supplier Invoices',
        description: 'Inspect pallets at loading dock, match bills of lading with kosher certified vendor list, and verify hashgacha seals.',
        category: 'Logistics',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5],
        targetTime: '09:00 AM',
        priority: 'high',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-2`,
        venueId,
        title: 'Refrigeration & Freezer Temperature Logs',
        description: 'Log digital readings for Walk-in Coolers 1-3 (must be between 34°F - 38°F) and Freezer units (-5°F - 0°F).',
        category: 'Food Safety',
        inputType: 'status_select',
        customStatusOptions: ['Pending', 'In Progress', 'Blocked', 'Completed'],
        completedStatusValues: ['Completed'],
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '10:30 AM',
        priority: 'high',
        currentStatus: 'Pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-3`,
        venueId,
        title: 'Sanitize Workstations & Meat/Dairy Separation Lines',
        description: 'Clean stainless steel preparation tables with approved sanitizing agent, replenish towels, and inspect kosher wash sinks.',
        category: 'Sanitation',
        inputType: 'checkbox',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '13:00 PM',
        priority: 'medium',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-4`,
        venueId,
        title: 'Audit Raw Ingredient Expiration Dates & Kosher Symbols',
        description: 'Cross-check labels on dairy/meat shelves, remove expired stock, and ensure all packaging has approved kosher hechsher.',
        category: 'Quality Assurance',
        inputType: 'yes_no',
        assignedTo: ['all'],
        daysOfWeek: [1, 3, 5],
        targetTime: '14:30 PM',
        priority: 'medium',
        currentStatus: 'no',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
      {
        id: `task-${venueId}-5`,
        venueId,
        title: 'End of Shift Equipment Lockout & Gas Valve Shutoff',
        description: 'Ensure heat sealers, fryers, and cooktops are disengaged, gas valves shut, and locks secured.',
        category: 'Operations',
        inputType: 'toggle',
        assignedTo: ['all'],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: '17:30 PM',
        priority: 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        createdAt: now,
      },
    ];
  }
}

interface EventTaskTemplate {
  id: string;
  title: string;
  agencyId?: string;
  sortOrder: number;
}

/**
 * 9a: the signed-in person's OWN payload: getSafeUser() + myVenueIds (their
 * current venue scope; admins get none — they are agency-wide). Used only
 * where the response goes to that same person (login, reset); never on a
 * roster or a broadcast user record.
 */
function getSelfUser(user: UserProfile) {
  const full = users.find((u) => u.id === user.id) || user;
  const scope = venueScopeFor(full);
  return { ...getSafeUser(user), ...(scope === 'agency' ? {} : { myVenueIds: scope }) };
}

function getSafeUser(user: UserProfile) {
  const { password, kioskPin, kioskPinHash, kioskPinSetAt, phoneNumber, ...withIdentity } = user;
  // Item 8b: server-only identity fields never leave the server.
  const safe = stripServerOnlyUserFields(withIdentity as any) as typeof withIdentity;
  const userAgency = agencies.find((a) => a.id === user.agencyId) || agencies[0];
  return {
    ...safe,
    agencyName: userAgency?.name || 'Kosher Supervision Agency',
    agencySeal: userAgency?.certificationSeal || 'Certified Kosher',
    agencyShortCode: userAgency?.shortCode || 'HKC',
    // Item 6: the agency's IANA zone (absent = America/New_York) so the
    // client resolves venue zone -> agency zone -> default for "today".
    agencyTimeZone: isValidTimeZone(userAgency?.timeZone) ? userAgency?.timeZone : undefined,
  };
}

/**
 * K1 — does `recipient` manage `target` (rule T, fail closed)? Admin: every
 * user of the own agency. Coordinator: mashgiach/worker users at a venue in
 * the coordinator's own scope (never admins, never coordinators). Everyone
 * else, any kiosk session (acting user is never admin/coordinator-for-this)
 * and any missing value: no.
 */
function recipientManages(recipient: any, target: any): boolean {
  if (!recipient || !target || typeof recipient.role !== 'string') return false;
  if ((recipient.agencyId || 'agency-hkc') !== (target.agencyId || 'agency-hkc')) return false;
  if (recipient.role === 'admin') return true;
  if (recipient.role === 'coordinator') {
    if (target.role !== 'mashgiach' && target.role !== 'worker') return false;
    const scope = venueScopeFor(recipient);
    return Array.isArray(scope) && personInScope(target, scope); // 9a: a shared venue, not matching home venues
  }
  return false;
}

/**
 * K1 — the safe user as a MANAGER sees it: getSafeUser() plus hasKioskPin
 * (a boolean — never the hash or digits) and the optional phoneNumber, only
 * when the recipient manages the target. Otherwise exactly getSafeUser().
 * Rule N: the one place these two fields are added to any payload.
 * 9a2: also the one place `venueIds` is added (same-agency admins only).
 */
function managerViewOf(user: UserProfile, recipient: any) {
  const safe: any = getSafeUser(user);
  if (!recipientManages(recipient, user)) return safe;
  safe.hasKioskPin = !!(user.kioskPinHash || user.kioskPin);
  if (typeof user.phoneNumber === 'string' && user.phoneNumber) safe.phoneNumber = user.phoneNumber;
  // 9a2: a same-agency ADMIN also sees the target's venue scope (`venueIds`):
  // the sanitized 9a scope of the CURRENT stored record (home if valid +
  // venueAccess ∩ the agency's current venues), never raw venueAccess. Admin
  // targets are agency-wide, so the field is omitted for them. Nobody else
  // (coordinator, mashgiach, worker, owner, another agency's admin) gets it.
  if (recipient.role === 'admin' && (recipient.agencyId || 'agency-hkc') === (user.agencyId || 'agency-hkc')) {
    const stored = users.find((u) => u.id === user.id) || user;
    const scope = venueScopeFor(stored);
    if (Array.isArray(scope)) safe.venueIds = [...scope];
  }
  return safe;
}

/**
 * K1 — normalize an optional phone number to E.164. Returns
 * { ok: true, value: undefined } for "" (clear), { ok: true, value } for a
 * valid number, { ok: false } otherwise. US default for 10-digit numbers.
 */
function normalizePhoneNumber(raw: unknown): { ok: boolean; value?: string } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false };
  let p = String(raw).trim();
  if (p === '') return { ok: true, value: undefined };
  if (p.length > 32) return { ok: false };
  p = p.replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^\d{10}$/.test(p)) p = '+1' + p;
  else if (/^1\d{10}$/.test(p)) p = '+' + p;
  if (!/^\+[1-9]\d{6,14}$/.test(p)) return { ok: false };
  return { ok: true, value: p };
}
const PHONE_NUMBER_ERROR = "That phone number doesn't look right. Use digits, with + and the country code outside the US.";

/**
 * K1 — an admin on a kiosk IS a mashgiach (Don, Oct 20 7:29 PM). The acting
 * identity for every kiosk request/socket: an admin becomes a mashgiach at
 * the TABLET's venue with mashgiach permissions; every other role is
 * returned unchanged. Applied at the identity boundary (HTTP middleware,
 * WS handshake, recipientForMeta, kiosk login response) so no handler ever
 * sees admin powers on a kiosk token. Full admin powers need a phone
 * session (email + password).
 */
function kioskActingUser<T extends UserProfile>(user: T, tabletVenueId: string): T {
  if (!user) return user;
  if ((user as any).role !== 'admin') {
    // 9a: a kiosk session is the TABLET's venue only. A multi-venue person
    // (or one whose home is elsewhere) acts at this tablet with exactly
    // [tablet venue] as their scope — never their other venues' data.
    const extra = Array.isArray((user as any).venueAccess) && (user as any).venueAccess.some((v: any) => v !== tabletVenueId);
    if ((user as any).venueId === tabletVenueId && !extra) return user;
    return { ...user, venueId: tabletVenueId, ...((user as any).personId ? { venueAccess: [tabletVenueId] } : {}) } as T;
  }
  return {
    ...user,
    role: 'mashgiach',
    venueId: tabletVenueId,
    permissions: { canFillTasks: true, canAssignTasks: false },
  } as T;
}

/**
 * K1 — may this user hold a kiosk session at a tablet of (agencyId,
 * venueId)? Same agency always required. Admin (rule T: whole agency): any
 * tablet of the own agency — the session is still scoped to THAT tablet's
 * venue. Everyone else: only their own assigned venue (unchanged rule).
 * Re-read on every request, so a demoted admin at another venue fails.
 */
function kioskUserFitsVenue(user: any, agencyId: string | undefined, venueId: string | undefined): boolean {
  if (!user || !agencyId || !venueId) return false;
  if ((user.agencyId || 'agency-hkc') !== agencyId) return false;
  if (user.role === 'admin') {
    // The tablet's venue must still exist in the admin's own agency (an
    // admin has no venueId of their own; never fall back to agency scope).
    return venues.some((v: any) => v && v.id === venueId && (v.agencyId || 'agency-hkc') === agencyId);
  }
  return personAtVenue(user, venueId);
}

/**
 * K1 — ONE kiosk session re-validation (rule N), used by the HTTP
 * middleware, the WS handshake, authorizeSocket (every delivery) and
 * recipientForMeta: the user still has a PIN hash at the token's PIN
 * revision, the bound device still exists at the token's agency + venue,
 * and the user still fits that venue (kioskUserFitsVenue, which re-reads the
 * role). The HTTP path additionally checks the request's device proof.
 */
function kioskSessionStillValid(
  user: any,
  sess: { agencyId?: string; venueId?: string; pv?: string; deviceId?: string }
): boolean {
  if (!user || !sess || !sess.agencyId || !sess.venueId || !sess.pv || !sess.deviceId) return false;
  const device = liveKioskDevice(sess.deviceId);
  return (
    !!user.kioskPinHash &&
    !!device &&
    device.agencyId === sess.agencyId &&
    device.venueId === sess.venueId &&
    pinRevOf(user) !== undefined &&
    String(pinRevOf(user)) === sess.pv &&
    kioskUserFitsVenue(user, sess.agencyId, sess.venueId)
  );
}

/**
 * K1 — may a kiosk session act on this task? Same venue as the tablet AND
 * visible to the acting user (canSeeTaskServer: a private task assigned to
 * someone else is neither visible nor writable from a tablet). Phone
 * sessions: always true here (their own rules apply).
 */
function kioskMayTouchTask(req: any, task: any): boolean {
  if ((req as any).kiosk !== true) return true;
  const kioskVenueId = (req as any).kioskVenueId;
  if (!kioskVenueId || !task || task.venueId !== kioskVenueId) return false;
  return canSeeTaskServer(task, getAuthUser(req));
}

/** Whether a roster recipient may see contact emails. Mirrors the client's
 * canUserAssignTasks (src/lib/permissions.ts): assignments are keyed by email,
 * so anyone who can assign tasks keeps emails; everyone else gets names/roles
 * only. Fail closed: unknown recipient → no emails. */
function recipientSeesRosterEmails(recipient?: { role?: string; permissions?: { canAssignTasks?: boolean } }): boolean {
  if (!recipient) return false;
  if (recipient.role === 'admin') return true;
  if (recipient.role === 'coordinator') return recipient.permissions?.canAssignTasks !== false;
  return recipient.permissions?.canAssignTasks === true;
}

/**
 * Item 8s: resolve an event's assigned mashgiach ONLY inside the caller's own
 * agency and rule-T roster (admin → whole agency; everyone else → own venue
 * + the agency's admins), intersected with E1's assignable roles. Owners are
 * never assignable. `usersList` is explicit: the cached roster for the fast
 * pre-check, and freshDoc.users (with the caller re-read from it) inside the
 * transaction. Returns the in-agency user or null — the caller answers the
 * same generic 400 for "elsewhere" and "nobody" (no existence oracle).
 */
const EVENT_ASSIGNABLE_ROLES = new Set(['admin', 'coordinator', 'mashgiach', 'worker']);
const EVENT_ASSIGNEE_REFUSAL = 'Choose someone from your team.';
function resolveAssignableUser(callerUser: any, email: unknown, usersList: any[]): any | null {
  if (!callerUser || typeof email !== 'string' || !email.trim()) return null;
  const want = email.trim().toLowerCase();
  const caller = normalizeStoredUser(callerUser);
  const agencyId = caller.agencyId || 'agency-hkc';
  const scope = venueScopeFor(caller as any);
  if (scope !== 'agency' && (scope as string[]).length === 0) return null;
  for (const raw of usersList || []) {
    if (!raw || typeof raw.email !== 'string' || raw.email.trim().toLowerCase() !== want) continue;
    const u = normalizeStoredUser(raw);
    if ((u.agencyId || 'agency-hkc') !== agencyId) continue;
    if (!EVENT_ASSIGNABLE_ROLES.has(raw.role) && !EVENT_ASSIGNABLE_ROLES.has(u.role)) continue;
    if (raw.role === 'owner' || u.role === 'owner') continue;
    if (scope !== 'agency' && !(u.role === 'admin' || personInScope(raw, scope as string[]))) continue;
    return u;
  }
  return null;
}

function getSafeUsersForAgency(
  agencyId: string,
  recipient?: { role?: string; permissions?: { canAssignTasks?: boolean }; venueId?: string }
) {
  // Privacy + RULE T: a roster payload is ALWAYS scoped to one agency and
  // trimmed by recipient. Admins see the whole agency roster; everyone else
  // sees only users at their own venue(s) PLUS the agency's admins.
  // - Every recipient sees only users of their own agency (never the platform roster).
  // - Contact emails are visible only to recipients who can assign tasks
  //   (admin, coordinator unless explicitly revoked, or granted canAssignTasks),
  //   and only for the users they actually get.
  // - A venue-less non-admin gets []. Other roles get names/roles/venues/avatar
  //   colors for display.
  const norm = (v?: string) => v || 'agency-hkc';
  const showEmails = recipientSeesRosterEmails(recipient);
  const isAdmin = recipient?.role === 'admin';
  const scope = isAdmin ? 'agency' : venueScopeFor(recipient as any);
  // A venue-less non-admin gets nothing at all — not even the admin list.
  if (scope !== 'agency' && (scope as string[]).length === 0) return [];
  return users
    .filter((u) => norm(u.agencyId) === agencyId)
    .filter((u) => {
      if (isAdmin || scope === 'agency') return true;
      return u.role === 'admin' || personInScope(u, scope);
    })
    .map((u) => {
      const safe = managerViewOf(u, recipient);
      if (showEmails) return safe;
      const { email, ...rest } = safe;
      return rest;
    });
}

/** Resolve a broadcast recipient's CURRENT user record for permission lookups.
 * Resolves by the socket's authenticated user ID (never by email alone — the
 * same email can exist in several agencies) and verifies the user still
 * exists AND belongs to the socket's authenticated agency. A permission
 * lookup must never cross an agency boundary. Returns undefined when the
 * recipient is gone or moved (fail closed). */
function recipientForMeta(meta: { userId: string; agencyId: string; kiosk?: boolean; kioskVenueId?: string; kioskAgencyId?: string; kioskPv?: string; kioskDeviceId?: string }) {
  const u = users.find((x) => x.id === meta.userId);
  if (!u) return undefined;
  const norm = (v?: string) => v || 'agency-hkc';
  if (norm(u.agencyId) !== meta.agencyId) return undefined;
  // K1: a kiosk socket's recipient is the ACTING user (an admin on a kiosk
  // is a mashgiach at the tablet's venue). No tablet venue → fail closed.
  if (meta.kiosk === true) {
    if (!meta.kioskVenueId) return undefined;
    if (!kioskSessionStillValid(u, { agencyId: (meta as any).kioskAgencyId, venueId: meta.kioskVenueId, pv: (meta as any).kioskPv, deviceId: (meta as any).kioskDeviceId })) return undefined;
    return kioskActingUser(u, meta.kioskVenueId);
  }
  return u;
}

/**
 * Server-side mirror of client canSeeTask (src/lib/permissions.ts).
 * RULE T: the admin of the task's agency sees every task. Everyone else —
 * coordinator included — must first be INSIDE the task's venue (venueScopeFor);
 * then the private rule applies: a coordinator sees private tasks at their own
 * venue; mashgiach/owner/worker see non-private tasks or tasks assigned to
 * them (by email, case-insensitive). Unknown/deleted recipient → fail closed.
 * (Agency match is the caller's job: tasksForRecipient filters by agency.)
 */
function canSeeTaskServer(
  task: { isPrivate?: boolean; assignedTo?: string[]; venueId?: string },
  recipient: UserProfile | undefined
): boolean {
  if (!recipient) return false;
  if (recipient.role === 'admin') return true;
  if (!callerMaySeeVenue(recipient, (task as any).venueId || '')) return false;
  if (!task.isPrivate) return true;
  if (recipient.role === 'coordinator') return true;
  const email = recipient.email.toLowerCase();
  return (task.assignedTo || []).some((a) => a.toLowerCase() === email);
}

/** Tasks of an agency visible to a specific recipient (private-task rule). */
function tasksForRecipient(agencyId: string, recipient: UserProfile | undefined) {
  const norm = (v?: string) => v || 'agency-hkc';
  return tasks.filter(
    (t) => norm(t.agencyId) === agencyId && canSeeTaskServer(t, recipient)
  );
}

/**
 * Broadcast a task update with transition handling (addendum item 1).
 * - Recipients who can see the NEW task get TASK_UPDATED (full).
 * - Recipients who could see the OLD task but not the NEW one get TASK_DELETED
 *   (their client holds a stale copy that must be removed immediately).
 * - Recipients who could see neither get nothing.
 * oldTask and newTask are the visibility-relevant snapshots ({isPrivate, assignedTo}).
 */
function broadcastTaskUpdated(
  oldTask: { isPrivate?: boolean; assignedTo?: string[] },
  newTask: any,
  senderEmail?: string
) {
  const agencyId = newTask.agencyId || 'agency-hkc';
  broadcast(
    'TASK_UPDATED',
    newTask,
    senderEmail,
    agencyId,
    (meta, task) => (canSeeTaskServer(task, recipientForMeta(meta)) ? task : null)
  );
  broadcast(
    'TASK_DELETED',
    { id: newTask.id, venueId: newTask.venueId, agencyId },
    undefined,
    agencyId,
    (meta, base) => {
      const recipient = recipientForMeta(meta);
      const sawOld = canSeeTaskServer(oldTask, recipient);
      const seesNew = canSeeTaskServer(newTask, recipient);
      return sawOld && !seesNew ? base : null;
    }
  );
}

/**
 * Broadcast an event update with transition handling (item 7, fix round 1) —
 * mirrors broadcastTaskUpdated for private tasks:
 * - Recipients who can see the NEW event get EVENT_UPDATED (full).
 * - Recipients who could see the OLD event but not the NEW one get
 *   EVENT_DELETED (their client holds a stale copy that must be removed
 *   immediately — this is the stale-assignment path: when an admin
 *   reassigns the event away from a mashgiach, that mashgiach gets the
 *   delete, and their next toggle 403s anyway via mayFillEventTasks).
 * oldEvent/newEvent are the stored snapshots (assignedMashgiachEmail matters).
 */
function broadcastEventUpdated(
  oldEvent: any,
  newEvent: any,
  senderEmail?: string
) {
  const agencyId = newEvent.agencyId || 'agency-hkc';
  broadcast(
    'EVENT_UPDATED',
    {
      event: newEvent,
      agencyId,
      venueId: newEvent.venueId,
      assignedMashgiachEmail: newEvent.assignedMashgiachEmail,
    },
    senderEmail,
    agencyId,
    (meta, payload) => {
      const recipient = recipientForMeta(meta);
      return canSeeEventServer(newEvent, recipient) ? payload : null;
    }
  );
  broadcast(
    'EVENT_DELETED',
    {
      id: newEvent.id,
      agencyId,
      venueId: newEvent.venueId,
      // Only the previous assignee rides along — the stale assignee does not
      // need to learn who replaced them (LOW a, fix round 2).
      previousAssignee: oldEvent?.assignedMashgiachEmail,
    },
    undefined,
    agencyId,
    (meta, base) => {
      const recipient = recipientForMeta(meta);
      const sawOld = canSeeEventServer(oldEvent, recipient);
      const seesNew = canSeeEventServer(newEvent, recipient);
      return sawOld && !seesNew ? base : null;
    }
  );
}

/**
 * Filter snapshot/history entries per recipient (shared by historyLogsForRecipient
 * and the DAILY_RESET snapshots payload — same entry shape).
 */
function filterLogEntries(logs: any[], recipient: UserProfile | undefined) {
  // RULE T: privileged = admin only. A non-admin never receives a log whose
  // venue is outside their scope (the whole log is dropped, not just entries).
  // Inside an own-venue log, a coordinator counts as privileged for
  // deleted-task entries; everyone else fails closed on those.
  const isAdmin = recipient?.role === 'admin';
  const scope = venueScopeFor(recipient);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const keepLog = (h: any) =>
    isAdmin || (typeof h?.venueId === 'string' && scope.includes(h.venueId));
  return logs.filter(keepLog).map((h) => {
    if (!Array.isArray((h as any).entries)) return h;
    const privilegedInVenue =
      isAdmin || (recipient?.role === 'coordinator' && scope.includes(h.venueId));
    const entries = (h as any).entries.filter((e: any) => {
      const task = taskById.get(e.taskId);
      if (!task) return privilegedInVenue; // deleted task: fail closed unless privileged here
      return canSeeTaskServer(task, recipient);
    });
    return { ...h, entries };
  });
}

/**
 * History logs of an agency with snapshot entries filtered per recipient.
 * Each entry references a task by taskId; entries for private tasks the
 * recipient cannot see are removed. If the task no longer exists (deleted),
 * fail closed for non-admin/coordinator (exclude); admins/coordinators see
 * everything anyway. Returns new objects (never mutates the stored logs).
 */
function historyLogsForRecipient(agencyId: string, recipient: UserProfile | undefined) {
  const norm = (v?: string) => v || 'agency-hkc';
  return filterLogEntries(
    historyLogs.filter((h) => norm(h.agencyId) === agencyId),
    recipient
  );
}

/**
 * Authorize a socket for broadcast receipt. Returns the socket's metadata
 * when the socket carries authenticated metadata AND its user still exists
 * and belongs to the socket's agency; otherwise closes the socket (4401)
 * and returns null. A socket without metadata, or whose user was deleted,
 * moved, or revoked, must never receive data — on either broadcast path,
 * scoped or unscoped. Fail closed: an unauthorizable socket is terminated,
 * not skipped silently.
 */
/** SO: close (4401) and unregister every open phone socket of one row.
 * Matches on user id AND session type (kiosk sockets are never touched). */
function revokeUserPhoneSockets(userId: string): number {
  let n = 0;
  for (const [client, meta] of Array.from(activeSockets.entries())) {
    if (!meta || meta.kiosk || meta.userId !== userId) continue;
    try {
      client.close(4401, 'Unauthorized');
    } catch {}
    activeSockets.delete(client);
    n++;
  }
  if (n) log.info(`[auth] closed ${n} open session socket(s) after a password reset`);
  return n;
}

function authorizeSocket(client: WebSocket): SocketMeta | null {
  const meta = activeSockets.get(client);
  if (!meta || !recipientForMeta(meta)) {
    try {
      client.close(4401, 'Unauthorized');
    } catch {}
    activeSockets.delete(client);
    return null;
  }
  // SO: a phone socket's token must still resolve (same resolver as HTTP):
  // a bumped tokenEpoch (password reset) or a deleted row fails closed.
  if (!meta.kiosk && !(meta.tokenClaims && resolveSessionRow(meta.tokenClaims, users as any[]))) {
    try {
      client.close(4401, 'Unauthorized');
    } catch {}
    activeSockets.delete(client);
    return null;
  }
  // Kiosk sockets are re-validated on every delivery (same revocation rule
  // as the HTTP middleware): the user must still exist, still have a
  // kioskPinHash, and still sit in the token's agency and venue.
  if (meta.kiosk) {
    const user = users.find((u) => u.id === meta.userId);
    // No 'agency-hkc' fallback: a kiosk meta without kioskAgencyId/pv is invalid.
    // C1: the bound device must still exist and match the socket's
    // agency/venue; pv is the PIN revision (2b).
    // K1: the same shared re-validation as the HTTP middleware.
    const stillValid = kioskSessionStillValid(user, {
      agencyId: meta.kioskAgencyId, venueId: meta.kioskVenueId, pv: meta.kioskPv, deviceId: meta.kioskDeviceId,
    });
    if (!stillValid) {
      try {
        client.close(4401, 'Unauthorized');
      } catch {}
      activeSockets.delete(client);
      return null;
    }
  }
  return meta;
}

const INITIAL_TASKS: TaskItem[] = [];

const INITIAL_HISTORY: HistoryLog[] = [];

let agencies: Agency[] = [...DEFAULT_AGENCIES];
let venues: Venue[] = [...DEFAULT_VENUES];
let tasks: TaskItem[] = [...INITIAL_TASKS];
let historyLogs: HistoryLog[] = [...INITIAL_HISTORY];
let users: UserProfile[] = [...DEFAULT_USERS];
let handoffNotes: HandoffNote[] = [];
let taskTemplates: TaskTemplate[] = [];
let incidents: Incident[] = [];
let announcements: Announcement[] = [];
let passwordResets: PasswordResetRequest[] = [];
let passwordResetRateLimits: PasswordResetRateLimits = emptyRateLimits();

/** Kiosk PIN lockout state (persisted in the state doc, survives restarts). */
interface KioskPinLockouts {
  users: { [userId: string]: { fails: string[]; lockedUntil?: number } };
  tablets: { [key: string]: { fails: string[]; lockedUntil?: number } }; // key = venueId|ip
}
function emptyKioskPinLockouts(): KioskPinLockouts {
  return { users: {}, tablets: {} };
}
let kioskPinLockouts: KioskPinLockouts = emptyKioskPinLockouts();

/**
 * Kiosk devices (2b): a tablet is PAIRED to exactly one venue by an admin or
 * that venue's coordinator. The device authenticates with a random secret;
 * only its sha256 hash is ever stored (rule M). Kiosk sign-in works only on
 * a paired tablet, and only for that tablet's venue.
 */
interface KioskDevice {
  id: string;
  agencyId: string;
  venueId: string;
  name: string;
  secretHash: string; // sha256 hex of the device secret — NEVER the plain secret
  createdAt: string;
  pairedByUserId: string;
  pairedByName: string;
  lastSeenAt?: string;
}
let kioskDevices: KioskDevice[] = [];

/** A pending/approved pairing, keyed by pairingId. Pruned of expired and
 * claimed entries on every pairing write. */
interface KioskPairing {
  pairingCodeHash: string; // sha256 hex of the 6-char pairing code (named so backup.ts's scrub catches it)
  secretHash: string; // sha256 hex of the device secret minted at start
  ip: string;
  createdAt: number; // ms epoch
  expiresAt: number; // ms epoch
  status: 'pending' | 'approved';
  deviceId?: string;
  venueId?: string;
  venueName?: string;
  approvedAt?: number; // ms epoch, stamped by the pair commit; the claim deadline is DERIVED (approvedAt + TTL), never stored
}
let kioskPairings: { [pairingId: string]: KioskPairing } = {};

/** Pairing rate-limit buckets (persisted like the PIN lockouts):
 * keys 'start|<ip>', 'caller|<userId>', 'pairip|<ip>' → attempt timestamps. */
let kioskPairingLimits: { [key: string]: string[] } = {};
let eventTaskTemplates: EventTaskTemplate[] = [];
// Legacy single work date (America/New_York). Item 6: it is now only the
// migration bridge for venues without their own marker (and the marker for
// tasks whose venue no longer exists); /api/health still shows it.
let currentWorkDate = workDateIn(DEFAULT_TIME_ZONE, new Date());
// Item 6: the workday each venue was last rolled to ("YYYY-MM-DD" in the
// venue's own zone). The scheduler decides per venue from this map.
let venueWorkDates: Record<string, string> = {};
let isDemoCleared = false;

const INITIAL_EVENTS: KosherEventItem[] = [];

let events: KosherEventItem[] = [...INITIAL_EVENTS];

const INITIAL_AIRTABLE_CONFIGS: AirtableConfigItem[] = [];

const INITIAL_APPROVED_INGREDIENTS: ApprovedIngredientItem[] = [];

let airtableConfigs: AirtableConfigItem[] = [...INITIAL_AIRTABLE_CONFIGS];
let approvedIngredients: ApprovedIngredientItem[] = [...INITIAL_APPROVED_INGREDIENTS];
let factoryReports: FactoryAuditReportItem[] = [];

// Web Push (phone notifications): per-user browser subscriptions + VAPID keys.
// VAPID keys come from env when set; otherwise generated once and persisted
// with the rest of the state so subscriptions survive restarts and deploys.
interface PushSubscriptionRecord {
  userEmail: string;
  /** Item 8t: the verified subscriber's id + agency (absent on legacy records). */
  userId?: string;
  agencyId?: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}
let pushSubscriptions: PushSubscriptionRecord[] = [];
let vapidKeys: { publicKey: string; privateKey: string } | null = null;

// Load persisted state if exists
// Hydrate all in-memory state from a parsed snapshot (local file or Firestore).
function hydrateState(parsed: any) {
  try {
      if (parsed.isDemoCleared !== undefined) {
        isDemoCleared = Boolean(parsed.isDemoCleared);
      }

      // Web Push state survives regardless of demo mode
      if (Array.isArray(parsed.pushSubscriptions)) {
        pushSubscriptions = parsed.pushSubscriptions.filter(
          (s: any) => s && s.endpoint && s.userEmail && s.keys
        );
      }
      // Persisted VAPID keys only win when env vars are not set (env takes precedence)
      if (
        !process.env.VAPID_PUBLIC_KEY &&
        parsed.vapidKeys &&
        parsed.vapidKeys.publicKey &&
        parsed.vapidKeys.privateKey
      ) {
        vapidKeys = {
          publicKey: parsed.vapidKeys.publicKey,
          privateKey: parsed.vapidKeys.privateKey,
        };
      }
      // Persisted JWT secret only wins when JWT_SECRET env is not set.
      if (!process.env.JWT_SECRET && typeof parsed.jwtSecret === 'string' && parsed.jwtSecret.length >= 32) {
        jwtSecret = parsed.jwtSecret;
      }

      // Password reset requests are persisted so they survive restarts.
      // Expired entries are pruned on read (15-min TTL enforced at use).
      // Accepts both new `codeHash` entries and legacy plaintext `code` entries
      // (legacy entries expire naturally; new writes always use codeHash).
      if (Array.isArray(parsed.passwordResets)) {
        const now = Date.now();
        passwordResets = parsed.passwordResets.filter(
          (r: any) => r && r.email && (r.codeHash || r.code) && new Date(r.expiresAt).getTime() > now - 3600000
        );
      }

      // Rate-limit state is persisted so limits survive restarts and work
      // across instances. Malformed entries are dropped defensively.
      if (parsed.passwordResetRateLimits && typeof parsed.passwordResetRateLimits === 'object') {
        const rl = parsed.passwordResetRateLimits;
        passwordResetRateLimits = {
          emailRequests: typeof rl.emailRequests === 'object' && rl.emailRequests ? rl.emailRequests : {},
          ipRequests: typeof rl.ipRequests === 'object' && rl.ipRequests ? rl.ipRequests : {},
          ipVerifies: typeof rl.ipVerifies === 'object' && rl.ipVerifies ? rl.ipVerifies : {},
        };
      } else {
        passwordResetRateLimits = emptyRateLimits();
      }

      // Kiosk PIN lockouts (persisted; survives restarts).
      if (parsed.kioskPinLockouts && typeof parsed.kioskPinLockouts === 'object') {
        const kl = parsed.kioskPinLockouts;
        kioskPinLockouts = {
          users: typeof kl.users === 'object' && kl.users ? kl.users : {},
          tablets: typeof kl.tablets === 'object' && kl.tablets ? kl.tablets : {},
        };
      } else {
        kioskPinLockouts = emptyKioskPinLockouts();
      }

      // Kiosk devices + pairings (2b). Malformed entries are dropped (fail
      // closed: a device that cannot be validated can never authenticate).
      // A device's secretHash must be exactly 64 lowercase hex chars and
      // its name a string; a pairing's hashes likewise. DUPLICATE device
      // ids are dropped ENTIRELY — with two records for one id, neither is
      // trustworthy.
      if (Array.isArray(parsed.kioskDevices)) {
        const HEX64 = /^[0-9a-f]{64}$/;
        const wellFormed = (parsed.kioskDevices as any[]).filter(
          (d) => d && typeof d.id === 'string' && d.id &&
            typeof d.secretHash === 'string' && HEX64.test(d.secretHash) &&
            typeof d.name === 'string' &&
            typeof d.venueId === 'string' && d.venueId &&
            typeof d.agencyId === 'string' && d.agencyId
        );
        const idCounts = new Map<string, number>();
        for (const d of wellFormed) idCounts.set(d.id, (idCounts.get(d.id) || 0) + 1);
        kioskDevices = wellFormed.filter((d) => idCounts.get(d.id) === 1);
      } else {
        kioskDevices = [];
      }
      if (parsed.kioskPairings && typeof parsed.kioskPairings === 'object') {
        const HEX64 = /^[0-9a-f]{64}$/;
        kioskPairings = {};
        for (const [pid, pr] of Object.entries(parsed.kioskPairings as any)) {
          const r: any = pr as any;
          if (r && typeof r.pairingCodeHash === 'string' && HEX64.test(r.pairingCodeHash) &&
              typeof r.secretHash === 'string' && HEX64.test(r.secretHash) &&
              (r.status === 'pending' || r.status === 'approved') &&
              typeof r.expiresAt === 'number') {
            kioskPairings[pid] = r;
          }
        }
      } else {
        kioskPairings = {};
      }
      if (parsed.kioskPairingLimits && typeof parsed.kioskPairingLimits === 'object') {
        kioskPairingLimits = {};
        for (const [k, v] of Object.entries(parsed.kioskPairingLimits as any)) {
          if (Array.isArray(v)) kioskPairingLimits[k] = v.filter((t) => typeof t === 'string');
        }
      } else {
        kioskPairingLimits = {};
      }

      if (Array.isArray(parsed.agencies) && parsed.agencies.length > 0) {
        agencies = parsed.agencies;
      } else {
        agencies = [...DEFAULT_AGENCIES];
      }

      // Ensure default agency is present
      for (const defAgency of DEFAULT_AGENCIES) {
        if (!agencies.some((a) => a.id === defAgency.id)) {
          agencies.push({ ...defAgency });
        }
      }

      if (isDemoCleared) {
        // Cleared (legacy stored flag; 8x removed the route that set it): venues,
        // tasks, history, events are strictly what the user created
        venues = Array.isArray(parsed.venues) ? parsed.venues : [];
        tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        historyLogs = Array.isArray(parsed.historyLogs) ? parsed.historyLogs : [];
        handoffNotes = Array.isArray(parsed.handoffNotes) ? parsed.handoffNotes : [];
        taskTemplates = Array.isArray(parsed.taskTemplates) ? parsed.taskTemplates : [];
        incidents = Array.isArray(parsed.incidents) ? parsed.incidents : [];
        announcements = Array.isArray(parsed.announcements) ? parsed.announcements : [];
        events = Array.isArray(parsed.events) ? parsed.events : [];
        airtableConfigs = Array.isArray(parsed.airtableConfigs) ? parsed.airtableConfigs : [];
        approvedIngredients = Array.isArray(parsed.approvedIngredients) ? parsed.approvedIngredients : [];
        factoryReports = Array.isArray(parsed.factoryReports) ? parsed.factoryReports : [];

        // Same normalisation and template load as the other branch (rule N):
        // the in-transaction caller checks compare against NORMALIZED cache
        // users, and event task templates must survive a reload here too.
        if (Array.isArray(parsed.users) && parsed.users.length > 0) {
          users = parsed.users.map((u: any) => normalizeStoredUser(u));
        } else {
          users = [{ ...DEFAULT_USERS[0] }];
        }
        eventTaskTemplates = Array.isArray(parsed.eventTaskTemplates)
          ? parsed.eventTaskTemplates.filter((t: any) => t && t.id && t.title)
          : [];
      } else {
        if (Array.isArray(parsed.venues)) {
          venues = parsed.venues.map((v: any) => ({
            ...v,
            agencyId: v.agencyId || 'agency-hkc',
          }));
        } else {
          venues = [...DEFAULT_VENUES];
        }

        if (Array.isArray(parsed.tasks)) {
          // Sanitize: any task that is not completed should not retain completion attribution logs
          tasks = parsed.tasks.map((t: any) => {
            const matchingVenue = venues.find((v) => v.id === t.venueId);
            const assignedAgencyId = t.agencyId || matchingVenue?.agencyId || 'agency-hkc';
            return {
              ...t,
              agencyId: assignedAgencyId,
              venueId: t.venueId || 'venue-crown-market',
              ...(!t.isCompleted
                ? { updatedByEmail: null, updatedByName: null, updatedAt: null }
                : {}),
            };
          });
        }

        if (Array.isArray(parsed.historyLogs)) {
          historyLogs = parsed.historyLogs.map((h: any) => {
            const matchingVenue = venues.find((v) => v.id === h.venueId);
            return {
              ...h,
              agencyId: h.agencyId || matchingVenue?.agencyId || 'agency-hkc',
              venueId: h.venueId || 'venue-crown-market',
            };
          });
        }

        if (Array.isArray(parsed.users)) {
          // Rule N: one normalization function, used here and on
          // freshCaller inside the PUT /api/events transaction (see
          // normalizeStoredUser).
          users = parsed.users.map((u: any) => normalizeStoredUser(u));

          // Ensure primary agency admin exists
          const adminUser = DEFAULT_USERS[0];
          if (!users.some((u) => u.email.toLowerCase() === adminUser.email.toLowerCase())) {
            users.unshift({ ...adminUser });
          }
        }

        if (Array.isArray(parsed.events)) {
          events = parsed.events;
        } else {
          events = [...INITIAL_EVENTS];
        }

        if (Array.isArray(parsed.airtableConfigs)) {
          airtableConfigs = parsed.airtableConfigs;
        } else {
          airtableConfigs = [...INITIAL_AIRTABLE_CONFIGS];
        }

        if (Array.isArray(parsed.approvedIngredients)) {
          approvedIngredients = parsed.approvedIngredients;
        } else {
          approvedIngredients = [...INITIAL_APPROVED_INGREDIENTS];
        }

        if (Array.isArray(parsed.factoryReports)) {
          factoryReports = parsed.factoryReports;
        } else {
          factoryReports = [];
        }

        if (Array.isArray(parsed.eventTaskTemplates)) {
          eventTaskTemplates = parsed.eventTaskTemplates.filter(
            (t: any) => t && t.id && t.title
          );
        } else {
          eventTaskTemplates = [];
        }

        // These were missing from the non-demo-cleared branch: without them,
        // a restart would empty the in-memory arrays even though Firestore
        // has the data (GET endpoints would return []).
        if (Array.isArray(parsed.incidents)) {
          incidents = parsed.incidents;
        } else {
          incidents = [];
        }

        if (Array.isArray(parsed.announcements)) {
          announcements = parsed.announcements;
        } else {
          announcements = [];
        }

        if (Array.isArray(parsed.handoffNotes)) {
          handoffNotes = parsed.handoffNotes;
        } else {
          handoffNotes = [];
        }

        if (Array.isArray(parsed.taskTemplates)) {
          taskTemplates = parsed.taskTemplates;
        } else {
          taskTemplates = [];
        }
      }

      if (parsed.currentWorkDate) currentWorkDate = parsed.currentWorkDate;
      venueWorkDates = sanitizeVenueWorkDates(parsed.venueWorkDates);
      if (typeof parsed._v === 'number' && parsed._v >= 0) {
        stateVersion = parsed._v;
      }
  } catch (err) {
    log.warn('Could not hydrate state:', err);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      hydrateState(JSON.parse(raw));
    }
  } catch (err) {
    log.warn('Could not read store.json, using defaults:', err);
  }
}

// Single snapshot of everything the server persists.
// _v is the monotonic document version for optimistic concurrency (Stage 2).
// It is managed exclusively by commitState() — never set it manually.
function stateSnapshot() {
  return {
    _v: stateVersion,
    agencies,
    venues,
    tasks,
    historyLogs,
    handoffNotes,
    taskTemplates,
    incidents,
    announcements,
    users,
    events,
    eventTaskTemplates,
    airtableConfigs,
    approvedIngredients,
    factoryReports,
    currentWorkDate,
    venueWorkDates,
    isDemoCleared,
    pushSubscriptions,
    vapidKeys,
    jwtSecret,
    resetPepper: (globalThis as any).__resetPepper || undefined,
    passwordResets,
    passwordResetRateLimits,
    kioskPinLockouts,
    kioskDevices,
    kioskPairings,
    kioskPairingLimits,
  };
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(stateSnapshot(), null, 2), 'utf-8');
  } catch (err) {
    log.warn('Could not save store.json:', err);
  }
  // Best-effort durable save to Firestore (never blocks, never throws).
  persistToFirestore();
}

// ---------------------------------------------------------------------------
// Firestore durable persistence.
//
// The local store.json lives on the container's ephemeral filesystem: every
// deploy or server restart wipes it. Firestore is the durable copy.
//
// Fail-closed on Cloud Run (K_SERVICE set): if Firestore init fails there,
// the server REFUSES TO START (process.exit(1)) instead of serving in
// silent degraded mode. In local dev (no K_SERVICE) a failed init falls
// back to the local file, with a loud DEGRADED warning on every write.
// Emergency kill-switch: FORCE_LOCAL_MODE=true skips Firestore init
// entirely (even on Cloud Run) — see EMERGENCY.md.
// ---------------------------------------------------------------------------
const FIRESTORE_STATE_DOC = 'app-state/main';
let firestoreDb: any = null;
// Set true once we've successfully applied Firestore state (or confirmed no
// doc exists yet). persistToFirestore() refuses to write until this is true,
// so a slow/failed boot can never overwrite good data with seed defaults.
let durableStateLoaded = false;
// Tracks WHY Firestore is absent, for /api/health and logs. Set by
// initFirestore(): 'connected' = init succeeded; 'disabled' = intentionally
// off (FORCE_LOCAL_MODE kill-switch, or no credentials available in local
// dev); 'degraded-local' = init was attempted but failed (local dev only —
// on Cloud Run a failed init refuses to start instead, see below).
let firestoreInitStatus: 'connected' | 'degraded-local' | 'disabled' = 'disabled';

function getFirestoreConfig(): { projectId?: string; databaseId?: string } {
  let fileConfig: any = {};
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch {
    // config file not present — env vars still work
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || fileConfig.projectId,
    // An explicitly-set (even empty) FIRESTORE_DATABASE_ID wins over the file.
    // Empty string means "use the Firestore default database" (used by tests
    // against the emulator, where the production database ID does not exist).
    databaseId: process.env.FIRESTORE_DATABASE_ID !== undefined
      ? process.env.FIRESTORE_DATABASE_ID || undefined
      : fileConfig.firestoreDatabaseId,
  };
}

async function initFirestore() {
  // Emergency kill-switch (see EMERGENCY.md §1 Option B / §2). When set,
  // Firestore init is skipped ENTIRELY — even on Cloud Run. The server runs
  // in local-file mode (ephemeral on Cloud Run: data will NOT persist across
  // restarts) and logs a loud warning on every write attempt. Fail-closed
  // is deliberately NOT triggered by this path: the degraded mode is the
  // operator's explicit choice.
  if (process.env.FORCE_LOCAL_MODE === 'true') {
    log.warn('[Firestore] FORCE_LOCAL_MODE=true — skipping Firestore init entirely (local file only, NO durability).');
    firestoreInitStatus = 'disabled';
    return;
  }
  try {
    // Test hook: in-memory Firestore mock with faithful transaction semantics.
    // Used by the Stage 2 test suite (FIRESTORE_MOCK=true). NEVER on Cloud Run.
    if (process.env.FIRESTORE_MOCK === 'true') {
      if (process.env.K_SERVICE) {
        log.error('[FATAL] FIRESTORE_MOCK=true on Cloud Run (K_SERVICE set). Refusing to start with mock data in production.');
        process.exit(1);
      }
      const mockMod = await import('./tests/stage2/firestore-mock.mjs');
      firestoreDb = mockMod.getMockFirestore();
      firestoreInitStatus = 'connected';
      console.log('[Firestore] Using in-memory mock (FIRESTORE_MOCK=true).');
      return;
    }
    // Only attempt Firestore where GCP credentials can exist: Cloud Run
    // (K_SERVICE is always set there), an explicit service-account key, or an
    // explicit opt-in. Anywhere else the ADC lookup would hang and fail, so
    // stay on the local file.
    const mayHaveCredentials =
      process.env.K_SERVICE ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIRESTORE_ENABLED === 'true';
    if (!mayHaveCredentials) {
      console.log('[Firestore] Not on Cloud Run — durable persistence disabled (file only).');
      firestoreInitStatus = 'disabled';
      return;
    }
    const { projectId, databaseId } = getFirestoreConfig();
    const onCloudRun = !!process.env.K_SERVICE;
    if (!projectId) {
      // On Cloud Run a missing project config is a FATAL misconfiguration,
      // not a soft fallback: fail closed (handled in the catch below).
      if (onCloudRun) {
        throw new Error('No Firebase project configured (FIREBASE_PROJECT_ID or firebase-applet-config.json missing).');
      }
      console.log('[Firestore] No project configured — durable persistence disabled (file only).');
      firestoreInitStatus = 'disabled';
      return;
    }
    const app = getApps().length > 0 ? getApp() : initializeApp({ projectId });
    firestoreDb = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
    firestoreInitStatus = 'connected';
    console.log(`[Firestore] Durable persistence enabled (db: ${databaseId || '(default)'}).`);
  } catch (err: any) {
    firestoreDb = null;
    if (process.env.K_SERVICE) {
      // FAIL-CLOSED in production: a Cloud Run instance that cannot reach
      // Firestore must NEVER serve in silent degraded mode (writes would
      // land in the ephemeral container and be lost on the next deploy).
      // Crash the boot so Cloud Run surfaces the failure loudly instead.
      log.error('[Firestore] FATAL: Firestore init failed on Cloud Run — refusing to start:', err?.message);
      process.exit(1);
    }
    firestoreInitStatus = 'degraded-local';
    log.warn('[Firestore] Init failed — durable persistence disabled (file only):', err?.message);
  }
}

/**
 * PR D: Load tasks, venues, users from per-entity collections into memory.
 * Called at startup when READ_FROM_PER_ENTITY=true.
 *
 * FAILS LOUDLY: if the flag is set but collections can't be read, the server
 * must not silently fall back to monolith reads (that would mask a broken
 * migration). Throws on failure.
 *
 * Strips per-entity _v (in-memory uses monolith versioning).
 */
async function loadPerEntityIntoMemory(): Promise<void> {
  if (!firestoreDb) {
    throw new Error('[PerEntity] READ_FROM_PER_ENTITY=true but Firestore is not available.');
  }
  const [tasksSnap, venuesSnap, usersSnap] = await Promise.all([
    firestoreDb.collection('tasks').get(),
    firestoreDb.collection('venues').get(),
    firestoreDb.collection('users').get(),
  ]);
  // Strip _v from per-entity docs (in-memory doesn't use per-entity versioning)
  tasks = tasksSnap.docs.map((d: any) => {
    const { _v, ...rest } = d.data();
    return rest;
  });
  venues = venuesSnap.docs.map((d: any) => {
    const { _v, ...rest } = d.data();
    return rest;
  });
  users = usersSnap.docs.map((d: any) => {
    const { _v, ...rest } = d.data();
    return rest;
  });
  console.log(`[PerEntity] Loaded ${tasks.length} tasks, ${venues.length} venues, ${users.length} users from per-entity collections.`);
}

// Load durable state at boot. Returns true when Firestore had state to apply.
// Sets durableStateLoaded so persistToFirestore() knows it's safe to write.
async function loadStateFromFirestore(): Promise<boolean> {
  if (!firestoreDb) return false;
  try {
    const snap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
    if (!snap.exists) {
      console.log('[Firestore] No saved state yet — starting from local file.');
      durableStateLoaded = true; // Nothing to overwrite; in-memory is the baseline.
      return false;
    }
    hydrateState(snap.data());
    durableStateLoaded = true;
    console.log('[Firestore] Loaded durable state.');
    // PR D: If reading from per-entity, override tasks/venues/users from collections.
    // Fail loudly if per-entity is empty but monolith had data (copy not run).
    if (process.env.READ_FROM_PER_ENTITY === 'true') {
      const monolithCounts = {
        tasks: tasks.length,
        venues: venues.length,
        users: users.length,
      };
      await loadPerEntityIntoMemory();
      const perEntityTotal = tasks.length + venues.length + users.length;
      const monolithTotal = monolithCounts.tasks + monolithCounts.venues + monolithCounts.users;
      if (perEntityTotal === 0 && monolithTotal > 0) {
        throw new Error(
          `[PerEntity] READ_FROM_PER_ENTITY=true but per-entity collections are empty ` +
          `(monolith has ${monolithTotal} entities). Run POST /api/admin/migrate-copy first.`
        );
      }
    }
    return true;
  } catch (err: any) {
    log.warn('[Firestore] Could not load state:', err?.message);
    return false;
  }
}

// Fire-and-forget durable write. RETIRED in Stage 2 — DO NOT CALL.
//
// Stage 2 replaced this with commitState(), the single transactional write
// path. This function performed an UNVERSIONED, NON-TRANSACTIONAL .set() of
// the entire document, which could overwrite a committed transaction with a
// stale in-memory snapshot. It is kept as a no-op (not deleted) so any
// forgotten caller fails safe instead of silently corrupting data. If you see
// this warning in logs, that caller must be migrated to commitState().
function persistToFirestore() {
  log.warn('[Firestore] persistToFirestore() is retired — use commitState(). Call ignored.');
}

// ============================================================================
// STAGE 2: Single transactional write path — Firestore is authoritative.
// ----------------------------------------------------------------------------
// Every mutation MUST go through commitState(). The old pattern (mutate
// in-memory arrays → saveState() → fire-and-forget Firestore write) is
// retired. The new flow:
//
//   1. Handler validates input (reads from in-memory cache — safe).
//   2. Handler calls await commitState(mutator, { expectedVersion, operationId }).
//   3. commitState opens a Firestore transaction:
//      a. Reads the live document + its _v version.
//      b. If expectedVersion was provided and !== current _v → 409 Conflict.
//      c. Runs mutator(freshDoc) — the mutator applies the change to FRESH
//         Firestore data, never to the in-memory snapshot.
//      d. Mutator returns { doc, result } or { conflict: message }.
//      e. Writes doc with _v+1 and server timestamp, atomically.
//   4. On commit success: hydrate in-memory from committed doc, record
//      operationId for idempotency, return result.
//   5. Caller (handler) then broadcasts WebSocket, sends pushes, responds.
//   6. On ANY failure: in-memory untouched, nothing broadcast, error returned.
//
// Invariants:
// - In-memory state is a READ CACHE. It is only updated from committed
//   Firestore data, never the other way around.
// - No WebSocket broadcast, push notification, or HTTP success happens
//   until the Firestore transaction commits.
// - A failed write leaves zero trace: no memory change, no broadcast,
//   no partial persistence.
// ============================================================================

class VersionConflictError extends Error {
  code = 'VERSION_CONFLICT';
  currentVersion: number;
  expectedVersion: number;
  constructor(currentVersion: number, expectedVersion: number) {
    super(`Version conflict: expected ${expectedVersion}, found ${currentVersion}. Please refresh and retry.`);
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
    this.expectedVersion = expectedVersion;
  }
}

class OperationConflictError extends Error {
  code = 'OPERATION_CONFLICT';
  /** Item 8s: a mutator may name the HTTP status/code of its refusal (default 409). */
  status = 409;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'OperationConflictError';
    if (status) this.status = status;
    if (code) this.code = code;
  }
}

class DuplicateOperationError extends Error {
  code = 'DUPLICATE_OPERATION';
  cachedResult: any;
  constructor(cachedResult: any) {
    super('Duplicate operation — returning cached result.');
    this.name = 'DuplicateOperationError';
    this.cachedResult = cachedResult;
  }
}

class PayloadMismatchError extends Error {
  code = 'PAYLOAD_MISMATCH';
  constructor() {
    super('Operation ID was already used for a different request. Please retry with a new operation ID.');
    this.name = 'PayloadMismatchError';
  }
}

class StagedRevisionError extends Error {
  code = 'NOT_YET_LIVE';
  constructor() {
    super('This app revision is staged for verification and is not live yet. Please wait for the cutover to complete.');
    this.name = 'StagedRevisionError';
  }
}

/**
 * The client sent an update without the version it rendered (expectedVersion).
 * This means the client is too old to participate in the version contract
 * (cached PWA from before Stage 2) or never loaded state — accepting the
 * write could silently clobber newer data. Fail safe: 428 tells the client
 * to refresh the app (preserving the user's draft) and retry.
 */
class StaleClientError extends Error {
  code = 'STALE_CLIENT';
  constructor() {
    super('Your app is out of date. Please refresh the app to get the latest data — your unsaved input is preserved — then try again.');
    this.name = 'StaleClientError';
  }
}

class FirestoreUnavailableError extends Error {
  code = 'FIRESTORE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'FirestoreUnavailableError';
  }
}

class RateLimitError extends Error {
  code = 'RATE_LIMITED';
  retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** Thrown when the document would exceed the Firestore size limit. */
class DocumentTooLargeError extends Error {
  code = 'SIZE_LIMIT';
  sizeBytes: number;
  limitBytes: number;
  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `Document too large (${Math.round(sizeBytes / 1024)} KiB exceeds ${Math.round(limitBytes / 1024)} KiB limit). ` +
      `Remove large attachments or contact support.`
    );
    this.name = 'DocumentTooLargeError';
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

// Idempotency: durable records stored in the Firestore document itself
// (doc.idempotencyRecords), so retries survive restarts and work across
// instances. Single-instance deployment (maxScale=1) is no longer load-bearing
// for correctness.
//
// Lifecycle: commitOrRespond scopes the client-supplied operationId with the
// authenticated user's ID (`${userId}:${operationId}`) into
// options.idempotencyKey. Inside the transaction, commitState reads the fresh
// document: a live (unexpired) record for the key short-circuits with the
// cached result (DuplicateOperationError); otherwise the mutator runs and the
// sanitized result is stored atomically with the main write.
//
// Concurrency: two in-flight requests with the same key both enter
// transactions; the first commits, the second's commit fails optimistic
// concurrency and is retried — the retry then sees the stored record and
// returns the cached result instead of re-executing the mutator. Mutators
// must stay pure (they already are: version-conflict retries re-run them).
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IDEMPOTENCY_MAX_RECORDS = 1000;

/** Exact-match sensitive field names (case-insensitive) stripped from cached results. */
const IDEMPOTENCY_SENSITIVE_FIELDS = new Set([
  'password', 'passwordhash', 'kioskpin', 'kioskpinhash', 'resettoken', 'apikey', 'secrethash', 'devicesecret', 'pairingcodehash', 'code',
  // Item 8b: server-only identity fields (a replayed result is sent to the
  // client as-is, so it must never carry them; tokenEpoch is caught by 'token').
  'personid', 'venueaccess', 'isprimaryadmin',
]);

/**
 * Deep-strip sensitive fields from a result before caching it as an
 * idempotency record. Removes password/passwordHash/kioskPin/kioskPinHash/resetToken/
 * apiKey and any field whose name contains 'secret' or 'token'
 * (case-insensitive). Never mutates the input.
 */
function sanitizeForIdempotency<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForIdempotency(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      const kl = k.toLowerCase();
      if (IDEMPOTENCY_SENSITIVE_FIELDS.has(kl) || kl.includes('secret') || kl.includes('token')) {
        continue;
      }
      // Don't store large blobs (e.g., base64 photos) in idempotency records.
      // Store a placeholder instead — the record is for deduplication, not data.
      if (typeof v === 'string' && v.length > 1024) {
        out[k] = `[truncated ${v.length} chars]`;
        continue;
      }
      out[k] = sanitizeForIdempotency(v);
    }
    // Safety cap: if the sanitized result is still > 10KB, store metadata only.
    const serialized = JSON.stringify(out);
    if (serialized.length > 10 * 1024) {
      return { _truncated: true, _size: serialized.length } as unknown as T;
    }
    return out as T;
  }
  return value;
}

/**
 * Drop expired idempotency records; if still over the cap, keep the newest
 * IDEMPOTENCY_MAX_RECORDS by createdAt. Runs inside the transaction, so the
 * prune is atomic with the write that triggered it.
 */
function pruneIdempotencyRecords(records: any[]): any[] {
  const now = Date.now();
  const live = records.filter(
    (r) => r && typeof r.key === 'string' && typeof r.expiresAt === 'number' && r.expiresAt > now
  );
  if (live.length <= IDEMPOTENCY_MAX_RECORDS) return live;
  return live
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, IDEMPOTENCY_MAX_RECORDS);
}

// Dev-only fallback (no Firestore configured): there is no durable store, so
// idempotency records live in memory. Production always has Firestore, so
// this Map is never consulted there.
const devIdempotencyFallback = new Map<string, { result: any; version: number; expiresAt: number }>();

// The shape a mutator returns. Either a successful mutation or a conflict.
type MutatorOutcome =
  | {
      doc: any;
      result: any;
      /** 8c ONLY (identity migrator): legacy rows that gain personId = row.id in this commit. */
      identityMigrateRowIds?: string[];
      /** 8d: rows whose tokenEpoch goes up by exactly 1 in this commit (revokes
       * their v1 and v2 tokens). The ONLY way tokenEpoch changes; in 8d only a
       * test hook uses it. */
      tokenEpochBumpIds?: string[];
      /** 9a: row id → the full validated venueAccess list for this commit
       * (admin venue grant, venue deletion prune). The ONLY way venueAccess
       * changes beyond the home venue; see src/server/identity.ts. */
      venueAccessSetById?: Record<string, string[]>;
    }
  | { conflict: string; conflictStatus?: number; conflictCode?: string };

interface CommitOptions {
  /**
   * 8c: reads made INSIDE the transaction after the monolith read and before
   * any write: (freshDoc copy, read(collection, id) → data | null) → value
   * passed to the mutator as its third argument. The local file fallback
   * (no Firestore) calls it with a reader that returns null.
   */
  preReads?: (freshDoc: any, read: (collection: string, id: string) => Promise<any>) => Promise<any>;
  /** Client-provided version for optimistic concurrency. If set and !== current _v → 409. */
  expectedVersion?: number;
  /** Client-generated UUID for idempotency. Retries with the same ID return the cached result. */
  operationId?: string;
  /**
   * Scoped idempotency key (`${userId}:${operationId}`), computed by
   * commitOrRespond from the authenticated session user. Takes precedence
   * over operationId when both are set.
   */
  idempotencyKey?: string;
  /** Authenticated user ID that owns the idempotency key (stored on the record). */
  idempotencyUserId?: string;
  /**
   * SHA-256 fingerprint of the request payload (minus versioning fields).
   * Stored on the idempotency record; a retry with the same operationId but
   * a different payload is rejected with 409 (not treated as idempotent).
   */
  payloadHash?: string;
  /** How many times to retry the transaction on version conflict (default 2). */
  maxRetries?: number;
  /** Human-readable label for logs. */
  label?: string;
  /**
   * When true, the write is an update to existing data and the client MUST
   * send expectedVersion. If it doesn't (old cached PWA client, or a client
   * that never loaded state), the server rejects with 428 STALE_CLIENT
   * instead of accepting a potentially stale write. Creates leave this false.
   */
  requireVersion?: boolean;
  /**
   * Operation type (e.g. 'update-task'), HTTP method, and target
   * (e.g. 'tasks:abc123') for idempotency scoping. Stored on the idempotency
   * record; a retry with the same operationId but a different type/method/
   * target is rejected with 409 (not treated as idempotent).
   */
  opType?: string;
  opMethod?: string;
  opTarget?: string;
}

interface CommitResult {
  result: any;
  version: number;
}

// Keys ignored when deciding whether a commit actually changed anything.
// _v is the version counter (managed by commitState, not the mutator);
// savedAt is written by the previous commit but never present in the
// mutator's output doc (it's added after this comparison).
// NOTE: `updatedAt` is ONLY ignored at the TOP LEVEL (document metadata).
// Nested entity `updatedAt` fields (e.g., task.updatedAt = "last checked")
// are REAL DATA and must be compared — see the isTopLevel flag below.
const NOOP_IGNORED_KEYS = new Set(['_v', 'savedAt']);

/**
 * Recursive structural equality for no-op detection.
 * - Top level: ignores `_v`, `updatedAt`, `savedAt` (document metadata).
 * - Nested levels: compares EVERYTHING including `updatedAt` (entity
 *   timestamps are real data).
 * Used by commitState() so a write that changes nothing doesn't bump _v
 * or cost a Firestore write. No new dependencies — plain recursion over
 * JSON-shaped data.
 */
function docsEqualIgnoring(a: any, b: any, isTopLevel = true): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => docsEqualIgnoring(item, b[i], false));
  }
  if (typeof a === 'object') {
    // Top level: also ignore `updatedAt` (document metadata).
    // Nested: compare everything (entity timestamps are real data).
    const ignored = (k: string) =>
      NOOP_IGNORED_KEYS.has(k) || (isTopLevel && k === 'updatedAt');
    const aKeys = Object.keys(a).filter((k) => !ignored(k));
    const bKeys = Object.keys(b).filter((k) => !ignored(k));
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && docsEqualIgnoring(a[k], b[k], false)
    );
  }
  return false;
}

/**
 * The ONLY way to persist a mutation. Runs the mutator inside a Firestore
 * transaction against fresh document data.
 *
 * No-op detection: if the mutator's output doc is structurally identical to
 * the current doc (ignoring _v, updatedAt, savedAt), the write is SKIPPED —
 * _v is NOT incremented and no Firestore write happens. Success is returned
 * with the existing version.
 *
 * When Firestore is unavailable (local dev without credentials), falls back
 * to the legacy in-memory + file path WITHOUT version checking, and logs a
 * loud DEGRADED warning on every write attempt. On Cloud Run (K_SERVICE)
 * this fallback never happens: a failed Firestore init refuses to start.
 */
import { dualWriteChangedEntities } from './src/server/dualwrite.js';
import { pruneHistory, shouldSweep, HISTORY_RETENTION_DAYS } from './src/server/history-retention.js';
import { enforceIdentityFields, stripServerOnlyUserFields, emailKey as identityEmailKey } from './src/server/identity.js';
import { venueScope as venueScopeOf, resolveTargetVenue, sharedVenues } from './src/server/venue-scope.js';

/**
 * Item 8b — the ONE enforcement point for server-only identity fields
 * (personId, venueAccess, isPrimaryAdmin, tokenEpoch), applied to every
 * mutator outcome in BOTH commitState paths (Firestore transaction and the
 * local/mock file path) before the no-op check, hydrate and dual-write.
 * Existing rows keep their personId/tokenEpoch exactly; new rows are born
 * migrated (personId = id); derived fields are recomputed. See
 * src/server/identity.ts.
 */
function applyIdentityInvariant(identityBase: any, outDoc: any, migrateRowIds?: string[], tokenEpochBumpIds?: string[], venueAccessSetById?: Record<string, string[]>): any {
  if (!outDoc || !Array.isArray(outDoc.users)) return outDoc;
  const beforeUsers = Array.isArray(identityBase?.users) ? identityBase.users : [];
  const agencies = Array.isArray(outDoc.agencies) ? outDoc.agencies : [];
  return {
    ...outDoc,
    users: enforceIdentityFields(beforeUsers, outDoc.users, agencies, {
      migrateRowIds: migrateRowIds && migrateRowIds.length ? new Set(migrateRowIds) : undefined,
      bumpTokenEpochIds: tokenEpochBumpIds && tokenEpochBumpIds.length ? new Set(tokenEpochBumpIds) : undefined,
      venueAccessSetById: venueAccessSetById && Object.keys(venueAccessSetById).length ? new Map(Object.entries(venueAccessSetById)) : undefined,
      onViolation: (rowId, field) =>
        log.warn(`[identity] reverted a mutator change to server-only field ${field} on user ${rowId}`),
    }),
  };
}

async function commitState(
  mutator: (freshDoc: any, currentVersion: number, preRead?: any) => MutatorOutcome,
  options: CommitOptions = {}
): Promise<CommitResult> {
  const label = options.label || 'unnamed';
  // ROUND 6 — centralized staged-revision write rejection. No indirect caller
  // (getJwtSecret(), boot backfills, background jobs) can write while staged,
  // even via a read path. This is the single transactional write boundary.
  if (isStagedRevision()) {
    throw new StagedRevisionError();
  }
  // Scoped idempotency key: `${userId}:${operationId}` so one user's retries
  // can never collide with another user's operationId.
  const idemKey = options.idempotencyKey || options.operationId || undefined;

  // ---- Fallback: no Firestore (local dev only — fail-closed on Cloud Run) ----
  if (!firestoreDb) {
    log.warn(`[Firestore] DEGRADED: writing to local file only — data will NOT persist across restarts`);
    const beforeDoc = stateSnapshot();
    // Dev-fallback idempotency: no durable store here, so check the
    // in-memory fallback map (synchronous section — atomic in the event loop).
    if (idemKey) {
      const hit = devIdempotencyFallback.get(idemKey);
      if (hit) {
        if (hit.expiresAt > Date.now()) {
          if (options.payloadHash && (hit as any).payloadHash && options.payloadHash !== (hit as any).payloadHash) {
            throw new PayloadMismatchError();
          }
          if (options.opType && (hit as any).opType && options.opType !== (hit as any).opType) {
            throw new PayloadMismatchError();
          }
          if (options.opMethod && (hit as any).opMethod && options.opMethod !== (hit as any).opMethod) {
            throw new PayloadMismatchError();
          }
          if (options.opTarget && (hit as any).opTarget && options.opTarget !== (hit as any).opTarget) {
            throw new PayloadMismatchError();
          }
          throw new DuplicateOperationError({ result: hit.result, version: hit.version });
        }
        devIdempotencyFallback.delete(idemKey);
      }
    }
    // Pristine deep copy BEFORE the mutator runs: the no-op comparison below
    // must stay correct even if a mutator mutates its input in place.
    const pristineBefore = JSON.parse(JSON.stringify(beforeDoc));
    // 8c: no Firestore here, so preReads see no documents.
    const preRead = options.preReads ? await options.preReads(pristineBefore, async () => null) : undefined;
    const outcome = mutator(beforeDoc, stateVersion, preRead);
    if ('conflict' in outcome) {
      throw new OperationConflictError(outcome.conflict, outcome.conflictStatus, outcome.conflictCode);
    }
    outcome.doc = applyIdentityInvariant(pristineBefore, outcome.doc, outcome.identityMigrateRowIds, outcome.tokenEpochBumpIds, outcome.venueAccessSetById);
    hydrateState(outcome.doc);
    // No-op detection (fallback path): skip the file write when nothing
    // changed. (The transactional path additionally skips the _v bump.)
    if (!docsEqualIgnoring(JSON.parse(JSON.stringify(outcome.doc)), pristineBefore)) {
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(stateSnapshot(), null, 2), 'utf-8');
      } catch (err) {
        log.warn('[commitState] File fallback save failed:', (err as any)?.message);
      }
    }
    const result = { result: outcome.result, version: stateVersion };
    if (idemKey) {
      devIdempotencyFallback.set(idemKey, {
        result: sanitizeForIdempotency(result.result),
        version: result.version,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        payloadHash: options.payloadHash || null,
        opType: options.opType || null,
        opMethod: options.opMethod || null,
        opTarget: options.opTarget || null,
      } as any);
    }
    return result;
  }

  // ---- Transactional path (production) ----
  if (!durableStateLoaded) {
    throw new FirestoreUnavailableError('Durable state not yet loaded — refusing to write (would risk overwriting good data).');
  }

  const maxAttempts = (options.maxRetries ?? 2) + 1;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const committed = await firestoreDb.runTransaction(async (tx: any) => {
        const docRef = firestoreDb.doc(FIRESTORE_STATE_DOC);
        const snap = await tx.get(docRef);
        const currentDoc = snap.exists ? snap.data() : null;
        const currentVersion = typeof currentDoc?._v === 'number' ? currentDoc._v : 0;

        // ---- Idempotency check-and-set (durable, inside the transaction) ----
        // Read the fresh document's idempotency records: a live record for
        // this key short-circuits with the cached result — the mutator never
        // re-runs, so a client retry after a timeout cannot double-apply.
        // Checked BEFORE the expectedVersion check so a retry carrying its
        // original (now stale) version still gets its cached result.
        if (idemKey) {
          const records: any[] = Array.isArray(currentDoc?.idempotencyRecords)
            ? currentDoc.idempotencyRecords
            : [];
          const now = Date.now();
          const hit = records.find(
            (r) => r && r.key === idemKey && typeof r.expiresAt === 'number' && r.expiresAt > now
          );
          if (hit) {
            // Payload mismatch: same operationId but different operation type
            // or payload. This is NOT a retry — reject it. Returning the
            // cached result would apply the wrong operation's outcome.
            if (options.payloadHash && hit.payloadHash && options.payloadHash !== hit.payloadHash) {
              throw new PayloadMismatchError();
            }
            // Operation-scope mismatch: same operationId AND same payload,
            // but a different action (type), HTTP method, or target entity.
            // E.g. the ID was reused for update-task vs delete-task, or for
            // task A vs task B. Not a retry — reject it.
            if (options.opType && hit.opType && options.opType !== hit.opType) {
              throw new PayloadMismatchError();
            }
            if (options.opMethod && hit.opMethod && options.opMethod !== hit.opMethod) {
              throw new PayloadMismatchError();
            }
            if (options.opTarget && hit.opTarget && options.opTarget !== hit.opTarget) {
              throw new PayloadMismatchError();
            }
            throw new DuplicateOperationError({ result: hit.result, version: hit.version });
          }
        }

        // Strict equality check: the client's view must match reality.
        if (options.expectedVersion !== undefined && options.expectedVersion !== currentVersion) {
          throw new VersionConflictError(currentVersion, options.expectedVersion);
        }

        // Run the mutator against FRESH Firestore data — never in-memory.
        // Exception: if the document doesn't exist yet (first boot), seed the
        // mutator with the in-memory baseline so the first write doesn't see
        // an empty world. This is safe because no other writer can exist yet
        // (the document is being created).
        const baseDoc = currentDoc || stateSnapshot();
        // Pristine deep copy BEFORE the mutator runs, so the no-op comparison
        // below stays correct even if a mutator mutates its input in place.
        // (Skipped on first boot when the doc doesn't exist yet — that write
        // must always happen.)
        const pristineBefore = currentDoc ? JSON.parse(JSON.stringify(currentDoc)) : null;
        // 8b: identity baseline = the stored doc, or (first boot) the seed
        // snapshot as it was before the mutator ran.
        const identityBase = pristineBefore || JSON.parse(JSON.stringify(baseDoc));
        // 8c: in-transaction reads a caller needs to decide (e.g. the identity
        // migrator's people/emails docs), on the same fresh doc, before any write.
        const preRead = options.preReads
          ? await options.preReads(JSON.parse(JSON.stringify(baseDoc)), async (collection: string, id: string) => {
              const s = await tx.get(firestoreDb.collection(collection).doc(id));
              return s.exists ? s.data() : null;
            })
          : undefined;
        const outcome = mutator(baseDoc, currentVersion, preRead);
        if ('conflict' in outcome) {
          throw new OperationConflictError(outcome.conflict, outcome.conflictStatus, outcome.conflictCode);
        }
        outcome.doc = applyIdentityInvariant(identityBase, outcome.doc, outcome.identityMigrateRowIds, outcome.tokenEpochBumpIds, outcome.venueAccessSetById);

        // No-op detection: the mutator changed nothing meaningful — skip the
        // Firestore write entirely, do NOT increment _v, return success with
        // the existing version. Compares the JSON-normalized output (exactly
        // what would be written) so `undefined` stripping can't produce a
        // false "changed" verdict.
        if (pristineBefore && docsEqualIgnoring(JSON.parse(JSON.stringify(outcome.doc)), pristineBefore)) {
          return { result: outcome.result, version: currentVersion, doc: currentDoc };
        }

        const newDoc: any = {
          ...outcome.doc,
          _v: currentVersion + 1,
          savedAt: Date.now(),
        };
        // Store the idempotency record atomically with the main write, so a
        // retry that arrives after this commit sees the cached result. The
        // cached result is sanitized (no passwords, PINs, tokens, or secrets).
        // On the no-op path above nothing is written, so no record is stored
        // either — a retry simply re-runs the effect-free mutator.
        // Expired records are pruned when the array exceeds the cap.
        const existingRecords: any[] = Array.isArray(currentDoc?.idempotencyRecords)
          ? currentDoc.idempotencyRecords
          : [];
        if (idemKey) {
          const now = Date.now();
          newDoc.idempotencyRecords = [
            ...pruneIdempotencyRecords(existingRecords),
            {
              key: idemKey,
              userId: options.idempotencyUserId || null,
              operation: label,
              payloadHash: options.payloadHash || null,
              opType: options.opType || null,
              opMethod: options.opMethod || null,
              opTarget: options.opTarget || null,
              result: sanitizeForIdempotency(outcome.result),
              createdAt: now,
              expiresAt: now + IDEMPOTENCY_TTL_MS,
              version: currentVersion + 1,
            },
          ];
        } else if (existingRecords.length > IDEMPOTENCY_MAX_RECORDS) {
          newDoc.idempotencyRecords = pruneIdempotencyRecords(existingRecords);
        }
        // Firestore rejects `undefined` with a synchronous throw — strip via JSON round-trip.
        const payload = JSON.parse(JSON.stringify(newDoc));
        // Document-size guard: Firestore hard limit is 1 MiB. We refuse at
        // 900 KiB to leave headroom for the _v/savedAt fields and to fail
        // with a clear error instead of a cryptic Firestore rejection.
        // Until Stage 3 (per-collection docs), photo/voice base64 is the main
        // size risk — see TEST_RESULTS.md for the analysis.
        const SIZE_LIMIT_BYTES = 900 * 1024;
        const payloadSize = JSON.stringify(payload).length;
        if (payloadSize > SIZE_LIMIT_BYTES) {
          throw new DocumentTooLargeError(payloadSize, SIZE_LIMIT_BYTES);
        }
        // PR C: Dual-write changed entities to per-entity collections.
        // Uses the SAME transaction (tx) — if the monolith write fails,
        // the per-entity writes roll back too. Atomic.
        // Reads still come from the monolith; this builds the mirror for PR D.
        if (pristineBefore) {
          await dualWriteChangedEntities(tx, firestoreDb, pristineBefore, outcome.doc);
        }
        tx.set(docRef, payload);
        return { result: outcome.result, version: currentVersion + 1, doc: payload };
      });

      // ---- Commit succeeded: NOW update in-memory cache ----
      // BLOCKER 3 fix: guard against out-of-order transaction completion.
      // If a newer transaction already hydrated the cache (higher _v),
      // this older result must NOT overwrite it.
      const committedVersion = committed.version;
      if (committedVersion > stateVersion) {
        hydrateState(committed.doc);
        stateVersion = committedVersion;
        // PR D note: No per-entity reload needed here. The transaction already
        // dual-wrote to per-entity collections, and hydrateState loads the same
        // entity data from the monolith doc. Both layouts are in sync.
      } else {
        log.warn(
          `[commitState:${label}] Skipping stale hydration: committed v${committedVersion} <= current v${stateVersion}. ` +
          `Newer state already in cache — not overwriting.`
        );
      }

      return { result: committed.result, version: committed.version };
    } catch (err: any) {
      // DuplicateOperationError is thrown from the idempotency check inside
      // the transaction — it must propagate untouched (the record is already
      // stored; a retry will keep returning the cached result).
      if (err instanceof DuplicateOperationError) throw err;
      // PayloadMismatchError: the operationId was reused for a different
      // action. Never retry — retrying would just re-detect the mismatch.
      // Propagate untouched so commitOrRespond maps it to 409.
      if (err instanceof PayloadMismatchError) throw err;
      // RateLimitError: never retry — the limit is real, retrying would just
      // burn the client's quota. Surface 429.
      if (err instanceof RateLimitError) {
        throw err;
      }
      if (err instanceof VersionConflictError || err instanceof OperationConflictError) {
        // Version conflicts: retry re-runs the mutator on fresh data (mergeable
        // operations succeed on retry; truly conflicting ones will hit the
        // mutator's own conflict check and raise OperationConflictError).
        // Operation conflicts: do NOT retry — the mutator already determined
        // this operation cannot apply.
        if (err instanceof VersionConflictError && attempt < maxAttempts) {
          lastError = err;
          console.log(`[commitState:${label}] Version conflict (attempt ${attempt}/${maxAttempts}) — retrying with fresh data.`);
          continue;
        }
        // Terminal failure: no idempotency record was stored (the transaction
        // aborted before the atomic write), so a legitimate client retry with
        // the same operationId will simply not find a record and re-execute.
        // Data-level idempotency in the mutators — pre-generated IDs +
        // existence checks — guards against the lost-commit edge case.
        throw err;
      }
      // Firestore errors (unavailable, deadline exceeded, etc.)
      log.warn(`[commitState:${label}] Transaction failed (attempt ${attempt}/${maxAttempts}):`, err?.message);
      lastError = err;
      if (attempt < maxAttempts) continue;
      throw new FirestoreUnavailableError(`Save failed after ${maxAttempts} attempts: ${err?.message || 'unknown error'}. Your data was NOT saved — please retry.`);
    }
  }
  throw lastError;
}

// In-memory mirror of the Firestore document version. Updated only from
// committed transaction results. Used by the file-fallback path and for
// observability; the transaction always reads the authoritative _v from
// Firestore, never this.
let stateVersion = 0;

/**
 * The idempotency scope of a write request, derived ONE way for
 * commitOrRespond and for replayCommittedOperation (item 7): caller-scoped
 * key, payload fingerprint and target.
 */
function idempotencyScopeFor(req: any) {
  const body = req.body || {};
  const query = req.query || {};
  const expectedVersion =
    body.expectedVersion !== undefined ? Number(body.expectedVersion) :
    query.expectedVersion !== undefined ? Number(query.expectedVersion) : undefined;
  const operationId = body.operationId || query.operationId || undefined;
  // Scope the idempotency key to the authenticated caller:
  // `${userId}:${operationId}` — never the bare client-supplied operationId,
  // so one user's retries can never collide with another user's.
  const authUserId = (req as any).authUser?.id as string | undefined;
  const idempotencyKey = operationId
    ? authUserId
      ? `${authUserId}:${operationId}`
      : operationId
    : undefined;
  // Payload fingerprint: hash of the request body (minus versioning fields).
  // If the same operationId arrives with a DIFFERENT payload, it's not a
  // retry — it's a collision or bug. The server rejects it with 409 rather
  // than returning the wrong cached result.
  const payloadForHash = { ...body };
  delete payloadForHash.expectedVersion;
  delete payloadForHash.operationId;
  const payloadHash = operationId
    ? crypto.createHash('sha256').update(JSON.stringify(payloadForHash)).digest('hex').slice(0, 16)
    : undefined;
  // Idempotency scoping: the operation type (label), HTTP method, and target
  // (derived from the request path) are stored on the idempotency record so
  // the same operationId can never return another action's cached result.
  const opTarget = req.params && (req.params as any).id
    ? `${req.path.split('/')[2] || 'unknown'}:${(req.params as any).id}`
    : undefined;

  return { expectedVersion, operationId, idempotencyKey, authUserId, payloadHash, opTarget };
}

/**
 * Item 7: answer a retry of an operation that ALREADY committed, before the
 * route's own checks run against today's (possibly changed) data. Returns
 * true after sending the stored result (or a 409 for the same operationId
 * with a different payload); false when no live receipt matches — the route
 * then runs its normal first-attempt checks. Writes nothing: on a miss the
 * probe's mutator refuses, inside the same transaction that read the receipts.
 */
async function replayCommittedOperation(req: any, res: any, label: string): Promise<boolean> {
  const scope = idempotencyScopeFor(req);
  if (!scope.operationId || !scope.idempotencyKey) return false;
  try {
    await commitState(() => ({ conflict: 'receipt-probe' }), {
      label, operationId: scope.operationId, idempotencyKey: scope.idempotencyKey,
      idempotencyUserId: scope.authUserId, payloadHash: scope.payloadHash,
      opType: label, opMethod: req.method, opTarget: scope.opTarget,
    });
  } catch (err: any) {
    if (err instanceof DuplicateOperationError) {
      res.json(err.cachedResult.result);
      return true;
    }
    if (err instanceof PayloadMismatchError) {
      res.status(409).json({ error: err.message, code: 'PAYLOAD_MISMATCH' });
      return true;
    }
  }
  return false;
}

/**
 * Helper for Express handlers: runs commitState and maps errors to HTTP
 * responses. Returns the commit result on success, or sends the error
 * response and returns null.
 *
 * Usage:
 *   const committed = await commitOrRespond(req, res, mutator, { label: 'create-task' });
 *   if (!committed) return; // response already sent
 *   broadcast(...); // only after commit
 *   res.status(201).json(committed.result);
 */
async function commitOrRespond(
  req: any,
  res: any,
  mutator: (freshDoc: any, currentVersion: number) => MutatorOutcome,
  options: Omit<CommitOptions, 'expectedVersion' | 'operationId'> = {}
): Promise<CommitResult | null> {
  const { expectedVersion, operationId, idempotencyKey, authUserId, payloadHash, opTarget } = idempotencyScopeFor(req);

  // Version contract: updates to existing data MUST carry the version the
  // client rendered. A client that sends no version is too old (cached PWA)
  // or never loaded state — reject safely instead of risking a stale
  // overwrite. 428 tells the client to refresh (keeping the user's draft).
  // Thrown INSIDE the try so it maps to a 428 response, not a 500.
  try {
    if (options.requireVersion && expectedVersion === undefined) {
      throw new StaleClientError();
    }
    return await commitState(mutator, { ...options, expectedVersion, operationId, idempotencyKey, idempotencyUserId: authUserId, payloadHash, opType: options.label, opMethod: req.method, opTarget });
  } catch (err: any) {
    // All error paths send the HTTP response and return null, so the caller's
    // `if (!committed) return;` guard works. (Returning the Express Response
    // object here would be truthy and break that guard.)
    if (err instanceof DuplicateOperationError) {
      // Idempotent retry: the original result was already broadcast when it
      // first committed. Return it directly without re-broadcasting.
      res.json(err.cachedResult.result);
      return null;
    }
    if (err instanceof PayloadMismatchError) {
      res.status(409).json({ error: err.message, code: 'PAYLOAD_MISMATCH' });
      return null;
    }
    if (err instanceof StagedRevisionError) {
      res.status(503).json({ error: err.message, code: 'NOT_YET_LIVE' });
      return null;
    }
    if (err instanceof StaleClientError) {
      // 428 Precondition Required: the client must refresh and resend with
      // the version it rendered. Never accept a version-less update.
      res.status(428).json({ error: err.message, code: 'STALE_CLIENT' });
      return null;
    }
    if (err instanceof VersionConflictError) {
      res.status(409).json({
        error: 'Conflict: the data changed since you loaded it. Please refresh and try again.',
        code: 'VERSION_CONFLICT',
        currentVersion: err.currentVersion,
      });
      return null;
    }
    if (err instanceof OperationConflictError) {
      res.status(err.status || 409).json({ error: err.message, code: err.code || 'OPERATION_CONFLICT' });
      return null;
    }
    if (err instanceof RateLimitError) {
      res.setHeader('Retry-After', String(err.retryAfterSec));
      res.status(429).json({ error: err.message, code: 'RATE_LIMITED' });
      return null;
    }
    if (err instanceof DocumentTooLargeError) {
      log.error(`[commitOrRespond:${options.label || 'unnamed'}] ${err.message}`);
      res.status(503).json({ error: err.message, code: 'SIZE_LIMIT' });
      return null;
    }
    if (err instanceof FirestoreUnavailableError) {
      log.error(`[commitOrRespond:${options.label || 'unnamed'}] ${err.message}`);
      res.status(503).json({
        error: 'Could not save — the database is unreachable. Your changes were NOT saved. Please try again.',
        code: 'SAVE_FAILED',
      });
      return null;
    }
    log.error(`[commitOrRespond:${options.label || 'unnamed'}] Unexpected error:`, err);
    res.status(500).json({ error: 'Save failed. Your changes were NOT saved. Please try again.', code: 'SAVE_FAILED' });
    return null;
  }
}

// ---------------------------------------------------------------------------
// End of Stage 2 transactional infrastructure.
// ---------------------------------------------------------------------------

// ============================================================================
// Stage 2 generic CRUD helpers for simple top-level array entities.
// These wrap commitOrRespond for the common create/update/delete patterns so
// each handler stays small while keeping transactional guarantees.
// ============================================================================

interface CrudHelperOptions {
  label: string;
  broadcastType?: string;
  getAgencyId?: (item: any) => string;
  getBroadcastPayload?: (item: any, result: any) => any;
  /** 5b: shape the HTTP response (default: the updated item as stored). */
  getResponse?: (item: any) => any;
  /**
   * Updates/deletes of existing entities require the client to send the
   * version it rendered (expectedVersion). Always true for these helpers —
   * they only ever mutate existing entities.
   */
  requireVersion?: boolean;
}

/**
 * Generic "create item in array" handler helper.
 * - buildItem(freshDoc): returns the new item (ID must be pre-generated by caller).
 * - checkDuplicate(freshDoc): returns conflict message if the item already exists, else null.
 */
async function crudCreate(
  req: any,
  res: any,
  arrayKey: string,
  buildItem: () => any,
  opts: CrudHelperOptions & {
    checkDuplicate?: (freshDoc: any, item: any) => string | null;
    statusCode?: number;
  }
): Promise<boolean> {
  const item = buildItem();
  const committed = await commitOrRespond(
    req,
    res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc[arrayKey]) ? freshDoc[arrayKey] : [];
      if (opts.checkDuplicate) {
        const dupMsg = opts.checkDuplicate(freshDoc, item);
        if (dupMsg) return { conflict: dupMsg };
      }
      // Idempotency: same ID already present → return existing.
      const existing = arr.find((x) => x && x.id === item.id);
      if (existing) return { doc: freshDoc, result: existing };
      return { doc: { ...freshDoc, [arrayKey]: [...arr, item] }, result: item };
    },
    { label: opts.label }
  );
  if (!committed) return false;
  const created = committed.result;
  if (opts.broadcastType) {
    const payload = opts.getBroadcastPayload ? opts.getBroadcastPayload(created, committed.result) : created;
    const agencyId = opts.getAgencyId ? opts.getAgencyId(created) : undefined;
    broadcast(opts.broadcastType, payload, undefined, agencyId);
  }
  res.status(opts.statusCode || 201).json(created);
  return true;
}

/**
 * Generic "update item in array by ID" helper.
 * - applyUpdate(freshItem, freshDoc): returns updated item, or { conflict: msg }.
 */
async function crudUpdate(
  req: any,
  res: any,
  arrayKey: string,
  id: string,
  applyUpdate: (freshItem: any, freshDoc: any) => any | { conflict: string },
  opts: CrudHelperOptions
): Promise<boolean> {
  const committed = await commitOrRespond(
    req,
    res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc[arrayKey]) ? freshDoc[arrayKey] : [];
      const freshItem = arr.find((x) => x && x.id === id);
      if (!freshItem) return { conflict: `${arrayKey} item not found (it may have been deleted).` };
      const outcome = applyUpdate(freshItem, freshDoc);
      if (outcome && typeof outcome === 'object' && 'conflict' in outcome) {
        return { conflict: (outcome as any).conflict };
      }
      const newArr = arr.map((x) => (x && x.id === id ? outcome : x));
      return { doc: { ...freshDoc, [arrayKey]: newArr }, result: outcome };
    },
    { label: opts.label, requireVersion: true }
  );
  if (!committed) return false;
  const updated = committed.result;
  if (opts.broadcastType) {
    const payload = opts.getBroadcastPayload ? opts.getBroadcastPayload(updated, committed.result) : updated;
    const agencyId = opts.getAgencyId ? opts.getAgencyId(updated) : undefined;
    broadcast(opts.broadcastType, payload, undefined, agencyId);
  }
  res.json(opts.getResponse ? opts.getResponse(updated) : updated);
  return true;
}

/**
 * Generic "delete item from array by ID" helper (idempotent).
 */
async function crudDelete(
  req: any,
  res: any,
  arrayKey: string,
  id: string,
  opts: CrudHelperOptions & { getDeletePayload?: (deleted: any) => any }
): Promise<boolean> {
  const committed = await commitOrRespond(
    req,
    res,
    (freshDoc) => {
      const freshArr: any[] = Array.isArray(freshDoc[arrayKey]) ? freshDoc[arrayKey] : [];
      const found = freshArr.find((x) => x && x.id === id);
      if (!found) return { doc: freshDoc, result: { success: true, deletedId: id, alreadyDeleted: true } };
      const newArr = freshArr.filter((x) => !(x && x.id === id));
      return { doc: { ...freshDoc, [arrayKey]: newArr }, result: { success: true, deletedId: id, deleted: found } };
    },
    { label: opts.label, requireVersion: true }
  );
  if (!committed) return false;
  const result: any = committed.result;
  if (opts.broadcastType) {
    const payload = opts.getDeletePayload && result.deleted
      ? opts.getDeletePayload(result.deleted)
      : { id, deletedId: id };
    const agencyId = opts.getAgencyId && result.deleted ? opts.getAgencyId(result.deleted) : undefined;
    broadcast(opts.broadcastType, payload, undefined, agencyId);
  }
  res.json({ success: true, deletedId: id });
  return true;
}

// ============================================================================
// End of Stage 2 CRUD helpers.
// ============================================================================

/** Backfill sortOrder for tasks that predate the manual-order feature,
 *  per venue, ordered by target time then creation. Idempotent.
 *  MUST run after the Firestore load (see startServer) — the async hydrate
 *  overwrites in-memory tasks, so a module-level call gets wiped. */
function taskSortMinutes(t: { targetTime?: string; targetTimeMinutes?: number }): number {
  // Explicit picker value wins; fall back to parsing the free-text time.
  if (typeof t.targetTimeMinutes === 'number') return t.targetTimeMinutes;
  return targetTimeMinutes(t.targetTime);
}

/**
 * Backfill sortOrder for tasks that predate the manual-order feature.
 * Pure: takes a task array, returns { tasks, changed }. The boot call site
 * runs it inside the transactional write path on fresh Firestore data.
 */
function normalizeTaskOrderPure(input: any[]): { tasks: any[]; changed: boolean } {
  let changed = false;
  // Work on copies so the input is never mutated.
  const working = input.map((t) => ({ ...t }));
  const byId = new Map(working.map((t) => [t.id, t]));
  const venueIds = [...new Set(working.map((t) => t.venueId))];
  for (const vid of venueIds) {
    const group = working
      .filter((t) => t.venueId === vid)
      .sort(
        (a, b) =>
          taskSortMinutes(a) - taskSortMinutes(b) ||
          String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      );
    if (group.some((t) => t.sortOrder === undefined)) {
      group.forEach((t, i) => {
        byId.get(t.id)!.sortOrder = i;
      });
      changed = true;
    }
  }
  return { tasks: working, changed };
}

/** Legacy wrapper: normalize the in-memory cache (boot-time only). */
function normalizeTaskOrder(): boolean {
  const { tasks: normalized, changed } = normalizeTaskOrderPure(tasks);
  if (changed) tasks = normalized;
  return changed;
}

loadState();

/** Ensure VAPID keys exist: env vars win, else persisted, else generate once. */
function ensureVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidKeys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  } else if (!vapidKeys) {
    const generated = webpush.generateVAPIDKeys();
    vapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    console.log('[Push] Generated VAPID keys (persisted with app state).');
    commitState(
      (freshDoc) => ({ doc: { ...freshDoc, vapidKeys }, result: null }),
      { label: 'persist-vapid-keys' }
    ).catch((err) => log.warn('[Push] VAPID key persist failed:', (err as any)?.message));
  }
  webpush.setVapidDetails(
    'mailto:kenan@hartfordkashrut.org',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}

/** TEST ONLY (item 8t): every push target attempted, recorded BEFORE any
 * network send. Only written when isTestMode() (never on Cloud Run). */
const testPushLog: Array<{ path: string; recipientUserId: string | null; email: string; endpoint: string; title: string }> = [];

/** Send a push notification to every device a user subscribed. Fire-and-forget. */
function sendPushToUser(userEmail: string, title: string, body: string, data?: any, onError?: (err: any) => void) {
  const email = userEmail.trim().toLowerCase();
  const subs = pushSubscriptions.filter((s) => s.userEmail.toLowerCase() === email);
  deliverPush(subs, 'email', null, title, body, data, onError);
}

/**
 * Item 8t: identity-bound delivery. Only subscriptions carrying the
 * recipient's verified userId AND agency receive it. Legacy records (no
 * userId) are NOT used here — they cannot be attributed to a current identity
 * (ChatGPT 8t v2 must-fix); those devices get these pushes again after the
 * user re-subscribes through the normal toggle.
 */
function sendPushToRecipient(user: any, title: string, body: string, data?: any, onError?: (err: any) => void) {
  if (!user || !user.id) return;
  const agencyId = normalizeStoredUser(user).agencyId || 'agency-hkc';
  const subs = pushSubscriptions.filter((s) => s.userId === user.id && s.agencyId === agencyId);
  deliverPush(subs, 'identity', user.id, title, body, data, onError);
}

function deliverPush(
  subs: PushSubscriptionRecord[],
  path: string,
  recipientUserId: string | null,
  title: string,
  body: string,
  data?: any,
  onError?: (err: any) => void
) {
  if (isTestMode()) {
    for (const sub of subs) {
      testPushLog.push({ path, recipientUserId, email: sub.userEmail, endpoint: sub.endpoint, title });
    }
    if (testPushLog.length > 5000) testPushLog.splice(0, testPushLog.length - 5000);
  }
  if (!vapidKeys) return;
  for (const sub of subs) {
    const payload = JSON.stringify({ title, body, data: data || {} });
    webpush
      .sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys } as any,
        payload
      )
      .catch((err: any) => {
        // 410/404 = subscription is gone; drop it instead of retrying forever
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          const deadEndpoint = sub.endpoint;
          commitState(
            (freshDoc) => {
              const arr: any[] = Array.isArray(freshDoc.pushSubscriptions) ? freshDoc.pushSubscriptions : [];
              return {
                doc: { ...freshDoc, pushSubscriptions: arr.filter((s) => s.endpoint !== deadEndpoint) },
                result: null,
              };
            },
            { label: 'prune-dead-push-subscription' }
          ).catch((e) => log.warn('[Push] Dead-subscription prune failed:', (e as any)?.message));
        } else if (onError) {
          onError(err);
        } else {
          log.warn('[Push] Send failed:', err?.message || err);
        }
      });
  }
}

// Media retention: photos and voice notes auto-expire after 30 days
// (keeps the text record, drops the base64 to save Firestore space/cost)
const MEDIA_RETENTION_DAYS = 30;
function cleanupExpiredMedia() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MEDIA_RETENTION_DAYS);
  const cutoffIso = cutoff.toISOString();
  let cleaned = 0;

  // Check-in photos
  for (const task of tasks) {
    if (!task.checkIns) continue;
    for (const checkIn of task.checkIns) {
      if (checkIn.photoData && checkIn.at < cutoffIso) {
        checkIn.photoData = undefined;
        cleaned++;
      }
    }
  }

  // Handoff note voice notes
  for (const note of handoffNotes) {
    if ((note as any).voiceNoteData && note.createdAt < cutoffIso) {
      (note as any).voiceNoteData = undefined;
      cleaned++;
    }
  }

  // Incident media
  for (const incident of incidents) {
    if (incident.photoData && incident.createdAt < cutoffIso) {
      incident.photoData = undefined;
      cleaned++;
    }
    if (incident.voiceNoteData && incident.createdAt < cutoffIso) {
      incident.voiceNoteData = undefined;
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[MediaCleanup] Removed ${cleaned} expired media items`);
    // Persist via the transactional write path. The mutator re-applies the
    // expiry scan to FRESH data (idempotent — already-cleaned items are skipped).
    commitState(
      (freshDoc) => {
        const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
        const freshNotes: any[] = Array.isArray(freshDoc.handoffNotes) ? freshDoc.handoffNotes : [];
        const freshIncidents: any[] = Array.isArray(freshDoc.incidents) ? freshDoc.incidents : [];
        const stripMedia = (arr: any[], getDate: (x: any) => string, fields: string[]) =>
          arr.map((x) => {
            let changed = false;
            const copy = { ...x };
            for (const f of fields) {
              if ((copy as any)[f] && getDate(x) < cutoffIso) {
                (copy as any)[f] = undefined;
                changed = true;
              }
            }
            return changed ? copy : x;
          });
        const newTasks = freshTasks.map((t) => {
          const checkIns = Array.isArray(t.checkIns) ? t.checkIns : [];
          const newCheckIns = checkIns.map((c: any) =>
            c.photoData && c.at < cutoffIso ? { ...c, photoData: undefined } : c
          );
          return newCheckIns.some((c: any, i: number) => c !== checkIns[i]) ? { ...t, checkIns: newCheckIns } : t;
        });
        return {
          doc: {
            ...freshDoc,
            tasks: newTasks,
            handoffNotes: stripMedia(freshNotes, (n) => n.createdAt, ['voiceNoteData']),
            incidents: stripMedia(freshIncidents, (i) => i.createdAt, ['photoData', 'voiceNoteData']),
          },
          result: null,
        };
      },
      { label: 'media-cleanup' }
    ).catch((err) => log.warn('[MediaCleanup] Persist failed:', (err as any)?.message));
  }
}

// Run media cleanup daily (skipped in maintenance mode / FORCE_LOCAL_MODE — it's a write;
// never on a staged revision either — staged revisions must not write at all)
setInterval(() => {
  if (process.env.MAINTENANCE_MODE === 'true' || process.env.FORCE_LOCAL_MODE === 'true' || isStagedRevision()) return;
  cleanupExpiredMedia();
}, 24 * 60 * 60 * 1000);
// Run once at startup (delayed to avoid slowing boot)
setTimeout(() => {
  if (process.env.MAINTENANCE_MODE === 'true' || process.env.FORCE_LOCAL_MODE === 'true' || isStagedRevision()) return;
  cleanupExpiredMedia();
}, 60000);

// Check for overdue tasks and notify assigned users (runs every 15 min)
// Tracks already-notified tasks to avoid spam.
// Item 6: "now" and "today" are the TASK'S VENUE's local time (its zone), not
// the server's UTC clock. Dedupe key = `${taskId}:${venue-local date}`, kept
// for 36 h and only removed when expired, so venues on different dates (New
// York still on the 20th, Jerusalem already on the 21st) never clear each
// other's keys, and the repeated 1 AM hour on a fall-back day is the same
// local date (no repeat). The map is in memory: exactly-once across restarts
// or several server instances is NOT claimed (pre-existing limitation).
const OVERDUE_KEY_RETENTION_MS = 36 * 60 * 60 * 1000;
const overdueNotified = new Map<string, number>();
/**
 * Item 8t: who may receive a push about a task. Only users of the TASK'S
 * agency (task.agencyId, else its venue's agency, else 'agency-hkc'), who
 * may see the task under the existing server rule (canSeeTaskServer: rule-T
 * venue scope + private-task rule), and who are named by it:
 *  - assignedTo includes 'all' (or is empty): the agency's users at the
 *    task's venue + the agency's admins (unless explicitOnly);
 *  - explicit emails: only those resolving to such a user.
 * Unknown / other-agency / invisible emails are silently omitted; the task's
 * stored assignedTo is never rewritten. De-duplicated by user id.
 */
function taskPushRecipients(task: any, usersList: any[], venuesList: any[], opts: { explicitOnly?: boolean } = {}): any[] {
  if (!task) return [];
  const venue = (venuesList || []).find((v: any) => v && v.id === task.venueId);
  const taskAgency = task.agencyId || venue?.agencyId || 'agency-hkc';
  const assigned: string[] = Array.isArray(task.assignedTo) && task.assignedTo.length > 0 ? task.assignedTo : ['all'];
  const toAll = assigned.some((a) => typeof a === 'string' && a.toLowerCase() === 'all') && !opts.explicitOnly;
  const explicit = new Set(
    assigned.filter((a) => typeof a === 'string' && a.toLowerCase() !== 'all').map((a) => a.trim().toLowerCase())
  );
  const out: any[] = [];
  const seen = new Set<string>();
  for (const raw of usersList || []) {
    if (!raw || !raw.id || typeof raw.email !== 'string' || seen.has(raw.id)) continue;
    const u = normalizeStoredUser(raw);
    if ((u.agencyId || 'agency-hkc') !== taskAgency) continue;
    if (!canSeeTaskServer(task, u as any)) continue;
    const named = explicit.has(raw.email.trim().toLowerCase());
    const inAll = toAll && (u.role === 'admin' || personAtVenue(raw, task.venueId));
    if (!named && !inAll) continue;
    seen.add(raw.id);
    out.push(u);
  }
  return out;
}

function checkOverdueTasks(now: Date = serverNow()): string[] {
  const nowMs = now.getTime();
  const sentKeys: string[] = [];
  for (const [key, expiresAt] of overdueNotified) {
    if (expiresAt <= nowMs) overdueNotified.delete(key);
  }

  for (const task of tasks) {
    if (task.isCompleted) continue;
    // 6c: no target time can become overdue.
    if (isAnyTimeTask(task)) continue;
    if (!task.enableOverdueAlert) continue; // Only alert for tasks with alerts enabled
    if (!task.targetTime || task.targetTime === 'End of Day') continue;

    const venue = venues.find((v) => v.id === task.venueId);
    const tz = venueTimeZoneIn(venue || { agencyId: task.agencyId }, agencies);
    const nowMinutes = minutesIn(tz, now);
    const today = workDateIn(tz, now);

    const taskMinutes = taskSortMinutes(task);
    if (taskMinutes >= nowMinutes) continue; // Not overdue yet

    const notifyKey = `${task.id}:${today}`;
    if (overdueNotified.has(notifyKey)) continue; // Already notified today (venue-local)
    overdueNotified.set(notifyKey, nowMs + OVERDUE_KEY_RETENTION_MS);
    sentKeys.push(notifyKey);

    const venueName = venue?.name || 'your venue';

    // Item 8t: recipients are resolved inside the TASK'S agency and must be
    // able to see the task (canSeeTaskServer); delivery is identity-bound.
    // ('all' = the agency's users at the venue + the agency's admins.)
    for (const recipient of taskPushRecipients(task, users, venues)) {
      sendPushToRecipient(
        recipient,
        `Overdue: ${task.title}`,
        `${venueName} — was due at ${task.targetTime}`,
        { taskId: task.id, venueId: task.venueId, type: 'overdue' }
      );
    }
  }
  return sentKeys;
}

// Run overdue check every 15 minutes (skipped in maintenance mode /
// FORCE_LOCAL_MODE; never on a staged revision — staged revisions must not write at all)
setInterval(() => {
  if (process.env.MAINTENANCE_MODE === 'true' || process.env.FORCE_LOCAL_MODE === 'true' || isStagedRevision()) return;
  checkOverdueTasks();
}, 15 * 60 * 1000);

// ---- Web Push endpoints ----
app.get('/api/push/public-key', (_req, res) => {
  if (!vapidKeys) return res.status(503).json({ error: 'Push not initialized' });
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { subscription } = req.body as any;
  if (!subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'subscription required' });
  }
  // Subscription ownership is keyed by the VERIFIED session user, never a
  // client-supplied email.
  const email = caller.email.trim().toLowerCase();
  // Item 8t: bind the subscription to the verified identity (id + agency),
  // so identity-bound pushes never reach a device by email alone.
  const subUserId = caller.id;
  const subAgencyId = normalizeStoredUser(caller).agencyId || 'agency-hkc';
  const createdAt = new Date().toISOString();
  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.pushSubscriptions) ? freshDoc.pushSubscriptions : [];
      // Upsert by endpoint against FRESH data.
      const newArr = [
        ...arr.filter((s) => s.endpoint !== subscription.endpoint),
        { userEmail: email, userId: subUserId, agencyId: subAgencyId, endpoint: subscription.endpoint, keys: subscription.keys, createdAt },
      ];
      return { doc: { ...freshDoc, pushSubscriptions: newArr }, result: { success: true } };
    },
    { label: 'push-subscribe' }
  );
  if (!committed) return;
  res.json({ success: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { endpoint } = req.body as any;
  // Only the caller's own subscription for that endpoint can be removed —
  // identity comes from the VERIFIED session user, never the request body.
  const callerEmail = caller.email.trim().toLowerCase();
  if (endpoint) {
    const committed = await commitOrRespond(
      req, res,
      (freshDoc) => {
        const arr: any[] = Array.isArray(freshDoc.pushSubscriptions) ? freshDoc.pushSubscriptions : [];
        return {
          doc: {
            ...freshDoc,
            pushSubscriptions: arr.filter(
              (s) => s.endpoint !== endpoint || (callerEmail && s.userEmail !== callerEmail)
            ),
          },
          result: { success: true },
        };
      },
      { label: 'push-unsubscribe' }
    );
    if (!committed) return;
  }
  res.json({ success: true });
});

// WebSocket Setup
const wss = new WebSocketServer({ server, path: '/ws' });
type SocketMeta = {
  userId: string; email: string; name: string; agencyId: string; role?: string; kiosk?: boolean; kioskVenueId?: string; kioskAgencyId?: string; kioskPv?: string; kioskDeviceId?: string;
  /** SO: the socket's own verified token claims (server-only, never sent).
   * Re-resolved on every delivery for phone sockets, so a bumped tokenEpoch
   * or a deleted row stops data even if a path forgets to close the socket. */
  tokenClaims?: SessionClaims;
};
const activeSockets = new Map<WebSocket, SocketMeta>();

/**
 * Kiosk socket allowlist (one helper for broadcasts AND INITIAL_STATE).
 * A kiosk socket receives ONLY:
 * - TASK_CREATED/TASK_UPDATED/TASK_DELETED when the task's venueId ===
 *   the kiosk venue; TASKS_UPDATED ({ venueId }) when it matches
 * - HANDOFF_NOTE when note.venueId matches
 * - ANNOUNCEMENT (agency-scoped; the REST allowlist includes it)
 * - USER_PRESENCE (counts only)
 * - USERS_UPDATED as the venue roster (names/roles/avatars, no emails)
 * - DAILY_RESET/DEMO_RESTORED with tasks/historyLogs/
 *   snapshots filtered to the kiosk venue (so the board isn't stale)
 * Everything else is dropped (the REST allowlist denies it too).
 */
function kioskMaySee(meta: SocketMeta, type: string, payload: any): boolean {
  const venueId = meta.kioskVenueId;
  if (!venueId) return false;
  switch (type) {
    case 'TASK_CREATED':
    case 'TASK_UPDATED':
    case 'TASK_DELETED': {
      const task = payload?.task || payload;
      return task?.venueId === venueId;
    }
    case 'TASKS_UPDATED': {
      // Broadcast as { venueId } — pass through only for the kiosk venue.
      return payload?.venueId === venueId;
    }
    case 'HANDOFF_NOTE': {
      const note = payload?.note || payload;
      return note?.venueId === venueId;
    }
    case 'HANDOFF_NOTE_DELETED':
      // 5a: a deleted note must leave the tablet too (venueId rides the payload).
      return payload?.venueId === venueId;
    case 'ANNOUNCEMENT': {
      // 5a / RULE T: one rule for REST and WS — the tablet's venue + the
      // logged-in user's role targeting, whatever that role is.
      const ann = payload?.announcement || payload;
      return announcementVisibleTo(recipientForMeta(meta), ann, venueId);
    }
    case 'ANNOUNCEMENT_DELETED': {
      // Same audience as the item itself: tablet venue + the signed-in role.
      const m = deletedAnnouncementMeta.get(payload?.id);
      return !!m && announcementVisibleTo(recipientForMeta(meta), m, venueId);
    }
    case 'USER_PRESENCE':
      return true;
    case 'USERS_UPDATED':
    case 'DAILY_RESET':
    case 'DEMO_RESTORED':
    case 'HISTORY_PRUNED': // 8r: history list only, venue-filtered below
      // Allowed; the payload is venue-filtered by kioskFilterPayload below.
      return true;
    default:
      return false;
  }
}

/**
 * K1 — the INITIAL_STATE payload for ONE socket, built from its verified
 * effective identity (recipientForMeta: an admin on a kiosk is a mashgiach
 * at the tablet's venue; a kiosk meta that no longer re-validates → null).
 * Kiosk sockets get the per-type allowlist: their venue's tasks/history, the
 * venue roster (no emails/phones), the single venue — nothing else. Used by
 * the WS handshake and by every manual INITIAL_STATE send (rule N), so no
 * user-scoped snapshot is ever reused across sockets of different modes.
 */
function initialStateForSocket(meta: SocketMeta | undefined): any | null {
  if (!meta) return null;
  const recipient = recipientForMeta(meta);
  if (!recipient) return null;
  const baseState = agencyStateFor(meta.agencyId, recipient);
  if (!meta.kiosk) return baseState;
  const kioskVenueId = meta.kioskVenueId;
  if (!kioskVenueId) return null;
  // D3c (ChatGPT's #46 review): an explicit key allowlist, never a spread of
  // the agency state — a key added to agencyStateFor later cannot reach a
  // tablet unless it is listed here. Same keys as before (no client change).
  return {
    tasks: (baseState.tasks || []).filter((t: any) => t.venueId === kioskVenueId),
    historyLogs: (baseState.historyLogs || []).filter((h: any) => h.venueId === kioskVenueId),
    venues: (baseState.venues || []).filter((v: any) => v.id === kioskVenueId),
    users: (baseState.users || [])
      .filter((u: any) => u && (u.venueId === kioskVenueId || personAtVenue(u, kioskVenueId)))
      .map((u: any) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor, role: u.role })),
    events: [],
    airtableConfigs: [],
    approvedIngredients: [],
    factoryReports: [],
    currentWorkDate: baseState.currentWorkDate,
  };
}

/**
 * Venue-filter a broadcast payload for a kiosk socket. Runs on the
 * varyByRecipient OUTPUT (the base payload may be just { agencyId } — the
 * user/venue lists are produced by the transform). Returns the filtered
 * payload, or null to drop the message.
 */
function kioskFilterPayload(meta: SocketMeta, type: string, payload: any): any {
  const venueId = meta.kioskVenueId;
  if (!venueId) return null;
  const p = payload || {};
  const roster = (users: any[]) =>
    (users || [])
      .filter((u: any) => u && (u.venueId === venueId || personAtVenue(u, venueId)))
      .map((u: any) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor, role: u.role }));
  switch (type) {
    case 'USERS_UPDATED':
      return { ...p, users: roster(p.users) };
    case 'HISTORY_PRUNED':
      // 8r: an explicit key allowlist — the tablet's venue history only.
      return { historyLogs: (p.historyLogs || []).filter((h: any) => h?.venueId === venueId) };
    case 'DAILY_RESET':
    case 'DEMO_RESTORED':
      return {
        ...p,
        tasks: (p.tasks || []).filter((t: any) => t?.venueId === venueId),
        historyLogs: (p.historyLogs || []).filter((h: any) => h?.venueId === venueId),
        snapshots: (p.snapshots || []).filter((s: any) => s?.venueId === venueId),
        venues: (p.venues || []).filter((v: any) => v?.id === venueId),
        events: [],
        users: p.users ? roster(p.users) : p.users,
      };
    default:
      return payload;
  }
}

/**
 * RULE T — staff venue filter for WebSocket broadcasts (the kiosk filter's
 * generalization to every NON-admin, non-kiosk socket). Applied to the OUTPUT
 * of varyByRecipient (as the kiosk filter is), so per-recipient transforms
 * (rosters, private-task filtering) run first.
 *
 * Explicit type classification (keep in sync with the kiosk allowlist above):
 * - PASS (no venue data): USER_PRESENCE, EVENT_TEMPLATES_UPDATED,
 *   INITIAL_STATE (built scoped by agencyStateFor). AGENCY_UPDATED and
 *   AGENCY_REGISTERED pass with the agency reduced to its public profile
 *   (name, shortCode, certificationSeal, region, contactPhone, customDomain,
 *   timeZone)
 *   for non-admin sockets — the full object also carries adminEmail.
 * - VENUE-FILTERED: TASK_CREATED/UPDATED/DELETED (by task venueId; since
 *   fix round 1, delete payloads for tasks/events/handoff notes carry their
 *   venueId and a venue-LESS delete drops — fail closed),
 *   TASKS_UPDATED ({ venueId }),
 *   HANDOFF_NOTE (note.venueId), HANDOFF_NOTE_DELETED (venueId in payload),
 *   INCIDENT_CREATED/UPDATED (incident.venueId), ANNOUNCEMENT (absent venueId
 *   = agency-wide, passes), ANNOUNCEMENT_DELETED (absent venueId = agency-wide, passes),
 *   EVENT_CREATED/UPDATED/DELETED (event venueId), INGREDIENT_VERIFIED and
 *   AUDIT_REPORT_SUBMITTED (payload venueId), VENUE_CREATED/UPDATED/DELETED
 *   (own venue only), DAILY_RESET/DEMO_RESTORED (arrays
 *   filtered to scope), USERS_UPDATED (scoped roster via getSafeUsersForAgency),
 *   INGREDIENTS_SYNCED (venueId if present).
 * - UNKNOWN type → drop + one warn log (fail closed).
 */
const staffWsUnknownWarned = new Set<string>();

function staffVenueFilterPayload(meta: SocketMeta, type: string, payload: any): any {
  const recipient = recipientForMeta(meta);
  if (!recipient) return null; // user gone/moved — fail closed
  if (recipient.role === 'admin') return payload;
  const scope = venueScopeFor(recipient) as string[];
  const inScope = (v: any) => typeof v === 'string' && scope.includes(v);
  const p = payload || {};
  switch (type) {
    case 'USER_PRESENCE':
    case 'EVENT_TEMPLATES_UPDATED':
    case 'INITIAL_STATE':
      return payload;
    case 'KIOSK_DEVICES_UPDATED':
      // Venue-targeted (C4): admins get everything (early return above);
      // a coordinator gets their own venue's device changes — nobody else.
      // The payload carries NO device records — { agencyId, venueId } only.
      return recipient.role === 'coordinator' && inScope(p.venueId) ? payload : null;
    case 'AGENCY_UPDATED':
    case 'AGENCY_REGISTERED': {
      // (fix round 1) These pass, but the payload is reduced to the agency's
      // PUBLIC profile for non-admin sockets. The full agency object also
      // carries adminEmail and createdAt, which are not public.
      // Item 8a: one explicit allowlist (agencyPublicProfile) — id, name,
      // shortCode, seal, region, phone, zone (item 6: decides "today" on
      // every client), slug, brand, logo. No adminEmail, createdAt or domain
      // field (customDomain was here before 8a; no client reads it).
      const pub = agencyPublicProfile(p.agency || {});
      const { adminEmail: _drop, ...rest } = p;
      return { ...rest, agency: pub };
    }
    case 'INGREDIENTS_SYNCED':
      return !p.venueId || inScope(p.venueId) ? payload : null;
    case 'TASK_CREATED':
    case 'TASK_UPDATED': {
      const task = p.task || p;
      return inScope(task?.venueId) ? payload : null;
    }
    case 'TASK_DELETED': {
      const vid = (p.task || p)?.venueId ?? p.venueId;
      if (!vid) return null; // fail closed: venue-less delete payloads drop
      return inScope(vid) ? payload : null;
    }
    case 'TASKS_UPDATED':
      return inScope(p.venueId) ? payload : null;
    case 'HANDOFF_NOTE': {
      const note = p.note || p;
      return inScope(note?.venueId) ? payload : null;
    }
    case 'HANDOFF_NOTE_DELETED':
      // Fail closed: a note delete without its venueId does not reach a
      // non-admin socket (the payload now carries venueId — see the handler).
      return inScope(p.venueId) ? payload : null;
    case 'ANNOUNCEMENT_DELETED': {
      // Same audience as the item itself (venue + role targeting + author).
      const m = deletedAnnouncementMeta.get(p.id);
      return m && announcementVisibleTo(recipient, m) ? payload : null;
    }
    case 'INCIDENT_CREATED':
    case 'INCIDENT_UPDATED': {
      // 5b: one rule with REST (incidentVisibleTo); the payload is a signal only.
      const inc = p.incident || p;
      return inScope(inc?.venueId) && incidentVisibleTo(recipient, inc) ? payload : null;
    }
    case 'ANNOUNCEMENT': {
      // 5a: venue scope AND role targeting (the same helper as GET /api/announcements).
      const ann = p.announcement || p;
      return announcementVisibleTo(recipient, ann) ? payload : null;
    }
    case 'EVENT_CREATED':
    case 'EVENT_UPDATED': {
      // Item 7: one rule — canSeeEventServer — built from the payload's
      // event/venueId/assignedMashgiachEmail. The assignee exception lets a
      // mashgiach assigned to another venue's event follow it live.
      const snapshot = {
        venueId: p.venueId ?? (p.event || {}).venueId,
        assignedMashgiachEmail: p.assignedMashgiachEmail ?? (p.event || {}).assignedMashgiachEmail,
      };
      return canSeeEventServer(snapshot, recipient) ? payload : null;
    }
    case 'EVENT_DELETED': {
      const vid = (p.event || p)?.venueId ?? p.venueId;
      if (!vid) return null; // fail closed: venue-less delete payloads drop
      if (inScope(vid)) return payload;
      // The event's assigned mashgiach (or the previous assignee after a
      // reassignment) must see the delete so their client drops the event —
      // same transition mechanism as private tasks.
      if (eventAssigneeIs(recipient, p.assignedMashgiachEmail) ||
          eventAssigneeIs(recipient, p.previousAssignee)) return payload;
      return null;
    }
    case 'INGREDIENT_VERIFIED':
    case 'AUDIT_REPORT_SUBMITTED':
      return inScope(p.venueId) || inScope((p.report || {})?.venueId) ? payload : null;
    case 'VENUE_CREATED':
    case 'VENUE_UPDATED': {
      const vid = (p.venue || p)?.id ?? p.venueId ?? p.id;
      return vid && inScope(vid) ? payload : null;
    }
    case 'VENUE_DELETED': {
      const vid = p.deletedVenueId ?? p.venueId ?? p.id;
      return vid && inScope(vid) ? payload : null;
    }
    case 'DAILY_RESET':
    case 'DEMO_RESTORED':
      return {
        ...p,
        tasks: (p.tasks || []).filter((t: any) => inScope(t?.venueId)),
        historyLogs: (p.historyLogs || []).filter((h: any) => inScope(h?.venueId)),
        snapshots: (p.snapshots || []).filter((sn: any) => inScope(sn?.venueId)),
        venues: (p.venues || []).filter((v: any) => inScope(v?.id)),
        events: (p.events || []).filter((e: any) => canSeeEventServer(e, recipient)),
      };
    case 'USERS_UPDATED':
      return Array.isArray(p.users)
        ? { ...p, users: getSafeUsersForAgency(meta.agencyId, recipient) }
        : payload;
    case 'HISTORY_PRUNED':
      // 8r: history list only, filtered to the recipient's venue scope.
      return { historyLogs: (p.historyLogs || []).filter((h: any) => inScope(h?.venueId)) };
    default:
      if (!staffWsUnknownWarned.has(type)) {
        staffWsUnknownWarned.add(type);
        console.warn(`[ws] dropping unknown broadcast type for non-admin socket: ${type}`);
      }
      return null;
  }
}

function agencyStateFor(agencyId: string, recipient?: UserProfile) {
  // RULE T: tasks/history/users are filtered by their own helpers (items 2–4).
  // Venues, events and the factory data below are additionally filtered to the
  // recipient's scope — admins pass through untouched, everyone else gets only
  // their own venue(s), and a venue-less non-admin gets none.
  const norm = (v?: string) => v || 'agency-hkc';
  const isAdmin = recipient?.role === 'admin';
  const scope = isAdmin ? 'agency' : venueScopeFor(recipient);
  const inScopeVenue = (venueId: any) =>
    scope === 'agency' || (typeof venueId === 'string' && scope.includes(venueId));
  const inScopeId = (id: any) =>
    scope === 'agency' || (typeof id === 'string' && scope.includes(id));
  return {
    venues: venues.filter((v) => norm(v.agencyId) === agencyId && inScopeId(v.id)),
    tasks: tasksForRecipient(agencyId, recipient),
    historyLogs: historyLogsForRecipient(agencyId, recipient),
    // Events use canSeeEventServer: venue scope PLUS the assigned-mashgiach
    // exception (item 7) so an assigned event at another venue survives in
    // the recipient's live state exactly as GET /api/events shows it.
    events: events.filter((e) => norm(e.agencyId) === agencyId && canSeeEventServer(e, recipient)),
    airtableConfigs: airtableConfigs.filter((c) => norm(c.agencyId) === agencyId && inScopeVenue(c.venueId)),
    approvedIngredients: approvedIngredients.filter((i) => norm(i.agencyId) === agencyId && inScopeVenue(i.venueId)),
    factoryReports: factoryReports.filter((r) => norm(r.agencyId) === agencyId && inScopeVenue(r.venueId)),
    users: getSafeUsersForAgency(agencyId, recipient),
    currentWorkDate,
    // D3c test 35: a test-mode-only probe key proving the kiosk allowlist
    // excludes keys it does not list (isTestMode() is false on Cloud Run).
    ...(isTestMode() ? { __stage2Probe: 'not-for-kiosk' } : {}),
  };
}

function broadcast(
  type: string,
  payload: any,
  senderEmail?: string,
  agencyId?: string,
  // Optional per-recipient payload transform (e.g. role-trimmed rosters).
  // Receives the socket's meta and the base payload; must return the payload
  // for THAT recipient. When omitted, every recipient gets the same payload.
  varyByRecipient?: (meta: SocketMeta, basePayload: any) => any
) {
  // The envelope carries the current document version so clients can keep
  // their last-known version fresh without polling (see src/lib/api.ts).
  // Broadcasts are sent only after the commit hydrated the cache, so
  // stateVersion is the version that produced this payload.
  const envelopeFor = (finalPayload: any) =>
    JSON.stringify({
      type,
      payload: finalPayload,
      timestamp: new Date().toISOString(),
      senderEmail,
      version: typeof stateVersion === 'number' ? stateVersion : undefined,
    });

  // Fast path: one message for every authorized recipient (serialized once).
  if (!varyByRecipient) {
    const message = envelopeFor(payload);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const meta = authorizeSocket(client);
      if (!meta) continue;
      // Agency-scoped broadcasts only reach that agency's sockets.
      if (agencyId && meta.agencyId !== agencyId) continue;
      // Kiosk sockets: per-type allowlist + venue-filtered payload.
      if (meta.kiosk) {
        if (!kioskMaySee(meta, type, payload)) continue;
        const filtered = kioskFilterPayload(meta, type, payload);
        if (filtered === null) continue;
        client.send(envelopeFor(filtered));
        continue;
      }
      // Staff sockets: RULE T venue filter (admins pass through untouched).
      const staffFiltered = staffVenueFilterPayload(meta, type, payload);
      if (staffFiltered === null) continue;
      if (staffFiltered === payload) {
        client.send(message);
      } else {
        client.send(envelopeFor(staffFiltered));
      }
    }
    return;
  }

  // Per-recipient path: the payload is computed for each authorized socket.
  // If the transform returns null/undefined, the socket is skipped (not sent)
  // — used when the recipient is not allowed to see the payload at all.
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const meta = authorizeSocket(client);
    if (!meta) continue;
    // Agency-scoped broadcasts only reach that agency's sockets.
    if (agencyId && meta.agencyId !== agencyId) continue;
    // Kiosk sockets: per-type allowlist (on the base payload), then the
    // per-recipient transform, then the venue filter on ITS output.
    if (meta.kiosk) {
      if (!kioskMaySee(meta, type, payload)) continue;
      const finalPayload = varyByRecipient(meta, payload);
      if (finalPayload === null || finalPayload === undefined) continue;
      const filtered = kioskFilterPayload(meta, type, finalPayload);
      if (filtered === null) continue;
      client.send(envelopeFor(filtered));
      continue;
    }
    const finalPayload = varyByRecipient(meta, payload);
    if (finalPayload === null || finalPayload === undefined) continue;
    // Staff sockets: RULE T venue filter on the transform's OUTPUT.
    const staffFiltered = staffVenueFilterPayload(meta, type, finalPayload);
    if (staffFiltered === null) continue;
    client.send(envelopeFor(staffFiltered));
  }
}

wss.on('connection', (ws, req) => {
  // Token via ?token=… query param (set by the client from its session).
  let authedUser: any = null;
  let socketClaims: SessionClaims | null = null;
  let kioskVenueId: string | undefined;
  let kioskAgencyId: string | undefined;
  let kioskPv: string | undefined;
  let kioskDeviceId: string | undefined;
  let isKiosk = false;
  try {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const payload = token ? verifyToken(token) : null;
    socketClaims = payload;
    // Item 8d: the same resolver as the HTTP middleware.
    authedUser = resolveSessionRow(payload, users as any[]) || null;
    isKiosk = payload?.kind === 'kiosk';
    if (payload && payload.kind === 'kiosk') {
      // Branch on the kiosk CLAIM, not on the presence of a venue id — a
      // kiosk token without agencyId, venueId, pv or dev fails closed
      // (never a phone session).
      kioskVenueId = payload.venueId;
      kioskAgencyId = payload.agencyId;
      kioskPv = payload.pv;
      kioskDeviceId = payload.dev;
      if (!kioskVenueId || !kioskAgencyId || !kioskPv || !kioskDeviceId) {
        ws.close(4401, 'Unauthorized');
        return;
      }
    }
  } catch {
    authedUser = null;
  }

  if (!authedUser) {
    ws.close(4401, 'Unauthorized');
    return;
  }
  // Kiosk token: re-validate the user AND the bound device (same revocation
  // rule as the middleware; pv is the PIN revision).
  if (isKiosk) {
    // K1: the same shared re-validation as the HTTP middleware.
    const stillValid = kioskSessionStillValid(authedUser, {
      agencyId: kioskAgencyId, venueId: kioskVenueId, pv: kioskPv, deviceId: kioskDeviceId,
    });
    if (!stillValid) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    // K1: from here on the socket's identity is the ACTING user (an admin on
    // a kiosk is a mashgiach at this tablet's venue): meta.role and the
    // INITIAL_STATE base below are built from it.
    authedUser = kioskActingUser(authedUser, kioskVenueId as string);
  }

  const agencyId = authedUser.agencyId || 'agency-hkc';

  // Addendum finding 1: a kiosk socket proves its device with its FIRST
  // frame — { type: 'KIOSK_DEVICE', credential: '<deviceId>.<secret>' } —
  // because a browser cannot set headers on a WebSocket and the secret must
  // never travel in the URL. Until that frame verifies, the server sends
  // NOTHING and the socket has NO activeSockets entry; a wrong frame, or
  // none within 5 s, closes 4401. Phone sockets expect no frame (and an
  // unexpected one is ignored — rule X: meta is never rebuilt from a
  // client message).
  let connected = false;
  let proofTimer: ReturnType<typeof setTimeout> | null = null;

  const finishConnect = () => {
    // SO: re-resolve this socket's own claims against the CURRENT users
    // immediately before registration, so a connection authenticated before
    // a revocation (epoch bump, deletion, kiosk PIN/device change) but
    // registered after it is closed and never registered.
    const current = resolveSessionRow(socketClaims, users as any[]);
    const stillOk = isKiosk
      ? !!current && kioskSessionStillValid(current, { agencyId: kioskAgencyId, venueId: kioskVenueId, pv: kioskPv, deviceId: kioskDeviceId })
      : !!current && current.id === authedUser.id;
    if (!stillOk) {
      try { ws.close(4401, 'Unauthorized'); } catch {}
      return;
    }
    connected = true;
    activeSockets.set(ws, {
      userId: authedUser.id, email: authedUser.email, name: authedUser.name,
      agencyId, role: authedUser.role,
      kiosk: isKiosk, kioskVenueId, kioskAgencyId, kioskPv, kioskDeviceId,
      tokenClaims: socketClaims || undefined,
    });

    // Initial state: ONLY this user's agency. Never the whole platform.
    // K1: one builder (initialStateForSocket) for the handshake AND every
    // later manual INITIAL_STATE send, from the socket's verified effective
    // identity; kiosk sockets get the tablet-venue allowlist.
    const kioskState = initialStateForSocket(activeSockets.get(ws) as SocketMeta);
    if (!kioskState) {
      try { ws.close(4401, 'Unauthorized'); } catch {}
      activeSockets.delete(ws);
      return;
    }
    ws.send(
      JSON.stringify({
        type: 'INITIAL_STATE',
        payload: {
          ...kioskState,
          activeWorkersCount: activeSockets.size,
        },
        timestamp: new Date().toISOString(),
        version: typeof stateVersion === 'number' ? stateVersion : undefined,
      })
    );

    broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);
  };

  if (isKiosk) {
    proofTimer = setTimeout(() => {
      try {
        ws.close(4401, 'Unauthorized');
      } catch {}
    }, 5000);
  } else {
    finishConnect();
  }

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (isKiosk && !connected) {
        // The FIRST frame on a kiosk socket must be the device proof:
        // the credential must resolve (hash compare) to the token's own
        // device, at the token's agency and venue.
        const proved = parsed?.type === 'KIOSK_DEVICE'
          ? verifyKioskDeviceCredential(parsed.credential, kioskDeviceId)
          : null;
        if (!proved || proved.agencyId !== kioskAgencyId || proved.venueId !== kioskVenueId) {
          if (proofTimer) clearTimeout(proofTimer);
          try {
            ws.close(4401, 'Unauthorized');
          } catch {}
          return;
        }
        if (proofTimer) clearTimeout(proofTimer);
        finishConnect();
        return;
      }
      if (parsed.type === 'KIOSK_DEVICE') {
        // Phone socket, or a repeat frame: ignored — never rebuild meta
        // from a client message (rule X).
        return;
      }
      if (parsed.type === 'USER_PRESENCE' && parsed.payload) {
        // Rule X: never rebuild security meta from a client message.
        // Presence changes nothing security-relevant — keep the meta as is.
        broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    if (proofTimer) clearTimeout(proofTimer);
    activeSockets.delete(ws);
    if (connected) {
      broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 6 — per-venue work days (time zones per agency/venue).
//
// Each venue runs on effectiveTimeZone(venue.timeZone, agency.timeZone):
// its own IANA zone, else its agency's, else America/New_York — never the
// server's UTC clock. doc.venueWorkDates[venueId] is the workday the venue
// was last rolled to; that marker is the ONLY thing that decides whether the
// venue's daily reset is due (today-in-its-zone > marker). The legacy NY
// doc.currentWorkDate is just the migration bridge: a venue with no marker
// yet runs on it, and the first committed reset or zone write materializes
// the marker from it (never reinterpreting a NY date as another zone's).
// ---------------------------------------------------------------------------

/** Keep only well-formed { venueId: "YYYY-MM-DD" } entries. */
function sanitizeVenueWorkDates(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k && isWorkDate(v)) out[k] = v as string;
  }
  return out;
}

/** The later of two "YYYY-MM-DD" dates (string order is date order). */
function laterWorkDate(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Whole calendar days from a to b ("YYYY-MM-DD"). */
function workDaysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/** The canonical IANA name the runtime reports for a valid zone. */
function canonicalTimeZone(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone || tz;
  } catch {
    return tz;
  }
}

/**
 * Parse a timeZone field from a request body. undefined = not being changed;
 * null or '' = clear (follow the agency / the default); a string must be a
 * known IANA zone (stored canonicalized). Returns { error } when invalid.
 */
function parseTimeZoneInput(raw: unknown): { value?: string | null; error?: string } {
  if (raw === undefined) return {};
  if (raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string') return { error: 'Unknown time zone.' };
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null };
  if (!isValidTimeZone(trimmed)) return { error: 'Unknown time zone.' };
  return { value: canonicalTimeZone(trimmed) };
}

/** A venue's effective zone, given the agencies list it belongs to. */
function venueTimeZoneIn(v: any, agencyList: any[]): string {
  const aid = v?.agencyId || 'agency-hkc';
  const agency = (agencyList || []).find((a: any) => a?.id === aid);
  return effectiveTimeZone(v?.timeZone, agency?.timeZone);
}

/**
 * Every venue's marker, with missing ones materialized from the legacy NY
 * date as it stands in `doc` (the date that venue has actually been running
 * on). A venue with neither falls back to its own today (never due).
 */
function materializedWorkDates(doc: any, venueList: any[], agencyList: any[], now: Date): Record<string, string> {
  const markers = sanitizeVenueWorkDates(doc?.venueWorkDates);
  const legacy = isWorkDate(doc?.currentWorkDate) ? (doc.currentWorkDate as string) : null;
  for (const v of venueList || []) {
    if (!v?.id || markers[v.id]) continue;
    markers[v.id] = legacy || workDateIn(venueTimeZoneIn(v, agencyList), now);
  }
  return markers;
}

/**
 * B3 — a zone change is a prospective boundary change: it never resets and
 * never moves a marker backwards. For each venue whose EFFECTIVE zone
 * changes, marker := max(marker, today in the new zone). Returns the new map
 * (markers for every venue materialized, per B2).
 */
function workDatesAfterZoneChange(
  doc: any,
  venuesBefore: any[],
  agenciesBefore: any[],
  venuesAfter: any[],
  agenciesAfter: any[],
  now: Date
): Record<string, string> {
  const markers = materializedWorkDates(doc, venuesBefore, agenciesBefore, now);
  for (const v of venuesAfter || []) {
    const before = (venuesBefore || []).find((x: any) => x?.id === v?.id);
    if (!before) continue;
    const oldTz = venueTimeZoneIn(before, agenciesBefore);
    const newTz = venueTimeZoneIn(v, agenciesAfter);
    if (oldTz === newTz) continue;
    markers[v.id] = laterWorkDate(markers[v.id], workDateIn(newTz, now));
  }
  return markers;
}

/**
 * Which venues are due for their scheduled rollover at `now`, from the
 * in-memory state (a cheap pre-check; executeDailyReset re-decides on the
 * fresh document inside the transaction). legacyDue: the NY day has rolled
 * past the legacy marker (tasks whose venue no longer exists still reset on
 * it, as before).
 */
function venuesDueAt(now: Date): { due: string[]; legacyDue: boolean } {
  const doc = { venueWorkDates, currentWorkDate };
  const markers = materializedWorkDates(doc, venues, agencies, now);
  const due = venues
    .filter((v: any) => workDateIn(venueTimeZoneIn(v, agencies), now) > markers[v.id])
    .map((v: any) => v.id);
  const legacyDue = !isWorkDate(currentWorkDate) || workDateIn(DEFAULT_TIME_ZONE, now) > currentWorkDate;
  return { due, legacyDue };
}

// Daily Reset Logic (supports resetting a specific venue or all)
//
// Returns a Promise that resolves ONLY after the transaction has committed
// (or rejects on failure) — callers must await it before responding or
// broadcasting. Archive/history creation happens INSIDE the transaction
// (buildSnapshot runs in the mutator).
//
// Item 6 (folds in PR #27's archive-date fix, per venue):
// - Scheduled (no force): the due set is computed on the FRESH document —
//   venues whose today-in-their-zone > their marker. That one set drives the
//   snapshots, the task resets, the marker advance and the broadcast. Each
//   snapshot is dated with the workday being CLOSED (the venue's marker),
//   never "today" and never the module-level date. An empty due set is a
//   no-op (no snapshot, no task change, no version bump, no broadcast).
//   A gap of more than one day (outage) closes in ONE snapshot carrying
//   catchUpDays; no empty days are synthesized.
// - Manual ({ force: true }, admin, own agency): resets the target venues
//   now; marker := max(marker, today-in-zone) (never backwards), and the
//   snapshot is dated with that same value. Idempotent via operationId.
async function executeDailyReset(
  targetVenueId?: string,
  resetBy: string = 'system',
  opts: { force?: boolean; operationId?: string; agencyId?: string; now?: Date } = {}
): Promise<{ result: any; version: number } | null> {
  // Agency scoping: manual resets pass agencyId (caller's agency only).
  // Scheduled resets pass no agencyId (system operation across all agencies).
  const scopeAgencyId = opts.agencyId || null;
  // One instant for the whole reset (and every transaction retry).
  const now = opts.now || serverNow();
  const resetAt = now.toISOString();
  // Random ID base per reset invocation: stable across transaction retries
  // (the mutator closure captures it), unique across invocations so snapshot
  // IDs from different resets can never collide.
  const stamp = crypto.randomUUID();
  // Agencies whose tasks changed without a snapshot (orphan tasks on the
  // legacy NY rollover); recomputed on every mutator run.
  let orphanAgencyIds = new Set<string>();
  // 8r: history retention counts from the committed mutator run (logged after commit).
  let resetHistoryRemoved = 0;
  let resetHistoryUndated = 0;

  // Build a single history snapshot from a venue + its tasks (pure function).
  // archiveDate is the workday being closed; tz formats check-in times in
  // the venue's own zone (N7).
  const buildSnapshot = (
    v: any,
    venueTasks: any[],
    archiveDate: string,
    tz: string,
    catchUpDays?: number
  ): HistoryLog => {
    const completedCount = venueTasks.filter((t) => t.isCompleted).length;
    const totalCount = venueTasks.length;
    const rate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
    return {
      id: `hist-${v.id}-${stamp}`,
      agencyId: v.agencyId || 'agency-hkc',
      venueId: v.id,
      date: archiveDate,
      totalTasks: totalCount,
      completedTasks: completedCount,
      completionRate: rate,
      resetAt,
      resetBy,
      ...(catchUpDays && catchUpDays > 1 ? { catchUpDays } : {}),
      entries: venueTasks.map((t) => {
        const checkIns = t.checkIns || [];
        const checkInSummary =
          checkIns.length > 0
            ? checkIns
                .map((c: any) => {
                  const when = (() => {
                    try {
                      return new Date(c.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz });
                    } catch {
                      return '';
                    }
                  })();
                  return `${c.byName || c.byEmail || 'Someone'}${when ? ` at ${when}` : ''}`;
                })
                .join('; ')
            : '';
        const archivedNotes = checkInSummary
          ? `${t.notes ? t.notes + '\n' : ''}Checks (${checkIns.length}): ${checkInSummary}`
          : t.notes;
        return {
          id: `entry-${t.id}-${stamp}`,
          taskId: t.id,
          taskTitle: t.title,
          category: t.category,
          status: t.currentStatus,
          isCompleted: t.isCompleted,
          notes: archivedNotes,
          completedByEmail: t.updatedByEmail,
          completedByName: t.updatedByName,
          completedAt: t.updatedAt,
        };
      }),
    };
  };

  const resetTask = (t: any): any => {
    let initialStatus = 'pending';
    if (t.inputType === 'yes_no') {
      initialStatus = 'no';
    } else if (
      t.inputType === 'status_select' &&
      Array.isArray(t.customStatusOptions) &&
      t.customStatusOptions.length > 0
    ) {
      initialStatus = t.customStatusOptions[0];
    }
    return {
      ...t,
      currentStatus: initialStatus,
      isCompleted: false,
      notes: '',
      updatedByEmail: null,
      updatedByName: null,
      updatedAt: null,
      checkIns: [],
    };
  };

  // The whole reset (snapshots + task reset + marker advance) commits
  // atomically; the markers advance inside the mutator, so a retry or a
  // second instance sees them and finds nothing due.
  // Await the CONFIRMED transaction before responding or broadcasting —
  // nothing may act on a reset that hasn't committed.
  let committed: { result: any; version: number };
  try {
    committed = await commitState(
      (freshDoc) => {
        orphanAgencyIds = new Set<string>();
        const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
        const freshAgencies: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
        const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
        const freshHistory: any[] = Array.isArray(freshDoc.historyLogs) ? freshDoc.historyLogs : [];
        // B2: markers for every venue, missing ones from the legacy date as
        // it stands BEFORE this commit.
        const markers = materializedWorkDates(freshDoc, freshVenues, freshAgencies, now);
        // Agency scoping: filter venues to the caller's agency when scoped.
        const scopedVenues = scopeAgencyId
          ? freshVenues.filter((v) => (v.agencyId || 'agency-hkc') === scopeAgencyId)
          : freshVenues;
        const targetVenues = targetVenueId
          ? scopedVenues.filter((v) => v.id === targetVenueId)
          : scopedVenues;

        // The due set: the single authority for snapshots, task resets,
        // marker advance and broadcast.
        const plan: Array<{ v: any; tz: string; archiveDate: string; newMarker: string; catchUpDays?: number }> = [];
        for (const v of targetVenues) {
          const tz = venueTimeZoneIn(v, freshAgencies);
          const today = workDateIn(tz, now);
          const marker = markers[v.id];
          if (opts.force) {
            const newMarker = laterWorkDate(marker, today);
            plan.push({ v, tz, archiveDate: newMarker, newMarker });
          } else if (today > marker) {
            plan.push({ v, tz, archiveDate: marker, newMarker: today, catchUpDays: workDaysBetween(marker, today) });
          }
        }
        // Legacy NY rollover (scheduled only): tasks whose venue no longer
        // exists reset on it, exactly as before item 6.
        const nyToday = workDateIn(DEFAULT_TIME_ZONE, now);
        const legacyDue = !opts.force && (!isWorkDate(freshDoc.currentWorkDate) || nyToday > freshDoc.currentWorkDate);
        const knownVenueIds = new Set(freshVenues.map((v) => v.id));
        const orphanTasks = legacyDue ? freshTasks.filter((t) => !knownVenueIds.has(t.venueId)) : [];

        if (plan.length === 0 && !legacyDue) {
          // Nothing due: version-neutral no-op (commitState's no-op path).
          return { doc: freshDoc, result: null };
        }
        const dueIds = new Set(plan.map((p) => p.v.id));
        const snapshots = plan.map((p) =>
          buildSnapshot(p.v, freshTasks.filter((t) => t.venueId === p.v.id), p.archiveDate, p.tz, p.catchUpDays)
        );
        // 8r: keep 7 days of history — only for this reset's due venues, in
        // this same commit (a scoped reset never touches other venues).
        const pruned = pruneHistory(
          snapshots.length ? [...snapshots, ...freshHistory] : freshHistory,
          freshVenues,
          freshAgencies,
          now,
          { venueIds: dueIds }
        );
        resetHistoryRemoved = pruned.removedCount;
        resetHistoryUndated = pruned.undatedKept;
        const orphanIds = new Set(orphanTasks.map((t) => t.id));
        for (const t of orphanTasks) orphanAgencyIds.add(t.agencyId || 'agency-hkc');
        const newMarkers = { ...markers };
        for (const p of plan) newMarkers[p.v.id] = p.newMarker;
        // CORE FIX (round 4): the transaction result carries ALL snapshots
        // (each tagged with its agencyId). The broadcast below selects the
        // snapshots for each agency — never send agency A's snapshot to
        // agency B.
        return {
          doc: {
            ...freshDoc,
            historyLogs: pruned.kept,
            tasks: freshTasks.map((t) => (dueIds.has(t.venueId) || orphanIds.has(t.id) ? resetTask(t) : t)),
            venueWorkDates: newMarkers,
            currentWorkDate: legacyDue ? nyToday : freshDoc.currentWorkDate,
          },
          result: snapshots,
        };
      },
      { label: 'daily-reset', operationId: opts.operationId }
    );
  } catch (err) {
    log.warn('[DailyReset] Transaction failed:', (err as any)?.message);
    throw err;
  }

  if (committed && committed.result && resetHistoryRemoved > 0) {
    log.info(`[history-retention] reset removed ${resetHistoryRemoved} snapshot(s) older than ${HISTORY_RETENTION_DAYS} days (undated kept: ${resetHistoryUndated})`);
  }
  // Broadcast per-agency ONLY after commit (in-memory cache is now fresh).
  // AGENCY SCOPING: each agency receives ONLY its own snapshots, and only
  // agencies that had a due venue (or reset orphan tasks) hear anything.
  // A no-op (nothing due) broadcasts nothing.
  if (committed.result === null || committed.result === undefined) return committed;
  const allSnapshots: any[] = Array.isArray(committed.result) ? committed.result : [];
  const touched = new Set<string>([
    ...allSnapshots.map((s: any) => s.agencyId || 'agency-hkc'),
    ...orphanAgencyIds,
  ]);
  const broadcastAgencies = (scopeAgencyId
    ? agencies.filter((a: any) => a.id === scopeAgencyId)
    : agencies
  ).filter((a: any) => opts.force || touched.has(a.id));
  for (const a of broadcastAgencies) {
    const aid = a.id;
    const agencySnapshots = allSnapshots.filter((s: any) => (s.agencyId || 'agency-hkc') === aid);
    broadcast(
      'DAILY_RESET',
      {
        venueId: targetVenueId || 'all',
        tasks: tasks.filter((t) => (t.agencyId || 'agency-hkc') === aid),
        historyLogs: historyLogs.filter((h) => (h.agencyId || 'agency-hkc') === aid),
        currentWorkDate,
        snapshots: agencySnapshots,
      },
      undefined,
      aid,
      (meta, base) => {
        const recipient = recipientForMeta(meta);
        return {
          ...base,
          tasks: base.tasks.filter((t: any) => canSeeTaskServer(t, recipient)),
          historyLogs: historyLogsForRecipient(aid, recipient),
          snapshots: filterLogEntries(base.snapshots, recipient),
        };
      }
    );
  }

  return committed;
}

/**
 * Item 6 — one scheduled rollover pass at `now`: if any venue (or the legacy
 * NY marker) is due, run the scheduled reset; otherwise nothing. One pass at
 * a time (in-flight guard); the transaction itself is the cross-instance
 * guard. No background writes in maintenance mode, FORCE_LOCAL_MODE or on a
 * staged revision.
 */
/**
 * Item 8r — the retention sweep: ONE commitState over every venue's history
 * (each venue by its own zone; src/server/history-retention.ts). Nothing to
 * remove → version-neutral no-op (no write, no broadcast). After a commit
 * that removed something, each affected agency gets HISTORY_PRUNED built
 * from the COMMITTED, hydrated state, filtered per recipient exactly like
 * DAILY_RESET's history list. Logs counts only. Throws on failure (the
 * caller then leaves the hourly gate open so the next tick retries).
 */
async function runHistoryRetentionSweep(now: Date): Promise<{ removed: number; version: number | null }> {
  let removed = 0;
  let undated = 0;
  let agencyIds: string[] = [];
  const committed = await commitState(
    (freshDoc) => {
      const freshHistory: any[] = Array.isArray(freshDoc.historyLogs) ? freshDoc.historyLogs : [];
      const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
      const freshAgencies: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
      const pr = pruneHistory(freshHistory, freshVenues, freshAgencies, now);
      removed = pr.removedCount;
      undated = pr.undatedKept;
      if (pr.removedCount === 0) {
        agencyIds = [];
        return { doc: freshDoc, result: null };
      }
      // Affected agencies resolved venue-first (a legacy snapshot without
      // agencyId belongs to its venue's agency), same rule as the helper.
      agencyIds = pr.removedAgencyIds;
      return { doc: { ...freshDoc, historyLogs: pr.kept }, result: { removed: pr.removedCount } };
    },
    { label: 'history-retention' }
  );
  if (removed === 0) return { removed: 0, version: committed ? committed.version : null };
  log.info(`[history-retention] sweep removed ${removed} snapshot(s) older than ${HISTORY_RETENTION_DAYS} days across ${agencyIds.length} agency(ies) (undated kept: ${undated})`);
  for (const aid of agencyIds) {
    broadcast(
      'HISTORY_PRUNED',
      { historyLogs: historyLogs.filter((h) => (h.agencyId || 'agency-hkc') === aid) },
      undefined,
      aid,
      (meta, base) => ({ ...base, historyLogs: historyLogsForRecipient(aid, recipientForMeta(meta)) })
    );
  }
  return { removed, version: committed ? committed.version : null };
}

let lastRetentionSweepAt: number | null = null;
let rolloverInFlight: Promise<{ reset: string[]; version: number | null; historyRemoved?: number }> | null = null;
function runRolloverTick(
  now: Date = serverNow()
): Promise<{ reset: string[]; version: number | null; skipped?: string; historyRemoved?: number }> {
  if (process.env.MAINTENANCE_MODE === 'true' || process.env.FORCE_LOCAL_MODE === 'true' || isStagedRevision()) {
    return Promise.resolve({ reset: [], version: null, skipped: 'no-background-writes' });
  }
  if (rolloverInFlight) return rolloverInFlight;
  const { due, legacyDue } = venuesDueAt(now);
  // 8r: the hourly retention sweep rides the same serialized tick (never
  // overlaps a reset; runs only after durable state loaded, as resets do).
  const sweepDue = durableStateLoaded && shouldSweep(lastRetentionSweepAt, now.getTime());
  if (due.length === 0 && !legacyDue && !sweepDue) return Promise.resolve({ reset: [], version: null });
  rolloverInFlight = (async () => {
    let out: { reset: string[]; version: number | null; historyRemoved?: number } = { reset: [], version: null };
    if (due.length > 0 || legacyDue) {
      log.info(`[Scheduled Reset] Rollover due for ${due.length} venue(s)${legacyDue ? ' + legacy NY marker' : ''}`);
      const committed = await executeDailyReset(undefined, 'scheduled_midnight_cron', { now });
      const snaps: any[] = committed && Array.isArray(committed.result) ? committed.result : [];
      out = { reset: snaps.map((s: any) => s.venueId), version: committed ? committed.version : null };
    }
    if (sweepDue) {
      try {
        const sw = await runHistoryRetentionSweep(now);
        lastRetentionSweepAt = now.getTime(); // only after a successful sweep
        out.historyRemoved = sw.removed;
        if (sw.removed > 0) out.version = sw.version;
      } catch (err) {
        // Gate stays open: the next tick retries.
        log.warn('[history-retention] sweep failed (will retry):', (err as any)?.message);
      }
    }
    return out;
  })().finally(() => {
    rolloverInFlight = null;
  });
  return rolloverInFlight;
}

// Scheduled interval: check every 60 s whether any venue reached its local
// midnight. Log-and-continue on failure — the next tick retries. In test
// mode, while the fake clock is pinned, tests drive ticks themselves.
setInterval(() => {
  if (isTestMode() && testNowOverrideMs !== null) return;
  runRolloverTick().catch((err) => log.warn('[Scheduled Reset] Failed:', (err as any)?.message));
}, 60000);

// REST API Endpoints
// Health — deliberately PUBLIC (listed in PUBLIC_API_ROUTES): monitoring and
// uptime checks must reach it without auth.
app.get('/api/health', (req, res) => {
  const maintenance = process.env.FORCE_LOCAL_MODE === 'true' || process.env.MAINTENANCE_MODE === 'true';
  const staged = isStagedRevision();
  const firestore = maintenance ? 'maintenance' : (firestoreDb ? 'connected' : firestoreInitStatus);
  res.json({
    status: maintenance ? 'maintenance' : (firestore === 'connected' ? 'ok' : 'degraded'),
    firestore,
    maintenance,
    staged,
    stage2: true,
    version: stateVersion,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString(),
    activeSockets: activeSockets.size,
    currentWorkDate,
    venuesCount: venues.length,
    tasksCount: tasks.length,
  });
});

// Storage stats — how much space media is using (admin only)
app.get('/api/admin/storage', (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  // Storage totals are scoped to the caller's agency — never all agencies.
  const agencyId = admin.agencyId || 'agency-hkc';
  const agencyTasks = tasks.filter((t) => (t.agencyId || 'agency-hkc') === agencyId);
  const agencyNotes = handoffNotes.filter((n) => (n.agencyId || 'agency-hkc') === agencyId);
  const agencyIncidents = incidents.filter((i) => i.agencyId === agencyId);

  let photoBytes = 0;
  let audioBytes = 0;
  let photoCount = 0;
  let audioCount = 0;

  for (const task of agencyTasks) {
    for (const ci of task.checkIns || []) {
      if ((ci as any).photoData) {
        photoBytes += (ci as any).photoData.length;
        photoCount++;
      }
    }
  }
  for (const note of agencyNotes) {
    if ((note as any).voiceNoteData) {
      audioBytes += (note as any).voiceNoteData.length;
      audioCount++;
    }
  }
  for (const incident of agencyIncidents) {
    if (incident.photoData) {
      photoBytes += incident.photoData.length;
      photoCount++;
    }
    if (incident.voiceNoteData) {
      audioBytes += incident.voiceNoteData.length;
      audioCount++;
    }
  }

  // Base64 is ~33% larger than binary
  const totalBytes = Math.round((photoBytes + audioBytes) * 0.75);

  res.json({
    photos: { count: photoCount, bytes: Math.round(photoBytes * 0.75) },
    audio: { count: audioCount, bytes: Math.round(audioBytes * 0.75) },
    totalBytes,
    totalMB: (totalBytes / 1024 / 1024).toFixed(2),
    retentionDays: MEDIA_RETENTION_DAYS,
  });
});

// Admin data export — download full state as JSON backup (admin only)
app.get('/api/admin/export', (req, res) => {
  // SECURITY: admin-only (2026-10-18). Since 8h: ALWAYS scoped to the
  // caller's own agency by verified ownership, built by explicit projection,
  // secret-free — no cross-agency export for anyone (whole-database DR is the
  // Tier-1 backup job). See src/server/admin-export.ts.
  const caller = requireAdmin(req, res);
  if (!caller) return;
  // The caller's agency comes from the verified session record (a legacy
  // account without agencyId belongs to the home agency, as everywhere else).
  const safe = buildAdminExport(stateSnapshot(), {
    id: caller.id, role: caller.role, email: caller.email, agencyId: caller.agencyId || 'agency-hkc',
  });
  const filename = `shutfey-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ ...safe, exportedAt: new Date().toISOString() });
});

// Custom task templates — Don's own library (replaces generic ones)
app.get('/api/task-templates', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const agencyId = caller.agencyId || 'agency-hkc';
  res.json({ templates: taskTemplates.filter((t) => t.agencyId === agencyId) });
});

app.post('/api/task-templates', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  // A2: no UI uses this API. Rule T: admin, or coordinator copying their own
  // venue (checked via fromVenueId below). A coordinator creating a blank
  // template (no fromVenueId) is allowed — it carries no venue data.
  if (caller.role !== 'admin' && caller.role !== 'coordinator') {
    return res.status(403).json({ error: 'Only admins and coordinators can create task templates.' });
  }
  const { name, description, tasks: templateTasks, fromVenueId } = req.body || {};
  if (!name?.trim()) {
    return res.status(400).json({ error: 'Template name is required.' });
  }

  // Build task definitions from the request (reads from memory cache — safe for reads).
  let taskDefs: TaskTemplate['tasks'] = [];
  if (fromVenueId) {
    taskDefs = tasks
      .filter((t) => t.venueId === fromVenueId)
      .map((t) => ({
        title: t.title,
        description: t.description,
        category: t.category,
        targetTime: t.targetTime,
        priority: t.priority,
        enableOverdueAlert: t.enableOverdueAlert,
      }));
  } else if (Array.isArray(templateTasks)) {
    taskDefs = templateTasks;
  }

  const templateId = `tmpl-${crypto.randomUUID()}`;
  // New templates belong to the caller's agency (never trust a client value).
  const agencyId = callerAgencyId(req);
  // Copying another venue's tasks into a template leaks their data to the
  // template owner — and RULE T: a non-admin may only copy their own venue.
  if (fromVenueId && !requireVenueAccess(req, res, fromVenueId)) return;

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.taskTemplates) ? freshDoc.taskTemplates : [];
      if (arr.some((t) => t.id === templateId)) {
        return { doc: freshDoc, result: arr.find((t) => t.id === templateId) };
      }
      const template: TaskTemplate = {
        id: templateId,
        agencyId,
        name: String(name).trim(),
        description: description?.trim(),
        tasks: taskDefs,
        createdByEmail: caller.email,
        createdAt: new Date().toISOString(),
      };
      return { doc: { ...freshDoc, taskTemplates: [...arr, template] }, result: template };
    },
    { label: 'create-task-template' }
  );
  if (!committed) return;
  res.json({ template: committed.result });
});

app.post('/api/task-templates/:id/apply', async (req, res) => {
  // A2: admin, or coordinator applying to their own venue (checked below).
  const applyCaller = getAuthUser(req);
  if (!applyCaller) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }
  if (applyCaller.role !== 'admin' && applyCaller.role !== 'coordinator') {
    return res.status(403).json({ error: 'Only admins and coordinators can apply task templates.' });
  }
  const template = taskTemplates.find((t) => t.id === req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found.' });

  const { venueId } = req.body || {};
  if (!venueId) return res.status(400).json({ error: 'Venue ID is required.' });

  // The template and the target venue must both belong to the caller's agency;
  // RULE T: a non-admin may only apply a template to their own venue.
  if (!requireSameAgency(req, res, template, 'templates')) return;
  if (!requireVenueAccess(req, res, venueId)) return;
  const agencyId = callerAgencyId(req);
  const now = new Date().toISOString();
  // Pre-generate stable IDs so transaction retries don't duplicate tasks.
  // 6c: normalize each applied template task.
  const created: TaskItem[] = template.tasks.map((td, i) => normalizeAnyTimeTask({
    id: `task-${crypto.randomUUID()}`,
    agencyId,
    venueId,
    title: td.title,
    description: td.description || '',
    category: td.category || 'General',
    categories: [td.category || 'General'],
    isPrivate: false,
    sortOrder: i,
    inputType: 'yes_no',
    assignedTo: ['all'],
    scheduleType: 'recurring',
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targetTime: td.targetTime || 'End of Day',
    priority: td.priority || 'medium',
    enableOverdueAlert: td.enableOverdueAlert === true,
    currentStatus: 'pending',
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    checkIns: [],
    createdAt: now,
  }));
  const createdIds = new Set(created.map((t) => t.id));

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      // Idempotency: skip tasks whose IDs already exist (partial previous commit).
      const toAdd = created.filter((t) => !freshTasks.some((ft) => ft.id === t.id));
      if (toAdd.length === 0) {
        return { doc: freshDoc, result: { created: 0, tasks: [] } };
      }
      return {
        doc: { ...freshDoc, tasks: [...freshTasks, ...toAdd] },
        result: { created: toAdd.length, tasks: toAdd },
      };
    },
    { label: 'apply-task-template' }
  );
  if (!committed) return;
  broadcast('TASKS_UPDATED', { venueId }, undefined, agencyId);
  res.json(committed.result);
});

app.delete('/api/task-templates/:id', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const existing = taskTemplates.find((t) => t.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Template not found.' });
  if (!requireSameAgency(req, res, existing, 'templates')) return;
  // A2: a coordinator may delete only templates they created themselves
  // (createdByEmail); everyone else non-admin is 403.
  if (caller.role !== 'admin' &&
      !(caller.role === 'coordinator' && (existing as any).createdByEmail === caller.email)) {
    return res.status(403).json({ error: 'You can only delete templates you created.' });
  }
  const ok = await crudDelete(req, res, 'taskTemplates', req.params.id, { label: 'delete-task-template' });
  return;
});

// Incidents — "oh no" flow: photo + voice + instant alert + auto-task.
// 5b: these are the app's ALERTS (Updates → Alerts tab). Payloads are
// publicIncident(): no media bytes, no emails.
app.get('/api/incidents', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const agencyId = caller.agencyId || 'agency-hkc';
  const venueScope = scopedVenueIds(req, res);
  if (!venueScope) return;
  const status = String(req.query.status || '');
  let list = incidents.filter((i) => i.agencyId === agencyId);
  if (venueScope !== 'agency') {
    list = list.filter((i) => venueScope.includes(i.venueId));
  }
  list = list.filter((i) => incidentVisibleTo(caller, i));
  if (status) list = list.filter((i) => i.status === status);
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const out = list.map((i) => publicIncident(i, caller));
  // 5b (Q4): the reporter sees "Seen by a recipient" once at least one
  // recipient has a read mark. Computed HERE only — read marks live outside
  // app-state, so POST/ack/resolve responses leave the field unset. No
  // names, no counts, and it never stands in for acknowledgment.
  const mineIdx = out.map((o, idx) => (o.mine ? idx : -1)).filter((idx) => idx >= 0);
  if (mineIdx.length > 0) {
    try {
      const recipUsers = mineIdx.flatMap((idx) => alertRecipients(list[idx]));
      const marks = await loadUpdateReadsMany(recipUsers);
      for (const idx of mineIdx) {
        const inc = list[idx];
        (out[idx] as any).seenByRecipient = alertRecipients(inc)
          .some((u) => { const r = marks.get(u.id); return !!r && !!r.i[inc.id]; });
      }
    } catch {
      // Marks unreadable: leave the field unset rather than guess.
    }
  }
  res.json({ incidents: out });
});

// 5b: an alert's photo / voice note, on demand, behind the same rule as the
// list. Unknown and not-visible answer the same 404 (no existence oracle).
app.get('/api/incidents/:id/media', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const inc = incidents.find((i) => i.id === req.params.id);
  if (!inc || !incidentVisibleTo(caller, inc)) {
    return res.status(404).json({ error: 'Alert not found.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.json({ photoData: inc.photoData || null, voiceNoteData: inc.voiceNoteData || null });
});

// 5b: inline media caps (the alert lives in app-state/main, which must stay
// under the 900 KiB guard). Over the cap = 413, never a silent truncation
// (a cut base64 string is a corrupt file). The client sends a photo resized
// to at most 1024 px JPEG and a voice note of at most 30 s at a low bitrate.
const ALERT_TITLE_MAX = 140;
const ALERT_DESCRIPTION_MAX = 2000;
// v2.1 A12: small caps (photo downscaled ≤ 1024 px on the client; voice
// ≤ 30 s) and a per-agency budget for inline media in the shared app-state
// document (the document refuses any commit over 900 KiB, which would
// block ordinary task writes and check-in photos).
const ALERT_PHOTO_MAX_CHARS = 120_000;
const ALERT_VOICE_MAX_CHARS = 90_000;
const ALERT_MEDIA_BUDGET_CHARS = 300 * 1024;
// Media may only be added while the projected document stays under this
// size — the rest is headroom for ordinary writes.
const ALERT_DOC_HEADROOM_BYTES = 700 * 1024;
/** Inline media (base64 chars) an agency currently keeps in the document. */
function inlineMediaChars(doc: any, agencyId: string): number {
  const mine = (x: any) => (x?.agencyId || 'agency-hkc') === agencyId;
  let n = 0;
  for (const i of (doc.incidents || [])) if (mine(i)) n += (i.photoData?.length || 0) + (i.voiceNoteData?.length || 0);
  for (const t of (doc.tasks || [])) if (mine(t)) for (const c of (t.checkIns || [])) n += (c?.photoData?.length || 0);
  for (const h of (doc.handoffNotes || [])) if (mine(h)) n += (h?.voiceNoteData?.length || 0);
  return n;
}

// 5b (test mode only): the routing decision of each alert, so Test 30 can
// prove who would be notified without sending a real push to anyone.
const testAlertRouting = new Map<string, { email: string; silent: boolean }[]>();
const testAlertAttempts = new Map<string, number>(); // v2 A4: push dispatches per alert (test mode)

app.post('/api/incidents', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { venueId, title, description, severity, photoData, voiceNoteData, clientRef } = req.body || {};
  if (!venueId || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Venue and title are required.' });
  }
  if (title.trim().length > ALERT_TITLE_MAX ||
      (description !== undefined && description !== null &&
        (typeof description !== 'string' || description.length > ALERT_DESCRIPTION_MAX))) {
    return res.status(400).json({ error: 'The alert text is too long.', code: 'TEXT_TOO_LONG' });
  }
  const photoOk = photoData === undefined || photoData === null || photoData === '' ||
    (typeof photoData === 'string' && photoData.startsWith('data:image/'));
  const voiceOk = voiceNoteData === undefined || voiceNoteData === null || voiceNoteData === '' ||
    (typeof voiceNoteData === 'string' && voiceNoteData.startsWith('data:audio/'));
  if (!photoOk || !voiceOk) {
    return res.status(400).json({ error: 'Unsupported attachment.', code: 'BAD_MEDIA' });
  }
  if ((typeof photoData === 'string' && photoData.length > ALERT_PHOTO_MAX_CHARS) ||
      (typeof voiceNoteData === 'string' && voiceNoteData.length > ALERT_VOICE_MAX_CHARS)) {
    return res.status(413).json({ error: 'The photo or voice note is too large.', code: 'MEDIA_TOO_LARGE' });
  }
  if (clientRef !== undefined && (typeof clientRef !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(clientRef))) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const agencyId = caller.agencyId || 'agency-hkc';
  const now = new Date().toISOString();
  // RULE T: the incident's venue must be the caller's own venue (admins: the agency).
  if (!requireVenueAccess(req, res, venueId)) return;
  const venue = venues.find((v) => v.id === venueId);
  const venueName = venue?.name || 'Venue';

  // Stable IDs: a retried request (same clientRef from the same user) maps to
  // the SAME alert and follow-up task, so a flaky network never raises a
  // second alert. Without clientRef, a fresh id per request (old behaviour).
  const refHash = typeof clientRef === 'string'
    ? crypto.createHash('sha256').update(`${agencyId}|${caller.id}|${clientRef}`).digest('hex').slice(0, 32)
    : null;
  const incidentId = refHash ? `incident-${refHash}` : `incident-${crypto.randomUUID()}`;
  const followUpId = refHash ? `task-incident-${refHash}` : `task-${crypto.randomUUID()}`;
  const sev = (['low', 'medium', 'high', 'critical'].includes(severity) ? severity : 'medium') as Incident['severity'];
  let created = false;

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshIncidents: any[] = Array.isArray(freshDoc.incidents) ? freshDoc.incidents : [];
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      // Idempotency: if this incident ID already exists, return it.
      const existingIncident = freshIncidents.find((i) => i.id === incidentId);
      if (existingIncident) {
        created = false;
        return { doc: freshDoc, result: existingIncident };
      }
      // v2.1 A12: two checks against the SAME transactional state (atomic
      // with the create): the agency's inline-media budget AND the
      // projected size of the whole document. Text always goes; only the
      // attachment is refused.
      const incomingMedia = (typeof photoData === 'string' ? photoData.length : 0) + (typeof voiceNoteData === 'string' ? voiceNoteData.length : 0);
      if (incomingMedia > 0 && (
        inlineMediaChars(freshDoc, agencyId) + incomingMedia > ALERT_MEDIA_BUDGET_CHARS ||
        Buffer.byteLength(JSON.stringify(freshDoc)) + incomingMedia + 4096 > ALERT_DOC_HEADROOM_BYTES
      )) {
        created = false;
        return { doc: freshDoc, result: { __mediaBudget: true } };
      }
      created = true;
      const incident: Incident = {
        id: incidentId,
        agencyId,
        venueId,
        reporterEmail: caller.email,
        reporterName: caller.name,
        title: title.trim(),
        description: String(description || '').trim(),
        severity: sev,
        photoData: typeof photoData === 'string' && photoData ? photoData : undefined,
        voiceNoteData: typeof voiceNoteData === 'string' && voiceNoteData ? voiceNoteData : undefined,
        status: 'open',
        createdAt: now,
        linkedTaskId: followUpId,
      };
      // Auto-create a follow-up task (same transaction — atomic with the incident).
      const followUp: TaskItem = {
        id: followUpId,
        agencyId,
        venueId,
        title: `🚨 Follow up: ${incident.title}`,
        description: `Incident reported by ${incident.reporterName} at ${new Date(now).toLocaleString()}.\n\n${incident.description}`,
        category: 'Incident',
        categories: ['Incident'],
        isPrivate: false,
        sortOrder: 0,
        inputType: 'yes_no',
        assignedTo: ['all'],
        scheduleType: 'recurring',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        targetTime: 'End of Day',
        priority: sev === 'critical' || sev === 'high' ? 'high' : 'medium',
        enableOverdueAlert: sev === 'critical' || sev === 'high',
        currentStatus: 'pending',
        isCompleted: false,
        notes: '',
        updatedByEmail: null,
        updatedByName: null,
        updatedAt: null,
        checkIns: [],
        createdAt: now,
      };
      const tasksToAdd = freshTasks.some((t) => t.id === followUpId) ? [] : [followUp];
      return {
        doc: { ...freshDoc, incidents: [incident, ...freshIncidents], tasks: [...freshTasks, ...tasksToAdd] },
        result: incident,
      };
    },
    { label: 'create-incident' }
  );
  if (!committed) return;
  if ((committed.result as any)?.__mediaBudget) {
    return res.status(413).json({ error: 'Too many photos and voice notes are stored right now. Send the alert without the attachment.', code: 'MEDIA_BUDGET' });
  }
  const incident = committed.result as Incident;
  // A replayed request answers with the stored alert and notifies nobody again.
  if (!created) return res.json({ incident: publicIncident(incident, caller), replayed: true });

  // Side effects ONLY after commit. Immediately, day or night: no quiet hours.
  // A recipient's own mute makes the push silent (still delivered). A mute
  // lookup that fails or is slow fails LOUD (normal push), never quiet.
  const recipients = alertRecipients(incident);
  const muted = await alertMuteSetFor(recipients).catch(() => new Set<string>());
  const routing: { email: string; silent: boolean }[] = [];
  // C1: a push failure never hides the committed alert (it is already
  // stored and visible in the app). The first failure per alert logs ONE
  // bounded line — id, recipient count, error class; no emails, no
  // payload. Push is best-effort in 5b; "Alert push retry" is a named
  // follow-up item.
  let pushFailureLogged = false;
  const onPushError = (err: any) => {
    if (pushFailureLogged) return;
    pushFailureLogged = true;
    log.warn(`[alerts] push failed for ${incident.id} (${recipients.length} recipients): ${err?.name || 'Error'}${err?.statusCode ? ` ${err.statusCode}` : ''}`);
  };
  for (const r of recipients) {
    const silent = muted.has(r.id);
    routing.push({ email: r.email, silent });
    sendPushToUser(
      r.email,
      `🚨 ${incident.severity.toUpperCase()}: ${incident.title}`,
      `${venueName} — reported by ${incident.reporterName}`,
      {
        // 5b (A5): the push data contract is exactly these three keys, end
        // to end — sw.ts reads url / tag / silent and nothing else.
        url: `/?updates=alerts&alert=${encodeURIComponent(incident.id)}`,
        tag: `alert-${incident.id}`,
        silent,
      },
      onPushError
    );
  }
  if (isTestMode()) { testAlertRouting.set(incident.id, routing); testAlertAttempts.set(incident.id, (testAlertAttempts.get(incident.id) || 0) + 1); }
  broadcast('INCIDENT_CREATED', incidentSignal(incident), undefined, agencyId);
  broadcast('TASKS_UPDATED', { venueId }, undefined, agencyId);

  res.json({ incident: publicIncident(incident, caller) });
});

app.post('/api/incidents/:id/resolve', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const incident = incidents.find((i) => i.id === req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found.' });
  if (!requireSameAgency(req, res, incident, 'incidents')) return;
  // A3: admin, or coordinator at the incident's venue, or a canFill
  // mashgiach/worker at that venue (the ones on site); owner/other → 403.
  const mayResolve =
    caller.role === 'admin' ||
    (caller.role === 'coordinator' && callerMaySeeVenue(caller, incident.venueId)) ||
    ((caller.role === 'mashgiach' || caller.role === 'worker') && canFillTasks(caller) &&
      callerMaySeeVenue(caller, incident.venueId));
  if (!mayResolve) {
    return res.status(403).json({ error: 'You can only resolve incidents at your own venue.' });
  }
  const resolvedAt = new Date().toISOString();
  // Attribution from the VERIFIED session user, never the request body.
  const resolvedBy = caller.email;
  const resolvedByName = caller.name;
  const ok = await crudUpdate(req, res, 'incidents', req.params.id,
    (fresh) => {
      if (fresh.status === 'resolved') return fresh; // idempotent
      return { ...fresh, status: 'resolved', resolvedAt, resolvedBy, resolvedByName };
    },
    {
      label: 'resolve-incident',
      broadcastType: 'INCIDENT_UPDATED',
      getBroadcastPayload: (updated) => incidentSignal(updated),
      getAgencyId: (updated) => updated.agencyId,
      getResponse: (updated) => ({ incident: publicIncident(updated, caller) }),
    }
  );
  return;
});

app.post('/api/incidents/:id/acknowledge', async (req, res) => {
  // 5b: "Acknowledged" means a RECIPIENT has taken it — an admin, or a
  // coordinator of the alert's venue (the people it is routed to). On-site
  // staff can still resolve it, but cannot mark someone else's alert as seen
  // on the receivers' behalf.
  const ackCaller = getAuthUser(req);
  if (!ackCaller) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }
  const incident = incidents.find((i) => i.id === req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found.' });
  if (!requireSameAgency(req, res, incident, 'incidents')) return;
  const mayAck =
    ackCaller.role === 'admin' ||
    (ackCaller.role === 'coordinator' && callerMaySeeVenue(ackCaller, incident.venueId));
  if (!mayAck) {
    return res.status(403).json({ error: 'Only an admin or this venue\'s coordinator can acknowledge an alert.' });
  }
  const acknowledgedAt = new Date().toISOString();
  const ok = await crudUpdate(req, res, 'incidents', req.params.id,
    (fresh) => {
      if (fresh.status === 'acknowledged' || fresh.status === 'resolved') return fresh; // idempotent
      return {
        ...fresh, status: 'acknowledged',
        acknowledgedAt, acknowledgedBy: ackCaller.email, acknowledgedByName: ackCaller.name,
      };
    },
    {
      label: 'acknowledge-incident',
      broadcastType: 'INCIDENT_UPDATED',
      getBroadcastPayload: (updated) => incidentSignal(updated),
      getAgencyId: (updated) => updated.agencyId,
      getResponse: (updated) => ({ incident: publicIncident(updated, ackCaller) }),
    }
  );
  return;
});

/**
 * Get the Firestore database for media operations. Uses the named database
 * (firestoreDb), not the default. Fails closed (503) if unavailable.
 * Returns null after sending the error response; callers must check.
 */
function requireMediaDb(req: any, res: any): any | null {
  if (!firestoreDb) {
    res.status(503).json({
      error: 'Media storage is temporarily unavailable (Firestore not connected).',
      code: 'DB_UNAVAILABLE',
    });
    return null;
  }
  return firestoreDb;
}

// ---------------------------------------------------------------------------
// Stage 3A — Media lifecycle API
// All routes require authentication. Agency/venue scope comes from the
// verified session user, never from client-supplied parameters.
// ---------------------------------------------------------------------------

/**
 * Media route error handler. For admin callers, includes the underlying
 * error message to aid debugging (e.g. via /admin/media-check).
 * Non-admin callers get the generic message only.
 */
function mediaErrorResponse(req: any, res: any, e: any, genericMessage: string, logPrefix: string): void {
  if (e instanceof media.MediaError) {
    res.status(e.status).json({ error: e.message, code: e.code });
  } else {
    log.error(`[media] ${logPrefix} error:`, e);
    const user = getAuthUser(req);
    const detail = user?.role === 'admin' && e?.message ? `: ${e.message}` : '';
    res.status(500).json({ error: genericMessage + detail });
  }
}

/**
 * POST /api/media/intent — Create an upload intent.
 * Body: { mimeType, sizeBytes, sha256, venueId? }
 * Returns: { mediaId, uploadUrl, expiresAt }
 */
app.post('/api/media/intent', async (req, res) => {
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const db = requireMediaDb(req, res);
    if (!db) return;
    const agencyId = callerAgencyId(req);
    // (fix round 1) A non-admin MUST supply venueId — uploading into an
    // unscoped (admin-level) record is not allowed. Admins may create
    // agency-level intents with no venue.
    const { mimeType, sizeBytes, sha256, venueId } = req.body || {};
    if (user.role !== 'admin' && !venueId) {
      res.status(403).json({ error: 'You can only work in your own venue.' });
      return;
    }
    if (venueId && !requireVenueAccess(req, res, String(venueId))) {
      return;
    }
    const result = await media.createIntent(db, {
      agencyId,
      venueId,
      uploadedBy: user.id,
      mimeType,
      sizeBytes,
      sha256,
    });
    res.json(result);
  } catch (e: any) {
    mediaErrorResponse(req, res, e, 'Failed to create upload intent.', 'intent');
  }
});

/**
 * POST /api/media/:id/uploaded — Mark intent as uploaded (after PUT to signed URL).
 */
app.post('/api/media/:id/uploaded', async (req, res) => {
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const db = requireMediaDb(req, res);
    if (!db) return;
    const doc = await db.collection('media').doc(req.params.id).get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Media not found.' });
      return;
    }
    const mediaDoc = doc.data();
    if (!requireSameAgency(req, res, mediaDoc, 'media')) return;
    // (fix round 1) A venue-less media doc is admin-only; a venue-scoped doc
    // goes to the admin or to non-admins inside its venue (rule T).
    if (user.role !== 'admin') {
      if (!mediaDoc.venueId) {
        res.status(403).json({ error: 'No access to this media.' });
        return;
      }
      if (!callerMaySeeVenue(user, mediaDoc.venueId)) {
        res.status(403).json({ error: 'No access to this venue.' });
        return;
      }
    }
    await media.markUploaded(db, req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    mediaErrorResponse(req, res, e, 'Failed to mark as uploaded.', 'uploaded');
  }
});

/**
 * POST /api/media/:id/validate — Validate the uploaded file.
 * Checks size, checksum, and file signature. INTENT/UPLOADED → VALIDATED.
 */
app.post('/api/media/:id/validate', async (req, res) => {
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const db = requireMediaDb(req, res);
    if (!db) return;
    const doc = await db.collection('media').doc(req.params.id).get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Media not found.' });
      return;
    }
    const mediaDoc = doc.data();
    if (!requireSameAgency(req, res, mediaDoc, 'media')) return;
    // (fix round 1) A venue-less media doc is admin-only; a venue-scoped doc
    // goes to the admin or to non-admins inside its venue (rule T).
    if (user.role !== 'admin') {
      if (!mediaDoc.venueId) {
        res.status(403).json({ error: 'No access to this media.' });
        return;
      }
      if (!callerMaySeeVenue(user, mediaDoc.venueId)) {
        res.status(403).json({ error: 'No access to this venue.' });
        return;
      }
    }
    const validated = await media.validateUpload(db, req.params.id);
    res.json({ ok: true, state: validated.state });
  } catch (e: any) {
    mediaErrorResponse(req, res, e, 'Validation failed.', 'validate');
  }
});

/**
 * POST /api/media/:id/commit — Commit validated media to an entity.
 * Body: { entityType, entityId }
 * VALIDATED → COMMITTED. Only after validation.
 */
app.post('/api/media/:id/commit', async (req, res) => {
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const db = requireMediaDb(req, res);
    if (!db) return;
    const doc = await db.collection('media').doc(req.params.id).get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Media not found.' });
      return;
    }
    const mediaDoc = doc.data();
    if (!requireSameAgency(req, res, mediaDoc, 'media')) return;
    // (fix round 1) A venue-less media doc is admin-only; a venue-scoped doc
    // goes to the admin or to non-admins inside its venue (rule T).
    if (user.role !== 'admin') {
      if (!mediaDoc.venueId) {
        res.status(403).json({ error: 'No access to this media.' });
        return;
      }
      if (!callerMaySeeVenue(user, mediaDoc.venueId)) {
        res.status(403).json({ error: 'No access to this venue.' });
        return;
      }
    }
    const { entityType, entityId } = req.body || {};
    if (!entityType || !entityId) {
      res.status(400).json({ error: 'entityType and entityId are required.' });
      return;
    }
    // Whitelist of attachable entity types (Phase 3A: metadata-only, see below).
    const ALLOWED_ENTITY_TYPES = new Set(['task', 'incident', 'handoff-note', 'announcement']);
    if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
      res.status(400).json({ error: `Entity type not allowed: ${entityType}` });
      return;
    }
    // (fix round 1, B2) Validate the target entity: it must exist (404), be
    // in the caller's agency, for non-admins its venueId must be in their
    // scope, and it must MATCH the media doc's venueId when the doc has one.
    // Without this, a caller could attach media across venues/agencies.
    const entityCollections: Record<string, any[]> = {
      'task': tasks,
      'incident': incidents,
      'handoff-note': handoffNotes,
      'announcement': announcements,
    };
    const targetEntity = (entityCollections[entityType] || []).find((e: any) => e.id === entityId);
    if (!targetEntity) {
      res.status(404).json({ error: 'Target entity not found.' });
      return;
    }
    if (!requireSameAgency(req, res, targetEntity, entityType)) return;
    if (mediaDoc.venueId && (targetEntity as any).venueId !== mediaDoc.venueId) {
      res.status(403).json({ error: 'Media and target entity are in different venues.' });
      return;
    }
    if (user.role !== 'admin' && (targetEntity as any).venueId &&
        !callerMaySeeVenue(user, (targetEntity as any).venueId)) {
      res.status(403).json({ error: 'No access to this venue.' });
      return;
    }
    // Phase 3A note: attachedTo is metadata recording the intended attachment.
    // The target entity lives in the monolith (app-state/main); Phase 3B's
    // per-entity collections will enforce referential integrity.
    const committed = await media.commitMedia(db, req.params.id, entityType, entityId);
    res.json({ ok: true, state: committed.state, attachedTo: committed.attachedTo });
  } catch (e: any) {
    mediaErrorResponse(req, res, e, 'Failed to commit media.', 'commit');
  }
});

/**
 * GET /api/media/:id/download — Get a short-lived signed download URL.
 * Only for COMMITTED media in the caller's agency.
 */
app.get('/api/media/:id/download', async (req, res) => {
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const db = requireMediaDb(req, res);
    if (!db) return;
    const doc = await db.collection('media').doc(req.params.id).get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Media not found.' });
      return;
    }
    const mediaDoc = doc.data();
    if (!requireSameAgency(req, res, mediaDoc, 'media')) return;
    // (fix round 1) A venue-less media doc is admin-only; a venue-scoped doc
    // goes to the admin or to non-admins inside its venue (rule T).
    if (user.role !== 'admin') {
      if (!mediaDoc.venueId) {
        res.status(403).json({ error: 'No access to this media.' });
        return;
      }
      if (!callerMaySeeVenue(user, mediaDoc.venueId)) {
        res.status(403).json({ error: 'No access to this venue.' });
        return;
      }
    }
    const url = await media.getDownloadUrl(db, req.params.id);
    res.json({ downloadUrl: url });
  } catch (e: any) {
    mediaErrorResponse(req, res, e, 'Failed to get download URL.', 'download');
  }
});

/**
 * POST /api/media/sweep — Run the orphan sweeper (admin only).
 * Idempotent. Marks abandoned intents, deletes expired files.
 */
/**
 * Verify a Google OIDC token from Cloud Scheduler.
 * Uses google-auth-library to verify the token's signature, audience,
 * and service account email. Returns true if valid, false otherwise.
 */
async function verifySchedulerOidc(req: any): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);

  // Expected: Cloud Scheduler's service account
  const expectedSa = process.env.SCHEDULER_SERVICE_ACCOUNT;
  const expectedAudience = process.env.SCHEDULER_AUDIENCE ||
    'https://workers-collaborative-dashboard-1080260390009.us-east1.run.app';

  if (!expectedSa) {
    log.warn('[media] SCHEDULER_SERVICE_ACCOUNT not configured; OIDC verification disabled.');
    return false;
  }

  try {
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: expectedAudience,
    });
    const payload = ticket.getPayload();
    if (!payload) return false;
    // Verify the token was issued for the expected service account
    if (payload.email !== expectedSa) {
      log.warn(`[media] OIDC email mismatch: ${payload.email} !== ${expectedSa}`);
      return false;
    }
    // Verify issuer is Google
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      log.warn(`[media] OIDC issuer mismatch: ${payload.iss}`);
      return false;
    }
    return true;
  } catch (e: any) {
    log.warn('[media] OIDC verification failed:', e?.message);
    return false;
  }
}

app.post('/api/media/sweep', async (req, res) => {
  try {
    // Accept either: verified scheduler OIDC (set by middleware) OR admin session.
    // The middleware already verified the OIDC token; we just check the flag.
    // 8i: platform-wide job — verified scheduler OIDC or the pinned operator.
    const isScheduler = (req as any).schedulerAuth === true;
    if (!isScheduler && !requirePlatformOperator(req, res)) return;
    const db = requireMediaDb(req, res);
    if (!db) return;
    if (!isScheduler && !stillPlatformOperator(req)) {
      res.status(403).json({ error: PLATFORM_OPERATOR_FORBIDDEN });
      return;
    }
    const result = await media.sweepOrphans(db);
    // If any deletions failed, return 500 so Cloud Scheduler retries.
    // The sweeper marks failed records with deleteError for the next run.
    if (result.errors.length > 0) {
      log.error(`[media] Sweeper completed with ${result.errors.length} errors:`, result.errors);
      res.status(500).json({
        error: 'Sweeper completed with deletion errors; will retry.',
        ...result,
      });
      return;
    }
    res.json(result);
  } catch (e: any) {
    log.error('[media] sweep error:', e);
    res.status(500).json({ error: 'Sweeper failed.' });
  }
});

/**
 * POST /api/internal/consistency-check — Stage 4 PR A.
 * Scheduler-OIDC or admin only. Runs the dual-write consistency check
 * (per-entity vs monolith) + monolith size warning.
 * Returns non-2xx on failure so Cloud Scheduler retries / alerts.
 */
app.post('/api/internal/consistency-check', async (req, res) => {
  // 8i: platform-wide job — verified scheduler OIDC or the pinned operator.
  const isScheduler = (req as any).schedulerAuth === true;
  if (!isScheduler && !requirePlatformOperator(req, res)) return;
  // The body lives in src/server/consistency-route.ts: it owns the 503,
  // the handler call, and the single-writer safety net (an emission marker
  // shared with the handler, so a failure before the handler runs still
  // produces exactly one "[consistency] ERROR" — and a failure after the
  // summary never produces a second one). Statically imported above: a load
  // failure must be a boot failure, never an unhandled rejection inside
  // this handler (fix round 2).
  await consistencyRoute(firestoreDb, res);
});

/**
 * POST /api/internal/test-alert — Stage 4 PR A.
 * Admin only. Fires a real ERROR-severity log line so Don can verify
 * the Cloud Monitoring alert pipeline delivers to his email/phone.
 */
app.post('/api/internal/test-alert', async (req, res) => {
  // 8i: pages Don — the pinned platform operator only.
  if (!requirePlatformOperator(req, res)) return;
  const stamp = new Date().toISOString();
  if ((req.body as any)?.mode === 'demo') {
    // Demo of the grouped consistency summary, from fixed sample data —
    // shows Don exactly what a grouped night looks like on his phone, and
    // can never be mistaken for a real finding. Logging only; no data read
    // or written. Never uses the "[consistency] ERROR" prefix.
    const { demoConsistencySummary } = await import('./src/server/consistency.js');
    const { summary } = demoConsistencySummary(stamp);
    log.error(summary);
    res.json({ ok: true, sentAt: stamp, mode: 'demo', summary });
    return;
  }
  log.error(`[alert-test] TEST ALERT from Shutfey admin at ${stamp}. If you received this, the monitoring pipeline works.`);
  res.json({ ok: true, sentAt: stamp, message: 'Test alert logged. Check your email/phone for the Cloud Monitoring notification.' });
});

/**
 * GET /api/media/status — Check if media storage is configured.
 * Used by the client to gracefully disable media features.
 */
app.get('/api/media/status', (req, res) => {
  res.json({
    configured: media.isMediaConfigured(),
    retentionDays: media.RETENTION_DAYS,
    maxImageBytes: media.MAX_IMAGE_BYTES,
    maxAudioBytes: media.MAX_AUDIO_BYTES,
    allowedMimeTypes: Array.from(media.ALLOWED_MIME_TYPES),
  });
});

/**
 * GET /api/media/check-indexes — Check if Firestore composite indexes are ready.
 * Admin only. Runs the sweeper's queries with limit(1) to detect missing-index errors.
 * Returns per-index readiness. If an index is still building, Firestore throws.
 */
app.get('/api/media/check-indexes', async (req, res) => {
  // 8i: platform infrastructure status — the pinned platform operator only.
  if (!requirePlatformOperator(req, res)) return;
  const db = requireMediaDb(req, res);
  if (!db) return;

  const indexes = [];
  let allReady = true;

  // Index 1: media(state, createdAt) — for stale intent queries
  try {
    await db.collection('media')
      .where('state', 'in', ['INTENT', 'UPLOADED', 'VALIDATED'])
      .where('createdAt', '<', new Date().toISOString())
      .limit(1)
      .get();
    indexes.push({ name: 'media(state, createdAt)', ready: true, detail: 'Query succeeded' });
  } catch (e: any) {
    const isIndexError = e?.message?.includes('index') || e?.code === 9;
    indexes.push({
      name: 'media(state, createdAt)',
      ready: false,
      detail: isIndexError ? 'Index missing or building' : e?.message,
    });
    allReady = false;
  }

  // Index 2: media(state, deleteError) — for failed-delete retry queries
  try {
    await db.collection('media')
      .where('state', '==', 'ABANDONED')
      .where('deleteError', '!=', null)
      .limit(1)
      .get();
    indexes.push({ name: 'media(state, deleteError)', ready: true, detail: 'Query succeeded' });
  } catch (e: any) {
    const isIndexError = e?.message?.includes('index') || e?.code === 9;
    indexes.push({
      name: 'media(state, deleteError)',
      ready: false,
      detail: isIndexError ? 'Index missing or building' : e?.message,
    });
    allReady = false;
  }

  res.json({ indexes, allReady });
});

/**
 * DELETE /api/media/:id/test-cleanup — Delete test-created media.
 * Admin only. NARROWLY SCOPED: only deletes media where attachedTo.entityId
 * starts with 'test-' (e2e test artifacts). Refuses all other deletions.
 * This is for cleaning up after the /admin/media-check e2e test.
 */
app.delete('/api/media/:id/test-cleanup', async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const db = requireMediaDb(req, res);
  if (!db) return;
  try {
    const docRef = db.collection('media').doc(req.params.id);
    const snap = await docRef.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Media not found.' });
      return;
    }
    const doc = snap.data();
    // Narrow scope: only test artifacts (entityId starts with 'test-')
    const entityId = doc.attachedTo?.entityId || '';
    if (!entityId.startsWith('test-')) {
      res.status(403).json({
        error: 'This endpoint only deletes test-created media (entityId must start with test-).',
      });
      return;
    }
    if (!requireSameAgency(req, res, doc, 'media')) return;

    // Delete from Storage, then delete the Firestore doc
    const store = media.getStorage();
    if (store) {
      try {
        await store.storage.bucket(store.bucketName).file(doc.storagePath).delete({ ignoreNotFound: true });
      } catch (e: any) {
        log.warn(`[media] test-cleanup storage delete failed: ${e?.message}`);
      }
    }
    await docRef.delete();
    res.json({ ok: true, deleted: req.params.id });
  } catch (e: any) {
    log.error('[media] test-cleanup error:', e);
    res.status(500).json({ error: 'Cleanup failed.' });
  }
});

/**
 * GET /admin/media-check — Serve the admin media-check HTML page.
 *
 * The HTML itself is NOT sensitive (no secrets in it). The page reads the
 * session token from localStorage and requires a successful admin-only API
 * call before enabling the test buttons. All privileged operations remain
 * protected server-side via requireAdmin().
 */
app.get('/admin/media-check', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin-media-check.html'));
});

// Broadcast announcements — one-way team updates (NOT a chat)
// Categories: assignment, update, notice, urgent. Targeted by role.
app.get('/api/announcements', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const agencyId = caller.agencyId || 'agency-hkc';
  // 5a / RULE T: one helper decides (agency, expiry, role targeting, venue —
  // the TABLET's venue for a kiosk session, whatever the user's role).
  const kioskVenueId = (req as any).kiosk === true ? String((req as any).kioskVenueId || '') : undefined;
  const list = announcements
    .filter((a) => a.agencyId === agencyId)
    .filter((a) => announcementVisibleTo(caller, a, kioskVenueId))
    .map(publicUpdate);
  res.json({
    announcements: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
});

app.post('/api/announcements', async (req, res) => {
  const { title, body, category, targetRoles, venueId, expiresAt } = req.body || {};
  if (!title?.trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }

  // Only admin/coordinator can post announcements — the author is ALWAYS the
  // authenticated session user, never a client-supplied email or name.
  const author = getAuthUser(req);
  if (!author || !['admin', 'coordinator'].includes(author.role)) {
    return res.status(403).json({ error: 'Only admins and coordinators can post announcements.' });
  }

  const agencyId = callerAgencyId(req);
  // An announcement targeted at a venue must reference the caller's own agency venue.
  if (venueId && !requireOwnVenue(req, res, venueId, venues)) return;
  // RULE T: a coordinator MUST target a venue in their scope — posting an
  // agency-wide announcement or to another venue is reserved for admins.
  if (author.role === 'coordinator') {
    if (!venueId || !callerMaySeeVenue(author, venueId)) {
      return res.status(403).json({ error: 'Coordinators can only post announcements for their own venue.' });
    }
  }
  const announcementId = `announce-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.announcements) ? freshDoc.announcements : [];
      const existing = arr.find((a) => a.id === announcementId);
      if (existing) return { doc: freshDoc, result: existing };
      const announcement: Announcement = {
        id: announcementId,
        agencyId,
        authorEmail: author.email,
        authorName: author.name,
        title: String(title).trim(),
        body: String(body || '').trim(),
        category: (['assignment', 'update', 'notice', 'urgent'] as const).includes(category) ? category : 'update',
        // 5a: only known role names; nothing valid → everyone.
        targetRoles: (() => {
          const r = Array.isArray(targetRoles)
            ? [...new Set(targetRoles.filter((x: any) => typeof x === 'string' && KNOWN_ANNOUNCEMENT_ROLES.includes(x)))]
            : [];
          return r.length === 0 || r.includes('all') ? ['all'] : r;
        })(),
        venueId: venueId || undefined,
        createdAt,
        expiresAt: expiresAt || undefined,
      };
      // Keep only last 100 announcements
      const updated = [announcement, ...arr].slice(0, 100);
      return { doc: { ...freshDoc, announcements: updated }, result: announcement };
    },
    { label: 'create-announcement' }
  );
  if (!committed) return;
  const announcement = committed.result as Announcement;

  // Side effects ONLY after commit.
  // RULE T: a venue-targeted announcement pushes only to that venue's users
  // (plus the agency's admins); agency-wide announcements push as before.
  const targets = users.filter((u) =>
    (u.agencyId || 'agency-hkc') === agencyId &&
    (announcement.targetRoles.includes('all') || announcement.targetRoles.includes(u.role)) &&
    (!announcement.venueId || u.role === 'admin' || personAtVenue(u, announcement.venueId))
  );
  const icon = announcement.category === 'urgent' ? '🚨' : announcement.category === 'assignment' ? '📋' : '📢';
  for (const target of targets) {
    if (target.email.toLowerCase() === author.email.toLowerCase()) continue; // Don't notify author
    sendPushToUser(
      target.email,
      `${icon} ${announcement.title}`,
      announcement.body.slice(0, 100),
      { announcementId: announcement.id, type: 'announcement' }
    );
  }
  broadcast('ANNOUNCEMENT', { announcement: publicUpdate(announcement) }, undefined, agencyId);

  res.json({ announcement: publicUpdate(announcement) });
});

app.delete('/api/announcements/:id', async (req, res) => {
  // Same bar as posting: only admins/coordinators, from the session user.
  const caller = getAuthUser(req);
  if (!caller || !['admin', 'coordinator'].includes(caller.role)) {
    return res.status(403).json({ error: 'Only admins and coordinators can delete announcements.' });
  }
  const existing = announcements.find((a) => a.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Announcement not found.' });
  if (!requireSameAgency(req, res, existing, 'announcements')) return;
  // RULE T: a coordinator may delete only announcements at their own venue.
  // Agency-wide announcements (no venueId) are admin-only.
  if (caller.role === 'coordinator') {
    if (!existing.venueId || !callerMaySeeVenue(caller, existing.venueId)) {
      return res.status(403).json({ error: 'Coordinators can only delete announcements for their own venue.' });
    }
  }
  const agencyId = existing.agencyId;
  rememberDeletedAnnouncement(existing);
  const ok = await crudDelete(req, res, 'announcements', req.params.id, {
    label: 'delete-announcement',
    broadcastType: 'ANNOUNCEMENT_DELETED',
    // VenueId rides along so the WS staff filter can scope the delete (an
    // announcement with no venueId is agency-wide and passes for everyone).
    getDeletePayload: () => ({ id: req.params.id, venueId: (existing as any).venueId }),
    getAgencyId: () => agencyId,
  });
  return;
});

// Agency dashboard — overview of all venues with task stats (admin/coordinator)
app.get('/api/admin/dashboard', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  // Dashboard is admin OR coordinator only — 403 otherwise. Both roles may
  // see private-task titles per the #29 visibility rule, so the overdue list
  // below stays within that gate; do not widen the role set later.
  if (caller.role !== 'admin' && caller.role !== 'coordinator') {
    return res.status(403).json({ error: 'Only administrators and coordinators can view the dashboard.' });
  }
  const agencyId = caller.agencyId || 'agency-hkc';
  // RULE T: the admin sees all venues; a coordinator sees only their own
  // venue(s), with totals computed over those only. A coordinator with no
  // venue gets { venues: [], totals: zeros }, 200 (handled below by the
  // empty venue list).
  const dashboardScope = venueScopeFor(caller);
  const agencyVenues = venues
    .filter((v) => (v.agencyId || 'agency-hkc') === agencyId)
    .filter((v) => dashboardScope === 'agency' || dashboardScope.includes(v.id));

  const venueStats = agencyVenues.map((venue) => {
    const venueTasks = tasks.filter((t) => t.venueId === venue.id);
    const completed = venueTasks.filter((t) => t.isCompleted).length;
    const total = venueTasks.length;
    const overdueList = venueTasks.filter((t) => {
      if (t.isCompleted) return false;
      // 6c: exclude any-time tasks before time maths.
      if (isAnyTimeTask(t)) return false;
      // Overdue if target time has passed today
      if (!t.targetTime || t.targetTime === 'End of Day') return false;
      const now = new Date();
      const minutes = taskSortMinutes(t);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      return minutes < nowMinutes;
    });

    // Recent handoff notes (last 3)
    const recentNotes = handoffNotes
      .filter((n) => n.venueId === venue.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);

    // Mashgichim assigned to this venue (with phone numbers for tap-to-call)
    const venueUsers = users
      .filter((u) => (u.agencyId || 'agency-hkc') === agencyId)
      .filter((u) => {
        // User is assigned if they have venueId match or are assigned to venue tasks
        if ((u as any).venueId === venue.id) return true;
        return venueTasks.some((t) =>
          Array.isArray(t.assignedTo) &&
          (t.assignedTo.includes('all') || t.assignedTo.includes(u.email))
        );
      })
      .map((u) => ({
        email: u.email,
        name: u.name,
        phone: (u as any).phone || '',
        role: u.role,
      }));

    // Open incidents
    const openIncidents = incidents
      .filter((i) => i.venueId === venue.id && i.status !== 'resolved')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      venue,
      totalTasks: total,
      completedTasks: completed,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      overdueTasks: overdueList.length,
      overdueTaskList: overdueList.map((t) => ({ id: t.id, title: t.title, targetTime: t.targetTime })),
      recentNotes,
      mashgichim: venueUsers,
      openIncidents: openIncidents.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        reporterName: i.reporterName,
        createdAt: i.createdAt,
      })),
    };
  });

  // Totals over the caller's venues only (RULE T): a coordinator's totals
  // cover their own venue(s), never the agency. A venue-less coordinator gets
  // zeros because venueStats is empty.
  const dashVenueIds = agencyVenues.map((v) => v.id);
  const scopedTasks = tasks.filter(
    (t) => dashVenueIds.includes(t.venueId) && ((t.agencyId || 'agency-hkc') === agencyId)
  );
  const scopedNotes = handoffNotes.filter((n) => dashVenueIds.includes(n.venueId));

  res.json({
    venues: venueStats,
    totals: {
      venueCount: agencyVenues.length,
      totalTasks: scopedTasks.length,
      completedTasks: scopedTasks.filter((t) => t.isCompleted).length,
      totalHandoffNotes: scopedNotes.length,
    },
  });
});

// Shift handoff notes — mashgiach-to-mashgiach communication
app.get('/api/handoff-notes', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const agencyId = caller.agencyId || 'agency-hkc';
  // Per-role venue scoping: a non-admin cannot read another venue's notes
  // via ?venueId (requireOwnVenue alone only proves agency ownership).
  const venueScope = scopedVenueIds(req, res);
  if (!venueScope) return;
  let notes = handoffNotes.filter((n) => (n.agencyId || 'agency-hkc') === agencyId);
  if (venueScope !== 'agency') {
    notes = notes.filter((n) => venueScope.includes(n.venueId));
  }
  res.json({ notes: notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicUpdate) });
});

app.post('/api/handoff-notes', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { content, shift, voiceNoteData } = req.body || {};
  // Kiosk: the note carries the token's venue, not a body venueId.
  const venueId = (req as any).kiosk === true ? (req as any).kioskVenueId : req.body?.venueId;
  if (!venueId || (!content?.trim() && !voiceNoteData)) {
    return res.status(400).json({ error: 'Venue and note content (or voice note) are required.' });
  }
  const noteId = `handoff-${crypto.randomUUID()}`;
  // Notes belong to the caller's agency; the venue must be theirs too.
  // Attribution comes from the VERIFIED session user, never the body.
  const agencyId = caller.agencyId || 'agency-hkc';
  // RULE T: the note's venue must be the caller's own venue (admins: the agency).
  if (!requireVenueAccess(req, res, venueId)) return;
  const createdAt = new Date().toISOString();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.handoffNotes) ? freshDoc.handoffNotes : [];
      const existing = arr.find((n) => n.id === noteId);
      if (existing) return { doc: freshDoc, result: existing };
      const note: HandoffNote = {
        id: noteId,
        agencyId,
        venueId,
        authorEmail: caller.email,
        authorName: caller.name,
        content: String(content || '').trim(),
        shift: shift || 'General',
        voiceNoteData: typeof voiceNoteData === 'string' && voiceNoteData.startsWith('data:audio/') ? voiceNoteData.slice(0, 1000000) : undefined,
        createdAt,
      };
      return { doc: { ...freshDoc, handoffNotes: [note, ...arr] }, result: note };
    },
    { label: 'create-handoff-note' }
  );
  if (!committed) return;
  const note = committed.result as HandoffNote;
  broadcast('HANDOFF_NOTE', { note: publicUpdate(note) }, undefined, note.agencyId);
  res.json({ note: publicUpdate(note) });
});

// ---------------------------------------------------------------------------
// 5a — Updates read state. Per user, per item, recorded when the item was
// actually visible on screen. Stored OUTSIDE the versioned app-state/main
// document (a mark there would bump the global version and give every open
// form a false 409, and readBy arrays would grow toward the 900 KiB limit):
// one small doc per user, updateReads/{agencyId}__{userId}. Not broadcast,
// never part of an announcement/note payload. 5b reads the same store for
// the ✓✓ counts. Without Firestore (local file mode) marks live in memory.
// ---------------------------------------------------------------------------
// 5b: `i` holds alert (incident) marks — same store, same rules.
type UpdateReads = { agencyId: string; userId: string; a: Record<string, string>; n: Record<string, string>; i: Record<string, string>; updatedAt?: string };
const localUpdateReads = new Map<string, UpdateReads>();
const updateReadsKey = (user: UserProfile) => `${(user as any).agencyId || 'agency-hkc'}__${user.id}`;

function emptyUpdateReads(user: UserProfile): UpdateReads {
  return { agencyId: (user as any).agencyId || 'agency-hkc', userId: user.id, a: {}, n: {}, i: {} };
}

/** Read the caller's marks. Identity = the authenticated server-side user, never request fields. */
async function loadUpdateReads(user: UserProfile): Promise<UpdateReads> {
  const key = updateReadsKey(user);
  const empty = emptyUpdateReads(user);
  if (!firestoreDb) return localUpdateReads.get(key) || empty;
  const snap = await firestoreDb.collection('updateReads').doc(key).get();
  return sanitizeUpdateReads(user, snap.exists ? snap.data() : null);
}

function sanitizeUpdateReads(user: UserProfile, d: any): UpdateReads {
  const empty = emptyUpdateReads(user);
  // Fail closed on a doc that is not this user's (should never happen).
  if (!d || d.userId !== user.id || d.agencyId !== empty.agencyId) return empty;
  return { ...empty, a: d.a || {}, n: d.n || {}, i: d.i || {} };
}

const UPDATE_READS_CAP = 5000;
/**
 * Apply new marks ATOMICALLY (a transaction: two devices marking at once
 * never overwrite each other). Pruning keeps only marks for items that still
 * exist. Above UPDATE_READS_CAP per kind, the marks of the OLDEST items are
 * dropped — those items turn back to unread, never the other way round: an
 * item counts as read ONLY when it has its own mark (review round 1: no
 * timestamp floor, so an item nobody saw can never be promoted to read).
 */
async function addUpdateReads(user: UserProfile, annIds: string[], noteIds: string[], alertIds: string[] = []): Promise<number> {
  const key = updateReadsKey(user);
  const now = new Date().toISOString();
  const createdOf = new Map<string, string>();
  for (const x of announcements) createdOf.set(`a:${x.id}`, x.createdAt);
  for (const x of handoffNotes) createdOf.set(`n:${x.id}`, x.createdAt);
  for (const x of incidents) createdOf.set(`i:${x.id}`, x.createdAt);
  let recorded = 0;
  const apply = (rec: UpdateReads): UpdateReads => {
    recorded = 0;
    for (const id of annIds) if (!rec.a[id]) { rec.a[id] = now; recorded++; }
    for (const id of noteIds) if (!rec.n[id]) { rec.n[id] = now; recorded++; }
    for (const id of alertIds) if (!rec.i[id]) { rec.i[id] = now; recorded++; }
    const prune = (kind: 'a' | 'n' | 'i') => {
      const m = rec[kind];
      const live = Object.keys(m).filter((id) => createdOf.has(`${kind}:${id}`));
      live.sort((x, y) => (createdOf.get(`${kind}:${y}`) || '').localeCompare(createdOf.get(`${kind}:${x}`) || ''));
      rec[kind] = Object.fromEntries(live.slice(0, UPDATE_READS_CAP).map((id) => [id, m[id]]));
    };
    prune('a'); prune('n'); prune('i');
    rec.updatedAt = now;
    return rec;
  };
  if (!firestoreDb) {
    const rec = apply({ ...(localUpdateReads.get(key) || emptyUpdateReads(user)) });
    if (recorded > 0) localUpdateReads.set(key, rec);
    return recorded;
  }
  const ref = firestoreDb.collection('updateReads').doc(key);
  await firestoreDb.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    const rec = apply(sanitizeUpdateReads(user, snap.exists ? snap.data() : null));
    if (recorded > 0) tx.set(ref, JSON.parse(JSON.stringify(rec)));
  });
  return recorded;
}

/** An item is read only when it carries the caller's own mark. */
function isRead(rec: UpdateReads, kind: 'a' | 'n' | 'i', id: string, _createdAt?: string): boolean {
  return !!rec[kind][id];
}

/** Notes of ONE venue in the caller's agency (the venue gate below has already applied rule T). */
function notesVisibleAt(user: UserProfile, venueId: string): HandoffNote[] {
  const agencyId = (user as any).agencyId || 'agency-hkc';
  return handoffNotes.filter((n) => (n.agencyId || 'agency-hkc') === agencyId && n.venueId === venueId);
}

/** Shared venue gate for the two routes: kiosk → 403 (read-only, also not on the
 * allowlist); venue must exist in the caller's agency and be in scope. */
function updatesVenueGate(req: any, res: any): { user: UserProfile; venueId: string } | null {
  const user = requireAuthUser(req, res);
  if (!user) return null;
  if ((req as any).kiosk === true) {
    res.status(403).json({ error: 'This kiosk session can only clock in and out.', code: 'KIOSK_SCOPE' });
    return null;
  }
  const venueId = String((req.body && req.body.venueId) || (req.query && req.query.venueId) || '');
  if (!venueId) { res.status(400).json({ error: 'venueId is required.' }); return null; }
  if (!requireVenueAccess(req, res, venueId)) return null;
  return { user, venueId };
}

app.post('/api/updates/seen', async (req, res) => {
  const g = updatesVenueGate(req, res);
  if (!g) return;
  const { user, venueId } = g;
  // Validate BEFORE processing: arrays of strings, combined ≤ 200, de-duplicated.
  const rawA = req.body?.announcementIds ?? [];
  const rawN = req.body?.noteIds ?? [];
  const rawI = req.body?.alertIds ?? [];
  const okArr = (v: any) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200);
  if (!okArr(rawA) || !okArr(rawN) || !okArr(rawI) || rawA.length + rawN.length + rawI.length > 200) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const annIds = [...new Set(rawA as string[])].filter((id) => {
    const a = announcements.find((x) => x.id === id);
    // Skip silently (no existence oracle): unknown, not visible to this user, or another venue's.
    return !!a && announcementVisibleTo(user, a) && (!a.venueId || a.venueId === venueId);
  });
  const visibleNotes = new Set(notesVisibleAt(user, venueId).map((n) => n.id));
  const noteIds = [...new Set(rawN as string[])].filter((id) => visibleNotes.has(id));
  // 5b (A2): an alert mark needs the alert at this venue AND the caller to
  // be one of its recipients — a viewer's mark never counts.
  const alertIds = [...new Set(rawI as string[])].filter((id) => {
    const inc = incidents.find((x) => x.id === id);
    return !!inc && inc.venueId === venueId && isAlertRecipient(user, inc);
  });
  try {
    const recorded = annIds.length + noteIds.length + alertIds.length > 0
      ? await addUpdateReads(user, annIds, noteIds, alertIds) : 0;
    // Aggregate count only — never per-id success/failure.
    res.json({ ok: true, recorded });
  } catch (e: any) {
    console.warn(`[updates/seen] could not record marks: ${String(e?.message || e).slice(0, 120)}`);
    res.status(503).json({ error: 'Could not save. Please retry.', code: 'SAVE_FAILED' });
  }
});

app.get('/api/updates/unread', async (req, res) => {
  const g = updatesVenueGate(req, res);
  if (!g) return;
  const { user, venueId } = g;
  try {
    const rec = await loadUpdateReads(user);
    const email = (user as any).email;
    const agencyId = (user as any).agencyId || 'agency-hkc';
    const anns = announcements
      .filter((a) => a.agencyId === agencyId)
      .filter((a) => announcementVisibleTo(user, a))
      .filter((a) => !a.venueId || a.venueId === venueId) // this venue's sheet: agency-wide + this venue
      .filter((a) => a.authorEmail !== email && !isRead(rec, 'a', a.id, a.createdAt));
    const notes = notesVisibleAt(user, venueId).filter((n) => n.authorEmail !== email && !isRead(rec, 'n', n.id, n.createdAt));
    // 5b (A2 + A3): unread alerts = alerts ROUTED to the caller (recipients
    // only) at this venue, not yet resolved, without the caller's own mark,
    // and not ones the caller acknowledged (badge rule only — acknowledging
    // never writes a read mark, so ✓✓ stays honest).
    const alerts = alertsVisibleAt(user, venueId)
      .filter((i) => isAlertRecipient(user, i) && i.status !== 'resolved' && !isRead(rec, 'i', i.id) &&
        !sameEmail((i as any).acknowledgedBy, email));
    const urgent = anns
      .filter((a) => a.category === 'urgent')
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, 3)
      .map((a) => ({ id: a.id, title: a.title, createdAt: a.createdAt }));
    // The unread ids ride along so the client can put an honest dot on the
    // exact items the counts describe (anns/notes above ARE the unread sets:
    // visible at this venue, not the caller's own, not read).
    res.json({
      announcements: anns.length,
      notes: notes.length,
      alerts: alerts.length,
      urgent,
      unreadAnnouncementIds: anns.map((a) => a.id),
      unreadNoteIds: notes.map((n) => n.id),
      unreadAlertIds: alerts.map((i) => i.id),
    });
  } catch (e: any) {
    console.warn(`[updates/unread] could not read marks: ${String(e?.message || e).slice(0, 120)}`);
    res.status(503).json({ error: 'Could not load. Please retry.', code: 'LOAD_FAILED' });
  }
});

// ---------------------------------------------------------------------------
// 5b — Alerts read receipts (✓✓) and the receiver's own mute.
// ---------------------------------------------------------------------------

/** Alerts of ONE venue the user may see (the venue gate has already applied rule T). */
function alertsVisibleAt(user: UserProfile, venueId: string): Incident[] {
  return incidents.filter((i) => i.venueId === venueId && incidentVisibleTo(user, i));
}

/** Whose read status a viewer may see: the same people their roster shows
 * (getSafeUsersForAgency) — admins see the agency; a coordinator sees users
 * at their own venue(s) plus the agency's admins. Nobody else sees receipts. */
function receiptViewerMaySee(viewer: UserProfile, u: UserProfile): boolean {
  if ((u.agencyId || 'agency-hkc') !== ((viewer as any).agencyId || 'agency-hkc')) return false;
  if (viewer.role === 'admin') return true;
  if (viewer.role !== 'coordinator') return false;
  const scope = venueScopeFor(viewer) as string[];
  return u.role === 'admin' || (typeof (u as any).venueId === 'string' && scope.includes((u as any).venueId));
}

/** The intended readers of an item, as this viewer may see them. Announcements:
 * everyone the announcement is visible to (rule N), minus its author.
 * Alerts: the routing list (alertRecipients), which already excludes the reporter. */
function receiptAudience(viewer: UserProfile, kind: 'a' | 'i', item: any): UserProfile[] {
  const agencyId = (viewer as any).agencyId || 'agency-hkc';
  const base = kind === 'i'
    ? alertRecipients(item)
    : users.filter((u) =>
        (u.agencyId || 'agency-hkc') === agencyId &&
        !sameEmail(u.email, item.authorEmail) &&
        announcementVisibleTo(u, item));
  return base.filter((u) => receiptViewerMaySee(viewer, u));
}

/** Marks of many users at once (each doc read under its owner's identity rules). */
async function loadUpdateReadsMany(list: UserProfile[]): Promise<Map<string, UpdateReads>> {
  const out = new Map<string, UpdateReads>();
  const uniq = [...new Map(list.map((u) => [u.id, u])).values()];
  const recs = await Promise.all(uniq.map((u) => loadUpdateReads(u)));
  uniq.forEach((u, idx) => out.set(u.id, recs[idx]));
  return out;
}

/** Receipts gate: the updates venue gate (kiosk 403, rule T venue) + admin/coordinator only. */
function receiptsGate(req: any, res: any): { user: UserProfile; venueId: string } | null {
  const g = updatesVenueGate(req, res);
  if (!g) return null;
  if (g.user.role !== 'admin' && g.user.role !== 'coordinator') {
    res.status(403).json({ error: 'Only admins and coordinators can see who read an update.', code: 'RECEIPTS_FORBIDDEN' });
    return null;
  }
  return g;
}

/** The items whose receipts this viewer may ask for in THIS venue's sheet. */
function receiptItems(user: UserProfile, venueId: string) {
  const agencyId = (user as any).agencyId || 'agency-hkc';
  const anns = announcements
    .filter((a) => a.agencyId === agencyId)
    .filter((a) => announcementVisibleTo(user, a))
    .filter((a) => !a.venueId || a.venueId === venueId);
  const alerts = alertsVisibleAt(user, venueId);
  return { anns, alerts };
}

// ✓✓ counts for the sheet: { id, read, total } per announcement and alert.
// Counts only — no names here.
app.get('/api/updates/receipts', async (req, res) => {
  const g = receiptsGate(req, res);
  if (!g) return;
  const { user, venueId } = g;
  try {
    const { anns, alerts } = receiptItems(user, venueId);
    const audA = new Map(anns.map((a) => [a.id, receiptAudience(user, 'a', a)]));
    const audI = new Map(alerts.map((i) => [i.id, receiptAudience(user, 'i', i)]));
    const everyone = [...audA.values(), ...audI.values()].flat();
    const marks = await loadUpdateReadsMany(everyone);
    const count = (aud: UserProfile[], kind: 'a' | 'i', id: string) => ({
      id,
      read: aud.filter((u) => { const r = marks.get(u.id); return !!r && isRead(r, kind, id); }).length,
      total: aud.length,
    });
    res.set('Cache-Control', 'private, no-store');
    res.json({
      announcements: anns.map((a) => count(audA.get(a.id) || [], 'a', a.id)),
      alerts: alerts.map((i) => count(audI.get(i.id) || [], 'i', i.id)),
    });
  } catch (e: any) {
    console.warn(`[updates/receipts] could not read marks: ${String(e?.message || e).slice(0, 120)}`);
    res.status(503).json({ error: 'Could not load. Please retry.', code: 'LOAD_FAILED' });
  }
});

// Reader list for ONE item: names + roles (no emails, no ids), who has read
// it and when, and who has not yet. Unknown, other-venue and not-visible
// items answer the same 404.
app.get('/api/updates/receipts/:kind/:id', async (req, res) => {
  const g = receiptsGate(req, res);
  if (!g) return;
  const { user, venueId } = g;
  const kind = req.params.kind === 'announcement' ? 'a' : req.params.kind === 'alert' ? 'i' : null;
  if (!kind) return res.status(404).json({ error: 'Not found.' });
  const { anns, alerts } = receiptItems(user, venueId);
  const item: any = kind === 'a' ? anns.find((a) => a.id === req.params.id) : alerts.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  try {
    const aud = receiptAudience(user, kind, item);
    const marks = await loadUpdateReadsMany(aud);
    const read: { name: string; role: string; readAt: string }[] = [];
    const notYet: { name: string; role: string }[] = [];
    for (const u of aud) {
      const r = marks.get(u.id);
      const at = r ? r[kind][item.id] : undefined;
      if (at) read.push({ name: u.name, role: u.role, readAt: at });
      else notYet.push({ name: u.name, role: u.role });
    }
    read.sort((x, y) => x.readAt.localeCompare(y.readAt));
    notYet.sort((x, y) => x.name.localeCompare(y.name));
    res.set('Cache-Control', 'private, no-store');
    res.json({ id: item.id, read, notYet, total: aud.length });
  } catch (e: any) {
    console.warn(`[updates/receipts] could not read marks: ${String(e?.message || e).slice(0, 120)}`);
    res.status(503).json({ error: 'Could not load. Please retry.', code: 'LOAD_FAILED' });
  }
});

// The receiver controls silence (Don, Oct 19): a per-user mute that makes
// alert pushes SILENT for a while — they are still delivered immediately.
// One small doc per user, alertMute/{agencyId}__{userId}, outside app-state/main.
const localAlertMute = new Map<string, string>();
const ALERT_MUTE_MAX_MINUTES = 24 * 60;

async function loadAlertMuteUntil(user: UserProfile): Promise<string | null> {
  const key = updateReadsKey(user);
  let until: any = null;
  if (!firestoreDb) until = localAlertMute.get(key) || null;
  else {
    const snap = await firestoreDb.collection('alertMute').doc(key).get();
    const d = snap.exists ? snap.data() : null;
    // Fail closed toward LOUD: a doc that is not this user's means no mute.
    if (d && d.userId === user.id && d.agencyId === ((user as any).agencyId || 'agency-hkc')) until = d.until || null;
  }
  return typeof until === 'string' && until > new Date().toISOString() ? until : null;
}

/** Which recipients are muted right now. Bounded: a slow or failing store
 * answers "nobody muted" (loud) after 1.5 s — an alert never waits on a mute. */
async function alertMuteSetFor(list: UserProfile[]): Promise<Set<string>> {
  const lookup = Promise.all(list.map(async (u) => ((await loadAlertMuteUntil(u)) ? u.id : null)))
    .then((ids) => new Set(ids.filter((x): x is string => !!x)));
  const timeout = new Promise<Set<string>>((resolve) => {
    const t = setTimeout(() => resolve(new Set()), 1500);
    (t as any).unref?.();
  });
  return Promise.race([lookup.catch(() => new Set<string>()), timeout]);
}

function alertMuteGate(req: any, res: any): UserProfile | null {
  const user = requireAuthUser(req, res);
  if (!user) return null;
  if ((req as any).kiosk === true) {
    res.status(403).json({ error: 'This kiosk session can only clock in and out.', code: 'KIOSK_SCOPE' });
    return null;
  }
  return user;
}

app.get('/api/updates/alert-mute', async (req, res) => {
  const user = alertMuteGate(req, res);
  if (!user) return;
  try {
    res.json({ mutedUntil: await loadAlertMuteUntil(user) });
  } catch {
    res.status(503).json({ error: 'Could not load. Please retry.', code: 'LOAD_FAILED' });
  }
});

app.put('/api/updates/alert-mute', async (req, res) => {
  const user = alertMuteGate(req, res);
  if (!user) return;
  const minutes = req.body?.minutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > ALERT_MUTE_MAX_MINUTES) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const until = minutes === 0 ? null : new Date(Date.now() + minutes * 60_000).toISOString();
  const key = updateReadsKey(user);
  try {
    if (!firestoreDb) {
      if (until) localAlertMute.set(key, until); else localAlertMute.delete(key);
    } else {
      await firestoreDb.collection('alertMute').doc(key).set({
        agencyId: (user as any).agencyId || 'agency-hkc', userId: user.id, until, updatedAt: new Date().toISOString(),
      });
    }
    res.json({ mutedUntil: until });
  } catch (e: any) {
    console.warn(`[alert-mute] could not save: ${String(e?.message || e).slice(0, 120)}`);
    res.status(503).json({ error: 'Could not save. Please retry.', code: 'SAVE_FAILED' });
  }
});

app.delete('/api/handoff-notes/:id', async (req, res) => {
  const existing = handoffNotes.find((n) => n.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Handoff note not found.' });
  if (!requireSameAgency(req, res, existing, 'handoff notes')) return;
  // A4: mirrors the UI (HandoffNotes.tsx shows delete only on the caller's OWN
  // note). Server: the author, or admin, or a coordinator at the note's venue.
  const delCaller = getAuthUser(req);
  if (!delCaller) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }
  const mayDeleteNote =
    delCaller.role === 'admin' ||
    (existing as any).authorEmail === delCaller.email ||
    (delCaller.role === 'coordinator' && callerMaySeeVenue(delCaller, existing.venueId));
  if (!mayDeleteNote) {
    return res.status(403).json({ error: 'You can only delete your own notes.' });
  }
  const ok = await crudDelete(req, res, 'handoffNotes', req.params.id, {
    label: 'delete-handoff-note',
    broadcastType: 'HANDOFF_NOTE_DELETED',
    // VenueId rides along so the WS staff filter can scope the delete.
    getDeletePayload: () => ({ id: req.params.id, venueId: existing.venueId }),
    getAgencyId: () => existing.agencyId,
  });
  return;
});

// -------------------------------------------------------------
// KOSHER AGENCIES ENDPOINTS (Multi-Tenant Platform Support)
// -------------------------------------------------------------

// Register a brand new Kosher Agency & provision initial workspace
app.post('/api/agencies/register', async (req, res) => {
  const {
    agencyName,
    shortCode,
    certificationSeal,
    region,
    contactPhone,
    adminName,
    adminEmail,
    adminPassword,
    initialVenueName,
    initialVenueCategory,
    includeStarterTemplates = false,
  } = stripServerOnlyUserFields(req.body || {}); // 8b: no server-only identity field from a body

  if (!agencyName || !agencyName.trim()) {
    return res.status(400).json({ error: 'Kosher Agency Name is required (e.g. "Chicago Rabbinical Council (cRc)").' });
  }

  if (!adminEmail || !adminEmail.trim() || !adminEmail.includes('@')) {
    return res.status(400).json({ error: 'A valid Administrator Work Email is required.' });
  }

  if (!adminPassword || adminPassword.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const cleanAdminEmail = adminEmail.trim().toLowerCase();
  if (users.some((u) => u.email.toLowerCase() === cleanAdminEmail)) {
    return res.status(409).json({ error: 'An administrator or staff account with this email already exists on the platform.' });
  }

  const cleanAgencyName = agencyName.trim();
  const agencyId = `agency-${crypto.randomUUID()}`;
  const derivedShortCode =
    (shortCode && shortCode.trim()) ||
    cleanAgencyName
      .split(' ')
      .filter((w) => w.length > 0)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6) ||
    'KOSHER';

  const cleanSeal = (certificationSeal && certificationSeal.trim()) || `${cleanAgencyName} - Kosher Supervision`;
  const cleanRegion = (region && region.trim()) || 'Regional Kashrut Authority';

  // Pre-generate stable IDs + hash password BEFORE the transaction.
  // Random base (stable within this call) so IDs are unique across calls.
  const stamp = crypto.randomUUID();
  const adminUserId = `usr_admin_${stamp}`;
  const venueId = `venue-${stamp}`;
  const createdAt = new Date().toISOString();
  const adminPasswordHash = bcrypt.hashSync(adminPassword.trim(), 10);

  const newAgency: Agency = {
    id: agencyId,
    name: cleanAgencyName,
    shortCode: derivedShortCode,
    adminEmail: cleanAdminEmail,
    certificationSeal: cleanSeal,
    region: cleanRegion,
    contactPhone: contactPhone ? contactPhone.trim() : undefined,
    createdAt,
  };

  const adminUser: UserProfile = {
    id: adminUserId,
    agencyId,
    email: cleanAdminEmail,
    name: (adminName && adminName.trim()) || `${cleanAgencyName} Administrator`,
    role: 'admin',
    avatarColor: '#3b82f6',
    password: adminPasswordHash,
  };

  const venueName = (initialVenueName && initialVenueName.trim()) || `${cleanAgencyName} Certified Kitchen`;
  const venueCategory = (initialVenueCategory && initialVenueCategory.trim()) || 'Food Service';

  const starterVenue: Venue = {
    id: venueId,
    agencyId,
    name: venueName,
    category: venueCategory,
    address: cleanRegion,
    certification: cleanSeal,
    createdAt,
  };

  let starterTasks: TaskItem[] = [];
  if (includeStarterTemplates) {
    const templateCat = venueCategory.toLowerCase().includes('bakery')
      ? 'bakery'
      : venueCategory.toLowerCase().includes('catering')
      ? 'catering'
      : 'restaurant';
    starterTasks = generateTemplateTasks(venueId, templateCat, agencyId);
  }

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshAgencies: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];

      // Idempotency: agency already registered by a previous attempt.
      if (freshAgencies.some((a) => a.id === agencyId)) {
        const ag = freshAgencies.find((a) => a.id === agencyId);
        return { doc: freshDoc, result: { agency: ag, user: freshUsers.find((u) => u.id === adminUserId), venue: starterVenue, tasks: [] } };
      }
      // Email uniqueness against FRESH data (concurrent registrations).
      if (freshUsers.some((u) => u.email.toLowerCase() === cleanAdminEmail)) {
        return { conflict: 'An administrator or staff account with this email already exists on the platform.' };
      }

      const tasksToAdd = starterTasks.filter((t) => !freshTasks.some((ft) => ft.id === t.id));
      // Item 8a: every new agency gets a unique short address, chosen against
      // FRESH data in this transaction (suffix -2, -3 … on a clash), so two
      // concurrent registrations with one short code get different slugs.
      const agencyWithSlug: Agency = {
        ...newAgency,
        slug: uniqueSlug(slugBase(derivedShortCode, cleanAgencyName), freshAgencies, agencyId),
      };
      return {
        doc: {
          ...freshDoc,
          agencies: [...freshAgencies, agencyWithSlug],
          users: [...freshUsers, adminUser],
          venues: [...freshVenues, starterVenue],
          tasks: [...freshTasks, ...tasksToAdd],
        },
        result: { agency: agencyWithSlug, user: adminUser, venue: starterVenue, tasks: tasksToAdd },
      };
    },
    { label: 'register-agency' }
  );
  if (!committed) return;
  const { agency, user, venue, tasks: createdTasks } = committed.result as any;

  // Item 8a: allowlisted views only (admin view to the new admin; the
  // broadcast is reduced to the public profile for non-admin sockets).
  const agencyView = agencyAdminView(agency);
  broadcast('AGENCY_REGISTERED', {
    agency: agencyView,
    adminEmail: cleanAdminEmail,
  }, undefined, agency.id);

  res.status(201).json({
    success: true,
    message: `Welcome to Shutfey! Agency ${cleanAgencyName} has been established.`,
    agency: agencyView,
    user: getSafeUser(user),
    token: signSessionToken(users.find((u) => u.id === user.id) || user),
    venue,
    tasks: createdTasks,
  });
});

// The caller's own agency (public fields only) — never a cross-agency listing.
app.get('/api/agencies', (req, res) => {
  // Privacy: an authenticated user sees ONLY their own agency, and only its
  // public fields (id/name/seal). No admin emails, no user/venue counts,
  // no cross-agency listing.
  const agencyId = callerAgencyId(req);
  const a = agencies.find((x: any) => x.id === agencyId) as any;
  if (!a) return res.status(404).json({ error: 'Agency not found.' });
  const { id, name, certificationSeal, shortCode } = a;
  res.json({ agencies: [{ id, name, certificationSeal, shortCode }] });
});

// Get current agency details for logged in user
app.get('/api/agencies/current', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const agencyId = caller.agencyId || 'agency-hkc';
  const agency = agencies.find((a) => a.id === agencyId) || agencies[0];
  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === agencyId);
  const agencyUsers = users.filter((u) => (u.agencyId || 'agency-hkc') === agencyId);

  // Item 8a: explicit allowlists. The agency's own admin gets the settings
  // view; everyone else the public profile. The DNS proof value is in neither.
  const view = caller.role === 'admin' ? agencyAdminView(agency) : agencyPublicProfile(agency);
  res.json({
    agency: {
      ...view,
      venuesCount: agencyVenues.length,
      workersCount: agencyUsers.length,
    },
  });
});

// Agency administrator updates agency profile details
app.put('/api/agencies/current', async (req, res) => {
  // Agency settings: admin only, verified from the session token.
  const user = requireAdmin(req, res);
  // requireAdmin already sent the 403 — returning here without sending again.
  // (Sending a second response crashes the process: ERR_HTTP_HEADERS_SENT.)
  if (!user) return;
  // Item 8a: domainStatus / domainVerificationToken / domainVerifiedAt /
  // domainLastCheckedAt are SERVER-ONLY — never destructured from the body,
  // so a client can never set them.
  const { name, shortCode, certificationSeal, region, contactPhone, customDomain, timeZone, slug, brandName, logoUrl } = req.body;

  const agencyId = user.agencyId || 'agency-hkc';
  // Item 6: optional agency zone (undefined = unchanged, null/'' = clear ->
  // America/New_York for every venue without its own zone).
  const tzInput = parseTimeZoneInput(timeZone);
  if (tzInput.error) {
    return res.status(400).json({ error: tzInput.error });
  }
  // Item 8a: validate EVERY branded-address field before any write (400,
  // nothing written). undefined = not being changed.
  let newSlug: string | undefined;
  if (slug !== undefined) {
    newSlug = normalizeSlug(slug);
    const err = typeof slug === 'string' ? validateSlug(newSlug) : 'The short address must be text.';
    if (err) return res.status(400).json({ error: err, code: 'INVALID_SLUG' });
  }
  let newBrandName: string | undefined;
  if (brandName !== undefined) {
    const r = validateBrandName(brandName);
    if (r.error) return res.status(400).json({ error: r.error, code: 'INVALID_BRAND' });
    newBrandName = r.value;
  }
  let newLogoUrl: string | undefined;
  if (logoUrl !== undefined) {
    const r = validateLogoUrl(logoUrl);
    if (r.error) return res.status(400).json({ error: r.error, code: 'INVALID_LOGO' });
    newLogoUrl = r.value;
  }
  let newCustomDomain: string | undefined; // undefined = not being changed; '' = clear
  if (customDomain !== undefined && customDomain !== null) {
    if (typeof customDomain !== 'string') {
      return res.status(400).json({ error: 'Enter a web address like app.youragency.org.', code: 'INVALID_DOMAIN' });
    }
    newCustomDomain = normalizeDomain(customDomain);
    if (newCustomDomain) {
      const err = validateDomain(newCustomDomain);
      if (err) return res.status(400).json({ error: err, code: 'INVALID_DOMAIN' });
    }
  } else if (customDomain === null) {
    newCustomDomain = '';
  }
  const zoneNow = serverNow();
  const existing = agencies.find((a) => a.id === agencyId);
  if (!existing) {
    return res.status(404).json({ error: 'Agency record not found.' });
  }

  // Baseline for semantic conflict detection.
  const baseline = { name: existing.name, shortCode: existing.shortCode };

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshAgencies: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
      const freshAgency = freshAgencies.find((a) => a.id === agencyId);
      if (!freshAgency) return { conflict: 'Agency record not found.' };
      // Item 8a: slug + domain uniqueness against FRESH data, normalised on
      // both sides, in the same transaction as the write. Any clash refuses
      // the WHOLE update (all fields commit together or none do).
      if (newSlug !== undefined && findSlugClash(freshAgencies, agencyId, newSlug)) {
        return { conflict: 'That short address is already taken by another agency.' };
      }
      if (newCustomDomain && findDomainClash(freshAgencies, agencyId, newCustomDomain)) {
        return { conflict: 'That domain is already assigned to another agency.' };
      }
      // Conflict if someone else changed a field this request is editing.
      if (name !== undefined && freshAgency.name !== baseline.name) {
        return { conflict: 'Conflict: the agency name was changed by someone else. Please refresh and try again.' };
      }
      let updated: Agency = {
        ...freshAgency,
        name: name !== undefined ? name.trim() : freshAgency.name,
        shortCode: shortCode !== undefined ? shortCode.trim() : freshAgency.shortCode,
        certificationSeal: certificationSeal !== undefined ? certificationSeal.trim() : freshAgency.certificationSeal,
        region: region !== undefined ? region.trim() : freshAgency.region,
        contactPhone: contactPhone !== undefined ? contactPhone.trim() : freshAgency.contactPhone,
      };
      if (newSlug !== undefined) updated.slug = newSlug;
      if (newBrandName !== undefined) {
        if (newBrandName) updated.brandName = newBrandName;
        else delete updated.brandName;
      }
      if (newLogoUrl !== undefined) {
        if (newLogoUrl) updated.logoUrl = newLogoUrl;
        else delete updated.logoUrl;
      }
      // Domain lifecycle (server-only fields): new domain -> pending + fresh
      // token; same domain -> unchanged; '' -> every domain field removed.
      if (newCustomDomain !== undefined) updated = withCustomDomain(updated, newCustomDomain);
      if (tzInput.value !== undefined) {
        if (tzInput.value) (updated as any).timeZone = tzInput.value;
        else delete (updated as any).timeZone;
      }
      const newAgencies = freshAgencies.map((a) => (a.id === agencyId ? updated : a));
      if (tzInput.value === undefined) {
        return { doc: { ...freshDoc, agencies: newAgencies }, result: updated };
      }
      // B3: venues that inherit the agency zone get the prospective rule
      // (never a reset, never a backwards marker). Only this agency changes.
      const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
      const newMarkers = workDatesAfterZoneChange(freshDoc, freshVenues, freshAgencies, freshVenues, newAgencies, zoneNow);
      return { doc: { ...freshDoc, agencies: newAgencies, venueWorkDates: newMarkers }, result: updated };
    },
    { label: 'update-agency', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as Agency;

  // Item 8a: the broadcast carries the ADMIN view (never the DNS proof value);
  // staffVenueFilterPayload reduces it to the public profile for non-admins.
  const adminView = agencyAdminView(updated);
  broadcast('AGENCY_UPDATED', { agency: adminView }, user.email, agencyId);
  res.json({ success: true, agency: adminView });
});


// Resolve the agency for the current hostname (custom-domain portals).
// Public: the login page uses this to show the agency's name on their domain.
app.get('/api/agencies/by-domain', (req, res) => {
  // Item 8a: verified-only, unambiguous match; public profile only.
  const agencyId = agencyIdForHostname(String(req.hostname || ''));
  const agency = agencyId ? agencies.find((a) => a.id === agencyId) : undefined;
  if (!agency) return res.json({ agency: null });
  const pub = agencyPublicProfile(agency);
  res.json({
    agency: {
      id: pub.id,
      name: pub.name,
      shortCode: pub.shortCode,
      certificationSeal: pub.certificationSeal,
    },
  });
});

// -------------------------------------------------------------
// VENUES ENDPOINTS (Multi-Tenant Management Scoped to Kosher Agency)
// -------------------------------------------------------------

// Get venues list. Strictly scoped to the caller's kosher agency!
// TEST ONLY: exposes mock Firestore state for the Stage 2 test suite.
// Registered when FIRESTORE_MOCK=true (local mock) or STAGE2_TEST_MODE=true
// (real-emulator CI). Never enabled in production.
if (process.env.FIRESTORE_MOCK === 'true' || isTestMode()) {
  // TEST ONLY: write a full events array into the stored doc WITHOUT
  // committing (no version bump, no hydration). Lets test-26 stage the
  // production race for fix round 2: the in-memory cache keeps the old
  // assignment while the doc's fresh event is reassigned, so the PUT's
  // in-transaction re-gate must refuse an in-flight save.
  app.post('/api/__test__/doc-set-events', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const db = firestoreDb;
    if (!db) return res.status(503).json({ error: 'db unavailable' });
    const { events } = req.body || {};
    if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
    const docRef = db.collection('app-state').doc('main');
    const snap = await docRef.get();
    const doc = (snap && snap.data && snap.data()) || {};
    await docRef.set({ ...doc, events });
    res.json({ ok: true });
  });
  // TEST ONLY: write a kioskPinLockouts object into the stored doc WITHOUT
  // committing (no version bump, no hydration). Lets test-27 seed STALE
  // lockout entries (fails older than the 15-minute window) so the next
  // kiosk-login commit must prune them (A4). Same pattern as doc-set-events.
  app.post('/api/__test__/doc-set-lockouts', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const db = firestoreDb;
    if (!db) return res.status(503).json({ error: 'db unavailable' });
    const { kioskPinLockouts } = req.body || {};
    if (!kioskPinLockouts || typeof kioskPinLockouts !== 'object') {
      return res.status(400).json({ error: 'kioskPinLockouts object required' });
    }
    const docRef = db.collection('app-state').doc('main');
    const snap = await docRef.get();
    const doc = (snap && snap.data && snap.data()) || {};
    await docRef.set({ ...doc, kioskPinLockouts });
    res.json({ ok: true });
  });
  // TEST ONLY: write a full users array into the stored doc WITHOUT
  // committing (no version bump, no hydration). Lets test-27 stage the
  // finding-2 race for pairing: the cache keeps coordinator P at venue P1
  // while the doc's fresh record sits at P2, so the pair transaction's
  // fresh-caller re-gate must refuse. Same pattern as doc-set-events.
  app.post('/api/__test__/doc-set-users', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const db = firestoreDb;
    if (!db) return res.status(503).json({ error: 'db unavailable' });
    const { users } = req.body || {};
    if (!Array.isArray(users)) return res.status(400).json({ error: 'users array required' });
    const docRef = db.collection('app-state').doc('main');
    const snap = await docRef.get();
    const doc = (snap && snap.data && snap.data()) || {};
    await docRef.set({ ...doc, users });
    res.json({ ok: true });
  });
  // TEST ONLY: seed a media doc directly into the `media` collection so the
  // commit gates can be tested without GCS Storage (unavailable in mock and
  // emulator runs). test-26 uses it for the 2c media validation tests.
  app.post('/api/__test__/media/seed-doc', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const db = requireMediaDb(req, res);
    if (!db) return;
    const { id, agencyId, venueId, state = 'INTENT' } = req.body || {};
    if (!id || !agencyId) {
      return res.status(400).json({ error: 'id and agencyId are required.' });
    }
    await db.collection('media').doc(String(id)).set({
      id: String(id),
      agencyId: String(agencyId),
      venueId: venueId ? String(venueId) : null,
      uploadedBy: 'test-seed',
      state,
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      sha256: '0'.repeat(64),
      storagePath: `media/${agencyId}/${id}.jpg`,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true, id });
  });
  app.get('/api/__test__/firestore-doc', async (req, res) => {
    if (process.env.FIRESTORE_MOCK === 'true') {
      if (!firestoreDb || !firestoreDb._read) {
        return res.status(500).json({ error: 'mock not active' });
      }
      const doc = firestoreDb._read('app-state/main');
      return res.json({ doc, version: doc ? doc._v : null });
    }
    // Real emulator: read via the Admin SDK.
    try {
      const snap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
      const doc = snap.exists ? snap.data() : null;
      return res.json({ doc, version: doc && typeof doc._v === 'number' ? doc._v : null });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'read failed' });
    }
  });

  // TEST ONLY: returns the plaintext reset code for the most recent request
  // for a given email (the code is only in server memory otherwise).
  // Used by test-8 to verify the correct code without admin push access.
  app.get('/api/__test__/last-reset-code', async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    const hit = (global as any).__testLastResetCodes?.[email];
    if (!hit) return res.status(404).json({ error: 'no code recorded for email' });
    res.json({ code: hit.code });
  });

  // TEST ONLY: force-expires the reset request for an email (for expiry tests).
  app.post('/api/__test__/expire-reset', async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    try {
      await commitState(
        (freshDoc) => {
          const freshResets: any[] = Array.isArray(freshDoc.passwordResets) ? freshDoc.passwordResets : [];
          const newResets = freshResets.map((r: any) =>
            r.email === email ? { ...r, expiresAt: new Date(Date.now() - 1000).toISOString() } : r
          );
          return { doc: { ...freshDoc, passwordResets: newResets }, result: { success: true } };
        },
        { label: 'test-expire-reset' }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // TEST ONLY: toggles the staged-revision guard at runtime (round 5).
  // Production uses the STAGED_REVISION env var; the test suite cannot restart
  // the server child process with different env, so this endpoint flips the
  // in-process override instead. Gated by isTestMode() like all __test__
  // endpoints (unreachable on Cloud Run).
  app.post('/api/__test__/staged', async (req, res) => {
    stagedOverride = (req.body || {}).enabled === true ? true : (req.body || {}).enabled === false ? false : undefined;
    res.json({ staged: isStagedRevision() });
  });

  // TEST ONLY: runs the exact scheduled-midnight code path
  // (executeDailyReset with no agencyId — system operation across all
  // agencies). First rolls currentWorkDate back one day so the rollover
  // check genuinely fires (other tests may have already reset today).
  // Used by test-16 to verify per-agency broadcast scoping of scheduled resets.
  app.post('/api/__test__/scheduled-reset', async (req, res) => {
    try {
      // Item 6: rewind every venue's marker one day in its own zone (and the
      // legacy NY marker), so every venue is due on the scheduled path.
      const now = serverNow();
      await commitState(
        (freshDoc) => {
          const fv: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
          const fa: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
          const rewound: Record<string, string> = { ...sanitizeVenueWorkDates(freshDoc.venueWorkDates) };
          for (const v of fv) rewound[v.id] = addDays(workDateIn(venueTimeZoneIn(v, fa), now), -1);
          return {
            doc: {
              ...freshDoc,
              venueWorkDates: rewound,
              currentWorkDate: addDays(workDateIn(DEFAULT_TIME_ZONE, now), -1),
            },
            result: { success: true },
          };
        },
        { label: 'test-rewind-work-date' }
      );
      const committed = await executeDailyReset(undefined, 'test-scheduled-reset', { now });
      res.json({ success: true, version: committed ? committed.version : null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // TEST ONLY (item 6): pin the server clock used by every work-day decision
  // (body { iso: "2026-11-01T05:30:00Z" }), or clear it ({ iso: null }).
  // While pinned, the 60-s interval skips; tests drive ticks themselves.
  app.post('/api/__test__/clock', async (req, res) => {
    const iso = (req.body || {}).iso;
    if (iso === null || iso === undefined || iso === '') {
      testNowOverrideMs = null;
      return res.json({ now: serverNow().toISOString(), pinned: false });
    }
    const ms = Date.parse(String(iso));
    if (!Number.isFinite(ms)) return res.status(400).json({ error: 'bad iso' });
    testNowOverrideMs = ms;
    res.json({ now: serverNow().toISOString(), pinned: true });
  });

  // TEST ONLY (item 6): run ONE scheduled rollover pass at the (fake) clock
  // and await its commit. { parallel: N } instead runs N scheduled resets
  // concurrently straight into the transaction (bypassing the in-flight
  // guard) to prove the transaction alone prevents a double archive.
  app.post('/api/__test__/rollover-tick', async (req, res) => {
    try {
      const parallel = Number((req.body || {}).parallel || 0);
      if (parallel > 1) {
        const now = serverNow();
        const results = await Promise.all(
          Array.from({ length: Math.min(parallel, 5) }, () =>
            executeDailyReset(undefined, 'test-parallel-reset', { now })
          )
        );
        const reset = results.flatMap((c) => (c && Array.isArray(c.result) ? c.result.map((s: any) => s.venueId) : []));
        return res.json({ reset, version: stateVersion });
      }
      const out = await runRolloverTick(serverNow());
      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // TEST ONLY (item 6): run the overdue check at the (fake) clock and return
  // the venue-local dedupe keys it would alert for ({ clear: true } empties
  // the dedupe map first). No push is sent in tests (no VAPID keys).
  app.post('/api/__test__/overdue-check', async (req, res) => {
    if ((req.body || {}).clear === true) overdueNotified.clear();
    res.json({ notified: checkOverdueTasks(serverNow()) });
  });

  // TEST ONLY: injects venues/tasks/agencies/users directly into Firestore
  // (for cross-agency test fixtures that can't be created via the scoped
  // HTTP API). Used by test-10 and test-16.
  // TEST ONLY (5b): who an alert was routed to, and whether silently. No push
  // is sent in tests (no VAPID keys); this is the routing decision itself.
  app.get('/api/__test__/alert-routing', (req, res) => {
    const id = String(req.query.id || '');
    res.json({ routing: testAlertRouting.get(id) || null, attempts: testAlertAttempts.get(id) || 0 });
  });

  app.post('/api/__test__/inject-fixture', async (req, res) => {
    const {
      venues = [], tasks = [], agencies: newAgencies = [], users: newUsers = [],
      events = [], incidents = [], handoffNotes = [], announcements = [],
      taskTemplates = [], eventTaskTemplates = [], approvedIngredients = [], factoryReports = [],
      kioskDevices: newKioskDevices = [], historyLogs = [],
      venueWorkDates: newWorkDates, currentWorkDate: newLegacyWorkDate,
    } = req.body || {};
    try {
      await commitState(
        (freshDoc) => {
          const newVenues = [...(freshDoc.venues || []), ...venues];
          const newTasks = [...(freshDoc.tasks || []), ...tasks];
          const mergedAgencies = [...(freshDoc.agencies || [])];
          for (const a of newAgencies) {
            if (!mergedAgencies.some((x: any) => x && x.id === a.id)) mergedAgencies.push(a);
          }
          const mergedUsers = [...(freshDoc.users || []), ...newUsers];
          return {
            doc: {
              ...freshDoc,
              venues: newVenues, tasks: newTasks, agencies: mergedAgencies, users: mergedUsers,
              events: [...(freshDoc.events || []), ...events],
              incidents: [...(freshDoc.incidents || []), ...incidents],
              handoffNotes: [...(freshDoc.handoffNotes || []), ...handoffNotes],
              announcements: [...(freshDoc.announcements || []), ...announcements],
              taskTemplates: [...(freshDoc.taskTemplates || []), ...taskTemplates],
              eventTaskTemplates: [...(freshDoc.eventTaskTemplates || []), ...eventTaskTemplates],
              approvedIngredients: [...(freshDoc.approvedIngredients || []), ...approvedIngredients],
              factoryReports: [...(freshDoc.factoryReports || []), ...factoryReports],
              kioskDevices: [...(freshDoc.kioskDevices || []), ...newKioskDevices],
              historyLogs: [...(freshDoc.historyLogs || []), ...historyLogs],
              // Item 6 (test-only): pin per-venue markers / the legacy date;
              // a venueWorkDates value of null removes that venue's marker
              // (to simulate pre-item-6 legacy data).
              ...(newWorkDates && typeof newWorkDates === 'object'
                ? {
                    venueWorkDates: Object.fromEntries(
                      Object.entries({ ...(freshDoc.venueWorkDates || {}), ...newWorkDates }).filter(
                        ([, v]) => v !== null
                      )
                    ),
                  }
                : {}),
              ...(newWorkDates === null ? { venueWorkDates: {} } : {}),
              ...(isWorkDate(newLegacyWorkDate) ? { currentWorkDate: newLegacyWorkDate } : {}),
            },
            result: { injected: venues.length + tasks.length + newAgencies.length + newUsers.length + newKioskDevices.length },
          };
        },
        { label: 'test-inject-fixture' }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });
}

// Test-only broadcast-authorization endpoints. Registered ONLY when
// isTestMode() is true (STAGE2_TEST_MODE=true AND not on Cloud Run), in a
// dedicated block separate from the FIRESTORE_MOCK endpoints — they must
// never exist outside test mode, even with FIRESTORE_MOCK=true.
if (isTestMode()) {
  // Item 8k (TEST ONLY; isTestMode() only, never under FIRESTORE_MOCK alone): merge a few top-level fields straight into the
  // stored doc (no route writes them this way); the next commit's hydrate
  // picks them up. 8x: only the legacy app-wide isDemoCleared (test-42 §6
  // keeps exercising the boot loader's cleared branch; no route writes it).
  app.post('/api/__test__/doc-merge', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const db = firestoreDb;
    if (!db) return res.status(503).json({ error: 'db unavailable' });
    const fields = (req.body || {}).fields;
    const allowed = ['isDemoCleared'];
    if (!fields || typeof fields !== 'object' || Object.keys(fields).some((k) => !allowed.includes(k))) {
      return res.status(400).json({ error: `fields must be an object with keys from ${allowed.join(', ')}` });
    }
    const docRef = db.collection('app-state').doc('main');
    const snap = await docRef.get();
    const doc = (snap && snap.data && snap.data()) || {};
    await docRef.set({ ...doc, ...fields });
    res.json({ ok: true });
  });
  // TEST ONLY (8r; isTestMode() only, never under FIRESTORE_MOCK alone): reopen the hourly retention-sweep gate (next tick sweeps).
  app.post('/api/__test__/history-retention-gate', (req, res) => {
    lastRetentionSweepAt = null;
    res.json({ ok: true });
  });
  // ---- Item 8c test hooks (identity migrator). isTestMode() only. ----
  // The next apply call throws after `afterBatches` committed batches (once).
  app.post('/api/__test__/identity-migration-interrupt', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const n = Number((req.body || {}).afterBatches);
    identityMigrationInterruptAfter = Number.isInteger(n) && n > 0 ? n : null;
    res.json({ ok: true, afterBatches: identityMigrationInterruptAfter });
  });
  // The next apply's batch N migrates one 'person-doc-exists' row anyway, so
  // the dual-write final guard must refuse the whole batch (once).
  app.post('/api/__test__/identity-migration-bypass-plan', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const n = Number((req.body || {}).atBatch);
    identityMigrationBypassPlanAtBatch = Number.isInteger(n) && n > 0 ? n : null;
    res.json({ ok: true, atBatch: identityMigrationBypassPlanAtBatch });
  });
  // ---- Item 8d test hooks (session tokens). isTestMode() only. ----
  // Signs arbitrary claims with the server's own secret (iat/exp added unless
  // given), so the suite can present validly signed but malformed tokens.
  app.post('/api/__test__/sign-claims', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const claims = (req.body || {}).claims;
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return res.status(400).json({ error: 'claims object required' });
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = base64url(JSON.stringify({ iat: now, exp: now + 3600, ...claims }));
    const sig = base64url(crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest());
    res.json({ token: `${header}.${payload}.${sig}` });
  });
  // Bumps one row's tokenEpoch by 1 through commitState's tokenEpochBumpIds
  // (the only sanctioned path). 8d has no production writer; the next PR
  // (sign-out other devices on password reset) adds the first real one.
  app.post('/api/__test__/bump-token-epoch', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const userId = String((req.body || {}).userId || '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const committed: any = await commitState(
        (freshDoc) => {
          const fu: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
          const row = fu.find((u) => u && u.id === userId);
          if (!row) return { doc: freshDoc, result: null };
          return { doc: { ...freshDoc, users: [...fu] }, result: { bumped: true }, tokenEpochBumpIds: [userId] };
        },
        { label: 'test-bump-token-epoch' }
      );
      if (!committed?.result?.bumped) return res.status(404).json({ error: 'User not found' });
      const row: any = users.find((u) => u.id === userId);
      res.json({ ok: true, tokenEpoch: row?.tokenEpoch ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });
  // The next migrator call stops after `maxBatches` batches ('batch-cap'), once.
  app.post('/api/__test__/identity-migration-batch-cap', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const n = Number((req.body || {}).maxBatches);
    identityMigrationMaxBatchesOverride = Number.isInteger(n) && n > 0 ? n : null;
    res.json({ ok: true, maxBatches: identityMigrationMaxBatchesOverride });
  });
  // Write or delete one people/emails doc directly (simulates history,
  // corruption and races in the emulator). data null = delete.
  app.post('/api/__test__/identity-doc', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { collection, id, data } = req.body || {};
    if ((collection !== 'people' && collection !== 'emails') || typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'collection people|emails and id required' });
    }
    const ref = firestoreDb.collection(collection).doc(id);
    if (data === null) await ref.delete();
    else await ref.set(data);
    res.json({ ok: true });
  });
  // Read many people/emails docs at once (test assertions).
  app.post('/api/__test__/identity-docs-bulk', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { peopleIds = [], emails = [] } = req.body || {};
    const out: any = { people: {}, emails: {} };
    for (const id of peopleIds) {
      const sn = await firestoreDb.collection('people').doc(String(id)).get();
      out.people[id] = sn && sn.exists ? sn.data() : null;
    }
    for (const e of emails) {
      const sn = await firestoreDb.collection('emails').doc(identityEmailKey(String(e))).get();
      out.emails[e] = sn && sn.exists ? sn.data() : null;
    }
    res.json(out);
  });
  // ---- Item 8b test hooks (identity projections). Registered ONLY under
  // isTestMode() — never under the broader FIRESTORE_MOCK block, never on
  // Cloud Run. ----
  // Read one person's raw identity state: the monolith row's server-only
  // fields plus the people and emails docs (by email when given).
  app.get('/api/__test__/identity-docs', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
      const email = typeof req.query.email === 'string' ? req.query.email : '';
      const personId = typeof req.query.personId === 'string' ? req.query.personId : '';
      const snap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
      const doc = snap && snap.exists ? snap.data() : null;
      const row = userId ? ((doc?.users || []) as any[]).find((u: any) => u && u.id === userId) || null : null;
      const pid = personId || row?.personId || '';
      const pSnap = pid ? await firestoreDb.collection('people').doc(pid).get() : null;
      const eSnap = email ? await firestoreDb.collection('emails').doc(identityEmailKey(email)).get() : null;
      res.json({
        version: doc?._v ?? null,
        row: row
          ? { exists: true, personId: row.personId ?? null, venueAccess: row.venueAccess ?? null, isPrimaryAdmin: row.isPrimaryAdmin ?? null, tokenEpoch: row.tokenEpoch ?? null }
          : { exists: false },
        people: pSnap && pSnap.exists ? pSnap.data() : null,
        emails: eSnap && eSnap.exists ? eSnap.data() : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });
  // Write an emails mapping directly (simulates a mapping owned by someone
  // else, for the fail-closed reassignment test).
  app.post('/api/__test__/identity-seed-email', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { email, personId, status } = req.body || {};
    if (typeof email !== 'string' || typeof personId !== 'string') return res.status(400).json({ error: 'email and personId required' });
    await firestoreDb.collection('emails').doc(identityEmailKey(email)).set({
      personId, status: status === 'retired' ? 'retired' : 'active', verified: false, source: 'admin-entered', addedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });
  // Internal controlled mutation: change one row's email inside commitState
  // (there is no public email-change API; 8b adds none).
  app.post('/api/__test__/identity-set-email', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { userId, email } = req.body || {};
    try {
      const committed = await commitState(
        (freshDoc) => {
          const list: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
          if (!list.some((u) => u && u.id === userId)) return { conflict: 'User not found', conflictStatus: 404 };
          return { doc: { ...freshDoc, users: list.map((u) => (u && u.id === userId ? { ...u, email } : u)) }, result: { ok: true } };
        },
        { label: 'test-identity-set-email' }
      );
      res.json({ ok: true, version: committed.version });
    } catch (err: any) {
      res.status(err?.status || 500).json({ error: err?.message });
    }
  });
  // Internal controlled mutation: ONE commit that removes user X and adds a
  // new row Y (optionally carrying body-sent server-only fields, which the
  // commitState enforcement must discard).
  app.post('/api/__test__/identity-swap', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { removeUserId, newUser } = req.body || {};
    try {
      const committed = await commitState(
        (freshDoc) => {
          const list: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
          const kept = removeUserId ? list.filter((u) => u && u.id !== removeUserId) : list;
          return { doc: { ...freshDoc, users: newUser ? [...kept, newUser] : kept }, result: { ok: true } };
        },
        { label: 'test-identity-swap' }
      );
      res.json({ ok: true, version: committed.version });
    } catch (err: any) {
      res.status(err?.status || 500).json({ error: err?.message });
    }
  });
  // TEST ONLY (item 8t): push targets attempted (recorded before any send).
  // Registered ONLY under isTestMode() — not under the broader FIRESTORE_MOCK
  // block — so mock-without-test-mode and production both get the 404 below.
  app.get('/api/__test__/push-log', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ log: testPushLog });
  });
  app.post('/api/__test__/push-log/clear', (req, res) => {
    if (!requireAdmin(req, res)) return;
    testPushLog.length = 0;
    res.json({ ok: true });
  });
  // TEST ONLY (item 8t): seed a LEGACY push subscription (no userId/agencyId),
  // the shape every subscription had before 8t.
  app.post('/api/__test__/seed-legacy-push-sub', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // (field is subEmail: a global guard rewrites any body userEmail to the caller's)
    const { subEmail: userEmail, endpoint } = req.body || {};
    if (typeof userEmail !== 'string' || typeof endpoint !== 'string') return res.status(400).json({ error: 'subEmail + endpoint required' });
    await commitState((freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.pushSubscriptions) ? freshDoc.pushSubscriptions : [];
      return { doc: { ...freshDoc, pushSubscriptions: [...arr.filter((s) => s.endpoint !== endpoint), { userEmail: userEmail.trim().toLowerCase(), endpoint, keys: { p256dh: 'x', auth: 'y' }, createdAt: new Date().toISOString() }] }, result: null };
    }, { label: 'test-seed-legacy-push-sub' });
    res.json({ ok: true });
  });
  // TEST ONLY: silently revokes a user (removes from the in-memory users array
  // and persists) WITHOUT broadcasting. Lets tests verify broadcast
  // authorization independently of the revocation broadcast (which would
  // close the socket itself). Test mode only — the route does not exist in
  // production (see isTestMode()).
  app.post('/api/__test__/revoke-user-silent', async (req, res) => {
    const { userId } = req.body || {};
    try {
      const committed = await commitState(
        (freshDoc) => {
          const before = (freshDoc.users || []).length;
          const remaining = (freshDoc.users || []).filter((u: any) => u.id !== userId);
          if (remaining.length === before) {
            return { doc: freshDoc, result: { revoked: false } };
          }
          return { doc: { ...freshDoc, users: remaining }, result: { revoked: true } };
        },
        { label: 'test-revoke-user-silent' }
      );
      // commitState hydrates the in-memory cache, so recipientForMeta() sees
      // the revocation immediately — but NOTHING is broadcast.
      if (!committed || !committed.result.revoked) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ ok: true, revoked: userId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // TEST ONLY: drops the authenticated metadata for a user's sockets WITHOUT
  // closing them, simulating a socket that somehow lost its metadata. Lets
  // tests verify that metadata-less sockets are closed (not sent data) on
  // broadcast. Test mode only.
  app.post('/api/__test__/drop-socket-meta', async (req, res) => {
    const { userId } = req.body || {};
    try {
      let dropped = 0;
      for (const [client, meta] of activeSockets) {
        if (meta.userId === userId) {
          activeSockets.delete(client);
          dropped++;
        }
      }
      res.json({ ok: true, dropped });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // TEST ONLY: mints a session JWT for a user ID, signing server-side with
  // getJwtSecret(). Lets tests obtain valid sessions without reading the
  // signing secret from the doc (Test 18's restore cycle strips jwtSecret by
  // design). Test mode only — never a production credential.
  app.post('/api/__test__/mint-token', async (req, res) => {
    const { userId } = req.body || {};
    try {
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId required' });
      }
      const user = users.find((u) => u.id === userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      // Item 8d: the same token login would issue; { legacy: true } forces v1.
      res.json({ token: req.body?.legacy === true ? signToken(userId) : signSessionToken(user as any) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // TEST ONLY (8i): set a user's password (bcrypt) — replaces the harness's
  // use of the public first-run setup route, which 8i closed. Test mode only.
  app.post('/api/__test__/set-password', async (req, res) => {
    const { userId, password } = req.body || {};
    if (!userId || typeof userId !== 'string' || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'userId and password (8+) required' });
    }
    const newHash = await hashPassword(password);
    try {
      await commitState(
        (freshDoc) => {
          const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
          if (!freshUsers.some((u) => u && u.id === userId)) throw new Error('User not found');
          return {
            doc: { ...freshDoc, users: freshUsers.map((u) => (u.id === userId ? { ...u, password: newHash } : u)) },
            result: { userId },
          };
        },
        { label: 'test-set-password' }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(err?.message === 'User not found' ? 404 : 500).json({ error: err?.message });
    }
  });

  // Test-only: mint a kiosk token with arbitrary claims (for malformed-token tests).
  app.post('/api/__test__/mint-kiosk-token', async (req, res) => {
    try {
      const { userId, agencyId, venueId, kiosk, pv, dev } = req.body || {};
      const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const now = Math.floor(Date.now() / 1000);
      const claims: any = { sub: userId, iat: now, exp: now + 3600 };
      if (kiosk !== false) claims.kiosk = true;
      if (agencyId !== undefined) claims.agencyId = agencyId;
      if (venueId !== undefined) claims.venueId = venueId;
      if (pv !== undefined) claims.pv = pv;
      if (dev !== undefined) claims.dev = dev;
      const payload = base64url(JSON.stringify(claims));
      const sig = base64url(
        crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest()
      );
      res.json({ token: `${header}.${payload}.${sig}` });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Test-only: clear kiosk PIN lockouts (for lock-expiry tests).
  app.post('/api/__test__/kiosk-clear-lockouts', async (req, res) => {
    const caller = requireAuthUser(req, res);
    if (!caller || caller.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      await commitState(
        (freshDoc) => ({
          // 2b: also reset the pairing rate-limit buckets, so a test can
          // exercise the pairing start/pair limits from a clean slate.
          doc: { ...freshDoc, kioskPinLockouts: emptyKioskPinLockouts(), kioskPairingLimits: {} },
          result: { cleared: true },
        }),
        { label: 'test-kiosk-clear-lockouts' }
      );
      res.json({ cleared: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Test-only: force-expire one kiosk pairing so test-27 can exercise the
  // expired-code and expired-status paths without waiting ten minutes.
  // Admin-checked like the other state-mutating test hooks (rule AL).
  app.post('/api/__test__/expire-kiosk-pairing', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { pairingId } = req.body || {};
    if (!pairingId || typeof pairingId !== 'string') {
      return res.status(400).json({ error: 'pairingId required' });
    }
    try {
      const committed = await commitState(
        (freshDoc) => {
          const pairings = {
            ...((freshDoc.kioskPairings || {}) as { [k: string]: KioskPairing }),
          };
          const pairing = pairings[pairingId];
          if (!pairing) return { doc: freshDoc, result: { expired: false } };
          // The claim deadline is DERIVED (approvedAt + TTL), so expiring
          // an approved pairing means pushing approvedAt past the whole
          // claim window, not just past now.
          pairings[pairingId] = { ...pairing, expiresAt: Date.now() - 1000, approvedAt: Date.now() - PAIRING_TTL_MS - 1000 };
          return {
            doc: { ...freshDoc, kioskPairings: pairings },
            result: { expired: true },
          };
        },
        { label: 'test-expire-kiosk-pairing' }
      );
      if (!(committed as any)?.result?.expired) {
        return res.status(404).json({ error: 'Pairing not found' });
      }
      res.json({ expired: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });
} else {
  // Item 8t: outside test mode every /api/__test__ path is an explicit 404
  // (none of the hooks above exist; this makes that unambiguous for GETs too).
  app.all(/^\/api\/__test__(\/.*)?$/, (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
}

app.get('/api/venues', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;

  const agencyId = caller.agencyId || 'agency-hkc';
  const isCallerAdmin = caller.role === 'admin';
  const callerVenueId: string | undefined = (caller as any).venueId;

  // Filter venues STRICTLY by caller's agency
  let accessibleVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === agencyId);

  // Kiosk session: the token's venue ONLY, regardless of the user's role
  // (a coordinator on a wall tablet gets the tablet's scope, not coordinator powers).
  if ((req as any).kiosk === true) {
    const kioskVenueId = (req as any).kioskVenueId;
    accessibleVenues = accessibleVenues.filter((v) => v.id === kioskVenueId);
  } else if (!isCallerAdmin) {
    // RULE T: a non-admin with no venue gets [], never the agency's first
    // venue. (Coordinators take the same branch as everyone else now.)
    const scope = venueScopeFor(caller);
    if (scope.length === 0) {
      accessibleVenues = [];
    } else {
      accessibleVenues = accessibleVenues.filter((v) => scope.includes(v.id));
    }
  }

  // Calculate live statistics for each venue
  const venuesWithStats = accessibleVenues.map((v) => {
    const venueTasks = tasks.filter((t) => t.venueId === v.id);
    const completedTasks = venueTasks.filter((t) => t.isCompleted).length;
    const totalTasks = venueTasks.length;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const venueWorkers = users.filter((u) => personAtVenue(u, v.id) && (u.role === 'mashgiach' || u.role === 'worker' || u.role === 'coordinator'));

    return {
      ...v,
      totalTasksToday: totalTasks,
      completedTasksToday: completedTasks,
      completionRate,
      workerCount: venueWorkers.length,
    };
  });

  // Item 8k: the cleared state is per agency (the legacy global flag only
  // steers the boot loader and never an agency's answer).
  res.json({ venues: venuesWithStats, isDemoCleared: agencyIsCleared(agencies as any[], agencyId) });
});

// Admin creates a brand new venue within their agency
/** Item 8v: generic refusal when ownerEmail belongs to a user who may not become this venue's owner. */
const VENUE_OWNER_EMAIL_REFUSAL = "This email can't be used for a new owner.";
app.post('/api/venues', async (req, res) => {
  const {
    name,
    category,
    address,
    certification,
    ownerName,
    ownerEmail,
    ownerPassword,
    templateType,
    timeZone,
  } = stripServerOnlyUserFields(req.body || {}); // 8b: no server-only identity field from a body

  const caller = requireAdmin(req, res);
  // requireAdmin already sent the 403 — see the note above; never double-send.
  if (!caller) return;
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  let callerAgency: Agency | undefined = undefined;

  callerAgency = agencies.find((a) => a.id === callerAgencyId) || agencies[0];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Venue Name is required.' });
  }
  // Item 6: optional IANA zone (absent/'' = follow the agency).
  const tzInput = parseTimeZoneInput(timeZone);
  if (tzInput.error) {
    return res.status(400).json({ error: tzInput.error });
  }

  // Pre-generate stable IDs/timestamps BEFORE the transaction so retries don't duplicate.
  const newVenueId = `venue-${crypto.randomUUID()}`;
  const cleanOwnerEmail = ownerEmail?.trim().toLowerCase() || undefined;
  // Item 8v: an EXISTING user may become the new venue's owner only if they
  // are already an owner in the caller's agency. Anyone else (another
  // agency's user, any admin/coordinator/staff, the platform admin) is
  // refused with one generic 409 and nothing is written — before 8v the
  // mutator silently rewrote that user to { role: 'owner', agencyId: caller's }.
  const ownerEmailRefused = (u: any) =>
    !!u && (u.role !== 'owner' || (normalizeStoredUser(u).agencyId || 'agency-hkc') !== callerAgencyId);
  if (cleanOwnerEmail) {
    const cachedOwner = users.find((u) => typeof u.email === 'string' && u.email.trim().toLowerCase() === cleanOwnerEmail);
    if (ownerEmailRefused(cachedOwner)) {
      return res.status(409).json({ error: VENUE_OWNER_EMAIL_REFUSAL, code: 'OWNER_EMAIL_UNAVAILABLE' });
    }
  }
  const ownerUserId = `usr_owner_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  // Hash the owner password once, outside the transaction (bcrypt is CPU-heavy;
  // the hash is deterministic input to the mutator).
  const ownerPasswordHash = ownerPassword?.trim()
    ? bcrypt.hashSync(ownerPassword.trim(), 10)
    : bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10);

  const newVenue: Venue = {
    id: newVenueId,
    agencyId: callerAgencyId,
    name: name.trim(),
    category: category?.trim() || 'Food Service',
    address: address?.trim() || callerAgency?.region || 'West Hartford, CT',
    certification: certification?.trim() || callerAgency?.certificationSeal || 'Certified Kosher',
    ownerEmail: cleanOwnerEmail,
    createdAt,
    ...(tzInput.value ? { timeZone: tzInput.value } : {}),
  };
  // Item 6: the new venue starts on today's date in its own zone, so its
  // starter tasks are not reset by the next rollover tick.
  const venueNow = serverNow();

  // Generate starter tasks (pure function of inputs — safe to pre-compute).
  const starterTasks = generateTemplateTasks(newVenueId, templateType || 'restaurant', callerAgencyId);

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];

      // Idempotency: venue already created by a previous attempt.
      const existingVenue = freshVenues.find((v) => v.id === newVenueId);
      if (existingVenue) {
        return { doc: freshDoc, result: { venue: existingVenue, tasks: [], owner: null } };
      }

      let newUsers = [...freshUsers];
      let createdOwner: any = null;
      if (cleanOwnerEmail) {
        const existingOwnerIdx = newUsers.findIndex((u) => typeof u.email === 'string' && u.email.trim().toLowerCase() === cleanOwnerEmail);
        // Item 8v: the same rule on FRESH data (the user may have changed
        // role/agency since the cached pre-check).
        if (existingOwnerIdx !== -1 && ownerEmailRefused(newUsers[existingOwnerIdx])) {
          return { conflict: VENUE_OWNER_EMAIL_REFUSAL, conflictStatus: 409, conflictCode: 'OWNER_EMAIL_UNAVAILABLE' };
        }
        if (existingOwnerIdx !== -1) {
          newUsers[existingOwnerIdx] = {
            ...newUsers[existingOwnerIdx],
            venueId: newVenueId,
            role: 'owner',
            agencyId: callerAgencyId,
          };
          createdOwner = newUsers[existingOwnerIdx];
        } else {
          const ownerUser: UserProfile = {
            id: ownerUserId,
            agencyId: callerAgencyId,
            email: cleanOwnerEmail,
            name: ownerName?.trim() || `${name.trim()} Owner`,
            role: 'owner',
            venueId: newVenueId,
            avatarColor: '#d97706',
            password: ownerPasswordHash,
          };
          newUsers.push(ownerUser);
          createdOwner = ownerUser;
        }
      }

      // Atomic: venue + owner + starter tasks all commit together.
      const tasksToAdd = starterTasks.filter((t) => !freshTasks.some((ft) => ft.id === t.id));
      return {
        doc: {
          ...freshDoc,
          venues: [...freshVenues, newVenue],
          users: newUsers,
          tasks: [...freshTasks, ...tasksToAdd],
          // B2: existing venues' markers are materialized from the legacy
          // date in the same commit; the new venue starts on today in its zone.
          venueWorkDates: {
            ...materializedWorkDates(
              freshDoc,
              freshVenues,
              Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [],
              venueNow
            ),
            [newVenueId]: workDateIn(
              venueTimeZoneIn(newVenue, Array.isArray(freshDoc.agencies) ? freshDoc.agencies : []),
              venueNow
            ),
          },
        },
        result: { venue: newVenue, tasks: tasksToAdd, owner: createdOwner },
      };
    },
    { label: 'create-venue' }
  );
  if (!committed) return;
  const { venue, tasks: createdTasks, owner } = committed.result as any;

  broadcast('VENUE_CREATED', {
    venue,
    agencyId: callerAgencyId,
    tasksCount: createdTasks.length,
    owner: owner ? getSafeUser(owner) : null,
  }, undefined, callerAgencyId);

  res.status(201).json({
    success: true,
    venue,
    tasks: createdTasks,
    owner: owner ? getSafeUser(owner) : null,
  });
});

// Admin edits venue details
app.put('/api/venues/:id', async (req, res) => {
  const { id } = req.params;
  const { name, category, address, certification, ownerEmail, timeZone } = req.body;

  const caller = requireAdmin(req, res);
  // requireAdmin already sent the 403 — see the note above; never double-send.
  if (!caller) return;
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const existing = venues.find((v) => v.id === id);
  if (!existing) {
    return res.status(404).json({ error: 'Venue not found.' });
  }

  if (!requireSameAgency(req, res, existing, 'venues')) return;

  // Item 6: optional zone change (undefined = unchanged, null/'' = clear).
  const tzInput = parseTimeZoneInput(timeZone);
  if (tzInput.error) {
    return res.status(400).json({ error: tzInput.error });
  }
  const zoneNow = serverNow();

  // Baseline for semantic conflict detection on name/category/address/timeZone.
  const baseline = {
    name: existing.name,
    category: existing.category,
    address: existing.address,
    timeZone: (existing as any).timeZone || null,
  };

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
      const freshVenue = freshVenues.find((v) => v.id === id);
      if (!freshVenue) return { conflict: 'Venue not found (it may have been deleted).' };
      // Conflict if someone else changed a field this request is editing.
      for (const field of ['name', 'category', 'address'] as const) {
        const newVal = { name, category, address }[field];
        if (newVal !== undefined && (freshVenue as any)[field] !== (baseline as any)[field]) {
          return { conflict: `Conflict: venue ${field} was changed by someone else. Please refresh and try again.` };
        }
      }
      if (tzInput.value !== undefined && ((freshVenue as any).timeZone || null) !== baseline.timeZone) {
        return { conflict: 'Conflict: venue time zone was changed by someone else. Please refresh and try again.' };
      }
      const updated: Venue = {
        ...freshVenue,
        name: name !== undefined ? name.trim() : freshVenue.name,
        category: category !== undefined ? category.trim() : freshVenue.category,
        address: address !== undefined ? address.trim() : freshVenue.address,
        certification: certification !== undefined ? certification.trim() : freshVenue.certification,
        ownerEmail: ownerEmail !== undefined ? ownerEmail?.trim().toLowerCase() : freshVenue.ownerEmail,
      };
      if (tzInput.value !== undefined) {
        if (tzInput.value) (updated as any).timeZone = tzInput.value;
        else delete (updated as any).timeZone;
      }
      const newVenues = freshVenues.map((v) => (v.id === id ? updated : v));
      if (tzInput.value === undefined) {
        return { doc: { ...freshDoc, venues: newVenues }, result: updated };
      }
      // B3: a zone change never resets and never moves a marker backwards.
      const freshAgencies: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
      const newMarkers = workDatesAfterZoneChange(freshDoc, freshVenues, freshAgencies, newVenues, freshAgencies, zoneNow);
      return { doc: { ...freshDoc, venues: newVenues, venueWorkDates: newMarkers }, result: updated };
    },
    { label: 'update-venue', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as Venue;
  broadcast('VENUE_UPDATED', { venue: updated, agencyId: callerAgencyId }, undefined, callerAgencyId);
  // Item 6 (B3a): the venue's zone, its current workday marker and the date
  // of the next local midnight at which it becomes due (computed, not
  // promised from the zone alone).
  const effTz = venueTimeZoneIn(updated, agencies);
  const marker = venueWorkDates[updated.id] || (isWorkDate(currentWorkDate) ? currentWorkDate : null);
  res.json({
    success: true,
    venue: updated,
    effectiveTimeZone: effTz,
    workDate: marker,
    nextResetDate: nextResetDate(effTz, marker, zoneNow),
  });
});

// Admin deletes a venue
app.delete('/api/venues/:id', async (req, res) => {
  const { id } = req.params;

  const caller = requireAdmin(req, res);
  // requireAdmin already sent the 403 — see the note above; never double-send.
  if (!caller) return;
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const existing = venues.find((v) => v.id === id);
  if (!existing) {
    return res.status(404).json({ error: 'Venue not found.' });
  }

  if (!requireSameAgency(req, res, existing, 'venues')) return;

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
      // Idempotent: already deleted → success.
      if (!freshVenues.some((v) => v.id === id)) {
        return { doc: freshDoc, result: { success: true, deletedVenueId: id } };
      }
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      const freshHistory: any[] = Array.isArray(freshDoc.historyLogs) ? freshDoc.historyLogs : [];
      // 2b (finding 6): the venue's paired kiosk tablets die with the
      // venue, in the SAME commit — a device is only usable while its
      // venue exists. Their ids ride the result so the handler can close
      // their sockets after the commit.
      const freshDevices: any[] = Array.isArray(freshDoc.kioskDevices) ? freshDoc.kioskDevices : [];
      const removedDeviceIds = freshDevices.filter((d) => d && d.venueId === id).map((d) => d.id);
      // 9a: the deleted venue leaves every extra venue grant in the SAME
      // commit (sanctioned path). Only rows of the venue's own agency carry
      // it legitimately; a foreign row naming it is pruned too (it never
      // granted anything — reads re-check the venue's agency).
      const venueAccessSetById: Record<string, string[]> = {};
      for (const u of Array.isArray(freshDoc.users) ? freshDoc.users : []) {
        if (u && typeof u.id === 'string' && Array.isArray(u.venueAccess) && u.venueAccess.includes(id) && u.venueId !== id) {
          venueAccessSetById[u.id] = u.venueAccess.filter((x: any) => x !== id);
        }
      }
      // Atomic cascade: venue + its tasks + its history all removed together.
      return {
        venueAccessSetById,
        doc: {
          ...freshDoc,
          venues: freshVenues.filter((v) => v.id !== id),
          tasks: freshTasks.filter((t) => t.venueId !== id),
          historyLogs: freshHistory.filter((h) => h.venueId !== id),
          kioskDevices: freshDevices.filter((d) => d && d.venueId !== id),
        },
        result: { success: true, deletedVenueId: id, removedDeviceIds },
      };
    },
    { label: 'delete-venue', requireVersion: true }
  );
  if (!committed) return;

  // Kill the deleted venue's kiosk sessions immediately (their devices
  // died with the venue above).
  const removedDeviceIds: string[] = (committed as any)?.result?.removedDeviceIds || [];
  for (const deviceId of removedDeviceIds) {
    closeKioskSocketsForDevice(deviceId);
  }
  broadcast('VENUE_DELETED', { deletedVenueId: id, agencyId: callerAgencyId }, undefined, callerAgencyId);
  res.json({ success: true, deletedVenueId: id });
});

// -------------------------------------------------------------
// TASKS ENDPOINTS (Filtered by Venue)
// -------------------------------------------------------------

app.get('/api/tasks', (req, res) => {
  const { venueId } = req.query;

  // Checklist C: resolve the caller by authenticated user ID + agency (never
  // by the client-supplied userEmail query param). Fail closed.
  const caller = getAuthUser(req);
  if (!caller) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  const isCallerAdmin = caller.role === 'admin';
  const callerVenueId = caller.venueId;
  const callerEmailNorm = caller.email.toLowerCase();
  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);

  // RULE T: a non-admin with no venue gets { tasks: [], venue: null, venueId: null },
  // never the first venue. A non-admin ?venueId for another venue is ignored.
  if (!isCallerAdmin) {
    const ownScope = venueScopeFor(caller);
    if (ownScope.length === 0) {
      return res.json({ tasks: [], venue: null, venueId: null });
    }
    if (venueId && !ownScope.includes(String(venueId))) {
      return res.json({ tasks: [], venue: null, venueId: null });
    }
  }

  let targetVenueId = venueId ? String(venueId) : agencyVenues[0]?.id || 'venue-crown-market';

  // Strict tenant boundary: workers and owners only access their assigned venue
  if (!isCallerAdmin) {
    // 9a: an explicitly requested venue inside the caller's scope (checked
    // above) is honoured; no venue requested → the home venue, as before.
    targetVenueId = (venueId ? String(venueId) : callerVenueId) || agencyVenues[0]?.id || 'venue-crown-market';
  } else {
    // If admin requested a venueId, ensure it belongs to their agency
    if (!agencyVenues.some((v) => v.id === targetVenueId) && agencyVenues.length > 0) {
      targetVenueId = agencyVenues[0].id;
    }
  }

  const filteredTasks = tasks.filter(
    (t) => t.venueId === targetVenueId && (t.agencyId || 'agency-hkc') === callerAgencyId
  );
  // Private assignments: shared helper with the WS paths (checklist C).
  const visibleTasks = filteredTasks.filter((t) => canSeeTaskServer(t, caller));
  const activeVenue = agencyVenues.find((v) => v.id === targetVenueId) || agencyVenues[0] || venues[0];

  res.json({
    tasks: visibleTasks,
    venue: activeVenue,
    venueId: targetVenueId,
    currentWorkDate,
    totalTasks: visibleTasks.length,
    completedCount: visibleTasks.filter((t) => t.isCompleted).length,
  });
});

app.post('/api/tasks', async (req, res) => {
  const {
    venueId,
    title,
    description,
    category,
    categories,
    isPrivate,
    inputType,
    customStatusOptions,
    completedStatusValues,
    assignedTo,
    scheduleType,
    daysOfWeek,
    specificDates,
    targetTime,
    targetTimeMinutes: targetTimeMinutesBody,
    targetTime2,
    targetTime2Minutes,
    priority,
    enableOverdueAlert,
    createdByEmail,
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  // Checklist C: resolve the caller by authenticated user ID + agency (never
  // by the client-supplied createdByEmail). Fail closed.
  const caller = getAuthUser(req);
  if (!caller) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  // Permission check: Admin, Coordinator, or user with canAssignTasks permission
  const isAllowedToAssign =
    caller.role === 'admin' ||
    caller.role === 'coordinator' ||
    caller.permissions?.canAssignTasks === true;
  if (!isAllowedToAssign) {
    return res.status(403).json({ error: 'You do not have permission to assign or create new tasks.' });
  }

  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);
  // RULE T: a non-admin with no venue gets 403, never a default venue. An admin
  // without a body venueId falls back to the agency's first venue.
  let targetVenueId: string;
  if (caller.role === 'admin') {
    targetVenueId = venueId || agencyVenues[0]?.id || 'venue-crown-market';
    if (!requireOwnVenue(req, res, targetVenueId, venues)) return;
  } else {
    if (!venueId) {
      return res.status(403).json({ error: 'You can only work in your own venue.' });
    }
    targetVenueId = String(venueId);
    if (!requireVenueAccess(req, res, targetVenueId)) return;
  }

  let defaultStatus = 'pending';
  if (inputType === 'yes_no') {
    defaultStatus = 'no';
  } else if (inputType === 'status_select' && Array.isArray(customStatusOptions) && customStatusOptions.length > 0) {
    defaultStatus = customStatusOptions[0];
  }

  // Generate stable IDs/timestamps BEFORE the transaction so retries reuse them
  // (idempotent: a retried transaction creates the same task, not a duplicate).
  const newTaskId = `task-${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const newTimeKey = targetTimeMinutes(targetTime);

  // 6c: canonical any-time tasks have no clock fields or overdue alert.
  const newTask: TaskItem = normalizeAnyTimeTask({
    id: newTaskId,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    title,
    description: description || '',
    category: category || 'General',
    categories: Array.isArray(categories) && categories.length > 0 ? categories : [category || 'General'],
    isPrivate: isPrivate === true,
    sortOrder: 0, // computed inside the transaction against fresh data
    inputType: inputType || 'yes_no',
    customStatusOptions: Array.isArray(customStatusOptions) && customStatusOptions.length > 0 ? customStatusOptions : undefined,
    completedStatusValues: Array.isArray(completedStatusValues) && completedStatusValues.length > 0 ? completedStatusValues : undefined,
    assignedTo: Array.isArray(assignedTo) && assignedTo.length > 0 ? assignedTo : ['all'],
    scheduleType: scheduleType === 'specific_dates' ? 'specific_dates' : 'recurring',
    daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : [0, 1, 2, 3, 4, 5, 6],
    specificDates: Array.isArray(specificDates) ? specificDates : undefined,
    targetTime: targetTime || 'End of Day',
    targetTimeMinutes: targetTimeMinutesBody !== undefined && targetTimeMinutesBody !== null ? Number(targetTimeMinutesBody) : undefined,
    targetTime2: targetTime2 || undefined,
    targetTime2Minutes: targetTime2Minutes !== undefined && targetTime2Minutes !== null ? Number(targetTime2Minutes) : undefined,
    priority: priority || 'medium',
    enableOverdueAlert: enableOverdueAlert === true,
    currentStatus: defaultStatus,
    isCompleted: false,
    notes: '',
    updatedByEmail: null,
    updatedByName: null,
    updatedAt: null,
    checkIns: [],
    createdAt: nowIso,
  });

  // STAGE 2: transactional commit. The mutator runs against FRESH Firestore
  // data (not in-memory). Sort-order slotting is recomputed inside so
  // concurrent inserts merge correctly instead of clobbering.
  const committed = await commitOrRespond(
    req,
    res,
    (freshDoc) => {
      const freshTasks: TaskItem[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];

      // Idempotency within retries: if this task ID already exists (a previous
      // attempt committed but the response was lost), return it instead of duplicating.
      const existing = freshTasks.find((t) => t.id === newTaskId);
      if (existing) {
        return { doc: freshDoc, result: existing };
      }

      // Slot into manual board order by target time (earliest first).
      const siblings = freshTasks
        .filter((t) => t.venueId === targetVenueId)
        .sort(
          (a, b) =>
            (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
            String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        );
      let insertAt = siblings.findIndex(
        (t) => targetTimeMinutes(t.targetTime) > newTimeKey || (targetTimeMinutes(t.targetTime) === newTimeKey && t.createdAt > nowIso)
      );
      if (insertAt === -1) insertAt = siblings.length;

      const updatedTasks = freshTasks.map((t) => {
        if (t.venueId !== targetVenueId) return t;
        const idx = siblings.findIndex((s) => s.id === t.id);
        if (idx >= insertAt) return { ...t, sortOrder: (t.sortOrder ?? idx) + 1 };
        return t;
      });

      const taskToInsert = { ...newTask, sortOrder: insertAt };
      updatedTasks.push(taskToInsert);
      return { doc: { ...freshDoc, tasks: updatedTasks }, result: taskToInsert };
    },
    { label: 'create-task' }
  );
  if (!committed) return; // error response already sent

  const created = committed.result as TaskItem;

  // Side effects ONLY after successful commit.
  broadcast(
    'TASK_CREATED',
    created,
    createdByEmail,
    created.agencyId || 'agency-hkc',
    (meta, task) => (canSeeTaskServer(task, recipientForMeta(meta)) ? task : null)
  );

  // Phone push to specifically-assigned mashgichim (not for global 'all' tasks).
  // Item 8t: only explicit assignees of the task's agency who may see it;
  // identity-bound delivery.
  for (const recipient of taskPushRecipients(created, users, venues, { explicitOnly: true })) {
    if (createdByEmail && recipient.email.toLowerCase() === createdByEmail.toLowerCase()) continue;
    sendPushToRecipient(
      recipient,
      '📋 New task assigned to you',
      `${created.title}${created.targetTime ? ` — ${created.targetTime}` : ''}`,
      { url: '/', taskId: created.id }
    );
  }

  res.status(201).json(created);
});

// Update task status, notes, or configuration
app.put('/api/tasks/:id', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { id } = req.params;
  const existing = tasks.find((t) => t.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, existing, 'tasks')) return;
  // Kiosk: task must belong to the token's venue, and only the
  // completion/status fields may change (title, notes, assignment, venue,
  // private flag, schedule… → 403 KIOSK_SCOPE).
  if ((req as any).kiosk === true) {
    // K1 (ChatGPT plan review): same venue as the tablet AND visible to the
    // acting user — a private task assigned to someone else is not writable
    // from a tablet even with its id (re-checked on fresh data below).
    if (!kioskMayTouchTask(req, existing)) {
      return res.status(403).json({
        error: 'This kiosk session can only clock in and out.',
        code: 'KIOSK_SCOPE',
      });
    }
    const bodyKeys = Object.keys(req.body || {}).filter(
      (k) => !['userEmail', 'userName', 'expectedVersion', 'operationId'].includes(k)
    );
    // Only the completion/status fields the task board uses; the attribution
    // fields (userEmail/userName) are overwritten server-side from the session
    // anyway. Anything else → 403 KIOSK_SCOPE.
    const allowed = new Set(['currentStatus', 'isCompleted']);
    const forbidden = bodyKeys.filter((k) => !allowed.has(k));
    if (forbidden.length > 0) {
      return res.status(403).json({
        error: 'This kiosk session can only clock in and out.',
        code: 'KIOSK_SCOPE',
      });
    }
  }

  // RULE T: a non-admin phone session may only touch tasks at their own
  // venue (the kiosk branch above already restricts kiosk sessions).
  if ((req as any).kiosk !== true) {
    const caller = getAuthUser(req);
    if (caller && caller.role !== 'admin' && !callerMaySeeVenue(caller, existing.venueId)) {
      return res.status(403).json({ error: 'You can only work on tasks at your own venue.' });
    }
  }

  // Capture pre-update visibility for transition handling (addendum item 1).
  const oldTaskVisibility = {
    isPrivate: existing.isPrivate,
    assignedTo: existing.assignedTo,
    venueId: existing.venueId,
  };

  const {
    currentStatus,
    isCompleted,
    notes,
    title,
    description,
    category,
    categories,
    isPrivate,
    sortOrder,
    inputType,
    customStatusOptions,
    completedStatusValues,
    assignedTo,
    scheduleType,
    daysOfWeek,
    specificDates,
    targetTime,
    targetTimeMinutes,
    targetTime2,
    targetTime2Minutes,
    priority,
    enableOverdueAlert,
  } = req.body;

  const hasStatusChange = currentStatus !== undefined || isCompleted !== undefined || notes !== undefined;
  const isDefinitionEdit =
    title !== undefined ||
    description !== undefined ||
    category !== undefined ||
    categories !== undefined ||
    isPrivate !== undefined ||
    sortOrder !== undefined ||
    inputType !== undefined ||
    customStatusOptions !== undefined ||
    completedStatusValues !== undefined ||
    assignedTo !== undefined ||
    scheduleType !== undefined ||
    daysOfWeek !== undefined ||
    specificDates !== undefined ||
    targetTime !== undefined ||
    targetTimeMinutes !== undefined ||
    targetTime2 !== undefined ||
    priority !== undefined;

  // Permission checks against the VERIFIED session user (never a body email).
  {
    // Check definition edit permissions
    if (isDefinitionEdit) {
      const canAssign =
        caller.role === 'admin' ||
        caller.role === 'coordinator' ||
        caller.permissions?.canAssignTasks === true;
      if (!canAssign) {
        return res.status(403).json({ error: 'You do not have permission to edit task definitions.' });
      }
    }

    // Check fill / complete / notes permission
    if (hasStatusChange) {
      const canFill =
        caller.role === 'admin' ||
        (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
        ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
        (caller.role === 'owner' && caller.permissions?.canFillTasks === true);

      if (!canFill) {
        return res.status(403).json({ error: 'You do not have permission to fill or update task statuses.' });
      }
    }
  }

  // Capture the in-memory snapshot for semantic conflict detection. If the
  // fresh Firestore task differs in a field this request is trying to change,
  // someone else edited it concurrently → 409 (not silent overwrite).
  const baseline = { ...existing };
  const definitionFields: Array<[string, any]> = [
    ['title', title], ['description', description], ['category', category],
    ['inputType', inputType], ['assignedTo', assignedTo], ['priority', priority],
    ['targetTime', targetTime], ['scheduleType', scheduleType],
  ];

  const committed = await commitOrRespond(
    req,
    res,
    (freshDoc) => {
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      const freshTask = freshTasks.find((t) => t.id === id);
      if (!freshTask) {
        return { conflict: 'Task not found (it may have been deleted).' };
      }
      // K1: a kiosk write re-checks venue + private visibility on FRESH data.
      if (!kioskMayTouchTask(req, freshTask)) {
        return { conflict: 'This task changed. Please refresh and try again.' };
      }

      // Semantic conflict check for definition edits: if the caller is
      // changing a field that someone else already changed, refuse rather
      // than silently overwriting their edit.
      if (isDefinitionEdit) {
        for (const [field, newValue] of definitionFields) {
          if (newValue !== undefined && JSON.stringify((freshTask as any)[field]) !== JSON.stringify((baseline as any)[field])) {
            return { conflict: `Conflict: "${field}" was changed by someone else. Please refresh and try again.` };
          }
        }
      }

      // Idempotency for status: if the requested end-state already holds, return it.
      const finalIsCompleted = isCompleted !== undefined ? Boolean(isCompleted) : freshTask.isCompleted;
      const statusAlreadyMatches =
        (currentStatus === undefined || freshTask.currentStatus === currentStatus) &&
        (isCompleted === undefined || freshTask.isCompleted === finalIsCompleted) &&
        (notes === undefined || freshTask.notes === notes);
      if (hasStatusChange && !isDefinitionEdit && statusAlreadyMatches) {
        return { doc: freshDoc, result: freshTask };
      }

      const updatedByEmail = finalIsCompleted ? (caller.email || freshTask.updatedByEmail || null) : null;
      const updatedByName = finalIsCompleted ? (caller.name || freshTask.updatedByName || null) : null;
      const updatedAt = finalIsCompleted ? (hasStatusChange ? new Date().toISOString() : freshTask.updatedAt) : null;

      // 6c: normalize the effective merged time, including partial edits.
      const updated: TaskItem = normalizeAnyTimeTask({
        ...freshTask,
        title: title !== undefined ? title : freshTask.title,
        description: description !== undefined ? description : freshTask.description,
        category: category !== undefined ? category : freshTask.category,
        categories: categories !== undefined ? categories : freshTask.categories,
        isPrivate: isPrivate !== undefined ? isPrivate === true : freshTask.isPrivate,
        sortOrder: sortOrder !== undefined ? Number(sortOrder) : freshTask.sortOrder,
        inputType: inputType !== undefined ? inputType : freshTask.inputType,
        customStatusOptions: customStatusOptions !== undefined ? customStatusOptions : freshTask.customStatusOptions,
        completedStatusValues: completedStatusValues !== undefined ? completedStatusValues : freshTask.completedStatusValues,
        assignedTo: assignedTo !== undefined ? assignedTo : freshTask.assignedTo,
        scheduleType: scheduleType !== undefined ? scheduleType : freshTask.scheduleType,
        daysOfWeek: daysOfWeek !== undefined ? daysOfWeek : freshTask.daysOfWeek,
        specificDates: specificDates !== undefined ? specificDates : freshTask.specificDates,
        targetTime: targetTime !== undefined ? targetTime : freshTask.targetTime,
        targetTimeMinutes: targetTimeMinutes !== undefined ? (targetTimeMinutes === null ? undefined : Number(targetTimeMinutes)) : freshTask.targetTimeMinutes,
        targetTime2: targetTime2 !== undefined ? (targetTime2 || undefined) : freshTask.targetTime2,
        targetTime2Minutes: targetTime2Minutes !== undefined ? (targetTime2Minutes === null ? undefined : Number(targetTime2Minutes)) : freshTask.targetTime2Minutes,
        priority: priority !== undefined ? priority : freshTask.priority,
        enableOverdueAlert: enableOverdueAlert !== undefined ? enableOverdueAlert === true : freshTask.enableOverdueAlert,
        currentStatus: currentStatus !== undefined ? currentStatus : (finalIsCompleted ? freshTask.currentStatus : 'pending'),
        isCompleted: finalIsCompleted,
        notes: notes !== undefined ? notes : freshTask.notes,
        updatedByEmail,
        updatedByName,
        updatedAt,
      });

      const newTasks = freshTasks.map((t) => (t.id === id ? updated : t));
      return { doc: { ...freshDoc, tasks: newTasks }, result: updated };
    },
    { label: 'update-task', requireVersion: true }
  );
  if (!committed) return;

  const updated = committed.result as TaskItem;
  broadcastTaskUpdated(oldTaskVisibility, updated, caller.email);
  res.json(updated);
});

// Remove one check-in entry (tapped by mistake, logged in error).
app.delete('/api/tasks/:id/check-in/:checkInId', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { id, checkInId } = req.params;
  const existing = tasks.find((t) => t.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, existing, 'tasks')) return;
  // Kiosk: task must belong to the token's venue (and be visible to the
  // acting user — K1), and only the caller's OWN check-in may be deleted
  // (clock-out); anyone else's → 403.
  if ((req as any).kiosk === true) {
    if (!kioskMayTouchTask(req, existing)) {
      return res.status(403).json({
        error: 'This kiosk session can only clock in and out.',
        code: 'KIOSK_SCOPE',
      });
    }
  }
  // RULE T: a non-admin phone session may only act on their own venue's tasks.
  if (caller.role !== 'admin' && !callerMaySeeVenue(caller, existing.venueId)) {
    return res.status(403).json({ error: 'You can only work on tasks at your own venue.' });
  }

  const entry = (existing.checkIns || []).find((c: any) => c.id === checkInId);
  if (!entry) {
    return res.status(404).json({ error: 'Check-in not found' });
  }
  if ((req as any).kiosk === true && entry.byEmail !== caller.email) {
    return res.status(403).json({
      error: 'This kiosk session can only clock in and out.',
      code: 'KIOSK_SCOPE',
    });
  }

  // The person who logged it, or anyone with fill permission, can remove it.
  // Identity comes from the VERIFIED session user, never the request body.
  {
    const isLogger = entry.byEmail && entry.byEmail.toLowerCase() === caller.email.toLowerCase();
    const canFill =
      caller.role === 'admin' ||
      (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
      ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
      (caller.role === 'owner' && caller.permissions?.canFillTasks === true);
    if (!isLogger && !canFill) {
      return res.status(403).json({ error: 'You do not have permission to remove checks.' });
    }
  }

  const now = new Date().toISOString();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      const freshTask = freshTasks.find((t) => t.id === id);
      if (!freshTask) return { conflict: 'Task not found.' };
      // K1: a kiosk write re-checks venue + private visibility on FRESH data.
      if (!kioskMayTouchTask(req, freshTask)) return { conflict: 'This task changed. Please refresh and try again.' };
      const freshCheckIns: any[] = Array.isArray(freshTask.checkIns) ? freshTask.checkIns : [];
      // Idempotent: check-in already removed → success.
      if (!freshCheckIns.some((c: any) => c.id === checkInId)) {
        return { doc: freshDoc, result: freshTask };
      }
      const updated: TaskItem = {
        ...freshTask,
        checkIns: freshCheckIns.filter((c: any) => c.id !== checkInId),
        updatedAt: now,
      };
      const newTasks = freshTasks.map((t) => (t.id === id ? updated : t));
      return { doc: { ...freshDoc, tasks: newTasks }, result: updated };
    },
    { label: 'delete-check-in', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as TaskItem;

  broadcastTaskUpdated(updated, updated, caller.email);
  res.json(updated);
});

// Log one repeatable check-in on a task (inputType 'check_in'): every tap
// appends a {byName, byEmail, at} record under the task.
app.post('/api/tasks/:id/check-in', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { id } = req.params;
  const existing = tasks.find((t) => t.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, existing, 'tasks')) return;
  // Kiosk: task must belong to the token's venue and be visible to the
  // acting user (K1: no check-in on someone else's private task).
  if ((req as any).kiosk === true) {
    if (!kioskMayTouchTask(req, existing)) {
      return res.status(403).json({
        error: 'This kiosk session can only clock in and out.',
        code: 'KIOSK_SCOPE',
      });
    }
  }
  // RULE T: a non-admin phone session may only check in at their own venue.
  if ((req as any).kiosk !== true && caller.role !== 'admin' && !callerMaySeeVenue(caller, existing.venueId)) {
    return res.status(403).json({ error: 'You can only work on tasks at your own venue.' });
  }

  const { photoData, photoCaption } = req.body;
  // Fill permission checked against the VERIFIED session user.
  {
    const canFill =
      caller.role === 'admin' ||
      (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
      ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
      (caller.role === 'owner' && caller.permissions?.canFillTasks === true);
    if (!canFill) {
      return res.status(403).json({ error: 'You do not have permission to log checks.' });
    }
  }

  // Stable check-in ID generated BEFORE the transaction so retries don't duplicate.
  const now = new Date().toISOString();
  const checkInId = `checkin-${crypto.randomUUID()}`;
  const checkIn: TaskCheckInItem = {
    id: checkInId,
    byName: caller.name || null,
    byEmail: caller.email || null,
    at: now,
    photoData: typeof photoData === 'string' && photoData.startsWith('data:image/') ? photoData.slice(0, 500000) : undefined, // cap at ~500KB
    photoCaption: typeof photoCaption === 'string' ? photoCaption.slice(0, 200) : undefined,
  };

  const committed = await commitOrRespond(
    req,
    res,
    (freshDoc) => {
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      const freshTask = freshTasks.find((t) => t.id === id);
      if (!freshTask) {
        return { conflict: 'Task not found (it may have been deleted).' };
      }
      // K1: a kiosk write re-checks venue + private visibility on FRESH data.
      if (!kioskMayTouchTask(req, freshTask)) {
        return { conflict: 'This task changed. Please refresh and try again.' };
      }
      // Idempotency: if this check-in ID already exists, return the task as-is.
      const alreadyLogged = (freshTask.checkIns || []).some((c: any) => c.id === checkInId);
      if (alreadyLogged) {
        return { doc: freshDoc, result: freshTask };
      }
      const updated: TaskItem = {
        ...freshTask,
        checkIns: [...(freshTask.checkIns || []), checkIn],
        updatedByEmail: caller.email || freshTask.updatedByEmail || null,
        updatedByName: caller.name || freshTask.updatedByName || null,
        updatedAt: now,
      };
      const newTasks = freshTasks.map((t) => (t.id === id ? updated : t));
      return { doc: { ...freshDoc, tasks: newTasks }, result: updated };
    },
    // NOTE: no requireVersion — check-ins APPEND to the fresh checkIns array
    // (never overwrite user content), so concurrent check-ins are safe and a
    // version gate would only cause spurious 409s on the primary workflow.
    { label: 'task-checkin' }
  );
  if (!committed) return;

  const updated = committed.result as TaskItem;
  broadcastTaskUpdated(updated, updated, caller.email);
  res.json(updated);
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const deletedTask = tasks.find((t) => t.id === id);

  if (!deletedTask) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, deletedTask, 'tasks')) return;
  // A1: role gate mirrors the UI (TaskCardView/TaskTableView only show delete
  // to canUserAssignTasks). B6: the venue check is separate from the role grant.
  const caller = getAuthUser(req);
  if (!caller) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }
  const mayDelete =
    caller.role === 'admin' ||
    caller.role === 'coordinator' ||
    (caller as any).permissions?.canAssignTasks === true;
  if (!mayDelete) {
    return res.status(403).json({ error: 'You do not have permission to delete tasks.' });
  }
  if (caller.role !== 'admin' && !callerMaySeeVenue(caller, deletedTask.venueId)) {
    return res.status(403).json({ error: 'You can only work on tasks at your own venue.' });
  }
  const { venueId: delVenueId, agencyId: delAgencyId } = deletedTask;

  const committed = await commitOrRespond(
    req,
    res,
    (freshDoc) => {
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      // Idempotent: already deleted → success.
      if (!freshTasks.some((t) => t.id === id)) {
        return { doc: freshDoc, result: { success: true, deletedId: id } };
      }
      const newTasks = freshTasks.filter((t) => t.id !== id);
      return { doc: { ...freshDoc, tasks: newTasks }, result: { success: true, deletedId: id } };
    },
    { label: 'delete-task', requireVersion: true }
  );
  if (!committed) return;

  broadcast(
    'TASK_DELETED',
    { id, venueId: delVenueId, agencyId: delAgencyId },
    undefined,
    delAgencyId || 'agency-hkc',
    (meta, base) => {
      // If the deleted task was private and the recipient couldn't see it,
      // they never knew it existed — don't reveal even the id.
      const recipient = recipientForMeta(meta);
      return canSeeTaskServer(deletedTask, recipient) ? base : null;
    }
  );
  res.json({ success: true, deletedId: id });
});

// Admin manual reset daily board for a venue
// Manual resets ALWAYS run (force), even if the board was already reset today
// — unlike the scheduled midnight reset, which skips. The operationId makes
// explicit client retries idempotent; the transaction itself is atomic.
app.post('/api/reset-daily', async (req, res) => {
  // BLOCKER 1 fix: require admin + scope strictly to caller's agency.
  // Previously this endpoint trusted client-supplied userEmail and had no
  // admin check — a non-admin could reset any agency's venues.
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const agencyId = admin.agencyId || 'agency-hkc';

  const { venueId, resetBy, operationId } = req.body;
  // A targeted reset must reference the caller's own agency venue.
  if (venueId && !requireOwnVenue(req, res, venueId, venues)) return;
  try {
    // Await the CONFIRMED transaction before responding or broadcasting.
    // Agency-scoped: only the caller's agency venues are reset.
    const outcome = await executeDailyReset(venueId, resetBy || 'Admin Manual', {
      force: true,
      operationId: operationId || crypto.randomUUID(),
      agencyId,
    });
    // In-memory state was hydrated by commitState — read tasks AFTER the await.
    // Scoped to caller's agency only. executeDailyReset returns the snapshots
    // array; the frontend expects a single snapshot, so send the first
    // (manual resets are agency-scoped, all snapshots are the caller's own).
    const venueTasks = tasks.filter(
      (t) => (!venueId || t.venueId === venueId) && (t.agencyId || 'agency-hkc') === agencyId
    );
    const snaps = outcome && Array.isArray(outcome.result) ? outcome.result : [];
    res.json({ success: true, snapshot: snaps[0] ?? null, tasks: venueTasks });
  } catch (err: any) {
    // Duplicate operation (idempotent retry): return the cached result with
    // 200, not 503. The reset already happened — the client just needs the
    // original response.
    if (err instanceof DuplicateOperationError) {
      const venueTasks = tasks.filter(
        (t) => (!venueId || t.venueId === venueId) && (t.agencyId || 'agency-hkc') === agencyId
      );
      // cachedResult.result is the snapshots array (see executeDailyReset).
      const cachedSnaps = Array.isArray(err.cachedResult?.result) ? err.cachedResult.result : [];
      return res.json({ success: true, snapshot: cachedSnaps[0] ?? null, tasks: venueTasks, duplicate: true });
    }
    res.status(503).json({ error: 'Daily reset failed: ' + (err?.message || 'unknown error') });
  }
});

// Item 8x (Don, Oct 21): Clean Slate (POST /api/admin/clean-slate) is removed
// entirely: no route, no gate, no CLEAN_SLATE_RESET broadcast. The read side
// of the flags it used to write (agencies[].cleanSlateAt via agencyIsCleared,
// legacy app-wide isDemoCleared) stays, because stored data may carry them.


// Admin "Restore demonstration data" — retired in 8i. Every demo seed list is
// empty, so the old handler only DELETED the caller agency's venues, tasks,
// history, events, Airtable configs and approved ingredients (no undo), and
// re-created the seed admin account (usr_admin, empty password) even when an
// admin of another agency called it. 410 for everyone: no state is read or
// written and no user is ever created. (The button is retired in a later UI PR.)
app.post('/api/admin/restore-demo', (req, res) => {
  res.status(410).json({ error: 'There is no demo data to restore.' });
});

/**
 * POST /api/admin/migrate-copy — One-time copy from monolith to per-entity.
 * Admin only. Idempotent: skips docs that already exist, never overwrites.
 * Runs in a single Firestore transaction (all reads before all writes).
 * The monolith is never modified or deleted.
 */
app.post('/api/admin/migrate-copy', async (req, res) => {
  // 8i: platform-wide write — the pinned platform operator only.
  if (!requirePlatformOperator(req, res)) return;
  if (!firestoreDb) {
    res.status(503).json({ error: 'Firestore not available.' });
    return;
  }
  try {
    const { migrateCopy } = await import('./src/server/migration.js');
    if (!stillPlatformOperator(req)) {
      res.status(403).json({ error: PLATFORM_OPERATOR_FORBIDDEN });
      return;
    }
    const result = await migrateCopy(firestoreDb);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    log.error('[migration] copy error:', e);
    res.status(500).json({ error: 'Migration copy failed.', detail: e?.message });
  }
});

/**
 * POST /api/admin/identity-migration — item 8c identity migrator.
 * body { step: 'rows' | 'repair', apply?: boolean, cursor?: string }.
 * Admin only (coordinator / mashgiach / kiosk → 403), CALLER'S AGENCY ONLY
 * (there is no agency parameter). DRY-RUN unless apply === true (strict
 * boolean). Bounded, resumable batches; see src/server/migrate-identity.ts
 * and "8c plan v2". Response: counts, cursor, stopReason and conflicts as
 * user ids + reason codes only (no emails, names, hashes or credentials).
 * Live use is Don's step (dry-run per agency first, then apply on root's OK).
 */
let identityMigrationInterruptAfter: number | null = null; // test hook only (isTestMode)
let identityMigrationBypassPlanAtBatch: number | null = null; // test hook only: exercises the final guard
let identityMigrationMaxBatchesOverride: number | null = null; // test hook only: exercises 'batch-cap' (one call)
app.post('/api/admin/identity-migration', async (req, res) => {
  const caller = requireAdmin(req, res);
  if (!caller) return;
  if (!firestoreDb) {
    res.status(503).json({ error: 'Firestore not available.' });
    return;
  }
  const body = req.body || {};
  const step = body.step;
  if (step !== 'rows' && step !== 'repair') {
    res.status(400).json({ error: "step must be 'rows' or 'repair'." });
    return;
  }
  if (body.cursor !== undefined && body.cursor !== null && typeof body.cursor !== 'string') {
    res.status(400).json({ error: 'cursor must be a string.' });
    return;
  }
  const apply = body.apply === true;
  const agencyId = callerAgencyId(req);
  const mig = await import('./src/server/migrate-identity.js');
  const af = await import('./src/server/agency-fields.js');
  const readDoc = async (collection: string, id: string) => {
    const s = await firestoreDb.collection(collection).doc(id).get();
    return s && s.exists ? s.data() : null;
  };
  const readMonolith = async () => {
    const s = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
    return s && s.exists ? s.data() : {};
  };
  const readSetDocs = async (
    rs: { peopleIds: string[]; emailKeys: string[] },
    read: (c: string, id: string) => Promise<any>
  ) => {
    const people = new Map<string, any>();
    const emails = new Map<string, any>();
    for (const id of rs.peopleIds) people.set(id, await read('people', id));
    for (const k of rs.emailKeys) emails.set(k, await read('emails', k));
    return { people, emails };
  };
  const slugFor = (agencies: any[]): string | null => {
    const ag = (agencies || []).find((a: any) => a && a.id === agencyId);
    if (!ag || (typeof ag.slug === 'string' && ag.slug)) return null;
    const candidate = af.uniqueSlug(af.slugBase(ag.shortCode, ag.name), agencies, agencyId);
    if (af.validateSlug(candidate) || af.findSlugClash(agencies, agencyId, candidate)) return null;
    return candidate;
  };

  const counts = { rowsMigrated: 0, rowsAlreadyMigrated: 0, projectionsRepaired: 0, projectionsOk: 0 };
  let conflicts: Array<{ userId: string; reason: string }> = [];
  let cursor: string | null = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;
  let batches = 0;
  let stopReason: string | null = null;
  let abortReason: string | undefined;
  let slugBackfill: string | undefined;
  let exhausted = false;
  const startCursor = cursor;

  try {
    // Slug backfill (8a rules), rows step only, decided on fresh agencies.
    if (step === 'rows') {
      const doc0 = await readMonolith();
      const ag0 = (doc0.agencies || []).find((a: any) => a && a.id === agencyId);
      if (ag0 && typeof ag0.slug === 'string' && ag0.slug) slugBackfill = 'present';
      else if (!slugFor(doc0.agencies || [])) slugBackfill = 'skipped-invalid';
      else slugBackfill = apply ? 'pending' : 'would-set';
    }

    while (!exhausted) {
      if (batches >= (isTestMode() && identityMigrationMaxBatchesOverride !== null ? identityMigrationMaxBatchesOverride : mig.MAX_BATCHES_PER_CALL)) {
        stopReason = 'batch-cap';
        break;
      }
      // Planning read (outside any transaction); never trusted on apply.
      const doc = await readMonolith();
      const cand = mig.nextCandidates(doc, agencyId, step, cursor);
      if (cand.batch.length === 0 && !(apply && slugBackfill === 'pending')) {
        exhausted = true;
        break;
      }
      if (step === 'rows') {
        const pre = await readSetDocs(mig.rowBatchReadSet(cand.batch), readDoc);
        const plan = mig.planRowBatch(doc, cand.batch, pre.people, pre.emails);
        if (!apply || (plan.migrate.length === 0 && slugBackfill !== 'pending')) {
          // Dry run, or nothing to change: commitState is NOT called.
          counts.rowsMigrated += apply ? 0 : plan.migrate.length;
          conflicts.push(...plan.conflicts);
        } else {
          if (!mig.rowBatchWithinLimits(cand.batch.length)) {
            stopReason = 'aborted';
            abortReason = 'batch-over-limit';
            break;
          }
          let txPlan: { migrate: string[]; conflicts: any[] } = { migrate: [], conflicts: [] };
          let txLast: string | null = null;
          let txMore = false;
          let slugSet = false;
          await commitState(
            (freshDoc, _v, ctx) => {
              // Re-decide everything on the FRESH doc + in-transaction reads.
              txPlan = mig.planRowBatch(freshDoc, ctx.cand.batch, ctx.people, ctx.emails);
              if (isTestMode() && identityMigrationBypassPlanAtBatch === batches + 1) {
                // TEST ONLY: simulate a planner that missed a people-doc
                // collision, so 8b's dual-write final guard must abort the batch.
                const c = txPlan.conflicts.find((x: any) => x.reason === 'person-doc-exists');
                if (c) txPlan = { migrate: [...txPlan.migrate, c.userId], conflicts: txPlan.conflicts.filter((x: any) => x !== c) };
              }
              txLast = ctx.cand.lastId;
              txMore = ctx.cand.more;
              const freshAgencies: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
              const newSlug = slugBackfill === 'pending' ? slugFor(freshAgencies) : null;
              slugSet = !!newSlug;
              if (txPlan.migrate.length === 0 && !newSlug) return { doc: freshDoc, result: null };
              return {
                doc: {
                  ...freshDoc,
                  agencies: newSlug
                    ? freshAgencies.map((a: any) => (a && a.id === agencyId ? { ...a, slug: newSlug } : a))
                    : freshAgencies,
                },
                result: { migrated: txPlan.migrate.length },
                identityMigrateRowIds: txPlan.migrate,
              };
            },
            {
              label: 'identity-migration',
              preReads: async (freshDoc, read) => {
                const c = mig.nextCandidates(freshDoc, agencyId, 'rows', cursor);
                const docs = await readSetDocs(mig.rowBatchReadSet(c.batch), read);
                return { cand: c, ...docs };
              },
            }
          );
          if (slugBackfill === 'pending') slugBackfill = slugSet ? 'set' : 'skipped-invalid';
          counts.rowsMigrated += txPlan.migrate.length;
          conflicts.push(...txPlan.conflicts);
          batches++;
          cursor = txLast ?? cursor;
          if (!txMore) exhausted = true;
          if (isTestMode() && identityMigrationInterruptAfter !== null && batches >= identityMigrationInterruptAfter) {
            identityMigrationInterruptAfter = null;
            throw Object.assign(new Error('test interrupt'), { testInterrupt: true });
          }
          continue;
        }
      } else {
        const pre = await readSetDocs(mig.repairBatchReadSet(cand.batch), readDoc);
        const plan = mig.planRepairBatch(doc, cand.batch, pre.people, pre.emails, new Date().toISOString());
        if (!apply || plan.writes.length === 0) {
          counts.projectionsRepaired += apply ? 0 : plan.repaired.length;
          counts.projectionsOk += plan.ok;
          conflicts.push(...plan.conflicts);
        } else {
          // ONE transaction: monolith + this batch's people/emails read first,
          // re-planned on fresh data; writes ONLY people/emails (never the monolith).
          const txRes = await firestoreDb.runTransaction(async (tx: any) => {
            const ms = await tx.get(firestoreDb.doc(FIRESTORE_STATE_DOC));
            const freshDoc = ms.exists ? ms.data() : {};
            const c = mig.nextCandidates(freshDoc, agencyId, 'repair', cursor);
            const docs = await readSetDocs(mig.repairBatchReadSet(c.batch), async (col, id) => {
              const s = await tx.get(firestoreDb.collection(col).doc(id));
              return s.exists ? s.data() : null;
            });
            const p = mig.planRepairBatch(freshDoc, c.batch, docs.people, docs.emails, new Date().toISOString());
            for (const w of p.writes) tx.set(firestoreDb.collection(w.collection).doc(w.id), w.data);
            return { p, last: c.lastId, more: c.more };
          });
          counts.projectionsRepaired += txRes.p.repaired.length;
          counts.projectionsOk += txRes.p.ok;
          conflicts.push(...txRes.p.conflicts);
          batches++;
          cursor = txRes.last ?? cursor;
          if (!txRes.more) exhausted = true;
          if (isTestMode() && identityMigrationInterruptAfter !== null && batches >= identityMigrationInterruptAfter) {
            identityMigrationInterruptAfter = null;
            throw Object.assign(new Error('test interrupt'), { testInterrupt: true });
          }
          continue;
        }
      }
      // Dry-run / no-op batch: walk on.
      batches++;
      cursor = cand.lastId ?? cursor;
      if (!cand.more) exhausted = true;
    }
  } catch (e: any) {
    if (e?.testInterrupt) {
      identityMigrationBypassPlanAtBatch = null;
      identityMigrationMaxBatchesOverride = null;
      res.status(500).json({ error: 'interrupted (test hook)', nextCursor: cursor, batches });
      return;
    }
    log.warn(`[identity-migration] batch aborted for agency ${agencyId}: ${e?.message}`);
    stopReason = 'aborted';
    abortReason = /Identity conflict/.test(String(e?.message)) ? 'identity-guard' : 'transaction-failed';
  }

  // Final completeness read (whole agency, reads only) once the scan is done.
  let blocked = 0;
  let pending = 0;
  if (exhausted && stopReason === null) {
    const doc = await readMonolith();
    const finalConflicts: any[] = [];
    let c: string | null = null;
    for (;;) {
      const cand = mig.nextCandidates(doc, agencyId, step, c);
      if (!cand.batch.length) break;
      if (step === 'rows') {
        const pre = await readSetDocs(mig.rowBatchReadSet(cand.batch), readDoc);
        const plan = mig.planRowBatch(doc, cand.batch, pre.people, pre.emails);
        pending += plan.migrate.length;
        finalConflicts.push(...plan.conflicts);
      } else {
        const pre = await readSetDocs(mig.repairBatchReadSet(cand.batch), readDoc);
        const plan = mig.planRepairBatch(doc, cand.batch, pre.people, pre.emails, new Date().toISOString());
        pending += plan.repaired.length;
        finalConflicts.push(...plan.conflicts);
      }
      c = cand.lastId;
      if (!cand.more) break;
    }
    if (step === 'rows') {
      const migratedNow = (doc.users || []).filter((u: any) => mig.inScope(u, agencyId) && u.personId).length;
      counts.rowsAlreadyMigrated = Math.max(0, migratedNow - (apply ? counts.rowsMigrated : 0));
    }
    conflicts = finalConflicts;
    blocked = mig.dedupeConflicts(finalConflicts).length;
    // Signed four-state contract: done | batch-cap | blocked | aborted.
    // stopReason says why the walk ended; complete is the only "nothing left"
    // signal (dry-run results and late work are told apart by apply/pending).
    stopReason = blocked > 0 ? 'blocked' : 'done';
  }
  if (isTestMode()) { identityMigrationBypassPlanAtBatch = null; identityMigrationMaxBatchesOverride = null; } // one call only
  const deduped = mig.dedupeConflicts(conflicts as any);
  res.json({
    step,
    apply,
    // true only when the final read found no remaining work AND no conflicts
    // (a dry-run with work to do is stopReason 'done', complete false, pending > 0).
    complete: exhausted && stopReason === 'done' && pending === 0 && blocked === 0,
    stopReason,
    ...(abortReason ? { abortReason } : {}),
    nextCursor: exhausted && stopReason !== 'aborted' ? null : cursor,
    startCursor,
    batches,
    counts,
    pending: exhausted ? pending : undefined,
    blocked: exhausted ? blocked : deduped.length,
    conflicts: deduped,
    ...(slugBackfill ? { slugBackfill } : {}),
  });
});

/**
 * GET /api/admin/per-entity-status — Compare monolith vs per-entity.
 * Admin only. Returns counts, match status, and mismatch details.
 * Never returns password hashes, PINs, or secrets.
 */
app.get('/api/admin/per-entity-status', async (req, res) => {
  // 8i: reports on every agency's records — the pinned platform operator only.
  if (!requirePlatformOperator(req, res)) return;
  if (!firestoreDb) {
    res.status(503).json({ error: 'Firestore not available.' });
    return;
  }
  try {
    const { perEntityStatus } = await import('./src/server/migration.js');
    const result = await perEntityStatus(firestoreDb);
    res.json(result);
  } catch (e: any) {
    log.error('[migration] status error:', e);
    res.status(500).json({ error: 'Status check failed.', detail: e?.message });
  }
});

app.get('/api/history', (req, res) => {
  // Checklist C: resolve the caller by authenticated user ID + agency (never
  // by the client-supplied userEmail query param). Fail closed.
  const caller = getAuthUser(req);
  if (!caller) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  // Per-role venue scoping: non-admin/coordinator with no own venue gets an
  // empty list, never whole-agency history.
  const venueScope = scopedVenueIds(req, res);
  if (!venueScope) return;

  // Filter logs strictly by caller agency, then by the private-task rule.
  const agencyHistory = historyLogsForRecipient(callerAgencyId, caller);

  if (venueScope === 'agency') {
    res.json({ historyLogs: agencyHistory });
  } else {
    res.json({ historyLogs: agencyHistory.filter((h) => venueScope.includes(h.venueId)) });
  }
});

// -------------------------------------------------------------
// KOSHER EVENTS ENDPOINTS
// -------------------------------------------------------------

// ---- Default event task templates ----
// Admin-defined tasks that pre-fill every new event notification.
// The event creator can delete any that don't apply and add event-specific ones.
app.get('/api/event-task-templates', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  // Agency-scoped: the caller's own agency plus global templates (no
  // agencyId). A client-supplied agencyId is ignored — it must never widen
  // the read to another agency.
  const agencyId = caller.agencyId || 'agency-hkc';
  const list = eventTaskTemplates
    .filter((t) => !t.agencyId || t.agencyId === agencyId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json({ templates: list });
});

function canManageTemplates(req: any): boolean {
  // RULE T: default event tasks are agency-wide config — ADMIN ONLY.
  // (The error text already says "Only admins can manage default event tasks.")
  const caller = getAuthUser(req);
  return !!caller && caller.role === 'admin';
}

app.post('/api/event-task-templates', async (req, res) => {
  const { title, agencyId } = req.body;
  if (!canManageTemplates(req)) {
    return res.status(403).json({ error: 'Only admins can manage default event tasks.' });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  const callerAgency = callerAgencyId(req);
  // A client-supplied agencyId must match the caller's agency (or be omitted
  // for a global template) — never another agency.
  if (agencyId && agencyId !== callerAgency) {
    return res.status(403).json({ error: 'You can only create templates for your own agency.' });
  }
  const broadcastAgencyId = (req as any).authUser?.agencyId || 'agency-hkc';
  // sortOrder is computed INSIDE the transaction from fresh data (not the cache),
  // so concurrent creates get correct ordering.
  const template: EventTaskTemplate = {
    id: `etpl-${crypto.randomUUID()}`,
    title: String(title).trim(),
    agencyId: agencyId || undefined,
    sortOrder: 0, // overwritten inside the transaction
  };
  const ok = await crudCreate(req, res, 'eventTaskTemplates',
    () => template,
    {
      label: 'create-event-task-template',
      // Fix sortOrder against fresh data before insert.
      checkDuplicate: (freshDoc, item) => {
        const arr: any[] = Array.isArray(freshDoc.eventTaskTemplates) ? freshDoc.eventTaskTemplates : [];
        if (arr.some((t) => t.id === item.id)) return null; // idempotent path handles it
        item.sortOrder = arr.length;
        return null;
      },
      broadcastType: 'EVENT_TEMPLATES_UPDATED',
      getBroadcastPayload: () => ({ templates: eventTaskTemplates }),
      getAgencyId: () => broadcastAgencyId,
    }
  );
  return;
});

app.delete('/api/event-task-templates/:id', async (req, res) => {
  if (!canManageTemplates(req)) {
    return res.status(403).json({ error: 'Only admins can manage default event tasks.' });
  }
  const broadcastAgencyId = (req as any).authUser?.agencyId || 'agency-hkc';
  const existing = eventTaskTemplates.find((t) => t.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Template not found.' });
  // Global templates (no agencyId) are shared; agency-scoped ones are protected.
  if (existing.agencyId && !requireSameAgency(req, res, existing, 'templates')) return;
  const ok = await crudDelete(req, res, 'eventTaskTemplates', req.params.id, {
    label: 'delete-event-task-template',
    broadcastType: 'EVENT_TEMPLATES_UPDATED',
    getDeletePayload: () => ({ templates: eventTaskTemplates }),
    getAgencyId: () => broadcastAgencyId,
  });
  return;
});

app.get('/api/events', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { venueId } = req.query;

  const agencyId = caller.agencyId || 'agency-hkc';
  const callerRole = caller.role;
  const callerVenueId: string | undefined = (caller as any).venueId;
  const callerEmail = caller.email.toLowerCase();

  // Filter events strictly by agency
  let agencyEvents = events.filter((e) => (e.agencyId || 'agency-hkc') === agencyId);

  // Visibility: admin sees everything; owner/coordinator/mashgiach/worker
  // are filtered by canSeeEventServer (rule T + the assigned-mashgiach
  // exception — see the helper). Other roles keep the venueId-param behavior.
  if (callerRole === 'owner' || callerRole === 'coordinator' ||
      callerRole === 'mashgiach' || callerRole === 'worker') {
    agencyEvents = agencyEvents.filter((e) => canSeeEventServer(e, caller));
  } else if (venueId && venueId !== 'all') {
    if (!requireOwnVenue(req, res, String(venueId), venues)) return;
    agencyEvents = agencyEvents.filter((e) => e.venueId === String(venueId));
  }

  // Sort by date ascending
  agencyEvents.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  res.json({ events: agencyEvents });
});

app.post('/api/events', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const {
    venueId,
    title,
    location,
    date,
    endDate,
    startTime,
    endTime,
    mashgiachType,
    assignedMashgiachEmail,
    assignedMashgiachName,
    externalMashgiach,
    menuAttachmentName,
    menuAttachmentData,
    notes,
    tasks: initialTasks,
  } = req.body;

  if (!title || !location || !date) {
    return res.status(400).json({ error: 'Title, location, and date are required.' });
  }

  const callerAgencyId = caller.agencyId || 'agency-hkc';
  const creatorEmail = caller.email;
  const creatorName = caller.name;

  // A6: anyone may create an event, but a non-admin only at their own venue
  // (the 'venue-crown-market' default applies to admins only).
  let targetVenueId: string;
  if (caller.role === 'admin') {
    targetVenueId = venueId || 'venue-crown-market';
    if (!requireOwnVenue(req, res, targetVenueId, venues)) return;
  } else {
    if (!venueId) {
      return res.status(403).json({ error: 'You can only work in your own venue.' });
    }
    targetVenueId = String(venueId);
    if (!requireVenueAccess(req, res, targetVenueId)) return;
  }
  const targetVenue = venues.find((v) => v.id === targetVenueId);

  // Item 8s: an assigned mashgiach is resolved ONLY within the caller's
  // agency + rule-T roster (resolveAssignableUser). Unknown and
  // other-agency emails get the same 400; the stored name always comes from
  // the resolved in-agency record (the client-supplied name is ignored).
  const effectiveType = mashgiachType || (assignedMashgiachEmail ? 'assigned_user' : externalMashgiach ? 'external' : 'unassigned');
  let resolvedMashgiachEmail: string | undefined = undefined;
  let resolvedMashgiachName: string | undefined = undefined;
  // Any non-empty assignee email is resolved, whatever the type (the client
  // only sends one for assigned_user; an API caller cannot park a foreign
  // email on an external/unassigned event either).
  const assigneeRequested = typeof assignedMashgiachEmail === 'string' && assignedMashgiachEmail.trim() !== '';
  if (assigneeRequested) {
    const matchedUser = resolveAssignableUser(caller, assignedMashgiachEmail, users);
    if (!matchedUser) return res.status(400).json({ error: EVENT_ASSIGNEE_REFUSAL, code: 'ASSIGNEE_NOT_IN_TEAM' });
    resolvedMashgiachEmail = matchedUser.email;
    resolvedMashgiachName = matchedUser.name;
  }

  // Pre-generate ALL stable IDs BEFORE the transaction so retries never duplicate.
  // Random base (stable within this call) so IDs are unique across calls.
  const stamp = crypto.randomUUID();
  const eventId = `evt-${stamp}`;
  const nowIso = new Date().toISOString();

  const starterTasks: EventTaskItem[] = Array.isArray(initialTasks) && initialTasks.length > 0
    ? initialTasks.map((t: any, idx: number) => ({
        id: t.id || `etask-${stamp}-${idx}`,
        title: t.title || 'Event Kosher Inspection Task',
        description: t.description || '',
        category: t.category || 'Inspection',
        isCompleted: Boolean(t.isCompleted),
        notes: t.notes || '',
      }))
    : [
        {
          id: `etask-${stamp}-1`,
          title: 'Tamper-Evident Delivery Seals & Manifest Verification',
          description: 'Inspect seals on all delivery Cambros and containers before venue entry.',
          category: 'Delivery',
          isCompleted: false,
          notes: '',
        },
        {
          id: `etask-${stamp}-2`,
          title: 'Ballroom / Banquet Kitchen Warmers & Bishul Yisroel Check',
          description: 'Verify heating element switches and pilot lights ignited according to standard.',
          category: 'Bishul Yisroel',
          isCompleted: false,
          notes: '',
        },
        {
          id: `etask-${stamp}-3`,
          title: 'Post-Event Kashrut Wrap-up & Meat/Dairy Separation',
          description: 'Ensure all serving gear is crate-sealed and segregated before transport.',
          category: 'Post-Event Wrapup',
          isCompleted: false,
          notes: '',
        },
      ];

  const newEvent: KosherEventItem = {
    id: eventId,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    venueName: targetVenue?.name || 'Supervised Establishment',
    title: title.trim(),
    location: location.trim(),
    date,
    endDate,
    startTime: startTime || '12:00 PM',
    endTime: endTime || '16:00 PM',
    mashgiachType: effectiveType,
    assignedMashgiachEmail: resolvedMashgiachEmail,
    assignedMashgiachName: resolvedMashgiachName,
    externalMashgiach: externalMashgiach && externalMashgiach.name ? {
      name: externalMashgiach.name.trim(),
      phone: externalMashgiach.phone ? externalMashgiach.phone.trim() : '',
      email: externalMashgiach.email ? externalMashgiach.email.trim() : '',
    } : undefined,
    menuAttachmentName: menuAttachmentName || undefined,
    menuAttachmentData: menuAttachmentData || undefined,
    notes: notes || '',
    status: 'confirmed',
    tasks: starterTasks,
    createdByEmail: creatorEmail,
    createdByName: creatorName,
    createdAt: nowIso,
  };

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.events) ? freshDoc.events : [];
      // Idempotency: same event ID already created.
      const existing = arr.find((e) => e.id === eventId);
      if (existing) return { doc: freshDoc, result: { event: existing } };
      // Item 8s: re-resolve the assignee on FRESH data with the caller re-read
      // from freshDoc.users (role/agency/venue may have changed).
      if (assigneeRequested) {
        const freshCaller = (freshDoc.users || []).find((u: any) => u && u.id === (caller as any).id);
        const freshAssignee = resolveAssignableUser(freshCaller, assignedMashgiachEmail, freshDoc.users || []);
        if (!freshAssignee) {
          return { conflict: EVENT_ASSIGNEE_REFUSAL, conflictStatus: 400, conflictCode: 'ASSIGNEE_NOT_IN_TEAM' };
        }
        const withFresh = { ...newEvent, assignedMashgiachEmail: freshAssignee.email, assignedMashgiachName: freshAssignee.name };
        return { doc: { ...freshDoc, events: [...arr, withFresh] }, result: withFresh };
      }
      return { doc: { ...freshDoc, events: [...arr, newEvent] }, result: newEvent };
    },
    { label: 'create-event' }
  );
  if (!committed) return;
  const event = committed.result as KosherEventItem;
  // Item 8s: the assignee as committed (re-resolved on fresh data).
  const committedAssigneeEmail: string | undefined = (event as any)?.assignedMashgiachEmail;

  // Side effects ONLY after commit.
  broadcast('EVENT_CREATED', {
    event,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    assignedMashgiachEmail: committedAssigneeEmail,
  }, undefined, callerAgencyId);

  if (committedAssigneeEmail) {
    const when = event.date ? ` — ${event.date}` : '';
    sendPushToUser(
      committedAssigneeEmail,
      '⭐ New event assignment',
      `${event.title}${when} at ${event.location}`,
      { url: '/', eventId: event.id }
    );
  }

  res.status(201).json({ event });
});

// Item 7: COPY EVENT — "task names only, never assignments."
// An admin (own agency) or a coordinator (own venue, rule T) duplicates an
// event into a NEW, independent event on a date they choose. The copy is
// built from an explicit allowlist — never a spread of the source — so no
// assignment (staff or external), completion, check, note, menu file or
// history can ride along. Fail closed: every other role gets 403.
const EVENT_COPY_TITLE_MAX = 200;

/**
 * Days between a source event's date and endDate: null when it has no
 * endDate (one-day event), 'bad' when either date is malformed or the range
 * is reversed — such a source is refused rather than copied into a corrupt
 * event.
 */
function eventCopySpanDays(src: any): number | null | 'bad' {
  const start = src?.date;
  if (!isWorkDate(start) || addDays(start, 0) !== start) return 'bad';
  const end = src?.endDate;
  if (end === undefined || end === null || end === '') return null;
  if (!isWorkDate(end) || addDays(end, 0) !== end) return 'bad';
  const span = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  return span >= 0 ? span : 'bad';
}

/**
 * Rule T for copying, from ONE place for the pre-check and the in-transaction
 * re-check: admin of the event's agency, or a coordinator whose venue is the
 * event's venue. Everyone else (incl. kiosk sessions, whose acting user is
 * never admin/coordinator) is refused.
 */
function mayCopyEvent(user: any, event: any): boolean {
  if (!user || !event) return false;
  if ((user.agencyId || 'agency-hkc') !== (event.agencyId || 'agency-hkc')) return false;
  if (user.role === 'admin') return true;
  return user.role === 'coordinator' && callerMaySeeVenue(user, event.venueId);
}

/** The event template the copy carries: definition fields + task names. */
function buildEventCopy(
  src: any,
  opts: { eventId: string; stamp: string; date: string; title: string; venueName: string; caller: { email: string; name: string }; nowIso: string }
): KosherEventItem {
  const srcTasks: any[] = Array.isArray(src?.tasks) ? src.tasks : [];
  const span = eventCopySpanDays(src);
  const endDate = typeof span === 'number' ? addDays(opts.date, span) : undefined;
  const copy: KosherEventItem = {
    id: opts.eventId,
    agencyId: src.agencyId || 'agency-hkc',
    venueId: src.venueId,
    venueName: opts.venueName,
    title: opts.title,
    location: typeof src.location === 'string' ? src.location : '',
    date: opts.date,
    ...(endDate ? { endDate } : {}),
    ...(typeof src.startTime === 'string' && src.startTime ? { startTime: src.startTime } : {}),
    ...(typeof src.endTime === 'string' && src.endTime ? { endTime: src.endTime } : {}),
    mashgiachType: 'unassigned',
    notes: '',
    status: 'confirmed',
    tasks: srcTasks.map((t: any, idx: number) => ({
      id: `etask-${opts.stamp}-${idx}`,
      title: typeof t?.title === 'string' && t.title.trim() ? t.title : 'Event Kosher Inspection Task',
      description: typeof t?.description === 'string' ? t.description : '',
      category: typeof t?.category === 'string' && t.category ? t.category : 'Inspection',
      isCompleted: false,
      notes: '',
    })),
    createdByEmail: opts.caller.email,
    createdByName: opts.caller.name,
    createdAt: opts.nowIso,
  };
  return copy;
}

app.post('/api/events/:id/copy', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  // A retry of a copy that already committed gets that copy back, even if the
  // source, the venue, the caller's access or "today" changed since (plan v2).
  if (await replayCommittedOperation(req, res, 'copy-event')) return;
  const { id } = req.params;
  const source = events.find((e) => e.id === id);
  if (!source) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (!requireSameAgency(req, res, source, 'events')) return;
  // Rule T, fail closed: admin = whole agency; coordinator = own venue(s).
  if (caller.role !== 'admin' && caller.role !== 'coordinator') {
    return res.status(403).json({ error: 'Only an admin or coordinator can copy events.' });
  }
  if (!mayCopyEvent(caller, source)) {
    return res.status(403).json({ error: 'You can only work in your own venue.' });
  }
  // The copy stays at the source event's venue, which must EXIST (explicit:
  // requireOwnVenue alone tolerates dangling references) and be this agency's.
  const venue = venues.find((v) => v && v.id === source.venueId);
  if (!venue) {
    return res.status(409).json({ error: "This event's venue no longer exists, so it can't be copied." });
  }
  if (!requireOwnVenue(req, res, venue.id, venues)) return;
  if (eventCopySpanDays(source) === 'bad') {
    return res.status(409).json({ error: "This event's dates are not valid, so it can't be copied." });
  }

  const body = req.body || {};
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  if (!isWorkDate(date) || addDays(date, 0) !== date) {
    return res.status(400).json({ error: 'Pick a valid date for the copy.' });
  }
  // "Today" is the venue's local date (item 6), never the server's UTC day.
  const venueToday = workDateIn(venueTimeZoneIn(venue, agencies), serverNow());
  if (date < venueToday) {
    return res.status(400).json({ error: 'Pick today or a later date.' });
  }
  let title = (typeof source.title === 'string' ? source.title : '').trim() || 'Kosher Event';
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return res.status(400).json({ error: 'The event name cannot be empty.' });
    }
    title = body.title.trim();
    if (title.length > EVENT_COPY_TITLE_MAX) {
      return res.status(400).json({ error: `Keep the event name under ${EVENT_COPY_TITLE_MAX} characters.` });
    }
  }

  // Stable IDs BEFORE the transaction so a retry never duplicates.
  const stamp = crypto.randomUUID();
  const eventId = `evt-${stamp}`;
  const nowIso = serverNow().toISOString();
  const venueName = venue.name || source.venueName || 'Supervised Establishment';

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.events) ? freshDoc.events : [];
      const existing = arr.find((e) => e.id === eventId);
      if (existing) return { doc: freshDoc, result: { event: existing } };
      // Re-authorize against the COMMITTED document (rule T): the source,
      // its venue and the caller's role/venue may have changed while this
      // request was in flight. Fail closed; nothing is written.
      const freshSource = arr.find((e) => e && e.id === id);
      if (!freshSource) return { conflict: 'This event was deleted, so it was not copied.' };
      const freshVenue = (Array.isArray(freshDoc.venues) ? freshDoc.venues : []).find(
        (v: any) => v && v.id === freshSource.venueId
      );
      if (!freshVenue || (freshVenue.agencyId || 'agency-hkc') !== (freshSource.agencyId || 'agency-hkc')) {
        return { conflict: "This event's venue no longer exists, so it was not copied." };
      }
      const freshCaller = (Array.isArray(freshDoc.users) ? freshDoc.users : []).find(
        (u: any) => u && u.id === caller.id
      );
      if (!freshCaller || !mayCopyEvent(freshCaller, freshSource) || !mayCopyEvent(caller, freshSource)) {
        return { conflict: 'Your access changed, so the event was not copied. Refresh and try again.' };
      }
      if (eventCopySpanDays(freshSource) === 'bad') {
        return { conflict: "This event's dates are not valid, so it was not copied." };
      }
      const copy = buildEventCopy(freshSource, {
        eventId, stamp, date, title, nowIso,
        venueName: freshVenue.name || venueName,
        caller: { email: caller.email, name: caller.name },
      });
      // Stored as { event } so a retry gets the same shape as the first 201.
      return { doc: { ...freshDoc, events: [...arr, copy] }, result: { event: copy } };
    },
    { label: 'copy-event' }
  );
  if (!committed) return;
  const event = (committed.result as { event: KosherEventItem }).event;

  // Side effects ONLY after commit (rule BR). Nobody is assigned → no push.
  // A retry with the same operationId never reaches here: commitOrRespond
  // answers it with the stored result and no second broadcast.
  broadcast('EVENT_CREATED', {
    event,
    agencyId: event.agencyId,
    venueId: event.venueId,
  }, undefined, event.agencyId);

  res.status(201).json({ event });
});

app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const existing = events.find((e) => e.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (!requireSameAgency(req, res, existing, 'events')) return;
  // A5 (fix round 1): field-aware gate. The client saves an event task
  // change by PUTting the WHOLE event object, so the gate must compare the
  // body against the existing event. Changing DEFINITION fields
  // (title/location/date/times/mashgiach assignment/menu attachments) needs
  // admin or venue-coordinator. Changing only tasks/status/notes takes the
  // same gate as the event-task toggle. Transport fields (userEmail,
  // expectedVersion, operationId) are ignored by the comparison.
  const caller = getAuthUser(req);
  if (!caller) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }
  const EVENT_DEFINITION_FIELDS = [
    'title', 'location', 'date', 'endDate', 'startTime', 'endTime',
    'mashgiachType', 'assignedMashgiachEmail', 'assignedMashgiachName',
    'externalMashgiach', 'menuAttachmentName', 'menuAttachmentData',
  ];
  const changesDefinition = EVENT_DEFINITION_FIELDS.some(
    (f) => (req.body as any)[f] !== undefined &&
      JSON.stringify((req.body as any)[f]) !== JSON.stringify((existing as any)[f])
  );
  if (changesDefinition) {
    if (caller.role !== 'admin' &&
        !(caller.role === 'coordinator' && callerMaySeeVenue(caller, existing.venueId))) {
      return res.status(403).json({ error: 'You can only edit event details at your own venue.' });
    }
  } else if (!mayFillEventTasks(caller, existing)) {
    return res.status(403).json({ error: 'You can only check event tasks at your own venue.' });
  }

  const {
    title,
    location,
    date,
    endDate,
    startTime,
    endTime,
    mashgiachType,
    assignedMashgiachEmail,
    assignedMashgiachName,
    externalMashgiach,
    menuAttachmentName,
    menuAttachmentData,
    notes,
    status,
    tasks: updatedTasks,
  } = req.body;

  // Baseline for semantic conflict detection: every definition field as
  // the requester saw it (fix round 2 MEDIUM: conflict-check every
  // definition field the body changes, not just three).
  const baseline: Record<string, any> = {};
  for (const f of EVENT_DEFINITION_FIELDS) baseline[f] = (existing as any)[f];

  // Item 8s: the assignee is looked up ONLY when the assignment is being
  // introduced or changed (a non-empty email different from the stored one,
  // or the type switching to assigned_user), and only within the caller's
  // agency + rule-T roster; unknown and other-agency emails get the same
  // 400. Task check-ins, notes, status and other definition edits never look
  // up or refresh the stored assignment (a historical assignment stays as
  // stored, taken from the FRESH event in the transaction).
  const normEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
  const bodyEmailGiven = typeof assignedMashgiachEmail === 'string' && assignedMashgiachEmail.trim() !== '';
  const nextType = mashgiachType !== undefined ? mashgiachType : existing.mashgiachType;
  const switchingToAssigned = mashgiachType === 'assigned_user' && existing.mashgiachType !== 'assigned_user';
  const assignmentChanging =
    (bodyEmailGiven && normEmail(assignedMashgiachEmail) !== normEmail(existing.assignedMashgiachEmail)) ||
    switchingToAssigned;
  const assigneeEmailToResolve = bodyEmailGiven ? assignedMashgiachEmail : existing.assignedMashgiachEmail;
  let resolvedAssignee: any = null;
  if (assignmentChanging) {
    resolvedAssignee = resolveAssignableUser(caller, assigneeEmailToResolve, users);
    if (!resolvedAssignee) return res.status(400).json({ error: EVENT_ASSIGNEE_REFUSAL, code: 'ASSIGNEE_NOT_IN_TEAM' });
  }
  // Explicit clear (unassigned/external with an empty or null email) keeps today's behaviour.
  const clearingAssignee = !bodyEmailGiven && assignedMashgiachEmail !== undefined;
  void nextType;
  const updatedAt = new Date().toISOString();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshEvents: any[] = Array.isArray(freshDoc.events) ? freshDoc.events : [];
      const freshEvent = freshEvents.find((e) => e.id === id);
      if (!freshEvent) return { conflict: 'Event not found (it may have been deleted).' };
      // Fix round 2 HIGH (rule AB): authorization inside the transaction
      // re-resolves the caller AND the target from the FRESH doc. The
      // pre-commit gate ran against the cached event; an admin reassignment
      // committed between the gate and this transaction must not be
      // silently overridden by an in-flight tasks-only save.
      // Rule N: normalize the stored record through hydration's own
      // function before comparing it to the hydrated cache caller —
      // legacy doc records ('worker', no agencyId/venueId/permissions)
      // otherwise false-fire as "access changed" on every event save.
      const freshCallerRaw: any = (freshDoc.users || []).find((u: any) => u.id === (caller as any).id);
      const freshCaller: any = freshCallerRaw ? normalizeStoredUser(freshCallerRaw) : freshCallerRaw;
      // Compare the authorization-relevant signature — role, venue,
      // agency, permissions — on two NORMALIZED records (the cache caller
      // is already normalized by hydration; freshCaller is normalized
      // above). The legacy asymmetry can no longer false-fire.
      if (!freshCaller ||
          freshCaller.agencyId !== (caller as any).agencyId ||
          freshCaller.role !== (caller as any).role ||
          (freshCaller as any).venueId !== (caller as any).venueId ||
          JSON.stringify((freshCaller as any).venueAccess ?? null) !== JSON.stringify((caller as any).venueAccess ?? null) ||
          JSON.stringify(freshCaller.permissions) !== JSON.stringify((caller as any).permissions)) {
        return { conflict: 'Your access changed while saving. Please refresh and try again.' };
      }
      // Fix round 2 HIGH: inside the transaction, the gate is re-run on
      // the FRESH event. A privileged save conflict-checks every
      // definition field the body changes (MEDIUM); a non-privileged save
      // is tasks/status/notes only, and stale definition fields in the body
      // are silently dropped — the caller may still work the fresh event's
      // tasks when they remain allowed on the fresh record.
      const freshPrivileged = freshCaller.role === 'admin' ||
        (freshCaller.role === 'coordinator' && callerMaySeeVenue(freshCaller, freshEvent.venueId));
      const freshTaskWorker = mayFillEventTasks(freshCaller, freshEvent);
      if (!freshPrivileged && !freshTaskWorker) {
        return { conflict: 'You are no longer assigned to this event.' };
      }
      let updated: KosherEventItem;
      // Item 8s: re-resolve a changing assignment on FRESH data, with the
      // caller re-read from freshDoc.users (fresh role/agency/venue).
      let freshAssigneeForSave: any = null;
      if (freshPrivileged && assignmentChanging) {
        freshAssigneeForSave = resolveAssignableUser(freshCallerRaw, assigneeEmailToResolve, freshDoc.users || []);
        if (!freshAssigneeForSave) {
          return { conflict: EVENT_ASSIGNEE_REFUSAL, conflictStatus: 400, conflictCode: 'ASSIGNEE_NOT_IN_TEAM' };
        }
      }
      if (freshPrivileged) {
        // Privileged save: conflict-check EVERY definition field the body
        // changes against the fresh event (MEDIUM).
        for (const field of EVENT_DEFINITION_FIELDS) {
          const newVal = (req.body as any)[field];
          if (newVal !== undefined &&
              JSON.stringify((freshEvent as any)[field]) !== JSON.stringify(baseline[field])) {
            return { conflict: `Conflict: event ${field} was changed by someone else. Please refresh and try again.` };
          }
        }
        updated = {
          ...freshEvent,
          title: title !== undefined ? title : freshEvent.title,
          location: location !== undefined ? location : freshEvent.location,
          date: date !== undefined ? date : freshEvent.date,
          endDate: endDate !== undefined ? endDate : freshEvent.endDate,
          startTime: startTime !== undefined ? startTime : freshEvent.startTime,
          endTime: endTime !== undefined ? endTime : freshEvent.endTime,
          mashgiachType: mashgiachType !== undefined ? mashgiachType : freshEvent.mashgiachType,
          assignedMashgiachEmail: assignmentChanging
            ? freshAssigneeForSave!.email
            : clearingAssignee ? assignedMashgiachEmail : freshEvent.assignedMashgiachEmail,
          assignedMashgiachName: assignmentChanging
            ? freshAssigneeForSave!.name
            : clearingAssignee ? (assignedMashgiachName !== undefined ? assignedMashgiachName : freshEvent.assignedMashgiachName) : freshEvent.assignedMashgiachName,
          externalMashgiach: externalMashgiach !== undefined ? externalMashgiach : freshEvent.externalMashgiach,
          menuAttachmentName: menuAttachmentName !== undefined ? menuAttachmentName : freshEvent.menuAttachmentName,
          menuAttachmentData: menuAttachmentData !== undefined ? menuAttachmentData : freshEvent.menuAttachmentData,
          notes: notes !== undefined ? notes : freshEvent.notes,
          status: status !== undefined ? status : freshEvent.status,
          tasks: updatedTasks !== undefined ? updatedTasks : freshEvent.tasks,
          updatedAt,
        };
      } else {
        // Non-privileged (tasks/status/notes) save: definition fields come
        // from the FRESH event unconditionally — a tasks-only save can never
        // silently undo an admin's concurrent reassignment (MEDIUM).
        updated = {
          ...freshEvent,
          notes: notes !== undefined ? notes : freshEvent.notes,
          status: status !== undefined ? status : freshEvent.status,
          tasks: updatedTasks !== undefined ? updatedTasks : freshEvent.tasks,
          updatedAt,
        };
      }
      const newEvents = freshEvents.map((e) => (e.id === id ? updated : e));
      return { doc: { ...freshDoc, events: newEvents }, result: updated };
    },
    { label: 'update-event', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as KosherEventItem;

  // Item 7: transition-aware broadcast — the stale-assignment path (an
  // admin reassigning the event away from a mashgiach) sends that mashgiach
  // EVENT_DELETED so their client drops the event immediately.
  broadcastEventUpdated(existing, updated, caller?.email);

  res.json({ event: updated });
});

app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const deletedEvent = events.find((e) => e.id === id);

  if (!deletedEvent) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (!requireSameAgency(req, res, deletedEvent, 'events')) return;
  // A5: same role gate as PUT (UI gates delete to admin only; rule T lets the
  // venue's coordinator lead at their venue).
  const delCaller = getAuthUser(req);
  if (!delCaller) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }
  if (delCaller.role !== 'admin' &&
      !(delCaller.role === 'coordinator' && callerMaySeeVenue(delCaller, deletedEvent.venueId))) {
    return res.status(403).json({ error: 'You can only delete events at your own venue.' });
  }
  const agencyId = deletedEvent.agencyId;
  const venueId = deletedEvent.venueId;

  const ok = await crudDelete(req, res, 'events', id, {
    label: 'delete-event',
    broadcastType: 'EVENT_DELETED',
    getDeletePayload: () => ({ id, agencyId, venueId, assignedMashgiachEmail: deletedEvent.assignedMashgiachEmail }),
    getAgencyId: () => agencyId || 'agency-hkc',
  });
  return;
});

// Event Task Toggle / Status Endpoint
app.post('/api/events/:id/tasks/:taskId/toggle', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { id, taskId } = req.params;
  const { isCompleted, notes } = req.body;

  const event = events.find((e) => e.id === id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (!requireSameAgency(req, res, event, 'events')) return;
  // A5: role gate mirrors the UI. A coordinator leads at their own venue only
  // (rule T). canFill mashgichim/workers participate when the event is at
  // their venue or assigned to them; owners only with canFillTasks at the venue.
  if (!mayFillEventTasks(caller, event)) {
    return res.status(403).json({ error: 'You can only check event tasks at your own venue.' });
  }

  const cachedTask = event.tasks.find((t) => t.id === taskId);
  if (!cachedTask) {
    return res.status(404).json({ error: 'Task not found in this event.' });
  }

  // Baseline for semantic conflict detection: the task's completion state as the
  // client saw it. If someone else toggled it meanwhile, that's a 409.
  const baselineCompleted = cachedTask.isCompleted;
  const completedAt = new Date().toISOString();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshEvents: any[] = Array.isArray(freshDoc.events) ? freshDoc.events : [];
      const freshEvent = freshEvents.find((e) => e.id === id);
      if (!freshEvent) return { conflict: 'Event not found (it may have been deleted).' };
      const freshTasks: any[] = Array.isArray(freshEvent.tasks) ? freshEvent.tasks : [];
      const freshTask = freshTasks.find((t) => t.id === taskId);
      if (!freshTask) return { conflict: 'Task not found in this event.' };
      if (freshTask.isCompleted !== baselineCompleted) {
        return { conflict: 'Conflict: this event task was changed by someone else. Please refresh and try again.' };
      }
      const targetCompleted = isCompleted !== undefined ? Boolean(isCompleted) : !freshTask.isCompleted;
      const updatedTask = {
        ...freshTask,
        isCompleted: targetCompleted,
        notes: notes !== undefined ? notes : freshTask.notes,
        completedAt: targetCompleted ? completedAt : null,
        completedByName: targetCompleted ? caller.name : null,
        completedByEmail: targetCompleted ? caller.email : null,
      };
      const updatedEvent = {
        ...freshEvent,
        tasks: freshTasks.map((t) => (t.id === taskId ? updatedTask : t)),
        updatedAt: completedAt,
      };
      const newEvents = freshEvents.map((e) => (e.id === id ? updatedEvent : e));
      return { doc: { ...freshDoc, events: newEvents }, result: { event: updatedEvent, task: updatedTask } };
    },
    // NOTE: no requireVersion — the mutator has its own entity-level stale
    // guard (baselineCompleted vs fresh), which is the precise check for a
    // toggle. A document-version gate would be redundant.
    { label: 'toggle-event-task' }
  );
  if (!committed) return;
  const { event: updatedEvent, task: updatedTask } = committed.result as any;

  broadcast('EVENT_UPDATED', {
    event: updatedEvent,
    agencyId: updatedEvent.agencyId,
    venueId: updatedEvent.venueId,
    assignedMashgiachEmail: updatedEvent.assignedMashgiachEmail,
  }, undefined, updatedEvent.agencyId || 'agency-hkc');

  res.json({ success: true, event: updatedEvent, task: updatedTask });
});

app.get('/api/users', (req, res) => {
  const { venueId } = req.query;

  // Kiosk: venue roster only (names/roles/avatars, no emails) for the token's
  // venue. The board needs this to render names.
  if ((req as any).kiosk === true) {
    const kioskVenueId = (req as any).kioskVenueId;
    const roster = users
      .filter((u) => (u.agencyId || 'agency-hkc') === callerAgencyId(req) && (u.venueId === kioskVenueId || personAtVenue(u, kioskVenueId)))
      .map((u) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor, role: u.role }));
    return res.json({ users: roster });
  }

  // Privacy: the roster is scoped from the verified session token, NEVER from
  // a client-supplied email. (Previously the userEmail query param let any
  // authenticated user read another agency's roster by passing one of its
  // emails.) Fields are trimmed by the caller's role, like the WS roster.
  const agencyId = callerAgencyId(req);
  const caller = getAuthUser(req);

  // RULE T: a non-admin with no venue gets [], never the whole roster.
  // A spoofed ?venueId from a non-admin is ignored (own venue, or nothing).
  let targetVenueId = venueId ? String(venueId) : null;
  if (caller && caller.role !== 'admin') {
    const ownScope = venueScopeFor(caller);
    if (ownScope.length === 0) return res.json({ users: [] });
    // 9a: a requested venue inside the scope is honoured; anything else →
    // the home venue (scope[0]), as before (a spoofed id is ignored).
    targetVenueId = targetVenueId && ownScope.includes(targetVenueId) ? targetVenueId : ownScope[0];
  }

  // Scope to caller's agency
  let agencyUsers = getSafeUsersForAgency(agencyId, caller ?? undefined);

  if (targetVenueId) {
    // Return users assigned to this venue OR agency admins
    agencyUsers = agencyUsers.filter((u: any) => u.role === 'admin' || personAtVenue(u, targetVenueId));
  }

  res.json({ users: agencyUsers });
});

app.post('/api/users', async (req, res) => {
  // Only admins can create users — verified from the session token, never the body.
  const caller = requireAdmin(req, res);
  if (!caller) return;
  // New users are always created in the caller's own agency.
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const { email, name, role, password, venueId, permissions, phoneNumber } = stripServerOnlyUserFields(req.body || {}); // 8b: no server-only identity field from a body
  if (!email || !name) {
    return res.status(400).json({ error: 'Email and name are required' });
  }
  // K1: optional phone number (E.164), validated before anything is written.
  const phoneNorm = normalizePhoneNumber(phoneNumber);
  if (!phoneNorm.ok) {
    return res.status(400).json({ error: PHONE_NUMBER_ERROR });
  }

  // Pre-generate stable ID + hash the password BEFORE the transaction so retries
  // never create a duplicate user or re-hash (bcrypt is CPU-heavy).
  const newUserId = `usr_${Date.now()}`;
  const initialPassword = (password && String(password).trim()) || crypto.randomBytes(9).toString('hex');
  const passwordHash = bcrypt.hashSync(initialPassword, 10);
  const cleanEmail = email.trim().toLowerCase();

  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#f97316'];
  const validRole =
    role === 'admin'
      ? 'admin'
      : role === 'coordinator'
      ? 'coordinator'
      : role === 'owner'
      ? 'owner'
      : 'mashgiach';

  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);
  // A client-supplied venueId must belong to the caller's agency.
  let targetVenueId: string | undefined = validRole === 'admin' ? undefined : (agencyVenues[0]?.id || 'venue-crown-market');
  if (validRole !== 'admin' && venueId) {
    const chosen = agencyVenues.find((v) => v.id === venueId);
    if (!chosen) {
      return res.status(403).json({ error: 'You can only assign team members to venues in your own agency.' });
    }
    targetVenueId = chosen.id;
  }

  const defaultPermissions: UserPermissions = {
    canFillTasks:
      permissions?.canFillTasks !== undefined
        ? Boolean(permissions.canFillTasks)
        : validRole === 'admin' || validRole === 'coordinator' || validRole === 'mashgiach',
    canAssignTasks:
      permissions?.canAssignTasks !== undefined
        ? Boolean(permissions.canAssignTasks)
        : validRole === 'admin' || validRole === 'coordinator',
  };

  const newUser: UserProfile = {
    id: newUserId,
    agencyId: callerAgencyId,
    email: cleanEmail,
    name: name.trim(),
    role: validRole,
    venueId: targetVenueId,
    permissions: defaultPermissions,
    avatarColor: colors[Math.floor(Math.random() * colors.length)],
    password: passwordHash,
    ...(phoneNorm.value ? { phoneNumber: phoneNorm.value } : {}),
  };

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      // Email uniqueness must be checked against FRESH data, not the cache.
      // (Two concurrent creates with the same email: one wins, the other gets 409 —
      // the duplicate-user case idempotency alone can't prevent.)
      const existing = freshUsers.find((u) => u.email.toLowerCase() === cleanEmail);
      if (existing) return { conflict: 'A team member with this email already exists' };
      // Idempotency: our own user ID already created by a previous attempt.
      const selfExisting = freshUsers.find((u) => u.id === newUserId);
      if (selfExisting) return { doc: freshDoc, result: selfExisting };
      return { doc: { ...freshDoc, users: [...freshUsers, newUser] }, result: newUser };
    },
    { label: 'create-user' }
  );
  if (!committed) return;
  const created = committed.result as UserProfile;
  broadcast('USERS_UPDATED', { agencyId: callerAgencyId }, undefined, callerAgencyId, (meta, base) => ({
    ...base,
    users: getSafeUsersForAgency(callerAgencyId, recipientForMeta(meta)),
  }));
  res.status(201).json({ user: managerViewOf(created, caller) });
});

// Update user permissions or role
app.put('/api/users/:id', async (req, res) => {
  // Admins can update users. Coordinators may ONLY set/re-save a kiosk PIN
  // (Don's decision 8:50 PM ET Oct 19): the body must contain kioskPin and
  // NOTHING else, the target must be in the caller's agency, and the target's
  // role must be mashgiach or worker (never admin, never coordinator).
  // A kiosk token is always 403 KIOSK_SCOPE here.
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  if ((req as any).kiosk === true) {
    return res.status(403).json({ error: 'This kiosk session can only clock in and out.', code: 'KIOSK_SCOPE' });
  }
  const callerIsAdmin = caller.role === 'admin';
  const callerIsCoordinator = caller.role === 'coordinator';
  if (!callerIsAdmin && !callerIsCoordinator) {
    return res.status(403).json({ error: 'Only admins can manage team members.' });
  }
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const { id } = req.params;
  const existingUser = users.find((u) => u.id === id);
  if (!existingUser) {
    return res.status(404).json({ error: 'Team member not found' });
  }
  // Cross-agency: the target must belong to the caller's agency.
  if ((existingUser.agencyId || 'agency-hkc') !== callerAgencyId) {
    return res.status(403).json({ error: 'You can only manage team members in your own agency.' });
  }

  const { role, permissions, venueId, name, kioskPin, phoneNumber } = stripServerOnlyUserFields(req.body || {}); // 8b: no server-only identity field from a body

  // Coordinator PIN-only path (Don 8:54 PM ET Oct 19 — own VENUE only):
  // body must be a NON-EMPTY subset of { kioskPin, phoneNumber } (K1, Don
  // 7:35 PM Oct 20: the coordinator may also save the phone number for
  // their venue's people); target must be in the caller's agency AND at the
  // caller's venue; target role mashgiach/worker only.
  // A coordinator with no venueId fails closed before any lookup.
  if (callerIsCoordinator) {
    const callerVenueId = (caller as any).venueId;
    if (!callerVenueId) {
      return res.status(403).json({ error: 'Coordinators can only set kiosk PINs for their own venue.' });
    }
    // Ignore transport/attribution fields the client and middleware add:
    // userEmail (middleware), adminEmail (App.tsx), expectedVersion and
    // operationId (apiWrite). Anything else → not a PIN-only body.
    const TRANSPORT_FIELDS = ['userEmail', 'adminEmail', 'expectedVersion', 'operationId'];
    const bodyKeys = Object.keys(req.body || {}).filter((k) => !TRANSPORT_FIELDS.includes(k));
    const COORDINATOR_FIELDS = ['kioskPin', 'phoneNumber'];
    const onlyPin = bodyKeys.length >= 1 && bodyKeys.every((k) => COORDINATOR_FIELDS.includes(k));
    // 9a: through an actual SHARED venue (both scopes, current agency), not
    // matching home venues; re-checked on fresh state inside the mutator.
    const targetOk =
      (existingUser.role === 'mashgiach' || existingUser.role === 'worker') &&
      sharedVenues(caller as any, existingUser as any, venues as any).length > 0;
    if (!onlyPin || !targetOk) {
      return res.status(403).json({ error: 'Coordinators can only set kiosk PINs for mashgichim and workers at their own venue.' });
    }
  }

  // Validate PIN outside the transaction (pure validation); hash it here so
  // the plaintext never reaches the transaction or the stored user record.
  let pinHashUpdate: string | undefined | null = null; // null = no change
  if (kioskPin !== undefined) {
    const pin = String(kioskPin).trim();
    if (pin !== '' && !/^[0-9]{4,6}$/.test(pin)) {
      return res.status(400).json({ error: 'Kiosk PIN must be 4-6 digits or empty.' });
    }
    pinHashUpdate = pin === '' ? undefined : await hashPassword(pin);
  }
  // K1: optional phone number — undefined in the body = no change; "" or
  // null clears it; anything else must normalize to E.164.
  const phoneProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'phoneNumber');
  const phoneNorm = phoneProvided ? normalizePhoneNumber(phoneNumber) : { ok: true, value: undefined };
  if (!phoneNorm.ok) {
    return res.status(400).json({ error: PHONE_NUMBER_ERROR });
  }

  const baseline = { name: existingUser.name, role: existingUser.role, venueId: existingUser.venueId };

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshUser = freshUsers.find((u) => u.id === id);
      if (!freshUser) return { conflict: 'Team member not found (they may have been deleted).' };
      // Re-verify agency against FRESH data (the cached check above is a fast path).
      if ((freshUser.agencyId || 'agency-hkc') !== callerAgencyId) {
        return { conflict: 'You can only manage team members in your own agency.' };
      }
      // Coordinator path: resolve the caller's OWN fresh record (still
      // exists, still coordinator, same agency, has a venue), then re-verify
      // the target against the FRESH caller (own venue, mashgiach/worker only).
      if (callerIsCoordinator) {
        const freshCaller = freshUsers.find((u) => u.id === caller.id);
        const freshCallerOk =
          freshCaller &&
          freshCaller.role === 'coordinator' &&
          (freshCaller.agencyId || 'agency-hkc') === callerAgencyId &&
          !!(freshCaller as any).venueId;
        if (!freshCallerOk) {
          return { conflict: 'Coordinators can only set kiosk PINs for mashgichim and workers at their own venue.' };
        }
        // 9a: a venue the FRESH caller and FRESH target actually share
        // (both scopes, venues of the agency in the fresh doc).
        const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
        const freshTargetOk =
          (freshUser.role === 'mashgiach' || freshUser.role === 'worker') &&
          (freshUser.agencyId || 'agency-hkc') === callerAgencyId &&
          sharedVenues(freshCaller as any, freshUser as any, freshVenues).length > 0;
        if (!freshTargetOk) {
          return { conflict: 'Coordinators can only set kiosk PINs for mashgichim and workers at their own venue.' };
        }
      }
      // Conflict if someone else changed a field this request is editing.
      if (name !== undefined && freshUser.name !== baseline.name) {
        return { conflict: 'Conflict: this team member\'s name was changed by someone else. Please refresh and try again.' };
      }
      if (role !== undefined && freshUser.role !== baseline.role) {
        return { conflict: 'Conflict: this team member\'s role was changed by someone else. Please refresh and try again.' };
      }
      const newRole =
        role === undefined
          ? freshUser.role
          : role === 'admin'
          ? 'admin'
          : role === 'coordinator'
          ? 'coordinator'
          : role === 'owner'
          ? 'owner'
          : 'mashgiach';
      // Never demote the last admin of the agency (counted on fresh data).
      if (newRole !== 'admin' && freshUser.role === 'admin') {
        const adminCount = freshUsers.filter(
          (u) => (u.agencyId || 'agency-hkc') === callerAgencyId && u.role === 'admin'
        ).length;
        if (adminCount <= 1) {
          return { conflict: 'Cannot change this role: they are the last administrator of the agency.' };
        }
      }
      // A reassigned venue must belong to the caller's agency.
      if (venueId !== undefined && venueId !== freshUser.venueId) {
        const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
        const targetVenue = freshVenues.find((v) => v && v.id === venueId);
        if (!targetVenue || (targetVenue.agencyId || 'agency-hkc') !== callerAgencyId) {
          return { conflict: 'You can only assign team members to venues in your own agency.' };
        }
      }
      const updated: UserProfile = { ...freshUser };
      if (name !== undefined) updated.name = name.trim();
      if (pinHashUpdate !== null) {
        updated.kioskPinHash = pinHashUpdate === undefined ? undefined : pinHashUpdate;
        updated.kioskPin = undefined; // drop any legacy plain PIN on explicit set/clear
        // PIN version: any kiosk token issued before this instant is revoked.
        updated.kioskPinSetAt = new Date().toISOString();
        // 2b: the revision counter is the token version now (pv). Set in
        // the SAME transaction as the hash; a re-save with the same digits
        // still bumps it (old sessions die). A non-integer stored value
        // restarts from 0 (validated on read — see pinRevOf).
        updated.kioskPinRev = (pinRevOf(freshUser) ?? 0) + 1;
      }
      if (venueId !== undefined) updated.venueId = venueId;
      if (phoneProvided) {
        if (phoneNorm.value) updated.phoneNumber = phoneNorm.value;
        else delete (updated as any).phoneNumber;
      }
      if (role !== undefined) {
        updated.role = newRole;
      }
      if (permissions !== undefined) {
        updated.permissions = {
          ...(freshUser.permissions || {}),
          ...(permissions.canFillTasks !== undefined ? { canFillTasks: Boolean(permissions.canFillTasks) } : {}),
          ...(permissions.canAssignTasks !== undefined ? { canAssignTasks: Boolean(permissions.canAssignTasks) } : {}),
        };
      }
      const newUsers = freshUsers.map((u) => (u.id === id ? updated : u));
      // Setting or clearing the PIN also clears any kiosk lockout for the user
      // (admin unlock path — no separate endpoint).
      let lockouts = freshDoc.kioskPinLockouts;
      if (pinHashUpdate !== null && lockouts && typeof lockouts === 'object') {
        const users2 = { ...((lockouts as any).users || {}) };
        delete users2[id];
        lockouts = { ...(lockouts as any), users: users2 };
      }
      const doc: any = { ...freshDoc, users: newUsers };
      if (lockouts !== freshDoc.kioskPinLockouts) doc.kioskPinLockouts = lockouts;
      return { doc, result: updated };
    },
    { label: 'update-user', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as UserProfile;
  broadcast('USERS_UPDATED', { agencyId: updated.agencyId }, undefined, updated.agencyId, (meta, base) => ({
    ...base,
    users: getSafeUsersForAgency(updated.agencyId, recipientForMeta(meta)),
  }));
  // ChatGPT round-1 (3) + round-2: if the role/permission change revoked the
  // user's access to private tasks, their OPEN sockets still hold the old
  // copies (tasks AND historyLogs). Send TASK_DELETED for every private task
  // they can no longer see, then a fresh permission-filtered INITIAL_STATE
  // so their history view is replaced wholesale (client handles INITIAL_STATE
  // by replacing tasks/historyLogs/events/users — App.tsx ~L414).
  {
    const oldUser = existingUser;
    const lostTasks = tasks.filter(
      (t) =>
        (t.agencyId || 'agency-hkc') === (updated.agencyId || 'agency-hkc') &&
        canSeeTaskServer(t, oldUser) &&
        !canSeeTaskServer(t, updated)
    );
    // Item 13 (ChatGPT): refresh whenever the target's role OR venueId changed —
    // a coordinator moved from venue A to B must lose A's data on connected
    // clients immediately, even if the lost-task count happens to be zero.
    const reassigned =
      oldUser.role !== updated.role || (oldUser as any).venueId !== (updated as any).venueId;
    if (lostTasks.length > 0 || reassigned) {
      for (const t of lostTasks) {
        broadcast(
          'TASK_DELETED',
          { id: t.id, venueId: t.venueId, agencyId: t.agencyId },
          undefined,
          t.agencyId || 'agency-hkc',
          (meta) => (meta.userId === updated.id ? { id: t.id, venueId: t.venueId, agencyId: t.agencyId } : null)
        );
      }
      // Fresh filtered INITIAL_STATE to the affected user's sockets only.
      // K1 (ChatGPT plan review): built PER SOCKET from that socket's
      // verified effective identity — a kiosk socket of this user gets the
      // kiosk-filtered, acting-user snapshot, never the stored admin's.
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        const meta = authorizeSocket(client);
        if (!meta || meta.userId !== updated.id) continue;
        const st = initialStateForSocket(meta);
        if (!st) continue;
        client.send(JSON.stringify({
          type: 'INITIAL_STATE',
          payload: { ...st, activeWorkersCount: activeSockets.size },
          timestamp: new Date().toISOString(),
          version: typeof stateVersion === 'number' ? stateVersion : undefined,
        }));
      }
    }
  }
  res.json({ user: managerViewOf(updated, caller) });
});

/**
 * 9a — admin grants a person venues inside the admin's own agency ("9a plan
 * v2"). Body: { venueIds: string[], expectedVenueIds?: string[] }.
 * The person's home venue is always kept; the list is the FULL extra set
 * (send [] to remove all extra venues). Server-only: the list is written
 * ONLY through commitState's sanctioned venueAccessSetById path, never from a
 * body field, and the client never sees another person's list.
 * Fresh, inside the transaction: the CALLER is still an admin of this agency;
 * the TARGET still exists in this agency, is not an admin, is migrated, and
 * (when expectedVenueIds is sent) still has exactly that scope; every venue
 * is a venue of this agency in the fresh doc. Audited like a role change.
 */
app.put('/api/users/:id/venues', async (req, res) => {
  const caller = requireAdmin(req, res);
  if (!caller) return; // requireAdmin already responded
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  const { id } = req.params;
  const body = stripServerOnlyUserFields(req.body || {});
  const raw = (body as any).venueIds;
  if (!Array.isArray(raw) || raw.length > 50 || !raw.every((x: any) => typeof x === 'string' && x.length > 0 && x.length <= 200)) {
    return res.status(400).json({ error: 'venueIds must be a list of venue ids.', code: 'VENUE_IDS_INVALID' });
  }
  const expected = (body as any).expectedVenueIds;
  if (expected !== undefined && (!Array.isArray(expected) || !expected.every((x: any) => typeof x === 'string'))) {
    return res.status(400).json({ error: 'expectedVenueIds must be a list of venue ids.', code: 'VENUE_IDS_INVALID' });
  }
  const cached = users.find((u) => u.id === id);
  if (!cached || (cached.agencyId || 'agency-hkc') !== callerAgencyId) {
    return res.status(404).json({ error: 'Team member not found.' });
  }
  const requested: string[] = Array.from(new Set(raw as string[]));
  const deny = (msg: string, status: number, code: string) => ({ conflict: msg, conflictStatus: status, conflictCode: code });
  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
      const freshCaller = freshUsers.find((u) => u && u.id === caller.id);
      if (!freshCaller || freshCaller.role !== 'admin' || (freshCaller.agencyId || 'agency-hkc') !== callerAgencyId) {
        return deny('Only an admin of this agency can change venue access.', 403, 'NOT_ADMIN');
      }
      const target = freshUsers.find((u) => u && u.id === id);
      if (!target || (target.agencyId || 'agency-hkc') !== callerAgencyId) {
        return deny('Team member not found (they may have been deleted).', 404, 'NOT_FOUND');
      }
      if (target.role === 'admin') {
        return deny('Admins already cover every venue of the agency.', 400, 'TARGET_IS_ADMIN');
      }
      if (!target.personId) {
        return deny('This account has not been upgraded yet; try again shortly.', 409, 'NOT_MIGRATED');
      }
      const before = venueScopeOf(target, freshVenues) as string[];
      if (expected !== undefined) {
        const a = [...before].sort().join('\u0000');
        const b = Array.from(new Set(expected as string[])).sort().join('\u0000');
        if (a !== b) return deny("Conflict: this person's venues were changed by someone else. Please refresh and try again.", 409, 'VENUES_CHANGED');
      }
      const own = new Set(freshVenues.filter((v) => v && (v.agencyId || 'agency-hkc') === callerAgencyId).map((v) => v.id));
      const bad = requested.filter((v) => !own.has(v));
      if (bad.length) return deny('Every venue must be a venue of your agency.', 400, 'VENUE_NOT_IN_AGENCY');
      const list = requested.filter((v) => v !== target.venueId);
      return {
        doc: { ...freshDoc, users: [...freshUsers] },
        venueAccessSetById: { [id]: list },
        result: { userId: id, before, home: target.venueId || null, list },
      };
    },
    { label: 'set-user-venues', requireVersion: true }
  );
  if (!committed) return;
  const r: any = (committed as any).result || {};
  const fresh = users.find((u) => u.id === id);
  const after = fresh ? (venueScopeFor(fresh) as string[]) : [];
  log.info(`[audit] venue access changed: admin ${caller.id} set user ${id} venues [${(r.before || []).join(',')}] -> [${after.join(',')}] (agency ${callerAgencyId})`);
  broadcast('USERS_UPDATED', { agencyId: callerAgencyId }, undefined, callerAgencyId, (meta, base) => ({
    ...base,
    users: getSafeUsersForAgency(callerAgencyId, recipientForMeta(meta)),
  }));
  // The person's open sockets get a fresh scope-filtered INITIAL_STATE (venues
  // gained or lost apply now), built per socket from its verified identity.
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const meta = authorizeSocket(client);
    if (!meta || meta.userId !== id) continue;
    const st = initialStateForSocket(meta);
    if (!st) continue;
    client.send(JSON.stringify({
      type: 'INITIAL_STATE',
      payload: { ...st, activeWorkersCount: activeSockets.size },
      timestamp: new Date().toISOString(),
      version: typeof stateVersion === 'number' ? stateVersion : undefined,
    }));
  }
  res.json({ success: true, userId: id, venueIds: after });
});

app.delete('/api/users/:id', async (req, res) => {
  // Only admins can delete users — verified from the session token.
  const caller = requireAdmin(req, res);
  if (!caller) return;
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const { id } = req.params;
  // Admins cannot delete themselves.
  if (id === caller.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const userToDelete = users.find((u) => u.id === id);
  // Not in cache → the transactional delete below returns idempotent success
  // (already deleted). The agency/primary-admin checks only apply to existing users.
  if (userToDelete) {
    // Cross-agency: the target must belong to the caller's agency.
    if ((userToDelete.agencyId || 'agency-hkc') !== callerAgencyId) {
      return res.status(403).json({ error: 'You can only manage team members in your own agency.' });
    }

    // Check if primary admin for this agency (permission check — safe on cached data).
    const userAgency = agencies.find((a) => a.id === userToDelete.agencyId);
    if (
      userToDelete.email.toLowerCase() === 'kenan@hartfordkashrut.org' ||
      (userAgency && userToDelete.email.toLowerCase() === userAgency.adminEmail?.toLowerCase())
    ) {
      return res.status(400).json({ error: 'Cannot delete the primary administrator account for this agency.' });
    }
  }
  const deletedAgencyId = userToDelete?.agencyId || 'agency-hkc';

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshTarget = freshUsers.find((u) => u.id === id);
      // Already deleted → idempotent success.
      if (!freshTarget) return { doc: freshDoc, result: { success: true, deletedId: id, alreadyDeleted: true } };
      // Re-verify agency against FRESH data.
      if ((freshTarget.agencyId || 'agency-hkc') !== callerAgencyId) {
        return { conflict: 'You can only manage team members in your own agency.' };
      }
      // Never delete the last admin of the agency (counted on fresh data).
      if (freshTarget.role === 'admin') {
        const adminCount = freshUsers.filter(
          (u) => (u.agencyId || 'agency-hkc') === callerAgencyId && u.role === 'admin'
        ).length;
        if (adminCount <= 1) {
          return { conflict: 'Cannot delete the last administrator of the agency.' };
        }
      }
      // Item 8t: the deleted user's push subscriptions go in the SAME commit
      // (identity-bound by userId, plus legacy records under their email —
      // emails are unique, so a legacy record under it is theirs).
      const targetEmail = typeof freshTarget.email === 'string' ? freshTarget.email.trim().toLowerCase() : '';
      const freshSubs: any[] = Array.isArray(freshDoc.pushSubscriptions) ? freshDoc.pushSubscriptions : [];
      const keptSubs = freshSubs.filter(
        (s) => !(s && (s.userId === id || (!s.userId && typeof s.userEmail === 'string' && s.userEmail.trim().toLowerCase() === targetEmail)))
      );
      return {
        doc: {
          ...freshDoc,
          users: freshUsers.filter((u) => u.id !== id),
          ...(keptSubs.length !== freshSubs.length ? { pushSubscriptions: keptSubs } : {}),
        },
        result: { success: true, deletedId: id },
      };
    },
    { label: 'delete-user', requireVersion: true }
  );
  if (!committed) return;
  broadcast(
    'USERS_UPDATED',
    { deletedId: id, agencyId: deletedAgencyId },
    undefined,
    deletedAgencyId,
    (meta, base) => ({
      ...base,
      users: getSafeUsersForAgency(deletedAgencyId, recipientForMeta(meta)),
    })
  );
  res.json({ success: true, deletedId: id });
});

// ---- Kiosk mode: shared tablet login via per-user PIN ----
// Public list of PIN-enabled staff for one venue (no PINs, no emails exposed).
// Public venue list for kiosk setup: id + name only, no sensitive data.
// A fresh tablet needs this before anyone logs in.
// 2b: the public venue picker (GET /api/kiosk/venues) and the public staff
// list (GET /api/kiosk/users) are REMOVED. A tablet is paired to one venue
// (below); it never lists venues or staff for a venue it isn't bound to.

// B1 — a fresh tablet starts a pairing. Public, rate-limited per IP, and
// the ONLY response that ever carries the device secret (once).
app.post('/api/kiosk/pairing/start', async (req, res) => {
  if (kioskBodyTooLarge(req)) {
    return res.status(400).json({ error: 'Request too large.' });
  }
  const clientIp = getClientIp(req);
  const nowMs = Date.now();
  const START_MAX = 10;
  try {
    const committed = await commitState(
      (freshDoc) => {
        const limits = prunePairingLimitsMap(
          (freshDoc.kioskPairingLimits && typeof freshDoc.kioskPairingLimits === 'object'
            ? freshDoc.kioskPairingLimits : {}) as { [k: string]: string[] },
          nowMs
        );
        const key = `start|${clientIp}`;
        const attempts = limits[key] || [];
        if (attempts.length >= START_MAX) {
          return { doc: freshDoc, result: { limited: true } };
        }
        limits[key] = [...attempts, new Date(nowMs).toISOString()];
        const pairings = pruneKioskPairings(
          (freshDoc.kioskPairings && typeof freshDoc.kioskPairings === 'object' ? freshDoc.kioskPairings : {}) as { [k: string]: KioskPairing },
          nowMs
        );
        // 6-char code, unique among pending codes.
        let code = '';
        for (let tries = 0; tries < 10; tries++) {
          code = Array.from({ length: 6 }, () => PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)]).join('');
          const hash = sha256Hex(code);
          const clash = Object.values(pairings).some((pr) => pr.status === 'pending' && pr.pairingCodeHash === hash);
          if (!clash) break;
          code = '';
        }
        if (!code) return { doc: freshDoc, result: { limited: true } };
        const deviceSecret = crypto.randomBytes(32).toString('base64url');
        const pairingId = `pair-${crypto.randomBytes(9).toString('hex')}`;
        const expiresAt = nowMs + PAIRING_TTL_MS;
        pairings[pairingId] = {
          pairingCodeHash: sha256Hex(code),
          secretHash: sha256Hex(deviceSecret),
          ip: clientIp,
          createdAt: nowMs,
          expiresAt,
          status: 'pending',
        };
        return {
          doc: { ...freshDoc, kioskPairings: pairings, kioskPairingLimits: limits },
          result: { pairingId, code, deviceSecret, expiresAt },
        };
      },
      { label: 'kiosk-pairing-start' }
    );
    const r: any = (committed as any)?.result || {};
    if (r.limited) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'Too many pairing attempts. Try again in 15 minutes.' });
    }
    // The code and secret are returned ONCE, here — never stored in plain
    // form, never logged.
    return res.json({ pairingId: r.pairingId, code: r.code, deviceSecret: r.deviceSecret, expiresAt: new Date(r.expiresAt).toISOString() });
  } catch (err) {
    log.warn('[kiosk] pairing start failed:', (err as any)?.message);
    return res.status(503).json({ error: 'Please try again in a moment.' });
  }
});

// B2 — the tablet polls for approval with its pairing secret. One 404
// message covers unknown id, wrong secret, and expired. Polling is a
// PURE READ in every case: approval does NOT consume the pairing
// (addendum, finding 3) — the same secret re-claims the same device
// idempotently until the claim deadline, which is DERIVED from the
// approval stamp (approvedAt + 10 min), never stored or written.
app.get('/api/kiosk/pairing/status', async (req, res) => {
  if (kioskHeaderTooLong(req, 'x-kiosk-pairing')) {
    return res.status(400).json({ error: 'Request too large.' });
  }
  const parsed = parseKioskSecretHeader(req, 'x-kiosk-pairing');
  const notFound = () => res.status(404).json({ error: 'Pairing expired. Start again on the tablet.' });
  if (!parsed) return notFound();
  const nowMs = Date.now();
  const pairing = kioskPairings[parsed.id];
  if (!pairing) return notFound();
  if (!timingSafeStrEq(sha256Hex(parsed.secret), pairing.secretHash)) return notFound();
  if (pairing.status === 'pending') {
    if (pairing.expiresAt <= nowMs) return notFound();
    return res.json({ status: 'pending', expiresAt: new Date(pairing.expiresAt).toISOString() });
  }
  // Approved: usable until the derived claim deadline (checked here, at
  // read time — not only by pruning).
  if (pairingEffectiveExpiry(pairing) <= nowMs) return notFound();
  const device = kioskDevices.find((d) => d.id === pairing.deviceId);
  if (!device) return notFound();
  const safe = safeKioskDevice(device);
  return res.json({ status: 'approved', device: { id: safe.id, name: safe.name, venueId: safe.venueId, venueName: safe.venueName, agencyId: safe.agencyId } });
});

// B3 — a paired tablet reads its own venue + PIN-enabled staff roster.
// Authenticated by the device secret; never by a venue parameter.
app.get('/api/kiosk/device', async (req, res) => {
  if (kioskHeaderTooLong(req, 'x-kiosk-device')) {
    return res.status(400).json({ error: 'Request too large.' });
  }
  const device = resolveKioskDevice(req);
  if (!device) {
    return res.status(401).json({ error: 'This tablet is not paired.', code: 'KIOSK_UNPAIRED' });
  }
  const staff = users
    // K1: admins with a code are listed on every tablet of their own agency
    // (kioskUserFitsVenue); everyone else only at their own venue.
    .filter((u) => kioskUserFitsVenue(u, device.agencyId, device.venueId) && (u.kioskPin || u.kioskPinHash) && ['mashgiach', 'worker', 'coordinator', 'admin'].includes(u.role))
    .map((u) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor, role: u.role }));
  const safe = safeKioskDevice(device);
  // Touch lastSeenAt at most once per 10 minutes — best-effort, never
  // throws into the response (a failed touch still serves the roster).
  // The touch is AWAITED before the response: it bumps the document
  // version, and the X-State-Version header on this response must carry
  // the bumped version. Fire-and-forget, the commit landed AFTER the
  // header went out (it retries behind the sign-in and the first task
  // writes), the tablet never heard the new version, and its next task
  // write answered 409 "data changed, refresh" right after PIN sign-in.
  const lastSeenMs = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  if (Date.now() - lastSeenMs > 10 * 60 * 1000) {
    await commitState(
      (freshDoc) => {
        const devs: any[] = Array.isArray(freshDoc.kioskDevices) ? freshDoc.kioskDevices : [];
        const next = devs.map((d) => (d && d.id === device.id ? { ...d, lastSeenAt: new Date().toISOString() } : d));
        return { doc: { ...freshDoc, kioskDevices: next }, result: { ok: true } };
      },
      { label: 'kiosk-device-seen' }
    ).catch(() => {});
  }
  return res.json({ device: { id: safe.id, name: safe.name, venueId: safe.venueId, venueName: safe.venueName }, users: staff });
});

// B5 — a tablet unpairs itself ("exit kiosk mode"). Device-authenticated;
// kills its own sessions (C3) in the same request.
app.post('/api/kiosk/device/unpair', async (req, res) => {
  if (kioskHeaderTooLong(req, 'x-kiosk-device')) {
    return res.status(400).json({ error: 'Request too large.' });
  }
  const device = resolveKioskDevice(req);
  if (!device) {
    return res.status(401).json({ error: 'This tablet is not paired.', code: 'KIOSK_UNPAIRED' });
  }
  try {
    await commitState(
      (freshDoc) => {
        const devs: any[] = Array.isArray(freshDoc.kioskDevices) ? freshDoc.kioskDevices : [];
        return {
          doc: { ...freshDoc, kioskDevices: devs.filter((d) => d && d.id !== device.id) },
          result: { ok: true },
        };
      },
      { label: 'kiosk-device-self-unpair' }
    );
  } catch (err) {
    log.warn('[kiosk] self-unpair failed:', (err as any)?.message);
    return res.status(503).json({ error: 'Please try again in a moment.' });
  }
  closeKioskSocketsForDevice(device.id);
  broadcast('KIOSK_DEVICES_UPDATED', { agencyId: device.agencyId, venueId: device.venueId }, undefined, device.agencyId);
  return res.json({ ok: true });
});

// D1 — the "Kiosk tablets" list (phone session). Admin: the whole agency's
// devices; coordinator: their own venue's only (rule T); others → 403.
app.get('/api/kiosk/devices', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  if (caller.role !== 'admin' && caller.role !== 'coordinator') {
    return res.status(403).json({ error: 'Only admins and coordinators can manage kiosk tablets.' });
  }
  const agencyId = caller.agencyId || 'agency-hkc';
  let list = kioskDevices.filter((d) => d.agencyId === agencyId);
  if (caller.role === 'coordinator') {
    const scope = venueScopeFor(caller);
    list = scope === 'agency' ? list : list.filter((d) => (scope as string[]).includes(d.venueId));
  }
  return res.json({ devices: list.map(safeKioskDevice) });
});

// D2 — pair a tablet: the phone enters the code the tablet shows.
app.post('/api/kiosk/devices/pair', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  if (caller.role !== 'admin' && caller.role !== 'coordinator') {
    return res.status(403).json({ error: 'Only admins and coordinators can pair kiosk tablets.' });
  }
  // Input bounds first (finding 5): small body, code exactly 6 chars,
  // name at most 40 — anything over is a 400 before any lookup.
  if (kioskBodyTooLarge(req)) {
    return res.status(400).json({ error: 'Request too large.' });
  }
  const { code, venueId, name } = req.body || {};
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (normalizedCode.length !== 6) {
    return res.status(400).json({ error: 'Enter the 6-character code from the tablet.' });
  }
  if (!venueId || typeof venueId !== 'string') {
    return res.status(400).json({ error: 'venueId is required.' });
  }
  const rawName = name === undefined || name === null ? '' : String(name).trim();
  if (rawName.length > 40) {
    return res.status(400).json({ error: 'Tablet name is too long (40 characters max).' });
  }
  // Venue gate (rule T), first pass from the cache: admin → any venue in
  // their agency; coordinator → their own venue only. The authoritative
  // gate re-runs inside the main transaction on the FRESH caller and
  // venue (finding 2 / rule AB).
  const venue = venues.find((v) => v.id === venueId);
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  if (!venue) {
    return res.status(404).json({ error: 'Venue not found.' });
  }
  if ((venue.agencyId || 'agency-hkc') !== callerAgencyId) {
    return res.status(403).json({ error: 'You can only pair tablets for venues in your own agency.' });
  }
  if (caller.role === 'coordinator' && !callerMaySeeVenue(caller, venueId)) {
    return res.status(403).json({ error: 'You can only pair tablets for your own venue.' });
  }
  const deviceName = rawName || `${venue.name} tablet`;
  const clientIp = getClientIp(req);
  const nowMs = Date.now();
  const attemptTs = new Date(nowMs).toISOString();
  const CALLER_MAX = 5;
  const IP_MAX = 20;
  const callerKey = `caller|${caller.id}`;
  const ipKey = `pairip|${clientIp}`;
  const readLimits = (doc: any) =>
    prunePairingLimitsMap(
      (doc.kioskPairingLimits && typeof doc.kioskPairingLimits === 'object'
        ? doc.kioskPairingLimits : {}) as { [k: string]: string[] },
      nowMs
    );
  // Finding 4: ATOMIC reservation BEFORE any hash compare (the 2a login
  // pattern). The attempt is counted per caller (5/15 min) and per IP
  // (20/15 min) in its own transaction; a locked bucket answers 429 even
  // for a right code; a failed reservation write fails CLOSED (503, no
  // compare ever happens).
  let reservation: any;
  try {
    reservation = await commitState(
      (freshDoc) => {
        const limits = readLimits(freshDoc);
        if ((limits[callerKey] || []).length >= CALLER_MAX || (limits[ipKey] || []).length >= IP_MAX) {
          return { doc: { ...freshDoc, kioskPairingLimits: limits }, result: { locked: true } };
        }
        limits[callerKey] = [...(limits[callerKey] || []), attemptTs];
        limits[ipKey] = [...(limits[ipKey] || []), attemptTs];
        return { doc: { ...freshDoc, kioskPairingLimits: limits }, result: { locked: false } };
      },
      { label: 'kiosk-pair-reservation' }
    );
  } catch (err) {
    log.warn('[kiosk] pair reservation failed:', (err as any)?.message);
    return res.status(503).json({ error: 'Please try again in a moment.' });
  }
  if ((reservation as any)?.result?.locked) {
    res.set('Retry-After', '900');
    return res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
  }
  try {
    const committed = await commitState(
      (freshDoc) => {
        // Finding 2 (rule AB + rule N): re-read the CALLER from the fresh
        // doc, normalized exactly like hydration, and re-run the whole
        // gate against fresh data — a coordinator reassigned between the
        // cache read and this commit can no longer pair for the old venue,
        // and the destination venue must still exist in the caller's
        // (fresh) agency.
        const rawUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
        const rawCaller = rawUsers.find((u) => u && u.id === caller.id);
        if (!rawCaller) {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        const freshCaller = normalizeStoredUser(rawCaller);
        if (freshCaller.role !== 'admin' && freshCaller.role !== 'coordinator') {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        const freshAgencyId = freshCaller.agencyId || 'agency-hkc';
        const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
        const freshVenue = freshVenues.find((v) => v.id === venueId);
        if (!freshVenue || (freshVenue.agencyId || 'agency-hkc') !== freshAgencyId) {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        if (freshCaller.role === 'coordinator' && !(venueScopeOf(freshCaller as any, freshVenues) as string[]).includes(venueId)) {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        // The code must map to a pairing that is still pending and
        // unexpired AT COMMIT TIME.
        const pairings = pruneKioskPairings(
          (freshDoc.kioskPairings && typeof freshDoc.kioskPairings === 'object' ? freshDoc.kioskPairings : {}) as { [k: string]: KioskPairing },
          nowMs
        );
        const codeHash = sha256Hex(normalizedCode);
        const entry = Object.entries(pairings).find(([, pr]) => pr.status === 'pending' && timingSafeStrEq(pr.pairingCodeHash, codeHash));
        if (!entry) {
          // Wrong/unknown/expired/used code — the reservation already
          // counted this attempt. One message for all four.
          return {
            doc: { ...freshDoc, kioskPairings: pairings },
            result: { invalid: true },
          };
        }
        const [pairingId, pairing] = entry;
        const deviceId = `kdev-${crypto.randomBytes(9).toString('hex')}`;
        const device: KioskDevice = {
          id: deviceId,
          agencyId: freshAgencyId,
          venueId,
          name: deviceName,
          secretHash: pairing.secretHash,
          createdAt: new Date(nowMs).toISOString(),
          pairedByUserId: freshCaller.id,
          pairedByName: freshCaller.name,
        };
        const devs: any[] = Array.isArray(freshDoc.kioskDevices) ? freshDoc.kioskDevices : [];
        pairings[pairingId] = { ...pairing, status: 'approved', deviceId, venueId, venueName: freshVenue.name, approvedAt: nowMs };
        // Success: take this attempt back out of the rate-limit buckets
        // (the 2a login pattern — only WRONG attempts accumulate).
        const limits = readLimits(freshDoc);
        for (const key of [callerKey, ipKey]) {
          const arr = limits[key] || [];
          const idx = arr.indexOf(attemptTs);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) delete limits[key];
          else limits[key] = arr;
        }
        return {
          doc: { ...freshDoc, kioskDevices: [...devs, device], kioskPairings: pairings, kioskPairingLimits: limits },
          result: { device },
        };
      },
      { label: 'kiosk-device-pair' }
    );
    const r: any = (committed as any)?.result || {};
    if (r.forbidden) {
      return res.status(409).json({ error: 'Your access changed while pairing. Refresh and try again.' });
    }
    if (r.invalid) {
      return res.status(404).json({ error: "That code isn't valid. Check the tablet and try again." });
    }
    broadcast('KIOSK_DEVICES_UPDATED', { agencyId: r.device.agencyId, venueId }, undefined, r.device.agencyId);
    return res.status(201).json({ device: safeKioskDevice(r.device) });
  } catch (err) {
    log.warn('[kiosk] pair failed:', (err as any)?.message);
    return res.status(503).json({ error: 'Please try again in a moment.' });
  }
});

// D3 — unpair a tablet (phone session). A device in the caller's agency at
// another venue → 403 for a coordinator; a device in another agency → 404
// (never reveal it exists). Unpair kills the device's sessions (C3).
app.delete('/api/kiosk/devices/:id', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  if (caller.role !== 'admin' && caller.role !== 'coordinator') {
    return res.status(403).json({ error: 'Only admins and coordinators can manage kiosk tablets.' });
  }
  if (String(req.params.id || '').length > 64) {
    return res.status(404).json({ error: 'Tablet not found.' });
  }
  const device = kioskDevices.find((d) => d.id === req.params.id);
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  if (!device || device.agencyId !== callerAgencyId) {
    return res.status(404).json({ error: 'Tablet not found.' });
  }
  if (caller.role === 'coordinator' && !callerMaySeeVenue(caller, device.venueId)) {
    return res.status(403).json({ error: 'You can only unpair tablets at your own venue.' });
  }
  let unpairResult: any;
  try {
    const committed = await commitState(
      (freshDoc) => {
        // Finding 2: re-read caller AND device from the fresh doc and
        // re-run the gate there — a coordinator reassigned since the
        // cache read can no longer unpair the old venue's tablet.
        const devs: any[] = Array.isArray(freshDoc.kioskDevices) ? freshDoc.kioskDevices : [];
        const freshDevice = devs.find((d) => d && d.id === device.id);
        if (!freshDevice) {
          // Already gone (concurrent unpair / venue cascade) — the end
          // state the caller asked for already holds.
          return { doc: freshDoc, result: { ok: true, alreadyGone: true } };
        }
        const rawUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
        const rawCaller = rawUsers.find((u) => u && u.id === caller.id);
        if (!rawCaller) {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        const freshCaller = normalizeStoredUser(rawCaller);
        const freshAgencyId = freshCaller.agencyId || 'agency-hkc';
        if (freshDevice.agencyId !== freshAgencyId) {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        if (freshCaller.role === 'coordinator' &&
            !(venueScopeOf(freshCaller as any, Array.isArray(freshDoc.venues) ? freshDoc.venues : []) as string[]).includes(freshDevice.venueId)) {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        if (freshCaller.role !== 'admin' && freshCaller.role !== 'coordinator') {
          return { doc: freshDoc, result: { forbidden: true } };
        }
        return {
          doc: { ...freshDoc, kioskDevices: devs.filter((d) => d && d.id !== device.id) },
          result: { ok: true },
        };
      },
      { label: 'kiosk-device-unpair' }
    );
    unpairResult = (committed as any)?.result || {};
  } catch (err) {
    log.warn('[kiosk] unpair failed:', (err as any)?.message);
    return res.status(503).json({ error: 'Please try again in a moment.' });
  }
  if (unpairResult.forbidden) {
    return res.status(409).json({ error: 'Your access changed. Refresh and try again.' });
  }
  if (!unpairResult.alreadyGone) {
    closeKioskSocketsForDevice(device.id);
    broadcast('KIOSK_DEVICES_UPDATED', { agencyId: device.agencyId, venueId: device.venueId }, undefined, device.agencyId);
  }
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Kiosk pairing & devices (2b) — helpers
// ---------------------------------------------------------------------------

const sha256Hex = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');

function timingSafeStrEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Parse an 'X-Kiosk-*' header of the form '<id>.<secret>'. */
function parseKioskSecretHeader(req: any, headerName: string): { id: string; secret: string } | null {
  const raw = String(req.headers[headerName] || '');
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const id = raw.slice(0, dot);
  if (id.length > 64) return null;
  return { id, secret: raw.slice(dot + 1) };
}

/**
 * The PIN revision of a user record, validated on read (addendum): only a
 * non-negative INTEGER counts. Anything else (missing, float, string) is
 * "no revision" — tokens carrying it fail, and the next PIN write restarts
 * the counter from a clean integer.
 */
function pinRevOf(u: any): number | undefined {
  const r = u?.kioskPinRev;
  return Number.isInteger(r) && r >= 0 ? r : undefined;
}

/**
 * A device is usable only while it exists AND its venue still exists AND
 * that venue still belongs to the device's agency (addendum, finding 6).
 */
function liveKioskDevice(id: string | undefined): KioskDevice | null {
  if (!id) return null;
  const device = kioskDevices.find((d) => d.id === id);
  if (!device) return null;
  const venue = venues.find((v) => v.id === device.venueId);
  if (!venue) return null;
  if ((venue.agencyId || 'agency-hkc') !== device.agencyId) return null;
  return device;
}

/**
 * Resolve the caller's kiosk DEVICE from the X-Kiosk-Device header
 * ('<deviceId>.<deviceSecret>'). Returns null for a missing header, an
 * unknown id, a wrong secret, or a device whose venue is gone/moved —
 * callers answer all of them identically.
 */
function resolveKioskDevice(req: any): KioskDevice | null {
  const parsed = parseKioskSecretHeader(req, 'x-kiosk-device');
  if (!parsed) return null;
  const device = liveKioskDevice(parsed.id);
  if (!device) return null;
  if (!timingSafeStrEq(sha256Hex(parsed.secret), device.secretHash)) return null;
  return device;
}

/**
 * Verify a device credential string ('<deviceId>.<secret>') — the WS proof
 * frame's form of the X-Kiosk-Device header. When expectedId is given, the
 * credential must be for THAT device (a valid credential for a different
 * tablet proves nothing). Hash compare is timing-safe.
 */
function verifyKioskDeviceCredential(credential: unknown, expectedId?: string): KioskDevice | null {
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 200) return null;
  const dot = credential.indexOf('.');
  if (dot <= 0 || dot === credential.length - 1) return null;
  const id = credential.slice(0, dot);
  if (id.length > 64) return null;
  if (expectedId && id !== expectedId) return null;
  const device = liveKioskDevice(id);
  if (!device) return null;
  if (!timingSafeStrEq(sha256Hex(credential.slice(dot + 1)), device.secretHash)) return null;
  return device;
}

/** Finding 5: an X-Kiosk-* header over 200 chars is a 400, before any lookup. */
function kioskHeaderTooLong(req: any, headerName: string): boolean {
  const raw = req.headers[headerName];
  return typeof raw === 'string' && raw.length > 200;
}

/** Finding 5: JSON bodies on the pairing routes stay small (4 KB is ample). */
function kioskBodyTooLarge(req: any): boolean {
  try {
    return JSON.stringify(req.body || {}).length > 4096;
  } catch {
    return true;
  }
}

/** The SAFE device shape — the only form a device record ever leaves in. */
function safeKioskDevice(d: KioskDevice) {
  const venue = venues.find((v) => v.id === d.venueId);
  return {
    id: d.id,
    name: d.name,
    venueId: d.venueId,
    venueName: venue?.name || d.venueId,
    agencyId: d.agencyId,
    createdAt: d.createdAt,
    pairedByName: d.pairedByName,
    lastSeenAt: d.lastSeenAt,
  };
}

/** The moment a pairing stops being usable: pending pairings die at
 * expiresAt; approved ones live until their claim deadline, which is
 * DERIVED (approvedAt + TTL) — status polling never writes. */
function pairingEffectiveExpiry(pr: KioskPairing): number {
  if (pr.status === 'approved') {
    return (pr.approvedAt ?? pr.expiresAt) + PAIRING_TTL_MS;
  }
  return pr.expiresAt;
}

/** Drop expired pairings (pending or approved past their claim deadline). */
function pruneKioskPairings(map: { [k: string]: KioskPairing }, nowMs: number) {
  const out: { [k: string]: KioskPairing } = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (v && typeof v.expiresAt === 'number' && pairingEffectiveExpiry(v) > nowMs) out[k] = v;
  }
  return out;
}

/** Drop pairing-limit timestamps older than the window; drop empty buckets. */
function prunePairingLimitsMap(map: { [k: string]: string[] }, nowMs: number) {
  const out: { [k: string]: string[] } = {};
  for (const [k, v] of Object.entries(map || {})) {
    const kept = (Array.isArray(v) ? v : []).filter((t) => nowMs - new Date(t).getTime() < PAIRING_LIMIT_WINDOW_MS);
    if (kept.length) out[k] = kept;
  }
  return out;
}

/**
 * A4 (2a backlog): prune dead PIN-lockout entries — every fail older than
 * the window AND no live lock. Applied inside every kiosk-login commit.
 */
function pruneKioskPinLockouts(lockouts: KioskPinLockouts, nowMs: number, windowMs: number): KioskPinLockouts {
  const pruneMap = (m: { [k: string]: { fails: string[]; lockedUntil?: number } }) => {
    const out: { [k: string]: { fails: string[]; lockedUntil?: number } } = {};
    for (const [k, v] of Object.entries(m || {})) {
      const fails = (v?.fails || []).filter((t) => nowMs - new Date(t).getTime() < windowMs);
      const locked = (v?.lockedUntil || 0) > nowMs;
      if (fails.length || locked) out[k] = { fails, ...(v?.lockedUntil ? { lockedUntil: v.lockedUntil } : {}) };
    }
    return out;
  };
  return { users: pruneMap(lockouts.users || {}), tablets: pruneMap(lockouts.tablets || {}) };
}

/** Kill every live kiosk socket bound to a device (C3 — unpair is immediate). */
function closeKioskSocketsForDevice(deviceId: string) {
  for (const [ws, meta] of activeSockets.entries()) {
    if (meta.kiosk && meta.kioskDeviceId === deviceId) {
      try {
        ws.close(4401, 'Unauthorized');
      } catch {}
      activeSockets.delete(ws);
    }
  }
}

// Verify a kiosk PIN and return a venue-scoped kiosk session token.
// PINs are bcrypt-hashed (cost 10); legacy plain PINs are upgraded on login.
// Lockout: 5 wrong PINs in 15 min locks the user for 15 min; 20 wrong from
// one venue+IP in 15 min locks that tablet for 15 min. Counters live in the
// state doc (survive restarts); the check-and-increment runs in a transaction.
// Unknown userIds count against the tablet bucket the request names
// (no bypass by changing identifiers).
app.post('/api/kiosk/login', async (req, res) => {
  if (kioskHeaderTooLong(req, 'x-kiosk-device')) {
    return res.status(400).json({ error: 'Request too large.' });
  }
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'Missing credentials' });
  // 2b: the tablet must be PAIRED. A missing/invalid device header → 401
  // KIOSK_UNPAIRED and NOTHING is counted (no lockout writes at all). The
  // venue is the DEVICE's venue — any body venueId is ignored entirely.
  const device = resolveKioskDevice(req);
  if (!device) {
    return res.status(401).json({ error: 'This tablet is not paired.', code: 'KIOSK_UNPAIRED' });
  }
  const venueId = device.venueId;
  const user = users.find((u) => u.id === userId);

  const clientIp = getClientIp(req);
  const nowMs = Date.now();
  const LOCK_WINDOW_MS = 15 * 60 * 1000;
  const USER_MAX = 5;
  const TABLET_MAX = 20;

  // Unknown user: count against the tablet bucket (venue|ip) so it shares
  // one consistent limiter with real attempts from the same tablet.
  if (!user) {
    const unknownKey = `${venueId}|${clientIp}`;
    try {
      const locked = await commitState(
        (freshDoc) => {
          const fresh = pruneKioskPinLockouts(
            (freshDoc.kioskPinLockouts && typeof freshDoc.kioskPinLockouts === 'object'
              ? freshDoc.kioskPinLockouts
              : { users: {}, tablets: {} }) as KioskPinLockouts,
            nowMs, LOCK_WINDOW_MS
          );
          const prune = (arr: any): string[] =>
            (Array.isArray(arr) ? arr : []).filter((t: string) => nowMs - new Date(t).getTime() < LOCK_WINDOW_MS);
          const entry = fresh.tablets[unknownKey] || { fails: [] };
          if (entry.lockedUntil && entry.lockedUntil > nowMs) {
            return { doc: freshDoc, result: { locked: true, retryAfter: entry.lockedUntil - nowMs } };
          }
          const fails = [...prune(entry.fails), new Date(nowMs).toISOString()];
          const updated: { fails: string[]; lockedUntil?: number } = { fails };
          if (fails.length > TABLET_MAX) updated.lockedUntil = nowMs + LOCK_WINDOW_MS;
          // IP-wide bucket in the same reservation (stops venue-id cycling).
          const ipKey2 = `ip|${clientIp}`;
          const ipEntry = fresh.tablets[ipKey2] || { fails: [] };
          const ipFails = [...prune(ipEntry.fails), new Date(nowMs).toISOString()];
          const ipUpdated: { fails: string[]; lockedUntil?: number } = { fails: ipFails };
          let ipLocked = false;
          if (ipFails.length > 40) {
            ipUpdated.lockedUntil = nowMs + LOCK_WINDOW_MS;
            ipLocked = true;
          }
          const tabletsOut = { ...fresh.tablets, [unknownKey]: updated, [ipKey2]: ipUpdated };
          if (ipLocked) {
            return { doc: { ...freshDoc, kioskPinLockouts: { ...fresh, tablets: tabletsOut } }, result: { locked: true, retryAfter: LOCK_WINDOW_MS } };
          }
          return {
            doc: { ...freshDoc, kioskPinLockouts: { ...fresh, tablets: tabletsOut } },
            result: { locked: false },
          };
        },
        { label: 'kiosk-pin-fail-unknown' }
      );
      if ((locked.result as any)?.locked) {
        const retrySec = Math.ceil(((locked.result as any).retryAfter || 60000) / 1000);
        res.set('Retry-After', String(retrySec));
        return res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(retrySec / 60)} minutes.` });
      }
    } catch {}
    // Don't reveal whether the user exists.
    return res.status(401).json({ error: 'Wrong code. Try again.' });
  }

  // 2b venue binding (K1: one helper): the user must fit the DEVICE's
  // agency and venue — an admin fits any tablet of the own agency, everyone
  // else only their own venue. EVERY other case (other venue, other agency)
  // is answered exactly like a wrong PIN, counted by the reservation below.
  // K1: an admin who signs in here gets a kiosk session whose identity is a
  // MASHGIACH at this tablet's venue (kioskActingUser) — never admin powers.
  const userMatchesDevice = kioskUserFitsVenue(user, device.agencyId, device.venueId);

  const tabletKey = `${venueId}|${clientIp}`;
  const ipKey = `ip|${clientIp}`;
  const IP_MAX = 40;

  // ATOMIC reservation: count the ATTEMPT (not the failure) inside one
  // transaction BEFORE any compare. A burst of parallel attempts serializes
  // here — 5 get a compare, the rest are refused. If the reservation
  // commit fails, fail closed (no compare for an uncounted attempt).
  // Buckets: per-user (5), per venue+IP tablet (20), per IP (40, stops
  // identifier/venue cycling). Threshold: N compares allowed, the (N+1)th
  // refused — "after 5 wrong PINs" means 5×401 then 429.
  let reservation: { allowed: boolean; retryAfterMs?: number };
  try {
    const res = await commitState(
      (freshDoc) => {
        const fresh = pruneKioskPinLockouts(
          (freshDoc.kioskPinLockouts && typeof freshDoc.kioskPinLockouts === 'object'
            ? freshDoc.kioskPinLockouts
            : { users: {}, tablets: {} }) as KioskPinLockouts,
          nowMs, LOCK_WINDOW_MS
        );
        const prune = (arr: any): string[] =>
          (Array.isArray(arr) ? arr : []).filter((t: string) => nowMs - new Date(t).getTime() < LOCK_WINDOW_MS);
        const reserve = (
          bucket: { [k: string]: { fails: string[]; lockedUntil?: number } },
          key: string,
          max: number
        ): [{ [k: string]: { fails: string[]; lockedUntil?: number } }, { allowed: boolean; retryAfterMs?: number }] => {
          const entry = bucket[key] || { fails: [] };
          if (entry.lockedUntil && entry.lockedUntil > nowMs) {
            return [bucket, { allowed: false, retryAfterMs: entry.lockedUntil - nowMs }];
          }
          const fails = [...prune(entry.fails), new Date(nowMs).toISOString()];
          const updated: { fails: string[]; lockedUntil?: number } = { fails };
          // Refuse when the count BEFORE this attempt already reached max:
          // N compares allowed, the (N+1)th is refused and locks the bucket.
          if (fails.length > max) {
            updated.lockedUntil = nowMs + LOCK_WINDOW_MS;
            return [{ ...bucket, [key]: updated }, { allowed: false, retryAfterMs: LOCK_WINDOW_MS }];
          }
          return [{ ...bucket, [key]: updated }, { allowed: true }];
        };
        const [users2, userRes] = reserve(fresh.users || {}, userId, USER_MAX);
        if (!userRes.allowed) {
          return { doc: { ...freshDoc, kioskPinLockouts: { ...fresh, users: users2 } }, result: userRes };
        }
        const [tablets2, tabletRes] = reserve(fresh.tablets || {}, tabletKey, TABLET_MAX);
        if (!tabletRes.allowed) {
          return { doc: { ...freshDoc, kioskPinLockouts: { ...fresh, users: users2, tablets: tablets2 } }, result: tabletRes };
        }
        const [tablets3, ipRes] = reserve(tablets2, ipKey, IP_MAX);
        return {
          doc: { ...freshDoc, kioskPinLockouts: { users: users2, tablets: tablets3 } },
          result: ipRes,
        };
      },
      { label: 'kiosk-pin-attempt' }
    );
    reservation = (res as any).result || { allowed: false };
  } catch (err) {
    // Reservation failed (version conflict, Firestore unavailable): fail closed.
    // Never compare a PIN for an attempt that couldn't be counted.
    log.warn('[kiosk] attempt reservation failed (fail closed):', (err as any)?.message);
    return res.status(503).json({ error: 'Please try again in a moment.' });
  }

  if (!reservation.allowed) {
    const retrySec = Math.max(1, Math.ceil((reservation.retryAfterMs || 60000) / 1000));
    const retryMin = Math.ceil(retrySec / 60);
    res.set('Retry-After', String(retrySec));
    return res.status(429).json({ error: `Too many wrong codes. Try again in ${retryMin} minutes.` });
  }

  // Verify the PIN (hash first; legacy plain with transparent upgrade).
  // This compare was counted by the reservation above. A user who is not at
  // this device never reaches the compare — the attempt was counted and the
  // answer is the same 'Wrong code' a bad PIN gets.
  if (!userMatchesDevice) {
    return res.status(401).json({ error: 'Wrong code. Try again.' });
  }
  const pinStr = String(pin).trim();
  let pinValid = false;
  let needsUpgrade = false;
  if (user.kioskPinHash && isBcryptHash(user.kioskPinHash)) {
    pinValid = await bcrypt.compare(pinStr, user.kioskPinHash);
  } else if (user.kioskPin) {
    pinValid = user.kioskPin === pinStr;
    needsUpgrade = pinValid;
  }

  if (!pinValid) {
    // Already counted by the reservation; nothing more to write.
    return res.status(401).json({ error: 'Wrong code. Try again.' });
  }

  // Success: clear the user's fail counter, upgrade a legacy plain PIN to
  // bcrypt in the same transaction, and mint the venue-scoped kiosk token.
  // The token is minted only after the commit lands (counter reset / rehash),
  // carrying the fresh PIN version (pv) so a later PIN change revokes it.
  const agencyId = user.agencyId || 'agency-hkc';
  let kioskToken: string | null = null;
  try {
    const newHash = needsUpgrade ? await hashPassword(pinStr) : null;
    const committed = await commitState(
      (freshDoc) => {
        const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
        const freshUser = freshUsers.find((u) => u.id === user.id);
        if (!freshUser) return { conflict: 'User not found.' };
        // 2b: re-verify the DEVICE against the fresh doc (rule AB) — a
        // device unpaired between the header check and this commit must
        // not mint a token.
        const freshDevices: any[] = Array.isArray(freshDoc.kioskDevices) ? freshDoc.kioskDevices : [];
        const freshDevice = freshDevices.find((d) => d && d.id === device.id);
        if (!freshDevice || freshDevice.venueId !== device.venueId || freshDevice.agencyId !== device.agencyId) {
          return { conflict: 'This tablet is not paired.' };
        }
        // Re-verify against the FRESH record: the hash (or plain PIN) must be
        // the one just compared, agency/venue unchanged, role not admin, and
        // no lock placed meanwhile. Any difference → conflict, no token.
        const hashMatches = needsUpgrade
          ? (freshUser as any).kioskPin === user.kioskPin
          : (freshUser as any).kioskPinHash === user.kioskPinHash;
        const freshOk =
          hashMatches &&
          kioskUserFitsVenue(freshUser, agencyId, venueId);
        if (!freshOk) return { conflict: 'User changed during login. Please try again.' };
        const freshLocks = (freshDoc.kioskPinLockouts && typeof freshDoc.kioskPinLockouts === 'object'
          ? freshDoc.kioskPinLockouts
          : { users: {}, tablets: {} }) as KioskPinLockouts;
        const userLock = (freshLocks.users || {})[user.id];
        const tabletLock = (freshLocks.tablets || {})[tabletKey];
        if ((userLock?.lockedUntil || 0) > nowMs || (tabletLock?.lockedUntil || 0) > nowMs) {
          return { conflict: 'Too many wrong codes. Please try again later.' };
        }
        const newUsers = freshUsers.map((u) => {
          if (u.id !== user.id) return u;
          const nu: any = { ...u };
          if (newHash && !isBcryptHash(nu.kioskPinHash)) {
            nu.kioskPinHash = newHash;
            nu.kioskPin = undefined;
            nu.kioskPinSetAt = new Date().toISOString();
            // 2b: a legacy upgrade increments the PIN revision, in the
            // same transaction as the hash write.
            nu.kioskPinRev = (pinRevOf(nu) ?? 0) + 1;
          }
          // Pre-pv users: stamp the version on first post-pv login.
          if (!nu.kioskPinSetAt && nu.kioskPinHash) {
            nu.kioskPinSetAt = new Date().toISOString();
          }
          // 2b: the first post-rev login stamps the revision (rev = 1);
          // the token's pv is String(kioskPinRev) from now on.
          if (pinRevOf(nu) === undefined && nu.kioskPinHash) {
            nu.kioskPinRev = 1;
          }
          return nu;
        });
        const fresh = pruneKioskPinLockouts(
          (freshDoc.kioskPinLockouts && typeof freshDoc.kioskPinLockouts === 'object'
            ? freshDoc.kioskPinLockouts
            : { users: {}, tablets: {} }) as KioskPinLockouts,
          nowMs, LOCK_WINDOW_MS
        );
        const users2 = { ...(fresh.users || {}) };
        delete users2[user.id];
        // Only failures accumulate: remove this attempt's timestamp from BOTH
        // the venue|ip and the ip|<ip> buckets so a busy wall tablet (or several
        // tablets behind one public IP) can't lock itself by legitimate use.
        const tablets2 = { ...(fresh.tablets || {}) };
        const attemptTs = new Date(nowMs).toISOString();
        const removeAttempt = (key: string) => {
          if (tablets2[key]) {
            const fails = (tablets2[key].fails || []).filter((t: string) => t !== attemptTs);
            // A4: an entry with no fails left and no ACTIVE lock is a dead
            // key — drop it instead of leaving an empty husk in the doc
            // (an active lockedUntil is never shortened by cleanup).
            if (fails.length === 0 && !((tablets2[key].lockedUntil || 0) > nowMs)) {
              delete tablets2[key];
            } else {
              tablets2[key] = { ...tablets2[key], fails };
            }
          }
        };
        removeAttempt(tabletKey);
        removeAttempt(`ip|${clientIp}`);
        const freshTarget = newUsers.find((u) => u.id === user.id);
        return {
          doc: { ...freshDoc, users: newUsers, kioskPinLockouts: { ...fresh, users: users2, tablets: tablets2 } },
          result: { kioskPinRev: (freshTarget as any)?.kioskPinRev },
        };
      },
      { label: 'kiosk-login-success' }
    );
    const pv = (committed as any)?.result?.kioskPinRev;
    if (pv === undefined || pv === null) {
      // The commit didn't record a PIN revision — fail closed, no token.
      return res.status(503).json({ error: 'Please try again in a moment.' });
    }
    kioskToken = signKioskToken(user.id, agencyId, venueId, String(pv), device.id);
  } catch (err) {
    // Success requires the committed transition (counter reset / rehash).
    // If it didn't land, no token — the tablet must try again.
    log.warn('[kiosk] login success write failed:', (err as any)?.message);
    return res.status(503).json({ error: 'Please try again in a moment.' });
  }
  // K1: the tablet receives the ACTING user — an admin arrives as a
  // mashgiach at this venue, so the kiosk client renders no admin UI.
  res.json({ user: getSafeUser(kioskActingUser(user, venueId)), token: kioskToken });
});

// Formal Login Endpoint — bcrypt passwords, signed session token on success.
// Legacy plaintext passwords are transparently upgraded to bcrypt on login.
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter both your email and password.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);

  if (!user) {
    return res.status(401).json({ error: 'Account not found. Please verify your email or ask your admin to register you.' });
  }

  // First-run setup: admin account with no password yet → client shows the
  // "create your password" screen instead of an error.
  if (!user.password && user.role === 'admin') {
    return res.json({ success: false, needsSetup: true, email: user.email });
  }

  // No hardcoded fallback passwords: only the stored (bcrypt) password works.
  const result = await checkPassword(String(password), user.password);
  if (result === 'invalid') {
    return res.status(401).json({ error: 'Incorrect password. Please try again or request a reset.' });
  }
  if (result === 'valid-needs-upgrade') {
    // Upgrade the legacy password hash inside a transaction so the write is
    // atomic and versioned like every other write. Login still succeeds even
    // if the upgrade write fails (the user proved they know the password).
    const newHash = await hashPassword(String(password));
    try {
      await commitState(
        (freshDoc) => {
          const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
          const freshUser = freshUsers.find((u) => u.id === user.id);
          if (!freshUser) return { conflict: 'User not found.' };
          // Only upgrade if the stored password isn't already a bcrypt hash
          // (another concurrent login may have upgraded it first).
          if (isBcryptHash(freshUser.password)) {
            return { doc: freshDoc, result: { upgraded: false } };
          }
          const newUsers = freshUsers.map((u) => (u.id === user.id ? { ...u, password: newHash } : u));
          return { doc: { ...freshDoc, users: newUsers }, result: { upgraded: true } };
        },
        { label: 'login-password-upgrade' }
      );
    } catch (err) {
      log.warn('[login] Password-hash upgrade write failed (login still succeeds):', (err as any)?.message);
    }
  }

  const token = signSessionToken(users.find((u) => u.id === user.id) || user);
  res.json({
    success: true,
    user: getSelfUser(user),
    token,
  });
});

// Forgot password: Step 1 — request a reset code
// The code is pushed to agency admins (who pass it to the user verbally).
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);
  // Always return success (don't reveal if email exists)
  if (!user) {
    return res.json({ success: true, message: 'If this email is registered, a reset code was sent.' });
  }

  // Cryptographically secure 6-digit code (crypto.randomInt, not Math.random).
  const code = crypto.randomInt(100000, 1000000).toString();
  // Store only the hash — the plaintext code lives in this handler's memory
  // (for the admin push/broadcast below) and is never persisted or logged.
  const codeHash = hashResetCode(code);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
  const clientIp = getClientIp(req);
  const nowMs = Date.now();

  // Persist the reset request transactionally (survives restarts).
  // Rate limits are checked INSIDE the transaction against fresh data.
  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshResets: any[] = Array.isArray(freshDoc.passwordResets) ? freshDoc.passwordResets : [];
      const rawLimits = freshDoc.passwordResetRateLimits;
      const limits: PasswordResetRateLimits = rawLimits && typeof rawLimits === 'object'
        ? {
            emailRequests: rawLimits.emailRequests || {},
            ipRequests: rawLimits.ipRequests || {},
            ipVerifies: rawLimits.ipVerifies || {},
          }
        : emptyRateLimits();
      // 5 requests/hour per email, 10/hour per IP. Throws RateLimitError → 429.
      const afterEmail = checkRateLimit(limits, 'emailRequests', normalizedEmail, 5, nowMs);
      const afterIp = checkRateLimit(afterEmail, 'ipRequests', clientIp, 10, nowMs);
      const newResets = [
        ...freshResets.filter((r: any) => r.email !== normalizedEmail),
        { email: normalizedEmail, codeHash, expiresAt, verified: false, attempts: 0 },
      ];
      return {
        doc: { ...freshDoc, passwordResets: newResets, passwordResetRateLimits: afterIp },
        result: { success: true },
      };
    },
    { label: 'forgot-password' }
  );
  if (!committed) return;

  // TEST ONLY: stash the plaintext code so test-8 can retrieve it.
  // Gated by STAGE2_TEST_MODE — never populated in production.
  if (isTestMode()) {
    (global as any).__testLastResetCodes = (global as any).__testLastResetCodes || {};
    (global as any).__testLastResetCodes[normalizedEmail] = { code };
  }

  // Notify admins via push (they pass the code to the user) — only after commit.
  // Privacy: the reset code is NEVER broadcast over WebSocket. It was
  // previously sent in plaintext to every connected client of the agency.
  const agencyId = user.agencyId || 'agency-hkc';
  // RULE T: admins of the agency + coordinators of the reset user's venue only.
  const admins = users.filter((u) =>
    (u.agencyId || 'agency-hkc') === agencyId &&
    (u.role === 'admin' || (u.role === 'coordinator' && sharedVenues(u as any, user as any, venues as any).length > 0))
  );
  for (const admin of admins) {
    sendPushToUser(
      admin.email,
      `🔑 Password reset code for ${user.name}`,
      `Code: ${code} (expires in 15 min)`,
      { type: 'password-reset', email: normalizedEmail }
    );
  }
  // (No WebSocket broadcast: reset codes must never travel in plaintext
  // to every connected client.)
  res.json({ success: true, message: 'If this email is registered, a reset code was sent.' });
});

// Forgot password: Step 2 — verify the code
app.post('/api/auth/verify-reset-code', async (req, res) => {
  const { email, code } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const submittedCode = String(code || '').trim();
  const clientIp = getClientIp(req);
  const nowMs = Date.now();

  // All checks happen INSIDE the transaction against fresh data:
  // expiry, hash comparison (constant-time), attempt counting, and
  // per-IP verify rate limiting. 5 wrong attempts invalidates the request.
  const resetToken = crypto.randomUUID();
  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshResets: any[] = Array.isArray(freshDoc.passwordResets) ? freshDoc.passwordResets : [];
      const rawLimits = freshDoc.passwordResetRateLimits;
      const limits: PasswordResetRateLimits = rawLimits && typeof rawLimits === 'object'
        ? {
            emailRequests: rawLimits.emailRequests || {},
            ipRequests: rawLimits.ipRequests || {},
            ipVerifies: rawLimits.ipVerifies || {},
          }
        : emptyRateLimits();
      // 20 verify attempts/hour per IP. Throws RateLimitError → 429.
      const afterIpVerify = checkRateLimit(limits, 'ipVerifies', clientIp, 20, nowMs);

      const freshRequest = freshResets.find((r: any) => r.email === normalizedEmail);
      if (!freshRequest) {
        return {
          doc: { ...freshDoc, passwordResetRateLimits: afterIpVerify },
          result: { notFound: true },
        };
      }
      if (new Date(freshRequest.expiresAt).getTime() < nowMs) {
        return {
          doc: {
            ...freshDoc,
            passwordResets: freshResets.filter((r: any) => r.email !== normalizedEmail),
            passwordResetRateLimits: afterIpVerify,
          },
          result: { expired: true },
        };
      }
      if (!verifyResetCode(submittedCode, freshRequest)) {
        const attempts = (freshRequest.attempts || 0) + 1;
        if (attempts >= 5) {
          // Too many wrong guesses — invalidate the request entirely.
          return {
            doc: {
              ...freshDoc,
              passwordResets: freshResets.filter((r: any) => r.email !== normalizedEmail),
              passwordResetRateLimits: afterIpVerify,
            },
            result: { invalidated: true },
          };
        }
        const newResets = freshResets.map((r: any) =>
          r.email === normalizedEmail
            ? { ...r, attempts, lastAttemptAt: new Date(nowMs).toISOString() }
            : r
        );
        return {
          doc: { ...freshDoc, passwordResets: newResets, passwordResetRateLimits: afterIpVerify },
          result: { wrongCode: true, attemptsLeft: 5 - attempts },
        };
      }
      // Prevent double-verification: if already verified, return the existing token
      // (idempotent — the client may have retried after a lost response).
      if (freshRequest.verified && freshRequest.resetToken) {
        return {
          doc: { ...freshDoc, passwordResetRateLimits: afterIpVerify },
          result: { resetToken: freshRequest.resetToken },
        };
      }
      const newResets = freshResets.map((r: any) =>
        r.email === normalizedEmail ? { ...r, verified: true, resetToken } : r
      );
      return {
        doc: { ...freshDoc, passwordResets: newResets, passwordResetRateLimits: afterIpVerify },
        result: { resetToken },
      };
    },
    { label: 'verify-reset-code' }
  );
  if (!committed) return;
  if (committed.result && committed.result.wrongCode) {
    return res.status(400).json({
      error: `Incorrect code. ${committed.result.attemptsLeft} attempt(s) left before this code is invalidated.`,
    });
  }
  // notFound = no request (invalidated or never requested).
  // expired = request existed but past its TTL.
  if (!committed.result || committed.result.notFound) {
    return res.status(400).json({ error: 'No reset request found. Please request a new code.' });
  }
  if (committed.result.expired) {
    return res.status(400).json({ error: 'Code expired. Please request a new code.' });
  }
  if (committed.result.invalidated) {
    return res.status(400).json({ error: 'Too many incorrect attempts. This code has been invalidated. Please request a new code.' });
  }
  if (!committed.result.resetToken) {
    return res.status(400).json({ error: 'Code invalidated. Please request a new code.' });
  }
  res.json({ success: true, resetToken: committed.result.resetToken });
});

// Forgot password: Step 3 — set new password with reset token
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, resetToken, newPassword } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const request = passwordResets.find(
    (r) => r.email === normalizedEmail && r.verified && r.resetToken === resetToken
  );
  if (!request) {
    return res.status(400).json({ error: 'Invalid or expired reset token.' });
  }

  const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  // Hash BEFORE the transaction (CPU-heavy); the hash is deterministic input.
  const newHash = await hashPassword(String(newPassword));

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshUser = freshUsers.find((u) => u.id === user.id);
      if (!freshUser) return { conflict: 'Account not found.' };
      const freshResets: any[] = Array.isArray(freshDoc.passwordResets) ? freshDoc.passwordResets : [];
      // The reset request must still be valid in fresh data — prevents reuse
      // of a token that was already consumed by a concurrent request.
      const freshRequest = freshResets.find(
        (r) => r.email === normalizedEmail && r.verified && r.resetToken === resetToken
      );
      if (!freshRequest) return { conflict: 'Invalid or expired reset token.' };
      const newUsers = freshUsers.map((u) => (u.id === user.id ? { ...u, password: newHash } : u));
      // Consume the reset token atomically with the password change.
      const newResets = freshResets.filter((r) => r.email !== normalizedEmail);
      // SO ("sign-out-on-reset plan v2"): in the SAME commit, bump the row's
      // tokenEpoch (+1 from the fresh row) so every older session token of
      // this row is refused. Migrated rows only: a legacy row can only hold
      // v1 tokens, which need epoch 0, so a bump would lock it out for good.
      const signOutOthers = typeof freshUser.personId === 'string' && freshUser.personId === freshUser.id;
      return {
        doc: { ...freshDoc, users: newUsers, passwordResets: newResets },
        result: { userId: user.id, signedOutOthers: signOutOthers },
        ...(signOutOthers ? { tokenEpochBumpIds: [user.id] } : {}),
      };
    },
    { label: 'reset-password' }
  );
  if (!committed) return;

  // SO: the in-memory epoch is already bumped (commit hydrated). Close this
  // user's open phone sockets now, before responding — this runs whether or
  // not the reset request's own connection is still open. Kiosk sockets are
  // PIN + device sessions and are left alone.
  const signedOutOthers = (committed as any)?.result?.signedOutOthers === true;
  if (signedOutOthers) revokeUserPhoneSockets(user.id);

  const token = signSessionToken(users.find((u) => u.id === user.id) || user);
  res.json({ success: true, user: getSelfUser(users.find((u) => u.id === user.id)!), token });
});

// First-run admin setup — disabled in 8i. It was public and set a password on
// ANY admin account that had none, which a stranger could claim (e.g. after
// the seed admin was re-created without a password). "No password stored" is
// not proof of who is asking, so public bootstrap is closed for every request:
// no state is read or written. First-run bootstrap moves to a separately
// reviewed operator workflow; forgotten passwords use the reset-code flow.
app.post('/api/auth/setup', (req, res) => {
  res.status(403).json({ error: 'Setup is already complete.' });
});

// Change Password Endpoint — requires a valid session; the caller can only
// change their OWN password (identity comes from the verified token).
app.post('/api/auth/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are both required.' });
  }

  if (String(newPassword).trim().length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
  }

  const authUser = (req as any).authUser;
  const user = users.find((u) => u.id === authUser.id);
  if (!user) {
    return res.status(404).json({ error: 'User account not found.' });
  }

  const result = await checkPassword(String(currentPassword), user.password);
  if (result === 'invalid') {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  // Hash BEFORE the transaction (CPU-heavy).
  const newHash = await hashPassword(String(newPassword).trim());

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshUser = freshUsers.find((u) => u.id === user.id);
      if (!freshUser) return { conflict: 'User account not found.' };
      // Re-verify the current password against FRESH data — if someone changed
      // it concurrently, the old password no longer proves ownership.
      // (Synchronous check: the mutator must stay pure and re-runnable.)
      const freshStored = freshUser.password;
      const freshValid = isBcryptHash(freshStored)
        ? bcrypt.compareSync(String(currentPassword), freshStored)
        : freshStored === String(currentPassword);
      if (!freshValid) {
        return { conflict: 'Your password was changed by another session. Please sign in again.' };
      }
      const newUsers = freshUsers.map((u) => (u.id === user.id ? { ...u, password: newHash } : u));
      return { doc: { ...freshDoc, users: newUsers }, result: { success: true } };
    },
    { label: 'change-password' }
  );
  if (!committed) return;

  res.json({ success: true, message: 'Password updated successfully.' });
});

// ==========================================
// AIRTABLE & FACTORY INGREDIENTS AUDIT APIS
// ==========================================

// Get Airtable Config for agency or venue
app.get('/api/airtable/config', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const venueScope = scopedVenueIds(req, res);
  if (!venueScope) return;
  // Empty scope (non-admin with no venue): 403 — a venue-less caller gets
  // no config, not the agency-level one. This check runs BEFORE the lookup
  // below, which would otherwise fall through to the agency config.
  if (venueScope !== 'agency' && venueScope.length === 0) {
    return res.status(403).json({ error: 'No venue assigned.' });
  }
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  // For non-privileged callers the venue is forced to their own venue;
  // privileged callers may narrow by ?venueId (already validated).
  const venueId = venueScope === 'agency' ? String(req.query.venueId || '') : venueScope[0];

  const config =
    (venueId ? airtableConfigs.find((c) => c.venueId === venueId && c.agencyId === callerAgencyId) : null) ||
    airtableConfigs.find((c) => c.agencyId === callerAgencyId) || {
      agencyId: callerAgencyId,
      venueId: venueId ? String(venueId) : undefined,
      baseId: '',
      tableName: 'Approved Ingredients',
      viewName: 'Grid view',
    };

  // Mask apiKey for safety if present
  const safeConfig = {
    ...config,
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-4)}` : '',
    hasApiKey: Boolean(config.apiKey),
  };

  res.json({ config: safeConfig });
});

// Save or Update Airtable Config
app.post('/api/airtable/config', async (req, res) => {
  // Airtable config is agency settings: admin only, from the session token.
  const caller = requireAdmin(req, res);
  if (!caller) return;
  // Configs always live in the caller's agency — never trust a client-supplied agencyId.
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  if (req.body?.agencyId && req.body.agencyId !== callerAgencyId) {
    return res.status(403).json({ error: 'You can only configure Airtable for your own agency.' });
  }

  const { venueId, apiKey, baseId, tableName, viewName, fieldNameMapping } = req.body;

  const configId = `atcfg_${Date.now()}`;
  const nowIso = new Date().toISOString();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.airtableConfigs) ? freshDoc.airtableConfigs : [];
      // Upsert: match on agencyId + venueId against FRESH data.
      const existingIdx = arr.findIndex(
        (c) => c.agencyId === callerAgencyId && (venueId ? c.venueId === venueId : true)
      );
      const existing = existingIdx >= 0 ? arr[existingIdx] : null;
      // Sensitive fields are NEVER blanked by an update that omits them: a new
      // value overwrites only when explicitly provided (non-empty). This keeps
      // the frontend from wiping the stored API key / base ID when it saves
      // the config form without re-sending secrets.
      const incomingApiKey = apiKey === undefined || apiKey === null ? '' : String(apiKey).trim();
      const incomingBaseId = baseId === undefined || baseId === null ? '' : String(baseId).trim();
      const updatedConfig: AirtableConfigItem = {
        id: existing ? existing.id : configId,
        agencyId: callerAgencyId,
        venueId: venueId || undefined,
        apiKey: incomingApiKey !== '' ? incomingApiKey : (existing?.apiKey || ''),
        baseId: incomingBaseId !== '' ? incomingBaseId : (existing?.baseId || ''),
        tableName: (tableName || 'Approved Ingredients').trim(),
        viewName: (viewName || 'Grid view').trim(),
        fieldNameMapping: fieldNameMapping || (existing ? existing.fieldNameMapping : undefined),
        lastSyncedAt: existing ? existing.lastSyncedAt : nowIso,
        autoSyncEnabled: true,
      };
      const newArr = existingIdx >= 0
        ? arr.map((c, i) => (i === existingIdx ? updatedConfig : c))
        : [...arr, updatedConfig];
      return { doc: { ...freshDoc, airtableConfigs: newArr }, result: updatedConfig };
    },
    { label: 'save-airtable-config', requireVersion: true }
  );
  if (!committed) return;
  const updatedConfig = committed.result as AirtableConfigItem;
  res.json({
    success: true,
    config: {
      ...updatedConfig,
      apiKey: updatedConfig.apiKey ? `${updatedConfig.apiKey.slice(0, 4)}...${updatedConfig.apiKey.slice(-4)}` : '',
      hasApiKey: Boolean(updatedConfig.apiKey),
    },
  });
});

// Sync from Airtable directly or simulate with custom/live schema
app.post('/api/airtable/sync', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { venueId } = req.body;
  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required to sync factory ingredients.' });
  }

  const callerAgencyId = caller.agencyId || 'agency-hkc';
  const callerName = caller.name;

  if (!requireOwnVenue(req, res, venueId, venues)) return;

  const config =
    airtableConfigs.find((c) => c.venueId === venueId && c.agencyId === callerAgencyId) ||
    airtableConfigs.find((c) => c.agencyId === callerAgencyId);

  if (!config || !config.baseId || !config.tableName) {
    return res.status(400).json({
      error: 'Airtable Base ID and Table Name must be configured before syncing.',
      needsConfig: true,
    });
  }

  // If live Airtable Personal Access Token (PAT) is supplied, query Airtable REST API
  if (config.apiKey && config.apiKey.startsWith('pat')) {
    try {
      const url = `https://api.airtable.com/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.tableName)}${config.viewName ? `?view=${encodeURIComponent(config.viewName)}` : ''}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });

      if (!response.ok) {
        const errBody = await response.text();
        return res.status(response.status).json({
          error: `Airtable API Error (${response.status}): ${errBody}`,
        });
      }

      const data = await response.json();
      const records = data.records || [];

      const mapping = config.fieldNameMapping || {};
      const nameKey = mapping.ingredientName || 'Ingredient Name';
      const brandKey = mapping.brandOrSupplier || 'Manufacturer / Supplier';
      const agencyKey = mapping.kashrutAgency || 'Kosher Certification Body';
      const kosherKey = mapping.kosherStatus || 'Kosher Designation';
      const lotKey = mapping.lotNumber || 'Lot / Batch Number';
      const dateKey = mapping.approvalDate || 'Approval Date';
      const approverKey = mapping.approvedBy || 'Rabbinic Approver';
      const notesKey = mapping.notes || 'Mashgiach Notes';
      const statusKey = mapping.status || 'Status';

      const syncedIngredients: ApprovedIngredientItem[] = records.map((rec: any) => {
        const fields = rec.fields || {};
        const rawKosher = String(fields[kosherKey] || fields['Kosher Status'] || fields['Category'] || 'Parve');
        let kosherStatus: any = 'Parve';
        if (/dairy/i.test(rawKosher)) kosherStatus = 'Dairy';
        else if (/meat/i.test(rawKosher)) kosherStatus = 'Meat';
        else if (/cholov/i.test(rawKosher)) kosherStatus = 'Cholov Yisroel';
        else if (/pas/i.test(rawKosher)) kosherStatus = 'Pas Yisroel';

        return {
          id: `ing_at_${rec.id}`,
          airtableRecordId: rec.id,
          venueId: String(venueId),
          agencyId: callerAgencyId,
          name: String(fields[nameKey] || fields['Name'] || fields['Ingredient'] || 'Unnamed Ingredient'),
          brandOrSupplier: String(fields[brandKey] || fields['Supplier'] || fields['Brand'] || 'Specified Vendor'),
          kashrutAgency: String(fields[agencyKey] || fields['Certification'] || 'Approved Agency'),
          kosherStatus,
          lotOrBatch: fields[lotKey] ? String(fields[lotKey]) : undefined,
          approvalStatus: (String(fields[statusKey] || 'approved').toLowerCase().includes('pending') ? 'pending_approval' : 'approved') as any,
          approvalDate: fields[dateKey] ? String(fields[dateKey]) : new Date().toISOString().split('T')[0],
          approvedBy: fields[approverKey] ? String(fields[approverKey]) : `${callerName} (Agency)`,
          notes: fields[notesKey] ? String(fields[notesKey]) : undefined,
          verificationStatus: 'unverified',
          verificationNotes: '',
        };
      });

      // Replace the venue's ingredients + update lastSyncedAt atomically.
      const syncedAt = new Date().toISOString();
      const committed = await commitOrRespond(
        req, res,
        (freshDoc) => {
          const freshIngredients: any[] = Array.isArray(freshDoc.approvedIngredients) ? freshDoc.approvedIngredients : [];
          const freshConfigs: any[] = Array.isArray(freshDoc.airtableConfigs) ? freshDoc.airtableConfigs : [];
          return {
            doc: {
              ...freshDoc,
              approvedIngredients: [
                ...freshIngredients.filter((i) => i.venueId !== venueId),
                ...syncedIngredients,
              ],
              airtableConfigs: freshConfigs.map((c) =>
                c.id === config.id ? { ...c, lastSyncedAt: syncedAt } : c
              ),
            },
            result: { syncedAt },
          };
        },
        { label: 'airtable-sync-live' }
      );
      if (!committed) return;

      broadcast('INGREDIENTS_SYNCED', {
        venueId,
        agencyId: callerAgencyId,
        ingredients: approvedIngredients.filter((i) => i.venueId === venueId),
        count: syncedIngredients.length,
        syncedAt,
      }, undefined, callerAgencyId);

      return res.json({
        success: true,
        source: 'airtable_live_api',
        count: syncedIngredients.length,
        ingredients: approvedIngredients.filter((i) => i.venueId === venueId),
        syncedAt,
      });
    } catch (err: any) {
      return res.status(500).json({ error: `Failed to fetch from Airtable: ${err.message}` });
    }
  }

  // If testing / demo mode without live PAT, refresh default ingredients with timestamp
  const demoSyncedAt = new Date().toISOString();
  try {
    await commitState(
      (freshDoc) => {
        const freshConfigs: any[] = Array.isArray(freshDoc.airtableConfigs) ? freshDoc.airtableConfigs : [];
        return {
          doc: {
            ...freshDoc,
            airtableConfigs: freshConfigs.map((c) =>
              c.id === config.id ? { ...c, lastSyncedAt: demoSyncedAt } : c
            ),
          },
          result: { syncedAt: demoSyncedAt },
        };
      },
      { label: 'airtable-sync-demo' }
    );
  } catch (err) {
    return res.status(503).json({ error: 'Could not save sync timestamp. Please try again.' });
  }

  const venueIngredients = approvedIngredients.filter((i) => i.venueId === venueId);
  broadcast('INGREDIENTS_SYNCED', {
    venueId,
    agencyId: callerAgencyId,
    ingredients: venueIngredients,
    count: venueIngredients.length,
    syncedAt: demoSyncedAt,
  }, undefined, callerAgencyId);

  res.json({
    success: true,
    source: 'airtable_configured_sync',
    count: venueIngredients.length,
    ingredients: venueIngredients,
    syncedAt: demoSyncedAt,
  });
});

// Get Approved Ingredients for a Venue
app.get('/api/ingredients', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const venueScope = scopedVenueIds(req, res);
  if (!venueScope) return;
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  let items = approvedIngredients.filter((i) => (i.agencyId || 'agency-hkc') === callerAgencyId);
  if (venueScope !== 'agency') {
    items = items.filter((i) => venueScope.includes(i.venueId));
  }

  res.json({ ingredients: items });
});

// Mashgiach verifies or flags an approved ingredient during factory visit
app.put('/api/ingredients/:id/verify', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { id } = req.params;
  const { verificationStatus, verificationNotes } = req.body;

  const existing = approvedIngredients.find((i) => i.id === id);
  if (!existing) {
    return res.status(404).json({ error: 'Ingredient not found' });
  }
  if (!requireSameAgency(req, res, existing, 'ingredients')) return;
  // A7: admin, coordinator at the venue, or canFill mashgiach/worker at the venue.
  if (!mayDoFieldWrite(caller, existing.venueId)) {
    return res.status(403).json({ error: 'You can only verify ingredients at your own venue.' });
  }

  const verifiedByName = caller.name;
  const verifiedByEmail = caller.email;
  const verifiedAt = new Date().toISOString();

  const ok = await crudUpdate(req, res, 'approvedIngredients', id,
    (fresh) => ({
      ...fresh,
      verificationStatus: verificationStatus || 'verified_present',
      verificationNotes: verificationNotes !== undefined ? verificationNotes : fresh.verificationNotes,
      verifiedAt: verificationStatus === 'unverified' ? null : verifiedAt,
      verifiedByName: verificationStatus === 'unverified' ? null : verifiedByName,
      verifiedByEmail: verificationStatus === 'unverified' ? null : verifiedByEmail,
    }),
    {
      label: 'verify-ingredient',
      broadcastType: 'INGREDIENT_VERIFIED',
      getBroadcastPayload: (updated) => ({
        ingredient: updated,
        venueId: updated.venueId,
        agencyId: updated.agencyId,
      }),
      getAgencyId: (updated) => updated.agencyId || 'agency-hkc',
    }
  );
  return;
});

// Add new Approved Ingredient (Agency Admin or Coordinator)
app.post('/api/ingredients', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const { venueId, name, brandOrSupplier, kashrutAgency, kosherStatus, lotOrBatch, notes } = req.body;
  if (!venueId || !name) {
    return res.status(400).json({ error: 'Venue ID and ingredient name are required.' });
  }

  const callerAgencyId = caller.agencyId || 'agency-hkc';
  const approverName = caller.name;
  // RULE T + A7: the venue must be the caller's own AND the role must be one
  // that does field writes (admin, coordinator, canFill mashgiach/worker).
  if (!requireVenueAccess(req, res, venueId)) return;
  if (!mayDoFieldWrite(caller, venueId)) {
    return res.status(403).json({ error: 'You can only add ingredients at your own venue.' });
  }

  const ingredientId = `ing_${crypto.randomUUID()}`;
  const newIngredient: ApprovedIngredientItem = {
    id: ingredientId,
    venueId,
    agencyId: callerAgencyId,
    name: name.trim(),
    brandOrSupplier: brandOrSupplier ? brandOrSupplier.trim() : undefined,
    kashrutAgency: kashrutAgency ? kashrutAgency.trim() : 'HKC Approved',
    kosherStatus: kosherStatus || 'Parve',
    lotOrBatch: lotOrBatch ? lotOrBatch.trim() : undefined,
    approvalStatus: 'approved',
    approvalDate: new Date().toISOString().split('T')[0],
    approvedBy: approverName,
    notes: notes ? notes.trim() : undefined,
    verificationStatus: 'unverified',
  };

  const ok = await crudCreate(req, res, 'approvedIngredients', () => newIngredient, {
    label: 'create-ingredient',
    broadcastType: 'INGREDIENT_VERIFIED',
    getBroadcastPayload: (created) => ({
      ingredient: created,
      venueId: created.venueId,
      agencyId: created.agencyId,
    }),
    getAgencyId: (created) => created.agencyId || 'agency-hkc',
  });
  return;
});

// Delete an ingredient
app.delete('/api/ingredients/:id', async (req, res) => {
  const { id } = req.params;
  const existing = approvedIngredients.find((i) => i.id === id);
  if (!existing) {
    return res.status(404).json({ error: 'Ingredient not found' });
  }
  if (!requireSameAgency(req, res, existing, 'ingredients')) return;
  // A7: admin, coordinator at the venue, or canFill mashgiach/worker at the venue.
  const delCaller = getAuthUser(req);
  if (!mayDoFieldWrite(delCaller, existing.venueId)) {
    return res.status(403).json({ error: 'You can only delete ingredients at your own venue.' });
  }
  const venueId = existing.venueId;
  const agencyId = existing.agencyId;
  const ok = await crudDelete(req, res, 'approvedIngredients', id, {
    label: 'delete-ingredient',
    broadcastType: 'INGREDIENTS_SYNCED',
    // Called after hydration, so approvedIngredients is already post-delete.
    getDeletePayload: () => ({
      venueId,
      agencyId,
      deletedId: id,
      ingredients: approvedIngredients.filter((i) => i.venueId === venueId),
    }),
    getAgencyId: () => agencyId || 'agency-hkc',
  });
  return;
});

// Factory Audit Reports: Get List
app.get('/api/factory-reports', (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const venueScope = scopedVenueIds(req, res);
  if (!venueScope) return;
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  let reports = factoryReports.filter((r) => r.agencyId === callerAgencyId);
  if (venueScope !== 'agency') {
    reports = reports.filter((r) => venueScope.includes(r.venueId));
  }

  // Sort newest first
  reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ reports });
});

// Factory Audit Reports: Submit New Mashgiach Inspection Report
app.post('/api/factory-reports', async (req, res) => {
  const caller = requireAuthUser(req, res);
  if (!caller) return;
  const {
    venueId,
    auditDate,
    startTime,
    endTime,
    factoryRepresentative,
    auditedIngredients,
    discrepancies,
    summaryNotes,
    status,
    mashgiachSigned,
  } = req.body;

  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required to submit a factory report.' });
  }

  const venue = venues.find((v) => v.id === venueId);
  // RULE T + A7: the venue must be the caller's own AND the role must be one
  // that does field writes (admin, coordinator, canFill mashgiach/worker).
  if (!requireVenueAccess(req, res, venueId)) return;
  if (!mayDoFieldWrite(caller, venueId)) {
    return res.status(403).json({ error: 'You can only submit factory reports at your own venue.' });
  }
  const callerAgencyId = venue?.agencyId || caller.agencyId || 'agency-hkc';
  const mashgiachName = caller.name;
  const mashgiachEmail = caller.email;

  // Pre-generate stable IDs/timestamps BEFORE the transaction so retries don't duplicate.
  const reportId = `rpt_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  const cleanDiscrepancies: UnapprovedDiscrepancyItem[] = Array.isArray(discrepancies)
    ? discrepancies.map((d: any, idx: number) => ({
        id: d.id || `disc_${crypto.randomUUID()}_${idx}`,
        name: String(d.name || 'Unlabeled Raw Material'),
        brandOrSupplier: d.brandOrSupplier ? String(d.brandOrSupplier) : undefined,
        kashrutSymbolFound: d.kashrutSymbolFound ? String(d.kashrutSymbolFound) : 'None / Non-Kosher',
        lotOrBatch: d.lotOrBatch ? String(d.lotOrBatch) : undefined,
        locationInFactory: d.locationInFactory ? String(d.locationInFactory) : 'Factory Floor',
        severity: d.severity || 'warning',
        notes: String(d.notes || ''),
        actionTaken: d.actionTaken ? String(d.actionTaken) : 'Quarantined by Mashgiach',
        photoUrl: d.photoUrl || undefined,
        reportedAt: nowIso,
        reportedByName: mashgiachName,
        reportedByEmail: mashgiachEmail,
      }))
    : [];

  const cleanAuditedIngredients = Array.isArray(auditedIngredients) ? auditedIngredients : [];
  const totalApprovedChecked = cleanAuditedIngredients.length;
  const totalPresent = cleanAuditedIngredients.filter((i) => i.status === 'verified_present').length;
  const totalDiscrepancies = cleanDiscrepancies.length;

  const newReport: FactoryAuditReportItem = {
    id: reportId,
    agencyId: callerAgencyId,
    venueId,
    venueName: venue?.name || 'Kosher Food Manufacturing Plant',
    auditDate: auditDate || nowIso.split('T')[0],
    startTime: startTime || '09:00 AM',
    endTime: endTime || '14:30 PM',
    mashgiachName,
    mashgiachEmail,
    factoryRepresentative: factoryRepresentative ? String(factoryRepresentative).trim() : 'Plant QA Manager',
    totalApprovedChecked,
    totalPresent,
    totalDiscrepancies,
    auditedIngredients: cleanAuditedIngredients,
    discrepancies: cleanDiscrepancies,
    summaryNotes: summaryNotes ? String(summaryNotes).trim() : 'Routine factory ingredient audit completed.',
    status: status || (totalDiscrepancies > 0 ? 'critical_violation_found' : 'passed'),
    mashgiachSigned: Boolean(mashgiachSigned),
    signatureTimestamp: mashgiachSigned ? nowIso : undefined,
    createdAt: nowIso,
  };

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.factoryReports) ? freshDoc.factoryReports : [];
      // Idempotency: same report ID already submitted.
      const existing = arr.find((r) => r.id === reportId);
      if (existing) return { doc: freshDoc, result: existing };
      return { doc: { ...freshDoc, factoryReports: [newReport, ...arr] }, result: newReport };
    },
    { label: 'create-factory-report' }
  );
  if (!committed) return;
  const report = committed.result as FactoryAuditReportItem;

  broadcast('AUDIT_REPORT_SUBMITTED', {
    report,
    venueId,
    agencyId: callerAgencyId,
  }, undefined, callerAgencyId);

  res.status(201).json({ success: true, report });
});


// Vite middleware for development & static serving for production
// One-time (per boot) migration: bcrypt-hash any plaintext passwords found in
// state. Already-hashed and empty passwords are left alone.
async function migratePasswordsToBcrypt(): Promise<void> {
  // DISABLED: This was double-hashing passwords on restart, locking Don out.
  // All passwords are now bcrypt-hashed at creation time. If a legacy plaintext
  // password is ever found, it will be upgraded on next successful login via
  // the 'valid-needs-upgrade' path in checkPassword().
  return;
}

async function startServer() {
  // Stage 3C: Load secrets from Secret Manager BEFORE anything else.
  // Fails closed — if USE_SECRET_MANAGER=true and secrets are unavailable,
  // the server refuses to start (no silent fallback, no generated values).
  if (process.env.USE_SECRET_MANAGER === 'true') {
    console.log('[secrets] Loading secrets from Secret Manager...');
    const { getSecret, SECRET_NAMES } = await import('./src/server/secrets.js');
    // JWT secret → set as env var so existing getJwtSecret() picks it up
    process.env.JWT_SECRET = await getSecret(SECRET_NAMES.JWT_SECRET);
    // VAPID keys → set as env vars
    process.env.VAPID_PUBLIC_KEY = await getSecret(SECRET_NAMES.VAPID_PUBLIC_KEY);
    process.env.VAPID_PRIVATE_KEY = await getSecret(SECRET_NAMES.VAPID_PRIVATE_KEY);
    // Reset pepper → set as env var
    process.env.RESET_CODE_PEPPER = await getSecret(SECRET_NAMES.RESET_CODE_PEPPER);
    console.log('[secrets] All secrets loaded from Secret Manager.');
  }

  // Durable state first: Firestore wins over the ephemeral local file.
  // We WAIT for the load — no timeout race. Starting with seed state while
  // Firestore is slow would let the first request overwrite real user data.
  // If Firestore is unreachable, the boot fails loudly instead of corrupting.
  await initFirestore();
  if (firestoreDb) {
    const loaded = await loadStateFromFirestore();
    if (!loaded && !durableStateLoaded) {
      throw new Error('[Firestore] Could not load durable state at boot — refusing to start with empty state.');
    }
  } else {
    durableStateLoaded = true; // No Firestore configured; local file is the source of truth.
  }

  // STAGED REVISION: verification reads only. Skip ALL startup writes —
  // pepper init, task-order backfill, VAPID persistence, password migration.
  // A staged revision must not make ANY Firestore mutation, including during
  // boot. The live revision (flag removed) does the normal startup writes
  // at cutover time. Reads (initFirestore/loadStateFromFirestore above) stay.
  const staged = isStagedRevision();
  if (staged) {
    console.log('[Boot] STAGED_REVISION=true — skipping all startup writes (pepper init, task-order backfill, VAPID, password migration). Reads only.');
  }

  if (!staged) {
  try {
  // Initialize the password-reset pepper BEFORE accepting requests.
  // Must be stable before any verification happens (no async race).
  await initResetPepper();

  // Backfill task ordering AFTER the durable load (the hydrate above replaces
  // in-memory tasks, so this must not run at module level). Persists via the
  // transactional write path when it changes anything so the order sticks.
  await commitState(
    (freshDoc) => {
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      const { tasks: normalized, changed } = normalizeTaskOrderPure(freshTasks);
      if (!changed) return { doc: freshDoc, result: { changed: false } };
      return { doc: { ...freshDoc, tasks: normalized }, result: { changed: true } };
    },
    { label: 'normalize-task-order-boot' }
  ).catch((err) => log.warn('[Boot] Task-order backfill failed:', (err as any)?.message));

  // Web Push: VAPID keys must be ready after durable state loads (env vars
  // take precedence over persisted keys inside ensureVapidKeys).
  ensureVapidKeys();

  // Security migration: hash any legacy plaintext passwords still in state.
  // Runs once per boot; already-hashed passwords are untouched.
  await migratePasswordsToBcrypt();

  // Kiosk PIN migration: hash any legacy plaintext kiosk PINs in place.
  // Same values (no reset, no rotation); users notice nothing. Skipped on
  // staged/read-only/maintenance revisions (the !staged gate above covers it).
  // One commitState labelled kiosk-pin-hash-migration.
  try {
    const needsMigration = users.some((u) => u.kioskPin && !u.kioskPinHash);
    if (needsMigration) {
      // Hash outside the transaction (bcrypt is async); the transaction only
      // swaps the fields on fresh data.
      const hashes = new Map<string, string>();
      for (const u of users) {
        if (u.kioskPin && !u.kioskPinHash) {
          hashes.set(u.id, await hashPassword(String(u.kioskPin).trim()));
        }
      }
      await commitState(
        (freshDoc) => {
          const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
          let changed = false;
          const newUsers = freshUsers.map((u) => {
            const h = hashes.get(u.id);
            if (h && u.kioskPin && !isBcryptHash(u.kioskPinHash)) {
              changed = true;
              const nu: any = { ...u, kioskPinHash: h, kioskPin: undefined, kioskPinSetAt: new Date().toISOString() };
              return nu;
            }
            return u;
          });
          if (!changed) return { doc: freshDoc, result: { changed: false } };
          return { doc: { ...freshDoc, users: newUsers }, result: { changed: true } };
        },
        { label: 'kiosk-pin-hash-migration' }
      );
      log.info('[Boot] Kiosk PIN hash migration complete.');
    }
  } catch (err: any) {
    log.warn('[Boot] Kiosk PIN hash migration failed (non-fatal):', err?.message);
  }
  } catch (err: any) {
    // Boot must never die on a startup-write failure. The server starts and
    // serves; the failed backfill is logged for investigation. Data safety
    // is preserved because reads loaded successfully above.
    log.error('[Boot] Startup writes failed (non-fatal, server continuing):', err?.message);
  }
  }

  if (process.env.NODE_ENV !== 'production') {
    // Dynamic import so production containers don't need vite installed.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    // Cache headers that let every deploy reach phones (see static-files.ts).
    mountStaticFiles(app, distPath);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[WorkPulse Server] Listening on http://0.0.0.0:${PORT} with WebSockets enabled at /ws`);
  });
}

startServer();
