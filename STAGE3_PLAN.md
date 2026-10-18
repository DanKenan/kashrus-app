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

## 2. Proposed layout (revised per architecture review)

### 2.1 Document structure

All in the named database `ai-studio-workerscollabora-faedc6a8-580b-463e-86b2-c3e3048ed73d`, project `gen-lang-client-0875538181`.

**Corrections from review:** history is per-entry (not per-agency accumulations); ingredients are per-ingredient (not a global doc); idempotency is one doc per operation (not `app-meta/idempotency`); password resets use opaque IDs (not emails); `currentWorkDate` and `isDemoCleared` are per-agency (not global).

| Collection | Document ID | Contents | Agency ownership | ID strategy | `_v`? | Indexes | Query patterns |
|---|---|---|---|---|---|---|---|
| `agencies` | `{agencyId}` | Agency config (name, settings, seal, contact) — **no API keys** (those stay in `airtableConfigs`) | Top-level (owns others) | Stable slug (`agency-hkc`), assigned at creation | Yes | — (direct lookup) | By ID |
| `agencyState` | `{agencyId}` | Per-agency operational state: `currentWorkDate`, `isDemoCleared` | This agency | Same as agency ID | Yes | — | By agency ID (single read at boot/request) |
| `venues` | `{venueId}` | Venue record | `agencyId` field | `venue-{ts}` / uuid, assigned at creation | Yes | `agencyId` | By agency; by ID |
| `users` | `{userId}` | UserProfile incl. bcrypt hash + kiosk PIN | `agencyId` field | `usr_*` / uuid | Yes | `agencyId`; email via `usersByEmail` lookup | By agency; by email (lookup); by ID |
| `usersByEmail` | `{sha256(email)}` | `{ userId }` — uniqueness lookup | Global (enforces cross-agency email uniqueness) | SHA-256 of lowercase email | No (write-once) | — | By email hash |
| `tasks` | `{taskId}` | TaskItem **without** `checkIns[]` and without media | `agencyId` + `venueId` fields | uuid (client-generated, preserves idempotent create) | Yes | `agencyId`; `venueId`; `agencyId+venueId` | By venue; by agency; by ID |
| `checkins` | `{checkinId}` | Check-in metadata: `taskId`, `byEmail`, `byName`, `at`, `photoCaption`, Storage object path | `agencyId` + `venueId` (denormalized for scoping) | uuid | Yes | `taskId`; `venueId+at` | By task (chronological); by venue+date |
| `historyLogs` | `{entryId}` | **One immutable entry per doc**: `agencyId`, `venueId`, `date`, `taskId`, `taskTitle`, `category`, `status`, `isCompleted`, `notes`, `completedBy*`, `completedAt` | `agencyId` field | uuid | No (immutable — never updated) | `agencyId+date`; `venueId+date` | By agency+date range (reports); by venue+date |
| `historyDailySummaries` | `{agencyId}_{date}` | Rollup: `totalTasks`, `completedTasks`, `completionRate`, `resetAt`, `resetBy` | `agencyId` field | Deterministic composite | Yes | `agencyId` | By agency+date |
| `handoffNotes` | `{noteId}` | HandoffNote + voice Storage object path | `agencyId` + `venueId` | uuid | Yes | `venueId+createdAt` | By venue, recent first |
| `taskTemplates` | `{templateId}` | TaskTemplate | `agencyId` field | uuid | Yes | `agencyId` | By agency |
| `eventTaskTemplates` | `{templateId}` | EventTaskTemplate | `agencyId` (optional) | uuid | Yes | `agencyId` | By agency |
| `incidents` | `{incidentId}` | Incident + media Storage object paths + `linkedTaskId` | `agencyId` + `venueId` | uuid | Yes | `venueId+status`; `agencyId` | By venue+status; by agency |
| `announcements` | `{announcementId}` | Announcement (+optional `venueId`) | `agencyId` field | uuid | Yes | `agencyId+expiresAt` | By agency, non-expired |
| `events` | `{eventId}` | KosherEventItem + menu attachment Storage path | `agencyId` + `venueId` | uuid | Yes | `venueId+date`; `agencyId+date` | By venue+date; by agency+date |
| `airtableConfigs` | `{configId}` | AirtableConfigItem incl. `apiKey` (**sensitive**) | `agencyId` (+optional `venueId`) | Existing `id` or uuid | Yes | `agencyId+venueId` | By agency+venue |
| `approvedIngredients` | `{ingredientId}` | ApprovedIngredientItem: preserves `agencyId`, `venueId`, ingredient ID, `approvalStatus`, `verificationStatus`, `airtableRecordId` mapping | `agencyId` + `venueId` fields | Existing `id` or uuid | Yes | `agencyId+venueId`; `agencyId+venueId+approvalStatus` | By venue (the sync set); by venue+status |
| `factoryReports` | `{reportId}` | FactoryAuditReportItem (nested `auditedIngredients[]`, `discrepancies[]` stay embedded — report-scoped, immutable after signing) | `agencyId` + `venueId` | uuid | Yes | `venueId+auditDate` | By venue+date |
| `pushSubscriptions` | `{subscriptionId}` | PushSubscriptionRecord | Via `userEmail` → user → agency | `sha256(endpoint)` (natural upsert key) | No (upsert by endpoint) | `userEmail` | By user |
| `passwordResets` | `{opaqueId}` | PasswordResetRequest: `codeHash`, `expiresAt`, `verified`, `resetToken` (hashed), `attempts` — **email stored as field, never as doc ID** (prevents enumeration) | N/A (resolved via user lookup at consume time) | `crypto.randomUUID()` | No (TTL 15 min, single-use atomic consume) | TTL via `expiresAt` (sweeper or Firestore TTL policy) | By opaque ID only |
| `passwordResetRateLimits` | `{bucketId}` | Rate-limit buckets: `email:{sha256(email)}` → timestamps[]; `ip:{sha256(ip)}` → timestamps[] | N/A | `email:{hash}` / `ip:{hash}` / `ipVerify:{hash}` | No (TTL 1h sliding window) | — | By bucket ID |
| `idempotency` | `{userId}:{operationId}` | `{ key, userId, operation, payloadHash, opType, opMethod, opTarget, result (sanitized), createdAt, expiresAt, version }` | Via `userId` | Client operation ID scoped by user | N/A (24h logical expiration, pruned on write) | TTL via `expiresAt` | By composite key (point lookup) |
| `auditLog` | `{entryId}` | Admin action log (Stage 4): actor, action, target, timestamp, agencyId | `agencyId` field | uuid | No (immutable) | `agencyId+timestamp` | By agency+time range |
| `app-meta` | `config` | **Truly global only:** feature flags, public VAPID key. No dates, no per-agency state, no secrets. | Global | Fixed | Yes | — | Single read |

