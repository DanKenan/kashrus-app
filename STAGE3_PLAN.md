# Shutfey — Stage 3 Plan: Per-Collection Firestore Layout + Media Storage

**Status:** Plan document — no code changes. Reviewer-grade.
**Author:** Amuse (for Don Kenan), 2026-10-18
**Precondition:** Stage 2 merged, cut over, and stable in production (single transactional write path, `_v` per document).
**Branch for implementation:** to be created after Stage 2 is live (suggested: `stage3/per-collection`).

---

## 1. Goal

Stage 2 made writes safe. Stage 3 makes them *scalable* and removes the last structural time bomb: the single Firestore document `app-state/main`.

Two concrete problems remain after Stage 2:

1. **The 1 MiB document ceiling.** Every write still rewrites the *entire* state as one document. Current state is ~3 KB, but photo check-ins are ~500 KB base64 each — **two photos in one day's check-ins exhaust the document**. When the document crosses 1,048,576 bytes, *every* write fails with `FAILED_PRECONDITION` and the app stops persisting. The 900 KB application guard (Stage 2) converts this into a loud 503, but the ceiling is still one busy kashering day away.
2. **Write contention on a single document.** Firestore supports ~1 sustained write/second per document (soft limit). A mashgiach rapid-completing 32 tasks fires 32 full-document writes in a burst. Today this is latency; at multi-agency scale it becomes `ABORTED` contention errors.

Stage 3 therefore does two things:
- **Shatter the monolith:** per-collection (and per-entity where justified) Firestore documents, so each write touches only what changed.
- **Move media out of Firestore:** photo/voice base64 goes to Cloud Storage; Firestore holds only metadata + a Storage reference.

**Non-goal:** this is a data-layer migration, not a feature. See §7 (Out of scope).

---

## 2. Proposed layout

### 2.1 Document structure

All in the named database `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`, project `gen-lang-client-0875538181`.

| Collection | Document ID | Contents | `_v`? | Rationale |
|---|---|---|---|---|
| `agencies` | `{agencyId}` | Agency config (name, settings, Airtable keys) | Yes | Tiny, rarely written. One doc per agency. |
| `venues` | `{venueId}` | Venue record | Yes | Low write rate. One doc per venue. |
| `users` | `{userId}` | User profile incl. bcrypt hash + kiosk PIN | Yes | Low write rate. Per-user doc also shrinks the F1-class blast radius to one user (though F1 itself is fixed). |
| `tasks` | `{taskId}` | Task record (no media payloads) | Yes | **Highest write rate.** Per-entity docs are the whole point — concurrent mashgichim editing *different* tasks never contend. |
| `checkins` | `{checkinId}` | Photo check-in: metadata + Storage refs only | Yes | Media metadata lives here; bytes in Storage. |
| `handoffNotes` | `{noteId}` | Note text + voice Storage ref | Yes | Voice notes are large; refs only. |
| `incidents` | `{incidentId}` | Incident + follow-up task link | Yes | Medium write rate. |
| `announcements` | `{announcementId}` | Announcement record | Yes | Low write rate; currently one-way broadcast. |
| `events` | `{eventId}` | Event record | Yes | Low write rate. |
| `taskTemplates` | `{templateId}` | Template definitions | Yes | Rarely written. |
| `eventTaskTemplates` | `{templateId}` | Event template definitions | Yes | Rarely written. |
| `historyLogs` | `{agencyId}` | Per-agency append log (subcollection `entries/{entryId}` if it grows) | Yes (doc-level) | History is append-only and agency-scoped. A single per-agency doc risks the same contention problem if it grows — start as one doc per agency, move to a subcollection of immutable entries if write rate demands it. Entries are never updated, only appended, so per-entry docs need no `_v`. |
| `airtableConfigs` | `{agencyId}` | Airtable key/baseId per agency | Yes | Tiny, rarely written. |
| `approvedIngredients` | `global` (single doc) | Ingredient allow-list | Yes | Small, rarely written. |
| `factoryReports` | `{reportId}` | Factory audit reports | Yes | Low write rate. |
| `pushSubscriptions` | `{subscriptionId}` | Push subscription per device | No (`_v` unnecessary — upsert by endpoint) | Ephemeral; recreated by clients. |
| `passwordResets` | `{email}` (or `{requestId}`) | Active reset requests (hashed codes) | No (TTL-based, single-use) | Short-lived; keyed for atomic consume. |
| `app-meta` | `config` | `currentWorkDate`, `isDemoCleared`, feature flags | Yes | Small global state. **Not secrets** (see §2.2). |
| `app-meta` | `idempotency` | Idempotency records (or a top-level `idempotency/{userId:opId}` collection) | N/A (TTL) | Stage 2 already persists these with 24h TTL; keep the mechanism, move the location. |

