/**
 * Stage 4 PR R — Tier 1 restore tool (throwaway databases ONLY).
 *
 * Usage:
 *   node dist/restore-backup.cjs \
 *     --source gs://<bucket>/tier1/<date>/<run>/ \
 *     --target-db <throwaway-id> \
 *     --confirm
 *
 * Without --confirm: runs ALL safety checks and validations (target naming,
 * emptiness, manifest format, checksum) but writes nothing. This is a
 * validated dry run — if it passes, --confirm will proceed to writes.
 *
 * With --confirm, the order is:
 * 1. Target safety: project match, not production DB, not (default),
 *    matches throwaway naming rule (must start with "restore-drill-").
 * 2. Target emptiness: enumerates ALL root collections via listCollections()
 *    (not just the known five) and refuses if any document exists anywhere.
 *    Fails closed on any read error.
 * 3. Downloads manifest.json + backup.json; validates manifest schema
 *    (version, databaseId = production, secretsScrubbed, checksum present)
 *    and payload structure (unique valid doc IDs, collection counts match
 *    manifest) BEFORE the first write.
 * 4. Verifies SHA-256 checksum of backup.json against the manifest.
 * 5. Writes records in batches.
 * 6. Independently re-queries Firestore: verifies actual destination counts
 *    per collection and spot-checks representative records. Queued-write
 *    counts are NOT treated as verification.
 * 7. Prints per-collection counts; non-zero exit on ANY mismatch, refusal,
 *    or error. A partial restore (error after some batches committed) is
 *    reported as FAILED — retry into a NEW empty throwaway DB, never
 *    auto-erase the partial result.
 *
 * The restored data is the SCRUBBED backup (secrets are [REDACTED]).
 *
 * IAM for Don's drill (dedicated database-scoped identity preferred):
 * - Firestore on the throwaway DB only: datastore.entities.get,
 *   datastore.entities.list, datastore.entities.create, datastore.entities.update
 *   (reads for emptiness/verification, list for collection enumeration,
 *   create+update because batch.set() has no existence precondition)
 * - Storage: storage.objects.get on the backup bucket
 * Do NOT run with broad production-write credentials.
 *
 * Build: esbuild src/server/restore-backup.ts --bundle --platform=node \
 *   --format=cjs --packages=external --outfile=dist/restore-backup.cjs
 */

import { log } from './log.ts';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as crypto from 'crypto';

// Production identifiers — restore REFUSES these targets, and the manifest's
// databaseId must match PROD_DATABASE_ID (backups come from production).
const PROD_PROJECT_ID = 'gen-lang-client-0875538181';
const PROD_DATABASE_ID = 'ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d';

// Throwaway databases must follow this naming rule.
const THROWAWAY_PREFIX = 'restore-drill-';

const FIRESTORE_STATE_DOC = 'app-state/main';
const EXPECTED_MANIFEST_VERSION = 1;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') {
      out.confirm = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) {
        throw new Error(`Missing value for ${a}`);
      }
      out[key] = val;
      i++;
    }
  }
  return out;
}

function parseGsUrl(url: string): { bucket: string; prefix: string } {
  const m = url.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`Invalid GCS URL: ${url} (expected gs://bucket/prefix/)`);
  let prefix = m[2];
  if (!prefix.endsWith('/')) prefix += '/';
  return { bucket: m[1], prefix };
}

/**
 * Check the target is truly empty: reject if listCollections() returns ANY
 * collection. A newly created throwaway DB has zero collections; any
 * collection present (even an "empty" one, which may hide orphaned
 * subcollections beneath missing parent docs) means refuse.
 * Fails closed: any read error => refuse.
 */
async function assertTargetEmpty(db: any): Promise<void> {
  let collections: any[];
  try {
    collections = await db.listCollections();
  } catch (e: any) {
    throw new Error(`[restore] REFUSING: cannot enumerate target collections (${e?.message}). Fail closed.`);
  }
  if (collections.length > 0) {
    const names = collections.map((c: any) => c.id || String(c));
    throw new Error(`[restore] REFUSING: target has collections (${names.join(', ')}). Use a newly created, empty throwaway DB.`);
  }
  // Also check app-state/main explicitly (single doc, not a collection)
  try {
    const mainSnap = await db.doc(FIRESTORE_STATE_DOC).get();
    if (mainSnap.exists) {
      throw new Error(`[restore] REFUSING: target has ${FIRESTORE_STATE_DOC}. Use a newly created, empty throwaway DB.`);
    }
  } catch (e: any) {
    if (e.message.includes('REFUSING')) throw e;
    throw new Error(`[restore] REFUSING: cannot read ${FIRESTORE_STATE_DOC} (${e?.message}). Fail closed.`);
  }
}