**Media bytes** → Cloud Storage (see §6). **Secrets** → Secret Manager (see §7, decoupled operation).

**Per-entity vs per-collection — the rule:**
- **Per-entity documents** for anything with independent write lifecycles (the table above). A write to task A never contends with a write to task B and never rewrites unrelated data.
- **Single documents** only for genuinely global, tiny, low-write data: `app-meta/config`. Everything else that was "global" in the monolith (`currentWorkDate`, `isDemoCleared`) was **accidentally global** — the daily reset is agency-scoped and demo-clear is agency-scoped, so they move to `agencyState/{agencyId}`. This preserves current behavior exactly while removing the cross-agency coupling.

**What the review corrected here:** the original draft had `historyLogs/{agencyId}` (an unbounded per-agency document — the same trap as the monolith), `approvedIngredients/global` (wrong: ingredients are per-venue sets synced from Airtable), `app-meta/idempotency` (another growing document), email-keyed password resets (enumeration risk), and global `currentWorkDate`/`isDemoCleared` (accidentally global). All fixed above.

**`app-state/main` (the monolith):** retained read-only as a cold backup after cutover. Deleted only when the §5 monolith-retirement gate passes (new-layout backups/restores verified, retention requirements met) — not on an arbitrary timer.

### 2.2 Secrets: decoupled migration to Secret Manager (separate operation)

Today the pepper, VAPID private key, and JWT secret live *inside* the Firestore document (`jwtSecret`, `vapidKeys`, `resetPepper`) — which is why exports must strip them and why the backup story is complicated.

**Decision: migrate secrets to Google Cloud Secret Manager — as a separately testable operation, NOT during the data-layout cutover.** Changing signing keys during a data migration adds avoidable risk; the two changes must be independently testable and independently reversible.

| Secret | Today | Target | Preserve existing value? |
|---|---|---|---|
| `RESET_CODE_PEPPER` | Env var → Firestore fallback | **Secret Manager** (mounted as env var) | **Yes** — read the current value (env var first, then Firestore-stored), write it to Secret Manager once, then remove the Firestore fallback. Rotating the pepper would invalidate outstanding reset codes; there is no reason to rotate during migration. |
| VAPID private key | In Firestore doc | **Secret Manager** | **Yes** — same value; rotating it breaks all existing push subscriptions (clients must re-subscribe). Public key stays in `app-meta/config`. |
| JWT signing secret | In Firestore doc | **Secret Manager** | **Yes** — same value; rotating it logs out every user. Rotation is an explicit future decision, not a migration side effect. |

**Why Secret Manager over env vars alone:** versioning, rotation history, IAM-scoped access — and it removes the "generate-and-persist to Firestore" fallback path that caused the Stage 2 pepper race. Cost is ~$0.06/secret-version/month (see §8 for the honest estimate, not a confident prediction).

**Startup behavior when Secret Manager is unavailable — fail loudly, never silently:**
- If the secret cannot be read at boot: **refuse to start** (`process.exit(1)` with a clear log line naming the missing secret). This matches the Stage 2 fail-closed Firestore behavior.
- **Never** silently generate a replacement pepper/JWT secret (that invalidates outstanding codes/sessions without anyone knowing).
- **Never** silently revert to an obsolete Firestore-stored value (that resurrects a rotated secret).
- The only acceptable fallback is an explicit, loudly-logged operator override env var (e.g. `ALLOW_SECRET_FALLBACK=true`), documented as a break-glass measure.

**Sequencing (three independently testable changes — per reviewer):**
1. **Media extraction** — Storage upload flow + metadata refs; Firestore layout unchanged.
2. **Per-entity migration** — the §4 backfill; secrets untouched (still read from env/Firestore as today).
3. **Secrets migration** — move values to Secret Manager; verify; remove Firestore fallback only after 30 days of clean operation.

**Cold-backup warning:** retaining `app-state/main` as a cold backup retains any historical secrets it contains (`jwtSecret`, `vapidKeys.privateKey`, `resetPepper`). Restrict access to the backup accordingly (encrypted, same access controls as Secret Manager — see §7).

### 2.3 Media: Cloud Storage (summary)

**Bucket:** new regional bucket in `us-east1`, e.g. `shutfey-media-1080260390009` (project-scoped name must be globally unique; exact name chosen at implementation). **Private** — uniform bucket-level access, no public readers.

**Layout:**
```
gs://<bucket>/
  checkins/{agencyId}/{venueId}/{checkinId}.jpg
  voice/{agencyId}/{noteId}.webm        # handoff voice notes, incident audio
  temp-uploads/{uuid}                   # client direct-upload staging (lifecycle-deleted)
```

