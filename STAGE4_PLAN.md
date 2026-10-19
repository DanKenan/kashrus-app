# Shutfey — Stage 4 Plan: Operations Runbook, Monitoring, Backups, Security Hardening

**Status:** Plan document — no code changes. Reviewer-grade.
**Author:** Amuse (for Don Kenan), 2026-10-18
**Precondition:** Stage 3 complete and stable (per-entity Firestore layout, media in Cloud Storage, secrets in Secret Manager).
**Branch for implementation:** to be created after Stage 3 is live (suggested: `stage4/ops-hardening`).

---

## 0. Operating reality (design constraint)

Don is the entire ops team. There is no on-call rotation, no SRE, no staging environment that anyone watches. Every procedure in this document must be:

1. **Executable by one non-engineer** with a terminal and the runbook open — copy-paste commands, expected outputs, and "if this looks wrong, stop" checkpoints.
2. **Rare.** Anything that needs doing weekly will eventually not get done. Automate or delete.
3. **Boring.** No cleverness. The Stage 2 cutover taught us that explicit verification beats assumed safety every time.

---

## 1. Ops runbook

### 1.1 Deploy checklist (routine deploys, post-Stage-3)

Stage 3+ deploys are lower-risk than the Stage 2 migration (no data-model cutover), but the discipline stays:

- [ ] CI green on the merge commit (full test suite + `tsc`).
- [ ] Independent review for anything touching write paths, auth, or backups (Don's standing rule — no unreviewed production pushes).
- [ ] Fresh Tier 1 backup taken before merge (automated — see §3; verify the latest automated backup completed within the last 24h).
- [ ] Merge to `main` (Don, daylight). Auto-deploy creates the revision at the workflow's configured traffic behavior.
- [ ] Verify: `/api/health` → `firestore: connected`; Don's 30-second verify (team screen, one task create/complete/delete).
- [ ] Watch logs for 10 minutes: `commitState` errors, 409/503 spikes.

### 1.2 Maintenance window procedure

Builds on the PR #3 `MAINTENANCE_MODE` switch (old server) and Stage 2's `FORCE_LOCAL_MODE` (new server). The runbook procedure (refine from CUTOVER.md's maintenance steps):

1. Announce: the app shows a friendly maintenance banner (client already handles 503 `MAINTENANCE`).
2. `gcloud run services update workers-collaborative-dashboard --update-env-vars MAINTENANCE_MODE=true --region us-east1 --project gen-lang-client-0875538181`
3. **Verify — do not assume:** `curl /api/health` → `maintenance: true`; one test mutation → 503; Cloud Run request log shows no mutating requests for 60s; Firestore `_v`/per-entity versions stable.
4. Do the work.
5. `--remove-env-vars MAINTENANCE_MODE`; verify health `maintenance: false`; Don smoke-tests one write.

**Key lesson carried forward:** "60 seconds quiet" is evidence, not proof. The revised CUTOVER.md requires explicit traffic/revision/instance-state checks — the runbook keeps that requirement for every maintenance window, not just the Stage 2 cutover.

### 1.3 Incident response

EMERGENCY.md remains the incident runbook — Stage 4 does not rewrite it, only keeps it current:

- After every Stage 3/4 change, update the "Tested vs documented-only" table (the table is the most valuable part of that doc — it tells Don what's real).
- Quarterly: re-read EMERGENCY.md end-to-end and fix anything that drifted from reality (stale commands, renamed env vars). Put a recurring calendar reminder — this is the one manual ops task that survives the "automate or delete" rule because incidents are rare and the doc is the plan.

**Escalation path (one-admin operation):** Don → assistant (me). There is no one else. The runbook must therefore prefer *safe degraded states* (maintenance mode, scale-to-zero) over *diagnosis under pressure*. "Stop the bleeding, then think" is already EMERGENCY.md's principle 3 — keep it.

---

## 2. Monitoring

### 2.1 What to watch

| Signal | Why | Where | Alert threshold |
|---|---|---|---|
| Cloud Run 5xx rate | App is erroring | Cloud Monitoring, service dashboard | > 1% of requests over 5 min |
| Firestore write errors (`ABORTED`, `FAILED_PRECONDITION`) | Contention or size-limit regressions | Cloud Logging, structured `commitState` logs | Any occurrence (should be zero) |
| Failed-write counter > 0 | Silent-loss canary | `/api/health` or admin endpoint exposing the counter | Any increment |
| Failed login spike | Attack or auth regression | Cloud Logging (`/api/auth/login` 401s) | > 20 failures / 5 min |
| Backup job failure / staleness | Recovery readiness | Cloud Scheduler + GCS object timestamps | No successful backup in 26h |
| Firestore usage vs free quota | Cost surprise | Firebase console / Cloud Monitoring | 70% of daily free quota |
| Storage bucket growth | Runaway uploads | GCS metrics | > 5 GiB total (10× expected) |
| Certificate / domain (if custom domain added) | Outage | Uptime check | Expiry < 14 days |

### 2.2 Concrete GCP setup (one-time, ~1 hour)

1. **Uptime check** on `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health` — 5-min interval, alert on 2 consecutive failures.
2. **Log-based alerts** (Cloud Logging → Alerting):
   - `severity=ERROR` on the Cloud Run service → notification.
   - `jsonPayload.message =~ "commitState.*failed"` → notification. (Server logs are structured JSON on Cloud Run — text lives in `jsonPayload.message`, not `textPayload`.)
   - `httpRequest.status=503 AND httpRequest.requestUrl =~ "/api/"` spike → notification (maintenance mode is intentional; unexpected 503s are not — correlate with deploys).
3. **Notification channel:** Don's phone (SMS via the alerting notification channel) + email. One channel is fine — two is better. Don chooses.
4. **Dashboard:** a single Cloud Monitoring dashboard with the table above — request rate, 5xx rate, Firestore reads/writes vs quota, Storage bytes. Bookmark it; it's the "is the app healthy" page.

### 2.3 Don's daily 2-minute health check

No dashboards required. Every morning (or whenever he opens the app):

1. Open the app — it loads, team screen shows 6 users. (If not: check the status dashboard.)
2. Glance at yesterday's backup confirmation (automated email/log — see §3). One line: "backup OK, N tasks, M venues, vK."

That's it. Anything deeper is the assistant's job on request, not Don's daily burden.

---

## 3. Backups (operationalized)

BACKUP_RESTORE.md defines the two-tier model. Stage 4 makes it run itself.

### 3.1 Automated schedule

- **Tier 1 (sanitized export):** daily, via Cloud Scheduler → Cloud Run job or Cloud Function that reads Firestore **directly** through the backup service account's IAM permissions (`datastore.entities.list`/`datastore.entities.get`), assembles the sanitized export (same strip rules as the operator endpoint), encrypts → writes to `gs://<backup-bucket>/tier1/<date>.json.enc`. Retention: 30 days. It **never** calls `GET /api/admin/export` — the user-facing endpoint is a human-operator tool, not the automated disaster-recovery path.
- **Tier 2 (full-fidelity):** weekly, via `gcloud firestore export` to `gs://<backup-bucket>/tier2/<date>/` (native Firestore export format — the only format that restores hashes, preserving logins). Retention: 90 days. Plus: one Tier 2 export before every production deploy (manual trigger, same pipeline).
- **Bucket:** separate from the media bucket, private, uniform access, **no public readers**, lifecycle rules enforcing the retention above.

**Service-account backup access (not an admin token):** the scheduled job authenticates as a dedicated GCP service account with a custom IAM role: `datastore.entities.list`/`datastore.entities.get` on the app's collections, `storage.objects.list`/`storage.objects.get` on the media and backup buckets, `secretmanager.versions.access` on the three app secrets (for the recovery drill — not for the daily backup). It has **no** write access to user data. `/api/admin/export` remains a human-operator tool; it is not the automated DR path.

### 3.1b Recovery components (each documented separately)

A Firestore managed export does **not** capture everything needed for recovery. The complete recovery set is:

| Component | Captured by | Restored by | Verified in drill |
|---|---|---|---|
| Firestore documents (all collections) | Tier 2 managed export | Managed import to throwaway/prod DB | Counts + hashes |
| Cloud Storage media objects | **Byte copies** in the backup bucket (Storage Transfer Service / `gsutil rsync`, nightly) — actual recoverable objects, not an inventory | Copy-back from the backup bucket; per-object SHA-256 vs manifest | Every object byte-verified |
| Secret Manager values | **Not in Firestore exports** — separate: encrypted snapshot of secret *metadata* (names, versions, rotation dates); values re-created from Don's password manager / re-issued | Manual per §2.2 procedures | Read-back access check |
| Firestore index definitions | `firestore.indexes.json` in git (deployed via `firebase deploy --only firestore:indexes`) | Index redeploy; build completion check | Index list diff |
| Cloud Run service config (env vars, traffic) | Exported service YAML in git-ignored ops dir (no secrets) | `gcloud run services replace` (minus secrets, re-attached) | Health check |

If any row has no verified restore, the backup is incomplete — say so in the drill log rather than assuming coverage.

### 3.2 Verification (automated, not trusted)

After every backup job:
- Tier 1: decrypt → parse → per the new per-entity layout (there is no global `_v` anymore): assert every expected collection is present, per-collection counts are > 0 and match the manifest, **every document carries a numeric per-entity `_v`**, per-entity content hashes match the manifest, no `password`/`passwordHash`/`kioskPin` fields present (the strip check from test 18, run against the real artifact).
- Tier 2: assert the export completed (operation status `SUCCESSFUL`) and metadata lists the expected collections.
- On any failure: alert Don (same channel as §2.2) and keep the previous good backup — never delete the last good backup on a failed run.

### 3.3 Restore drill cadence

- **Quarterly:** restore drill against a **throwaway database**. Alternate the tiers: one quarter the Tier 1 sanitized export, the next quarter the **full-fidelity Tier 2 backup including media** (Firestore restore + restore of the actual media byte-copies from the backup bucket + per-object SHA-256 verification against the manifest — every object, not a sample). The full-fidelity drill must happen **at least twice a year** — a sanitized-export drill alone does not prove the media or secret-recovery paths work.
- **What the full-fidelity drill verifies:** per-collection counts match the manifest, **per-entity `_v` present and numeric on every document**, per-entity content hashes match (§3.4 of STAGE3_PLAN.md), every restored media object byte-verified against its manifest checksum, Secret Manager values are readable by the service account, required indexes exist.
- **After any backup-pipeline change:** immediate drill (same tier that changed).
- Document each drill (date, tier, result, counts, media objects verified) in BACKUP_RESTORE.md's drill log. A backup you've never restored is a hope, not a plan.

### 3.4 What changes from today

Today backups are manual (`curl` the export endpoint). Stage 4's deliverable is: Don never runs a backup command again, and the first time he needs a restore, the procedure is the quarterly-drilled one, not a first-time improvisation.

---

## 4. Security hardening (remaining items)

These are the known-open items, collected in one place with owners and order:

### 4.1 Firestore Security Rules — verify deny-all is deployed (Don, before Stage 3)
The PWA's only direct Firestore use is a connection test; all data flows through the Express API (Admin SDK, bypasses rules). Deploying deny-all rules breaks nothing and closes the "wide open" finding from October. **Verify in the Firebase console** (database `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`): rules = `allow read, write: if false` on all documents. Record the verification date. (This has been "Don's Sunday-morning item" since Oct 18 — it must be confirmed, not assumed.)

### 4.2 Secret Manager migration (Stage 3 implements; Stage 4 verifies)
Per STAGE3_PLAN.md §2.2: pepper, VAPID private key, JWT secret move to Secret Manager. Stage 4 verification: confirm no secret material remains in any Firestore document (query `app-meta/config` — must contain only the public VAPID key and non-sensitive flags), and that the Firestore-fallback code path is removed after 30 days.

### 4.3 Kiosk PIN rotation procedure
- The October backup exposure included 2 populated kiosk PINs. Rotation is a Don-side task (communicate new PINs to the 2 mashgichim).
- Going forward: PINs are set in the Team modal, stored per-user, never exported (Stage 2 strips them from exports — verified by test 18). Document the rotation steps (generate → set → communicate → confirm the mashgiach can log in) so it's a 5-minute task, not a project.

### 4.4 Admin export agency-scoping (the reviewer's open note)
**The gap:** PR #2 made `/api/admin/export` admin-only, but an agency admin can still export *every* agency's data. 
**Design for the fix:**
- Add an `agencyId` filter to the export: non-super-admins get only their own agency's entities (users, venues, tasks, notes, incidents, announcements scoped by `agencyId`).
- Define the super-admin concept explicitly (today: is there one? Don is the HKC admin — decide whether a cross-agency role exists or whether Don holds two agency-scoped adminships).
- The Tier 1 automated backup (service account) keeps full scope — it's the DR path, not a user path.
- Test: agency-B admin exports → assert zero agency-A entities in the output.
- This is a **small, well-scoped change** — a good first task for the post-Stage-3 cycle, not a redesign.

### 4.5 Dependency updates
- Quarterly `npm audit` + dependency bumps, in a PR, with CI green. The app's dependency surface is small (Express, Firebase Admin, bcrypt, web-push) — this is a 30-minute task, not a project.
- Pin a Node version in the deploy pipeline (already Node 22 in CI; ensure the Cloud Run buildpack uses the same).

### 4.6 Audit logging for admin actions
- Log admin mutations (user create/deactivate, PIN changes, exports, maintenance toggles) with actor, timestamp, and target to a dedicated `auditLog` collection (append-only, per-agency docs like `historyLogs`).
- Why: today there is no record of *who* changed *what* administratively. For a two-agency operation with kiosk PINs and exports, this is the missing accountability layer.
- Keep it minimal: one helper, called from the ~10 admin endpoints. No UI in Stage 4 (read via Firestore console); UI later if Don wants it.

### 4.7 Git history + token hygiene (carryover — verify done)
- The October backup was removed from `main`'s working tree, but git history still contains it until the history rewrite Don planned. Verify: `git log --all -- BACKUP-*.json` should return nothing after the rewrite.
- Old GitHub tokens (Oct 15–18) deleted; repo visibility decision (private?) recorded.

---

## 5. Costs (labeled estimate + verification plan, us-east1, Blaze pay-as-you-go)

**This is an ESTIMATE, not a prediction.** Cloud pricing changes, and "free tier" has sharp edges. The plan below includes how to check the actual bill — the estimate is a starting hypothesis, the billing console is the truth.

Don's scale: ~6 users, bursty human-paced usage, ~500 writes/day, ~12K reads/day, <1 GiB storage, <0.5 GiB media.

| Service | Usage | Free tier | Estimated cost |
|---|---|---|---|
| Cloud Run | ~50K requests/mo, low vCPU | 2M req, 180K vCPU-s, 360K GiB-s /mo | **~$0** |
| Firestore (Native) | ~360K reads, ~15K writes /mo | 50K reads + 20K writes **per day** | **~$0** |
| Cloud Storage (media) | ~0.5 GiB, few thousand ops | 5 GiB-mo, 5K Class A + 50K Class B /mo | **~$0** |
| Cloud Storage (backups) | ~1 GiB versions | Same free tier (shared) | **~$0** |
| Cloud Scheduler | 2 jobs (daily + weekly) | 3 jobs free | **~$0** |
| Secret Manager | 3 secrets | $0.06 per active secret version /mo (no free tier) | **~$0.18/mo** |
| Cloud Monitoring/Logging | Default metrics | Generous free tier | **~$0** |
| **Total** | | | **~$0.18/mo (estimate)** |

**Sharp edges the estimate does NOT assume away:**
- **Firestore free tier covers only ONE database per project.** The Stage 3 migration uses throwaway named databases for staging/dry-runs — those live in the same project and share/exceed the free quota if used heavily. Keep staging databases short-lived and delete them after verification.
- **Managed backups, restores, and TTL deletions have billing implications** beyond the table above: Firestore managed export/restore operations are billed (not free-tier-covered at all usage levels); TTL-policy deletions count as writes. The quarterly restore drill has a real (small) cost — budget it, don't discover it.
- **A billing alert is NOT a spending cap.** It sends an email; it does not stop spending. Say this explicitly to Don: if something runs away, the alert tells him at $5 — he still has to act.

**Verification plan (first operational release must INCLUDE these, not just plan for them):**
1. **Real billing alert active:** Cloud Billing budget at $5/mo, notification to Don's email + phone, verified by triggering a test notification during setup.
2. **First verified backup exists:** one Tier 1 automated backup completed + verified (decrypt, counts, strip-check) and one Tier 2 export completed — before Stage 4 is declared done.
3. **Monthly 2-minute billing check** (added to Don's routine): open Cloud Billing → confirm current-month spend < $1 → done. If it ever isn't, investigate before the next deploy.

**When would Don actually pay?** Roughly: 10× user growth (60 users, multi-agency) → Firestore ~$2–5/mo; 100× → ~$20–40/mo. Media is the wild card — 10,000 photos/mo ≈ 5 GiB ≈ $0.10/mo storage; still trivial. Honest message: **this app should cost essentially nothing at Don's scale, and the billing check above is how we confirm that monthly instead of assuming it.**

---

## 6. Stage 4 acceptance criteria

1. Don hasn't run a manual backup in 90 days; the drill log shows 1+ successful quarterly restores, including at least one **full-fidelity drill** (Tier 2 + media + secret read-back) in the last 12 months.
2. The monitoring dashboard exists; Don got zero false-positive pages in 90 days (alerts are tuned or they're noise).
3. Firestore rules verified deny-all; no secrets in any Firestore document; `git log` shows no backup files.
4. Admin export is agency-scoped (reviewer's note closed) with a passing test.
5. Audit log records admin actions; `npm audit` clean within the quarter.
6. **Billing alert at $5/mo active with a verified test notification;** monthly billing check shows actual spend < $1/mo (or the overage is understood and accepted).
7. EMERGENCY.md's "tested vs documented" table has no stale rows.
8. The recovery-components table (§3.1b) has a verified restore for **every** row — Firestore, media, secrets, indexes, service config. No row is "assumed."

**Relationship to Stage 3:** the §9 release gates in STAGE3_PLAN.md (full-fidelity backup/restore, media coverage, secret recovery, alerts, maintenance procedure, access controls, export scoping, service-account backups) are the **prerequisites** for the Stage 3 cutover. Stage 4 operationalizes what Stage 3 proves once: automated schedules, quarterly drills, and the ongoing hygiene above.

---

## 7. Stage 4 PR checklist (added 2026-10-18 — ChatGPT review)

| PR | Item | Status | Needs Don's OK? |
|---|---|---|---|
| 3C | Secrets → Secret Manager (PR #16) | Open, awaiting review | **YES — cutover step** (setting `USE_SECRET_MANAGER=true`); rotation is separate |
| A | Consistency + monolith-size monitor (PR #15) | Open, CI green | No — read-only; scheduler job setup is Don's console work |
| B | Automated backups (Tier 1 + Tier 2, Cloud Run Job) | Planned, not yet coded | No for Tier 1; **YES** for any restore test touching prod. **Restore drills: throwaway database ONLY — never test against production.** Media retention: **30 days from original upload applies to every backup copy**, regardless of Tier 2 90-day retention. |
| C | Uptime / error / backup-staleness / billing ($5/mo) alerts | Planned | No — Don confirmed: **email for all alerts, SMS for urgent** |
| D | Runbook + security-hardening verification | Planned | — |
| — | Agency-scoped admin export | Planned (from §4.4) | **YES** — needs Don's call on super-admin model |
| — | Admin audit log | Planned (from §4.6) | No |
| — | Dependency checks (`npm audit` quarterly) | Planned (from §4.5) | No |
| — | Git-history / token hygiene verification | Planned (from §4.7) | **YES** — history rewrite is destructive |
| — | JWT/VAPID secret rotation | Propose only | **YES — explicit** |
| — | Kiosk PIN rotation | Propose only (dropped by Don 2026-10-18) | **YES — explicit** (do not raise unprompted) |
| — | Firestore rules changes | Propose only | **YES — explicit** |
| — | Deleting any data | Propose only | **YES — explicit** |
| — | Ingredients / factory-inspections redesign | **DEFERRED** — Don deciding with his team; top priority when it happens | **YES** — design together, don't touch now |

*End of Stage 4 plan. This is the "boring operations" stage — its success metric is that Don never thinks about infrastructure.*