// The complete Tier 1 schema: exactly one of these two collection sets, no
// more, no fewer. Item 8b added the identity projections (people, emails);
// a backup taken before 8b is the legacy 5-collection set and is still
// accepted. Anything else is refused.
const TIER1_COLLECTIONS_LEGACY = ['tasks', 'venues', 'users', 'usersByEmail', 'media'];
const IDENTITY_COLLECTIONS = ['people', 'emails'];
const TIER1_COLLECTIONS_V2 = [...TIER1_COLLECTIONS_LEGACY, ...IDENTITY_COLLECTIONS];

/**
 * The schema a manifest claims: the 7-collection set when it names any
 * identity collection, else the legacy 5-collection set. The exact-match
 * checks below then refuse anything that is not exactly that set.
 */
export function tier1SchemaFor(manifestCollections: Record<string, unknown>): string[] {
  const names = Object.keys(manifestCollections || {});
  return names.some((n) => IDENTITY_COLLECTIONS.includes(n)) ? TIER1_COLLECTIONS_V2 : TIER1_COLLECTIONS_LEGACY;
}

/** True when the restore carries no identity projections (legacy 5-set). */
export function isLegacyTier1(manifestCollections: Record<string, unknown>): boolean {
  return tier1SchemaFor(manifestCollections) === TIER1_COLLECTIONS_LEGACY;
}

// Firestore document IDs: 1-1500 chars, no forward slashes.
function isValidDocId(id: any): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 1500 && !id.includes('/');
}

/**
 * Validate manifest schema and payload structure BEFORE any write.
 * Requires the COMPLETE Tier 1 schema: tier='tier1', monolithPresent=true,
 * exactly the 7-collection set or the legacy 5-collection set (item 8b),
 * with non-negative integer counts,
 * valid Firestore document IDs, no unexpected collections.
 * Throws on any problem. Returns the parsed payload.
 */
function validateManifestAndPayload(manifest: any, dataJson: string): any {
  // Manifest schema
  if (manifest.version !== EXPECTED_MANIFEST_VERSION) {
    throw new Error(`[restore] Bad manifest version: ${manifest.version} (expected ${EXPECTED_MANIFEST_VERSION})`);
  }
  if (manifest.tier !== 'tier1') {
    throw new Error(`[restore] Bad manifest tier: ${manifest.tier} (expected 'tier1')`);
  }
  if (manifest.databaseId !== PROD_DATABASE_ID) {
    throw new Error(`[restore] Manifest databaseId ${manifest.databaseId} != production ${PROD_DATABASE_ID}. Wrong source.`);
  }
  if (manifest.secretsScrubbed !== true) {
    throw new Error('[restore] Manifest does not confirm secretsScrubbed. Refusing.');
  }
  if (manifest.monolithPresent !== true) {
    throw new Error('[restore] Manifest monolithPresent is not true. Refusing incomplete backup.');
  }
  if (!manifest.checksum || typeof manifest.checksum !== 'string') {
    throw new Error('[restore] Manifest missing checksum.');
  }
  if (!manifest.collections || typeof manifest.collections !== 'object') {
    throw new Error('[restore] Manifest missing collections map.');
  }

  // Complete schema: exactly the 7-set or exactly the legacy 5-set
  const TIER1_COLLECTIONS = tier1SchemaFor(manifest.collections);
  const manifestColls = Object.keys(manifest.collections).sort();
  const expectedColls = [...TIER1_COLLECTIONS].sort();
  const missing = expectedColls.filter(c => !manifestColls.includes(c));
  const unexpected = manifestColls.filter(c => !expectedColls.includes(c));
  if (missing.length > 0) {
    throw new Error(`[restore] Manifest missing collections: ${missing.join(', ')}. Incomplete Tier 1 schema.`);
  }
  if (unexpected.length > 0) {
    throw new Error(`[restore] Manifest has unexpected collections: ${unexpected.join(', ')}. Refusing.`);
  }
  for (const [name, count] of Object.entries(manifest.collections)) {
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new Error(`[restore] Manifest collection ${name} has invalid count: ${count} (must be non-negative integer).`);
    }
  }

  // Checksum
  const actualChecksum = crypto.createHash('sha256').update(dataJson, 'utf8').digest('hex');
  if (actualChecksum !== manifest.checksum) {
    throw new Error(`[restore] CHECKSUM MISMATCH: manifest ${manifest.checksum}, actual ${actualChecksum}.`);
  }

  // Payload structure
  let payload: any;
  try {
    payload = JSON.parse(dataJson);
  } catch {
    throw new Error('[restore] backup.json is not valid JSON.');
  }
  if (!payload.monolith) {
    throw new Error('[restore] Payload missing monolith.');
  }
  if (!payload.collections || typeof payload.collections !== 'object') {
    throw new Error('[restore] Payload missing collections.');
  }

  // Payload collections must match manifest exactly (no missing/unexpected)
  const payloadColls = Object.keys(payload.collections).sort();
  const pMissing = expectedColls.filter(c => !payloadColls.includes(c));
  const pUnexpected = payloadColls.filter(c => !expectedColls.includes(c));
  if (pMissing.length > 0) throw new Error(`[restore] Payload missing collections: ${pMissing.join(', ')}.`);
  if (pUnexpected.length > 0) throw new Error(`[restore] Payload has unexpected collections: ${pUnexpected.join(', ')}.`);

  // Collection counts + unique VALID doc IDs
  const seenIds = new Set<string>();
  for (const collName of TIER1_COLLECTIONS) {
    const expectedCount = manifest.collections[collName];
    const docs = payload.collections[collName];
    if (!Array.isArray(docs)) {
      throw new Error(`[restore] Payload ${collName} is not an array.`);
    }
    if (docs.length !== expectedCount) {
      throw new Error(`[restore] Payload ${collName} has ${docs.length} docs, manifest says ${expectedCount}.`);
    }
    for (const doc of docs) {
      if (!isValidDocId(doc.id)) {
        throw new Error(`[restore] Document in ${collName} has invalid Firestore ID: ${JSON.stringify(doc.id)}.`);
      }
      const key = `${collName}/${doc.id}`;
      if (seenIds.has(key)) {
        throw new Error(`[restore] Duplicate document id: ${key}.`);
      }
      seenIds.add(key);
    }
  }

  return payload;
}

