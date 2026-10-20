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

### Option A: Route traffic to the previous healthy revision (conditional)

**Only use this if the bad revision is actually serving production traffic
and causing real impact.** A failed build that never took traffic needs no
shift — just fix forward.

Cloud Run keeps prior revisions. Shifting 100% of traffic to the last-known-good
revision stops the bad code from serving within ~30 seconds, without deleting anything.

```bash
# List revisions (newest first) — identify the last healthy one
gcloud run revisions list \
  --service workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --format "table(metadata.name, metadata.creationTimestamp)"

# Route 100% of traffic to the verified healthy revision
HEALTHY_REVISION="verified-revision-name"
gcloud run services update-traffic workers-collaborative-dashboard \
  --to-revisions="${HEALTHY_REVISION}=100" \
  --region us-east1 \
  --project gen-lang-client-0875538181
```

**Critical constraint:** the target revision must be verified compatible with
*today's* data layer — per-entity reads, transactional writes (`_v` chain),
and the current security posture. **Never blindly pick an old Stage 2
revision**: schema, middleware, or env expectations may have drifted since it
was built. Verify by checking its deploy date against recent migrations and,
if in doubt, smoke-test it on its tagged revision URL before shifting traffic.

If no verified-compatible revision is healthy, use Option B.

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

### Option C: Firestore deny-all rules (permanent — do not change without Don's OK)

> **Status 2026-10-18:** deny-all rules are DEPLOYED and are the permanent
> protection. They block all direct client SDK access. The server's Admin SDK
> bypasses rules entirely, so this does **not** stop server writes.
>
> **Any change to these rules needs Don's explicit OK** (Shutfey guardrail).
> There is no "temporary deploy and revert" — the rules stay as they are.

If the incident involves compromised direct client access, the rules are
already blocking it. If the bug is in the server's writes, rules alone will
**NOT** stop the bleeding: use Option B (scale to zero) or maintenance mode
(§6) to actually stop server writes.

### Option D: FORCE_LOCAL_MODE kill-switch (legacy — prefer maintenance mode)

> **Corrected 2026-10-18:** On current builds, the middleware rejects API
> mutations when `FORCE_LOCAL_MODE=true` — it is NOT a "local-file mode"
> where writes might be lost. It is a hard stop on mutations, closer to
> maintenance mode than to a degraded local mode. **Prefer maintenance mode
> (§6)** for pausing writes — it's the supported path. `FORCE_LOCAL_MODE`
> remains as a legacy kill-switch.

```bash
gcloud run services update workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --set-env-vars FORCE_LOCAL_MODE=true
```

Re-enable with `--remove-env-vars FORCE_LOCAL_MODE`.

**Limits of `--scaling=0` (Option B):** scaling to zero stops new instances,
but tagged revision URLs may stay reachable and in-flight requests finish
gracefully — it does not instantly remove every writer. For a hard stop,
combine with maintenance mode.

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
   `K_SERVICE` signal alone is enough.) On current builds, `FORCE_LOCAL_MODE=true`
   makes the middleware **reject API mutations** — it is not a local-file mode
   (see §1 Option D). **Prefer maintenance mode (§6)** — it's the supported
   path for pausing writes.
   ```bash
   gcloud run services update workers-collaborative-dashboard \
     --region us-east1 \
     --project gen-lang-client-0875538181 \
     --update-env-vars MAINTENANCE_MODE=true
   ```
   Re-enable by removing the override (`--remove-env-vars MAINTENANCE_MODE`)
   when the fixed build is deployed.
   Note: pre-Stage-2 revisions do not know `FORCE_LOCAL_MODE` — for those,
   use §1 Option B (scale to zero), which works regardless of code version.
3. **Firestore deny-all rules** (§1 Option C) are already the permanent
   backstop — they stop direct client SDK access. They never stop the
   server's Admin SDK writes. **Do not change them without Don's OK.**

### What we can and cannot recover

| Scenario | Recoverable? | How |
|---|---|---|
| Bad build deployed, no bad writes committed yet | Yes | Traffic shift to healthy revision (Option A) |
| Bad writes committed with valid `_v` chain | Yes | Forward data migration (new build repairs records at boot or via admin endpoint) |
| Pre-Stage-2 code wrote without `_v` checks | Partially | Identify overwritten fields from Firestore version history (console → document → history); manually reconcile. No automatic undo. |
| Firestore database destroyed | Last resort | Tier 1 backup restore (once operational) or Tier 2 managed export; all post-backup writes are lost; every client must hard-refresh |
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
    --format "table(timestamp, severity, jsonPayload.message, textPayload)" \
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

1. Write the fix locally; run `npm run test:stage2` and
   `node tests/stage4/run-all.mjs` (all suites green) and
   `npx tsc --noEmit` (clean).
