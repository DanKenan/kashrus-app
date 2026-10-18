# Stage 4 — Monitoring & Alerts Setup

Don's console steps for every alert. All alerts go to the **email** notification
channel (`kenandan770@gmail.com`); the urgent ones (uptime, backup failure)
also go to **SMS** (`+1 347-670-0381`).

> These are Don-side GCP console steps. Nothing here runs automatically until
> Don creates the checks. Each section cites the Google doc it follows
> (checklist point 9).

---

## 0. Notification channels (do first)

1. Cloud Console → Monitoring → Alerting → Notification channels.
2. Add **Email**: `kenandan770@gmail.com` → name it `don-email`.
3. Add **SMS**: `+1 347-670-0381` → name it `don-sms-urgent`.
4. Click the verification link/code for each.

Doc: https://cloud.google.com/monitoring/support/notification-options

---

## 1. Uptime check — `/api/health` every 5 minutes (URGENT: email + SMS)

Alerts if the app stops responding. Fires after 2 consecutive failures
(~10 minutes of downtime).

1. Monitoring → Uptime checks → Create uptime check.
2. **Target**: URL — `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health`
3. **Check every**: 5 minutes. **Regions**: keep the default set.
4. **Response validation** (optional but recommended): Content match —
   contains `"status":"ok"`. (The endpoint returns `status: ok|degraded|maintenance`;
   `degraded` means Firestore isn't connected.)
5. **Alert policy**: Create alert → Condition: "Uptime check failure" →
   **2 consecutive failures** → Notify `don-email` + `don-sms-urgent`.
6. Name: `shutfey-uptime`.

To test: stop the Cloud Run service briefly (or block the URL), wait ~10 min,
confirm email + SMS arrive, then restore.

Doc: https://cloud.google.com/monitoring/uptime-checks

---

## 2. Log-based alerts (email; backup/consistency = URGENT: email + SMS)

Log-based alerting watches Cloud Logging for matching lines and fires a
Monitoring alert.

Doc: https://cloud.google.com/logging/docs/alerting/log-based-alerts

### 2a. HTTP 5xx spike (email)

Catches server errors before users report them.

1. Logging → Logs Explorer → run this query:
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="workers-collaborative-dashboard"
   httpRequest.status>=500
   ```
2. **Create alert** (top of the query results).
3. Condition: count of matching log entries **> 5 in 5 minutes**.
4. Notify `don-email`. Name: `shutfey-5xx-spike`.

### 2b. `commitState` failures (email)

`commitState` is the Stage 2 transactional write path — a failure here means
data may not have saved.

1. Logs Explorer query:
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="workers-collaborative-dashboard"
   "[commitState]"
   severity>=WARNING
   ```
   (Adjust the severity/text to match the actual log lines in `server.ts` —
   search `[commitState]` first to see the real format.)
2. Create alert → any matching entry → Notify `don-email`.
   Name: `shutfey-commit-failures`.

### 2c. Backup / consistency ERROR lines (URGENT: email + SMS)

The backup job logs `[backup] FAILED`, and the consistency monitor logs
`[consistency] ERROR`. Either means recovery infrastructure is broken.

1. Logs Explorer query:
   ```
   resource.type="cloud_run_revision"
   ("[backup]" OR "[consistency] ERROR" OR "[alert-test] TEST ALERT")
   severity>=ERROR
   ```
   Note: `[alert-test] TEST ALERT` is included so Don's manual test from
   `/admin/media-check` verifies this alert fires end-to-end.
2. Create alert → any matching entry → Notify `don-email` + `don-sms-urgent`.
   Name: `shutfey-backup-consistency-error`.

To test: fire the test alert from `/admin/media-check` → "Fire Test Alert" →
confirm email + SMS arrive.

### 2d. Cloud Run Job execution failure — `shutfey-backup-tier1` (URGENT: email + SMS)

Fires when the nightly backup job itself fails (crash, IAM denial, timeout).

1. Monitoring → Alerting → Create policy → Add condition.
2. **Metric**: `run.googleapis.com/job/completed_execution_count` —
   filter `job_name="shutfey-backup-tier1"`, `result="failed"`.
   (Alternative: Logs Explorer query on
   `resource.type="cloud_run_job" AND resource.labels.job_name="shutfey-backup-tier1"`
   with `severity>=ERROR`, then Create alert.)
3. Condition: any failed execution in 1 hour → Notify `don-email` + `don-sms-urgent`.
   Name: `shutfey-backup-job-failed`.

Doc: https://cloud.google.com/run/docs/monitoring#viewing-job-metrics

---

## 3. Billing budget — $5/month (email)

Not a spending cap — just an early warning if costs move unexpectedly.
At Don's scale the app costs ~$0.18/month.

1. Billing → Budgets & alerts → Create budget.
2. **Scope**: project `gen-lang-client-0875538181`.
3. **Amount**: $5/month.
4. **Alert thresholds**: 50%, 100% (default) → Notify `don-email`.
5. Name: `shutfey-monthly-5usd`.

To test: temporarily set the budget to $0.01, confirm the email arrives,
then set it back to $5.

Doc: https://cloud.google.com/billing/docs/how-to/budgets

---

## 4. Consistency-check cadence (ties into §2c)

The `/api/internal/consistency-check` endpoint (which includes the 26-hour
backup-staleness check) must run every **4–6 hours**, not just daily —
a daily check can't reliably catch a 26-hour threshold.

Don's scheduler command (from PR #19's body, step 6):

```bash
gcloud scheduler jobs create http shutfey-consistency-check \
  --project=gen-lang-client-0875538181 --location=us-east1 \
  --schedule="0 */4 * * *" --time-zone="America/New_York" \
  --uri="https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/internal/consistency-check" \
  --http-method=POST \
  --oidc-service-account-email=shutfey-scheduler@gen-lang-client-0875538181.iam.gserviceaccount.com \
  --oidc-token-audience="https://workers-collaborative-dashboard-1080260390009.us-east1.run.app"
```

If the check returns non-2xx (mismatch, stale backup, oversized monolith),
Scheduler retries and the §2c log alert fires.

---

## Summary table

| Alert | Type | Notify | Test |
|---|---|---|---|
| Uptime `/api/health` 5 min, 2 failures | Uptime check | email + SMS | Block URL 10 min |
| HTTP 5xx > 5 in 5 min | Log-based | email | — |
| `[commitState]` failures | Log-based | email | — |
| `[backup]`/`[consistency] ERROR` | Log-based | email + SMS | Fire test alert |
| Backup job execution failed | Metric/log | email + SMS | — |
| Billing $5/month | Budget | email | Set $0.01 briefly |

**Reminder:** Don's alert contacts are `kenandan770@gmail.com` (all alerts)
and SMS `+1 347-670-0381` (urgent only). Verify each channel before relying
on it.
