# Section A Fixes — Reviewer Finding → Fix Mapping

Branch: `review/stage2-data-integrity` · PR #1
All changes uncommitted, for review. `npx tsc --noEmit` clean. `npm run test:stage2` → 9/9 pass.

---

## 1. PWA save-error handling (frontend)

**Was wrong:** Multiple write handlers in `src/App.tsx` and components called `res.json()` without checking `res.ok`. On 409/503 the error body would replace real data in state, show false "saved" toasts, or fail silently. Optimistic UI updates had no rollback.

**Changed:**
- `src/lib/api.ts`: new `apiWrite(input, init)` helper returning `{ ok, status, data, error }`. Never throws on HTTP errors (only network failure → status 0). `describeWriteError()` produces display-ready messages for 409 ("Someone else changed this — please review and retry") and 503/network ("Couldn't save — please check your connection and retry").
- `src/App.tsx` — 12 handlers migrated to `apiWrite`: `handleUpdateTaskStatus`, `handleUpdateNotes`, `handleCheckIn`, `handleRemoveCheckIn`, `handleSaveTask` (now returns boolean; modal stays open on failure), `handleDeleteTask`, `handleResetDailyBoard`, `handleCleanSlate`, `handleRestoreDemo`, `handleAddUser`, `handleUpdateUser`, `handleDeleteUser`, `handleToggleEventTask`, `handleUpdateEvent`, `handleDeleteEvent`, `handleMoveTask` (2×). All: ok-gated, optimistic updates rolled back from snapshots on failure, no success toast before confirmation.
- `src/components/TaskModal.tsx`: `handleSubmit` awaits `onSave`, closes only on `true`; input preserved on failure.
- `src/components/HandoffNotes.tsx`: `addNote`/`deleteNote` now ok-gated with inline error banners.
- `src/components/Announcements.tsx`: `post`/`remove` ok-gated with error banners.
- `src/components/FactoryAuditHubModal.tsx`: `handleVerifyIngredient`, `handleSaveAirtableConfig`, `handleSyncAirtable` migrated.

**Tested:** Type-checked via `tsc`. No automated frontend tests exist in the repo; reviewer requested frontend-to-server integration tests — these do not yet exist (flagged as follow-up).

## 2. API response contracts

**Was wrong:** Stage 2's generic `crudCreate`/`crudUpdate` return raw objects, but two frontend callers expected wrapped responses.

**Changed (frontend side only):**
- `POST /api/event-task-templates` (`CreateEventModal.handleAddTemplate`): was reading `data.template`, now `result.data?.template ?? result.data` with id guard.
- `PUT /api/ingredients/:id/verify` (`FactoryAuditHubModal.handleVerifyIngredient`): was reading `data.ingredient`, now `result.data?.ingredient ?? result.data`.

**Verified compatible (no change needed):** task endpoints, check-in endpoints, reset-daily, clean-slate/restore-demo, users, events, venues, handoff-notes, announcements, incidents, factory-reports, airtable config/sync. All `crudDelete` → `{ success: true, deletedId }`, all delete callers only need `ok`.

**Could not verify** (no frontend caller in src/): `POST /api/incidents/:id/resolve`, `/:id/acknowledge`, `DELETE /api/task-templates/:id`, `POST /api/ingredients`, `DELETE /api/ingredients/:id`.

## 3. Fail-closed Firestore init

**Was wrong:** `initFirestore()` swallowed errors into `firestoreDb=null`; `commitState()` fell back to local file writes possibly returning success. On Cloud Run this means silent data loss.

**Changed** (`server.ts`, `initFirestore`):
- `K_SERVICE` set + init failure → `console.error('[Firestore] FATAL …')` + `process.exit(1)`. No silent degraded mode in production.
- Local dev (no `K_SERVICE`): file fallback kept, but every write logs `[Firestore] DEGRADED: writing to local file only — data will NOT persist across restarts`.
- New `firestoreInitStatus: 'connected'|'degraded-local'|'disabled'` tracked through init.
- New `GET /api/health` (public, no auth): `{ status, firestore, version, uptime }`.
- New `FORCE_LOCAL_MODE=true` kill-switch env var: skips Firestore init entirely, even on Cloud Run (deliberate ephemeral mode for incident pause).

**Tested:** `tsc` clean. Fail-closed boot path is documented-only (not executed against production). Health endpoint shape verified manually.

