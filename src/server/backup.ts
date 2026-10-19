/**
 * Stage 4 PR B — Tier 1 backup (sanitized export).
 *
 * Reads ALL recoverable data from the named Firestore database directly
 * (not via HTTP), scrubs secrets recursively, writes a manifest + data
 * to the private backup bucket.
 *
 * Runs as a dedicated Cloud Run Job with its own service account:
 * - Firestore: datastore.viewer (read-only, database-conditioned) on the
 *   named database ONLY. NO writes to Firestore — the job is read-only.
 * - Storage: storage.objectCreator on the backup bucket ONLY (no overwrite).
 *
 * Backup-success is tracked via a GCS marker file (not Firestore), so the
 * backup identity stays genuinely read-only. Monitoring reads the marker
 * through its own identity.
 *
 * Tier 1 captures: monolith app-state/main (all fields), every per-entity
 * collection (tasks, venues, users, usersByEmail, media), and media metadata.
 * Media BYTES are NOT copied (they live in GCS; the 30-day retention is
 * enforced by the sweeper, not by backup retention).
 */

import { log } from './log.ts';
import crypto from 'crypto';

const FIRESTORE_STATE_DOC = 'app-state/main';

// Collections to back up (in addition to the monolith doc).
// This list must be updated when new per-entity collections are added.
const PER_ENTITY_COLLECTIONS = [
  'tasks',
  'venues',
  'users',
  'usersByEmail',
  'media',
];

// Field names that are always scrubbed (case-insensitive exact match).
// Explicit list to avoid false positives (apiKeyLabel) and false negatives
// (accessToken, privateKey). Compound names like "userPassword" are caught
// by checking camelCase boundaries.
const SECRET_WORDS = [
  'password',
  'kioskpin',
  'jwtsecret',
  'vapid',
  'pepper',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'secret',
  'token',
];

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  // Hash-suffixed secret names: "passwordHash" → stem "password" is secret,
  // "kioskPinHash" → stem "kioskPin" is secret. (Forward defence: PR 2a's PIN
  // hashing introduces kioskPinHash; without this, backups would leak it.)
  if (/hash$/i.test(key) && key.length > 4 && isSecretKey(key.slice(0, -4))) return true;
  // Exact match (ignoring _ and -)
  const normalized = lower.replace(/[_-]/g, '');
  if (SECRET_WORDS.includes(normalized)) return true;
  // CamelCase compound: e.g. "userPassword" → "Password" starts with uppercase P
  // Check if key ends with a secret word whose first letter is uppercase
  for (const word of SECRET_WORDS) {
    if (lower.endsWith(word) && lower.length > word.length) {
      const idx = key.length - word.length;
      const firstChar = key[idx];
      // Uppercase first letter = camelCase boundary (userPassword, accessToken)
      if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Recursively scrub secrets from an object. Returns a deep copy with
 * secret values replaced by "[REDACTED]". Arrays and nested objects
 * are handled. Non-object values pass through.
 *
 * In addition to field-name matching, explicitly handles known sensitive
 * paths:
 * - pushSubscriptions[].keys.auth (Web Push auth secret)
 * - passwordResets[].code (legacy plaintext reset codes)
 * - passwordResets[].codeHash (hash — still sensitive, scrub for safety)
 */
export function scrubSecrets(obj: any, path: string = ''): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((v, i) => scrubSecrets(v, `${path}[${i}]`));
  if (typeof obj !== 'object') return obj;

  // Explicit path-based scrubbing for known sensitive nested fields
  if (path.endsWith('pushSubscriptions') || /pushSubscriptions\[\d+\]$/.test(path)) {
    // Inside a push subscription: scrub keys.auth
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'keys' && v && typeof v === 'object') {
        out[k] = { ...(v as object), auth: '[REDACTED]' };
      } else if (isSecretKey(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = scrubSecrets(v, path ? `${path}.${k}` : k);
      }
    }
    return out;
  }
  if (/passwordResets\[\d+\]$/.test(path)) {
    // Inside a password reset record: scrub code and codeHash
    const out: any = { ...(obj as object) };
    if ('code' in out) out.code = '[REDACTED]';
    if ('codeHash' in out) out.codeHash = '[REDACTED]';
    for (const [k, v] of Object.entries(out)) {
      if (k !== 'code' && k !== 'codeHash') {
        out[k] = isSecretKey(k) ? '[REDACTED]' : scrubSecrets(v, path ? `${path}.${k}` : k);
      }
    }
    return out;
  }

  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSecretKey(k)) {
      out[k] = '[REDACTED]';
    } else if (k === 'keys' && v && typeof v === 'object' && !Array.isArray(v)) {
      // Web Push-style key bundles ({ p256dh, auth }) carry an `auth` secret
      // wherever they appear in the tree — scrub it at any nesting depth,
      // not only under pushSubscriptions.
      const keysOut: any = {};
      for (const [kk, vv] of Object.entries(v)) {
        keysOut[kk] = kk === 'auth' ? '[REDACTED]' : scrubSecrets(vv, path ? `${path}.${k}.${kk}` : `${k}.${kk}`);
      }
      out[k] = keysOut;
    } else {
      out[k] = scrubSecrets(v, path ? `${path}.${k}` : k);
    }
  }
  return out;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  databaseId: string;
  tier: 'tier1';
  collections: Record<string, number>; // collection name -> doc count
  monolithPresent: boolean;
  monolithVersion: number;
  checksum: string; // SHA-256 of the canonical JSON payload
  secretsScrubbed: boolean;
}

