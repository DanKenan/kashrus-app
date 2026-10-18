/**
 * Stage 4 PR R — Tier 1 restore tool (throwaway databases ONLY).
 *
 * Usage:
 *   node dist/restore-backup.cjs \
 *     --source gs://<bucket>/tier1/<date>/<run>/ \
 *     --target-db <throwaway-id> \
 *     --confirm
 *
 * What it does:
 * 1. Refuses to run unless --confirm is passed (dry-run by default).
 * 2. Refuses any target that is:
 *    - the production database (exact ID match),
 *    - "(default)",
 *    - not matching the throwaway naming rule (must start with "restore-drill-").
 * 3. Refuses a non-empty target (any document in app-state/main or the
 *    per-entity collections) — restore only into an empty database.
 * 4. Downloads backup.json + manifest.json from the source prefix,
 *    verifies the SHA-256 checksum of backup.json against the manifest.
 * 5. Writes the scrubbed records into the target database:
 *    monolith -> app-state/main, each collection -> its documents.
 * 6. Prints per-collection counts; they must equal the manifest's counts.
 *    Exit code is non-zero on ANY mismatch, refusal, or error.
 *
 * The restored data is the SCRUBBED backup (secrets are [REDACTED]).
 * This tool restores structure and non-secret data for drill verification,
 * not production credentials.
 *
 * Build: esbuild src/server/restore-backup.ts --bundle --platform=node \
 *   --format=cjs --packages=external --outfile=dist/restore-backup.cjs
 * (added to the "build" script in package.json)
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as crypto from 'crypto';

// Production identifiers — restore REFUSES these targets.
const PROD_PROJECT_ID = 'gen-lang-client-0875538181';
const PROD_DATABASE_ID = 'ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d';

// Throwaway databases must follow this naming rule.
const THROWAWAY_PREFIX = 'restore-drill-';

const FIRESTORE_STATE_DOC = 'app-state/main';
const PER_ENTITY_COLLECTIONS = ['tasks', 'venues', 'users', 'usersByEmail', 'media'];

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

async function isTargetEmpty(db: any): Promise<{ empty: boolean; found: string[] }> {
  const found: string[] = [];
  const mainSnap = await db.doc(FIRESTORE_STATE_DOC).get();
  if (mainSnap.exists) found.push(FIRESTORE_STATE_DOC);
  for (const coll of PER_ENTITY_COLLECTIONS) {
    const snap = await db.collection(coll).limit(1).get();
    if (!snap.empty) found.push(`${coll} (has docs)`);
  }
  return { empty: found.length === 0, found };
}

export async function runRestore(opts: {
  source: string;
  targetDb: string;
  projectId: string;
  confirm: boolean;
  firestoreDb: any;
  storage: any;
}): Promise<{ counts: Record<string, number> }> {
  const { source, targetDb, projectId, confirm, firestoreDb, storage } = opts;

  // 1. Confirm flag
  if (!confirm) {
    console.log('[restore] Dry run (no --confirm). Would restore:');
    console.log(`  source: ${source}`);
    console.log(`  target: ${targetDb} (project ${projectId})`);
    console.log('[restore] Pass --confirm to execute.');
    return { counts: {} };
  }

  // 2. Target safety checks
  if (projectId !== PROD_PROJECT_ID) {
    throw new Error(`[restore] REFUSING: project ${projectId} != ${PROD_PROJECT_ID}`);
  }
  if (targetDb === PROD_DATABASE_ID) {
    throw new Error('[restore] REFUSING: target is the PRODUCTION database. Restore only into throwaway DBs.');
  }
  if (targetDb === '(default)') {
    throw new Error('[restore] REFUSING: target is (default).');
  }
  if (!targetDb.startsWith(THROWAWAY_PREFIX)) {
    throw new Error(
      `[restore] REFUSING: target "${targetDb}" does not match throwaway rule (must start with "${THROWAWAY_PREFIX}").`
    );
  }

  // 3. Target must be empty
  const { empty, found } = await isTargetEmpty(firestoreDb);
  if (!empty) {
    throw new Error(`[restore] REFUSING: target is not empty. Found: ${found.join(', ')}`);
  }

  // 4. Download + checksum verification
  const { bucket, prefix } = parseGsUrl(source);
  console.log(`[restore] Downloading from gs://${bucket}/${prefix} ...`);
  const [manifestRaw] = await storage.bucket(bucket).file(`${prefix}manifest.json`).download();
  const [dataRaw] = await storage.bucket(bucket).file(`${prefix}backup.json`).download();
  const manifest = JSON.parse(manifestRaw.toString('utf8'));
  const dataJson = dataRaw.toString('utf8');

  const actualChecksum = crypto.createHash('sha256').update(dataJson, 'utf8').digest('hex');
  if (actualChecksum !== manifest.checksum) {
    throw new Error(
      `[restore] CHECKSUM MISMATCH: manifest says ${manifest.checksum}, actual ${actualChecksum}. Aborting.`
    );
  }
  console.log(`[restore] Checksum verified: ${actualChecksum.slice(0, 16)}...`);

  const payload = JSON.parse(dataJson);

  // 5. Write records (batched)
  const counts: Record<string, number> = {};
  const BATCH_SIZE = 400;
  let batch = firestoreDb.batch();
  let batchCount = 0;
  const commitIfFull = async () => {
    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      batch = firestoreDb.batch();
      batchCount = 0;
    }
  };

  // Monolith
  if (payload.monolith) {
    batch.set(firestoreDb.doc(FIRESTORE_STATE_DOC), payload.monolith);
    batchCount++;
    counts['app-state/main'] = 1;
  }

  // Per-entity collections
  for (const collName of PER_ENTITY_COLLECTIONS) {
    const docs = payload.collections?.[collName] || [];
    counts[collName] = 0;
    for (const doc of docs) {
      const { id, ...data } = doc;
      if (!id) throw new Error(`[restore] Document in ${collName} missing id`);
      batch.set(firestoreDb.collection(collName).doc(id), data);
      batchCount++;
      counts[collName]++;
      await commitIfFull();
    }
  }
  if (batchCount > 0) await batch.commit();

  // 6. Verify counts match manifest
  console.log('[restore] Restored counts:');
  let mismatch = false;
  for (const [name, count] of Object.entries(counts)) {
    const expected = name === 'app-state/main'
      ? (manifest.monolithPresent ? 1 : 0)
      : manifest.collections?.[name];
    const status = count === expected ? 'OK' : `MISMATCH (expected ${expected})`;
    console.log(`  ${name}: ${count} — ${status}`);
    if (count !== expected) mismatch = true;
  }
  if (mismatch) {
    throw new Error('[restore] Count mismatch — restore incomplete.');
  }

  console.log(`[restore] SUCCESS: restored into ${targetDb}`);
  return { counts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source as string;
  const targetDb = (args['target-db'] || args.targetDb) as string;
  const projectId = (process.env.FIREBASE_PROJECT_ID as string) || PROD_PROJECT_ID;
  const confirm = args.confirm === true;

  if (!source) {
    console.error('Usage: node dist/restore-backup.cjs --source gs://<bucket>/tier1/<date>/<run>/ --target-db <throwaway-id> --confirm');
    process.exit(1);
  }
  if (!targetDb) {
    console.error('Missing --target-db');
    process.exit(1);
  }

  const app = admin.initializeApp({ projectId });
  const db = getFirestore(app, targetDb);
  const storage = getStorage(app);

  try {
    await runRestore({ source, targetDb, projectId, confirm, firestoreDb: db, storage });
    process.exit(0);
  } catch (e: any) {
    console.error(e?.message || e);
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported for tests).
if (process.argv[1]?.endsWith('restore-backup.cjs')) {
  main();
}
