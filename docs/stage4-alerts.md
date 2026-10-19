# Stage 4 — Monitoring & Alerts Setup

Don's console steps for every alert. All alerts go to the **email** notification
channel (`kenandan770@gmail.com`); the urgent ones (uptime, backup failure)
also go to **SMS** (`+1 347-670-0381`).

> These are Don-side GCP console steps. Nothing here runs automatically until
> Don creates the checks. Each section cites the Google doc it follows
> (checklist point 9). All log filters below were copied from the actual
> `server.ts` / `src/server/*.ts` log lines (grepped 2026-10-18), not from
> memory — see the grep notes inline.

---

## 0. Notification channels (do first)

1. Cloud Console → Monitoring → Alerting → Notification channels.
2. Add **Email**: `kenandan770@gmail.com` → name it `don-email`. Complete verification.
3. Add **SMS**: `+1 347-670-0381` → name it `don-sms-urgent`. Complete verification.

Doc: https://cloud.google.com/monitoring/support/notification-options

---

## 1. Uptime check — `/api/health` every 5 minutes (URGENT: email + SMS)

Alerts if the app stops responding.

1. Monitoring → Uptime checks → Create uptime check.
2. **Target**: URL — `https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health`
3. **Check every**: 5 minutes.
4. **Response validation (REQUIRED)**: Content match — response must contain
   `"status":"ok"`. (`/api/health` returns `status: ok|degraded|maintenance`;
   `degraded` = Firestore not connected, `maintenance` = maintenance mode.
   Either should alert.)
5. **Alert policy**: Create alert → use the **failure-duration** setting:
   alert when the check has failed for **10 minutes** (2 consecutive 5-min
   failures). Notify `don-email` + `don-sms-urgent`.
6. Name: `shutfey-uptime`.

**Safe testing (do NOT stop the production service):**
- Use the uptime check's built-in **Test** button to verify the configuration.
- To test failure-notification delivery, create a *temporary* uptime check
  against a deliberately unavailable URL (e.g. `https://example.invalid/health`),
  confirm the alert fires to email + SMS, then delete the temporary check.

