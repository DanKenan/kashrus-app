/**
 * Stage 4 PR A — Consistency + monolith-size monitor.
 *
 * POST /api/internal/consistency-check (scheduler-OIDC or admin only):
 * - Runs perEntityStatus() with version-stable retry (avoids false alerts
 *   from concurrent transactions).
 * - Measures monolith serialized size; warns at 800 KiB (before the 900 KiB
 *   application guard).
 * - Returns non-2xx on any failure so Cloud Scheduler retries / alerts.
 * - Logs IDs and reasons only — never user documents, hashes, PINs, secrets.
 *
 * POST /api/internal/test-alert (admin only):
 * - Fires a real log line at ERROR severity so Don can verify the
 *   Cloud Monitoring alert pipeline delivers to his email/phone.
 * - Body {"mode":"demo"} fires ONE demo line in the grouped shape instead,
 *   built from fixed sample data and clearly marked not real data.
 *
 * Alert grouping (item 3): one run writes AT MOST one "[consistency] ERROR"
 * line — a summary (type counts + first 3 items + run id). Every finding is
 * written as it is found as one "[consistency] INFO run=<id> …" line, so the
 * details sit one Logs Explorer search away. runConsistencyCheck NEVER logs
 * at ERROR; handleConsistencyCheck is the single writer of the summary line.
 */

import { log } from './log.ts';
import { randomBytes } from 'node:crypto';
const FIRESTORE_STATE_DOC = 'app-state/main';
const MONOLITH_SIZE_WARN_BYTES = 800 * 1024; // 800 KiB warning
const MAX_CONSISTENCY_RETRIES = 3;

import { getStorage } from 'firebase-admin/storage';

/**
 * Get the monolith's _v (global version) for stability checking.
 */
