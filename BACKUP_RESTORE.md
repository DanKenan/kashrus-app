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

### What's in the backup
- ✅ Users (names, emails, roles, agency links)
- ✅ Venues, tasks, history logs, handoff notes, announcements, incidents
- ✅ Task templates, agency configs (Airtable keys are included — store securely)
- ❌ **Passwords are stripped** (by design — `password: undefined` in export)
- ❌ **Sessions are not included** (they're HMAC-signed tokens, not stored)
- ❌ **Reset peppers/codes**: `resetPepper` IS included (needed for pepper stability);
  outstanding `passwordResets` entries are included but expire in 15 minutes

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
// restore.mjs — run with: node restore.mjs backup-2026-10-18.json
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

admin.initializeApp({
  projectId: 'gen-lang-client-0875538181',
  databaseId: 'ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d',
});
const backup = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
// Remove export metadata, keep the document fields
delete backup.exportedAt;
await admin.firestore().doc('app-state/main').set(backup);
console.log('Restore complete. Document version:', backup._v);
process.exit(0);
```

```bash
# 3. Restart Cloud Run to reload
# 4. Verify health, then take out of maintenance mode
```

### Post-Restore Steps
1. **Passwords**: all users must use the forgot-password flow to set new passwords
   (passwords are stripped from exports by design).
2. **Sessions**: all active sessions are invalidated (JWT secret may have changed
   if it was rotated; even if not, users should re-login to be safe).
3. **Kiosk PINs**: if the backup predates a PIN rotation, re-issue PINs.
4. **Verify**: Don checks the team screen (6 users), venue data, and recent tasks.

### What Cannot Be Restored
- Passwords (must be reset via forgot-password flow)
- Active sessions (users must re-login)
- Push notification subscriptions (clients re-subscribe on next app open)
- Data written AFTER the backup was taken (by definition)

## Restore Testing (Emulator)

**Status**: procedure documented; live restore test against the emulator is
planned before production deployment of Stage 2.

To test:
1. Start the Firestore emulator locally
2. Create a test backup via the API (against the emulator)
3. Delete the emulator data
4. Restore via Option B script pointed at the emulator
5. Verify the app loads the restored data

Record the result here when done.

## Backup Retention

- Keep the 3 most recent backups.
- Keep one backup from before each major deploy (Stage 1, Stage 2, etc.).
- Delete older backups securely (they contain user emails and API keys).