/**
 * Independently verify the restore by re-querying Firestore.
 * Compares actual counts AND representative field values (not just existence).
 * Returns per-collection actual counts. Throws on mismatch.
 */
async function verifyRestore(db: any, manifest: any, payload: any): Promise<Record<string, number>> {
  const actual: Record<string, number> = {};

  // Monolith: existence + _v + spot-check a field value
  const mainSnap = await db.doc(FIRESTORE_STATE_DOC).get();
  actual['app-state/main'] = mainSnap.exists ? 1 : 0;
  if (!mainSnap.exists) {
    throw new Error('[restore] VERIFY FAILED: app-state/main missing after restore');
  }
  const restoredMain = mainSnap.data();
  if (restoredMain?._v !== payload.monolith._v) {
    throw new Error(`[restore] VERIFY FAILED: monolith _v ${restoredMain?._v} != payload ${payload.monolith._v}`);
  }
  // Spot-check a nested field value (not just the version)
  const payloadVenueName = payload.monolith.venues?.[0]?.name;
  const restoredVenueName = restoredMain?.venues?.[0]?.name;
  if (payloadVenueName !== undefined && restoredVenueName !== payloadVenueName) {
    throw new Error(`[restore] VERIFY FAILED: monolith venues[0].name "${restoredVenueName}" != payload "${payloadVenueName}"`);
  }

  // Per-entity collections: count + spot-check field values of first doc
  for (const collName of tier1SchemaFor(manifest.collections)) {
    const snap = await db.collection(collName).get();
    actual[collName] = snap.size;
    const expected = manifest.collections[collName];
    if (actual[collName] !== expected) {
      throw new Error(`[restore] VERIFY FAILED: ${collName} has ${actual[collName]} docs, expected ${expected}`);
    }
    const payloadDocs = payload.collections?.[collName] || [];
    if (payloadDocs.length > 0) {
      const first = payloadDocs[0];
      const docSnap = await db.collection(collName).doc(first.id).get();
      if (!docSnap.exists) {
        throw new Error(`[restore] VERIFY FAILED: ${collName}/${first.id} missing after restore`);
      }
      // Compare actual field values, not just existence
      const restored = docSnap.data();
      for (const [k, v] of Object.entries(first)) {
        if (k === 'id') continue;
        const rv = restored?.[k];
        if (JSON.stringify(rv) !== JSON.stringify(v)) {
          throw new Error(`[restore] VERIFY FAILED: ${collName}/${first.id}.${k} = ${JSON.stringify(rv)} != payload ${JSON.stringify(v)}`);
        }
      }
    }
  }

  return actual;
}