/**
 * Run a Tier 1 backup.
 *
 * @param firestoreDb - Firestore instance for the NAMED database (read-only).
 * @param storage - Storage instance.
 * @param backupBucket - GCS bucket name (private, uniform access).
 * @param databaseId - Named database ID (for manifest).
 * @returns Manifest of the completed backup.
 *
 * Each execution writes to a unique path: tier1/<date>/<runId>/
 * (storage.objectCreator cannot overwrite, so unique paths enable retries).
 *
 * Requires the monolith to exist with a valid numeric _v. Captures the
 * version before and after reading collections; if it changed, retries
 * (a backup across concurrent commits is not a consistent snapshot).
 */
export async function runTier1Backup(
  firestoreDb: any,
  storage: any,
  backupBucket: string,
  databaseId: string
): Promise<BackupManifest> {
  const runId = crypto.randomBytes(8).toString('hex');
  const createdAt = new Date().toISOString();
  const dateStr = createdAt.slice(0, 10); // YYYY-MM-DD
  const basePath = `tier1/${dateStr}/${runId}`;

  const MAX_ATTEMPTS = 3;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 1. Read monolith + capture version BEFORE
    const monolithSnapBefore = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
    if (!monolithSnapBefore.exists) {
      throw new Error('[backup] Monolith app-state/main does not exist — refusing to back up empty state.');
    }
    const monolithData = monolithSnapBefore.data();
    const versionBefore = monolithData?._v;
    if (typeof versionBefore !== 'number') {
      throw new Error(`[backup] Monolith _v is not a valid number (got ${typeof versionBefore}) — refusing.`);
    }

    // 2. Read all per-entity collections
    const collections: Record<string, any[]> = {};
    const counts: Record<string, number> = {};
    for (const collName of PER_ENTITY_COLLECTIONS) {
      const snap = await firestoreDb.collection(collName).get();
      collections[collName] = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      counts[collName] = snap.size;
    }

    // 3. Verify version AFTER (consistent snapshot check)
    const monolithSnapAfter = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
    const versionAfter = monolithSnapAfter.data()?._v;
    if (versionBefore !== versionAfter) {
      lastError = `Monolith version changed during backup (v${versionBefore} → v${versionAfter}), retrying`;
      log.warn(`[backup] ${lastError} (attempt ${attempt})`);
      continue;
    }

    // 4. Scrub secrets recursively
    const scrubbedMonolith = scrubSecrets(monolithData);
    const scrubbedCollections: Record<string, any[]> = {};
    for (const [name, docs] of Object.entries(collections)) {
      scrubbedCollections[name] = docs.map(d => scrubSecrets(d));
    }

    // 5. Assemble payload + manifest
    const payload = {
      monolith: scrubbedMonolith,
      collections: scrubbedCollections,
    };
    const payloadJson = JSON.stringify(payload);
    const checksum = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');

    const manifest: BackupManifest = {
      version: 1,
      createdAt,
      databaseId,
      tier: 'tier1',
      collections: counts,
      monolithPresent: true,
      monolithVersion: versionAfter,
      checksum,
      secretsScrubbed: true,
    };

    // 6. Write to GCS with unique paths (Google-managed encryption; NOT .enc)
    //    Every file is immutable — storage.objectCreator cannot overwrite,
    //    so unique paths per execution enable retries.
    const bucket = storage.bucket(backupBucket);
    const dataPath = `${basePath}/backup.json`;
    const manifestPath = `${basePath}/manifest.json`;
    // Success marker is ALSO unique per run (not a fixed latest-success.json,
    // which would fail on overwrite). Monitoring lists tier1/ to find newest.
    const markerPath = `${basePath}/SUCCESS.json`;
    await bucket.file(dataPath).save(payloadJson, { contentType: 'application/json' });
    await bucket.file(manifestPath).save(JSON.stringify(manifest, null, 2), {
      contentType: 'application/json',
    });
    await bucket.file(markerPath).save(JSON.stringify({
      createdAt,
      runId,
      manifestPath: `gs://${backupBucket}/${manifestPath}`,
      dataPath: `gs://${backupBucket}/${dataPath}`,
      checksum,
      monolithVersion: versionAfter,
    }), { contentType: 'application/json' });

    console.log(`[backup] Tier 1 complete: ${basePath}, v${versionAfter}, checksum ${checksum.slice(0, 12)}..., ${Object.values(counts).reduce((a, b) => a + b, 0)} docs`);
    return manifest;
  }

  throw new Error(`[backup] Failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