Doc: https://cloud.google.com/monitoring/uptime-checks
(Upcheck testing: https://cloud.google.com/monitoring/uptime-checks#test-check)

---

## 2. Request/error alerts (metric-based)

### 2a. HTTP 5xx rate > 1% over 5 minutes (email)

Stage 4 requires alerting when the 5xx rate exceeds 1% over five minutes.
Use the metric-based alert (not a log count), with low-traffic protection
so a single error on a quiet night doesn't page Don.

1. Monitoring → Alerting → Create policy → Add condition.
2. **Metric**: `run.googleapis.com/request_count` —
   filter `service_name="workers-collaborative-dashboard"`,
   group by `response_code_class`.
3. **Condition**: ratio of `response_code_class="5xx"` to total requests
   **> 0.01 (1%) over a 5-minute window**, AND total requests **> 10**
   in that window (low-traffic guard).
4. Notify `don-email`. Name: `shutfey-5xx-rate`.

Doc: https://cloud.google.com/monitoring/alerting/using-metric-thresholds
(Run metrics: https://cloud.google.com/run/docs/monitoring#viewing-service-metrics)

### 2b. Terminal failed saves — `[commitOrRespond:<label>]` (email)

Real log lines (grepped from `server.ts` 2026-10-18):
- Retry warning (transient, may succeed): `[commitState:save-task] Transaction failed (attempt 1/3)` — `console.warn`
- **Terminal failure**: `[commitOrRespond:save-task] Save failed after 3 attempts` — `console.error`

Alert on the **terminal** failures (data actually lost), not on transient
retries that ultimately succeed.

1. Logging → Logs Explorer → query:
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="workers-collaborative-dashboard"
   severity>=ERROR
   jsonPayload.message =~ "\\[commitOrRespond:[^]]+\\]"
   ```
   (Server logs are structured JSON on Cloud Run: the text lives in
   `jsonPayload.message`, not `textPayload`. Bare-string terms like
   `"[consistency] ERROR"` still match any field, but any `textPayload`
   filter must use `jsonPayload.message`. `severity>=ERROR` is real now —
   plain `console.error` used to land as DEFAULT.)
   (Verify this matches real entries in Logs Explorer before creating the policy —
   the exact label text varies per operation.)
2. Create alert → any matching entry → Notify `don-email`.
   Name: `shutfey-failed-saves`.
3. Optional separate informational filter for retry warnings:
   `jsonPayload.message =~ "\\[commitState:[^]]+\\] Transaction failed"` at
   `severity>=WARNING` — for diagnosis, not paging.

Doc: https://cloud.google.com/logging/docs/alerting/log-based-alerts

### 2c. Unexpected API 503 spike (email)

The app returns 503 for staged-revision and maintenance-mode guards.
A spike outside a planned maintenance window is unexpected.

1. Logs Explorer query:
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="workers-collaborative-dashboard"
   httpRequest.status=503
   ```
2. Create alert → count **> 10 in 5 minutes** → Notify `don-email`.
   (Tune after observing baseline; maintenance windows will trigger this —
   that's acceptable as a confirmation the guard is active.)
   Name: `shutfey-503-spike`.

---

## 3. Backup & consistency alerts (URGENT: email + SMS)

### 3a. Application consistency/backup ERROR logs (email + SMS)

Real log lines (grepped 2026-10-18):
- `src/server/consistency.ts`: `[consistency] ERROR: <reason>` (check failures,
  stale backup, oversized monolith) — `console.error`
- `server.ts` line 3978: `[alert-test] TEST ALERT from Shutfey admin at ...` —
  `console.error` (Don's manual end-to-end test)

1. Logs Explorer query:
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="workers-collaborative-dashboard"
   severity>=ERROR
   ("[consistency] ERROR" OR "[alert-test] TEST ALERT")
   ```
2. Create alert → any matching entry → Notify `don-email` + `don-sms-urgent`.
   Name: `shutfey-consistency-error`.

To test: fire the test alert from `/admin/media-check` → "Fire Test Alert" →
confirm email + SMS arrive.

### 3b. Cloud Run Job failure — `shutfey-backup-tier1` (email + SMS)

Separate from §3a: this watches the **job execution itself** (crash, IAM
denial, timeout), not the application's logs.

1. Monitoring → Alerting → Create policy → Add condition.
2. **Metric**: `run.googleapis.com/job/completed_execution_count` —
   filter `job_name="shutfey-backup-tier1"`.
   Group/filter by the `result` label; alert when `result="failed"`.
   (**Verify the actual `result` label value** in Metrics Explorer before
   finalizing — it may be `"failed"`, `"error"`, or similar.)
3. Condition: any failed execution in 1 hour → Notify `don-email` + `don-sms-urgent`.
   Name: `shutfey-backup-job-failed`.

Doc: https://cloud.google.com/run/docs/monitoring#viewing-job-metrics

---

## 4. Billing budget — $5/month (email)

Not a spending cap — an early warning. At Don's scale the app costs ~$0.18/month.

1. Billing → Budgets & alerts → Create budget.
2. **Scope**: project `gen-lang-client-0875538181`.
3. **Amount**: $5/month. **Thresholds**: 50%, 100%.
4. **Explicitly link Don's Monitoring email channel**: in the budget's
   notification settings, add `kenandan770@gmail.com` (in addition to the
   default billing-account recipients).
   Doc: https://cloud.google.com/billing/docs/how-to/budgets#manage-notifications
5. Name: `shutfey-monthly-5usd`.

**Do NOT test with a $0.01 budget expecting immediate delivery** — budget
notifications can be delayed by hours. Configure the $5 budget, verify the
email channel is linked, and mark actual threshold-triggered delivery as
PENDING until observed in a real billing cycle.

Doc: https://cloud.google.com/billing/docs/how-to/budgets

---

## 5. Consistency-check scheduler (every 4–6 hours)

The `/api/internal/consistency-check` endpoint (includes the 26-hour
backup-staleness check) must run every **4–6 hours** — a daily check can't
reliably catch a 26-hour threshold.

```bash
gcloud scheduler jobs create http shutfey-consistency-check \
  --project=gen-lang-client-0875538181 --location=us-east1 \
  --schedule="0 */4 * * *" --time-zone="America/New_York" \
  --uri="https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/internal/consistency-check" \
  --http-method=POST \
  --oidc-service-account-email=shutfey-scheduler@gen-lang-client-0875538181.iam.gserviceaccount.com \
  --oidc-token-audience="https://workers-collaborative-dashboard-1080260390009.us-east1.run.app"
```

**Verify after creating:**
- The scheduler's OIDC service account (`shutfey-scheduler@...`) must be
  accepted by the app's middleware — the app checks `req.path ===
  '/internal/consistency-check'` with POST (see `server.ts` scheduler-OIDC
  exception). Confirm a manual run returns 200, not 401.
- **Retry policy**: Cloud Scheduler's default `max-retry-attempts` can be 0.
  Check with `gcloud scheduler jobs describe shutfey-consistency-check` and set
  `--max-retry-attempts 3` if needed. **Do not promise automatic retries
  unless the retry count is explicitly configured.**
- If the check returns non-2xx, the §3a log alert fires.

Doc: https://cloud.google.com/scheduler/docs/configuring/cron-job-retries

---

## 6. Monitoring coverage — §2.1–2.3 requirements carried forward

From `STAGE4_PLAN.md` §2.1–2.3. Anything not implemented above is marked
**PENDING** (not dropped).

| Requirement | Status in this doc | Notes |
|---|---|---|
| Uptime check 5 min, alert on failure | ✅ §1 | Failure-duration 10 min; `status:"ok"` validation required |
| 5xx rate > 1% over 5 min | ✅ §2a | Metric-based; low-traffic guard (>10 req) |
| Failed-write alert | ✅ §2b | Terminal `[commitOrRespond]` ERROR; retries separate |
| Failed login spike (>20 in 5 min) | **PENDING** | Needs a log filter on login-failure lines — grep `server.ts` for the actual login-failure log text first |
| Firestore usage at 70% of daily free quota | **PENDING** | Metric `firestore.googleapis.com/document/read_count` (or billing-based); needs threshold research |
| Storage bucket growth above 5 GiB | **PENDING** | Metric `storage.googleapis.com/storage/total_bytes` per bucket |
| Unexpected API 503 spike | ✅ §2c | Log-based; tune baseline after observing |
| Backup staleness / consistency ERROR | ✅ §3a | Email + SMS |
| Backup job execution failure | ✅ §3b | Email + SMS; verify `result` label value |
| Billing $5/month budget | ✅ §4 | Email channel explicitly linked; delivery PENDING first cycle |
| Cloud Monitoring dashboard | **PENDING** | Single dashboard with uptime, 5xx rate, backup age, monolith size — build in console |
| Daily backup confirmation summary | **PENDING** | Options: log-based metric on `[backup] Tier 1 complete` + daily digest, or email via Cloud Function |
| Custom-domain certificate expiry | **PENDING** | Not applicable until a custom domain is added |

---

## Summary

| Alert | Type | Notify | Test |
|---|---|---|---|
| Uptime `/api/health` 5 min, fail 10 min | Uptime check | email + SMS | Built-in Test + temp failing check |
| 5xx rate > 1% / 5 min (>10 req) | Metric | email | — |
| `[commitOrRespond]` terminal failures | Log-based | email | Verify filter in Logs Explorer |
| 503 spike > 10 / 5 min | Log-based | email | — |
| `[consistency] ERROR` / test alert | Log-based | email + SMS | Fire test alert |
| Backup job execution failed | Metric | email + SMS | Verify `result` label |
| Billing $5/month | Budget | email (linked) | PENDING first cycle |

**Don's contacts:** `kenandan770@gmail.com` (all) · SMS `+1 347-670-0381` (urgent only).
Don's actual alert configuration and successful notification tests are separate
operational acceptance gates — this doc is the plan, not the proof.
