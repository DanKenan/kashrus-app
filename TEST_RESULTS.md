# Stage 2 Test Results — Single Transactional Write Path

**Date:** 2026-10-17/18
**Method:** 8 HTTP-level tests against the server with `FIRESTORE_MOCK=true`
(an in-memory Firestore mock with faithful transaction semantics).
**Result: 8/8 PASS** (multiple consecutive clean runs).

## Why a mock instead of the emulator — precise diagnosis

The task specified the Firestore emulator. Investigation results:

**What works:**
- Java 21 (OpenJDK 21.0.12.1) installed; firebase-tools 15.34.0 installed
- Emulator JAR cached (`cloud-firestore-emulator-v1.22.0.jar`); starts cleanly
- Reports "All emulators ready!" on 127.0.0.1:8080; TCP connections succeed
- Raw HTTP/2 prior-knowledge handshake succeeds (verified with Node's `http2` module)

**What fails:**
- Every gRPC call via firebase-admin hangs indefinitely, then the subchannel goes
  `CONNECTING → TRANSIENT_FAILURE` (verified with `GRPC_VERBOSITY=DEBUG`,
  `GRPC_TRACE=connectivity_state`)
- The emulator's own log shows `INTERNAL: http2 exception` for each attempt
- HTTP/1.1 REST via curl fails (expected — the emulator requires HTTP/2)
- Proxy env vars (`https_proxy`, `NODE_USE_ENV_PROXY=1`) were ruled out:
  unsetting them did not fix the hang

**Root cause:** The sandbox's network layer breaks HTTP/2 *streams*.
TCP connects and the HTTP/2 preface is accepted, but gRPC/HTTP-2 data frames
never complete. This is sandbox infrastructure (likely packet inspection or a
transparent proxy interfering with HTTP/2 framing), not fixable from userland.

**Recommendation:** Run `npm run test:stage2` against the real emulator on
Don's machine or a GitHub Actions CI runner where HTTP/2 works. The test suite
is emulator-ready: set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and unset
`FIRESTORE_MOCK` (the server's `initFirestore()` already respects
`FIRESTORE_EMULATOR_HOST`; use `FIRESTORE_ENABLED=true` to bypass the
credentials check). A CI workflow running the emulator is the durable solution.

Per the task's approved alternative, `tests/stage2/firestore-mock.mjs` implements
the exact transaction semantics Stage 2 depends on:

- **Optimistic concurrency:** each transaction snapshots document versions at
  start; if the version changes before commit (a concurrent transaction won),
  the commit aborts with a retryable contention error and the function re-runs
  — mirroring Firestore's server-side retry.
- **Atomicity:** a transaction's writes all apply or none do.
- **Application errors propagate without retry:** `VersionConflictError` /
  `OperationConflictError` thrown by the mutator are not retried by the mock
  (Firestore doesn't retry user-code failures either); the server's own retry
  loop in `commitState` handles version conflicts as designed.
- **Durability:** the mock persists to a file after every commit, so Test 5
  (restart) genuinely verifies that only committed data reloads.

**Documented limitations of the mock** (things the emulator would have covered):
- Single-document only (Stage 2 only ever touches `app-state/main`, so this is exact).
- No real network latency, no partial failures, no multi-client clock skew.
- Contention is modeled via version checks, not true parallel gRPC streams —
  the 10-way storm still exercises real concurrent Node.js execution against
  the server's transaction loop.

## Verification audit (2026-10-18) — beyond the 7 tests

### Task 2: Direct Firestore write audit

Searched `server.ts` for all Firestore write operations (`.set(`, `.update(`,
`.add(`, `.delete(`, `batch.`, direct `firestoreDb.doc().set`).

**Finding 1 — FIXED:** The legacy `persistToFirestore()` function still existed
with a direct, unversioned, non-transactional `.set()` of the entire document.
It had no remaining callers (`saveState()` was dead code), but it was a loaded
gun: any future accidental call would have clobbered transactional data.
**Fix:** `persistToFirestore()` is now a no-op that logs a warning directing
the caller to `commitState()`. The direct `.set()` is gone.

**Finding 2 — FIXED:** The forgot-password flow (Step 1 `forgot-password` and
Step 2 `verify-reset-code`) mutated the in-memory `passwordResets` array
directly, bypassing the transactional path. Worse, `passwordResets` was not in
`stateSnapshot()`, so Step 3 (`reset-password`) — which correctly read
`freshDoc.passwordResets` inside its transaction — could never find the token.
**The forgot-password flow was broken end-to-end.**
**Fix:**
- `passwordResets` added to `stateSnapshot()` and `hydrateState()` (with
  expiry pruning on load)
- Step 1 now uses `commitOrRespond` to persist the reset request transactionally
- Step 2 now uses `commitOrRespond` to persist verification + reset token,
  with idempotent re-verification (returns existing token on retry)
- Reset tokens now survive server restarts (previously lost)

**Finding 3 — VERIFIED CLEAN:** All other Firestore writes go through
`commitState()` / `commitOrRespond()`. The only `tx.set()` is inside the
transaction (line ~1503, the correct path). No `.update()`, `.add()`,
`.delete()`, or batch writes exist outside the transactional path.

### Task 3: Idempotency atomicity, broadcast ordering, mutator purity

**Idempotency race — FIXED:** The original check-then-store had an async gap:
two concurrent requests with the same `operationId` could both pass the cache
check before either stored its result, causing duplicate execution.
**Fix:** the operationId is now *claimed synchronously* (in the same
synchronous block as the check — atomic in Node's event loop) with an
`inFlight: true` marker. A concurrent duplicate gets
`OperationConflictError("already in progress")` instead of executing twice.
On terminal failure, `releaseIdempotencyClaim()` removes the in-flight marker
(only if still marked in-flight — never removes a committed result) so
legitimate retries can re-execute. Data-level idempotency in mutators
(pre-generated IDs + existence checks, e.g. `crudCreate` returning the existing
item) guards the lost-commit edge case.

**Broadcast ordering — VERIFIED CLEAN:** Audited all ~40 `broadcast()` calls.
Every one in a request handler is gated by `if (!committed) return;` after
`commitOrRespond`/`commitState`. Push notifications (`sendPushToUser`) follow
the same pattern. The two apparent exceptions are safe:
- Overdue-task checker (background job, read-only, not a write path)
- Forgot-password admin push (now after `commitOrRespond` success)

**Mutator purity — VERIFIED CLEAN:** No mutator performs external I/O.
- Airtable sync: `fetch()` happens *before* `commitOrRespond`; the mutator
  only transforms already-fetched data (pure)
- Password hashing (`bcrypt`): computed *before* the transaction; the mutator
  receives the hash as deterministic input
- VAPID key generation: happens once at boot, outside any transaction
- ID generation (`crypto.randomUUID()`): pre-generated by callers before the
  mutator runs (e.g. `crudCreate`'s `buildItem()`), so retries reuse the same ID

### Task 4: Document size and write contention — what Stage 2 does NOT solve

**Current size:** The production database is 2,860 bytes (0.3% of the
1 MiB Firestore document limit). The database is nearly empty (0 tasks).

**NEW in Round 2: Document-size guard.** `commitState` now measures
`JSON.stringify(doc).length` before every write. If it exceeds 900 KiB
(leaving 124 KiB headroom below Firestore's 1 MiB hard limit), the write is
rejected with 503 `{code: 'SIZE_LIMIT'}` and a clear message. This prevents
cryptic Firestore rejections and gives operators a clear signal to clean up
or accelerate Stage 3.

**How photo/voice uploads are handled until Stage 3:**
- Photos are compressed client-side (max 800px, JPEG 0.7, ~500 KB cap each)
- 30-day retention: `MEDIA_RETENTION_DAYS = 30` strips old base64 automatically
- **BUT:** 2 photos still fill the document. The size guard will start rejecting
  writes when this happens — this is intentional. It's a circuit breaker, not
  a solution. Stage 3 (Cloud Storage for media) is the real fix.
- Idempotency records are capped at 1000 entries, pruned transactionally, and
  large results are truncated (not stored) to prevent unbounded growth.

**Projection — the limit is closer than it looks:**
- Photo check-ins: ~500 KB base64 each (after client-side compression)
- **Only 2 photos fit** in the remaining headroom before hitting 1 MiB
- 30-day media retention helps, but 5 photos/day × 30 days = 75 MB — far over
- 32 Crown Market tasks (no photos): ~32 KB — fine on their own
- History logs grow with every check-in; handoff voice notes add base64 audio

**What Stage 2 does NOT solve (honest scoping for Stage 3):**
1. **The 1 MiB document ceiling.** Stage 2 keeps the monolithic
   `app-state/main` document. Two photo check-ins will hit the wall.
2. **Write contention.** Firestore sustains ~1 write/sec per document under
   contention. The retry loop handles bursts (Test 7 proves 10 concurrent
   writes succeed), but sustained high-frequency writes will see elevated 409s.
3. **Media storage.** Photos/voice must move to Cloud Storage (Stage 3), not
   base64 in Firestore.
4. **Per-collection sharding.** The real fix is separate documents per entity
   (users, venues, tasks, etc.) — Stage 3.

Stage 2 stops silent data loss. It does not make the architecture scalable.
Stage 3 is not optional.

## Test-by-test results

### Test 1: Stale write blocked (version check) — PASS
**What it proves:** a write carrying a stale `expectedVersion` (the old
fire-and-forget path, which never checked versions) cannot overwrite a
committed transaction.

**How:** create task (v=N), create another task (v=N+1), then `PUT
/api/tasks/:id` with `expectedVersion=N` → **409**. Firestore document
verified: the stale title never landed; `_v` unchanged by the rejected write.

**Result:** `stale write got 409, committed data intact, version stayed at 6`

### Test 2: Concurrent writes to different tasks both succeed — PASS
**What it proves:** mergeable writes (different tasks) both commit. The
transaction retry re-reads fresh data and re-applies; nothing is lost.

**How:** two `PUT /api/tasks/:id` fired simultaneously with no
`expectedVersion` (server reads fresh). Both return 200; both titles present
in Firestore; `_v` incremented by exactly 2.

**Result:** `both updates committed, version 9 → 11, no data loss`

### Test 3: Same-field conflict → one wins, one gets 409 — PASS
**What it proves:** conflicting edits to the same field are detected
*semantically* (not just by version). The loser gets 409 — never a silent
last-wins overwrite.

**How:** two `PUT`s with the same baseline `expectedVersion`, both renaming
the same task's title. Statuses: one 200, one 409. The winner's title is
intact in Firestore.

**Result:** `one 200 + one 409, winner="Rename by Client 1", no silent overwrite`

### Test 4: Failed write leaves no trace — PASS
**What it proves:** when a write fails, the client gets an error and *nothing*
is half-applied: Firestore unchanged, in-memory cache unchanged.

**How:** a good write commits, then a stale-version write is rejected with
409. Firestore and the API (in-memory cache) both show only the good write.

**Result:** `409 returned; Firestore and in-memory cache show only the good write`

### Test 5: Restart resurrects nothing uncommitted — PASS
**What it proves:** the server is stateless across restarts. Firestore is the
source of truth; failed/uncommitted writes never reappear.

**How:** commit a task, fail a write (409), SIGKILL the Node process, restart,
then verify: the committed task loads, the ghost write is absent, `_v`
is stable, and the API agrees with Firestore.

**Result:** `committed task survived, ghost write absent, version stable at 20`

### Test 6: Idempotent operationId replay — PASS
**What it proves:** client retries after a timeout don't create duplicates.
The same `operationId` returns the cached original result.

**How:** `POST /api/tasks` with `operationId=X`, then the identical request
again. Second returns 200 with the *same* task ID; Firestore has exactly one
copy; `_v` did not increment on the replay.

**Result:** `retry returned same task task-626a0e57-…, no duplicate, version stayed at 22`

### Test 7: Retry storm (10 concurrent writes) — PASS
**What it proves:** under contention, all mergeable writes succeed via
transaction retry. `_v` increments by exactly the number of commits — no lost
writes, no duplicates.

**How:** 10 concurrent `POST /api/tasks` (distinct entities, distinct
`operationId`s). All 10 return 201/200 with unique IDs; all 10 present in
Firestore; `_v` goes from 23 → 33 (exactly +10).

**Result:** `all 10 writes committed, version 23 → 33, no lost writes`

### Test 8: Password-reset security — PASS
**What it proves:** reset codes are cryptographically generated, stored hashed,
rate-limited, attempt-capped, single-use, and expire correctly.

**How:** 7 scenarios against the live endpoints with dedicated test users
(isolated IPs via `X-Forwarded-For`):
1. **Code format** — `forgot-password` → test-only `/api/__test__/last-reset-code`
   returns a 6-digit numeric code.
2. **Hashed storage** — Firestore doc shows `codeHash` (64-char SHA-256 hex);
   no plaintext `code` field persisted.
3. **Per-email rate limit** — 5 requests succeed; 6th within the hour → **429**
   with `Retry-After` header.
4. **Attempt cap** — 5 wrong codes → request invalidated; even the correct
   code then returns 400 ("invalidated").
5. **Forgiving within cap** — 4 wrong codes (each returns attempts-left),
   then the correct code → 200 with `resetToken`.
6. **Single-use token** — `reset-password` with token → 200; reuse → 400.
7. **Expiry** — force-expire via `/api/__test__/expire-reset` → verify →
   400 ("expired").

**Result:** `all 7 password-reset security scenarios verified`

## Password-reset security design

| Requirement | Implementation |
|---|---|
| Secure RNG | `crypto.randomInt(100000, 1000000)` — never `Math.random()` |
| Hashed storage | `codeHash` = SHA-256(`reset-code:<pepper>:<code>`); pepper = server JWT secret (persisted in Firestore, never hardcoded, never logged) |
| Constant-time verify | `crypto.timingSafeEqual()` on hash buffers; legacy plaintext `code` entries also compared in constant time during migration |
| Per-email request limit | 5/hour → 429 + `Retry-After` |
| Per-IP request limit | 10/hour → 429 |
| Per-email verify attempts | 5 wrong → request deleted (invalidated) |
| Per-IP verify attempts | 20/hour → 429 |
| Rate-limit durability | Timestamps persisted in `passwordResetRateLimits` in the Firestore doc — survive restarts, work across instances |
| Atomicity | All checks + mutations inside the Firestore transaction; `RateLimitError` is never retried by `commitState` |
| Single-use | Reset token consumed atomically with the password change (same transaction) |
| Expiry | 15-min TTL, re-checked inside the final redemption transaction |
| Anti-enumeration | Generic success response even for unregistered emails |
| No secrets in logs | Plaintext code exists only in handler memory for the admin push/broadcast; zero `console.*` hits for codes (audited) |
| Migration | `hydrateState` accepts both `codeHash` (new) and legacy `code`; all new writes use `codeHash`; legacy entries expire naturally |

**Known gaps (reviewer decision):**
- No CAPTCHA on `forgot-password` (rate limits mitigate; 5/hr/email makes abuse expensive).
- 6-digit numeric code (~20 bits entropy). At 5 attempts per 15-min window,
  brute force is infeasible (1M ÷ 5 per 15 min ≈ 5.7 years expected), but a
  longer alphanumeric code would be stronger. Left as reviewer call.

## Remaining risks / limitations (updated 2026-10-18 after verification audit)

1. **Mock vs emulator (see precise diagnosis above).** The version-check, retry,
   atomicity, and idempotency logic is backend-agnostic (it sits in
   `commitState`, above the Firestore driver), so the risk is low — but a
   pre-deploy emulator run on a working machine (or GitHub Actions CI) is still
   required before production.
2. **Monolithic document contention + 1 MiB ceiling.** Stage 2 keeps the single
   document. Firestore sustains ~1 write/sec per document under contention; the
   retry loop handles bursts (proven by Test 7), but sustained high-frequency
   writes from many clients will see elevated 409s. **Only 2 photo check-ins
   fit before hitting the 1 MiB limit.** Stage 3 (per-collection sharding +
   Cloud Storage for media) is the real fix — see Task 4 above.
3. **Idempotency cache is in-memory with 15-min TTL.** A server restart drops
   it; a client retry after a restart could double-apply. Mitigation is now
   two-layer: (a) synchronous in-flight claiming prevents concurrent duplicates
   within a server lifetime; (b) mutators are idempotent on stable IDs (e.g.
   pre-generated task IDs, verified-token checks), so most replays are still
   safe across restarts. A Firestore-backed idempotency log is future work.
4. **Client must send `expectedVersion`.** Writes without it get the server's
   fresh read (safe), but the UI should send the version it rendered so users
   get 409s instead of unknowingly editing stale data. The client already
   reloads on 409 (`code: 'VERSION_CONFLICT'` with `currentVersion`).
5. **`_v` is on the monolithic doc.** Any direct Firestore console edits that
   don't bump `_v` will cause the next transactional write to 409 once, then
   succeed on retry — by design.
6. **Legacy `saveState()`/`persistToFirestore()` are now inert.** `saveState()`
   still writes the local `store.json` file (harmless crash-recovery backup);
   its Firestore call is neutered. If `store.json` is ever removed, this
   function should be deleted entirely.

## How to run

```bash
npm run test:stage2
# → node tests/stage2/harness.mjs
```

Starts the server on :3100 with `FIRESTORE_MOCK=true`, runs all 7 tests,
prints PASS/FAIL per test plus a summary. Exit 0 = all pass.
`--keep` leaves the server running for debugging.