**Risk:** fail-closed turns a transient Firestore outage at boot into a crash loop — intended (loud > silent).

## 4. Server-side admin authorization

**Was wrong:** User endpoints resolved the caller from `userEmail` in the request body with no admin gate — any authenticated non-admin could create/promote/delete users cross-agency. `POST /api/announcements` used client-supplied `authorEmail` (impersonation). `DELETE /api/announcements/:id` had no permission check.

**Changed** (`server.ts`):
- New helpers: `getAuthUser(req)` (session user), `callerAgencyId(req)`, `requireAdmin(req,res)` → 403 unless `role==='admin'`, `requireSameAgency(req,res,entity)` → 403 on cross-agency.
- `POST /api/users`: `requireAdmin`; new user forced into caller's agency; `venueId` must be caller-agency venue.
- `PUT /api/users/:id`: `requireAdmin`; target must be in caller's agency (cached + fresh-data re-check in tx); last-admin demotion blocked (409).
- `DELETE /api/users/:id`: `requireAdmin`; no self-delete (400); same-agency; last-admin delete blocked in tx; rewritten on `commitOrRespond` for idempotent already-deleted.
- Standardized `requireAdmin` on: `PUT /api/agencies/current`, `POST /api/admin/clean-slate`, `POST /api/admin/restore-demo`, `POST/PUT/DELETE /api/venues`.
- Cross-agency checks added to: events, tasks, task-templates, incidents, announcements, handoff-notes, ingredients, factory-reports, reset-daily, airtable/config. Push unsubscribe scoped to caller's own subscription.

**Tested:** `tsc` clean, 9/9 backend tests pass. No dedicated auth endpoint tests yet (flagged: reviewer asked for at least one test per fixed endpoint — recommend adding).

## 5. Daily reset fix

**Was wrong:** `executeDailyReset` was synchronous, returned `null` immediately; endpoint responded before commit; broadcast fired in a racy `.then`; manual resets silently skipped if run twice in a day.

**Changed** (`server.ts`):
- Function is now `async`, returns `Promise<{result,version}|null>`, awaits `commitState` before responding/broadcasting.
- New `opts {force, operationId}`: scheduled path skips when `currentWorkDate` is already today; manual (`force:true`) always runs, idempotent via `operationId`.
- `/api/reset-daily` is async, reads tasks only after commit, returns 503 on failure. Archive/history creation was already inside the transaction — preserved.

**Tested:** `tsc` clean. Reviewer-requested reset tests (archive creation, double manual reset, concurrent resets, Firestore failure) are not yet written — flagged as follow-up.

## 6. Idempotency durability + sanitization

**Was wrong:** 15-min in-memory `Map`, keyed by bare client `operationId` (cross-user collisions, lost on restart). Cached results could contain password hashes.

**Changed** (`server.ts`):
- `idempotencyRecords[]` on the Firestore doc: `{key, userId, operation, result, createdAt, expiresAt, version}`. Check-and-set inside the transaction (before version check; concurrent same-key txs serialize via retry).
- TTL 24h (was 15 min). Transactional prune when >1000 records.
- `sanitizeForIdempotency()` deep-strips `password`/`passwordHash`/`kioskPin`/`resetToken`/`apiKey` + any key containing `secret`/`token` (case-insensitive).
- Keys scoped as `${userId}:${operationId}` in `commitOrRespond`. Dev-only in-memory fallback when Firestore absent.
- Removed `idempotencyCache`/`pruneIdempotencyCache`/`releaseIdempotencyClaim`.

**Tested:** Test 6 (idempotent replay) passes. Manual verification: two users sharing one operationId get separate tasks; each user's replay is idempotent.

## 7. EMERGENCY.md corrections

