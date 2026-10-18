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