export async function runRestore(opts: {
  source: string;
  targetDb: string;
  projectId: string;
  confirm: boolean;
  firestoreDb: any;
  storage: any;
}): Promise<{ counts: Record<string, number>; identityProjections?: 'absent' | 'restored' }> {
  const { source, targetDb, projectId, confirm, firestoreDb, storage } = opts;

  // 1. Target safety checks (run in dry-run too — this is a validated dry run)
  if (projectId !== PROD_PROJECT_ID) {
    throw new Error(`[restore] REFUSING: project ${projectId} != ${PROD_PROJECT_ID}`);
  }
  if (targetDb === PROD_DATABASE_ID) {
    throw new Error('[restore] REFUSING: target is the PRODUCTION database.');
  }
  if (targetDb === '(default)') {
    throw new Error('[restore] REFUSING: target is (default).');
  }
  if (!targetDb.startsWith(THROWAWAY_PREFIX)) {
    throw new Error(`[restore] REFUSING: target "${targetDb}" must start with "${THROWAWAY_PREFIX}".`);
  }

  // 2. Target must be completely empty (all collections enumerated)
  await assertTargetEmpty(firestoreDb);
  console.log('[restore] Target is empty (all collections checked).');

  // 3. Download + validate manifest/payload BEFORE any write
  const { bucket, prefix } = parseGsUrl(source);
  console.log(`[restore] Downloading from gs://${bucket}/${prefix} ...`);
  const [manifestRaw] = await storage.bucket(bucket).file(`${prefix}manifest.json`).download();
  const [dataRaw] = await storage.bucket(bucket).file(`${prefix}backup.json`).download();
  const manifest = JSON.parse(manifestRaw.toString('utf8'));
  const payload = validateManifestAndPayload(manifest, dataRaw.toString('utf8'));
  console.log('[restore] Manifest + payload validated, checksum OK.');
  const legacy = isLegacyTier1(manifest.collections);
  console.log(`[restore] Schema: ${legacy ? 'legacy 5-collection set' : '7-collection set (with identity projections)'}.`);
  if (legacy) console.log('[restore] NOTE: identity projections not restored (legacy 5-collection backup); rebuild them with the identity repair command.');

  if (!confirm) {
    console.log('[restore] Validated dry run complete (no --confirm, nothing written).');
    console.log(`  source: ${source}`);
    console.log(`  target: ${targetDb} (project ${projectId})`);
    console.log(`  would restore: ${Object.entries(manifest.collections || {}).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    return { counts: {} };
  }

  // 4. Write records in batches
  const BATCH_SIZE = 400;
  let batch = firestoreDb.batch();
  let batchCount = 0;
  let batchesCommitted = 0;
  const commitIfFull = async () => {
    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      batchesCommitted++;
      batch = firestoreDb.batch();
      batchCount = 0;
    }
  };

  try {
    if (payload.monolith) {
      batch.set(firestoreDb.doc(FIRESTORE_STATE_DOC), payload.monolith);
      batchCount++;
    }
    for (const collName of tier1SchemaFor(manifest.collections)) {
      const docs = payload.collections?.[collName] || [];
      for (const doc of docs) {
        const { id, ...data } = doc;
        batch.set(firestoreDb.collection(collName).doc(id), data);
        batchCount++;
        await commitIfFull();
      }
    }
    if (batchCount > 0) {
      await batch.commit();
      batchesCommitted++;
    }
  } catch (e: any) {
    throw new Error(
      `[restore] FAILED after ${batchesCommitted} batches committed: ${e?.message}. ` +
      `Target may be PARTIALLY restored. Do NOT retry into this DB — use a NEW empty throwaway database.`
    );
  }

  // 5. Independent verification (re-query Firestore, don't trust queued counts)
  const actual = await verifyRestore(firestoreDb, manifest, payload);

  console.log('[restore] Verified counts (independently re-queried):');
  for (const [name, count] of Object.entries(actual)) {
    console.log(`  ${name}: ${count} — OK`);
  }
  console.log(`  identity projections: ${legacy ? 'absent (legacy backup)' : 'restored'}`);
  if (legacy) console.log('[restore] NOTE: identity projections not restored (legacy 5-collection backup); rebuild them with the identity repair command; until then the consistency check reports every migrated row as "identity projection missing".');
  console.log(`[restore] SUCCESS: restored into ${targetDb}`);
  return { counts: actual, identityProjections: legacy ? 'absent' : 'restored' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source as string;
  const targetDb = (args['target-db'] || args.targetDb) as string;
  const projectId = (process.env.FIREBASE_PROJECT_ID as string) || PROD_PROJECT_ID;
  const confirm = args.confirm === true;

  if (!source) {
    log.error('Usage: node dist/restore-backup.cjs --source gs://<bucket>/tier1/<date>/<run>/ --target-db <throwaway-id> --confirm');
    process.exit(1);
  }
  if (!targetDb) {
    log.error('Missing --target-db');
    process.exit(1);
  }

  const app = admin.initializeApp({ projectId });
  const db = getFirestore(app, targetDb);
  const storage = getStorage(app);

  try {
    await runRestore({ source, targetDb, projectId, confirm, firestoreDb: db, storage });
    process.exit(0);
  } catch (e: any) {
    log.error(e?.message || e);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('restore-backup.cjs')) {
  main();
}