**Was wrong (5 issues):**
1. Rules example had `allow read: if true` (exposes data).
2. No warning that Security Rules don't restrict the Admin SDK.
3. Used `--max-instances 0` (wrong flag for scale-to-zero).
4. Implied `FIRESTORE_ENABLED=false` disables Firestore on Cloud Run (it doesn't when `K_SERVICE` is set).
5. Tested-vs-documented table needed updates.

**Changed** (`EMERGENCY.md`):
1. Rules example is now deny-all: `allow read, write: if false;`
2. Prominent warning: Security Rules do NOT restrict the Firebase Admin SDK — rules alone can't stop server writes; use scale-to-zero or `FORCE_LOCAL_MODE`.
3. `--max-instances 0` → `--scaling=0` (verified against Google Cloud docs; gcloud not installed in sandbox). Restore: `--scaling=auto --max-instances=1`.
4. Documented that `FIRESTORE_ENABLED=false` does NOT disable Firestore when `K_SERVICE` is set; `FORCE_LOCAL_MODE=true` is the real kill-switch (new Option D).
5. Tested-vs-documented table updated with new rows for fail-closed boot, `FORCE_LOCAL_MODE`, no-op commits, health endpoint, daily-reset changes (all ⚠️ documented-only).

## 8. Airtable API key preservation

**Was wrong:** `POST /api/airtable/config` did `apiKey: (apiKey || '').trim()` — overwrote the stored key with empty string when the frontend omitted it.

**Changed** (`server.ts`, `POST /api/airtable/config`):
- Now `requireAdmin`, forces caller's agency (403 on mismatched body `agencyId`).
- Preserves `apiKey`/`baseId` when undefined/null/empty — overwrite only on explicit non-empty value.

**Tested:** New `tests/stage2/test-9-airtable-key-preservation.mjs` (registered in `run-all.mjs`): create with key → update without key (preserved) → update with new key (changed) → update with empty string (preserved). **PASS.**

## 9. Unique IDs

**Was wrong:** `Date.now()`-based IDs (`usr_${Date.now()}`, `checkin-${Date.now()}-…`, etc.) are collision-prone under concurrent requests.

**Changed** (`server.ts`): all `Date.now()`-based IDs replaced with `crypto.randomUUID().slice(0,8)` keeping human-readable prefixes: `agency-`, `venue-`, `usr_owner_`, `usr_admin_`, `usr_`, `checkin-`, `etpl-`, `evt-`/`etask-`, `ing_`, `rpt_`, `disc_`, `atcfg_`, `hist-`/`entry-`. Per-call `stamp` stable across transaction retries via closure capture. Remaining `Date.now()` hits are pure timestamps/TTLs, correctly kept.

**Tested:** `tsc` clean, 9/9 tests pass (test 7's 10-way concurrent storm exercises ID generation).

## 10. No-op transactions

**Was wrong:** Every transaction incremented `_v` and wrote to Firestore even when the mutator produced no actual data change (wasted writes, version noise).

**Changed** (`server.ts`, `commitState`):
- Added `docsEqualIgnoring()` (recursive deep-equal, no new deps) + `NOOP_IGNORED_KEYS` (`_v`, `updatedAt`, `savedAt` — `savedAt` must be excluded since the previous commit wrote it but mutators never produce it).
- Pristine JSON deep-copy taken before the mutator runs (safe even if a mutator mutates its input).
- If identical → skip `tx.set`, no `_v` bump, return existing version. Fallback path also skips the file write.

**Tested:** `tsc` clean, 9/9 tests pass.

**Risk:** a mutator whose only change is `updatedAt` now commits nothing (intended per spec).

---

## Cross-cutting notes

- **Edit collisions:** two workers edited `server.ts` concurrently mid-task; both detected and re-applied their changes. Final tree verified coherent via `tsc` (clean) and 9/9 tests.
- **Not yet done (flagged for follow-up):** frontend-to-server integration tests for 409/503 handling; dedicated per-endpoint authorization tests; daily-reset specific tests (archive, double-reset, concurrent, failure); all marked in the relevant sections above.
- **Production unchanged:** no deploys from this branch. The only production change tonight was the backup-file removal commit on `main` (delete-only, verified).

---

# Round 2 — Second Reviewer Pass (commit 549c8a9 → current)

## R2-BLOCKER 1: Daily reset authorization and isolation

**Was wrong:** `POST /api/reset-daily` had no admin check and trusted client-supplied `userEmail` for agency scoping. Omitting `venueId` reset ALL agencies' venues.

**Changed (server.ts):**
- Endpoint now calls `requireAdmin(req, res)` first — non-admins get 403
- Uses `admin.agencyId` (from verified session) instead of client-supplied `userEmail`
- `executeDailyReset` accepts `opts.agencyId`; venues filtered to caller's agency when scoped
- Dates use `America/New_York` timezone via `toLocaleDateString('en-CA', { timeZone })`
- Scheduled cron reset (no agencyId) still resets all agencies (system operation)

**Tested:** test-10-daily-reset.mjs (non-admin 403, manual reset, double-reset idempotency, agency scoping, archive dates)

## R2-BLOCKER 2: FORCE_LOCAL_MODE rejects writes

**Was wrong:** `FORCE_LOCAL_MODE=true` fell back to local file writes and could return success — claiming data was saved when it was only on ephemeral disk.

**Changed (server.ts):**
- New middleware at top of `/api` router: when `FORCE_LOCAL_MODE=true`, ALL mutating requests (POST/PUT/DELETE/PATCH) return 503 `{error: 'Maintenance mode...', code: 'MAINTENANCE'}`
- GET/HEAD/OPTIONS continue to work (read-only maintenance mode)
- Documented in EMERGENCY.md §1 with gcloud commands to enable/disable

**Tested:** test-11-maintenance-mode.mjs documents manual verification steps

## R2-BLOCKER 3: Out-of-order transaction completion

**Was wrong:** `hydrateState(committed.doc)` ran unconditionally after every commit. If transaction A (older) completed after transaction B (newer), A's stale doc overwrote B's newer state.

**Changed (server.ts, commitState):**
- Before hydrating: compare `committed.version > stateVersion`
- Only hydrate if the committed version is newer; otherwise log warning and skip
- The newer state is already correct — no overwrite

**Tested:** test-12-out-of-order-hydration.mjs

## R2-4: Client-side versioning and idempotency

**Was wrong:** `apiWrite()` didn't send `expectedVersion` or stable `operationId`.

**Changed (src/lib/api.ts):**
- `apiWrite` now accepts `{expectedVersion, operationId}` in init options
- Auto-injects both into JSON request bodies (doesn't overwrite if already present)
- Generates stable UUID per call; callers should generate once per user action and reuse on retry
- Server-side idempotency already scoped to `${userId}:${operationId}` with payload-agnostic caching

**Tested:** test-15-frontend-smoke.mjs (retry with same ID, stale version 409)

## R2-5: Correct no-op detection

**Was wrong:** `docsEqualIgnoring` ignored ALL `updatedAt` fields recursively — legitimate entity timestamp updates (e.g., "last checked at") were treated as no-ops.

**Changed (server.ts):**
- `docsEqualIgnoring(a, b, isTopLevel=true)` — top level ignores `_v`, `updatedAt`, `savedAt` (document metadata)
- Nested levels compare EVERYTHING including `updatedAt` (entity timestamps are real data)
- Array recursion passes `isTopLevel=false`

**Tested:** test-13-noop-detection.mjs (nested timestamp persists + bumps version; true no-op doesn't bump)

## R2-6: Password-reset security finishing

**Was wrong:** (a) IP extraction trusted `X-Forwarded-For` blindly (spoofable); (b) reset-code pepper was the JWT secret stored alongside hashes in Firestore.

**Changed (server.ts):**
- `app.set('trust proxy', 1)` — Express `req.ip` now returns real client IP behind Cloud Run's load balancer; spoofed X-Forwarded-For is stripped
- `getClientIp()` uses trust-aware `req.ip` (not raw header parsing)
- New `getResetPepper()`: dedicated secret from `RESET_CODE_PEPPER` env var → Firestore-stored fallback (generated once) → never hardcoded, never the JWT secret
- Rotation documented: set new env var, redeploy; old codes invalidate naturally

**Tested:** Existing test-8 covers the flow; IP trust is infrastructure config (documented)

## R2-7: Test endpoints gated on !K_SERVICE

**Was wrong:** `/api/__test__/*` gated only on `STAGE2_TEST_MODE=true` — if accidentally set in production, they'd expose full DB state and reset codes.

**Changed (server.ts):**
- New `isTestMode()` helper: `STAGE2_TEST_MODE === 'true' && !process.env.K_SERVICE`
- All three gating points (route registration, auth bypass list, code stash) use `isTestMode()`
- On Cloud Run (K_SERVICE always set), endpoints don't exist even if the env var is set

**Tested:** Code inspection; CI runs with K_SERVICE unset so tests still work

## R2-8: Document-size guard

**Was wrong:** No protection against hitting Firestore's 1 MiB document limit — would fail with cryptic error.

**Changed (server.ts):**
- `commitState` measures `JSON.stringify(payload).length` before `tx.set()`
- Exceeds 900 KiB → throws `DocumentTooLargeError` → mapped to 503 `{code: 'SIZE_LIMIT'}` with clear message
- `sanitizeForIdempotency`: truncates strings >1KB, caps total at 10KB (metadata only beyond)
- All `crypto.randomUUID().slice(0,8)` replaced with full UUIDs for durable records
- Idempotency records already capped at 1000, pruned transactionally (verified working)

**Tested:** test-14-document-size-guard.mjs documents the wiring; TEST_RESULTS.md updated with photo/voice handling analysis

## R2-9: Release-critical tests

**Added:**
- test-10: daily reset (auth, idempotency, agency scoping, archive dates)
- test-12: out-of-order hydration safety
- test-13: no-op detection (nested timestamps vs true no-ops)
- test-15: frontend smoke (retry, 409, optimistic rollback behavior)
- CI: crash detection step (fails on "unhandled"/"EADDRINUSE"/"FATAL" in logs)
- CI: triggers on `src/**` changes (was only server.ts/tests)
- Harness: pre-flight port cleanup (kills stale servers on test port)

**Still manual:** full maintenance-mode test (requires env var + restart); 503 simulation

## R2-10: Recovery documentation

**Changed:**
- EMERGENCY.md: all `BACKUP-2026-10-17-stage1.json` references replaced with "fresh `/api/admin/export` backup, stored privately (NOT in git)"
- ROLLBACK.md: same replacement
- EMERGENCY.md §1: added "Maintenance mode vs normal operation" section documenting FORCE_LOCAL_MODE behavior, gcloud commands, and the guarantee that writes are REJECTED (not silently lost)
- Noted: backup remains in git history on PR branch; Don handles history cleanup + credential rotation separately in the morning

---

## Round 2 Bug Fixes (found by test-10 during verification)

### BUGFIX A: Daily reset task clearing was not agency-scoped

**Was wrong:** `resetTask()` inside `executeDailyReset` filtered only by `targetVenueId`, not by agency. When a manual reset omitted `venueId` (agency-wide reset), it cleared EVERY task across ALL agencies — while snapshots were correctly scoped. Test-10 proved an agency-B task's `isCompleted`/`notes` were wiped with no snapshot archived.

**Changed (server.ts):**
- `resetTask(t, scopedVenueIds)` now takes the scoped venue ID set
- When `scopeAgencyId` is set, only tasks whose `venueId` is in the scoped set are reset; others returned untouched
- Scheduled system reset (`scopeAgencyId=null`) still resets all venues as intended

**Tested:** test-10 verifies agency-B fixture task is untouched after agency-A reset

### BUGFIX B: Duplicate operationId on reset-daily returned 503

**Was wrong:** The endpoint's catch-all mapped `DuplicateOperationError` to 503. Clients retrying after a lost response got an error instead of the cached result.

**Changed (server.ts):**
- `catch` block now checks `err instanceof DuplicateOperationError` first
- Returns 200 `{success: true, snapshot, tasks, duplicate: true}` with the cached result
- No duplicate effect (idempotency already guaranteed by commitState)

**Tested:** test-10 updated to expect 200 + `duplicate:true` on replay

---

## Round 3 — Third Review (commit eaf0075)

### R3-1. Daily-reset WebSocket broadcast scoping
**Was wrong:** Post-commit broadcast looped over ALL agencies, sending `committed.result` (only the first snapshot) to every agency.
**Changed:** `server.ts` `executeDailyReset()`: broadcast now scoped to `scopeAgencyId` when set. Also aligned scheduled rollover check to America/New_York (was UTC `toISOString`, now `toLocaleDateString` with NY timezone, matching the transaction).

### R3-2. Client versioning and idempotency completion
**Was wrong:** No callers passed `expectedVersion`; operation IDs generated in apiWrite (not stable across retries); server didn't check payload on idempotency hit.
**Changed:**
- `src/lib/api.ts`: added `newActionId()` helper + explicit JSDoc contract (callers MUST provide expectedVersion for updates; generate ONE action ID per user action).
- `server.ts`: `commitOrRespond` computes `payloadHash` (SHA-256 of body minus versioning fields); `commitState` stores it on idempotency records; on lookup, mismatched payload → new `PayloadMismatchError` → 409 `PAYLOAD_MISMATCH` (not cached result).

### R3-3. Mock and maintenance safety
**Was wrong:** FIRESTORE_MOCK could run on Cloud Run; background writers (daily reset cron, media cleanup, overdue check) ran in maintenance mode; /api/health didn't report maintenance.
**Changed:**
- `initFirestore()`: `FIRESTORE_MOCK=true` + `K_SERVICE` → `console.error` + `process.exit(1)`.
- All `setInterval`/`setTimeout` background writers gated on `FORCE_LOCAL_MODE !== 'true'`.
- `/api/health` now reports `maintenance: true/false` and `firestore: 'maintenance'` in maintenance mode.

### R3-4. Reset pepper race fix
**Was wrong:** `getResetPepper()` generated and persisted async during request handling (race on restart).
**Changed:** New `initResetPepper()` runs during `startServer()` after Firestore loads, before accepting requests. Priority: env var → Firestore-stored → generate+publish. `getResetPepper()` throws if not initialized. No async generation during requests.

### R3-5. Completed tests
- **Test 11**: now actually restarts with `FORCE_LOCAL_MODE=true`, verifies 503 MAINTENANCE on POST/PUT/DELETE, 200 on GETs, clean recovery. Harness `restartServer` accepts env overrides.
- **Test 14**: now performs a real 950KB oversized write, verifies 503 SIZE_LIMIT, no version bump, no leak, normal writes unaffected.
- **Test 15**: already honest about API-contract verification (no React test infra); description accurate.
- **EADDRINUSE investigation**: port 24678 not in codebase (ephemeral CI port); WebSocket shares HTTP server port 3100; harness kills 3100 on restart. All tests pass; noise from controlled restarts, not a code bug.

### R3-6/7/8. New docs
- `CUTOVER.md`: atomic traffic cutover procedure with gcloud commands.
- `PWA_UPDATE.md`: old-client behavior matrix, update flow.
- `BACKUP_RESTORE.md`: backup via admin export, manual restore procedure, post-restore steps.

### R3-9. Admin/export hotfix included
Applied `requireAdmin` check to `/api/admin/export` on the PR branch (matches hotfix/admin-export-auth PR #2).

**Tests:** 15/15 pass. `npx tsc --noEmit` clean.

---

## Round 4 (fourth review) — release/cutover blockers

### R4-1. Zero-traffic deploy workflow (actual code change, not just docs)
**Was wrong:** CUTOVER.md told the operator to merge, let the ordinary deploy
take 100% traffic, then pin traffic back — a window where old unversioned and
new transactional writers serve simultaneously.
**Changed:** `.github/workflows/deploy.yml` now does staged deploys by
default: the Python spec-rewrite pins 100% of traffic to the currently-serving
revision, so `gcloud run services replace` creates the new revision with **0%
traffic**. Handles both traffic shapes (`revisionName` entries and
`latestRevision: true` via `status.latestReadyRevisionName`). Set the repo
Actions variable `STAGED_DEPLOY=false` to restore ordinary push-to-deploy
after the migration. `CUTOVER.md` rewritten to match: deploy → verify new
revision on its direct URL → drain → atomic `update-traffic` cutover → verify
0% on old → never revert to pre-Stage-2 once it has committed (forward-fix
only). Traffic-pinning logic unit-tested locally against simulated
describe-JSON (4 shapes, all pass); gcloud itself unavailable in this sandbox.

### R4-2. Scheduled reset broadcast per-agency scoping
**Was wrong:** `executeDailyReset()` returned only `snapshots[0]` and the
broadcast sent it to every agency — the scheduled (unscoped) reset leaked
agency A's snapshot to agency B.
**Changed:** the transaction now returns the full `snapshots` array (each
tagged `agencyId`); the broadcast filters per agency (`snapshots`, `tasks`,
`historyLogs` all agency-scoped). Manual endpoint takes `snapshots[0]` for
its single-snapshot response (unchanged frontend contract). New test-only
endpoint `/api/__test__/scheduled-reset` runs the exact scheduled code path.
**Test 16** (new): real WebSocket clients for agency-hkc and agency-b;
scheduled reset fires; asserts each client receives ONLY its agency's
snapshots/tasks/history and no cross-agency notes leakage. PASSES.

### R4-3. Stale-client version contract (end to end)
**Was wrong:** `apiWrite()` accepted `expectedVersion` but no caller sent it;
old cached clients sent nothing and would have been silently accepted.
**Changed:**
- Server: `X-State-Version` header on every `/api` response; `version` in
  every WebSocket envelope (incl. INITIAL_STATE).
- Server: `requireVersion: true` on all update/delete handlers (12 bespoke
  labels + `crudUpdate`/`crudDelete`). Missing version → **428 STALE_CLIENT**
  ("please refresh — your input is preserved"), never a silent apply.
  Exemptions (documented in code): `task-checkin` (append to fresh array —
  provably safe under concurrency) and `toggle-event-task` (has its own
  entity-level baseline guard).
- New `StaleClientError` → 428. (Also fixed: `PayloadMismatchError` now
  propagates untouched from transactions instead of degrading to 503.)
- Frontend (`src/lib/api.ts`): tracks `lastKnownVersion` from headers + WS
  messages (`observeVersion`); `apiWrite()` auto-injects it for
  PUT/PATCH/DELETE; `describeWriteError` handles 428; stale-draft
  save/restore via localStorage (`shutfey_stale_drafts`).
- Frontend (`src/App.tsx`): WS handler observes versions; stale-draft banner
  with Re-apply (resends with fresh version) / Discard; drafts wired into
  task-notes and task-edit writes (check-in/handoff forms already keep input
  on failure; deletes need no drafts).
- **Design decision (strict gate):** the version check is strict equality.
  Concurrent fresh writes race: one commits, the other gets 409
  VERSION_CONFLICT (clear, retryable — never silent). Tests 2 and 12 updated
  to assert this contract (winner + 409 loser + clean retry, both changes land).
- **Test 15** extended: version-less PUT → 428 STALE_CLIENT (rejected, data
  intact); `X-State-Version` header verified present and correct.

### R4-4. Disaster recovery correctness
**Was wrong:** restore script used `admin.initializeApp({ databaseId })`
(which firebase-admin v14 does not support) and implied `admin.firestore()`
default-DB usage.
**Changed:** script now uses the explicit, supported
`getFirestore(app, DATABASE_ID)` with the named database
(`ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`).
`BACKUP_RESTORE.md`: exact in/out inventory verified against code
(passwords/hashes/PINs/jwtSecret/vapidKeys stripped; resetPepper included;
pushSubscriptions ARE included — corrected the old "cannot be restored"
claim); new "complete backup" section (JSON export + separate secret
inventory + optional GCS `gcloud firestore export`); test-18 result recorded;
production verification checklist for Don (counts, pepper env var, rules).
**Test 18** (new): export → wipe → restore cycle. Mock mode: structural
validation (required fields, no credential leakage). Emulator (CI): full
cycle via Admin SDK with explicit database ID — counts, version, and canary
identical after restore; post-restore write succeeds. PASSES.

### R4-5. Idempotency operation scoping
**Was wrong:** only user + operationId + payload hash were checked.
**Changed:** records now store `opType` (label), `opMethod`, `opTarget`
(entity type + id, derived from the request path). Mismatches → 409
PAYLOAD_MISMATCH (not the wrong cached result). Applied to both the
transactional path and the dev-fallback map.
**Test 17** (new): same operationId for create→update → 409; same
operationId + identical payload for task A → task B → 409 (no cross-apply);
genuine retry (same op/target/payload) → 200 cached. PASSES.

### R4-6. Release preparation
- `PWA_UPDATE.md` rewritten to the ACTUAL verified behavior (428 flow, draft
  banner, what's verified in code/tests vs. what needs Don's device check).
- `CUTOVER.md` rewritten for the staged workflow (see R4-1).
- `BACKUP_RESTORE.md` corrected (see R4-4).
- New `MANUAL_VERIFICATION.md`: exact commands for maintenance mode
  (enable/verify/disable), PWA device checks, restart checks, and Don's
  pre-cutover production checklist (Firestore rules, pepper env var, PIN
  rotation, JWT rotation decision, git history, fresh backup).
- **PR #2 merge conflict note:** PR #2 (`hotfix/admin-export-auth`) and this
  PR both touch `/api/admin/export`. PR #2 adds an `(req as any).authUser`
  role check; this PR uses `requireAdmin(req, res)` (strictly stronger —
  same 403 semantics via the shared helper). When PR #2 merges first, the
  merge of main into this branch will conflict on those lines: **keep this
  PR's `requireAdmin` line** (it subsumes PR #2's fix).

**Tests:** 18/18 pass (mock mode locally; real-emulator run in CI).
`npx tsc --noEmit` clean.
