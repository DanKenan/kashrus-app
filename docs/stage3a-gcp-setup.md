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
7. Protection: **None** (do NOT enable versioning — Don's 30-day retention requires hard delete)
8. Click **CREATE**

## 2. Set the 30-Day Lifecycle Rule

1. Click the bucket name → **LIFECYCLE** tab → **ADD RULE**
2. Action: **Delete object**
3. Condition: **Age** → `30` days
4. Click **SAVE**

This is the backup protection. The app's sweeper also deletes expired files,
but the lifecycle rule guarantees deletion even if the sweeper fails.

## 3. Grant the Runtime Service Account Access

The Cloud Run service runs as a service account. Grant it bucket-scoped permissions:

1. Go to https://console.cloud.google.com/storage/browser?project=gen-lang-client-0875538181
2. Click the bucket name → **PERMISSIONS** tab → **GRANT ACCESS**
3. New principals: the Cloud Run runtime service account
   - Find it at: Cloud Run → workers-collaborative-dashboard → SECURITY tab
   - It looks like `1080260390009-compute@developer.gserviceaccount.com`
4. Role: **Storage Object Admin** (`roles/storage.objectAdmin`)
   - Scoped to this bucket only (not the whole project)
   - Allows: create, read, delete objects (needed for upload, download, sweeper)
5. Click **SAVE**

**Do NOT grant** the GitHub deploy service account (`github-deploy@...`) access to this bucket.
Deploy and runtime identities are separate by design.

## 4. Set the Bucket Name on Cloud Run

1. Go to Cloud Run → workers-collaborative-dashboard → **EDIT & DEPLOY NEW REVISION**
2. **VARIABLES & SECRETS** tab → **ADD VARIABLE**
3. Name: `MEDIA_BUCKET_NAME`
4. Value: `shutfey-media-gen-lang-client-0875538181` (the bucket name from step 1)
5. Click **DEPLOY**

## Verification

After the 3A PR deploys, check:
- `GET /api/media/status` → `{"configured": true, ...}`
- If `configured: false`, the bucket name is missing or the SA lacks permissions.
  Media features will be disabled; the rest of the app works normally.

## What the App Does NOT Do

- The app never creates buckets. If `MEDIA_BUCKET_NAME` is unset, media APIs return 503 with a clear message.
- The app never changes bucket IAM or lifecycle rules. Those are your one-time setup.
- The deploy workflow does not touch Storage configuration.
