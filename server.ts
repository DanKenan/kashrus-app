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
    // Persist via the transactional write path (fire-and-forget is fine here:
    // the secret is already in memory; this just ensures it survives restarts).
    // First call happens after boot anyway.
    commitState(
      (freshDoc) => ({ doc: { ...freshDoc, jwtSecret }, result: null }),
      { label: 'persist-jwt-secret' }
    ).catch((err) => console.warn('[getJwtSecret] Persist failed:', (err as any)?.message));
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
      console.warn('[Security] Could not read reset pepper from Firestore:', err?.message);
    }
  }
  // 3. Generate and persist (first boot only).
  _resetPepper = crypto.randomBytes(32).toString('hex');
  if (!process.env.K_SERVICE) {
    console.warn('[Security] Generated ephemeral reset pepper for local dev. Set RESET_CODE_PEPPER env var for production.');
  } else {
    console.error('[Security] WARNING: No RESET_CODE_PEPPER env var on Cloud Run. Using generated pepper persisted to Firestore. Set the env var to fix this (see docs).');
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
      console.warn('[Security] Could not persist reset pepper:', err?.message);
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

function signToken(userId: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const sig = base64url(
    crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${sig}`;
}

function verifyToken(token: string): { userId: string } | null {
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
    if (typeof data.sub !== 'string' || !data.sub) return null;
    return { userId: data.sub };
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
  // Kiosk: the PIN itself is the credential; /kiosk/users only returns names.
  { method: 'GET', path: '/kiosk/users' },
  { method: 'POST', path: '/kiosk/login' },
  // Kiosk setup: venue names only (no sensitive data) so a fresh tablet can
  // pick its establishment before anyone logs in.
  { method: 'GET', path: '/kiosk/venues' },
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
      ]
    : []),
];

function isPublicApiRoute(method: string, path: string): boolean {
  return PUBLIC_API_ROUTES.some((r) => r.method === method && r.path === path);
}

// Custom domains: agencyId -> hostname (e.g. app.hartfordkashrut.org).
// Agencies map in state; entries added via agency settings.
function agencyIdForHostname(hostname: string): string | null {
  const host = hostname.split(':')[0].toLowerCase();
  for (const a of agencies as Array<{ id: string; customDomain?: string }>) {
    if (a.customDomain && a.customDomain.toLowerCase() === host) return a.id;
  }
  return null;
}

app.use('/api', (req, res, next) => {
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

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const payload = token ? verifyToken(token) : null;
  const user = payload ? users.find((u) => u.id === payload.userId) : undefined;

  if (!user) {
    return res.status(401).json({ error: 'Sign in required. Please log in again.' });
  }

  // Force the verified identity: endpoints keying off userEmail now see the
  // authenticated user, never a client-supplied impersonation.
  (req as any).authUser = user;
  if (req.query && typeof req.query === 'object') {
    (req.query as any).userEmail = user.email;
  }
  if (req.body && typeof req.body === 'object') {
    (req.body as any).userEmail = user.email;
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

/** The caller's agency, from the verified session user. */
function callerAgencyId(req: any): string {
  return getAuthUser(req)?.agencyId || 'agency-hkc';
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
  resolvedAt?: string;
  resolvedBy?: string;
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
  venueId?: string; // Mashgichim, Coordinators and Owners belong to a specific venue; Admins have access to all in their agency
  permissions?: UserPermissions;
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

function getSafeUser(user: UserProfile) {
  const { password, kioskPin, ...safe } = user;
  const userAgency = agencies.find((a) => a.id === user.agencyId) || agencies[0];
  return {
    ...safe,
    agencyName: userAgency?.name || 'Kosher Supervision Agency',
    agencySeal: userAgency?.certificationSeal || 'Certified Kosher',
    agencyShortCode: userAgency?.shortCode || 'HKC',
  };
}

function getSafeUsers() {
  return users.map(getSafeUser);
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
let eventTaskTemplates: EventTaskTemplate[] = [];
let currentWorkDate = new Date().toISOString().split('T')[0];
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
        // Clean slate: venues, tasks, history, events are strictly what the user created
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

        if (Array.isArray(parsed.users) && parsed.users.length > 0) {
          users = parsed.users;
        } else {
          users = [DEFAULT_USERS[0]];
        }
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
          users = parsed.users.map((u: any) => {
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
          });

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
      }

      if (parsed.currentWorkDate) currentWorkDate = parsed.currentWorkDate;
      if (typeof parsed._v === 'number' && parsed._v >= 0) {
        stateVersion = parsed._v;
      }
  } catch (err) {
    console.warn('Could not hydrate state:', err);
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
    console.warn('Could not read store.json, using defaults:', err);
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
    isDemoCleared,
    pushSubscriptions,
    vapidKeys,
    jwtSecret,
    resetPepper: (globalThis as any).__resetPepper || undefined,
    passwordResets,
    passwordResetRateLimits,
  };
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(stateSnapshot(), null, 2), 'utf-8');
  } catch (err) {
    console.warn('Could not save store.json:', err);
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
    console.warn('[Firestore] FORCE_LOCAL_MODE=true — skipping Firestore init entirely (local file only, NO durability).');
    firestoreInitStatus = 'disabled';
    return;
  }
  try {
    // Test hook: in-memory Firestore mock with faithful transaction semantics.
    // Used by the Stage 2 test suite (FIRESTORE_MOCK=true). NEVER on Cloud Run.
    if (process.env.FIRESTORE_MOCK === 'true') {
      if (process.env.K_SERVICE) {
        console.error('[FATAL] FIRESTORE_MOCK=true on Cloud Run (K_SERVICE set). Refusing to start with mock data in production.');
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
      console.error('[Firestore] FATAL: Firestore init failed on Cloud Run — refusing to start:', err?.message);
      process.exit(1);
    }
    firestoreInitStatus = 'degraded-local';
    console.warn('[Firestore] Init failed — durable persistence disabled (file only):', err?.message);
  }
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
    return true;
  } catch (err: any) {
    console.warn('[Firestore] Could not load state:', err?.message);
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
  console.warn('[Firestore] persistToFirestore() is retired — use commitState(). Call ignored.');
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
  constructor(message: string) {
    super(message);
    this.name = 'OperationConflictError';
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
const IDEMPOTENCY_SENSITIVE_FIELDS = new Set(['password', 'passwordhash', 'kioskpin', 'resettoken', 'apikey']);

/**
 * Deep-strip sensitive fields from a result before caching it as an
 * idempotency record. Removes password/passwordHash/kioskPin/resetToken/
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
  | { doc: any; result: any }
  | { conflict: string };

interface CommitOptions {
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
async function commitState(
  mutator: (freshDoc: any, currentVersion: number) => MutatorOutcome,
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
    console.warn(`[Firestore] DEGRADED: writing to local file only — data will NOT persist across restarts`);
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
    const outcome = mutator(beforeDoc, stateVersion);
    if ('conflict' in outcome) {
      throw new OperationConflictError(outcome.conflict);
    }
    hydrateState(outcome.doc);
    // No-op detection (fallback path): skip the file write when nothing
    // changed. (The transactional path additionally skips the _v bump.)
    if (!docsEqualIgnoring(JSON.parse(JSON.stringify(outcome.doc)), pristineBefore)) {
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(stateSnapshot(), null, 2), 'utf-8');
      } catch (err) {
        console.warn('[commitState] File fallback save failed:', (err as any)?.message);
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
        const outcome = mutator(baseDoc, currentVersion);
        if ('conflict' in outcome) {
          throw new OperationConflictError(outcome.conflict);
        }

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
      } else {
        console.warn(
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
      console.warn(`[commitState:${label}] Transaction failed (attempt ${attempt}/${maxAttempts}):`, err?.message);
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
      res.status(409).json({ error: err.message, code: 'OPERATION_CONFLICT' });
      return null;
    }
    if (err instanceof RateLimitError) {
      res.setHeader('Retry-After', String(err.retryAfterSec));
      res.status(429).json({ error: err.message, code: 'RATE_LIMITED' });
      return null;
    }
    if (err instanceof DocumentTooLargeError) {
      console.error(`[commitOrRespond:${options.label || 'unnamed'}] ${err.message}`);
      res.status(503).json({ error: err.message, code: 'SIZE_LIMIT' });
      return null;
    }
    if (err instanceof FirestoreUnavailableError) {
      console.error(`[commitOrRespond:${options.label || 'unnamed'}] ${err.message}`);
      res.status(503).json({
        error: 'Could not save — the database is unreachable. Your changes were NOT saved. Please try again.',
        code: 'SAVE_FAILED',
      });
      return null;
    }
    console.error(`[commitOrRespond:${options.label || 'unnamed'}] Unexpected error:`, err);
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
  res.json(updated);
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
    ).catch((err) => console.warn('[Push] VAPID key persist failed:', (err as any)?.message));
  }
  webpush.setVapidDetails(
    'mailto:kenan@hartfordkashrut.org',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}

/** Send a push notification to every device a user subscribed. Fire-and-forget. */
function sendPushToUser(userEmail: string, title: string, body: string, data?: any) {
  if (!vapidKeys) return;
  const email = userEmail.trim().toLowerCase();
  const subs = pushSubscriptions.filter((s) => s.userEmail.toLowerCase() === email);
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
          ).catch((e) => console.warn('[Push] Dead-subscription prune failed:', (e as any)?.message));
        } else {
          console.warn('[Push] Send failed:', err?.message || err);
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
    ).catch((err) => console.warn('[MediaCleanup] Persist failed:', (err as any)?.message));
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
// Tracks already-notified tasks to avoid spam
const overdueNotified = new Set<string>();
function checkOverdueTasks() {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = now.toISOString().split('T')[0];

  for (const task of tasks) {
    if (task.isCompleted) continue;
    if (!task.enableOverdueAlert) continue; // Only alert for tasks with alerts enabled
    if (!task.targetTime || task.targetTime === 'End of Day') continue;

    const taskMinutes = taskSortMinutes(task);
    if (taskMinutes >= nowMinutes) continue; // Not overdue yet

    const notifyKey = `${task.id}:${today}`;
    if (overdueNotified.has(notifyKey)) continue; // Already notified today
    overdueNotified.add(notifyKey);

    const venue = venues.find((v) => v.id === task.venueId);
    const venueName = venue?.name || 'your venue';

    // Notify assigned users, or all venue users if assigned to 'all'
    const assigned = Array.isArray(task.assignedTo) ? task.assignedTo : ['all'];
    const notifyEmails = assigned.includes('all')
      ? users.filter((u) => u.venueId === task.venueId || !u.venueId).map((u) => u.email)
      : assigned;

    for (const email of notifyEmails) {
      sendPushToUser(
        email,
        `Overdue: ${task.title}`,
        `${venueName} — was due at ${task.targetTime}`,
        { taskId: task.id, venueId: task.venueId, type: 'overdue' }
      );
    }
  }

  // Clean up old notification keys (keep only today's)
  for (const key of overdueNotified) {
    if (!key.endsWith(`:${today}`)) overdueNotified.delete(key);
  }
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
  const { userEmail, subscription } = req.body as any;
  if (!userEmail || !subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'userEmail and subscription required' });
  }
  const email = String(userEmail).trim().toLowerCase();
  const createdAt = new Date().toISOString();
  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const arr: any[] = Array.isArray(freshDoc.pushSubscriptions) ? freshDoc.pushSubscriptions : [];
      // Upsert by endpoint against FRESH data.
      const newArr = [
        ...arr.filter((s) => s.endpoint !== subscription.endpoint),
        { userEmail: email, endpoint: subscription.endpoint, keys: subscription.keys, createdAt },
      ];
      return { doc: { ...freshDoc, pushSubscriptions: newArr }, result: { success: true } };
    },
    { label: 'push-subscribe' }
  );
  if (!committed) return;
  res.json({ success: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body as any;
  // Only the caller's own subscription for that endpoint can be removed
  // (userEmail is forced to the authenticated user by the auth middleware).
  const callerEmail = String((req.body as any)?.userEmail || '').trim().toLowerCase();
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
const activeSockets = new Map<WebSocket, { email: string; name: string; agencyId: string }>();

function agencyStateFor(agencyId: string) {
  const norm = (v?: string) => v || 'agency-hkc';
  return {
    venues: venues.filter((v) => norm(v.agencyId) === agencyId),
    tasks: tasks.filter((t) => norm(t.agencyId) === agencyId),
    historyLogs: historyLogs.filter((h) => norm(h.agencyId) === agencyId),
    events: events.filter((e) => norm(e.agencyId) === agencyId),
    airtableConfigs: airtableConfigs.filter((c) => norm(c.agencyId) === agencyId),
    approvedIngredients: approvedIngredients.filter((i) => norm(i.agencyId) === agencyId),
    factoryReports: factoryReports.filter((r) => norm(r.agencyId) === agencyId),
    users: getSafeUsers().filter((u: any) => norm(u.agencyId) === agencyId),
    currentWorkDate,
  };
}

function broadcast(type: string, payload: any, senderEmail?: string, agencyId?: string) {
  // The envelope carries the current document version so clients can keep
  // their last-known version fresh without polling (see src/lib/api.ts).
  // Broadcasts are sent only after the commit hydrated the cache, so
  // stateVersion is the version that produced this payload.
  const message = JSON.stringify({
    type,
    payload,
    timestamp: new Date().toISOString(),
    senderEmail,
    version: typeof stateVersion === 'number' ? stateVersion : undefined,
  });

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // Agency-scoped broadcasts only reach that agency's sockets.
    if (agencyId) {
      const meta = activeSockets.get(client);
      if (!meta || meta.agencyId !== agencyId) continue;
    }
    client.send(message);
  }
}

wss.on('connection', (ws, req) => {
  // Token via ?token=… query param (set by the client from its session).
  let authedUser: any = null;
  try {
    const url = new URL(req.url || '/ws', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const payload = token ? verifyToken(token) : null;
    authedUser = payload ? users.find((u) => u.id === payload.userId) : null;
  } catch {
    authedUser = null;
  }

  if (!authedUser) {
    ws.close(4401, 'Unauthorized');
    return;
  }

  const agencyId = authedUser.agencyId || 'agency-hkc';
  activeSockets.set(ws, { email: authedUser.email, name: authedUser.name, agencyId });

  // Initial state: ONLY this user's agency. Never the whole platform.
  ws.send(
    JSON.stringify({
      type: 'INITIAL_STATE',
      payload: {
        ...agencyStateFor(agencyId),
        activeWorkersCount: activeSockets.size,
      },
      timestamp: new Date().toISOString(),
      version: typeof stateVersion === 'number' ? stateVersion : undefined,
    })
  );

  broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'USER_PRESENCE' && parsed.payload) {
        activeSockets.set(ws, {
          email: authedUser.email,
          name: authedUser.name,
          agencyId,
        });
        broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    activeSockets.delete(ws);
    broadcast('USER_PRESENCE', { activeWorkersCount: activeSockets.size }, undefined, agencyId);
  });
});

// Daily Reset Logic (supports resetting a specific venue or all)
//
// Returns a Promise that resolves ONLY after the transaction has committed
// (or rejects on failure) — callers must await it before responding or
// broadcasting. Scheduled resets skip when currentWorkDate is already today
// (idempotency via the work-date guard inside the mutator); manual resets
// pass { force: true } to ALWAYS run when explicitly requested, staying
// transactional and idempotent via operationId. Archive/history creation
// happens INSIDE the transaction (buildSnapshot runs in the mutator).
async function executeDailyReset(
  targetVenueId?: string,
  resetBy: string = 'system',
  opts: { force?: boolean; operationId?: string; agencyId?: string } = {}
): Promise<{ result: any; version: number } | null> {
  // Agency scoping: manual resets pass agencyId (caller's agency only).
  // Scheduled resets pass no agencyId (system operation across all agencies).
  const scopeAgencyId = opts.agencyId || null;
  // Use America/New_York for work dates (Don's timezone; all agencies are CT-based).
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const resetAt = new Date().toISOString();
  // Random ID base per reset invocation: stable across transaction retries
  // (the mutator closure captures it), unique across invocations so snapshot
  // IDs from different resets can never collide.
  const stamp = crypto.randomUUID();

  // Build a single history snapshot from a venue + its tasks (pure function).
  const buildSnapshot = (v: any, venueTasks: any[]): HistoryLog => {
    const completedCount = venueTasks.filter((t) => t.isCompleted).length;
    const totalCount = venueTasks.length;
    const rate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
    return {
      id: `hist-${v.id}-${stamp}`,
      agencyId: v.agencyId || 'agency-hkc',
      venueId: v.id,
      date: currentWorkDate,
      totalTasks: totalCount,
      completedTasks: completedCount,
      completionRate: rate,
      resetAt,
      resetBy,
      entries: venueTasks.map((t) => {
        const checkIns = t.checkIns || [];
        const checkInSummary =
          checkIns.length > 0
            ? checkIns
                .map((c: any) => {
                  const when = (() => {
                    try {
                      return new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  const resetTask = (t: any, scopedVenueIds: Set<string> | null): any => {
    // Agency scoping: only reset tasks whose venue is in the scoped set.
    // When scopedVenueIds is null (scheduled system reset), all venues reset.
    if (scopedVenueIds && !scopedVenueIds.has(t.venueId)) return t;
    if (targetVenueId && t.venueId !== targetVenueId) return t;
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

  // The whole reset (snapshots + task reset + work-date bump) commits atomically.
  // currentWorkDate is bumped inside the mutator so a retry can't double-reset.
  // Await the CONFIRMED transaction before responding or broadcasting —
  // nothing may act on a reset that hasn't committed.
  let committed: { result: any; version: number };
  try {
    committed = await commitState(
      (freshDoc) => {
        const freshVenues: any[] = Array.isArray(freshDoc.venues) ? freshDoc.venues : [];
        const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
        const freshHistory: any[] = Array.isArray(freshDoc.historyLogs) ? freshDoc.historyLogs : [];
        // Idempotency for scheduled resets: if the work date was already
        // advanced, this reset already ran — the no-op detection in
        // commitState() turns this into a version-neutral success. Manual
        // (force) resets always run; their idempotency comes from operationId.
        if (!opts.force && freshDoc.currentWorkDate === todayStr) {
          return { doc: freshDoc, result: null };
        }
        // Agency scoping: filter venues to the caller's agency when scoped.
        // Without scoping (scheduled system reset), all venues are reset.
        const scopedVenues = scopeAgencyId
          ? freshVenues.filter((v) => (v.agencyId || 'agency-hkc') === scopeAgencyId)
          : freshVenues;
        const targetVenues = targetVenueId
          ? scopedVenues.filter((v) => v.id === targetVenueId)
          : scopedVenues;
        const snapshots = targetVenues.map((v) =>
          buildSnapshot(v, freshTasks.filter((t) => t.venueId === v.id))
        );
        // Scoped venue IDs for task filtering (null = all venues, system reset).
        const scopedVenueIds = scopeAgencyId ? new Set(targetVenues.map((v) => v.id)) : null;
        // CORE FIX (round 4): the transaction result carries ALL snapshots
        // (each tagged with its agencyId). The broadcast below selects the
        // snapshots for each agency — never send agency A's snapshot to
        // agency B. Previously this returned only snapshots[0], which leaked
        // the first agency's snapshot to every agency on scheduled resets.
        return {
          doc: {
            ...freshDoc,
            historyLogs: [...snapshots, ...freshHistory],
            tasks: freshTasks.map((t) => resetTask(t, scopedVenueIds)),
            currentWorkDate: todayStr,
          },
          result: snapshots,
        };
      },
      { label: 'daily-reset', operationId: opts.operationId }
    );
  } catch (err) {
    console.warn('[DailyReset] Transaction failed:', (err as any)?.message);
    throw err;
  }

  // Broadcast per-agency ONLY after commit (in-memory cache is now fresh).
  // AGENCY SCOPING: each agency receives ONLY its own snapshots.
  // committed.result is the full snapshots array (each tagged with agencyId);
  // filter per agency so agency B never receives agency A's history/notes.
  const allSnapshots: any[] = Array.isArray(committed.result) ? committed.result : [];
  const broadcastAgencies = scopeAgencyId
    ? agencies.filter((a: any) => a.id === scopeAgencyId)
    : agencies;
  for (const a of broadcastAgencies) {
    const aid = a.id;
    const agencySnapshots = allSnapshots.filter((s: any) => (s.agencyId || 'agency-hkc') === aid);
    broadcast('DAILY_RESET', {
      venueId: targetVenueId || 'all',
      tasks: tasks.filter((t) => (t.agencyId || 'agency-hkc') === aid),
      historyLogs: historyLogs.filter((h) => (h.agencyId || 'agency-hkc') === aid),
      currentWorkDate,
      snapshots: agencySnapshots,
    }, undefined, aid);
  }

  return committed;
}

// Scheduled interval: check every 60s for midnight rollover.
// Uses America/New_York consistently with executeDailyReset's todayStr.
setInterval(() => {
  // No background writes: maintenance mode (cutover window), FORCE_LOCAL_MODE,
  // or staged revision (must not write pre-cutover). The daily reset is a write.
  if (process.env.MAINTENANCE_MODE === 'true' || process.env.FORCE_LOCAL_MODE === 'true' || isStagedRevision()) return;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (today !== currentWorkDate) {
    console.log(`[Scheduled Reset] Rollover detected from ${currentWorkDate} to ${today}`);
    // Async: resolves only after the transaction commits. Log-and-continue on
    // failure — the next 60s tick retries the rollover.
    executeDailyReset(undefined, 'scheduled_midnight_cron').catch((err) =>
      console.warn('[Scheduled Reset] Failed:', (err as any)?.message)
    );
  }
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
  let photoBytes = 0;
  let audioBytes = 0;
  let photoCount = 0;
  let audioCount = 0;

  for (const task of tasks) {
    for (const ci of task.checkIns || []) {
      if ((ci as any).photoData) {
        photoBytes += (ci as any).photoData.length;
        photoCount++;
      }
    }
  }
  for (const note of handoffNotes) {
    if ((note as any).voiceNoteData) {
      audioBytes += (note as any).voiceNoteData.length;
      audioCount++;
    }
  }
  for (const incident of incidents) {
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
  // SECURITY: admin-only. Previously any authenticated user could download
  // the full database. Fixed 2026-10-18 (matches hotfix/admin-export-auth).
  if (!requireAdmin(req, res)) return;
  const snapshot = stateSnapshot();
  // Strip sensitive fields from export. Passwords AND kiosk PINs are stripped
  // from ALL exports (round 5 fix — the docs claimed PINs were stripped but
  // the code only removed password). Ordinary admin exports must never carry
  // credential material; the separate full-fidelity DR backup (BACKUP_RESTORE.md)
  // is the only place credential material lives, stored encrypted.
  const safe = {
    ...snapshot,
    users: (snapshot.users || []).map((u: any) => ({
      ...u,
      password: undefined,
      passwordHash: undefined,
      kioskPin: undefined,
    })),
    jwtSecret: undefined,
    vapidKeys: undefined,
  };
  const filename = `shutfey-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ ...safe, exportedAt: new Date().toISOString() });
});