2. Commit to a branch, open a PR, get review — **even in an incident, no
   unreviewed production pushes** (Don's standing rule).
3. Deploy via the normal pipeline (push to `main` → GitHub Actions → Cloud Run).
4. If `FORCE_LOCAL_MODE=true` was set (legacy Option D), remove it
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
- [ ] Pre-review checklist points 1–9 (standing rules — data source,
  API verification, arithmetic, auth, concurrency, tests, deployment compat,
  final diff + CI + pushed-diff verification, infrastructure).
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
  `staged: false`. (Note: `version` is the Firestore state `_v`, not a build
  version — a code-only release need not change it. Verify the deployed Cloud
  Run revision separately via `gcloud run revisions list`.)
- [ ] Don's 30-second verify: team screen loads, create → complete → delete
  one task.
- [ ] Installed-PWA check (per `PWA_UPDATE.md`): on Don's phone, confirm the
  installed PWA picks up the new version (no white screen, no stale cache).
  Do NOT clear site data — that wipes the local session.
- [ ] Watch logs 10 min: `[commitOrRespond:<label>]` ERROR lines (terminal
  failed writes), 5xx/503 spikes.

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

## 7. Open items (one place)

### Don's actions (console access he has, I don't)

**Backup & recovery:**
- [ ] GCP backup setup bundle (PR #19 body): create bucket, backup SA with
  database-conditioned viewer role, deploy Cloud Run Job, scheduler (OAuth,
  `America/New_York`), grant `run.invoker`.
- [ ] Run the backup job **twice** successfully; verify two `SUCCESS.json`
  markers with matching checksums.
- [ ] Restore drill: create empty `restore-drill-<date>` DB, run
  `node dist/restore-backup.cjs --confirm`, verify printed counts match.

**Monitoring:**
- [ ] Create scheduler job `shutfey-consistency-check` every **4–6 hours**
  (not daily) — OIDC, verify 200 not 401, set `--max-retry-attempts 3`.
- [ ] Create notification channels (email + SMS) and all alerts in
  `docs/stage4-alerts.md`; fire the test alert; confirm delivery.
  (One consistency run = at most one alert: a single grouped
  `[consistency] ERROR` summary with a run id; the per-finding details are
  the `[consistency] INFO run=<id>` lines in Logs Explorer. Alerts are
  delivered immediately, 24/7; any silencing is the receiver's own setting.)
- [ ] Sweeper scheduler: set `--max-retry-attempts 3` on `shutfey-media-sweeper`.

**Hygiene:**
- [ ] Change the reused admin password everywhere (hash was public ~12h Oct 18).
- [ ] Branch protection on `main` (PRs + required CI + no bypasses).

### Explicit-approval-only decisions (propose, never do unprompted)

- [ ] Secrets cutover (`USE_SECRET_MANAGER=true`): 5 steps in PR #16.
- [ ] JWT/VAPID secret rotation — would log everyone out.
- [ ] **Any Firestore rules change** (rules are permanent deny-all since Oct 18).
- [ ] **Any data deletion** (including lifecycle auto-deletion rules:
  tier1/ 30d, tier2/ 90d — Don reserved explicit authorization).
- [ ] Agency-scoped admin export design (needs Don's call on super-admin model).
- [ ] Kiosk PIN rotation / reset-code provisioning — **dropped by Don's explicit
  decision** ("no one using it"). Do not raise again.
- [ ] Git-history rewriting / token hygiene verification (destructive).

### Engineering work (code, not Don's console)

Carried forward from `STAGE4_PLAN.md`:
- [ ] Admin audit logging (who changed what, when).
- [ ] Quarterly `npm audit` + dependency updates.
- [ ] Token/history hygiene verification (after Don OKs the approach).
- [ ] Cloud Monitoring dashboard (uptime, 5xx rate, backup age, monolith size).
- [ ] Deferred monitoring coverage from `docs/stage4-alerts.md` §6 PENDING items
  (login-spike alert, Firestore quota, bucket growth, backup digest, cert expiry).
- [ ] Full Tier 2 recovery (weekly managed export + its restore path).
- [ ] Fix flaky Test 2 in `tests/stage2/harness.mjs` (concurrent writes: both
  requests got 409 instead of one 200 + one 409 — pre-existing timing race,
  observed 2026-10-18; re-run passed).
- [ ] Module-level `currentWorkDate` in server.ts is initialized using UTC;
  subsequently refreshed through Firestore hydration, but may hold the wrong
  work date before hydration. It also feeds health/status responses and the
  midnight-rollover comparison. Between 00:00–04:00 UTC it can disagree with
  America/New_York by a full day. The snapshot archive date still depends on
  it (see next item). Tracked in PR #27, not part of the logging PR.
- [ ] Daily-reset snapshot archive date uses the module-level `currentWorkDate`
  instead of the NY date (`todayStr`) — between 00:00–04:00 UTC the snapshot
  is dated with the wrong day (observed 2026-10-18: Test 10 failed with
  snapshot date 2026-10-19 vs NY today 2026-10-18). The scheduled-rollover
  path also needs the archive date to be the workday being closed
  (`freshDoc.currentWorkDate`), not today. Tracked in PR #27
  ("Daily reset archive date: close the right workday").
- [ ] Step E (stop dual-write): **deferred by Don's decision** — do not revive
  without him.
- [ ] Ingredients / factory-inspections migration: **do not touch** until Don
  decides with his people — then it's top priority.

---

## 8. Contacts and references

- **Service URL:** `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/`
- **Repo:** `https://github.com/DanKenan/kashrus-app` (branch `review/stage2-data-integrity` for Stage 2 review)
- **Firestore console:** Firebase project `gen-lang-client-0875538181` → Firestore → database `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d` → `app-state/main`
- **Backup:** Once the Tier 1 job is operational, backups run automatically nightly. Before any risky operation, trigger a manual job run and note its `SUCCESS.json` path. (The old `/api/admin/export` endpoint is a manual sanitized snapshot — not a DR mechanism; Tier 1/Tier 2 are.) Store exports privately, never in git.
- **Related docs:** `ROLLBACK.md` (forward-fix policy), `TEST_RESULTS.md` (verification), `ARCHITECTURE_ANALYSIS.md` (full failure-mode analysis)
