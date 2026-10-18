# Emergency Runbook — Stage 2 (Single Transactional Write Path)

> **For use if a Stage 2 deployment causes problems in production.**
> Service: `workers-collaborative-dashboard` · Region: `us-east1` · Project: `gen-lang-client-0875538181`

## Principles

1. **Forward fix only.** Never redeploy a pre-Stage-2 build — it writes without
   version checks and will clobber committed data. (See ROLLBACK.md.)
2. **Firestore is the source of truth.** The in-memory cache and `store.json`
   are expendable; the Firestore document is not.
3. **Pause first, diagnose second.** Stop the bleeding before investigating.

---

## 1. How to pause writes safely

### Maintenance mode vs normal operation

**Normal operation:** All endpoints work. Writes go through Firestore transactions.

**Read-only maintenance mode** — two implementations, same behavior:

- **On current production (pre-Stage-2):** `MAINTENANCE_MODE=true` env var
  (added by the `hotfix/maintenance-mode` PR). ALL non-read `/api` requests
  return **503** with `{code: 'MAINTENANCE'}`; background writers (media
  cleanup, overdue check, scheduled reset) skip. This is the switch to stop
  old-version writes fast — e.g. before the Stage 2 cutover (see CUTOVER.md).
  Set via: `gcloud run services update workers-collaborative-dashboard --update-env-vars MAINTENANCE_MODE=true --region us-east1 --project gen-lang-client-0875538181`
  To exit: `--remove-env-vars MAINTENANCE_MODE`.
- **On Stage 2 builds:** `FORCE_LOCAL_MODE=true` env var. ALL mutating
  endpoints (POST/PUT/DELETE/PATCH) return **503** with `{code: 'MAINTENANCE'}`.
  GET endpoints continue to work. Set via: `gcloud run services update workers-collaborative-dashboard --set-env-vars FORCE_LOCAL_MODE=true --region us-east1`
  To exit: remove the env var or set it to `false`, then redeploy.

**Important:** neither mode makes the server write to local disk and claim
success. Both REJECT writes explicitly. This is the safe behavior — a
maintenance mode that silently loses data is worse than one that says
"try later."

### Option A: Route traffic to the previous healthy revision (recommended)

Cloud Run keeps prior revisions. Shifting 100% of traffic to the last-known-good
revision stops the bad code from serving within ~30 seconds, without deleting anything.

```bash
# List revisions (newest first) — identify the last healthy one
gcloud run revisions list \
  --service workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "table(metadata.name, metadata.creationTimestamp)"

# Route 100% of traffic to the last healthy revision
gcloud run services update-traffic workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --to-revisions <HEALTHY_REVISION_NAME>=100
```

**Critical constraint:** the "healthy" revision must itself be a Stage 2 build
(any build with the `_v` version chain). Rolling back to a *pre-Stage-2*
revision reintroduces unversioned writes — see Section 2.

If no Stage 2 revision is healthy, use Option B.

### Option B: Maintenance mode (kill-switch)

If every available revision is suspect, take the service offline gracefully
rather than serving corrupt writes:

```bash
# Scale to zero — stops all instances, rejects new requests.
# Per Google Cloud docs ("Manual scaling"): --scaling=0 disables the service.
# (The previous revision of this runbook used --max-instances 0, which is
# INVALID — max-instances minimum is 1 — and would have failed.)
gcloud run services update workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --scaling=0
```

Clients will see "Service unavailable" / "Service disabled" errors (better
than silent data corruption). Restore with `--scaling=auto --max-instances=1`
(the Stage 1 single-instance constraint) once fixed.

### Option C: Firestore deny-all (limited — read the warning)

> ⚠️ **Firestore Security Rules do NOT restrict the Firebase Admin SDK.**
> The server bypasses rules entirely. Setting rules to read-only (or deny-all)
> only stops DIRECT CLIENT SDK access — it does **NOT** stop the server from
> writing. If the bug is in the server's writes, rules alone will **NOT** stop
> the bleeding: use Option B (scale to zero) or Option D (FORCE_LOCAL_MODE)
> to actually stop server writes.

If direct client access (e.g. a compromised client SDK path) is the threat,
stop all access at the database level via the Firebase console:
**Firestore → Rules → deploy temporary deny-all (reads AND writes):**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