// Custom task templates — Don's own library (replaces generic ones)
app.get('/api/task-templates', (req, res) => {
  const agencyId = (req as any).agencyId || 'agency-hkc';
  res.json({ templates: taskTemplates.filter((t) => t.agencyId === agencyId) });
});

app.post('/api/task-templates', async (req, res) => {
  const { name, description, tasks: templateTasks, fromVenueId, createdByEmail } = req.body || {};
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
  // Copying another agency's venue tasks into a template would leak their data.
  if (fromVenueId && !requireOwnVenue(req, res, fromVenueId, venues)) return;

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
        createdByEmail: createdByEmail || '',
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
  const template = taskTemplates.find((t) => t.id === req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found.' });

  const { venueId, createdByEmail } = req.body || {};
  if (!venueId) return res.status(400).json({ error: 'Venue ID is required.' });

  // The template and the target venue must both belong to the caller's agency.
  if (!requireSameAgency(req, res, template, 'templates')) return;
  if (!requireOwnVenue(req, res, venueId, venues)) return;
  const agencyId = callerAgencyId(req);
  const now = new Date().toISOString();
  // Pre-generate stable IDs so transaction retries don't duplicate tasks.
  const created: TaskItem[] = template.tasks.map((td, i) => ({
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
  const existing = taskTemplates.find((t) => t.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Template not found.' });
  if (!requireSameAgency(req, res, existing, 'templates')) return;
  const ok = await crudDelete(req, res, 'taskTemplates', req.params.id, { label: 'delete-task-template' });
  return;
});

// Incidents — "oh no" flow: photo + voice + instant alert + auto-task
app.get('/api/incidents', (req, res) => {
  const agencyId = (req as any).agencyId || 'agency-hkc';
  const venueId = String(req.query.venueId || '');
  const status = String(req.query.status || '');
  let list = incidents.filter((i) => i.agencyId === agencyId);
  if (venueId) list = list.filter((i) => i.venueId === venueId);
  if (status) list = list.filter((i) => i.status === status);
  res.json({ incidents: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

app.post('/api/incidents', async (req, res) => {
  const { venueId, title, description, severity, photoData, voiceNoteData, reporterEmail, reporterName } = req.body || {};
  if (!venueId || !title?.trim()) {
    return res.status(400).json({ error: 'Venue and title are required.' });
  }

  const agencyId = callerAgencyId(req);
  const now = new Date().toISOString();
  // The incident's venue must belong to the caller's agency.
  if (!requireOwnVenue(req, res, venueId, venues)) return;
  const venue = venues.find((v) => v.id === venueId);
  const venueName = venue?.name || 'Venue';

  // Pre-generate stable IDs so transaction retries don't duplicate.
  const incidentId = `incident-${crypto.randomUUID()}`;
  const followUpId = `task-${crypto.randomUUID()}`;
  const sev = (['low', 'medium', 'high', 'critical'].includes(severity) ? severity : 'medium') as Incident['severity'];

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshIncidents: any[] = Array.isArray(freshDoc.incidents) ? freshDoc.incidents : [];
      const freshTasks: any[] = Array.isArray(freshDoc.tasks) ? freshDoc.tasks : [];
      // Idempotency: if this incident ID already exists, return it.
      const existingIncident = freshIncidents.find((i) => i.id === incidentId);
      if (existingIncident) {
        return { doc: freshDoc, result: existingIncident };
      }
      const incident: Incident = {
        id: incidentId,
        agencyId,
        venueId,
        reporterEmail: reporterEmail || '',
        reporterName: reporterName || 'Mashgiach',
        title: String(title).trim(),
        description: String(description || '').trim(),
        severity: sev,
        photoData: typeof photoData === 'string' && photoData.startsWith('data:image/') ? photoData.slice(0, 500000) : undefined,
        voiceNoteData: typeof voiceNoteData === 'string' && voiceNoteData.startsWith('data:audio/') ? voiceNoteData.slice(0, 1000000) : undefined,
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
  const incident = committed.result as Incident;

  // Side effects ONLY after commit.
  const admins = users.filter((u) =>
    (u.agencyId || 'agency-hkc') === agencyId &&
    (u.role === 'admin' || u.role === 'coordinator')
  );
  for (const admin of admins) {
    sendPushToUser(
      admin.email,
      `🚨 ${incident.severity.toUpperCase()}: ${incident.title}`,
      `${venueName} — reported by ${incident.reporterName}`,
      { incidentId: incident.id, venueId, type: 'incident' }
    );
  }
  broadcast('INCIDENT_CREATED', { incident }, undefined, agencyId);
  broadcast('TASKS_UPDATED', { venueId }, undefined, agencyId);

  res.json({ incident });
});

app.post('/api/incidents/:id/resolve', async (req, res) => {
  const incident = incidents.find((i) => i.id === req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found.' });
  if (!requireSameAgency(req, res, incident, 'incidents')) return;
  const { resolvedBy } = req.body || {};
  const resolvedAt = new Date().toISOString();
  const ok = await crudUpdate(req, res, 'incidents', req.params.id,
    (fresh) => {
      if (fresh.status === 'resolved') return fresh; // idempotent
      return { ...fresh, status: 'resolved', resolvedAt, resolvedBy: resolvedBy || '' };
    },
    {
      label: 'resolve-incident',
      broadcastType: 'INCIDENT_UPDATED',
      getBroadcastPayload: (updated) => ({ incident: updated }),
      getAgencyId: (updated) => updated.agencyId,
    }
  );
  return;
});

app.post('/api/incidents/:id/acknowledge', async (req, res) => {
  const incident = incidents.find((i) => i.id === req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found.' });
  if (!requireSameAgency(req, res, incident, 'incidents')) return;
  const ok = await crudUpdate(req, res, 'incidents', req.params.id,
    (fresh) => {
      if (fresh.status === 'acknowledged' || fresh.status === 'resolved') return fresh; // idempotent
      return { ...fresh, status: 'acknowledged' };
    },
    {
      label: 'acknowledge-incident',
      broadcastType: 'INCIDENT_UPDATED',
      getBroadcastPayload: (updated) => ({ incident: updated }),
      getAgencyId: (updated) => updated.agencyId,
    }
  );
  return;
});

// Broadcast announcements — one-way team updates (NOT a chat)
// Categories: assignment, update, notice, urgent. Targeted by role.
app.get('/api/announcements', (req, res) => {
  const agencyId = (req as any).agencyId || 'agency-hkc';
  const userEmail = String(req.query.userEmail || '').toLowerCase();
  const user = users.find((u) => u.email.toLowerCase() === userEmail);

  const now = new Date().toISOString();
  let list = announcements.filter((a) => a.agencyId === agencyId);
  // Filter expired
  list = list.filter((a) => !a.expiresAt || a.expiresAt > now);
  // Filter by role targeting
  if (user) {
    list = list.filter((a) =>
      a.targetRoles.includes('all') || a.targetRoles.includes(user.role)
    );
  }
  res.json({
    announcements: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
});

app.post('/api/announcements', async (req, res) => {
  const { title, body, category, targetRoles, venueId, expiresAt, authorName } = req.body || {};
  if (!title?.trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }

  // Only admin/coordinator can post announcements — the author is ALWAYS the
  // authenticated session user, never a client-supplied email.
  const author = getAuthUser(req);
  if (!author || !['admin', 'coordinator'].includes(author.role)) {
    return res.status(403).json({ error: 'Only admins and coordinators can post announcements.' });
  }

  const agencyId = callerAgencyId(req);
  // An announcement targeted at a venue must reference the caller's own agency venue.
  if (venueId && !requireOwnVenue(req, res, venueId, venues)) return;
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
        authorName: authorName || author.name,
        title: String(title).trim(),
        body: String(body || '').trim(),
        category: (['assignment', 'update', 'notice', 'urgent'] as const).includes(category) ? category : 'update',
        targetRoles: Array.isArray(targetRoles) && targetRoles.length > 0 ? targetRoles : ['all'],
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
  const targets = users.filter((u) =>
    (u.agencyId || 'agency-hkc') === agencyId &&
    (announcement.targetRoles.includes('all') || announcement.targetRoles.includes(u.role))
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
  broadcast('ANNOUNCEMENT', { announcement }, undefined, agencyId);

  res.json({ announcement });
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
  const agencyId = existing.agencyId;
  const ok = await crudDelete(req, res, 'announcements', req.params.id, {
    label: 'delete-announcement',
    broadcastType: 'ANNOUNCEMENT_DELETED',
    getDeletePayload: () => ({ id: req.params.id }),
    getAgencyId: () => agencyId,
  });
  return;
});

// Agency dashboard — overview of all venues with task stats (admin/coordinator)
app.get('/api/admin/dashboard', (req, res) => {
  const agencyId = (req as any).agencyId || 'agency-hkc';
  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === agencyId);

  const venueStats = agencyVenues.map((venue) => {
    const venueTasks = tasks.filter((t) => t.venueId === venue.id);
    const completed = venueTasks.filter((t) => t.isCompleted).length;
    const total = venueTasks.length;
    const overdueList = venueTasks.filter((t) => {
      if (t.isCompleted) return false;
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

  // Agency-wide totals
  const allTasks = tasks.filter((t) => {
    const v = venues.find((vv) => vv.id === t.venueId);
    return v && (v.agencyId || 'agency-hkc') === agencyId;
  });

  res.json({
    venues: venueStats,
    totals: {
      venueCount: agencyVenues.length,
      totalTasks: allTasks.length,
      completedTasks: allTasks.filter((t) => t.isCompleted).length,
      totalHandoffNotes: handoffNotes.length,
    },
  });
});

// Shift handoff notes — mashgiach-to-mashgiach communication
app.get('/api/handoff-notes', (req, res) => {
  const venueId = String(req.query.venueId || '');
  const notes = venueId
    ? handoffNotes.filter((n) => n.venueId === venueId)
    : handoffNotes;
  res.json({ notes: notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

app.post('/api/handoff-notes', async (req, res) => {
  const { venueId, content, shift, authorEmail, authorName, voiceNoteData } = req.body || {};
  if (!venueId || (!content?.trim() && !voiceNoteData)) {
    return res.status(400).json({ error: 'Venue and note content (or voice note) are required.' });
  }
  const noteId = `handoff-${crypto.randomUUID()}`;
  // Notes belong to the caller's agency; the venue must be theirs too.
  const agencyId = callerAgencyId(req);
  if (!requireOwnVenue(req, res, venueId, venues)) return;
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
        authorEmail: authorEmail || (req as any).userEmail || '',
        authorName: authorName || 'Mashgiach',
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
  broadcast('HANDOFF_NOTE', { note }, undefined, note.agencyId);
  res.json({ note });
});

app.delete('/api/handoff-notes/:id', async (req, res) => {
  const existing = handoffNotes.find((n) => n.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Handoff note not found.' });
  if (!requireSameAgency(req, res, existing, 'handoff notes')) return;
  const ok = await crudDelete(req, res, 'handoffNotes', req.params.id, {
    label: 'delete-handoff-note',
    broadcastType: 'HANDOFF_NOTE_DELETED',
    getDeletePayload: () => ({ id: req.params.id }),
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
  } = req.body;

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
      return {
        doc: {
          ...freshDoc,
          agencies: [...freshAgencies, newAgency],
          users: [...freshUsers, adminUser],
          venues: [...freshVenues, starterVenue],
          tasks: [...freshTasks, ...tasksToAdd],
        },
        result: { agency: newAgency, user: adminUser, venue: starterVenue, tasks: tasksToAdd },
      };
    },
    { label: 'register-agency' }
  );
  if (!committed) return;
  const { agency, user, venue, tasks: createdTasks } = committed.result as any;

  broadcast('AGENCY_REGISTERED', {
    agency,
    adminEmail: cleanAdminEmail,
  }, undefined, agency.id);

  res.status(201).json({
    success: true,
    message: `Welcome to KeepingKosher! Agency ${cleanAgencyName} has been established.`,
    agency,
    user: getSafeUser(user),
    token: signToken(user.id),
    venue,
    tasks: createdTasks,
  });
});

// List all registered kosher agencies (with overview counts)
app.get('/api/agencies', (req, res) => {
  const safeAgencies = agencies.map((a) => {
    const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === a.id);
    const agencyUsers = users.filter((u) => (u.agencyId || 'agency-hkc') === a.id);
    return {
      ...a,
      venuesCount: agencyVenues.length,
      workersCount: agencyUsers.length,
    };
  });
  res.json({ agencies: safeAgencies });
});

// Get current agency details for logged in user
app.get('/api/agencies/current', (req, res) => {
  const { userEmail } = req.query;
  const user = userEmail
    ? users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase())
    : null;
  const agencyId = user?.agencyId || 'agency-hkc';
  const agency = agencies.find((a) => a.id === agencyId) || agencies[0];
  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === agencyId);
  const agencyUsers = users.filter((u) => (u.agencyId || 'agency-hkc') === agencyId);

  res.json({
    agency: {
      ...agency,
      venuesCount: agencyVenues.length,
      workersCount: agencyUsers.length,
    },
  });
});

// Agency administrator updates agency profile details
app.put('/api/agencies/current', async (req, res) => {
  // Agency settings: admin only, verified from the session token.
  const user = requireAdmin(req, res);
  if (!user) {
    return res.status(403).json({ error: 'Only kosher agency administrators can edit agency profile settings.' });
  }
  const { name, shortCode, certificationSeal, region, contactPhone, customDomain } = req.body;

  const agencyId = user.agencyId || 'agency-hkc';
  const existing = agencies.find((a) => a.id === agencyId);
  if (!existing) {
    return res.status(404).json({ error: 'Agency record not found.' });
  }

  // Baseline for semantic conflict detection.
  const baseline = { name: existing.name, shortCode: existing.shortCode };

  const newCustomDomain = customDomain !== undefined
    ? customDomain.trim().toLowerCase() || undefined
    : undefined; // undefined = not being changed

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshAgencies: any[] = Array.isArray(freshDoc.agencies) ? freshDoc.agencies : [];
      const freshAgency = freshAgencies.find((a) => a.id === agencyId);
      if (!freshAgency) return { conflict: 'Agency record not found.' };
      // Custom domain uniqueness must be checked against FRESH data.
      if (newCustomDomain) {
        const clash = freshAgencies.find(
          (a) => a.id !== agencyId && a.customDomain && a.customDomain.toLowerCase() === newCustomDomain
        );
        if (clash) return { conflict: 'That domain is already assigned to another agency.' };
      }
      // Conflict if someone else changed a field this request is editing.
      if (name !== undefined && freshAgency.name !== baseline.name) {
        return { conflict: 'Conflict: the agency name was changed by someone else. Please refresh and try again.' };
      }
      const updated: Agency = {
        ...freshAgency,
        name: name !== undefined ? name.trim() : freshAgency.name,
        shortCode: shortCode !== undefined ? shortCode.trim() : freshAgency.shortCode,
        certificationSeal: certificationSeal !== undefined ? certificationSeal.trim() : freshAgency.certificationSeal,
        region: region !== undefined ? region.trim() : freshAgency.region,
        contactPhone: contactPhone !== undefined ? contactPhone.trim() : freshAgency.contactPhone,
        customDomain: customDomain !== undefined ? newCustomDomain : freshAgency.customDomain,
      };
      const newAgencies = freshAgencies.map((a) => (a.id === agencyId ? updated : a));
      return { doc: { ...freshDoc, agencies: newAgencies }, result: updated };
    },
    { label: 'update-agency', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as Agency;

  broadcast('AGENCY_UPDATED', { agency: updated }, user.email, agencyId);
  res.json({ success: true, agency: updated });
});

// Resolve the agency for the current hostname (custom-domain portals).
// Public: the login page uses this to show the agency's name on their domain.
app.get('/api/agencies/by-domain', (req, res) => {
  const host = String(req.hostname || '').split(':')[0].toLowerCase();
  const agency = agencies.find((a) => a.customDomain && a.customDomain.toLowerCase() === host);
  if (!agency) return res.json({ agency: null });
  res.json({
    agency: {
      id: agency.id,
      name: agency.name,
      shortCode: agency.shortCode,
      certificationSeal: agency.certificationSeal,
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
      const yesterday = new Date(Date.now() - 86400000)
        .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      await commitState(
        (freshDoc) => ({
          doc: { ...freshDoc, currentWorkDate: yesterday },
          result: { success: true },
        }),
        { label: 'test-rewind-work-date' }
      );
      const committed = await executeDailyReset(undefined, 'test-scheduled-reset');
      res.json({ success: true, version: committed ? committed.version : null });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // TEST ONLY: injects venues/tasks/agencies/users directly into Firestore
  // (for cross-agency test fixtures that can't be created via the scoped
  // HTTP API). Used by test-10 and test-16.
  app.post('/api/__test__/inject-fixture', async (req, res) => {
    const { venues = [], tasks = [], agencies: newAgencies = [], users: newUsers = [] } = req.body || {};
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
            doc: { ...freshDoc, venues: newVenues, tasks: newTasks, agencies: mergedAgencies, users: mergedUsers },
            result: { injected: venues.length + tasks.length + newAgencies.length + newUsers.length },
          };
        },
        { label: 'test-inject-fixture' }
      );
      res.json({ success: true, injected: venues.length + tasks.length + newAgencies.length + newUsers.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });
}

app.get('/api/venues', (req, res) => {
  const { userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let isCallerAdmin = true;
  let callerVenueId: string | undefined = undefined;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      isCallerAdmin = user.role === 'admin';
      callerVenueId = user.venueId;
    }
  }

  // Filter venues STRICTLY by caller's agency
  let accessibleVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);

  // If worker or owner, additionally filter to their assigned venue within the agency
  if (!isCallerAdmin) {
    if (callerVenueId) {
      accessibleVenues = accessibleVenues.filter((v) => v.id === callerVenueId);
    } else if (accessibleVenues.length > 0) {
      accessibleVenues = [accessibleVenues[0]];
    }
  }

  // Calculate live statistics for each venue
  const venuesWithStats = accessibleVenues.map((v) => {
    const venueTasks = tasks.filter((t) => t.venueId === v.id);
    const completedTasks = venueTasks.filter((t) => t.isCompleted).length;
    const totalTasks = venueTasks.length;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const venueWorkers = users.filter((u) => u.venueId === v.id && (u.role === 'mashgiach' || u.role === 'worker' || u.role === 'coordinator'));

    return {
      ...v,
      totalTasksToday: totalTasks,
      completedTasksToday: completedTasks,
      completionRate,
      workerCount: venueWorkers.length,
    };
  });

  res.json({ venues: venuesWithStats, isDemoCleared });
});

// Admin creates a brand new venue within their agency
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
  } = req.body;

  const caller = requireAdmin(req, res);
  if (!caller) {
    return res.status(403).json({ error: 'Only agency administrators can create new venue platforms.' });
  }
  const callerAgencyId = caller.agencyId || 'agency-hkc';
  let callerAgency: Agency | undefined = undefined;

  callerAgency = agencies.find((a) => a.id === callerAgencyId) || agencies[0];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Venue Name is required.' });
  }

  // Pre-generate stable IDs/timestamps BEFORE the transaction so retries don't duplicate.
  const newVenueId = `venue-${crypto.randomUUID()}`;
  const cleanOwnerEmail = ownerEmail?.trim().toLowerCase() || undefined;
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
  };

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
        const existingOwnerIdx = newUsers.findIndex((u) => u.email.toLowerCase() === cleanOwnerEmail);
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
  const { name, category, address, certification, ownerEmail } = req.body;

  const caller = requireAdmin(req, res);
  if (!caller) {
    return res.status(403).json({ error: 'Only administrators can modify venue settings.' });
  }
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const existing = venues.find((v) => v.id === id);
  if (!existing) {
    return res.status(404).json({ error: 'Venue not found.' });
  }

  if (!requireSameAgency(req, res, existing, 'venues')) return;

  // Baseline for semantic conflict detection on name/category/address.
  const baseline = { name: existing.name, category: existing.category, address: existing.address };

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
      const updated: Venue = {
        ...freshVenue,
        name: name !== undefined ? name.trim() : freshVenue.name,
        category: category !== undefined ? category.trim() : freshVenue.category,
        address: address !== undefined ? address.trim() : freshVenue.address,
        certification: certification !== undefined ? certification.trim() : freshVenue.certification,
        ownerEmail: ownerEmail !== undefined ? ownerEmail?.trim().toLowerCase() : freshVenue.ownerEmail,
      };
      const newVenues = freshVenues.map((v) => (v.id === id ? updated : v));
      return { doc: { ...freshDoc, venues: newVenues }, result: updated };
    },
    { label: 'update-venue', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as Venue;
  broadcast('VENUE_UPDATED', { venue: updated, agencyId: callerAgencyId }, undefined, callerAgencyId);
  res.json({ success: true, venue: updated });
});

// Admin deletes a venue
app.delete('/api/venues/:id', async (req, res) => {
  const { id } = req.params;

  const caller = requireAdmin(req, res);
  if (!caller) {
    return res.status(403).json({ error: 'Only administrators can remove venue platforms.' });
  }
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
      // Atomic cascade: venue + its tasks + its history all removed together.
      return {
        doc: {
          ...freshDoc,
          venues: freshVenues.filter((v) => v.id !== id),
          tasks: freshTasks.filter((t) => t.venueId !== id),
          historyLogs: freshHistory.filter((h) => h.venueId !== id),
        },
        result: { success: true, deletedVenueId: id },
      };
    },
    { label: 'delete-venue', requireVersion: true }
  );
  if (!committed) return;

  broadcast('VENUE_DELETED', { deletedVenueId: id, agencyId: callerAgencyId }, undefined, callerAgencyId);
  res.json({ success: true, deletedVenueId: id });
});

// -------------------------------------------------------------
// TASKS ENDPOINTS (Filtered by Venue)
// -------------------------------------------------------------

app.get('/api/tasks', (req, res) => {
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let isCallerAdmin = true;
  let callerVenueId: string | undefined = undefined;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      isCallerAdmin = user.role === 'admin';
      callerVenueId = user.venueId;
    }
  }

  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);
  let targetVenueId = venueId ? String(venueId) : agencyVenues[0]?.id || 'venue-crown-market';

  // Strict tenant boundary: workers and owners only access their assigned venue
  if (!isCallerAdmin) {
    targetVenueId = callerVenueId || agencyVenues[0]?.id || 'venue-crown-market';
  } else {
    // If admin requested a venueId, ensure it belongs to their agency
    if (!agencyVenues.some((v) => v.id === targetVenueId) && agencyVenues.length > 0) {
      targetVenueId = agencyVenues[0].id;
    }
  }

  const filteredTasks = tasks.filter(
    (t) => t.venueId === targetVenueId && (t.agencyId || 'agency-hkc') === callerAgencyId
  );
  // Private assignments: only the assignees, coordinators and admins may see them
  const callerEmailNorm = userEmail ? String(userEmail).trim().toLowerCase() : '';
  const callerUser = callerEmailNorm
    ? users.find((u) => u.email.toLowerCase() === callerEmailNorm)
    : undefined;
  const canSeePrivate =
    isCallerAdmin || (callerUser && callerUser.role === 'coordinator');
  const visibleTasks = canSeePrivate
    ? filteredTasks
    : filteredTasks.filter(
        (t) =>
          !t.isPrivate ||
          (callerEmailNorm !== '' &&
            (t.assignedTo || []).some((a) => a.toLowerCase() === callerEmailNorm))
      );
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

  const caller = createdByEmail
    ? users.find((u) => u.email.toLowerCase() === String(createdByEmail).trim().toLowerCase())
    : null;
  const callerAgencyId = caller?.agencyId || 'agency-hkc';

  // Permission check: Admin, Coordinator, or user with canAssignTasks permission
  if (caller) {
    const isAllowedToAssign =
      caller.role === 'admin' ||
      caller.role === 'coordinator' ||
      caller.permissions?.canAssignTasks === true;
    if (!isAllowedToAssign) {
      return res.status(403).json({ error: 'You do not have permission to assign or create new tasks.' });
    }
  }

  const agencyVenues = venues.filter((v) => (v.agencyId || 'agency-hkc') === callerAgencyId);
  const targetVenueId = venueId || agencyVenues[0]?.id || 'venue-crown-market';
  // The task's venue must belong to the caller's agency.
  if (!requireOwnVenue(req, res, targetVenueId, venues)) return;

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

  const newTask: TaskItem = {
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
  };

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
            (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt.localeCompare(b.createdAt)
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
  broadcast('TASK_CREATED', created, createdByEmail, created.agencyId || 'agency-hkc');

  // Phone push to specifically-assigned mashgichim (not for global 'all' tasks)
  const assignees = (created.assignedTo || []).filter(
    (a) => a && a.toLowerCase() !== 'all'
  );
  for (const email of assignees) {
    if (createdByEmail && email.toLowerCase() === createdByEmail.toLowerCase()) continue;
    sendPushToUser(
      email,
      '📋 New task assigned to you',
      `${created.title}${created.targetTime ? ` — ${created.targetTime}` : ''}`,
      { url: '/', taskId: created.id }
    );
  }

  res.status(201).json(created);
});

// Update task status, notes, or configuration
app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const existing = tasks.find((t) => t.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, existing, 'tasks')) return;

  const {
    currentStatus,
    isCompleted,
    notes,
    userEmail,
    userName,
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

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === userEmail.trim().toLowerCase());
    if (caller) {
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

      const updatedByEmail = finalIsCompleted ? (userEmail || freshTask.updatedByEmail || null) : null;
      const updatedByName = finalIsCompleted ? (userName || freshTask.updatedByName || null) : null;
      const updatedAt = finalIsCompleted ? (hasStatusChange ? new Date().toISOString() : freshTask.updatedAt) : null;

      const updated: TaskItem = {
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
      };

      const newTasks = freshTasks.map((t) => (t.id === id ? updated : t));
      return { doc: { ...freshDoc, tasks: newTasks }, result: updated };
    },
    { label: 'update-task', requireVersion: true }
  );
  if (!committed) return;

  const updated = committed.result as TaskItem;
  broadcast('TASK_UPDATED', updated, userEmail, updated.agencyId || 'agency-hkc');
  res.json(updated);
});

// Remove one check-in entry (tapped by mistake, logged in error).
app.delete('/api/tasks/:id/check-in/:checkInId', async (req, res) => {
  const { id, checkInId } = req.params;
  const existing = tasks.find((t) => t.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, existing, 'tasks')) return;

  const { userEmail } = req.body || {};
  const entry = (existing.checkIns || []).find((c: any) => c.id === checkInId);
  if (!entry) {
    return res.status(404).json({ error: 'Check-in not found' });
  }

  // The person who logged it, or anyone with fill permission, can remove it.
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    const isLogger = entry.byEmail && entry.byEmail.toLowerCase() === String(userEmail).trim().toLowerCase();
    const canFill =
      caller &&
      (caller.role === 'admin' ||
        (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
        ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
        (caller.role === 'owner' && caller.permissions?.canFillTasks === true));
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

  broadcast('TASK_UPDATED', updated, userEmail, updated.agencyId || 'agency-hkc');
  res.json(updated);
});

// Log one repeatable check-in on a task (inputType 'check_in'): every tap
// appends a {byName, byEmail, at} record under the task.
app.post('/api/tasks/:id/check-in', async (req, res) => {
  const { id } = req.params;
  const existing = tasks.find((t) => t.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, existing, 'tasks')) return;

  const { userEmail, userName, photoData, photoCaption } = req.body;
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      const canFill =
        caller.role === 'admin' ||
        (caller.role === 'coordinator' && caller.permissions?.canFillTasks !== false) ||
        ((caller.role === 'mashgiach' || caller.role === 'worker') && caller.permissions?.canFillTasks !== false) ||
        (caller.role === 'owner' && caller.permissions?.canFillTasks === true);
      if (!canFill) {
        return res.status(403).json({ error: 'You do not have permission to log checks.' });
      }
    }
  }

  // Stable check-in ID generated BEFORE the transaction so retries don't duplicate.
  const now = new Date().toISOString();
  const checkInId = `checkin-${crypto.randomUUID()}`;
  const checkIn: TaskCheckInItem = {
    id: checkInId,
    byName: userName || null,
    byEmail: userEmail || null,
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
      // Idempotency: if this check-in ID already exists, return the task as-is.
      const alreadyLogged = (freshTask.checkIns || []).some((c: any) => c.id === checkInId);
      if (alreadyLogged) {
        return { doc: freshDoc, result: freshTask };
      }
      const updated: TaskItem = {
        ...freshTask,
        checkIns: [...(freshTask.checkIns || []), checkIn],
        updatedByEmail: userEmail || freshTask.updatedByEmail || null,
        updatedByName: userName || freshTask.updatedByName || null,
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
  broadcast('TASK_UPDATED', updated, userEmail, updated.agencyId || 'agency-hkc');
  res.json(updated);
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const deletedTask = tasks.find((t) => t.id === id);

  if (!deletedTask) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!requireSameAgency(req, res, deletedTask, 'tasks')) return;
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

  broadcast('TASK_DELETED', { id, venueId: delVenueId, agencyId: delAgencyId }, undefined, delAgencyId || 'agency-hkc');
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

// Admin Wipes All Demo Data to Start Completely From Scratch
app.post('/api/admin/clean-slate', async (req, res) => {
  const caller = requireAdmin(req, res);
  if (!caller) {
    return res.status(403).json({ error: 'Only administrators can reset the platform to a clean slate.' });
  }

  const callerAgencyId = caller.agencyId || 'agency-hkc';
  const callerEmailLower = caller.email.toLowerCase();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const keep = (arr: any[]) =>
        (Array.isArray(arr) ? arr : []).filter((x) => (x.agencyId || 'agency-hkc') !== callerAgencyId);
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      // Wipe agency data atomically; keep admin users.
      return {
        doc: {
          ...freshDoc,
          tasks: keep(freshDoc.tasks),
          historyLogs: keep(freshDoc.historyLogs),
          events: keep(freshDoc.events),
          venues: keep(freshDoc.venues),
          airtableConfigs: keep(freshDoc.airtableConfigs),
          approvedIngredients: keep(freshDoc.approvedIngredients),
          factoryReports: keep(freshDoc.factoryReports),
          users: freshUsers.filter(
            (u) => (u.agencyId || 'agency-hkc') !== callerAgencyId || u.role === 'admin' || u.email.toLowerCase() === callerEmailLower
          ),
          isDemoCleared: true,
        },
        result: { success: true, isDemoCleared: true },
      };
    },
    { label: 'clean-slate' }
  );
  if (!committed) return;

  broadcast('CLEAN_SLATE_RESET', {
    agencyId: callerAgencyId,
    venues: [],
    tasks: [],
    events: [],
    users: getSafeUsers(),
    isDemoCleared: true,
  }, undefined, callerAgencyId);

  res.json({
    success: true,
    isDemoCleared: true,
    venues: [],
    tasks: [],
    events: [],
    users: getSafeUsers(),
    message: 'All demo facilities and example data have been cleared. Ready to start from scratch!',
  });
});

// Admin Restores Demonstration Facilities and Data
app.post('/api/admin/restore-demo', async (req, res) => {
  const caller = requireAdmin(req, res);
  if (!caller) {
    return res.status(403).json({ error: 'Only administrators can restore demonstration data.' });
  }

  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const replaceAgency = (arr: any[], seeds: any[]) => [
        ...(Array.isArray(arr) ? arr : []).filter((x) => (x.agencyId || 'agency-hkc') !== callerAgencyId),
        ...seeds,
      ];
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const newUsers = [...freshUsers];
      for (const defUser of DEFAULT_USERS) {
        if (!newUsers.some((u) => u.email.toLowerCase() === defUser.email.toLowerCase())) {
          newUsers.push({ ...defUser });
        }
      }
      // Re-seed default venues, tasks, events, and users atomically.
      return {
        doc: {
          ...freshDoc,
          venues: replaceAgency(freshDoc.venues, DEFAULT_VENUES),
          tasks: replaceAgency(freshDoc.tasks, INITIAL_TASKS),
          historyLogs: replaceAgency(freshDoc.historyLogs, INITIAL_HISTORY),
          events: replaceAgency(freshDoc.events, INITIAL_EVENTS),
          airtableConfigs: replaceAgency(freshDoc.airtableConfigs, INITIAL_AIRTABLE_CONFIGS),
          approvedIngredients: replaceAgency(freshDoc.approvedIngredients, INITIAL_APPROVED_INGREDIENTS),
          users: newUsers,
          isDemoCleared: false,
        },
        result: { success: true, isDemoCleared: false },
      };
    },
    { label: 'restore-demo' }
  );
  if (!committed) return;

  broadcast('DEMO_RESTORED', {
    agencyId: callerAgencyId,
    venues,
    tasks,
    events,
    users: getSafeUsers(),
    isDemoCleared: false,
  }, undefined, callerAgencyId);

  res.json({
    success: true,
    isDemoCleared: false,
    venues,
    tasks,
    events,
    users: getSafeUsers(),
    message: 'Demo facilities, mashgichim, and inspection tasks have been restored.',
  });
});

app.get('/api/history', (req, res) => {
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let targetVenueId = venueId ? String(venueId) : null;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      if (user.role !== 'admin') {
        targetVenueId = user.venueId || null;
      }
    }
  }

  // Filter logs strictly by caller agency
  const agencyHistory = historyLogs.filter((h) => (h.agencyId || 'agency-hkc') === callerAgencyId);

  if (targetVenueId) {
    res.json({ historyLogs: agencyHistory.filter((h) => h.venueId === targetVenueId) });
  } else {
    res.json({ historyLogs: agencyHistory });
  }
});

// -------------------------------------------------------------
// KOSHER EVENTS ENDPOINTS
// -------------------------------------------------------------

// ---- Default event task templates ----
// Admin-defined tasks that pre-fill every new event notification.
// The event creator can delete any that don't apply and add event-specific ones.
app.get('/api/event-task-templates', (req, res) => {
  const { agencyId } = req.query;
  const list = eventTaskTemplates
    .filter((t) => !agencyId || !t.agencyId || t.agencyId === agencyId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  res.json({ templates: list });
});

function canManageTemplates(req: any): boolean {
  const caller = getAuthUser(req);
  return !!caller && (caller.role === 'admin' || caller.role === 'coordinator');
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
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let callerRole = 'admin';
  let callerVenueId: string | undefined = undefined;
  let normalizedUserEmail = '';

  if (userEmail) {
    normalizedUserEmail = String(userEmail).trim().toLowerCase();
    const user = users.find((u) => u.email.toLowerCase() === normalizedUserEmail);
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      callerRole = user.role;
      callerVenueId = user.venueId;
    }
  }

  // Filter events strictly by agency
  let agencyEvents = events.filter((e) => (e.agencyId || 'agency-hkc') === callerAgencyId);

  // If user is owner or coordinator, restrict to their venue unless admin
  if (callerRole === 'owner') {
    agencyEvents = agencyEvents.filter((e) => e.venueId === callerVenueId);
  } else if (callerRole === 'mashgiach') {
    // Mashgiach sees events assigned to them OR events in their venue
    agencyEvents = agencyEvents.filter(
      (e) =>
        (e.assignedMashgiachEmail && e.assignedMashgiachEmail.toLowerCase() === normalizedUserEmail) ||
        (callerVenueId && e.venueId === callerVenueId)
    );
  } else if (venueId && venueId !== 'all') {
    agencyEvents = agencyEvents.filter((e) => e.venueId === String(venueId));
  }

  // Sort by date ascending
  agencyEvents.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  res.json({ events: agencyEvents });
});

