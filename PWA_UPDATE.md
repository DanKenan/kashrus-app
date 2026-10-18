# PWA Update Handling for Stage 2

## Problem

After Stage 2 deploys, users' devices may still run the OLD cached PWA
JavaScript. These old clients will hit new Stage 2 endpoints and may receive
error responses they weren't designed for:
- **409 VERSION_CONFLICT**: old clients don't send `expectedVersion`, so the
  server can't detect stale edits for them. They'll get generic errors on
  conflicting writes.
- **409 PAYLOAD_MISMATCH**: old clients don't send `operationId`, so no impact.
- **503 SAVE_FAILED / MAINTENANCE / SIZE_LIMIT**: new error codes old clients
  don't recognize.

## Why This Is Safe (No Data Loss)

The server is authoritative. The worst case for an old client is a confusing
error message — never silent data corruption:

1. **Old clients can't corrupt data**: all writes go through the server's
   transactional path. If an old client's write is stale, the server rejects
   it (409) rather than applying it blindly.
2. **No fake success**: Stage 2 never returns 200 for a failed write. If the
   old client shows "saved", the data really was saved.
3. **Reads are unaffected**: GET endpoints are unchanged. Old clients see
   current data.

## How Clients Get the Update

The PWA uses a service worker. Updates flow:

1. **Automatic**: on next app open, the service worker checks for a new
   version in the background and installs it. The user sees the new version
   on the *following* open (standard PWA lifecycle).
2. **Manual**: the "Update App" button on the landing page forces an immediate
   update check and reload. Don added this in Stage 1 for exactly this purpose.

### Recommended rollout
After the Stage 2 deploy:
1. Don opens the PWA on his phone → taps "Update App" → confirms the new
   version loads (check: task completion shows the new UI).
2. Don asks the 5 mashgichim to tap "Update App" on their devices at the
   next convenient moment (not urgent — old clients are safe, just less
   graceful on conflicts).

## What Old Clients Experience

| Scenario | Old client behavior | Data safe? |
|---|---|---|
| Normal write (no conflict) | Works normally (200) | ✅ |
| Conflicting write | Generic error toast (no `expectedVersion` sent, so server can't give a specific 409) | ✅ Rejected, not applied |
| Retry after timeout | May create duplicate (no `operationId`) | ⚠️ Possible duplicate; server can't deduplicate without the ID |
| 503 (Firestore down) | Generic "couldn't save" (doesn't recognize new codes) | ✅ Not marked as saved |

The duplicate-on-retry case is the only real wart, and it's bounded: it
requires a network timeout at exactly the wrong moment AND the user retrying.
The new client (with `operationId`) eliminates it entirely.

## No Action Required From Users

- Users don't need to do anything special.
- Worst case is a confusing error message, not data loss.
- The update happens automatically; "Update App" just speeds it up.
