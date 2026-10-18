# Stage 2 Cutover Procedure (Round 5 — maintenance-window cutover)

## Problem

Stage 2 (transactional writes with `_v` version checking) and pre-Stage-2
(unversioned fire-and-forget writes) **cannot safely write to the same
Firestore document simultaneously**. A standard Cloud Run rolling deployment
does NOT guarantee they won't: during the rollout window, old and new
revisions serve traffic concurrently.

## How this cutover guarantees exclusivity

Three independent mechanisms, any one of which would suffice alone:

1. **Short controlled maintenance window.** Before deploy, the operator puts
   the serving (old) revision into maintenance mode (`FORCE_LOCAL_MODE=true`).
   All mutations return 503 — old writers are conclusively stopped, and
   in-flight requests drain.
2. **Staged revision cannot write.** The deploy workflow bakes
   `STAGED_REVISION=true` into the new revision. The server serves reads and
   health checks but refuses ALL writes with 503 `NOT_YET_LIVE`, and all
   background jobs (daily reset, media cleanup, overdue check) are skipped.
   Even if the staged revision's direct URL is hit before cutover, it cannot
   write to production.
3. **Zero-traffic deploy + post-deploy assertion.** The workflow pins 100% of
   traffic to the serving revision, refuses to proceed if it cannot identify
   it, and after deploy reads back the traffic allocation — failing the job
   if the new revision has >0% traffic. Production traffic can never
   accidentally follow the latest revision.

The cutover itself is one atomic `update-traffic` call to a **live** revision
(Stage 2 code with both flags removed), created with `--no-traffic` first.

## Prerequisites

- [ ] PR #1 merged to `main` (after independent review approval).
- [ ] CI green on the merge commit (19/19 real-emulator tests).
- [ ] PR #2 merged (export restricted to admins).
- [ ] Fresh backup taken and stored privately (see BACKUP_RESTORE.md),
      with counts recorded: tasks=___, venues=___, users=___, `_v`=___.
- [ ] `RESET_CODE_PEPPER` provisioned as a Cloud Run env var.
- [ ] Firestore security rules verified (deny-all deployed).
- [ ] Exposed kiosk PINs rotated; public backup history addressed.
- [ ] Don has approved the deploy and the cutover window.
- [ ] Don has a terminal with `gcloud` authenticated to project
      `gen-lang-client-0875538181`.

Set these for the session:
```bash
PROJECT=gen-lang-client-0875538181
REGION=us-east1
SERVICE=workers-collaborative-dashboard
```

## The cutover (one controlled sequence)

### Step 1. Open the maintenance window (stop old writers)

```bash
gcloud run services update $SERVICE \
  --region $REGION --project $PROJECT \
  --update-env-vars FORCE_LOCAL_MODE=true
```

This creates a new revision running the OLD code with maintenance mode on;
it takes 100% of traffic. Every mutation now returns 503 `MAINTENANCE` with
a friendly message — **old writers are conclusively stopped**. Reads keep
working. In-flight requests drain gracefully (Cloud Run default).

Verify:
```bash
curl -s "https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'], d['maintenance'])"
# Expect: maintenance True
```

### Step 2. Confirm zero in-flight writes

Check the Cloud Run request log — no mutating requests after the
maintenance revision took over:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="workers-collaborative-dashboard" AND httpRequest.requestMethod!="GET"' \
  --project $PROJECT --limit 5 --format "value(timestamp,httpRequest.requestMethod,httpRequest.requestUrl)" \
  --freshness 10m
# Expect: no output (or only requests from before the maintenance revision).
```

Wait ~60 seconds after the last observed request. The app is single-instance
(`maxScale=1`), so one quiet minute means fully drained.

### Step 3. Deploy Stage 2 (0% traffic, staged, cannot write)

Push to `main` (the merge commit). The deploy workflow:
1. Identifies the serving revision — **refuses to proceed if it cannot**
   (fail the job rather than risk traffic following the new revision).
2. Pins 100% traffic to it; bakes `STAGED_REVISION=true` into the new revision.
3. After `services replace`, reads back traffic allocation and **fails if the
   new revision has >0% traffic**.
4. Prints the staged revision's direct URL and curls `/api/health`.

Confirm in the workflow log:
```
STAGED DEPLOY: new revision gets 0% traffic; pinned to <SERVING_REVISION>
STAGED DEPLOY: STAGED_REVISION=true set — new revision cannot write until cutover
OK: newest revision has 0% traffic.
staged revision direct URL: https://<rev>-<hash>-us-east1.run.app
```

### Step 4. Verify the staged revision (reads only, writes refused)

```bash
STAGED_URL="<url from the workflow log>"
curl -s "$STAGED_URL/api/health" | python3 -m json.tool
# Expect: "staged": true, "firestore": "connected", "stage2": true

# Writes must be refused — try one (use a test that fails safely):
curl -s -X POST "$STAGED_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{"title":"cutover-probe"}' | python3 -m json.tool
# Expect: 503, code "NOT_YET_LIVE". (No auth needed to see the refusal;
# the staged guard runs before auth.)
```

If `firestore` is NOT `"connected"`: STOP. The maintenance revision is still
serving production reads; nothing is broken. Investigate before proceeding.

### Step 5. Create the live revision (flags off, still 0% traffic)

```bash
gcloud run services update $SERVICE \
  --region $REGION --project $PROJECT \
  --remove-env-vars STAGED_REVISION,FORCE_LOCAL_MODE \
  --no-traffic