app.post('/api/events', async (req, res) => {
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
    userEmail,
    userName,
  } = req.body;

  if (!title || !location || !date) {
    return res.status(400).json({ error: 'Title, location, and date are required.' });
  }

  let callerAgencyId = 'agency-hkc';
  let creatorEmail = userEmail || 'admin@kosherkitchen.com';
  let creatorName = userName || 'Staff Member';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
      creatorName = caller.name;
    }
  }

  const targetVenueId = venueId || 'venue-crown-market';
  // The event's venue must belong to the caller's agency.
  if (!requireOwnVenue(req, res, targetVenueId, venues)) return;
  const targetVenue = venues.find((v) => v.id === targetVenueId);

  // Resolve assigned mashgiach details
  let resolvedMashgiachEmail = assignedMashgiachEmail;
  let resolvedMashgiachName = assignedMashgiachName;

  if (mashgiachType === 'assigned_user' && assignedMashgiachEmail) {
    const matchedUser = users.find((u) => u.email.toLowerCase() === assignedMashgiachEmail.toLowerCase());
    if (matchedUser) {
      resolvedMashgiachName = matchedUser.name;
    }
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
    mashgiachType: mashgiachType || (assignedMashgiachEmail ? 'assigned_user' : externalMashgiach ? 'external' : 'unassigned'),
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
      if (existing) return { doc: freshDoc, result: existing };
      return { doc: { ...freshDoc, events: [...arr, newEvent] }, result: newEvent };
    },
    { label: 'create-event' }
  );
  if (!committed) return;
  const event = committed.result as KosherEventItem;

  // Side effects ONLY after commit.
  broadcast('EVENT_CREATED', {
    event,
    agencyId: callerAgencyId,
    venueId: targetVenueId,
    assignedMashgiachEmail: resolvedMashgiachEmail,
  }, undefined, callerAgencyId);

  if (resolvedMashgiachEmail) {
    const when = event.date ? ` — ${event.date}` : '';
    sendPushToUser(
      resolvedMashgiachEmail,
      '⭐ New event assignment',
      `${event.title}${when} at ${event.location}`,
      { url: '/', eventId: event.id }
    );
  }

  res.status(201).json({ event });
});

