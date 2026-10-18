# Stage 2 Cutover Procedure

## Problem

Stage 2 (transactional writes with `_v` version checking) and pre-Stage 2
(unversioned fire-and-forget writes) **cannot safely write to the same
Firestore document simultaneously**.

- Stage 2 writes include `_v` and check it transactionally.
- Pre-Stage 2 writes overwrite the entire document without version checks.
- If both versions are live during a rolling deploy, a pre-Stage-2 instance
  can clobber a Stage 2 transaction's committed data.

A standard Cloud Run rolling deployment does NOT guarantee this won't happen:
during the rollout window, old and new revisions serve traffic concurrently.

## Procedure: Atomic Traffic Cutover

### Prerequisites
- PR #1 merged to `main` (after independent review approval).
- CI green on the merge commit (15/15 real-emulator tests).
- Fresh backup taken (see BACKUP_RESTORE.md) and stored privately.
- Don has approved the deploy.

### Steps

#### 1. Deploy the new revision with 0% traffic
Push to `main` triggers the deploy workflow, which creates a new Cloud Run
revision. By default it gets 100% traffic — we override this immediately.

```bash
# After the deploy workflow completes, find the new revision name
gcloud run revisions list \
  --service workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "table(metadata.name, metadata.creationTimestamp)" \
  --limit 3
```

```bash
# Pin 100% traffic to the OLD (pre-Stage-2) revision first
# Replace OLD_REVISION with the last known-good revision name
gcloud run services update-traffic workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --to-revisions OLD_REVISION=100
```

#### 2. Verify the new revision is healthy (0% traffic)
```bash
# Get the new revision's URL (each revision has a unique URL)
gcloud run revisions describe NEW_REVISION \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "value(status.url)"
```

```bash
# Health check against the new revision directly (bypasses traffic split)
curl -s "https://NEW_REVISION_URL/api/health" | python3 -m json.tool
# Expected: { "status": "ok", "firestore": "connected", ... }
# If firestore is NOT "connected", STOP. Do not proceed.
```

#### 3. Atomic cutover: shift 100% traffic to the new revision
This is a single API call — Cloud Run applies it atomically. There is no
gradual period where both versions serve writes.

```bash
gcloud run services update-traffic workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --to-revisions NEW_REVISION=100
```

#### 4. Verify the old revision receives zero traffic
```bash
gcloud run services describe workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "yaml(status.traffic)"
# Confirm 100% is on NEW_REVISION, 0% on OLD_REVISION
```

Monitor for 15 minutes:
- `GET /api/health` → `status: ok`, `firestore: connected`
- Check Cloud Run logs for errors: `VERSION_CONFLICT` (expected occasionally),
  `SAVE_FAILED` (should be rare), `FATAL` (should be zero)
- Don verifies in the PWA: login works, tasks load, team screen shows 6

#### 5. Keep the old revision available
Do NOT delete the old revision. It remains available for instant traffic
rollback via step 3 (in reverse).

**CRITICAL:** Rolling back to a pre-Stage-2 revision reintroduces unversioned
writes. Per ROLLBACK.md, the policy is **forward-fix only** — if Stage 2 has
a bug, fix it and deploy forward. Only roll back traffic to the old revision
if Stage 2 is catastrophically broken AND you accept that unversioned writes
may clobber data. See EMERGENCY.md for the incident procedure.

## Verification Checklist

- [ ] New revision health check returns `firestore: connected`
- [ ] Traffic is 100% on new revision, 0% on old
- [ ] No `FATAL` errors in logs for 15 minutes
- [ ] Don confirms PWA works (login, tasks, team screen)
- [ ] Old revision retained (not deleted)
- [ ] Backup taken before cutover is stored privately

## Rollback (Emergency Only)

If Stage 2 is catastrophically broken within minutes of cutover:

```bash
# Route traffic back to the old revision
gcloud run services update-traffic workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --to-revisions OLD_REVISION=100
```

Then follow EMERGENCY.md. Remember: the old code writes without version
checks. This is a last resort, not a routine operation.
