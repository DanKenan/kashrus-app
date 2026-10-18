# Stage 2 Cutover Procedure

## Problem

Stage 2 (transactional writes with `_v` version checking) and pre-Stage-2
(unversioned fire-and-forget writes) **cannot safely write to the same
Firestore document simultaneously**.

- Stage 2 writes include `_v` and check it transactionally.
- Pre-Stage 2 writes overwrite the entire document without version checks.
- If both versions are live during a rolling deploy, a pre-Stage-2 instance
  can clobber a Stage 2 transaction's committed data.

A standard Cloud Run rolling deployment does NOT guarantee this won't happen:
during the rollout window, old and new revisions serve traffic concurrently.

## How the deploy workflow protects the cutover

`.github/workflows/deploy.yml` now performs **staged (zero-traffic) deploys by
default**: the Python step pins 100% of traffic to the revision that is
currently serving it, so the new revision created by `gcloud run services
replace` starts with **0% traffic**. The operator then verifies the new
revision on its direct URL and cuts traffic over explicitly.

- Default (repo variable `STAGED_DEPLOY` unset or not `'false'`): staged deploy.
- To restore ordinary push-to-deploy after the migration is complete, set the
  repo Actions variable `STAGED_DEPLOY` to `'false'`
  (repo Settings → Secrets and variables → Actions → Variables).
- The traffic-pinning logic was unit-tested locally against simulated
  `gcloud run services describe` JSON (named-revision shape, `latestRevision:
  true` shape, empty list, first-deploy edge case) — all pass. It was NOT run
  against live Cloud Run from this environment (no gcloud credentials here);
  Don or the operator should confirm the first staged deploy shows the
  `STAGED DEPLOY: new revision gets 0% traffic` line in the workflow log.

## Procedure: Staged Deploy + Atomic Cutover

### Prerequisites
- PR #1 merged to `main` (after independent review approval).
- CI green on the merge commit (15/15 real-emulator tests).
- Fresh backup taken (see BACKUP_RESTORE.md) and stored privately.
- `RESET_CODE_PEPPER` provisioned in Cloud Run env (see BACKUP_RESTORE.md).
- Don has approved the deploy and the cutover window.

### Step 0. Record the current (pre-Stage-2) revision
```bash
gcloud run services describe workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "value(status.latestReadyRevisionName)"
# Save this as OLD_REVISION. It keeps 100% traffic through the whole deploy.
```

### Step 1. Deploy — new revision is created with 0% traffic automatically
Push to `main` (the merge commit). The deploy workflow builds and runs
`gcloud run services replace` with traffic pinned to OLD_REVISION.

Confirm in the workflow log:
```
STAGED DEPLOY: new revision gets 0% traffic; pinned to <OLD_REVISION>
```

Then confirm from the command line:
```bash
gcloud run services describe workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "yaml(spec.traffic)"
# Expect: 100% on OLD_REVISION. The new revision exists but gets no traffic.

# Find the new revision name (most recent):
gcloud run revisions list \
  --service workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --sort-by "~metadata.creationTimestamp" \
  --limit 2 \
  --format "table(metadata.name,metadata.creationTimestamp)"
# Save the newest as NEW_REVISION.
```

### Step 2. Verify the new revision directly (0% traffic)
Each revision has its own URL — this bypasses the traffic split entirely.
```bash
gcloud run revisions describe NEW_REVISION \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "value(status.url)"
# Save as NEW_REVISION_URL.

curl -s "$NEW_REVISION_URL/api/health" | python3 -m json.tool
```
Expected: `{ "status": "ok", "firestore": "connected", "stage2": true, ... }`.
- If `firestore` is NOT `"connected"`: STOP. Do not proceed. Investigate
  (service account, database ID, network). The old revision is still serving
  100% of production traffic — nothing is broken.
- Also verify login works against the new revision URL (admin login, read-only
  checks only — do NOT write test data through the new revision yet; it shares
  the production Firestore document).

### Step 3. Let in-flight requests on the old revision drain
The old revision holds the single instance (maxScale=1). Wait ~60 seconds after
the last observed request, or check Cloud Run metrics (request count on
OLD_REVISION drops to zero). There is no forced termination — this step is a
courtesy wait so no request is cut mid-flight.

### Step 4. Atomic cutover: shift 100% traffic to the new revision
Single API call — Cloud Run applies it atomically. No gradual period where
both versions serve writes.
```bash
gcloud run services update-traffic workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --to-revisions NEW_REVISION=100
```

### Step 5. Verify the old revision receives zero traffic
```bash
gcloud run services describe workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "yaml(status.traffic)"
# Confirm 100% on NEW_REVISION, 0% on OLD_REVISION.
```

Monitor for 15 minutes:
- `GET /api/health` → `status: ok`, `firestore: connected`
- Cloud Run logs: `VERSION_CONFLICT` (expected occasionally),
  `SAVE_FAILED` (should be rare), `FATAL` (must be zero)
- Don verifies in the PWA: login works, tasks load, team screen shows 6 users

### Step 6. Restore ordinary deploys (after the cutover is stable)
Once Stage 2 has served production traffic cleanly (recommend: 24h), set the
repo Actions variable `STAGED_DEPLOY` to `'false'` to restore push-to-deploy.
Until then, every push stays staged — no automatic production rollout.

## Verification Checklist

- [ ] Workflow log shows `STAGED DEPLOY: new revision gets 0% traffic`
- [ ] `spec.traffic` shows 100% on OLD_REVISION before cutover
- [ ] New revision `/api/health` → `firestore: connected`, `stage2: true`
- [ ] In-flight requests drained (~60s quiet)
- [ ] `update-traffic` moved 100% to NEW_REVISION atomically
- [ ] `status.traffic` confirms 0% on OLD_REVISION
- [ ] No `FATAL` errors in logs for 15 minutes
- [ ] Don confirms PWA works (login, tasks, team screen)
- [ ] Old revision retained (not deleted) until Stage 2 is proven stable
- [ ] Backup taken before cutover is stored privately

## Rollback

**Do NOT revert traffic to a pre-Stage-2 revision once Stage 2 has committed
data.** The old code writes the Firestore document without version checks —
routing traffic back would let unversioned writes clobber versioned state,
corrupting the document for all clients. Per ROLLBACK.md the policy is
**forward-fix only**: if Stage 2 has a bug, fix it on the PR branch, CI green,
and deploy forward through this same staged procedure.

The only exception is a catastrophic Stage 2 failure within minutes of
cutover AND explicit acceptance that unversioned writes may clobber data:
```bash
gcloud run services update-traffic workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --to-revisions OLD_REVISION=100
```
Then follow EMERGENCY.md. This is a last resort, not a routine operation.

## Testing this procedure without touching production

The traffic-pinning Python logic is the only new automation; it was validated
locally against simulated describe-JSON (see "How the deploy workflow protects
the cutover" above). The gcloud cutover commands themselves are standard Cloud
Run operations — to rehearse end-to-end without touching production:

1. Create a staging Cloud Run service (e.g.
   `workers-collaborative-dashboard-staging`) in the same project, or
2. Run the workflow's Python block locally against a saved
   `gcloud run services describe ... --format=json` output from production
   (read-only), and inspect the resulting traffic spec before any `replace`.

No part of the rehearsal writes to the production Firestore document.
