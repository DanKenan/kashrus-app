# Rollback Strategy — Stage 2 (Single Transactional Write Path)

> **Forward fix only. There is no safe code-only rollback after Stage 2.**

## Why rollback is not safe

Stage 2 changes the write contract between the server and Firestore:

1. **Every write now carries a monotonically increasing `_v` version field** on the
   `app-state/main` document, checked with strict equality inside a Firestore
   transaction (`expectedVersion !== current _v` → 409 Conflict).
2. **The pre-Stage-2 code has no version checks.** Its `saveState()` wrote the whole
   in-memory document fire-and-forget. If that code were redeployed after Stage 2
   data exists, the first write would silently clobber any concurrent committed
   transaction — exactly the data-loss class Stage 2 was built to eliminate.
3. The `_v` field itself is additive and ignored by old code, but that does not make
   old code safe: old code *writes without reading `_v`*, so it can still overwrite
   newer data.

**Consequence:** once a Stage 2 build has written to Firestore (bumping `_v`),
no pre-Stage-2 build may ever be deployed again against that database.

## What to do instead of rolling back

If Stage 2 has a bug in production:

1. **Fix forward.** Write the fix, test it against the Firestore emulator
   (`npm run test:stage2` — see TEST_RESULTS.md), and deploy the new build.
   Do not redeploy an older build.
2. **If the bug is a bad write that already committed**, the data is in Firestore
   with a valid version chain. Repair it with a forward data migration
   (a new deploy whose boot or admin path corrects the records), not by
   restoring a backup over live data — a restore would resurrect stale versions
   and collide with the `_v` chain.
3. **Disaster recovery only:** `BACKUP-2026-10-17-stage1.json` (repo root,
   passwords stripped by design) exists for total-loss scenarios (e.g. the
   Firestore database itself is destroyed). Restoring it means:
   - The `_v` chain restarts from the backup's version.
   - Any writes committed after the backup was taken are lost.
   - Every client must hard-refresh; any in-flight `expectedVersion` values are stale.
   - This is a last resort, not an undo button.

## Pre-deploy checklist (before any Stage 2 build goes live)

- [ ] All 7 Stage 2 emulator tests pass (`TEST_RESULTS.md`).
- [ ] `npx tsc --noEmit` is clean.
- [ ] No `saveState()` call sites remain outside the deleted legacy function.
- [ ] Don has explicitly approved the deploy (standing rule: no production deploy
      without his explicit approval).

## Version-field contract (for future stages)

- `_v`: integer, starts at 0, increments by exactly 1 per committed transaction.
- Writers must use `commitState()` / `commitOrRespond()` — never write the
  document directly.
- Stage 3 (per-collection sharding) must preserve the per-document `_v` chain or
  provide an explicit migration for it.