**Per-entity vs per-collection — the rule used above:**
- **Per-entity documents** for anything with independent write lifecycles: `tasks`, `users`, `venues`, `checkins`, `handoffNotes`, `incidents`, `announcements`, `events`, `taskTemplates`, `factoryReports`, `pushSubscriptions`, `passwordResets`. Rationale: a write to task A must never contend with a write to task B, and must never rewrite unrelated data. Tasks are the critical case — they are the high-write collection and the one mashgichim mutate concurrently.
- **Per-collection single documents** only for genuinely global, tiny, low-write data: `approvedIngredients/global`, `app-meta/config`. Rationale: no contention risk, and a single read fetches them.

**`app-state/main` (the monolith):** retained read-only as a cold backup for 30 days after cutover, then deleted. Never written by Stage 3 code.

### 2.2 Secrets: where do the pepper, VAPID private key, and JWT secret live?

Today these live *inside* the Firestore document (`jwtSecret`, `vapidKeys`, `resetPepper`) — which is why exports must strip them and why the backup story is complicated.

**Recommendation: Google Cloud Secret Manager, referenced by the Cloud Run service.**

| Secret | Today | Stage 3 target | Why |
|---|---|---|---|
| `RESET_CODE_PEPPER` | Env var → Firestore fallback | **Secret Manager**, mounted as env var | Already an env var in production; Secret Manager makes rotation auditable and keeps it out of Firestore entirely. |
| VAPID private key | In Firestore doc | **Secret Manager** | Private key material should never sit in a database document that gets exported. Public key can stay in `app-meta/config`. |
| JWT signing secret | In Firestore doc | **Secret Manager** | Same reasoning. Rotation invalidates sessions — acceptable and explicit. |

**Why not Cloud Run env vars alone (the status quo for the pepper)?** Env vars work, but Secret Manager adds versioning, rotation history, and IAM-scoped access — and it removes the "generate-and-persist to Firestore" fallback path that caused the Stage 2 pepper race. Cost: Secret Manager is $0.06/secret/month + access ops — effectively $0 at this scale (6 free active secret versions... actually pricing is $0.06 per secret version per month; 3 secrets ≈ $0.18/mo — negligible, and worth stating honestly).

**Migration note:** the server must tolerate the transition — read order: Secret Manager → env var → Firestore-stored value (last resort, logged loudly). Remove the Firestore fallback only after 30 days of clean operation.

### 2.3 Media: Cloud Storage

**Bucket:** new regional bucket in `us-east1`, e.g. `shutfey-media-1080260390009` (project-scoped name must be globally unique; exact name chosen at implementation).

**Layout:**
```
gs://<bucket>/
  checkins/{agencyId}/{venueId}/{checkinId}.jpg
  voice/{agencyId}/{noteId}.webm        # handoff voice notes, incident audio
  temp-uploads/{uuid}                   # client direct-upload staging (lifecycle-deleted)
```

**Access model: signed URLs, not public.**
- The bucket is **private** (uniform bucket-level access, no public readers).
- Upload flow: client requests a signed upload URL from the server (`POST /api/media/upload-url`), uploads bytes directly to Storage, then commits the Firestore metadata doc with the Storage object path. This keeps large payloads out of the API servers entirely.
- Download flow: server issues short-lived signed read URLs (15 min) when serving metadata to authorized clients.
- Why not public URLs: photos may show venue interiors, staff, and proprietary processes — Don's agencies would not want them indexable.

**Lifecycle rules:**
- `temp-uploads/*`: delete after 1 day (orphaned uploads).
- Nothing else auto-deleted by Storage — the existing 30-day media-retention logic moves to: strip the *Firestore metadata's* signed-URL cache and delete the Storage object when a check-in ages out. (Today's `MEDIA_RETENTION_DAYS` strips base64 from the doc; Stage 3 deletes the object.)

**Size enforcement:** the 900 KB Firestore guard stays (defense in depth), but the *meaningful* limit moves to the upload endpoint: photos ≤ 5 MB post-compression, voice ≤ 10 MB. Client-side compression (already implemented, ~500 KB cap) stays as the first line.

**Cost:** Cloud Storage standard in us-east1 is $0.020/GiB/month; 1,000 photos × 500 KB ≈ 0.5 GiB ≈ $0.01/mo. Operations: Class A (uploads) $0.05/10K — negligible. Effectively $0.

---

## 3. Data-integrity guarantees during and after

