# PWA Update Handling for Stage 2

## What actually happens (verified)

After Stage 2 deploys, devices may still run the OLD cached PWA JavaScript.
The version contract handles this explicitly — it was designed for exactly
this case, and the server behavior is covered by automated tests.

### Old cached clients (no version support)

Old clients send updates (PUT/DELETE) without `expectedVersion`. The server
does NOT accept these blindly. For updates to existing data it returns:

- **428 STALE_CLIENT** — "Your app is out of date. Please refresh the app to
  get the latest data — your unsaved input is preserved — then try again."

Verified by test 15: a version-less PUT returns 428 (not 409, not 200), the
write is rejected, and the existing data is untouched.

The old client shows this as an error toast (its old `apiWrite` doesn't know
code 428, so it displays the server's message text). The user's form input
stays in the open modal — old modals only close on success, so nothing is
cleared. The user refreshes (or taps "Update App") and retries.

### New clients (this release)

- Every API response carries `X-State-Version`; every WebSocket message
  carries `version`. The client tracks the highest seen (verified: test 15
  asserts the header is present and matches the document version).
- `apiWrite()` automatically attaches the tracked version to PUT/PATCH/DELETE
  (verified in code; the auto-injection is exercised by the test suite's
  update calls, which now all send versions).
- On 428, `apiWrite()` persists the attempted write as a draft in
  localStorage (key, label, endpoint, method, body) and the app shows a
  banner after refresh: "Unsaved change preserved" with **Re-apply** (resends
  with the fresh version) and **Discard**. Verified in code; the banner and
  re-apply flow have not been exercised in a real browser from this
  environment (no browser test harness) — Don should confirm on his device.

### What old clients experience (summary)

| Scenario | Old client behavior | Data safe? |
|---|---|---|
| Normal write, no version sent | 428 STALE_CLIENT, clear "please refresh" message | ✅ Rejected, not applied |
| Write after refreshing / updating | Works normally (200) | ✅ |
| Retry after timeout (no operationId) | May create duplicate | ⚠️ Possible duplicate; new client eliminates it |
| 409 VERSION_CONFLICT | Only for new clients (old ones get 428 instead) | ✅ |
| 503 (Firestore down) | Generic "couldn't save" | ✅ Not marked as saved |
| Reads (GET) | Unchanged, always current | ✅ |

## Why this is safe (no data loss)

1. **The server is authoritative and fail-closed.** A client that can't prove
   it saw the current version cannot update existing data. There is no code
   path where a version-less update is silently applied.
2. **No fake success.** Stage 2 never returns 200 for a failed write.
3. **Drafts are never silently discarded.** On 428 the new client saves the
   draft before the user refreshes; the old client keeps the modal open with
   the input intact.

## How clients get the update

1. **Automatic**: on next app open, the service worker checks for a new
   version in the background; the user sees it on the following open.
2. **Manual**: the "Update App" button forces an immediate update check.

### Recommended rollout (Don)
1. After cutover, open the PWA → tap "Update App" → confirm it loads.
2. Ask the 5 mashgichim to tap "Update App" at the next convenient moment.
   Not urgent: old clients are safe (428 + clear message), just less graceful.

## Manual verification needed (not automatable here)

- [ ] On a real device: with the OLD client cached, edit a task → expect the
      428 "please refresh" message (not a silent failure, not a crash).
- [ ] Tap "Update App" → new client loads → edit a task → expect success.
- [ ] With the new client: trigger a 428 (e.g., airplane-mode timing is hard;
      easiest is to wait for a real conflict), refresh, and confirm the
      "Unsaved change preserved" banner appears with working Re-apply.
- [ ] Confirm no form clears its input on a failed write.
