# Stage 2 Cutover Procedure (Round 6 — maintenance-hotfix cutover)

## Problem

Stage 2 (transactional writes with `_v` version checking) and pre-Stage-2
(unversioned fire-and-forget writes) **cannot safely write to the same
Firestore document simultaneously**. A standard Cloud Run rolling deployment
does NOT guarantee they won't: during the rollout window, old and new
revisions serve traffic concurrently.

## How this cutover guarantees exclusivity

Three independent mechanisms, any one of which would suffice alone:

1. **Maintenance hotfix on the old server.** Before anything else, Don merges
   the `hotfix/maintenance-mode` PR (a minimal, separately reviewed hotfix
   against `main`: `MAINTENANCE_MODE=true` makes all non-read `/api`
   requests return 503 and gates the old server's background writers). After
   it auto-deploys, the operator sets `MAINTENANCE_MODE=true` on the serving
   revision — **old writers are conclusively stopped**, and in-flight
   requests drain. (The old code has no `FORCE_LOCAL_MODE` support, so the
   hotfix is required — setting an env var the old server doesn't read
   would silently do nothing.)
2. **Staged revision cannot write — including during boot.** The deploy
   workflow bakes `STAGED_REVISION=true` into the new revision. The server
   serves reads and health checks but refuses ALL writes with 503
   `NOT_YET_LIVE`; all background jobs are skipped; and `startServer()`
   skips all four startup writes (pepper init, task-order backfill, VAPID,
   password migration) — a staged revision makes zero Firestore mutations,
   even during boot. Even if the staged revision's URL is hit before
   cutover, it cannot write to production.
3. **Zero-traffic deploy + post-deploy assertion.** The workflow pins 100% of
   traffic to the serving revision, refuses to proceed if it cannot identify
   it, and after deploy reads back the traffic allocation — failing the job
   if the new revision has >0% traffic. Production traffic can never
   accidentally follow the latest revision.

The cutover itself is one atomic `update-traffic` call to a **live** revision
(Stage 2 code with both flags removed), created with `--no-traffic` first.

## Prerequisites (all mandatory — release gates)

- [ ] PR #2 merged (export restricted to admins).
- [ ] Maintenance hotfix PR (`hotfix/maintenance-mode`) merged to `main` and
      deployed (verify: production `/api/health` accepts the
      `maintenance` field).
- [ ] PR #1 merged to `main` (after independent review approval).
- [ ] CI green on the merge commit (all Stage 2 tests, real emulator).
- [ ] Fresh backup of the NAMED Firestore database taken and verified, with
      counts recorded: tasks=___, venues=___, users=___, `_v`=___.
      (See BACKUP_RESTORE.md.)
- [ ] `RESET_CODE_PEPPER` provisioned as a Cloud Run env var.
- [ ] Firestore security rules verified (deny-all deployed).
- [ ] Exposed kiosk PINs rotated; public backup history addressed.
- [ ] Real-device PWA check completed.
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

### Step 0. Merge the maintenance hotfix first

Merge `hotfix/maintenance-mode` → `main` (Don, in daylight). It auto-deploys
the OLD code plus the maintenance switch. Verify the deploy took:

```bash
curl -s "https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('maintenance' in d)"
# Expect: True (the field exists — value False until the window opens)
```

### Step 1. Open the maintenance window (stop old writers)

```bash
gcloud run services update $SERVICE \
  --region $REGION --project $PROJECT \
  --update-env-vars MAINTENANCE_MODE=true
```

This creates a new revision running the OLD code with maintenance mode on;
it takes 100% of traffic. Every mutation now returns 503 `MAINTENANCE` with
a friendly message — **old writers are conclusively stopped**, including the
old server's background writers (media cleanup, overdue check, scheduled
reset all skip). Reads keep working. In-flight requests drain gracefully
(Cloud Run default).

Verify:
```bash
curl -s "https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'], d['maintenance'])"
# Expect: ok True

# A mutation must be refused:
curl -s -X POST "https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/tasks" \
  -H "Content-Type: application/json" -d '{"title":"probe"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['code'])"
# Expect: MAINTENANCE
```

### Step 2. Confirm old writers are fully stopped (explicit verification)

Do NOT assume a quiet minute means drained. An env-var update creates a new
Cloud Run revision; older revision instances may still exist temporarily, and
revision-level minimum instances can keep them active. Verify each of these
explicitly — **if any check cannot be confirmed, STOP the cutover** rather
than guessing:

**2a. Traffic: 100% on the maintenance revision, 0% elsewhere.**
```bash
gcloud run services describe $SERVICE --region $REGION --project $PROJECT \
  --format "value(status.traffic[].percent,status.traffic[].revisionName)"
# Expect: exactly one line with 100 and the maintenance revision name.
```

**2b. No pre-maintenance revision has running instances.**
```bash
gcloud run revisions list --service $SERVICE --region $REGION --project $PROJECT \
  --format "table(name,active:status.conditions[0].status)"
# Every revision EXCEPT the maintenance revision must show no active instances.
# If an old revision still has instances, wait and re-check; do not proceed
# while any unguarded revision can serve.
```