### 3.1 Versioning carries over, per-entity

Stage 2's `_v` becomes **per-document** instead of per-monolith:
- Each entity doc has its own `_v`, incremented transactionally on every mutation of that doc.
- The stale-write contract is unchanged in shape: client sends `expectedVersion` = the version the form rendered; server rejects with 409 on mismatch. But contention scope shrinks dramatically — two mashgichim editing *different* tasks never conflict (today they share one `_v`).
- `X-State-Version` header semantics change: it becomes per-entity (or the client tracks versions per entity it renders). The `captureEditBaseline()` mechanism from Stage 2 round 5 carries over unchanged in concept.

### 3.2 Idempotency, re-scoped

Stage 2's operation IDs are scoped `userId:operationId` with payload/type/method/target checks. In Stage 3:
- Idempotency records move to `idempotency/{userId:operationId}` (or stay in `app-meta/idempotency` — implementation choice; either works).
- The **target** check becomes more meaningful: same operation retried against `tasks/{id}` is idempotent; the same operation ID used against a *different* entity is a 409 (already the Stage 2 behavior — preserved).

### 3.3 Cross-entity transactions

Stage 2's multi-entity mutations (e.g., "complete task + append history + update venue counters") become **Firestore transactions across documents** (up to 500 docs, serializable):
- `tasks/{taskId}` update + `historyLogs/{agencyId}` append in one transaction.
- Incident creation + auto-follow-up task creation in one transaction.
- Transactional `create` with the client-generated ID preserves idempotency (create-if-not-exists is naturally idempotent).

**What Firestore transactions do NOT give:** uniqueness constraints beyond document IDs. "Email must be unique" needs a `usersByEmail/{email}` lookup doc maintained transactionally alongside the user doc (or use the email hash as part of the user doc ID). This is a known pattern — document it in the implementation.

### 3.4 The 900 KB guard

Stays, but its role shrinks to backstop: with media out of Firestore and per-entity docs, no legitimate doc should approach it. Keep the guard failing loudly (503 `SIZE_LIMIT`) — it caught a real oversized-write path in Stage 2 testing.

---

## 4. Migration steps from the single document

**Principle: backfill, don't dual-write.** Stage 2's cutover taught us that two writers to the same data are the danger. The monolith is read-mostly during migration; the backfill is a one-way copy, verified, then the server switches.

### Step 0 — Fresh verified backup (Tier 2)
Per BACKUP_RESTORE.md: full-fidelity export of `app-state/main` from the named database, encrypted, stored off-GitHub, with recorded counts (`_v`, tasks, venues, users, hash of the canonical JSON). This is the rollback baseline.