app.put('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const existing = events.find((e) => e.id === id);

  if (!existing) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (!requireSameAgency(req, res, existing, 'events')) return;

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
    userEmail,
    userName,
  } = req.body;

  // Baseline for semantic conflict detection on title/location/date.
  const baseline = { title: existing.title, location: existing.location, date: existing.date };

  let resolvedMashgiachEmail = assignedMashgiachEmail !== undefined ? assignedMashgiachEmail : existing.assignedMashgiachEmail;
  let resolvedMashgiachName = assignedMashgiachName !== undefined ? assignedMashgiachName : existing.assignedMashgiachName;

  if (assignedMashgiachEmail) {
    const matchedUser = users.find((u) => u.email.toLowerCase() === assignedMashgiachEmail.toLowerCase());
    if (matchedUser) {
      resolvedMashgiachName = matchedUser.name;
    }
  }
  const updatedAt = new Date().toISOString();

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshEvents: any[] = Array.isArray(freshDoc.events) ? freshDoc.events : [];
      const freshEvent = freshEvents.find((e) => e.id === id);
      if (!freshEvent) return { conflict: 'Event not found (it may have been deleted).' };
      // Conflict if someone else changed a field this request is editing.
      for (const field of ['title', 'location', 'date'] as const) {
        const newVal = { title, location, date }[field];
        if (newVal !== undefined && (freshEvent as any)[field] !== (baseline as any)[field]) {
          return { conflict: `Conflict: event ${field} was changed by someone else. Please refresh and try again.` };
        }
      }
      const updated: KosherEventItem = {
        ...freshEvent,
        title: title !== undefined ? title : freshEvent.title,
        location: location !== undefined ? location : freshEvent.location,
        date: date !== undefined ? date : freshEvent.date,
        endDate: endDate !== undefined ? endDate : freshEvent.endDate,
        startTime: startTime !== undefined ? startTime : freshEvent.startTime,
        endTime: endTime !== undefined ? endTime : freshEvent.endTime,
        mashgiachType: mashgiachType !== undefined ? mashgiachType : freshEvent.mashgiachType,
        assignedMashgiachEmail: resolvedMashgiachEmail,
        assignedMashgiachName: resolvedMashgiachName,
        externalMashgiach: externalMashgiach !== undefined ? externalMashgiach : freshEvent.externalMashgiach,
        menuAttachmentName: menuAttachmentName !== undefined ? menuAttachmentName : freshEvent.menuAttachmentName,
        menuAttachmentData: menuAttachmentData !== undefined ? menuAttachmentData : freshEvent.menuAttachmentData,
        notes: notes !== undefined ? notes : freshEvent.notes,
        status: status !== undefined ? status : freshEvent.status,
        tasks: updatedTasks !== undefined ? updatedTasks : freshEvent.tasks,
        updatedAt,
      };
      const newEvents = freshEvents.map((e) => (e.id === id ? updated : e));
      return { doc: { ...freshDoc, events: newEvents }, result: updated };
    },
    { label: 'update-event', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as KosherEventItem;

  broadcast('EVENT_UPDATED', {
    event: updated,
    agencyId: updated.agencyId,
    venueId: updated.venueId,
    assignedMashgiachEmail: updated.assignedMashgiachEmail,
  }, undefined, updated.agencyId || 'agency-hkc');

  res.json({ event: updated });
});