```

This creates ONE new revision running Stage 2 code with both flags removed,
at 0% traffic. Name it:

```bash
LIVE_REV=$(gcloud run revisions list --service $SERVICE \
  --region $REGION --project $PROJECT \
  --sort-by "~metadata.creationTimestamp" --limit 1 \
  --format "value(metadata.name)")
echo "LIVE_REV=$LIVE_REV"
```

Sanity: confirm it has 0% before cutover:
```bash
gcloud run services describe $SERVICE --region $REGION --project $PROJECT \
  --format "yaml(status.traffic)"
# Expect: 100% on the maintenance revision, 0% on $LIVE_REV.
```

### Step 6. Atomic cutover

Single API call — Cloud Run applies it atomically. No gradual period where
both versions serve writes (and neither could write anyway: old is in
maintenance, staged was replaced).

```bash
gcloud run services update-traffic $SERVICE \
  --region $REGION --project $PROJECT \
  --to-revisions $LIVE_REV=100
```

### Step 7. Verify, then close the maintenance window

```bash
# 100% on the live revision, 0% everywhere else:
gcloud run services describe $SERVICE --region $REGION --project $PROJECT \
  --format "yaml(status.traffic)"

# Live health (maintenance is over — the live revision never had the flag):
curl -s "https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'], d.get('maintenance'), d.get('staged'))"
# Expect: ok False False (or None)

# A real write works again (admin login → create a test task → delete it).
```

Monitor for 15 minutes:
- Cloud Run logs: `VERSION_CONFLICT` (expected occasionally),
  `SAVE_FAILED` (should be rare), `FATAL` (must be zero), `NOT_YET_LIVE`
  (must be zero after cutover — any hit means something still points at a
  staged URL).
- Don verifies in the PWA: login works, tasks load, team screen shows 6 users.

The maintenance window is now closed — it lasted from Step 1 to Step 6
(minutes, not hours).

### Step 8. Restore ordinary deploys (after the cutover is stable)

Once Stage 2 has served production traffic cleanly (recommend: 24h), set the
repo Actions variable `STAGED_DEPLOY` to `'false'` to restore push-to-deploy.
Until then, every push stays staged — no automatic production rollout.

## Verification checklist

- [ ] Maintenance mode on: `/api/health` → `maintenance: true`
- [ ] Request log quiet (~60s, no mutating requests)
- [ ] Workflow log: serving revision identified (not refused)
- [ ] Workflow log: `STAGED DEPLOY: new revision gets 0% traffic`
- [ ] Workflow log: `OK: newest revision has 0% traffic`
- [ ] Staged `/api/health` → `staged: true`, `firestore: connected`
- [ ] Staged write probe → 503 `NOT_YET_LIVE`
- [ ] Live revision created with `--no-traffic`, confirmed 0%
- [ ] `update-traffic` moved 100% to `$LIVE_REV` atomically
- [ ] `status.traffic` confirms 0% on all other revisions
- [ ] Production `/api/health` → `ok`, `maintenance` false, `staged` false
- [ ] No `FATAL` errors in logs for 15 minutes
- [ ] Don confirms PWA works (login, tasks, team screen)
- [ ] Old revisions retained (not deleted) until Stage 2 is proven stable
- [ ] Backup taken before cutover is stored privately

## Rollback

**Do NOT send traffic back to a pre-Stage-2 revision once Stage 2 has
committed data.** The old code writes the Firestore document without version
checks — routing traffic back would let unversioned writes clobber versioned
state, corrupting the document for all clients. Per ROLLBACK.md the policy is
**forward-fix only**: if Stage 2 has a bug, fix it on the PR branch, CI
green, and deploy forward through this same staged procedure.

The only exception is a catastrophic Stage 2 failure within minutes of
cutover AND explicit acceptance that unversioned writes may clobber data.
Then follow EMERGENCY.md. This is a last resort, not a routine operation.

## Testing this procedure without touching production

1. **Workflow logic**: the traffic-pinning Python was unit-tested against
   simulated `describe` JSON (named-revision shape, `latestRevision: true`
   shape, empty traffic, unidentified-revision refusal, `STAGED_DEPLOY=first`
   override) — all pass. The post-deploy assertion logic was syntax-checked.
   Neither was run against live Cloud Run from the sandbox (no gcloud
   credentials); the first staged deploy's workflow log is the live proof.
2. **Staged-revision guard**: covered by the server test suite's maintenance
   tests pattern — `STAGED_REVISION=true` reuses the exact middleware path
   as `FORCE_LOCAL_MODE`. Operator verifies with the Step 4 write probe
   against the real staged revision before cutover.
3. **End-to-end rehearsal**: create a staging Cloud Run service in the same
   project and walk Steps 1–7 against it. No step touches the production
   Firestore document until the operator runs Step 6 against production.