### Step 1 — Staging backfill (no production touch)
1. Create a **throwaway named database** (or use the emulator with the production-shaped data).
2. Run the backfill script: reads `app-state/main`, fans out to the §2.1 layout, writes with `_v` preserved per entity (entity `_v` = the monolith's `_v` at backfill time; subsequent writes increment per-entity).
3. Verification gates (must all pass):
   - Entity counts match the monolith exactly (tasks, users, venues, …).
   - Canonical hash of each entity's data matches the monolith's corresponding section.
   - Spot-check: 5 random tasks, 2 users, 1 venue — field-by-field diff clean.
   - Media inventory: every `photoData`/`voiceNoteData` in the monolith has a corresponding Storage object; every Storage object is referenced.

### Step 2 — Backfill script review + dry run against production-shaped data
- Independent review of the backfill script (same reviewer as Stage 2 if available).
- Dry run against a **restored copy** of the production backup in the throwaway database — never the live database.

### Step 3 — Production backfill (maintenance window)
1. Don enables `MAINTENANCE_MODE=true` on the live server (the PR #3 switch) — writes stop, 503s.
2. Verify drain: no mutating requests in the Cloud Run log for 60s; Firestore doc `_v` stable (the revised CUTOVER.md procedure — explicit verification, not "60 seconds = drained").
3. Take a **final pre-migration backup** (writes have stopped — this is the exact cutover point).
4. Run the backfill script against the **production named database**. Target: new collections only; `app-state/main` untouched.
5. Run the Step 1 verification gates against production.
6. If any gate fails: **stop. Do not proceed.** The monolith is untouched and the app is still in maintenance mode — rollback is "don't cut over."

### Step 4 — Server cutover (feature flag)
- The Stage 3 server reads/writes the new layout when `FIRESTORE_LAYOUT=v2` (env var, default `v1` = monolith). Deploy with `v1` first (no behavior change), verify health, then flip to `v2` via `gcloud run services update --update-env-vars FIRESTORE_LAYOUT=v2` (creates a new revision — no in-place flag flips on serving revisions, per the Stage 2 lesson).
- The `v2` code paths are the only writers to the new collections. The monolith writer is **deleted** from the `v2` path (not dual-written — one writer, one truth).
- Smoke test: Don creates/completes/deletes a task on his phone; checks the team screen; verifies a photo check-in uploads to Storage.

### Step 5 — Soak + monolith retirement
- 7 days of production operation on `v2`. Monitor: Firestore error rates, contention errors, Storage upload failures, the failed-write log (must stay zero).
- After 7 clean days: `app-state/main` is demoted to cold backup (no code references it). After 30 clean days: delete it. The Tier 2 backup from Step 0 remains the long-term fallback regardless.

### Rollback (per step)
| Step fails | Rollback |
|---|---|
| Step 1/2 (staging) | Throw away the throwaway database. Nothing production touched. |
| Step 3 (backfill) | Don't cut over. New collections are inert (no code reads them). Optionally delete them. App exits maintenance mode on the monolith. |
| Step 4 (cutover) | Flip `FIRESTORE_LAYOUT` back to `v1` (new revision). The monolith was never written by `v2` code paths... **with one caveat:** any writes committed to the new collections while on `v2` are NOT in the monolith. True rollback after live writes requires the reverse backfill (collections → monolith), which must be written and tested as part of Step 2. **Do not cut over without a tested reverse backfill.** |
| Step 5 (soak) | Same as Step 4, within the 30-day monolith retention. |

---

## 5. Rollout/rollback summary

- **Phased:** staging backfill → reviewed script → production maintenance window → flagged cutover → soak → retire monolith. No phase starts until the previous phase's verification gates pass.
- **Monitoring during migration:** Cloud Run logs for `commitState`/transaction errors; Firestore console for the new collections (doc counts vs expected); the failed-write counter (must remain zero); Storage upload success rate.
- **Rollback triggers (explicit):** any verification gate fails; 409/503 spike after cutover; Don's screenshot shows wrong data; failed-write counter > 0. The default action on any trigger is **stop and hold in maintenance mode**, not "try the next step."
- **Stage 2 cutover lessons applied:** staged revisions that cannot write (extend the `STAGED_REVISION` pattern to the migration); no simultaneous writers (maintenance window + explicit drain verification); never route back to old code after new writes commit (forward-fix only); revision tags for verification URLs.

---

## 6. Estimated effort

| Work | Estimate |
|---|---|
| Backfill script + reverse backfill + verification harness | 3–4 days |
| Server read/write path migration (collection by collection) | 5–7 days |
| Media upload/download flow (signed URLs) + client changes | 3–4 days |
| Secret Manager migration | 1–2 days |
| Staging verification + production migration + soak support | 3–4 days |
| **Total** | **~3–4 weeks**, one developer, careful boring work |

This is the same shape as the ARCHITECTURE_ANALYSIS.md Phase 2 estimate (1–2 weeks for the data layer alone); the media flow and Secret Manager are the additions.

---

## 7. Out of scope (explicitly NOT Stage 3)

- **No UI changes.** The screens render the same data; only the fetch/persist layer changes. (The four unmounted components — HandoffNotes, AgencyDashboard, Announcements, IncidentReporter — stay unmounted; that's separate product work.)
- **No new features.** No template-library UI, no new endpoints, no reporting.
- **No multi-instance.** `maxScale=1` stays. The per-entity layout *enables* future multi-instance (no shared in-memory primary left), but Stage 3 does not turn it on and does not implement the changelog-tail broadcast (Option B2).
- **No Postgres.** The ARCHITECTURE_ANALYSIS.md Phase 4 evaluation stays parked; Firestore per-entity is the destination unless production use reveals otherwise.
- **No permission-model changes.** The agency-scoping fix for admin export (reviewer's note) belongs to Stage 4 security hardening, not the data migration.

---

## 8. Acceptance criteria (for Don + reviewer)

1. `app-state/main` is not written by any code path; Firestore console shows the §2.1 collections.
2. Two 500 KB photo check-ins in one day: both persist, task doc stays small, Storage holds the bytes.
3. 32 rapid task completions across two devices: all persist, no contention errors, per-task `_v` chains clean.
4. Staged-revision discipline holds: a staged Stage 3 revision writes nothing (extend test 21).
5. Reverse backfill tested: collections → monolith round-trips with identical counts/hashes.
6. 30 days: failed-write log stays zero; monolith deleted; Tier 2 backup retained.

---

*End of Stage 3 plan. Implementation branch to be created after Stage 2 is live and stable.*