app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  const deletedEvent = events.find((e) => e.id === id);

  if (!deletedEvent) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (!requireSameAgency(req, res, deletedEvent, 'events')) return;
  const agencyId = deletedEvent.agencyId;
  const venueId = deletedEvent.venueId;

  const ok = await crudDelete(req, res, 'events', id, {
    label: 'delete-event',
    broadcastType: 'EVENT_DELETED',
    getDeletePayload: () => ({ id, agencyId, venueId }),
    getAgencyId: () => agencyId || 'agency-hkc',
  });
  return;
});

// Event Task Toggle / Status Endpoint
app.post('/api/events/:id/tasks/:taskId/toggle', async (req, res) => {
  const { id, taskId } = req.params;
  const { isCompleted, notes, userEmail, userName } = req.body;

  const event = events.find((e) => e.id === id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (!requireSameAgency(req, res, event, 'events')) return;

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
        completedByName: targetCompleted ? (userName || 'Mashgiach') : null,
        completedByEmail: targetCompleted ? (userEmail || null) : null,
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
  const { venueId, userEmail } = req.query;

  let callerAgencyId = 'agency-hkc';
  let targetVenueId = venueId ? String(venueId) : null;

  if (userEmail) {
    const user = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (user) {
      callerAgencyId = user.agencyId || 'agency-hkc';
      if (user.role !== 'admin') {
        targetVenueId = user.venueId || null;
      }
    }
  }

  // Scope to caller's agency
  let agencyUsers = getSafeUsers().filter((u) => (u.agencyId || 'agency-hkc') === callerAgencyId);

  if (targetVenueId) {
    // Return users assigned to this venue OR agency admins
    agencyUsers = agencyUsers.filter((u) => u.role === 'admin' || u.venueId === targetVenueId);
  }

  res.json({ users: agencyUsers });
});

app.post('/api/users', async (req, res) => {
  // Only admins can create users — verified from the session token, never the body.
  const caller = requireAdmin(req, res);
  if (!caller) return;
  // New users are always created in the caller's own agency.
  const callerAgencyId = caller.agencyId || 'agency-hkc';

  const { email, name, role, password, venueId, permissions } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'Email and name are required' });
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
  broadcast('USERS_UPDATED', { users: getSafeUsers(), agencyId: callerAgencyId }, undefined, callerAgencyId);
  res.status(201).json({ user: getSafeUser(created) });
});