This does **not** make the server read-only: the Admin SDK used by our server
bypasses Security Rules entirely, so server writes continue unchanged. Do not
rely on this to stop bad server writes — see the warning above. Revert the
rules when the fix is deployed.

### Option D: FORCE_LOCAL_MODE kill-switch (stop server Firestore writes)

On Stage 2 builds (current code), set the env var `FORCE_LOCAL_MODE=true`:
the server skips Firestore init **entirely** — even on Cloud Run — and runs
in local-file mode, logging a loud `[Firestore] DEGRADED` warning on every
write attempt.

```bash
gcloud run services update workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --set-env-vars FORCE_LOCAL_MODE=true
```

Caveats:

- **Writes do NOT persist across restarts** (ephemeral container filesystem).
  Treat as read-mostly; expect data loss on redeploy/crash. This is a PAUSE,
  not a mode of operation.
- Works ONLY on Stage 2 builds containing the FORCE_LOCAL_MODE check
  (`initFirestore()` in server.ts). Pre-Stage-2 revisions ignore this variable
  — for those, use Option B (scale to zero).
- Reads keep serving from the in-memory cache (seeded from the local file at
  boot); they are not frozen.
- Re-enable by removing the override
  (`--remove-env-vars FORCE_LOCAL_MODE`) and redeploying the fixed build.

---

## 2. How to preserve committed data during an incident

### The danger

If you roll traffic back to a pre-Stage-2 revision, its `saveState()` writes the
whole document **without checking `_v`**. Any write from that old code can
silently overwrite newer committed transactions.

### The rule

**Only Stage 2 builds may write to the production Firestore document.**
Enforcement options, in order of preference:

1. **Don't roll back at all** — fix forward (Option A with a Stage 2 revision,
   or deploy a patched Stage 2 build).
2. **If you must run old code temporarily** (e.g. to keep reads alive):
   ⚠️ `FIRESTORE_ENABLED=false` does **NOT** disable Firestore on Cloud Run —
   `initFirestore()` checks `K_SERVICE` independently, so on Cloud Run the
   database is still initialized regardless of that variable. (Setting
   `FIRESTORE_ENABLED=false` only removes one of three opt-in signals; the
   `K_SERVICE` signal alone is enough.) On current Stage 2 builds, use the
   real kill-switch instead: `FORCE_LOCAL_MODE=true` — it skips Firestore
   init entirely, even on Cloud Run (see §1 Option D).
   ```bash
   gcloud run services update workers-collaborative-dashboard \
     --region us-east1 \
     --project gen-lang-client-0875538181 \
     --set-env-vars FORCE_LOCAL_MODE=true
   ```
   **No writes will persist** in this mode (local file only, ephemeral) —
   treat it as read-only. Re-enable by removing the override
   (`--remove-env-vars FORCE_LOCAL_MODE`) when the fixed build is deployed.
   Note: pre-Stage-2 revisions do not know `FORCE_LOCAL_MODE` — for those,
   use §1 Option B (scale to zero), which works regardless of code version.
3. **Firestore deny-all rules** (§1 Option C) as a backstop regardless of
   which revision is serving — with the caveat that they only stop DIRECT
   client SDK access, never the server's Admin SDK writes.

### What we can and cannot recover

| Scenario | Recoverable? | How |
|---|---|---|
| Bad build deployed, no bad writes committed yet | Yes | Traffic shift to healthy revision (Option A) |
| Bad writes committed with valid `_v` chain | Yes | Forward data migration (new build repairs records at boot or via admin endpoint) |
| Pre-Stage-2 code wrote without `_v` checks | Partially | Identify overwritten fields from Firestore version history (console → document → history); manually reconcile. No automatic undo. |
| Firestore database destroyed | Last resort | Restore from a fresh `/api/admin/export` backup (stored privately, NOT in git); all post-backup writes are lost; every client must hard-refresh |
| In-memory idempotency cache lost (restart) | Yes | Mutators are idempotent on stable IDs; client retries are safe |

**What we cannot recover:** writes that were never committed (client got an
error — by design, nothing was saved, so there is nothing to recover) and
post-backup writes after a total-restore.

---

## 3. Incident runbook (step by step)

### Detect