Photos may show venue interiors, staff, and proprietary processes — signed URLs, not public URLs. The full upload lifecycle state machine (intent → private upload → server validation → transactional metadata → orphan cleanup) is defined in §6. The 30-day media-retention auto-deletion policy is **flagged for Don's explicit decision** before implementation (see §6) — inspection evidence must not be auto-deleted on an assumed policy.

**Size enforcement:** the 900 KB Firestore guard stays (defense in depth); the meaningful limit moves to the upload endpoint: photos ≤ 5 MB post-compression, voice ≤ 10 MB. Client-side compression (~500 KB cap) stays as the first line.

---

## 3. State-mapping inventory (field-by-field)

Source: `stateSnapshot()` on the Stage 2 branch (commit `6cd6915`). Every field below is accounted for — classification: **migrated** (same shape, new location), **transformed** (shape changes), **retired** (intentionally dropped, with reason), **→ Secret Manager**, **→ Cloud Storage**. The migration test suite must compare **every entity and every relationship**, not just totals and random samples (see §7).

### 3.1 Top-level scalar/version fields

| `stateSnapshot()` field | Classification | Target | Notes |
|---|---|---|---|
| `_v` (global version) | **Transformed** | Per-entity `_v` on each new doc | The monolith's single version counter splits. Each entity doc gets `_v` starting at the monolith's `_v` at backfill time (preserves ordering), then increments per-entity. No global version survives — cross-entity consistency comes from Firestore transactions, not a shared counter. |
| `currentWorkDate` | **Transformed** | `agencyState/{agencyId}.currentWorkDate` | Was accidentally global; the daily reset is agency-scoped. Each agency gets its own rollover date, initialized from the monolith's value. Behavior preserved: same date each agency already had. |
| `isDemoCleared` | **Transformed** | `agencyState/{agencyId}.isDemoCleared` | Was accidentally global; demo-clear is agency-scoped (keeps the caller's agency). Per-agency flag, initialized from the monolith's value. |

### 3.2 Entity collections

| `stateSnapshot()` field | Classification | Target | Notes |
|---|---|---|---|
| `agencies[]` | **Migrated** | `agencies/{agencyId}` | All fields: `id`, `name`, `shortCode`, `adminEmail`, `certificationSeal`, `region`, `contactPhone?`, `createdAt`, `customDomain?`. Airtable keys are NOT here (they live in `airtableConfigs`). |
| `venues[]` | **Migrated** | `venues/{venueId}` | All fields: `id`, `agencyId`, `name`, `category`, `address`, `certification`, `ownerEmail?`, `createdAt`. |
| `users[]` | **Migrated** (+ lookup) | `users/{userId}` + `usersByEmail/{sha256(email)}` | All UserProfile fields: `id`, `agencyId?`, `email`, `name`, `role`, `avatarColor`, `password` (bcrypt hash — **stays in the user doc**; one-way hash, not a reversible secret; needed for login without a Secret Manager round-trip), `kioskPin?` (stays; never exported), `venueId?`, `permissions?`. The email lookup doc is new (enables uniqueness checks in transactions). |
| `tasks[]` | **Transformed** | `tasks/{taskId}` + `checkins/{checkinId}` | TaskItem fields migrate as-is **except** `checkIns[]`, which fans out: each `TaskCheckInItem` becomes a `checkins/{checkinId}` doc with `taskId` back-reference. `photoData` (base64) → Cloud Storage object; doc stores the object path + `photoCaption`. All other TaskItem fields (`agencyId?`, `venueId`, `title`, `description`, `category`, `categories?`, `inputType`, `customStatusOptions?`, `completedStatusValues?`, `assignedTo`, `scheduleType?`, `daysOfWeek`, `specificDates?`, `targetTime*`, `priority?`, `enableOverdueAlert?`, `currentStatus`, `isCompleted`, `notes`, `updatedBy*`, `updatedAt`, `createdAt`, `sortOrder?`, `isPrivate?`) migrate unchanged. |
| `historyLogs[]` | **Transformed** | `historyLogs/{entryId}` + `historyDailySummaries/{agencyId}_{date}` | Each `HistoryLog.entries[]` element becomes its own immutable `historyLogs/{entryId}` doc (`agencyId`, `venueId`, `date`, `taskId`, `taskTitle`, `category`, `status`, `isCompleted`, `notes`, `completedBy*`, `completedAt`). The per-day rollup (`totalTasks`, `completedTasks`, `completionRate`, `resetAt`, `resetBy`) becomes `historyDailySummaries/{agencyId}_{date}`. **Relationship check:** every entry's `taskId` must resolve to a migrated `tasks/{taskId}` (or be flagged as referencing a deleted task — preserved as-is, not dropped). |
| `handoffNotes[]` | **Transformed** | `handoffNotes/{noteId}` | All fields (`id`, `agencyId?`, `venueId`, `authorEmail`, `authorName`, `content`, `shift`, `createdAt`) migrate; `voiceNoteData` (base64) → Cloud Storage object, doc stores path. |
| `taskTemplates[]` | **Migrated** | `taskTemplates/{templateId}` | All fields including nested `tasks[]` definitions (template-scoped, stay embedded). |
| `eventTaskTemplates[]` | **Migrated** | `eventTaskTemplates/{templateId}` | All fields (`id`, `title`, `agencyId?`, `sortOrder`). |
| `incidents[]` | **Transformed** | `incidents/{incidentId}` | All fields migrate; `photoData`/`voiceNoteData` (base64) → Cloud Storage objects, doc stores paths. `linkedTaskId` relationship preserved and validated. |
| `announcements[]` | **Migrated** | `announcements/{announcementId}` | All fields (`id`, `agencyId`, `authorEmail`, `authorName`, `title`, `body`, `category`, `targetRoles`, `venueId?`, `createdAt`, `expiresAt?`). |
| `events[]` | **Transformed** | `events/{eventId}` | All KosherEventItem fields migrate; `menuAttachmentData` (base64) → Cloud Storage object, doc stores path + `menuAttachmentName`. Nested `tasks[]` (EventTaskItem) stay embedded (event-scoped). `externalMashgiach?` nested object stays embedded. |
| `airtableConfigs[]` | **Migrated** | `airtableConfigs/{configId}` | All fields including `apiKey` (**sensitive** — stays in the doc, encrypted backups required; see §9) and `fieldNameMapping`. Uses existing `id` or generates uuid. |
| `approvedIngredients[]` | **Migrated** | `approvedIngredients/{ingredientId}` | Per-ingredient docs (corrected per review). All fields: `id`, `airtableRecordId?` (Airtable mapping preserved), `venueId`, `agencyId`, `name`, `brandOrSupplier?`, `kashrutAgency?`, `kosherStatus`, `lotOrBatch?`, `approvalStatus`, `approvalDate?`, `approvedBy?`, `notes?`, `verificationStatus?`, `verifiedAt?`, `verifiedByName?`, `verifiedByEmail?`, `verificationNotes?`. The Airtable sync updates a venue's set — sync logic keyed by (`venueId`, `airtableRecordId`). |
| `factoryReports[]` | **Migrated** | `factoryReports/{reportId}` | All fields; nested `auditedIngredients[]` and `discrepancies[]` (UnapprovedDiscrepancyItem) stay embedded (report-scoped, immutable after signing). |
| `pushSubscriptions[]` | **Migrated** | `pushSubscriptions/{sha256(endpoint)}` | All fields (`userEmail`, `endpoint`, `keys.p256dh`, `keys.auth`, `createdAt`). Natural upsert key = endpoint hash. |

### 3.3 Credential, reset, and operational fields

| `stateSnapshot()` field | Classification | Target | Notes |
|---|---|---|---|
| `jwtSecret` | **→ Secret Manager** | Secret Manager `shutfey-jwt-secret` | Decoupled operation (§2.2). Value preserved (no rotation during migration). |
| `vapidKeys.privateKey` | **→ Secret Manager** | Secret Manager `shutfey-vapid-private` | Value preserved. Public key → `app-meta/config`. |
| `vapidKeys.publicKey` | **Migrated** | `app-meta/config.vapidPublicKey` | Non-sensitive; clients need it. |
| `resetPepper` | **→ Secret Manager** | Secret Manager `shutfey-reset-pepper` | Decoupled operation (§2.2). Value preserved. |
| `passwordResets[]` | **Transformed** | `passwordResets/{opaqueId}` | Each PasswordResetRequest becomes a doc with **opaque uuid** (never the email as doc ID). Fields: `email` (as a field, for lookup at consume time), `codeHash?`, `expiresAt`, `verified`, `resetToken?` (hashed), `attempts?`, `lastAttemptAt?`. Legacy plaintext `code` field: **retired** (pre-hardening; any surviving plaintext codes are invalidated — they cannot be verified without the pepper scheme). TTL 15 min; single-use atomic consume preserved. |
| `passwordResetRateLimits` | **Transformed** | `passwordResetRateLimits/{bucketId}` | The three maps (`emailRequests`, `ipRequests`, `ipVerifies`) become per-bucket docs: `email:{sha256(email)}`, `ip:{sha256(ip)}`, `ipVerify:{sha256(ip)}`, each holding `timestamps[]`. Sliding-window logic unchanged. 1-hour TTL. |
| `idempotencyRecords[]` (in-doc, Stage 2) | **Transformed** | `idempotency/{userId}:{operationId}` | One doc per operation: `key`, `userId`, `operation`, `payloadHash`, `opType`, `opMethod`, `opTarget`, `result` (sanitized), `createdAt`, `expiresAt`, `version`. 24h logical expiration preserved. In-flight operations at cutover: drain before migration (maintenance window); any surviving records older than 24h are expired by definition. |

### 3.4 Migration test requirements

The migration test suite must verify **every entity and every relationship** — not just totals and random samples:
- **Counts:** per-collection counts match the monolith exactly.
- **Content:** canonical hash of every entity's migrated fields matches the source (field-by-field, after applying the documented transformations).
- **Relationships:** every `taskId` reference (checkins, history entries, incident `linkedTaskId`), every `venueId`/`agencyId`/`userId`/`email` reference resolves to a migrated doc. Dangling references are reported, not silently dropped.
- **Media:** every base64 payload in the monolith has a corresponding Storage object with matching checksum (§6).
- **Idempotency/reset state:** record counts match; expirations preserved.
- **Agency isolation:** no entity lands in the wrong agency's scope (cross-check `agencyId` on every migrated doc against the source).

---

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

## 4. Data-integrity guarantees during and after

### 4.1 Versioning carries over, per-entity

Stage 2's `_v` becomes **per-document** instead of per-monolith:
- Each entity doc has its own `_v`, incremented transactionally on every mutation of that doc. Initial `_v` = the monolith's `_v` at backfill time (preserves ordering across the cutover).
- The stale-write contract is unchanged in shape: client sends `expectedVersion` = the version the form rendered; server rejects with 409 on mismatch. But contention scope shrinks dramatically — two mashgichim editing *different* tasks never conflict (today they share one `_v`).
- Immutable collections (`historyLogs` entries, `auditLog`) carry no `_v` — they are write-once by construction; an update attempt is a 409 by policy, not by version comparison.

### 4.2 Idempotency, re-scoped

Stage 2's operation IDs are scoped `userId:operationId` with payload/type/method/target checks. In Stage 3:
- Records live at `idempotency/{userId}:{operationId}` — one document per operation, 24h logical expiration (Firestore TTL policy on `expiresAt`, plus prune-on-write as today).
- The **target** check becomes more meaningful: the same operation retried against `tasks/{id}` is idempotent; the same operation ID used against a *different* entity is a 409 (Stage 2 behavior, preserved).

### 4.3 Cross-entity transactions

Stage 2's multi-entity mutations become **Firestore transactions across documents** (up to 500 docs, serializable):
- Completing a task: `tasks/{taskId}` update + `historyLogs/{entryId}` create + `historyDailySummaries/{agencyId}_{date}` update, in one transaction.
- Incident creation + auto-follow-up task creation in one transaction.
- Daily reset: per-agency `agencyState/{agencyId}` date bump + summary docs, one transaction per agency.
- Transactional `create` with the client-generated ID preserves idempotency (create-if-not-exists is naturally idempotent).

**What Firestore transactions do NOT give:** uniqueness constraints beyond document IDs. Email uniqueness uses the `usersByEmail/{sha256(email)}` lookup doc, written transactionally alongside the user doc (create the lookup first; if it already exists, the email is taken — 409).

### 4.4 The 900 KB guard

Stays, but its role shrinks to backstop: with media out of Firestore and per-entity docs, no legitimate doc should approach it. Keep the guard failing loudly (503 `SIZE_LIMIT`) — it caught a real oversized-write path in Stage 2 testing.

---

## 5. Client and API compatibility contract

Stage 3 changes version handling from one global `_v` to per-entity `_v`. This section is the contract the client and server both implement.

### 5.1 Per-record editing baselines

Stage 2's form-baseline mechanism (`captureEditBaseline()` — the version the form rendered from travels with the save) carries over, **per record**:
- The PWA stores a baseline **per entity being edited** (e.g., `baselines[taskId] = _v`), captured from the response that populated the form (the `X-State-Version` header becomes per-entity, or the entity's `_v` from its JSON body).
- Stale form → server 409 `VERSION_CONFLICT` → existing handling: draft preserved in localStorage, re-apply/discard banner, refresh-and-reconcile. Unchanged in shape, now scoped per record.
- Retries: same `operationId` + same baseline → idempotent replay; new baseline after refresh → new `operationId`.
- The WebSocket `version` field in envelopes becomes per-entity (`{ entityType, entityId, _v }`); the client updates that entity's displayed data and marks any open form for that entity as potentially stale (banner, not silent overwrite).

### 5.2 What stays compatible

- **HTTP response formats** are preserved: same status codes, same error `code` values (`VERSION_CONFLICT`, `PAYLOAD_MISMATCH`, `STALE_CLIENT`, `NOT_YET_LIVE`, `MAINTENANCE`, `SIZE_LIMIT`), same JSON shapes. A Stage 2 client talking to a Stage 3 server gets the same-shaped errors (with per-entity versions inside).
- **WebSocket agency isolation** is preserved: per-agency broadcasts, same envelope shape plus the per-entity version fields above.
- `maxScale=1` stays for the initial Stage 3 release (the per-entity layout *enables* future multi-instance, but Stage 3 does not turn it on).

### 5.3 Correction: "no UI changes" was wrong

The plan previously said "no UI changes." That is inaccurate. Two **client integration changes are required** — they are compatibility changes, not features:
1. **Direct media uploads:** the photo/voice capture flow must use the §6 upload lifecycle (request signed URL → upload bytes → commit metadata) instead of embedding base64 in the task/note payload. The capture UI itself doesn't change; the submit path does.
2. **Per-record baselines:** the editing forms must capture and send per-entity baselines (§5.1) instead of the single global version.

No new screens, no new features, no redesign — but the client and server must be updated together, which is why media extraction is phased as its own independently testable change (§10).

---

## 6. Transactional media upload lifecycle

Cloud Storage and Firestore cannot participate in one atomic transaction. A completed check-in must **never** claim its photo was saved unless *both* the object and its Firestore reference are confirmed. The lifecycle is a server-driven state machine:

### 6.1 Upload states

```
INTENT → UPLOADED → VALIDATED → COMMITTED
   ↓         ↓           ↓
ABANDONED (orphan sweeper reclaims)
```

1. **INTENT (authorized).** Client calls `POST /api/media/upload-intent` with `{ agencyId, venueId, kind: 'checkin-photo' | 'voice-note' | 'incident-photo' | 'menu-attachment', contentType, byteSize, checksum }`. The server **checks agency/venue permissions first** (the caller's agency must own the venue; the caller's role must allow the kind), then returns a **server-assigned object path** (`checkins/{agencyId}/{venueId}/{uuid}.jpg`) and a short-lived signed upload URL (15 min). The client never chooses the path (prevents collisions and path-traversal games).
2. **UPLOADED.** Client PUTs bytes directly to the signed URL. Firestore is untouched. If the client abandons here, the object sits in `temp-uploads/`-equivalent staging until the orphan sweeper (step 5) reclaims it.
3. **VALIDATED (server-side).** Client calls `POST /api/media/confirm-upload` with the object path. The server verifies: object exists, **actual byte size** matches the intent (and ≤ the kind's limit), **content type** matches (magic bytes, not just the header), **checksum** matches the intent. On any mismatch → 422, object scheduled for deletion, no metadata created.
4. **COMMITTED (transactional).** Only after validation, the server creates the Firestore metadata doc (`checkins/{checkinId}` etc.) **in a transaction** that also marks the upload intent consumed (idempotency: same intent → same doc, no duplicates). The check-in is now complete — object + reference both confirmed.
5. **ABANDONED → swept.** A scheduled job (daily) lists intents older than 24h that never reached COMMITTED and deletes their staged objects. The sweeper is idempotent and logs what it reclaims.

### 6.2 Download authorization

- Firestore metadata stores the **object path only** — never a signed URL.
- When serving metadata to a client, the server issues a **short-lived signed read URL** (15 min) after checking the caller's agency/venue permissions for that object.
- **Never store long-lived signed URLs as permanent metadata** — they leak via exports, logs, and caches, and they bypass permission checks after issuance.

### 6.3 Retention policy — decision required

The current `MEDIA_RETENTION_DAYS = 30` strips base64 from the monolith. In Stage 3 the equivalent is deleting the Storage object. **This policy is flagged for Don's explicit decision before implementation** — inspection evidence (kashering photos, incident documentation) may have evidentiary or compliance value beyond 30 days, and auto-deletion is irreversible. Options to put to Don:
- (a) Keep 30-day auto-deletion (current behavior, new mechanism).
- (b) Retain 1 year, then delete (covers annual audit cycles).
- (c) Retain indefinitely; Don deletes manually per venue.
- Until Don decides, the migration preserves all existing media with **no auto-deletion** in the new layout (safe default).

### 6.4 Migration of existing media

Per the §3 inventory: every `photoData`/`voiceNoteData`/`menuAttachmentData` base64 payload in the monolith is uploaded to its §2.3 path during the backfill, with a **checksum recorded in the migration manifest** (§7). The backfill verifies: every source payload → exactly one object with matching checksum; every object ← exactly one source payload (missing-object detection both directions). The monolith's base64 fields are **not** deleted during backfill (they remain in the cold backup); the new docs store paths only.

---

## 7. Migration steps from the single document

**Principle: backfill, don't dual-write.** Stage 2's cutover taught us that two writers to the same data are the danger. The monolith is read-mostly during migration; the backfill is a one-way copy, verified, then the server switches.

### 7.0 Migration script properties (required)

The backfill script MUST be:
- **Resumable:** processes entities in batches, records a **checkpoint** (last completed collection + entity ID) in a `migrationRuns/{migrationId}` doc after each batch. A crashed run resumes from the checkpoint — never from scratch.
- **Idempotent:** every write uses deterministic document IDs (§2.1); re-running a batch overwrites identical content (verified by hash before write — skip if the target doc already matches).
- **Identified:** each run gets a `migrationId` (uuid + timestamp + operator). All migrated docs carry `_migratedBy: migrationId` and `_migratedAt`. The manifest below is keyed by it.

### Step 0 — Fresh verified backup (Tier 2) + source manifest
Per BACKUP_RESTORE.md: full-fidelity export of `app-state/main` from the named database, encrypted, stored off-GitHub. Additionally, produce the **authoritative source manifest**:
- The monolith's `_v`, canonical SHA-256 hash of the full JSON, per-collection entity counts.
- Per-entity content hashes (so the backfill can verify field-by-field, not just counts).
- Media source inventory: every base64 payload's location (collection, entity ID, field), byte size, and SHA-256 checksum.
- This manifest is the ground truth every later validation compares against. It is stored alongside the backup, never in git.

### Step 1 — Staging backfill (no production touch)
1. Create a **throwaway named database** (or use the emulator with the production-shaped data).
2. Run the backfill script against the Step 0 manifest.
3. Verification gates (must ALL pass — per the §3.4 test requirements):
   - **Counts:** per-collection entity counts match the manifest exactly.
   - **Content:** canonical hash of every migrated entity matches the source (field-by-field after documented transformations).
   - **IDs:** every target doc ID is well-formed and unique; no collisions; deterministic IDs reproducible from source.
   - **Agency ownership:** every migrated doc's `agencyId` matches the source entity's agency; zero cross-agency misplacements.
   - **Relationships:** every `taskId`/`venueId`/`userId`/`linkedTaskId`/`airtableRecordId` reference resolves; dangling references reported, not dropped.
   - **Media:** every source payload → exactly one Storage object with matching checksum; every object ← exactly one source (missing-object detection both directions).
   - **Indexes:** confirm every index in the §2.1 table exists in the throwaway database (create missing ones; Firestore index builds take minutes — never discover this at cutover).

### Step 2 — Backfill script review + dry run against production-shaped data
- Independent review of the backfill script AND the reverse-recovery script (see §8) by the Stage 2 reviewer if available.
- Dry run against a **restored copy** of the production backup in the throwaway database — never the live database.
- The reverse script (new-layout → monolith) must round-trip in staging with identical counts/hashes **before** it is accepted as a cutover precondition.

### Step 3 — Production backfill (maintenance window)
1. Don enables `MAINTENANCE_MODE=true` on the live server — writes stop, 503s.
2. Explicit drain verification per the revised CUTOVER.md (traffic, revision instances, request log, Firestore stability — **not** "60 seconds = drained").
3. Take a **final pre-migration backup** and regenerate the source manifest (writes have stopped — this is the exact cutover point).
4. Run the backfill script against the **production named database**. Target: new collections only; `app-state/main` untouched.
5. Run the Step 1 verification gates against production (counts, content, IDs, agency ownership, relationships, media, indexes).
6. If any gate fails: **stop. Do not proceed.** The monolith is untouched and the app is still in maintenance mode — this is a rollback-before-live-writes (see §8): abort, keep Stage 2, exit maintenance mode.

### Step 4 — Server cutover (feature flag, tested for exclusivity)
- The Stage 3 server reads/writes the new layout when `FIRESTORE_LAYOUT=v2` (env var, default `v1` = monolith). Deploy with `v1` first (no behavior change), verify health, then flip to `v2` via `gcloud run services update --update-env-vars FIRESTORE_LAYOUT=v2` (new revision — no in-place flag flips, per the Stage 2 lesson).
- **Exclusivity test (required before traffic):** the `v2` revision is deployed at 0% traffic with a revision tag (Stage 2 cutover pattern). The operator verifies via the tagged URL that (a) reads work against the new layout, (b) a test write commits to the new layout only, and (c) the monolith's `_v`/hash are unchanged. Only then does traffic shift.
- The `v2` code paths are the only writers to the new collections. The monolith writer is **deleted** from the `v2` path (not dual-written — one writer, one truth).
- Extend the `STAGED_REVISION` pattern: the staged `v2` revision cannot write until the operator confirms the old layout's writers are stopped.
- Smoke test: Don creates/completes/deletes a task on his phone; checks the team screen; verifies a photo check-in uploads to Storage via the §6 lifecycle.

### Step 5 — Soak + monolith retirement (gated, not timed)
- 7 days minimum of production operation on `v2`. Monitor: Firestore error rates, contention errors, Storage upload failures, failed-write log (must stay zero).
- **Monolith deletion gate** (replaces the arbitrary "30 days"): `app-state/main` is deleted only when ALL of these hold —
  1. New-layout **backups have been taken and a restore has been verified** (throwaway database, counts match — the §9 gate).
  2. Data-retention requirements are satisfied (Don confirms no compliance/audit need for the old format; the Tier 2 backup from Step 0 remains regardless).
  3. 30 days of clean `v2` operation have elapsed (minimum, not sufficient alone).
- Until the gate passes, the monolith remains as a read-only cold backup (with restricted access — it contains historical secrets, see §2.2).

### Rollback (per step)
| Step fails | Rollback |
|---|---|
| Step 1/2 (staging) | Throw away the throwaway database. Nothing production touched. |
| Step 3 (backfill) | Don't cut over. New collections are inert (no code reads them). Optionally delete them. App exits maintenance mode on the monolith. |
| Step 4 (cutover) | Flip `FIRESTORE_LAYOUT` back to `v1` (new revision). The monolith was never written by `v2` code paths... **with one caveat:** any writes committed to the new collections while on `v2` are NOT in the monolith. True rollback after live writes requires the reverse backfill (collections → monolith), which must be written and tested as part of Step 2. **Do not cut over without a tested reverse backfill.** |
| Step 5 (soak) | Same as Step 4, within the 30-day monolith retention. |

---

## 8. Rollout, rollback, and recovery

- **Phased:** staging backfill → reviewed script → production maintenance window → flagged cutover → soak → gated monolith retirement. No phase starts until the previous phase's verification gates pass.
- **Monitoring during migration:** Cloud Run logs for transaction errors; Firestore console for the new collections (doc counts vs manifest); the failed-write counter (must remain zero); Storage upload success rate; orphan-sweeper reclaim counts.
- **Rollback triggers (explicit):** any verification gate fails; 409/503 spike after cutover; Don's screenshot shows wrong data; failed-write counter > 0. The default action on any trigger is **stop and hold in maintenance mode**, not "try the next step."
- **Stage 2 cutover lessons applied:** staged revisions that cannot write (extend the `STAGED_REVISION` pattern to the migration); no simultaneous writers (maintenance window + explicit drain verification); revision tags for verification URLs.

### 8.1 The critical distinction: rollback vs recovery

**Rollback BEFORE live writes — straightforward.**
If the migration is aborted before the `v2` code paths accept production traffic (Steps 0–3, or Step 4 before the traffic shift): the new collections are inert. Delete them (or leave them — nothing reads them), exit maintenance mode, resume on the monolith. The Step 0 backup is untouched. This is a non-event operationally.

**Recovery AFTER live writes — forward repair preferred.**
Once `v2` has committed production writes, the new collections contain data the monolith does not. Reverting to the old layout at this point **can lose data**:
- **Preferred: forward repair.** Fix the new layout in place (same discipline as Stage 2's forward-fix policy). The monolith is stale the moment `v2` writes — do not route traffic back to it.
- **Reverse migration (last resort):** the tested reverse backfill (collections → monolith, a Step 2 precondition) may be used ONLY after: (1) writes are frozen (maintenance mode, drain verified per the §7 procedure), (2) a full reconciliation has been run and passes (every new-layout entity accounted for in the reverse output, counts + hashes match), and (3) Don explicitly approves. The reverse run gets its own migration ID and manifest.
- **Never** delete the monolith while the new layout is the only copy of live data (see the §7 retirement gate).

### 8.2 Tested cutover exclusivity

The §7 Step 4 exclusivity check is not optional and not a doc exercise: the staged `v2` revision is verified at 0% traffic via its revision tag to (a) read the new layout, (b) write only to the new layout, and (c) leave the monolith byte-identical — before any production traffic shifts. This is the same bar Stage 2's test 21 sets, applied to the layout cutover.

---

## 9. Stage 3 release gates (minimum ops safeguards)

Stage 3 does **not** go live unless all of these hold. (Stage 4 remains the comprehensive ops phase; these are the non-negotiable minimums for the data migration.)

1. **Full-fidelity backup/restore for the NEW layout** — tested end-to-end: back up the per-entity collections, restore to a throwaway database, verify counts + hashes + relationships (§3.4). The monolith backup alone is insufficient once `v2` writes.
2. **Media in backups** — the backup covers Cloud Storage objects as well as Firestore documents (object inventory with checksums; restore verifies object presence). A Firestore-only backup is not a complete backup.
3. **Secret/config recovery** — Secret Manager values included in the recovery plan (separate from the Firestore backup — see §2.2); `app-meta/config` contents documented; recovery procedure tested (read-back of each secret in a drill).
4. **Index definitions in recovery** — Firestore composite indexes are **not** captured by managed exports. The required index list (§2.1) is stored as code/config (e.g., `firestore.indexes.json`) and part of the recovery procedure.
5. **Basic alerts live** — failed writes (any `commitState`/transaction error), unhealthy deployments (5xx spike / failed revision), failed backups (no successful backup in 26h). Don has the notification channel on his phone.
6. **Tested maintenance and recovery procedure** — the maintenance-window procedure (stop writes → verify → work → verify → resume) has been executed at least once in staging, not just documented.
7. **Verified Firestore access controls** — deny-all rules confirmed deployed on the named database (the carryover item from Stage 2).
8. **Agency-scoped export authorization** — before broader multi-agency use: `/api/admin/export` (or its Stage 3 successor) restricts non-super-admins to their own agency's data (the reviewer's open note; design in STAGE4_PLAN.md §4.4, implemented as a Stage 3 gate).
9. **No admin-token backup jobs** — `/api/admin/export` is not a long-term automated DR API. Scheduled backups use a **service account with explicitly authorized backup functionality**, not a stored administrator login token. (The service account has a dedicated IAM role scoped to read the collections + Storage; it cannot mutate user data.)

---

## 10. Phasing: three independently testable changes

Per the reviewer: do not ship media extraction, per-entity migration, and secrets migration as one enormous release. Each is independently testable and independently reversible:

**Phase 3A — Media extraction** (smallest blast radius).
- Implements the §6 upload lifecycle; migrates existing base64 payloads to Storage; Firestore docs store paths.
- The monolith layout is unchanged; only media fields change shape (base64 → path + metadata).
- Testable: upload → validate → commit → download round-trip; orphan sweeper; backfill checksum verification.
- Reversible: paths can be resolved back to base64 from Storage; the monolith is untouched.

**Phase 3B — Per-entity migration** (the §7 backfill).
- Implements the §2.1 layout; the §7 migration with all gates; the §5 client contract.
- Depends on 3A (media already in Storage) but not on 3C (secrets still read as today).
- Reversible per §8.1 (before live writes: abort; after: forward repair).

**Phase 3C — Secrets migration** (the §2.2 operation).
- Moves pepper, VAPID private key, JWT secret to Secret Manager; values preserved.
- Independently testable: boot with Secret Manager → verify auth, push, and reset flows; failure modes (unavailable → fail loudly).
- Reversible: values preserved means rollback is "point back at the old source."

Each phase gets its own branch, review, staging verification, and production cutover. No phase starts until the previous phase's acceptance criteria pass.

---

## 11. Estimated effort

| Work | Estimate |
|---|---|
| Backfill script + reverse backfill + verification harness (+ manifest, checkpoints) | 4–5 days |
| Server read/write path migration (collection by collection) | 5–7 days |
| Media upload lifecycle (§6) + client integration + orphan sweeper | 4–5 days |
| Secret Manager migration (decoupled) | 2 days |
| Per-entity client contract (§5) + compatibility testing | 2–3 days |
| Stage 3 release gates (§9: backup/restore, alerts, index config) | 2–3 days |
| Staging verification + production migration + soak support | 3–4 days |
| **Total** | **~4–5 weeks**, one developer, phased as §10 |

The estimate grew from the first draft because the review correctly added: the field-mapping inventory, the media state machine, the decoupled secrets operation, and the release gates. These are not padding — they are the parts that prevent a data-loss incident.

---

## 12. Out of scope (explicitly NOT Stage 3)

- **No new screens or features.** The §5 client changes are compatibility integration (upload flow, per-record baselines), not product work. (The four unmounted components — HandoffNotes, AgencyDashboard, Announcements, IncidentReporter — stay unmounted; that's separate product work.)
- **No new API features.** No template-library UI, no reporting, no new endpoints beyond the §6 media lifecycle endpoints (which are infrastructure, not features).
- **No multi-instance.** `maxScale=1` stays. The per-entity layout *enables* future multi-instance, but Stage 3 does not turn it on.
- **No Postgres.** The ARCHITECTURE_ANALYSIS.md Phase 4 evaluation stays parked; Firestore per-entity is the destination unless production use reveals otherwise.
- **No permission-model changes** beyond the §9 export-scoping gate (which is a security requirement, not a feature).

---

## 13. Acceptance criteria (for Don + reviewer)

The reviewer's implementation acceptance criteria, mapped to this plan:

1. **Corrected schema + field map:** §2.1 (per-entry history, per-ingredient docs, per-operation idempotency, opaque reset IDs, per-agency operational state) and §3 (field-by-field inventory with classifications). Nothing disappears silently.
2. **Migration and reverse-recovery specs:** §7 (resumable/idempotent script, manifest, gates) and §8.1 (rollback-before vs recovery-after, reverse-migration preconditions).
3. **Media-upload state machine + retention:** §6 (five-state lifecycle, orphan sweeper, signed-URL discipline) and the retention decision flagged for Don.
4. **Per-entity version/API contract:** §5 (per-record baselines, preserved response formats, WebSocket agency isolation, maxScale=1).
5. **Minimum backup/auth/monitoring in Stage 3 gates:** §9 (nine gates, including the service-account backup requirement).

Plus the original functional criteria:
6. `app-state/main` is not written by any code path; Firestore console shows the §2.1 collections.
7. Two 500 KB photo check-ins in one day: both persist via the §6 lifecycle, task docs stay small, Storage holds the bytes.
8. 32 rapid task completions across two devices: all persist, no contention errors, per-task `_v` chains clean.
9. Staged-revision discipline holds: a staged Stage 3 revision writes nothing (extend test 21).
10. Reverse backfill tested: collections → monolith round-trips with identical counts/hashes (Step 2 precondition).
11. Monolith deleted only when the §7 retirement gate passes; Tier 2 backup retained.

---

*End of Stage 3 plan. Implementation branch to be created after Stage 2 is live and stable.*
