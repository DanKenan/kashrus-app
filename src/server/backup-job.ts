/**
 * Stage 4 PR B — Cloud Run Job entry point for Tier 1 backups.
 *
 * Run via: node --loader ts-node/esm src/server/backup-job.ts
 * (or compiled: node dist/backup-job.js)
 *
 * Environment variables required:
 * - FIREBASE_PROJECT_ID: GCP project ID
 * - FIRESTORE_DATABASE_ID: named database ID (explicit, never default)
 * - BACKUP_BUCKET: GCS bucket name (private, uniform access)
 * - GOOGLE_APPLICATION_CREDENTIALS: (on Cloud Run Job, uses attached SA)
 *
 * The job's service account needs:
 * - roles/datastore.viewer (or custom: datastore.entities.list + .get)
 *   on the named database
 * - roles/storage.objectCreator on the backup bucket
 *
 * It must NOT have write access to user data collections.
 */

import admin from 'firebase-admin';

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const databaseId = process.env.FIRESTORE_DATABASE_ID;
  const backupBucket = process.env.BACKUP_BUCKET;

  if (!projectId || !databaseId || !backupBucket) {
    console.error('[backup-job] Missing required env vars: FIREBASE_PROJECT_ID, FIRESTORE_DATABASE_ID, BACKUP_BUCKET');
    process.exit(1);
  }

  // Explicitly select the named database — never the default.
  if (!databaseId || databaseId === '(default)') {
    console.error('[backup-job] FIRESTORE_DATABASE_ID must be the named production database, not (default). Refusing to run.');
    process.exit(1);
  }

  console.log(`[backup-job] Starting Tier 1 backup: project=${projectId}, db=${databaseId}, bucket=${backupBucket}`);

  const app = admin.initializeApp({ projectId });
  // Explicitly select the named database.
  const namedDb = (app as any).firestore(databaseId);

  const storage = (admin as any).storage();

  const { runTier1Backup } = await import('./backup.js');
  try {
    const manifest = await runTier1Backup(namedDb, storage, backupBucket, databaseId);
    console.log(`[backup-job] SUCCESS: ${manifest.createdAt}, checksum ${manifest.checksum.slice(0, 16)}`);
    process.exit(0);
  } catch (e: any) {
    console.error('[backup-job] FAILED:', e?.message);
    console.error(e?.stack);
    process.exit(1);
  }
}

main();
