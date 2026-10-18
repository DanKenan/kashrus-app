# Backup and Restore Plan

## Creating a Backup

### Via API (recommended)
```bash
# As an admin user, download the full state
curl -s "https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/admin/export" \
  -H "Authorization: Bearer <ADMIN_SESSION_TOKEN>" \
  -o "backup-$(date +%Y-%m-%d).json"
```

The export endpoint (`GET /api/admin/export`) is **admin-only** (fixed 2026-10-18).
It returns the full Firestore document as JSON.

### What's in the backup (verified against `stateSnapshot()` + export code)
- ✅ Users (names, emails, roles, agency links, permissions) — **passwords,
  password hashes, and kiosk PINs are stripped** (keys absent, not null)
- ✅ Venues, tasks, history logs, handoff notes, announcements, incidents
- ✅ Task templates, events, event task templates, approved ingredients, factory reports
- ✅ Agency configs — **Airtable API keys ARE included** (store securely)
- ✅ Agency list, push subscriptions, `currentWorkDate`, document `_v`
- ✅ `resetPepper` (needed for pepper stability across restores)
- ✅ `passwordResets` + rate-limit state (outstanding codes expire in 15 min anyway)
- ✅ Idempotency records (harmless; expire in 24h)
- ❌ **Passwords / password hashes / kiosk PINs** — stripped by design
- ❌ **`jwtSecret`** — stripped by design (sessions invalidate on restore; users re-login)
- ❌ **`vapidKeys`** — stripped by design (push must be re-keyed after restore — see below)
- ❌ **Sessions** — not stored server-side (HMAC tokens); all invalidate when the JWT secret rotates

### The complete backup: two tiers, different trust levels

**Tier 1 — Ordinary admin export** (`GET /api/admin/export` → JSON).
Strips ALL credential material: passwords, password hashes, kiosk PINs,
`jwtSecret`, `vapidKeys`. Safe to handle, store, and move around — but a
restore from Tier 1 alone means: all users reset passwords via the
forgot-password flow, all kiosk PINs re-issued, push re-keyed. Acceptable
for a data-only recovery; annoying for a full disaster.

**Tier 2 — Full-fidelity disaster-recovery backup** (round 5). For a restore
where users keep working with no re-issue storm, keep a SEPARATE encrypted
bundle containing everything Tier 1 strips, stored with restricted access
(encrypted file in a password manager, or a private GCS bucket with
limited IAM — never in git, never next to the Tier 1 JSON):