// Update user permissions or role
app.put('/api/users/:id', async (req, res) => {
  // Only admins can update users — verified from the session token.
  const caller = requireAdmin(req, res);
  if (!caller) return;
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

  const { role, permissions, venueId, name, kioskPin } = req.body;

  // Validate PIN outside the transaction (pure validation).
  let pinUpdate: string | undefined | null = null; // null = no change
  if (kioskPin !== undefined) {
    const pin = String(kioskPin).trim();
    if (pin !== '' && !/^[0-9]{4,6}$/.test(pin)) {
      return res.status(400).json({ error: 'Kiosk PIN must be 4-6 digits or empty.' });
    }
    pinUpdate = pin === '' ? undefined : pin;
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
      if (pinUpdate !== null) updated.kioskPin = pinUpdate === undefined ? undefined : pinUpdate;
      if (venueId !== undefined) updated.venueId = venueId;
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
      return { doc: { ...freshDoc, users: newUsers }, result: updated };
    },
    { label: 'update-user', requireVersion: true }
  );
  if (!committed) return;
  const updated = committed.result as UserProfile;
  broadcast('USERS_UPDATED', { users: getSafeUsers(), agencyId: updated.agencyId }, undefined, updated.agencyId);
  res.json({ user: getSafeUser(updated) });
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
      (userAgency && userToDelete.email.toLowerCase() === userAgency.adminEmail.toLowerCase())
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
      return {
        doc: { ...freshDoc, users: freshUsers.filter((u) => u.id !== id) },
        result: { success: true, deletedId: id },
      };
    },
    { label: 'delete-user', requireVersion: true }
  );
  if (!committed) return;
  broadcast(
    'USERS_UPDATED',
    { users: getSafeUsers(), deletedId: id, agencyId: deletedAgencyId },
    undefined,
    deletedAgencyId
  );
  res.json({ success: true, deletedId: id });
});

