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
# Scale to zero — stops all instances, rejects new requests
gcloud run services update workers-collaborative-dashboard \
  --region us-east1 \
  --project gen-lang-client-0875538181 \
  --max-instances 0
```

Clients will see connection errors (better than silent data corruption).
Restore with `--max-instances 1` (Stage 1 constraint) once fixed.

### Option C: Firestore read-only (nuclear option)

If the bug is writing bad data (not just failing), stop all writes at the
database level via the Firebase console:
**Firestore → Rules → deploy temporary deny-all writes:**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

The server will return 503 `SAVE_FAILED` on every write (by design — Stage 2
never reports success without a commit). Reads keep working. Revert the rules
when the fix is deployed.

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
2. **If you must run old code temporarily** (e.g. to keep reads alive), deploy
   it with Firestore writes disabled: set `FIRESTORE_ENABLED=false`
   (the server falls back to file-only mode and logs a warning per write).
   Reads still work from the in-memory cache loaded at boot.
   ```bash
   gcloud run services update workers-collaborative-dashboard \
     --region us-east1 \
     --project gen-lang-client-0875538181 \
     --set-env-vars FIRESTORE_ENABLED=false
   ```
   **No writes will persist** in this mode — treat it as read-only.
   Re-enable with `--set-env-vars FIRESTORE_ENABLED=true` (or remove the override)
   when the fixed build is deployed.
3. **Firestore read-only rules** (Option C above) as a backstop regardless of
   which revision is serving.

### What we can and cannot recover

| Scenario | Recoverable? | How |
|---|---|---|
| Bad build deployed, no bad writes committed yet | Yes | Traffic shift to healthy revision (Option A) |
| Bad writes committed with valid `_v` chain | Yes | Forward data migration (new build repairs records at boot or via admin endpoint) |
| Pre-Stage-2 code wrote without `_v` checks | Partially | Identify overwritten fields from Firestore version history (console → document → history); manually reconcile. No automatic undo. |
| Firestore database destroyed | Last resort | Restore `BACKUP-2026-10-17-stage1.json`; all post-backup writes are lost; every client must hard-refresh |
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
3. If bad writes are suspected: deploy Firestore deny-all-writes rules (Option C).
4. Confirm: `curl -s https://<service-url>/api/health` (or equivalent) reflects
   the intended state.

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
4. If Firestore was set read-only (Option C), restore the normal rules **after**
   the fixed build is serving.

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
2. Restore `--max-instances 1` if you scaled to zero.
3. Document the incident: what happened, what was done, what to prevent recurrence.

---

## 4. Tested vs documented-only

| Procedure | Status | Notes |
|---|---|---|
| Transactional write path (commitState/commitOrRespond) | ✅ Tested | 7/7 tests pass against Firestore mock (TEST_RESULTS.md). Real-emulator run pending. |
| Version conflict → 409 (no silent overwrite) | ✅ Tested | Test 1 & 3 verify stale writes blocked, conflicts return 409. |
| Idempotent retries (no duplicates) | ✅ Tested | Test 6 verifies same operationId returns cached result. |
| Failed write leaves no trace | ✅ Tested | Test 4 verifies Firestore + memory unchanged on failure. |
| Restart doesn't resurrect uncommitted data | ✅ Tested | Test 5 verifies only committed data survives restart. |
| Concurrent writes (10-way storm) | ✅ Tested | Test 7 verifies all succeed, version increments correctly. |
| Traffic shift to healthy revision (Option A) | ⚠️ Documented only | gcloud commands verified syntactically, never executed against production. Safe to test — it's non-destructive (just reroutes traffic). |
| Scale-to-zero maintenance mode (Option B) | ⚠️ Documented only | Command is standard Cloud Run; never executed. Brief downtime expected. |
| Firestore read-only rules (Option C) | ⚠️ Documented only | Rules syntax is standard; never deployed. Would block ALL writes including legitimate ones until reverted. |
| Backup restore from BACKUP-2026-10-17-stage1.json | ⚠️ Documented only | File exists and is valid JSON. Restore procedure (import via admin endpoint or manual Firestore write) has NOT been executed. Passwords are stripped by design — users would need password resets after restore. |
| Forward-fix deploy (ROLLBACK.md policy) | ⚠️ Documented only | Standard deploy pipeline; the policy (never redeploy pre-Stage-2) is a process rule, not a technical gate. |

**Before production deployment, the ⚠️ items should be dry-run where safe** (traffic shift is non-destructive and can be tested; backup restore should be tested against the Firestore emulator, not production).

---

## 5. Contacts and references

- **Service URL:** `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/`
- **Repo:** `https://github.com/DanKenan/kashrus-app` (branch `review/stage2-data-integrity` for Stage 2 review)
- **Firestore console:** Firebase project `gen-lang-client-0875538181` → Firestore → database `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d` → `app-state/main`
- **Backup:** `BACKUP-2026-10-17-stage1.json` (repo root; passwords stripped by design)
- **Related docs:** `ROLLBACK.md` (forward-fix policy), `TEST_RESULTS.md` (verification), `ARCHITECTURE_ANALYSIS.md` (full failure-mode analysis)
