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
   - `textPayload =~ "commitState.*failed"` → notification.
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

- **Tier 1 (sanitized export):** daily, via Cloud Scheduler → Cloud Run job or Cloud Function: `GET /api/admin/export` (service-account auth) → encrypt → write to `gs://<backup-bucket>/tier1/<date>.json.enc`. Retention: 30 days.
- **Tier 2 (full-fidelity):** weekly, via `gcloud firestore export` to `gs://<backup-bucket>/tier2/<date>/` (native Firestore export format — the only format that restores hashes, preserving logins). Retention: 90 days. Plus: one Tier 2 export before every production deploy (manual trigger, same pipeline).
- **Bucket:** separate from the media bucket, private, uniform access, **no public readers**, lifecycle rules enforcing the retention above. Consider Object Versioning off (exports are immutable by date path) and a second-region copy if Don wants it (costs double storage — ~$0.02/GiB/mo — say so explicitly).

### 3.2 Verification (automated, not trusted)

After every backup job:
- Tier 1: decrypt → parse → assert required top-level keys present, counts > 0, `_v` is a number, no `password`/`kioskPin` fields present (the strip check from test 18, run against the real artifact).
- Tier 2: assert the export completed (operation status `SUCCESSFUL`) and metadata lists the expected collections.
- On any failure: alert Don (same channel as §2.2) and keep the previous good backup — never delete the last good backup on a failed run.

### 3.3 Restore drill cadence

- **Quarterly:** restore the latest Tier 1 backup to a **throwaway database**, verify counts, delete the throwaway. 30 minutes, assistant-guided, Don observes once then it's routine.
- **After any backup-pipeline change:** immediate drill.
- Document each drill (date, result, counts) in BACKUP_RESTORE.md's drill log. A backup you've never restored is a hope, not a plan.

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

## 5. Costs (honest estimate, us-east1, Blaze pay-as-you-go)

Don's scale: ~6 users, bursty human-paced usage, ~500 writes/day, ~12K reads/day, <1 GiB storage, <0.5 GiB media.

| Service | Usage | Free tier | Expected cost |
|---|---|---|---|
| Cloud Run | ~50K requests/mo, low vCPU | 2M req, 180K vCPU-s, 360K GiB-s /mo | **$0** |
| Firestore (Native) | ~360K reads, ~15K writes /mo | 50K reads + 20K writes **per day** | **$0** |
| Cloud Storage (media) | ~0.5 GiB, few thousand ops | 5 GiB-mo, 5K Class A + 50K Class B /mo | **$0** |
| Cloud Storage (backups) | ~1 GiB versions | Same free tier (shared) | **$0** |
| Cloud Scheduler | 2 jobs (daily + weekly) | 3 jobs free | **$0** |
| Secret Manager | 3 secrets | — ($0.06/secret-version/mo) | **~$0.18/mo** |
| Cloud Monitoring/Logging | Default metrics | Generous free tier | **$0** |
| **Total** | | | **~$0.18/mo** |

**When would Don pay?** Roughly: 10× user growth (60 users, multi-agency) → Firestore ~$2–5/mo; 100× → ~$20–40/mo. Media is the wild card — 10,000 photos/mo ≈ 5 GiB ≈ $0.10/mo storage; still trivial. The honest message: **this app costs essentially nothing to run at Don's scale, and stays under $10/mo until he's 50× bigger.** The $10/mo Postgres from the architecture analysis remains unnecessary.

**Billing guardrail:** set a Cloud Billing budget alert at $5/mo (email to Don). If anything ever misbehaves (runaway function, hot loop), he hears about it at $5, not $500.

---

## 6. Stage 4 acceptance criteria

1. Don hasn't run a manual backup in 90 days; the drill log shows 1+ successful quarterly restores.
2. The monitoring dashboard exists; Don got zero false-positive pages in 90 days (alerts are tuned or they're noise).
3. Firestore rules verified deny-all; no secrets in any Firestore document; `git log` shows no backup files.
4. Admin export is agency-scoped (reviewer's note closed) with a passing test.
5. Audit log records admin actions; `npm audit` clean within the quarter.
6. Billing alert at $5/mo active; actual spend < $1/mo.
7. EMERGENCY.md's "tested vs documented" table has no stale rows.

---

*End of Stage 4 plan. This is the "boring operations" stage — its success metric is that Don never thinks about infrastructure.*
