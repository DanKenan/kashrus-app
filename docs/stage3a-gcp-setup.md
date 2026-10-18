# Stage 3A — GCP Setup (One-Time, Don's Steps)

These are one-time infrastructure steps. Done once in the Google Cloud Console.
The app will NOT create or reconfigure the bucket on deploy.

## 1. Create the Storage Bucket

1. Go to https://console.cloud.google.com/storage/browser?project=gen-lang-client-0875538181
2. Click **CREATE BUCKET**
3. Name: `shutfey-media-gen-lang-client-0875538181` (must be globally unique)
4. Location type: **Region**, Region: `us-east1` (same as Cloud Run)
5. Storage class: **Standard**
6. Access control: **Uniform** (recommended)
7. Protection settings:
   - **Soft delete**: Set to **OFF** (default is 7 days — must disable or deleted media outlives the 30-day limit)
   - **Object versioning**: **OFF** (do not enable)
8. Click **CREATE**

## 2. Disable Soft Delete (if not done at creation)

1. Click the bucket name → **PROTECTION** tab
2. Soft delete policy: Click **EDIT** → Set retention to **0 days** (disabled) → **SAVE**

## 3. Set the 30-Day Lifecycle Rule (Backup Protection)

**Note:** Lifecycle deletions are asynchronous — Google processes them on its own schedule, not exactly at day 30. The app's scheduled sweeper is the PRIMARY deletion mechanism; the lifecycle rule is BACKUP protection.

1. Click the bucket name → **LIFECYCLE** tab → **ADD RULE**
2. Action: **Delete object**
3. Condition: **Age** → `30` days
4. Click **SAVE**

## 4. Configure CORS for Browser Uploads

Browser-based PUT uploads to signed URLs require CORS on the bucket.

1. Create a file `cors.json`:
```json
[
  {
    "origin": ["https://workers-collaborative-dashboard-1080260390009.us-east1.run.app"],
    "method": ["PUT", "GET", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Length"],
    "maxAgeSeconds": 3600
  }
]
```
2. Run: `gsutil cors set cors.json gs://shutfey-media-gen-lang-client-0875538181`
   (Or use Cloud Shell in the console)

## 5. Grant the Runtime Service Account Access

The Cloud Run service runs as a service account. Grant it bucket-scoped permissions:

1. Go to https://console.cloud.google.com/storage/browser?project=gen-lang-client-0875538181
2. Click the bucket name → **PERMISSIONS** tab → **GRANT ACCESS**
3. New principals: the Cloud Run runtime service account
   - Find it at: Cloud Run → workers-collaborative-dashboard → SECURITY tab
   - It looks like `1080260390009-compute@developer.gserviceaccount.com`
4. Assign TWO roles:
   - **Storage Object Admin** (`roles/storage.objectAdmin`) — create, read, delete objects
   - **Service Account Token Creator** (`roles/iam.serviceAccountTokenCreator`) — required for signing URLs from the runtime identity. Grant this ON THE SERVICE ACCOUNT ITSELF (IAM → Service Accounts → select the runtime SA → PERMISSIONS → GRANT ACCESS → add the SA as principal with Token Creator role).
5. Click **SAVE**

**Do NOT grant** the GitHub deploy service account (`github-deploy@...`) access to this bucket.
Deploy and runtime identities are separate by design.

## 6. Set the Bucket Name on Cloud Run

1. Go to Cloud Run → workers-collaborative-dashboard → **EDIT & DEPLOY NEW REVISION**
2. **VARIABLES & SECRETS** tab → **ADD VARIABLE**
3. Name: `MEDIA_BUCKET_NAME`
4. Value: `shutfey-media-gen-lang-client-0875538181` (the bucket name from step 1)
5. Click **DEPLOY**

## 7. Set Up the Scheduled Sweeper (Cloud Scheduler)

The sweeper must run on a schedule — the admin endpoint alone is insufficient.

1. Go to https://console.cloud.google.com/cloudscheduler?project=gen-lang-client-0875538181
2. Click **CREATE JOB**
3. Name: `shutfey-media-sweeper`
4. Region: `us-east1`
5. Frequency: `0 2 * * *` (daily at 2 AM ET)
6. Target type: **HTTP**
7. URL: `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/media/sweep`
8. HTTP method: **POST**
9. Auth header: Add an `Authorization` header with a service account token
   - (Requires setting up OIDC token for the scheduler SA — see Cloud Scheduler docs)
10. Click **CREATE**

**Alternative (simpler for now):** Don can manually trigger the sweeper via the admin UI, or we can add it to the existing nightly cron. The Cloud Scheduler is the robust long-term solution.

## Verification

After the 3A PR deploys and bucket is configured:

1. `GET /api/media/status` → `{"configured": true, ...}`
   - If `configured: false`, check: bucket name env var, SA permissions, Storage API enabled.
2. Test upload flow:
   - `POST /api/media/intent` (as admin) → should return `uploadUrl`
   - PUT a test image to the `uploadUrl` → should succeed (CORS configured)
   - `POST /api/media/:id/uploaded` → `{"ok": true}`
   - `POST /api/media/:id/validate` → `{"ok": true, "state": "VALIDATED"}`
   - `POST /api/media/:id/commit` → `{"ok": true, "state": "COMMITTED"}`
   - `GET /api/media/:id/download` → should return `downloadUrl`
3. Test sweeper: `POST /api/media/sweep` (as admin) → should return counts.

## What the App Does NOT Do

- The app never creates buckets. If `MEDIA_BUCKET_NAME` is unset, media APIs return 503.
- The app never changes bucket IAM, CORS, lifecycle, or soft-delete settings.
- The deploy workflow does not touch Storage configuration.
- Backup copies (if any) must have equivalent 30-day retention — document separately when backups are implemented (Phase 4).