- `kioskPin` per kiosk user (user id → PIN). PINs cannot be extracted from
  exports (they're stripped) — maintain this inventory separately, recorded
  when PINs are issued via TeamModal. Re-apply after restore via TeamModal.
- VAPID public/private keys (keeps push working after restore). Record from
  the server environment / secret store — never from an export.
- `RESET_CODE_PEPPER` value (or confirm it remains the Cloud Run env var)
- Passwords: NOT recoverable by design (bcrypt hashes are one-way). Even
  Tier 2 cannot restore passwords — users MUST use the forgot-password flow
  after any restore. Document this; do not promise otherwise.
- The JWT secret is intentionally EXCLUDED from both tiers — restoring it
  would keep potentially-stolen sessions valid. Let it rotate on restore;
  users re-login once.

Tier 2 exists so a restore doesn't lock out the field team (PINs) or break
push (VAPID). It does NOT avoid the password-reset flow — nothing can.

### Verifying the restore against the NAMED production database (operator)

The automated test (test 18) covers the restore cycle against the emulator's
default database with the explicit-database-ID code path. The named
production database still needs a one-time operator verification. Do NOT
touch production data — verify against a THROWAWAY named database:

```bash
# 1. Create a throwaway named database (any name, e.g. shutfey-restore-test).
#    Firebase Console → Firestore → Create database, or:
gcloud firestore databases create --database=shutfey-restore-test \
  --location=us-east1 --type=firestore-native \
  --project=gen-lang-client-0875538181

# 2. Run the restore script (BACKUP_RESTORE.md Option B) pointed at the
#    throwaway database: temporarily set DATABASE_ID='shutfey-restore-test'
#    in restore.mjs, with a COPY of a Tier 1 backup.

# 3. Verify: document exists at app-state/main in shutfey-restore-test,
#    counts match the backup (tasks/venues/users/_v), then boot a local
#    server against the throwaway DB and confirm the app loads it.

# 4. Delete the throwaway database when done:
gcloud firestore databases delete --database=shutfey-restore-test \
  --project=gen-lang-client-0875538181
```

Record the result here when done:
- [ ] Throwaway named-DB restore verified (date: ___; counts: tasks=___, venues=___, users=___, `_v`=___)
- [ ] Throwaway database deleted afterwards

### Storage
- Store backups **privately** — encrypted drive, password manager, etc.
- **NEVER commit to git** (the Oct 17 backup was accidentally committed to the
  public repo; it was removed from `main` on Oct 18 and history cleanup is planned).
- `.gitignore` now blocks `BACKUP-*.json` and `*.backup` files.
- Recommended cadence: before every production deploy, plus weekly.

## Restoring from Backup

### Prerequisites
- A backup JSON file from `/api/admin/export`
- Admin access to the Firebase console (or `gcloud` with Firestore permissions)
- **Downtime expected**: put the app in maintenance mode first (see EMERGENCY.md)

### Procedure

There is no automated import endpoint (by design — restores are rare and
dangerous enough to warrant manual steps).

#### Option A: Via Firebase Console (recommended for Don)
1. Go to Firebase Console → Firestore → database
   `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`
2. Navigate to collection `app-state`, document `main`
3. Delete the current document (or note its contents for comparison)
4. Create a new document with ID `main`, paste the backup JSON as fields
   - The console accepts JSON import via the "Add document" → auto-ID is wrong;
     instead use `gcloud` (Option B) for reliability with large documents
5. Verify: `GET /api/health` shows `firestore: connected`
6. Restart the Cloud Run service to reload state from Firestore

#### Option B: Via gcloud (recommended for large backups)
```bash
# 1. Put app in maintenance mode (see EMERGENCY.md for exact commands)
# 2. Write the backup to Firestore using the Admin SDK via a Node script:
```

```javascript
// restore.mjs — run with:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//   node restore.mjs backup-2026-10-18.json
//
// Targets the NAMED Firestore database explicitly via getFirestore(app,
// databaseId). Do NOT use admin.firestore() without a database ID —
// Shutfey does not use the (default) database.
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'gen-lang-client-0875538181';
const DATABASE_ID = 'ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d';

const app = initializeApp({
  credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf-8'))),
  projectId: PROJECT_ID,
});
// Explicit named-database handle — this is the critical line.
const db = getFirestore(app, DATABASE_ID);

const backup = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
// Remove export metadata, keep the document fields.
delete backup.exportedAt;
console.log(`Restoring ${Object.keys(backup).length} top-level fields, _v=${backup._v}, ` +
  `${(backup.tasks || []).length} tasks, ${(backup.venues || []).length} venues, ` +
  `${(backup.users || []).length} users → ${DATABASE_ID}/app-state/main`);
await db.doc('app-state/main').set(backup);
console.log('Restore complete.');
process.exit(0);
```

```bash
# 3. Restart Cloud Run to reload
# 4. Verify health, then take out of maintenance mode
```

### Post-Restore Steps
1. **Passwords**: all users must use the forgot-password flow to set new passwords
   (passwords are stripped from exports by design).
2. **Sessions**: all active sessions are invalidated (the JWT secret is stripped
   from exports, so the server generates a new one on boot). Users re-login.
3. **Kiosk PINs**: stripped from exports — re-issue PINs for kiosk mashgichim
   after any restore.
4. **Push (VAPID)**: `vapidKeys` are stripped from exports. After a restore,
   re-provision VAPID keys from the secret inventory (part 2 of the complete
   backup) or generate new ones and have clients re-subscribe on next app open.
5. **Verify**: Don checks the team screen (6 users), venue data, and recent tasks.

### What Cannot Be Restored
- Passwords, password hashes, kiosk PINs (must be re-issued; PINs via TeamModal)
- Active sessions (users must re-login)
- VAPID keys (stripped; re-provision from the secret inventory)
- Data written AFTER the backup was taken (by definition)

## Restore Testing

**Test 18 (automated, 2026-10-18):** full export → wipe → restore cycle
against the Firestore emulator, using the Admin SDK with an **explicit
database ID** (`getFirestore(app, databaseId)` — the exact pattern from the
restore script above):
- Export validated: all required fields present (`_v`, tasks, venues, users,
  `currentWorkDate`); passwords/hashes/PINs absent.
- Wipe simulated; restore wrote the export back.
- Result: **counts identical** (tasks, venues, users, `_v` all matched the
  backup); canary task intact; a post-restore write succeeded (doc not corrupted).
- Note: CI runs against the `(default)` emulator database
  (`FIRESTORE_DATABASE_ID` is empty in CI). The explicit-database-ID code path
  is what's tested. **Before production, Don must verify a fresh backup
  against the real project (`gen-lang-client-0875538181`) and the named
  database (`ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`),
  and record data counts + version here.**

## Pre-cutover release gate (all must be checked before Step 1 of CUTOVER.md)

- [ ] PR #2 merged — production `/api/admin/export` is admin-only
- [ ] PR #1 CI green (19/19) after sync with `main`
- [ ] Production Firestore security rules verified (deny-all deployed;
      confirmed in Firebase console, not assumed)
- [ ] Exposed kiosk PINs rotated (the 2 PINs from the Oct 17 public backup)
- [ ] Public backup history addressed (git history scrub of BACKUP-2026-10-17-stage1.json)
- [ ] `RESET_CODE_PEPPER` provisioned as a Cloud Run env var (stable, not generated)
- [ ] JWT secret rotation decision made (rotating logs out all users)
- [ ] Fresh Tier 1 backup downloaded and stored privately, counts recorded:
      tasks=___, venues=___, users=___, `_v`=___
- [ ] Tier 2 DR bundle (kiosk PIN inventory + VAPID keys + pepper) stored encrypted
- [ ] Named-database restore verified via throwaway DB (see above) — or
      explicitly deferred with reason: ___
- [ ] Don has approved the cutover window

## Backup Retention

- Keep the 3 most recent backups.
- Keep one backup from before each major deploy (Stage 1, Stage 2, etc.).
- Delete older backups securely (they contain user emails and API keys).