- **Signal:** spike in 409 `VERSION_CONFLICT` or 503 `SAVE_FAILED` responses;
  users report "my save disappeared"; `savedAt` stops advancing in Firestore.
- **Check:** Cloud Run logs
  ```bash
  gcloud logging read \
    'resource.type="cloud_run_revision" AND resource.labels.service_name="workers-collaborative-dashboard"' \
    --project gen-lang-client-0875538181 \
    --limit 50 \
    --format "table(timestamp, textPayload)" \
    | grep -iE "commitState|conflict|failed|error"
  ```

### Pause (~2 min)

1. Shift traffic to last healthy Stage 2 revision (Option A above).
2. If no healthy revision: scale to zero (Option B).
3. If bad writes are suspected: scale to zero (Option B) or set
   `FORCE_LOCAL_MODE=true` (Option D) — do NOT rely on Firestore rules
   (Option C), which cannot stop the server's Admin SDK writes.
4. Confirm: `curl -s https://<service-url>/api/health` (no auth needed) — check
   the `firestore` field reflects the intended state (`connected`,
   `degraded-local`, or `disabled`).

### Assess (~15 min)

1. What is the bad behavior? (Failed writes? Wrong data committed? Crash loop?)
2. When did it start? (Correlate with deploy timestamp in Cloud Run revisions.)
3. What is the current `_v` in Firestore? (Firebase console → Firestore →
   `app-state/main` → `_v` field.) A healthy chain increments by 1 per write;
   gaps or stalls indicate the failure mode.
4. Is any committed data wrong? If yes, note the affected fields/collections
   for the forward fix.

### Fix forward

1. Write the fix locally; run `npm run test:stage2` (all 7 must pass) and
   `npx tsc --noEmit` (clean).
