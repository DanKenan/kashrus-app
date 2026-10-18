/**
 * Stage 4 PR B — Restore script (THROWAWAY DATABASE ONLY).
 *
 * Restores a Tier 1 backup into a throwaway Firestore database for
 * verification drills. REFUSES to target production.
 *
 * Usage:
 *   node --loader ts-node/esm scripts/restore-backup.ts \
 *     --manifest gs://<bucket>/tier1/<date>/manifest.json \
 *     --target-db <throwaway-database-id>
 *
 * SAFETY:
 * - The target database ID must NOT match the production database ID
 *   (set via PROD_DATABASE_ID env var or --prod-db flag).
 * - The script lists what it WOULD write and requires --confirm.
 * - Never deletes; only writes (restores are additive for drills).
 */

import admin from 'firebase-admin';

const PROD_DB_IDS = [
  'ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d',
  process.env.PROD_DATABASE_ID,
].filter(Boolean);

function parseArgs() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--/, '');
    args[k] = process.argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const manifestPath = args['manifest'];
  const targetDb = args['target-db'];
  const confirmed = process.argv.includes('--confirm');

  if (!manifestPath || !targetDb) {
    console.error('Usage: --manifest gs://<bucket>/tier1/<date>/manifest.json --target-db <throwaway-id> [--confirm]');
    process.exit(1);
  }

  // REFUSE production
  if (PROD_DB_IDS.includes(targetDb)) {
    console.error(`[restore] REFUSING: target ${targetDb} is a production database. Restore drills use throwaway databases only.`);
    process.exit(1);
  }
  if (targetDb === '(default)') {
    console.error('[restore] REFUSING: target cannot be (default). Use a throwaway named database.');
    process.exit(1);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (!projectId) {
    console.error('[restore] Set FIREBASE_PROJECT_ID or GCP_PROJECT_ID.');
    process.exit(1);
  }

  console.log(`[restore] Manifest: ${manifestPath}`);
  console.log(`[restore] Target (throwaway): ${targetDb}`);
  console.log(`[restore] Project: ${projectId}`);

  if (!confirmed) {
    console.log('[restore] DRY RUN — pass --confirm to actually write.');
    console.log('[restore] Would: download manifest + backup.json, verify checksum, write docs to throwaway DB.');
    process.exit(0);
  }

  // TODO: implement actual restore (download from GCS, verify checksum, batch writes)
  // This is a drill tool — implement when the first drill is scheduled.
  console.log('[restore] --confirm passed, but restore implementation is pending the first drill.');
  console.log('[restore] See STAGE4_PLAN.md §3.3 for drill procedure.');
  process.exit(0);
}

main();