// ---- Kiosk mode: shared tablet login via per-user PIN ----
// Public list of PIN-enabled staff for one venue (no PINs, no emails exposed).
// Public venue list for kiosk setup: id + name only, no sensitive data.
// A fresh tablet needs this before anyone logs in.
app.get('/api/kiosk/venues', (req, res) => {
  res.json({
    venues: venues.map((v) => ({ id: v.id, name: v.name })),
  });
});

app.get('/api/kiosk/users', (req, res) => {
  const venueId = String(req.query.venueId || '').trim();
  if (!venueId) return res.status(400).json({ error: 'venueId required' });
  const staff = users
    .filter((u) => u.venueId === venueId && u.kioskPin && ['mashgiach', 'worker', 'coordinator'].includes(u.role))
    .map((u) => ({ id: u.id, name: u.name, avatarColor: u.avatarColor, role: u.role }));
  const venue = venues.find((v) => v.id === venueId);
  res.json({ venueName: venue?.name || 'Kiosk', users: staff });
});

// Verify a kiosk PIN and return the user session (with a signed token, so the
// kiosk session is authenticated like any other login).
app.post('/api/kiosk/login', (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'Missing credentials' });
  const user = users.find((u) => u.id === userId);
  if (!user || !user.kioskPin || user.kioskPin !== String(pin).trim()) {
    return res.status(401).json({ error: 'Wrong code. Try again.' });
  }
  res.json({ user: getSafeUser(user), token: signToken(user.id) });
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
      console.warn('[login] Password-hash upgrade write failed (login still succeeds):', (err as any)?.message);
    }
  }

  const token = signToken(user.id);
  res.json({
    success: true,
    user: getSafeUser(user),
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
  const agencyId = user.agencyId || 'agency-hkc';
  const admins = users.filter((u) =>
    (u.agencyId || 'agency-hkc') === agencyId &&
    ['admin', 'coordinator'].includes(u.role)
  );
  for (const admin of admins) {
    sendPushToUser(
      admin.email,
      `🔑 Password reset code for ${user.name}`,
      `Code: ${code} (expires in 15 min)`,
      { type: 'password-reset', email: normalizedEmail }
    );
  }
  // Also broadcast so admin sees it in-app
  broadcast('PASSWORD_RESET_REQUESTED', { email: normalizedEmail, code, userName: user.name }, undefined, agencyId);

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
      return {
        doc: { ...freshDoc, users: newUsers, passwordResets: newResets },
        result: { userId: user.id },
      };
    },
    { label: 'reset-password' }
  );
  if (!committed) return;

  const token = signToken(user.id);
  res.json({ success: true, user: getSafeUser(users.find((u) => u.id === user.id)!), token });
});