2. Commit to a branch, open a PR, get review — **even in an incident, no
   unreviewed production pushes** (Don's standing rule).
3. Deploy via the normal pipeline (push to `main` → GitHub Actions → Cloud Run).
4. If Firestore deny-all rules were deployed (Option C), restore the normal
   rules **after** the fixed build is serving.
5. If `FORCE_LOCAL_MODE=true` was set (Option D), remove it
   (`--remove-env-vars FORCE_LOCAL_MODE`) **after** the fixed build is
   serving, so durability is restored.

### Verify

1. `_v` is advancing on writes (check Firestore console).
2. Create → verify → delete a test task via the API; confirm no 409/503.
3. Check logs for `commitState` errors for 10 minutes.
4. Ask one user (Don) to confirm the app behaves normally.

### Resume

1. Restore normal traffic: `--to-latest` (if you pinned a revision)
   ```bash
   gcloud run services update-traffic workers-collaborative-dashboard \
     --region us-east1 \
     --project gen-lang-client-0875538181 \
     --to-latest
   ```
2. Restore `--scaling=auto --max-instances=1` if you scaled to zero (restores
   autoscaling with the Stage 1 single-instance constraint).
3. Document the incident: what happened, what was done, what to prevent recurrence.

---

## 4. Tested vs documented-only

> Updated 2026-10-18 (Stage 4). Brutally honest: ✅ = executed for real;
> ⚠️ = written but never run against production.

| Procedure | Status | Notes |
|---|---|---|
| Transactional write path (commitState/commitOrRespond) | ✅ Tested | All Stage 2 tests pass against the real Firestore emulator in CI. |
| Version conflict → 409 (no silent overwrite) | ✅ Tested | Stale writes blocked, conflicts return 409. |
| Stage 2 release to production | ✅ Tested | Deployed 2026-10-17/18; the Cloud Run startup-command fix (removed stale AI-Studio override, 3-min probe) was diagnosed and fixed live. Don phone-tested: "Looks great." |
| Media upload lifecycle (intent → commit) | ✅ Tested | Don ran the full media-check E2E on his phone 2026-10-18 — ALL GREEN. |
| Per-entity migration copy + status | ✅ Tested | Don ran Copy (6 users, 1 venue, 6 email lookups) + Check Migration Status (MATCH) in production 2026-10-18. |
| Per-entity read switch (`READ_FROM_PER_ENTITY`) | ✅ Tested | Don flipped the env var; phone-tested login, users, venue, task CRUD — "All good." |
| Consistency monitor code | ✅ Tested (code) / ⚠️ Not created (job) | `runConsistencyCheck()` deployed; unit tests green. The Cloud Scheduler job (`shutfey-consistency-check`, every 4–6h) is **NOT yet created** — Don's open item. |
| Tier 1 backup code | ✅ Tested (code) / ⚠️ Not run (job) | `runTier1Backup()` deployed; unit tests green (scrub, checksums, unique paths). The Cloud Run Job + bucket + scheduler are **NOT yet created** — Don's open item. No backup has ever run. |
| Restore tool | ✅ Tested (code) / ⚠️ Not drilled | `restore-backup.ts` merged; 16 unit tests green (refusals, checksum, verification). **No real drill into a throwaway DB has been run.** Tier 1 is NOT disaster-recovery ready until this happens. |
| Secrets → Secret Manager code | ✅ Tested (code) / ⚠️ Not cut over | `USE_SECRET_MANAGER` flag deployed (default off — changes nothing). The 5-step cutover (copy values → create secrets → grant access → flip flag → verify) **needs Don's separate explicit OK** — not done. |
| Monitoring alerts | ⚠️ Documented only | `docs/stage4-alerts.md` written with Don's console steps. **No alert has been created**; no notification test has fired (except none). Don's open item. |
| Traffic shift to healthy revision (Option A) | ⚠️ Documented only | Never executed against production. Non-destructive — safe to test. |
| Scale-to-zero maintenance mode (Option B) | ⚠️ Documented only | Never executed against production. Brief downtime expected. |
| `MAINTENANCE_MODE` kill-switch | ⚠️ Documented only | Code path added (PR #3); never exercised against production. See §6. |
| Firestore deny-all rules | ✅ Tested | Don published deny-all rules 2026-10-18; Tab re-verified unauthenticated reads return 403. App unaffected (Admin SDK bypasses rules). |
| Secrets rotation (JWT/VAPID/PIN) | ⚠️ Documented only | **Needs Don's separate explicit OK — propose only, never do unprompted.** Would log everyone out. |
| Branch protection on main | ⚠️ Documented only | Proposed to Don (he enables it in GitHub settings). Not done. |

**The single most important untested item:** no backup has ever run and no
restore has ever been drilled. Until both happen, Stage 4's recovery story is
code + docs, not a verified capability.

---

## 5. Deploy checklist (one page)

Every production deploy — no exceptions, no matter how small the change.

**Before the PR:**
- [ ] Pre-review checklist points 1–9 (in `AGENTS.md` / memory — data source,
  API verification, arithmetic, auth, concurrency, tests, deployment compat,
  final diff + CI, infrastructure).
- [ ] `npm run lint` (tsc) + all relevant test suites green **locally**.
- [ ] 5-sentence note drafted: what changed / tested / unverified / data impact.

**The PR:**
- [ ] Open PR against `main`. **No direct pushes to main — ever** (not even docs).
- [ ] CI must go **green on the pushed SHA** (queued/running/failing ≠ green).
- [ ] Independent review (ChatGPT via Tab): address every point, push fixes,
  re-verify the pushed head via GitHub's compare API.
- [ ] Merge only on: review GO + CI green + your own agreement.

**After merge (GitHub Actions deploys automatically):**
- [ ] Watch the Actions run → confirm the Cloud Run revision deployed.
- [ ] `curl https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health`
  → expect `status: "ok"`, `firestore: "connected"`, `maintenance: false`,
  `staged: false`, and the new `version` number.
- [ ] Don's 30-second verify: team screen loads, create → complete → delete
  one task.
- [ ] Watch logs 10 min: `[commitOrRespond]` ERROR lines, 5xx/503 spikes.

**If the deploy fails:**
1. **Don't panic-deploy.** Read the Actions log — most failures are build
   errors (tsc) or the stale startup-command issue (see below).
2. **Diagnostics:** `gcloud run revisions list --service workers-collaborative-dashboard --region us-east1`
   → find the last healthy revision →
   `gcloud run services update-traffic workers-collaborative-dashboard --to-revisions <healthy>=100 --region us-east1`
   (Option A — non-destructive traffic shift, no redeploy).
3. **Known gotcha (Oct 18):** a stale AI-Studio container command override
   (`/bin/sh -c "if [ -f server.js ]; then..."`) can survive `services replace`
   and break startup. Fix: remove the override so the buildpack default
   (`node dist/server.cjs`) runs; ensure the startup probe allows ~3 min.
4. If writes are at risk and you can't diagnose in 5 min: **maintenance mode**
   (§6) to pause, then diagnose.

---

## 6. Maintenance-mode procedure

From `STAGE4_PLAN.md` §1.2. Use when you need to pause all writes safely
(deploy gone wrong, data repair, incident triage).

**What users see:** the app shows a friendly maintenance banner (the client
already handles HTTP 503 `MAINTENANCE`).

**Engage:**
```bash
gcloud run services update workers-collaborative-dashboard \
  --update-env-vars MAINTENANCE_MODE=true \
  --region us-east1 --project gen-lang-client-0875538181
```

**Verify — do not assume:**
1. `curl /api/health` → `maintenance: true`.
2. One test mutation (e.g. create a task) → expect HTTP 503.
3. Cloud Run request logs: no mutating requests for 60 seconds.
4. Firestore `app-state/main` `_v` stable (no version bumps).

**Do the work.**

**Lift:**
```bash
gcloud run services update workers-collaborative-dashboard \
  --remove-env-vars MAINTENANCE_MODE \
  --region us-east1 --project gen-lang-client-0875538181
```
Then: `curl /api/health` → `maintenance: false`; Don smoke-tests one write
(create → complete → delete a task).

**Key lesson (Oct 18):** "60 seconds quiet" is evidence, not proof. For
anything beyond a quick pause, also check the serving revision and instance
state — don't rely on log silence alone.

---

## 7. Don's open items (one place)

Everything below needs Don (console access he has, I don't). Nothing here
runs automatically.

**Backup & recovery:**
- [ ] GCP backup setup bundle (PR #19 body): create bucket, backup SA with
  database-conditioned viewer role, deploy Cloud Run Job, scheduler (OAuth,
  `America/New_York`), grant `run.invoker`.
- [ ] Run the backup job **twice** successfully; verify two `SUCCESS.json`
  markers with matching checksums.
- [ ] Restore drill: create empty `restore-drill-<date>` DB, run
  `node dist/restore-backup.cjs --confirm`, verify printed counts match.
- [ ] Tier 2 (weekly managed Firestore export): separate future work.
- [ ] Lifecycle deletion rules (tier1/ 30d, tier2/ 90d): **needs Don's OK**
  before activating — he reserved explicit authorization for auto-deletion.

**Monitoring:**
- [ ] Create scheduler job `shutfey-consistency-check` every **4–6 hours**
  (not daily) — OIDC, verify 200 not 401, set `--max-retry-attempts 3`.
- [ ] Create notification channels (email + SMS) and all alerts in
  `docs/stage4-alerts.md`; fire the test alert; confirm delivery.
- [ ] Sweeper scheduler: set `--max-retry-attempts 3` on `shutfey-media-sweeper`.

**Security & hygiene:**
- [ ] Secrets cutover (`USE_SECRET_MANAGER=true`): 5 steps in PR #16 —
  **needs Don's separate explicit OK**.
- [ ] JWT/VAPID secret rotation: **propose only** — would log everyone out.
- [ ] Change the reused admin password everywhere (hash was public ~12h Oct 18).
- [ ] Branch protection on `main` (PRs + required CI + no bypasses).

**Product (parked — Don's call):**
- [ ] Step E (stop dual-write): deferred by Don's decision.
- [ ] Ingredients / factory-inspections: **do not touch** until Don decides
  with his people — then it's top priority and the migration is designed
  together with it.

---

## 8. Contacts and references

- **Service URL:** `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/`
- **Repo:** `https://github.com/DanKenan/kashrus-app` (branch `review/stage2-data-integrity` for Stage 2 review)
- **Firestore console:** Firebase project `gen-lang-client-0875538181` → Firestore → database `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d` → `app-state/main`
- **Backup:** Take a fresh backup via `GET /api/admin/export` before any risky operation. Store it privately (NOT in git — the Oct 17 backup was removed from the repo after it was found to contain user emails and kiosk PINs in a public repo). Passwords are stripped by design.
- **Related docs:** `ROLLBACK.md` (forward-fix policy), `TEST_RESULTS.md` (verification), `ARCHITECTURE_ANALYSIS.md` (full failure-mode analysis)