async function getMonolithVersion(firestoreDb: any): Promise<number | null> {
  try {
    const snap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
    if (!snap.exists) return null;
    const v = snap.data()?._v;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Measure the serialized size of the monolith document in bytes.
 */
async function getMonolithSize(firestoreDb: any): Promise<number | null> {
  try {
    const snap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
    if (!snap.exists) return null;
    const json = JSON.stringify(snap.data());
    return Buffer.byteLength(json, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Alert grouping: issues, sanitizing, the summary formatter           */
/* ------------------------------------------------------------------ */

export const CONSISTENCY_ISSUE_TYPES = [
  'mismatch-missing',
  'mismatch-field',
  'mismatch-orphan',
  'mismatch-duplicate-email',
  'mismatch-email-lookup',
  'mismatch-other',
  'backup-stale',
  'backup-unconfigured',
  'size-warn',
  'unreadable',
  'check-error',
] as const;
export type ConsistencyIssueType = (typeof CONSISTENCY_ISSUE_TYPES)[number];

export interface ConsistencyIssue {
  type: ConsistencyIssueType;
  item: string;
  detail: string;
}

const ISSUE_TYPE_SET = new Set<string>(CONSISTENCY_ISSUE_TYPES);
export const CONSISTENCY_ERROR_PREFIX = '[consistency] ERROR';
export const DEMO_ALERT_PREFIX = '[alert-test] TEST ALERT (demo of grouped summary — not real data)';

/** Strip control characters, collapse whitespace to single spaces, cap length. */
export function sanitizeText(value: unknown, cap: number): string {
  const s = String(value ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}

/** A bounded, single-line reason for an exception — never a stack, never a document. */
export function boundedReason(e: unknown): string {
  const msg = (e as any)?.message ?? String(e ?? 'unknown error');
  return sanitizeText(msg, 120);
}

/** Validate an issue type against the fixed list; anything unknown becomes 'mismatch-other'. */
export function validIssueType(t: unknown): ConsistencyIssueType {
  return typeof t === 'string' && ISSUE_TYPE_SET.has(t) ? (t as ConsistencyIssueType) : 'mismatch-other';
}

/** Map a perEntityStatus reason string (migration.ts) to an issue type. */
export function issueTypeForReason(reason: unknown): ConsistencyIssueType {
  const r = typeof reason === 'string' ? reason : '';
  if (r === 'Missing in per-entity collection') return 'mismatch-missing';
  if (r.startsWith('Field mismatch')) return 'mismatch-field';
  if (r === 'In per-entity but not in monolith (orphan)') return 'mismatch-orphan';
  if (r === 'Duplicate normalized email in monolith') return 'mismatch-duplicate-email';
  if (
    r === 'Missing email lookup' ||
    r === 'Email lookup points to wrong user' ||
    r === 'Extra lookup not in monolith'
  ) {
    return 'mismatch-email-lookup';
  }
  return 'mismatch-other';
}

/**
 * The one summary line for a run. Pure and deterministic — tests pin the
 * exact text. Shape:
 *   <prefix> run=<id> — N issue(s): <count> <type>, …[ (+K more types)].
 *   <item>: <detail>; …[ and X more]. Details: INFO lines run=<id>
 * Items/details are sanitized and capped (48 / 80 chars) here, so every
 * caller (production run, demo alert, tests) gets the same safe text.
 *
 * opts.capped: the per-entity check lists at most 20 mismatches, so when
 * the mismatch list hit that cap the total is a floor, not an exact count —
 * the line reads "20+ issues:" (counts and "and X more" unchanged).
 *
 * Note (fix round 1, LOW): the 0-issues form of this line is unreachable in
 * production — the formatter is only called with the ERROR prefix when at
 * least one issue exists (perEntityStatus match === zero mismatches, and
 * every other not-ok branch adds an issue first). It exists so the
 * formatter is total and demo/test callers get a sane line.
 */
export function formatConsistencySummary(
  prefix: string,
  runId: string,
  issues: ConsistencyIssue[],
  opts: { capped?: boolean } = {}
): string {
  const clean = (issues || []).map((i) => ({
    type: validIssueType(i?.type),
    item: sanitizeText(i?.item, 48),
    detail: sanitizeText(i?.detail, 80),
  }));
  const n = clean.length;
  const suffix = `Details: INFO lines run=${runId}`;
  if (n === 0) return `${prefix} run=${runId} — 0 issues. ${suffix}`;
  const counts = new Map<string, number>();
  for (const i of clean) counts.set(i.type, (counts.get(i.type) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const countsText =
    sorted.slice(0, 3).map(([t, c]) => `${c} ${t}`).join(', ') +
    (sorted.length > 3 ? ` (+${sorted.length - 3} more types)` : '');
  const itemsText = clean.slice(0, 3).map((i) => `${i.item}: ${i.detail}`).join('; ');
  const moreText = n > 3 ? ` and ${n - 3} more` : '';
  const totalText = opts.capped ? `${n}+` : `${n}`;
  return `${prefix} run=${runId} — ${totalText} ${n === 1 ? 'issue' : 'issues'}: ${countsText}. ${itemsText}${moreText}. ${suffix}`;
}

/** Run id: c-YYYYMMDD-HHMM-xxxx (UTC, minute precision + 4 random hex). */
export function newConsistencyRunId(now: Date = new Date()): string {
  const p = (v: number) => String(v).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `c-${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Fixed sample issues for the test-alert demo mode — never real data. */
export function demoConsistencySummary(stamp: string): { runId: string; summary: string } {
  const runId = `test-${stamp}-demo`;
  const issues: ConsistencyIssue[] = [
    ...Array.from({ length: 7 }, (_, i) => ({
      type: 'mismatch-missing' as const,
      item: `venues/demo-${i + 1}`,
      detail: 'Missing in per-entity collection',
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      type: 'mismatch-field' as const,
      item: `users/demo-${i + 1}`,
      detail: 'Field mismatch: name',
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      type: 'mismatch-orphan' as const,
      item: `tasks/demo-${i + 1}`,
      detail: 'In per-entity but not in monolith (orphan)',
    })),
  ];
  return { runId, summary: formatConsistencySummary(DEMO_ALERT_PREFIX, runId, issues) };
}

export interface ConsistencyResult {
  ok: boolean;
  monolithVersion: number | null;
  monolithSizeBytes: number | null;
  monolithSizeWarn: boolean;
  backupStale: boolean;
  backupLastAt: string | null;
  status: {
    monolith: { venues: number; users: number; tasks: number };
    perEntity: { venues: number; users: number; tasks: number; usersByEmail: number };
    match: boolean;
    mismatches: Array<{ collection: string; id: string; reason: string }>;
  } | null;
  runId: string;
  issues: ConsistencyIssue[];
  summary: string;
  error?: string;
}

export interface ConsistencyCheckOpts {
  /** Test injection point: replace the real GCS backup-staleness check. */
  checkBackup?: (db: any) => Promise<{ stale: boolean; lastAt: string | null }>;
  /**
   * Internal shared collector, set by handleConsistencyCheck so that a throw
   * mid-run still reports the findings collected so far.
   */
  sink?: { runId: string; issues: ConsistencyIssue[] };
  /**
   * Emission marker shared with the route (single-writer rule): the handler
   * sets runId as soon as it has one and emitted=true immediately after its
   * one summary log call, so the route can tell "no summary was emitted"
   * (route owes the ERROR) from "summary emitted, response failed" (route
   * must never add a second ERROR).
   */
  alert?: { runId?: string; emitted: boolean };
}

/**
 * Check backup staleness by finding the newest SUCCESS.json marker in GCS.
 * Each backup run writes tier1/<date>/<runId>/SUCCESS.json (immutable).
 * Monitoring lists the bucket prefix and takes the newest by path
 * (paths are chronological: tier1/YYYY-MM-DD/<runId>/).
 *
 * Returns { stale, lastAt, unconfigured }. Stale = no successful backup in
 * 26 hours, OR missing/malformed/future timestamp, OR missing BACKUP_BUCKET
 * config (once monitoring is enabled, unconfigured = error, not healthy).
 */
async function checkBackupStaleness(
  firestoreDb: any
): Promise<{ stale: boolean; lastAt: string | null; unconfigured: boolean }> {
  const bucketName = process.env.BACKUP_BUCKET;
  if (!bucketName) {
    // Monitoring is enabled (this code is running) but bucket not configured.
    // That's an error, not a healthy "unknown" — fail closed.
    return { stale: true, lastAt: null, unconfigured: true };
  }
  try {
    const storage = getStorage();
    // List all SUCCESS.json markers. Run IDs are random (not chronological),
    // so download each marker and select by its createdAt timestamp.
    const [files] = await storage.bucket(bucketName).getFiles({ prefix: 'tier1/' });
    const markerNames = files
      .filter((f: any) => f.name.endsWith('/SUCCESS.json'))
      .map((f: any) => f.name);
    if (markerNames.length === 0) {
      return { stale: true, lastAt: null, unconfigured: false };
    }
    let newestTs = -1;
    let newestAt: string | null = null;
    for (const name of markerNames) {
      try {
        const [contents] = await storage.bucket(bucketName).file(name).download();
        const marker = JSON.parse(contents.toString('utf8'));
        const ts = new Date(marker?.createdAt).getTime();
        if (!isNaN(ts) && ts > newestTs) {
          newestTs = ts;
          newestAt = marker.createdAt;
        }
      } catch {
        // Skip unreadable markers
      }
    }
    const lastAt = newestAt;
    if (!lastAt || typeof lastAt !== 'string') {
      return { stale: true, lastAt: null, unconfigured: false };
    }
    const ts = new Date(lastAt).getTime();
    if (isNaN(ts)) {
      return { stale: true, lastAt: null, unconfigured: false }; // Malformed date = stale
    }
    if (ts > Date.now() + 5 * 60 * 1000) {
      return { stale: true, lastAt, unconfigured: false }; // Implausibly future = stale
    }
    const ageMs = Date.now() - ts;
    const stale = ageMs > 26 * 60 * 60 * 1000; // 26 hours
    return { stale, lastAt, unconfigured: false };
  } catch (e: any) {
    // Marker missing or unreadable = stale (fail closed)
    return { stale: true, lastAt: null, unconfigured: false };
  }
}

/**
 * Run the consistency check with version-stable retry.
 *
 * If the monolith version changes during verification (concurrent write),
 * the comparison may be against a moving target — retry up to
 * MAX_CONSISTENCY_RETRIES times. After that, report unstable (not a
 * data mismatch — just couldn't get a clean read).
 *
 * This function NEVER writes an ERROR log line. Findings are collected as
 * issues and each is written at once as an INFO line carrying the run id;
 * the returned `summary` is the formatted line for the caller to emit
 * (handleConsistencyCheck is the single writer).
 */
export async function runConsistencyCheck(
  firestoreDb: any,
  opts: ConsistencyCheckOpts = {}
): Promise<ConsistencyResult> {
  const runId = newConsistencyRunId();
  const issues: ConsistencyIssue[] = opts.sink ? opts.sink.issues : [];
  if (opts.sink) opts.sink.runId = runId;
  const addIssue = (type: ConsistencyIssueType, item: string, detail: string): void => {
    const issue: ConsistencyIssue = {
      type: validIssueType(type),
      item: sanitizeText(item, 48),
      detail: sanitizeText(detail, 80),
    };
    issues.push(issue);
    // Best-effort only: once the issue is in the collector, a failing INFO
    // write must never throw — it could otherwise suppress the run's one
    // ERROR summary (fix round 1). Swallow and continue.
    try {
      log.info(`[consistency] INFO run=${runId} ${issue.type} ${issue.item}: ${issue.detail}`);
    } catch { /* the summary still carries this finding */ }
  };

  // Dynamic import to avoid circular dependencies; works with both .ts (tests)
  // and .js (compiled server) via Node's module resolution.
  let perEntityStatus: any;
  try {
    perEntityStatus = (await import('./migration.js')).perEntityStatus;
  } catch {
    perEntityStatus = (await import('./migration.ts')).perEntityStatus;
  }

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= MAX_CONSISTENCY_RETRIES; attempt++) {
    const versionBefore = await getMonolithVersion(firestoreDb);
    const sizeBytes = await getMonolithSize(firestoreDb);

    // Fail closed: if we can't read the version or size, that's a failure,
    // not a stable null. Never let null === null appear "stable".
    // Attempt-level failures are WARNING lines, not issues (R3).
    if (versionBefore === null) {
      lastError = `Cannot read monolith version (attempt ${attempt})`;
      log.warn(`[consistency] WARNING run=${runId} ${lastError}`);
      continue;
    }
    if (sizeBytes === null) {
      lastError = `Cannot read monolith size (attempt ${attempt})`;
      log.warn(`[consistency] WARNING run=${runId} ${lastError}`);
      continue;
    }

    let status = null;
    try {
      status = await perEntityStatus(firestoreDb);
    } catch (e: any) {
      // Bounded: an unbounded exception message could make this WARNING
      // line multi-line / huge (fix round 1). boundedReason collapses and
      // caps it; the text still lands in result.error via lastError.
      lastError = boundedReason(e);
      log.warn(`[consistency] WARNING run=${runId} perEntityStatus failed (attempt ${attempt}): ${lastError}`);
      continue;
    }
    const versionAfter = await getMonolithVersion(firestoreDb);
    if (versionAfter === null) {
      lastError = `Cannot read monolith version after check (attempt ${attempt})`;
      log.warn(`[consistency] WARNING run=${runId} ${lastError}`);
      continue;
    }

    // Version changed mid-check — retry (not a mismatch, just unstable read)
    if (versionBefore !== versionAfter) {
      lastError = `Monolith version changed during check (v${versionBefore} → v${versionAfter}), retrying`;
      log.warn(`[consistency] WARNING run=${runId} ${lastError}`);
      continue;
    }

    const sizeWarn = sizeBytes >= MONOLITH_SIZE_WARN_BYTES;
    // Findings, in collection order: mismatches, size, backup.
    if (!status.match) {
      // Log IDs + reasons only — perEntityStatus never includes secrets
      for (const m of status.mismatches) {
        addIssue(issueTypeForReason(m.reason), `${m.collection}/${m.id}`, m.reason);
      }
    }
    if (sizeWarn) {
      addIssue(
        'size-warn',
        'monolith',
        `Monolith size ${Math.round(sizeBytes / 1024)} KiB (warn at 800 KiB, hard cap 900 KiB)`
      );
    }
    const backup = opts.checkBackup
      ? { ...(await opts.checkBackup(firestoreDb)), unconfigured: false }
      : await checkBackupStaleness(firestoreDb);
    if (backup.stale) {
      if (backup.unconfigured) {
        addIssue(
          'backup-unconfigured',
          'backup',
          'BACKUP_BUCKET not configured — backup monitoring enabled but no bucket'
        );
      } else {
        addIssue('backup-stale', 'backup', `Last successful backup: ${backup.lastAt || 'never'} (threshold: 26h)`);
      }
    }
    const ok = status.match && !sizeWarn && !backup.stale;
    // migration.ts caps the mismatch list at 20 — at the cap the issue
    // total is a floor, and the summary must say so ("20+ issues").
    const mismatchesCapped = status.mismatches.length >= 20;
    const summary = ok
      ? `[consistency] INFO run=${runId} ok: 0 issues (venues ${status.monolith.venues}, users ${status.monolith.users}, tasks ${status.monolith.tasks}; monolith ${Math.round(sizeBytes / 1024)} KiB; last backup ${backup.lastAt || 'never'})`
      : formatConsistencySummary(CONSISTENCY_ERROR_PREFIX, runId, issues, { capped: mismatchesCapped });

    return {
      ok,
      monolithVersion: versionAfter,
      monolithSizeBytes: sizeBytes,
      monolithSizeWarn: sizeWarn,
      backupStale: backup.stale,
      backupLastAt: backup.lastAt,
      status,
      runId,
      issues,
      summary,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  // All retries failed — this IS the old "Unstable or unreadable" outcome;
  // it is reported as the single 'unreadable' issue, under no other name.
  const finalError = `Unstable or unreadable after ${MAX_CONSISTENCY_RETRIES} attempts. ${lastError || ''}`;
  addIssue('unreadable', 'run', finalError);
  return {
    ok: false,
    monolithVersion: null,
    monolithSizeBytes: null,
    monolithSizeWarn: false,
    backupStale: true,
    backupLastAt: null,
    status: null,
    runId,
    issues,
    summary: formatConsistencySummary(CONSISTENCY_ERROR_PREFIX, runId, issues),
    error: finalError,
  };
}

/**
 * The single writer of the run's summary line (R1). Runs the check, then —
 * after the try/catch, at exactly one call site — emits the one ERROR line
 * (issues found, or a throw that adds a 'check-error' issue) or the INFO
 * ok line (clean run). A throw after ≥1 finding still yields exactly one
 * "[consistency] ERROR" line and a 500 body.
 */
export async function handleConsistencyCheck(
  firestoreDb: any,
  opts: ConsistencyCheckOpts = {}
): Promise<{ httpStatus: number; body: ConsistencyResult | Record<string, unknown> }> {
  const sink: { runId: string; issues: ConsistencyIssue[] } = { runId: '', issues: [] };
  let httpStatus: number;
  let body: ConsistencyResult | Record<string, unknown>;
  let line: string;
  let isError: boolean;
  try {
    const result = await runConsistencyCheck(firestoreDb, { ...opts, sink });
    httpStatus = result.ok ? 200 : 500;
    body = result;
    line = result.summary;
    isError = result.issues.length > 0;
    if (opts.alert) opts.alert.runId = result.runId;
  } catch (e: any) {
    const runId = sink.runId || newConsistencyRunId();
    const detail = boundedReason(e);
    const issue: ConsistencyIssue = { type: 'check-error', item: 'run', detail };
    // Best-effort only (fix round 1): this INFO write must never throw on
    // the way to the one ERROR emit below.
    try {
      log.info(`[consistency] INFO run=${runId} ${issue.type} ${issue.item}: ${issue.detail}`);
    } catch { /* the summary still carries this finding */ }
    const allIssues = [...sink.issues, issue];
    line = formatConsistencySummary(CONSISTENCY_ERROR_PREFIX, runId, allIssues);
    httpStatus = 500;
    body = { ok: false, runId, issues: allIssues, summary: line, error: detail };
    isError = true;
    if (opts.alert) opts.alert.runId = runId;
  }
  // Exactly one emit site for the whole run.
  if (isError) log.error(line);
  else log.info(line);
  if (opts.alert) opts.alert.emitted = true;
  return { httpStatus, body };
}
