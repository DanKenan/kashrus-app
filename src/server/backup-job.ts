/**
 * Stage 4 PR B — Cloud Run Job entry point for Tier 1 backups.
 *
 * Build: npx tsc src/server/backup-job.ts --outDir dist --module nodenext --target es2022
 * (or via the project's build script — must produce dist/backup-job.js)
 *
 * Run via: node dist/backup-job.js
 *
 * Environment variables required:
 * - FIREBASE_PROJECT_ID: GCP project ID (must match PROD_PROJECT_ID)
 * - FIRESTORE_DATABASE_ID: named database ID (must match PROD_DATABASE_ID)
 * - BACKUP_BUCKET: GCS bucket name (private, uniform access)
 *
 * The job's service account needs:
 * - roles/datastore.viewer with IAM condition restricting to the named DB
 * - roles/storage.objectCreator on the backup bucket ONLY
 *
 * It has NO Firestore write permissions. Backup success is tracked via
 * GCS markers, not Firestore writes.
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

// Exact production identifiers — the job REFUSES to run against anything else.
const PROD_PROJECT_ID = 'gen-lang-client-0875538181';
const PROD_DATABASE_ID = 'ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d';

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const databaseId = process.env.FIRESTORE_DATABASE_ID;
  const backupBucket = process.env.BACKUP_BUCKET;

  if (!projectId || !databaseId || !backupBucket) {
    console.error('[backup-job] Missing required env vars: FIREBASE_PROJECT_ID, FIRESTORE_DATABASE_ID, BACKUP_BUCKET');
    process.exit(1);
  }

  // Require EXACT match to production — a wrong database must not produce
  // a misleading "successful" backup.
  if (projectId !== PROD_PROJECT_ID) {
    console.error(`[backup-job] REFUSING: project ${projectId} != production ${PROD_PROJECT_ID}`);
    process.exit(1);
  }
  if (databaseId !== PROD_DATABASE_ID) {
    console.error(`[backup-job] REFUSING: database ${databaseId} != production ${PROD_DATABASE_ID}`);
    process.exit(1);
  }

  console.log(`[backup-job] Starting Tier 1 backup: project=${projectId}, db=${databaseId}, bucket=${backupBucket}`);

  const app = admin.initializeApp({ projectId });
  // Use the explicit named-database API (not (app as any).firestore(id)).
  const namedDb = getFirestore(app, databaseId);

  const storage = (admin as any).storage();

  const { runTier1Backup } = await import('./backup.js');
  try {
    const manifest = await runTier1Backup(namedDb, storage, backupBucket, databaseId);
    console.log(`[backup-job] SUCCESS: ${manifest.createdAt}, v${manifest.monolithVersion}, checksum ${manifest.checksum.slice(0, 16)}`);
    process.exit(0);
  } catch (e: any) {
    console.error('[backup-job] FAILED:', e?.message);
    console.error(e?.stack);
    process.exit(1);
  }
}

main();