// First-run admin setup: sets the admin password. Public, but ONLY works when
// the admin account has no password yet — it becomes a no-op forever after.
app.post('/api/auth/setup', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword || String(newPassword).trim().length < 8) {
    return res.status(400).json({ error: 'A password of at least 8 characters is required.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (!user) {
    return res.status(404).json({ error: 'Account not found.' });
  }
  if (user.role !== 'admin' || user.password) {
    return res.status(403).json({ error: 'Setup is already complete.' });
  }

  // Hash BEFORE the transaction (CPU-heavy).
  const newHash = await hashPassword(String(newPassword).trim());

  const committed = await commitOrRespond(
    req, res,
    (freshDoc) => {
      const freshUsers: any[] = Array.isArray(freshDoc.users) ? freshDoc.users : [];
      const freshUser = freshUsers.find((u) => u.id === user.id);
      if (!freshUser) return { conflict: 'Account not found.' };
      // Setup must still be pending in fresh data — if a password already
      // exists, someone else completed setup first.
      if (freshUser.role !== 'admin' || freshUser.password) {
        return { conflict: 'Setup is already complete.' };
      }
      const newUsers = freshUsers.map((u) => (u.id === user.id ? { ...u, password: newHash } : u));
      return { doc: { ...freshDoc, users: newUsers }, result: { userId: user.id } };
    },
    { label: 'auth-setup' }
  );
  if (!committed) return;

  const token = signToken(user.id);
  res.json({ success: true, user: getSafeUser(users.find((u) => u.id === user.id)!), token });
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
  const { venueId, userEmail } = req.query;
  let callerAgencyId = 'agency-hkc';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) callerAgencyId = caller.agencyId || 'agency-hkc';
  }

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
  const { venueId, userEmail } = req.body;
  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required to sync factory ingredients.' });
  }

  let callerAgencyId = 'agency-hkc';
  let callerName = 'System';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
      callerName = caller.name;
    }
  }

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
  const { venueId, userEmail } = req.query;
  let callerAgencyId = 'agency-hkc';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) callerAgencyId = caller.agencyId || 'agency-hkc';
  }

  let items = approvedIngredients.filter((i) => (i.agencyId || 'agency-hkc') === callerAgencyId);
  if (venueId) {
    items = items.filter((i) => i.venueId === venueId);
  }

  res.json({ ingredients: items });
});

// Mashgiach verifies or flags an approved ingredient during factory visit
app.put('/api/ingredients/:id/verify', async (req, res) => {
  const { id } = req.params;
  const { verificationStatus, verificationNotes, userEmail } = req.body;

  const existing = approvedIngredients.find((i) => i.id === id);
  if (!existing) {
    return res.status(404).json({ error: 'Ingredient not found' });
  }
  if (!requireSameAgency(req, res, existing, 'ingredients')) return;

  let verifiedByName = 'Factory Mashgiach';
  let verifiedByEmail = userEmail || null;

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      verifiedByName = caller.name;
      verifiedByEmail = caller.email;
    }
  }
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
  const { venueId, name, brandOrSupplier, kashrutAgency, kosherStatus, lotOrBatch, notes, userEmail } = req.body;
  if (!venueId || !name) {
    return res.status(400).json({ error: 'Venue ID and ingredient name are required.' });
  }

  let callerAgencyId = 'agency-hkc';
  let approverName = 'HKC Rabbinic Council';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || 'agency-hkc';
      approverName = caller.name;
    }
  }
  // The ingredient's venue must belong to the caller's agency.
  if (!requireOwnVenue(req, res, venueId, venues)) return;

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
  const { venueId, userEmail } = req.query;
  let callerAgencyId = 'agency-hkc';
  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) callerAgencyId = caller.agencyId || 'agency-hkc';
  }

  let reports = factoryReports.filter((r) => r.agencyId === callerAgencyId);
  if (venueId) {
    reports = reports.filter((r) => r.venueId === venueId);
  }

  // Sort newest first
  reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ reports });
});

// Factory Audit Reports: Submit New Mashgiach Inspection Report
app.post('/api/factory-reports', async (req, res) => {
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
    userEmail,
  } = req.body;

  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required to submit a factory report.' });
  }

  const venue = venues.find((v) => v.id === venueId);
  // The report's venue must belong to the caller's agency (and determines the agency).
  if (!requireOwnVenue(req, res, venueId, venues)) return;
  let callerAgencyId = venue?.agencyId || 'agency-hkc';
  let mashgiachName = 'Rabbi Shimon Klein (Factory Mashgiach)';
  let mashgiachEmail = userEmail || 'factory.mashgiach@hartfordkashrut.org';

  if (userEmail) {
    const caller = users.find((u) => u.email.toLowerCase() === String(userEmail).trim().toLowerCase());
    if (caller) {
      callerAgencyId = caller.agencyId || callerAgencyId;
      mashgiachName = caller.name;
      mashgiachEmail = caller.email;
    }
  }

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
  });

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
  ).catch((err) => console.warn('[Boot] Task-order backfill failed:', (err as any)?.message));

  // Web Push: VAPID keys must be ready after durable state loads (env vars
  // take precedence over persisted keys inside ensureVapidKeys).
  ensureVapidKeys();

  // Security migration: hash any legacy plaintext passwords still in state.
  // Runs once per boot; already-hashed passwords are untouched.
  await migratePasswordsToBcrypt();
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
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[WorkPulse Server] Listening on http://0.0.0.0:${PORT} with WebSockets enabled at /ws`);
  });
}

startServer();
