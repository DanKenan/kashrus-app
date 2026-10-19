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
 */

import { log } from './log.ts';
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
  error?: string;
}

/**
 * Check backup staleness by finding the newest SUCCESS.json marker in GCS.
 * Each backup run writes tier1/<date>/<runId>/SUCCESS.json (immutable).
 * Monitoring lists the bucket prefix and takes the newest by path
 * (paths are chronological: tier1/YYYY-MM-DD/<runId>/).
 *
 * Returns { stale, lastAt }. Stale = no successful backup in 26 hours,
 * OR missing/malformed/future timestamp, OR missing BACKUP_BUCKET config
 * (once monitoring is enabled, unconfigured = error, not healthy).
 */
async function checkBackupStaleness(firestoreDb: any): Promise<{ stale: boolean; lastAt: string | null }> {
  const bucketName = process.env.BACKUP_BUCKET;
  if (!bucketName) {
    // Monitoring is enabled (this code is running) but bucket not configured.
    // That's an error, not a healthy "unknown" — fail closed.
    log.error('[consistency] ERROR: BACKUP_BUCKET not configured — backup monitoring enabled but no bucket. Stale.');
    return { stale: true, lastAt: null };
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
      return { stale: true, lastAt: null };
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
      return { stale: true, lastAt: null };
    }
    const ts = new Date(lastAt).getTime();
    if (isNaN(ts)) {
      return { stale: true, lastAt: null }; // Malformed date = stale
    }
    if (ts > Date.now() + 5 * 60 * 1000) {
      return { stale: true, lastAt }; // Implausibly future = stale
    }
    const ageMs = Date.now() - ts;
    const stale = ageMs > 26 * 60 * 60 * 1000; // 26 hours
    return { stale, lastAt };
  } catch (e: any) {
    // Marker missing or unreadable = stale (fail closed)
    return { stale: true, lastAt: null };
  }
}

/**
 * Run the consistency check with version-stable retry.
 *
 * If the monolith version changes during verification (concurrent write),
 * the comparison may be against a moving target — retry up to
 * MAX_CONSISTENCY_RETRIES times. After that, report unstable (not a
 * data mismatch — just couldn't get a clean read).
 */
export async function runConsistencyCheck(firestoreDb: any): Promise<ConsistencyResult> {
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
    if (versionBefore === null) {
      lastError = `Cannot read monolith version (attempt ${attempt})`;
      log.error(`[consistency] ERROR: ${lastError}`);
      continue;
    }
    if (sizeBytes === null) {
      lastError = `Cannot read monolith size (attempt ${attempt})`;
      log.error(`[consistency] ERROR: ${lastError}`);
      continue;
    }

    let status = null;
    try {
      status = await perEntityStatus(firestoreDb);
    } catch (e: any) {
      lastError = e?.message || 'perEntityStatus failed';
      log.error(`[consistency] ERROR: perEntityStatus failed (attempt ${attempt}): ${lastError}`);
      continue;
    }
    const versionAfter = await getMonolithVersion(firestoreDb);
    if (versionAfter === null) {
      lastError = `Cannot read monolith version after check (attempt ${attempt})`;
      log.error(`[consistency] ERROR: ${lastError}`);
      continue;
    }

    // Version changed mid-check — retry (not a mismatch, just unstable read)
    if (versionBefore !== versionAfter) {
      lastError = `Monolith version changed during check (v${versionBefore} → v${versionAfter}), retrying`;
      log.error(`[consistency] WARNING: ${lastError}`);
      continue;
    }

    const sizeWarn = sizeBytes >= MONOLITH_SIZE_WARN_BYTES;
    const backup = await checkBackupStaleness(firestoreDb);
    if (backup.stale) {
      log.error(
        `[consistency] ERROR: BACKUP STALE — last successful backup: ${backup.lastAt || 'never'} ` +
        `(threshold: 26h)`
      );
    }
    const ok = status.match && !sizeWarn && !backup.stale;

    if (!status.match) {
      // Log IDs + reasons only — perEntityStatus never includes secrets
      log.error(
        `[consistency] ERROR: MISMATCH detected (attempt ${attempt}):`,
        JSON.stringify(status.mismatches.map(m => `${m.collection}/${m.id}: ${m.reason}`))
      );
    }
    if (sizeWarn) {
      log.error(
        `[consistency] ERROR: MONOLITH SIZE WARNING: ${Math.round(sizeBytes / 1024)} KiB ` +
        `(warn at 800 KiB, hard cap 900 KiB)`
      );
    }

    return {
      ok,
      monolithVersion: versionAfter,
      monolithSizeBytes: sizeBytes,
      monolithSizeWarn: sizeWarn,
      backupStale: backup.stale,
      backupLastAt: backup.lastAt,
      status,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  // All retries failed — emit ERROR and report failure
  const finalError = `Unstable or unreadable after ${MAX_CONSISTENCY_RETRIES} attempts. ${lastError || ''}`;
  log.error(`[consistency] ERROR: ${finalError}`);
  return {
    ok: false,
    monolithVersion: null,
    monolithSizeBytes: null,
    monolithSizeWarn: false,
    backupStale: true,
    backupLastAt: null,
    status: null,
    error: finalError,
  };
}
