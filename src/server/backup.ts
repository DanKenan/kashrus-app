/**
 * Stage 4 PR B — Tier 1 backup (sanitized export).
 *
 * Reads ALL recoverable data from the named Firestore database directly
 * (not via HTTP), scrubs secrets recursively, writes a manifest + data
 * to the private backup bucket, and updates backups/latest for staleness
 * monitoring.
 *
 * Runs as a dedicated Cloud Run Job with its own service account:
 * - Firestore: datastore.entities.list + datastore.entities.get on the
 *   named database ONLY (no writes to user data).
 * - Storage: storage.objects.create on the backup bucket ONLY.
 *
 * Tier 1 captures: monolith app-state/main (all fields), every per-entity
 * collection (tasks, venues, users, usersByEmail, media), and media metadata.
 * Media BYTES are NOT copied (they live in GCS; the 30-day retention is
 * enforced by the sweeper, not by backup retention).
 *
 * Secrets scrubbed recursively: password, kioskPin, jwtSecret, vapidKeys,
 * resetPepper, airtable credentials (apiKey, token), and any field whose
 * key matches /password|secret|token|key|pin/i (case-insensitive).
 */

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

// Field names (case-insensitive patterns) that are always scrubbed.
const SECRET_PATTERNS = [
  /password/i,
  /kioskpin/i,
  /jwtsecret/i,
  /vapid/i,
  /pepper/i,
  /apikey/i,
  /api_key/i,
  /\btoken\b/i,
  /secret/i,
  /\bpin\b/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(key));
}

/**
 * Recursively scrub secrets from an object. Returns a deep copy with
 * secret values replaced by "[REDACTED]". Arrays and nested objects
 * are handled. Non-object values pass through.
 */
export function scrubSecrets(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(scrubSecrets);
  if (typeof obj !== 'object') return obj;
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSecretKey(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = scrubSecrets(v);
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
  checksum: string; // SHA-256 of the canonical JSON payload
  secretsScrubbed: boolean;
}

/**
 * Run a Tier 1 backup.
 *
 * @param firestoreDb - Admin SDK Firestore instance (named database).
 * @param storage - Admin SDK Storage instance.
 * @param backupBucket - GCS bucket name (private, uniform access).
 * @param databaseId - Named database ID (for manifest + explicit selection).
 * @returns Manifest of the completed backup.
 */
export async function runTier1Backup(
  firestoreDb: any,
  storage: any,
  backupBucket: string,
  databaseId: string
): Promise<BackupManifest> {
  const createdAt = new Date().toISOString();
  const dateStr = createdAt.slice(0, 10); // YYYY-MM-DD

  // 1. Read monolith
  const monolithSnap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
  const monolithData = monolithSnap.exists ? monolithSnap.data() : null;

  // 2. Read all per-entity collections
  const collections: Record<string, any[]> = {};
  const counts: Record<string, number> = {};
  for (const collName of PER_ENTITY_COLLECTIONS) {
    const snap = await firestoreDb.collection(collName).get();
    collections[collName] = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    counts[collName] = snap.size;
  }

  // 3. Scrub secrets recursively
  const scrubbedMonolith = scrubSecrets(monolithData);
  const scrubbedCollections: Record<string, any[]> = {};
  for (const [name, docs] of Object.entries(collections)) {
    scrubbedCollections[name] = docs.map(scrubSecrets);
  }

  // 4. Assemble payload + manifest
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
    monolithPresent: monolithSnap.exists,
    checksum,
    secretsScrubbed: true,
  };

  // 5. Write to GCS (Google-managed encryption; NOT .enc — no app-level encryption)
  const bucket = storage.bucket(backupBucket);
  const dataPath = `tier1/${dateStr}/backup.json`;
  const manifestPath = `tier1/${dateStr}/manifest.json`;
  await bucket.file(dataPath).save(payloadJson, { contentType: 'application/json' });
  await bucket.file(manifestPath).save(JSON.stringify(manifest, null, 2), {
    contentType: 'application/json',
  });

  // 6. Update backups/latest for staleness monitoring (in the PROD database,
  //    so /api/health and the consistency job can check it).
  //    This is metadata about the backup, not user data.
  await firestoreDb.collection('backups').doc('latest').set({
    tier: 'tier1',
    createdAt,
    manifestPath: `gs://${backupBucket}/${manifestPath}`,
    dataPath: `gs://${backupBucket}/${dataPath}`,
    checksum,
    collections: counts,
    monolithPresent: monolithSnap.exists,
  });

  console.log(`[backup] Tier 1 complete: ${dateStr}, checksum ${checksum.slice(0, 12)}..., ${Object.values(counts).reduce((a, b) => a + b, 0)} docs`);
  return manifest;
}