**2c. No mutating requests in the log since the maintenance revision took over.**
```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="workers-collaborative-dashboard" AND httpRequest.requestMethod!="GET"' \
  --project $PROJECT --limit 5 --format "value(timestamp,httpRequest.requestMethod,httpRequest.requestUrl)" \
  --freshness 10m
# Expect: no output, or only requests timestamped before the maintenance revision.
```

**2d. Firestore document is stable.**
Read `app-state/main` in the Firebase console (named database
`ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`); note `_v`
and `updatedAt`. Wait 2 minutes, re-read. Both must be unchanged — no writer
is touching the document.

**2e. STAGED_DEPLOY is not disabled.**
```bash
gh variable list --repo DanKenan/kashrus-app | grep STAGED_DEPLOY
# Expect: no output, or STAGED_DEPLOY=true. If STAGED_DEPLOY=false, the next
# push deploys with traffic — STOP and remove the variable first.
```

Only when 2a–2e all pass: old writers are conclusively stopped.

### Step 3. Deploy Stage 2 (0% traffic, staged, cannot write)

Merge PR #1 → `main`. The deploy workflow:
1. Identifies the serving revision — **refuses to proceed if it cannot**
   (fail the job rather than risk traffic following the new revision).
2. Pins 100% traffic to it; bakes `STAGED_REVISION=true` into the new revision.
3. After `services replace`, reads back traffic allocation and **fails if the
   new revision has >0% traffic**.
4. Tags the staged revision (`stage2-staged`) and prints the tagged URL, then
   curls `/api/health` through it.

Confirm in the workflow log:
```
STAGED DEPLOY: new revision gets 0% traffic; pinned to <SERVING_REVISION>
STAGED DEPLOY: STAGED_REVISION=true set — new revision cannot write until cutover
OK: newest revision has 0% traffic.
staged revision tagged URL: https://stage2-staged---<service-host>
```

### Step 4. Verify the staged revision (reads only, writes refused)

Use the **tagged URL** from the workflow log (untagged revisions have no
usable direct URL — `status.url` is not reliable for this):

```bash
STAGED_URL="<tagged URL from the workflow log>"
curl -s "$STAGED_URL/api/health" | python3 -m json.tool
# Expect: "staged": true, "firestore": "connected", "stage2": true

# Writes must be refused — try one (fails safely, no auth needed to see it;
# the staged guard runs before auth):
curl -s -X POST "$STAGED_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{"title":"cutover-probe"}' | python3 -m json.tool
# Expect: 503, code "NOT_YET_LIVE".
```

If `firestore` is NOT `"connected"`: STOP. The maintenance revision is still
serving production reads; nothing is broken. Investigate before proceeding.

### Step 5. Create the live revision (flags off, still 0% traffic)

```bash
gcloud run services update $SERVICE \
  --region $REGION --project $PROJECT \
  --remove-env-vars STAGED_REVISION,MAINTENANCE_MODE \
  --no-traffic
```

This creates ONE new revision running Stage 2 code with both flags removed,
at 0% traffic. (The live revision does its normal startup writes — pepper
init, backfills — at boot; the old server's writes were conclusively stopped
in Step 1, so there is no overlap.) Name it:

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
# Expect: ok False False (or None/None)

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

- [ ] Maintenance hotfix merged and deployed (health accepts `maintenance` field)
- [ ] Maintenance mode on: `/api/health` → `maintenance: true`
- [ ] Mutation probe → 503 `MAINTENANCE`
- [ ] Request log quiet (~60s, no mutating requests)
- [ ] Workflow log: serving revision identified (not refused)
- [ ] Workflow log: `STAGED DEPLOY: new revision gets 0% traffic`
- [ ] Workflow log: `OK: newest revision has 0% traffic`
- [ ] Workflow log: staged revision tagged, tagged URL printed
- [ ] Staged `/api/health` (via tagged URL) → `staged: true`, `firestore: connected`
- [ ] Staged write probe → 503 `NOT_YET_LIVE`
- [ ] Live revision created with `--no-traffic`, confirmed 0%
- [ ] `update-traffic` moved 100% to `$LIVE_REV` atomically
- [ ] `status.traffic` confirms 0% on all other revisions
- [ ] Production `/api/health` → `ok`, `maintenance` false, `staged` false
- [ ] No `FATAL` errors in logs for 15 minutes
- [ ] Don confirms PWA works (login, tasks, team screen)
- [ ] Old revisions retained (not deleted) until Stage 2 is proven stable
- [ ] Backup taken before cutover is stored encrypted and access-restricted

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
   override) — all pass. The post-deploy assertion and tag logic were
   syntax-checked. Neither was run against live Cloud Run from the sandbox
   (no gcloud credentials; tag flag syntax marked unverified); the first
   staged deploy's workflow log is the live proof.
2. **Staged-revision guard**: test 20 (runtime toggle) and test 21 (real
   staged boot — version and hash unchanged) cover it in CI.
3. **End-to-end rehearsal**: create a staging Cloud Run service in the same
   project and walk Steps 0–7 against it. No step touches the production
   Firestore document until the operator runs Step 6 against production.
