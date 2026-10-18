# Manual Verification Checklist (Stage 2 Release)

These checks cannot run in CI (they need a real browser, a real restart, or
production access). Don or the operator runs them during the cutover window.

## 1. Maintenance mode

**Enable** (stops all writes; reads keep working):
```bash
gcloud run services update workers-collaborative-dashboard \
  --set-env-vars FORCE_LOCAL_MODE=true \
  --region us-east1 --project gen-lang-client-0875538181
```

**Verify**:
```bash
# Health reports maintenance
curl -s https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/health | python3 -m json.tool
# Expect: "maintenance": true, "firestore": "maintenance"

# Writes are rejected (login first, capture $TOKEN)
curl -s -X PUT https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/tasks/some-id \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"x"}' | python3 -m json.tool
# Expect: 503, code MAINTENANCE

# Reads still work
curl -s https://workers-collaborative-dashboard-1080260390009.us-east1.run.app/api/tasks?userEmail=kenan@hartfordkashrut.org \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['tasks']), 'tasks')"
```

**Background writes**: the daily-reset cron, media cleanup, and overdue-push
sender all check `FORCE_LOCAL_MODE` and skip while set (verified in code;
the 60s rollover tick is the observable one — leave maintenance on across a
minute boundary and confirm no reset occurs in the logs).

**Disable**:
```bash
gcloud run services update workers-collaborative-dashboard \
  --remove-env-vars FORCE_LOCAL_MODE \
  --region us-east1 --project gen-lang-client-0875538181
# Then verify /api/health shows "maintenance": false
```

## 2. PWA interface (real device)

- [ ] With the OLD client cached: edit a task → expect the 428 message
      ("Your app is out of date. Please refresh…"). The form must NOT clear.
- [ ] Tap "Update App" → new client loads.
- [ ] With the new client: complete a task, add a check-in with photo,
      edit notes → all succeed.
- [ ] In two browser tabs (or two devices): edit the same task's title in
      both → the second gets "Conflict: the data changed…" (409), the first
      one's value is intact. No silent overwrite.
- [ ] Draft banner: if a 428 is ever hit, refresh → "Unsaved change
      preserved" banner appears → Re-apply works, Discard works.

## 3. Restart behavior

- [ ] Note the current `_v` (`/api/__test__` is test-only; use the
      `X-State-Version` response header on any API call, or the version shown
      in health if exposed).
- [ ] Restart the Cloud Run revision (or redeploy). After boot:
  - Login works with the existing password (pepper stable — no forced resets).
  - Task/team data intact; no resurrection of deleted items.
  - A password-reset code requested BEFORE the restart still verifies
    (pepper persisted to Firestore).
- [ ] `FIRESTORE_MOCK=true` can never reach production: the server refuses to
      start when `K_SERVICE` is set (verified in code; do not test on prod).

## 3b. Staged-revision guard (during cutover, Step 4 of CUTOVER.md)

After the staged deploy, before cutover:
- [ ] `curl -s "$STAGED_URL/api/health"` → `"staged": true`,
      `"firestore": "connected"`, `"stage2": true`.
- [ ] Write probe refused (no auth needed — the guard runs before auth):
      `curl -s -X POST "$STAGED_URL/api/tasks" -H 'Content-Type: application/json' -d '{"title":"probe"}'`
      → 503, code `NOT_YET_LIVE`.
- [ ] Reads work: `curl -s "$STAGED_URL/api/tasks"` → 200 (auth as usual).
- [ ] After cutover, production health shows `"staged"` false/absent and
      `"maintenance"` false; no `NOT_YET_LIVE` in the logs.

## 4. Production readiness (Don, before cutover)

- [ ] Firestore security rules: confirm the deny-all `firestore.rules` is
      DEPLOYED in the Firebase console for database
      `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`
      (the PWA only uses Firestore directly for a connection test; the API
      does all data access, so deny-all breaks nothing).
- [ ] `RESET_CODE_PEPPER` set as a Cloud Run env var (32+ random bytes).
- [ ] Kiosk PINs rotated (2 mashgichim affected by the Oct 17 backup exposure).
- [ ] JWT secret: rotate only if the Firestore rules were found open
      (rotating logs out all users — Don's call).
- [ ] Git history scrubbed of `BACKUP-2026-10-17-stage1.json` (or repo made
      private + tokens rotated — Don's decision).
- [ ] Fresh backup taken, counts + version recorded in BACKUP_RESTORE.md.
- [ ] PR #2 merged (admin/export hotfix) before PR #1.
