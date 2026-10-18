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

| Procedure | Status | Notes |
|---|---|---|
| Transactional write path (commitState/commitOrRespond) | ✅ Tested | All Stage 2 tests pass against the real Firestore emulator in CI (see CI runs on PR #1). |
| Version conflict → 409 (no silent overwrite) | ✅ Tested | Tests 1, 3, 19 verify stale writes blocked, conflicts return 409; test 19 covers the stale-form baseline. |
| Idempotent retries (no duplicates) | ✅ Tested | Tests 6, 17 verify same operationId returns cached result; type/method/target scoping. |
| Failed write leaves no trace | ✅ Tested | Test 4 verifies Firestore + memory unchanged on failure. |
| Restart doesn't resurrect uncommitted data | ✅ Tested | Test 5 verifies only committed data survives restart. |
| Concurrent writes (10-way storm) | ✅ Tested | Test 7 verifies all succeed, version increments correctly. |
| Staged revision refuses writes (incl. boot) | ✅ Tested | Tests 20 (runtime toggle) and 21 (real staged boot — version/hash unchanged). |
| Backup → wipe → restore cycle | ✅ Tested | Test 18: export, wipe, restore via Admin SDK with explicit database ID; counts/version identical. Emulator only — production named-DB restore still needs operator verification. |
| Traffic shift to healthy revision (Option A) | ⚠️ Documented only | gcloud commands verified syntactically, never executed against production. Safe to test — it's non-destructive (just reroutes traffic). |
| Scale-to-zero maintenance mode (Option B) | ⚠️ Documented only | Command verified against Google Cloud docs ("Manual scaling": `--scaling=0` disables a service). Never executed against production. Brief downtime expected. |
| Maintenance kill-switch (Option D) | ⚠️ Documented only | `MAINTENANCE_MODE` (old server hotfix) and `FORCE_LOCAL_MODE` (Stage 2) code paths added; never exercised against production. Verify in a staging revision before relying on it in an incident. |
| Fail-closed boot (K_SERVICE + Firestore failure → `process.exit(1)`) | ⚠️ Documented only | Code path added; cannot be triggered by the test suite (would require K_SERVICE set + broken credentials). |
| No-op commits (skip write, no `_v` bump) | ✅ Tested | Test 13 verifies nested timestamps are treated as data; top-level `_v`/`updatedAt`/`savedAt` ignored for no-op detection. |
| `GET /api/health` (no auth; status/firestore/version/uptime) | ⚠️ Documented only | Endpoint extended; already public (no auth). Manually verifiable with curl. |
| Daily reset awaited + force/operationId | ⚠️ Documented only | `executeDailyReset` is now async; scheduled vs manual semantics changed. Not covered by current tests. |
| Firestore deny-all rules (Option C) | ⚠️ Documented only | ⚠️ CORRECTED 2026-10-18: Security Rules do **NOT** restrict the Firebase Admin SDK — this never blocked server writes. Only stops direct client SDK access. Rules syntax is standard; never deployed. |
| Backup restore from private export | ✅ Tested (emulator) | Test 18: full export → wipe → restore cycle against the Firestore emulator with explicit database ID — counts/version identical, post-restore write OK. Named production database still needs the operator throwaway-DB verification (BACKUP_RESTORE.md). Passwords AND kiosk PINs are stripped by design — users need password resets + PIN re-issue after a Tier 1 restore. |
| Forward-fix deploy (ROLLBACK.md policy) | ⚠️ Documented only | Standard deploy pipeline; the policy (never redeploy pre-Stage-2) is a process rule, not a technical gate. |

**Before production deployment, the ⚠️ items should be dry-run where safe** (traffic shift is non-destructive and can be tested; backup restore should be tested against the Firestore emulator, not production).

---

## 5. Contacts and references

- **Service URL:** `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/`
- **Repo:** `https://github.com/DanKenan/kashrus-app` (branch `review/stage2-data-integrity` for Stage 2 review)
- **Firestore console:** Firebase project `gen-lang-client-0875538181` → Firestore → database `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d` → `app-state/main`
- **Backup:** Take a fresh backup via `GET /api/admin/export` before any risky operation. Store it privately (NOT in git — the Oct 17 backup was removed from the repo after it was found to contain user emails and kiosk PINs in a public repo). Passwords are stripped by design.
- **Related docs:** `ROLLBACK.md` (forward-fix policy), `TEST_RESULTS.md` (verification), `ARCHITECTURE_ANALYSIS.md` (full failure-mode analysis)
