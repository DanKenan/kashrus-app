# Shutfey — Architecture Analysis: The Consistency Problem and How to Fix It Right

**Date:** 2026-10-17
**Author:** Architecture review (commissioned by Don Kenan)
**Status:** Decision document — no code changes, analysis only
**Repo:** `~/workspace/kashrus-app` (`server.ts`, 4,475 lines; React frontend in `src/`)

---

## Executive Summary

Shutfey's data corruption is not a collection of bugs. It is **one architectural defect** expressing itself in many symptoms: the server treats process memory as the database and Firestore as an asynchronous backup copy. On Cloud Run — where the platform routinely runs multiple container instances, recycles them, and routes requests across them — this design guarantees divergence, silent overwrites, and data loss. Every "fix" so far (repair endpoints, redeploys, disabling migrations) has patched a symptom while leaving the defect intact.

**The single most damaging line in the codebase** is `server.ts:1083`, inside `hydrateState()`: every time the server loads state from Firestore (every boot, every deploy, every Cloud Run instance recycle), **every user's password is replaced with a random hash**. Don's repeated lockouts were not a mystery and not a bcrypt migration bug — they were this line executing on schedule.

**Recommendation in one paragraph:** Keep the single-instance lock (`maxScale=1`) as tonight's tourniquet. This week, migrate Firestore from one monolithic `app-state/main` document to per-collection documents with write-through semantics (no in-memory primary). This month, evaluate whether the relational shape of the domain (users → venues → tasks → check-ins) justifies Cloud SQL Postgres (~$9–11/mo all-in for db-f1-micro); if the Firestore migration holds up under real use, stay on Firestore and skip Postgres. Do not build on the current dual-write design for one more feature.

Cost of the recommended path: **$0 additional per month** (stays inside Firestore + Cloud Run free tiers at Don's scale). Cost of Postgres path: **~$9–11/mo**.

---

## 1. Current Architecture Autopsy

### 1.1 What the system actually is

The server is a single Node.js/Express process (`server.ts`) that holds the entire application state in module-level JavaScript arrays:

```ts
// server.ts:930 (representative)
let users: UserProfile[] = [...DEFAULT_USERS];
let venues: Venue[] = [...];
let tasks: TaskItem[] = [...];
// ... 19 top-level collections total (see stateSnapshot, server.ts:1148)
```

All request handlers read and mutate these arrays directly. After any mutation, the handler calls `saveState()` (51 call sites), which does two things:

```ts
// server.ts:1172
function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(stateSnapshot(), null, 2), 'utf-8');
  } catch (err) { /* ... */ }
  persistToFirestore();  // fire-and-forget, never blocks, never throws
}
```

`persistToFirestore()` (server.ts:1265) serializes the **entire state** — all 19 collections — into a single Firestore document `app-state/main` via `.set()` (full overwrite, not merge). It is explicitly fire-and-forget: `.catch()` only logs.

On boot, `startServer()` (server.ts:4426) awaits `loadStateFromFirestore()`, which does a single `.get()` on `app-state/main` and calls `hydrateState()` to repopulate the in-memory arrays. A `durableStateLoaded` flag (server.ts:1199) blocks `persistToFirestore()` until the load completes — this was the fix for the October 15 boot race.

WebSocket clients receive real-time updates via `broadcast()` (server.ts:1516), which serializes from the **local in-memory arrays** of whichever instance the socket happens to be connected to.

### 1.2 The failure modes, enumerated

**F1. The hydrate password reset (the smoking gun).**
`hydrateState()`, server.ts:1064–1092, maps over persisted users and returns:

```ts
return {
  ...u,
  role,
  permissions,
  agencyId: u.agencyId || 'agency-hkc',
  venueId: assignedVenue,
  // Role change resets to a random temp password (hashed) — admin sets a real one.
  password: bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10),
};
```

The comment describes intent ("role change resets"), but the code is unconditional: **every user, every hydrate, every boot**. `hydrateState` runs on every `loadStateFromFirestore()` (every container start) and every `loadState()` (local file). Don sets a password → it persists to Firestore correctly → the next deploy/instance-recycle boots → `hydrateState` replaces it with a random hash → "Incorrect password." This happened at least four times Oct 15–17. The disabled `migratePasswordsToBcrypt` was a red herring; this line was the killer. Note it also means **no password set through any flow survives a restart** — including the forgot-password flow built Oct 16.

**F2. Multi-instance divergence (the team-list flipping).**
Cloud Run scales the service to N instances based on traffic (default max 1,000; default concurrency 80 requests/instance). Each instance boots, loads `app-state/main` once, then diverges: Instance A serves requests that add users (6 in memory); Instance B, started earlier or from a stale read, still has 1. Don's phone hits A → sees 6 briefly (or via WebSocket) → next request routes to B → sees 1. The "6 for a sec, then 1 after refresh" symptom is two instances disagreeing, observed directly Oct 17. No mechanism exists to reconcile them — there is no shared lock, no version vector, no read-your-write guarantee across instances.

**F3. Last-writer-wins data loss (the October 15 incident).**
`persistToFirestore()` does a full-document `.set()` of all 19 collections. If Instance A (with Don's 32 tasks) and Instance B (which booted during the 8-second Firestore timeout with empty seed state — the pre-fix behavior) both call `saveState()`, the slower writer's empty state overwrites the good state. This is exactly what wiped Don's Crown Market tasks Oct 15. The `durableStateLoaded` guard fixed the *boot* variant, but the *multi-instance* variant is unguarded: any two instances with divergent memory will silently clobber each other on every `saveState()`.

**F4. Fire-and-forget write loss.**
`persistToFirestore()` catches and logs all errors. If the Firestore write fails (network blip, permission error, document over 1 MiB), the in-memory mutation is already visible to the requesting client and broadcast over WebSocket — but the durable copy never updates. The next instance boot loads the *old* Firestore state, and the mutation vanishes. The client was told "success." There is no retry, no dead-letter, no reconciliation. At Don's scale this is rare, but it is silent when it happens.

**F5. Stale-instance WebSocket broadcast.**
`broadcast()` (server.ts:1516) reads from the local instance's arrays. A client connected to Instance B receives `USERS_UPDATED` with B's stale 1-user list and overwrites its correct 6-user UI. The client has no way to know the broadcast came from a divergent instance — there is no version number, no timestamp comparison, no "this state is authoritative" marker.

**F6. Monolithic document write contention.**
Every `saveState()` rewrites the *entire* `app-state/main` document — all users, all venues, all tasks, all history — even when only one task's status changed. Firestore's documented guidance is ~1 sustained write/second per document (soft limit; exceeding it causes contention latency and `ABORTED` errors). At Don's current scale (51 `saveState()` call sites, a mashgiach tapping "complete" on 32 tasks in sequence), bursts of >1 write/sec to the same document are routine. Today this manifests as occasional slow saves; as task volume grows, it becomes write contention errors. Worse: the document has a hard **1 MiB (1,048,576 bytes)** ceiling. The local `data/store.json` was already 30 KB in early October with seed data; with photo/voice-note base64 (capped ~500 KB each per the Oct 15 media work), history logs, and multi-venue tasks, the monolith approaches the ceiling faster than intuition suggests. When it crosses 1 MiB, **every write fails with `FAILED_PRECONDITION`** and the app silently stops persisting (recall F4: errors are swallowed).

**F7. The `undefined`-strip JSON round-trip.**
`persistToFirestore` does `JSON.parse(JSON.stringify(...))` to strip `undefined` (server.ts:1277). This is correct defensively, but it means the persisted form is *not* identical to the in-memory form for any object relying on `undefined` vs. missing-key semantics. Minor, but it adds another silent divergence vector between "what the server thinks" and "what Firestore has."

### 1.3 Why each band-aid failed

| Band-aid | What it did | Why it didn't fix the root cause |
|---|---|---|
| Repair endpoints (`/api/auth/repair-don`, reset) | Rewrote Don's password hash directly | The next `hydrateState` (next boot) re-randomized it (F1). Repaired the symptom; the line that destroys passwords was untouched. |
| Redeploys to "resync" | Restarted instances so they reloaded Firestore | With multiple instances, a fresh boot just creates *new* divergent instances. And F1 re-randomized passwords on every one of those boots. |
| Disabling `migratePasswordsToBcrypt` | Removed the double-hash suspect | The migration was never the culprit (it correctly skipped `$2b$` hashes). F1 was. |
| `durableStateLoaded` guard | Blocked writes before the boot load completes | Fixed the *boot* race (F3-boot-variant) but does nothing for *multi-instance* divergence (F3-instance-variant), F1, F4, or F5. |
| `maxScale=1` (proposed, not yet deployed — needs `workflow`-scoped token) | Locks Cloud Run to one instance | Eliminates F2/F3-instance-variant/F5 by removing the second writer. Does **not** fix F1 (single instance still re-randomizes passwords on every restart), F4 (fire-and-forget still loses writes), or F6 (monolith still hits 1 MiB and write-contention limits). It is a tourniquet, not a cure. |

---

## 2. Option A: Single Instance (maxScale=1)

### How it works
Set `autoscaling.knative.dev/maxScale: '1'` on the Cloud Run service (one-line change in `.github/workflows/deploy.yml`, already staged locally — needs a `workflow`-scoped GitHub token to push). Cloud Run then runs exactly one container instance (plus brief overlap during deploy rollouts). All requests hit the same process; the in-memory arrays become genuinely single-writer.

### What it fixes
- **F2 (divergence):** eliminated — there is no second instance to disagree with.
- **F3-instance-variant:** eliminated — one writer, no clobbering.
- **F5 (stale broadcast):** eliminated — the only broadcaster has the only state.

### What it does NOT fix
- **F1 (hydrate password reset):** a single instance still runs `hydrateState` on every restart and still randomizes every password. Don's lockouts continue on every deploy until line 1083 is fixed. (This line must be fixed regardless of which option is chosen — it is a plain bug, not an architecture choice.)
- **F4 (fire-and-forget loss):** a failed Firestore write is still silent and still permanent.
- **F6 (monolith limits):** the 1 MiB document ceiling and ~1 write/sec/doc contention apply to one writer as much as to many. A mashgiach rapid-tapping 32 task completions still bursts writes to the single doc.
- **Deploy-time overlap:** Cloud Run deploys start the new revision *before* draining the old one. For ~30–60 seconds, two revisions (old code + new code) both serve traffic and both write to `app-state/main`. maxScale=1 applies per-revision, not per-service — during rollout there are transiently two writers. The window is small but nonzero, and it coincides exactly with the riskiest writes (schema migrations in `hydrateState`).

### Availability implications
- **Single point of failure.** If the instance crashes (OOM, unhandled exception), Cloud Run starts a replacement — cold start is 5–30 seconds for this Node image (buildpacks image, `bcrypt` native load, Firestore SDK init). During that window the app is down. Cloud Run's 99.95% monthly SLO still applies to the *service*, but the practical MTTR for a crash is the cold-start time, and in-flight WebSocket connections drop (clients reconnect, but presence state resets).
- **Deploy downtime:** effectively zero for HTTP (traffic shifts after the new instance passes health), but WebSocket connections are severed on every deploy — the kiosk tablets and mashgiach phones reconnect, with a brief "reconnecting" state. Don has already seen white screens on deploy; single-instance doesn't change that.
- **Instance recycling:** Cloud Run recycles instances periodically (no documented fixed interval; in practice hours to days). Each recycle is a cold start + Firestore reload + F1 password randomization (until fixed). With min-instances=0 (current), idle periods also scale to zero — the *next* request after idle pays the full cold start.
- **Throughput ceiling:** one instance with default concurrency 80 handles Don's load (dozens of users, bursty) with enormous headroom. Throughput is not the constraint; resilience is.

### Cost
$0 change. Cloud Run free tier (2M requests, 180K vCPU-seconds, 360K GiB-seconds/month per billing account) already covers this app several times over. maxScale=1 can only *reduce* cost.

### Verdict
**Acceptable as a tonight-tourniquet; negligent as a destination.** It converts "data corrupts randomly" into "data corrupts only on deploy/restart" — which, combined with fixing F1, makes the app *usable*. But it leaves a single point of failure, silent write loss, and the monolithic-document time bomb. For a nonprofit tool where Don is the only person who can fix things at 10 PM, "usable but fragile" is a reasonable 48-hour posture and an unacceptable 6-month posture. Do not present maxScale=1 to Don as "the fix." Present it as "the bleeding stopped; now we operate."

---

## 3. Option B: Stateless + Firestore as Source of Truth

### The design
Remove in-memory arrays as the primary store. Every request handler reads the documents it needs from Firestore and writes through to Firestore. The process keeps at most a short-TTL read cache (or none at all). Concretely:

1. **Shatter the monolith.** Replace `app-state/main` with per-collection documents:
   - `agencies/{agencyId}` — one doc per agency (tiny, rarely written)
   - `venues/{venueId}` — one doc per venue
   - `users/{userId}` — one doc per user (password hash lives here; F1's blast radius becomes one user, and the fix is to stop overwriting it)
   - `tasks/{taskId}` — one doc per task (the high-write collection)
   - `checkins/{checkinId}`, `handoffNotes/{noteId}`, `incidents/{incidentId}`, `announcements/{announcementId}` — one doc each
   - `meta/{agencyId}` — counters, `currentWorkDate`, feature flags
2. **Write-through with transactions** for multi-document mutations (e.g., completing a task + appending a history log = one transaction).
3. **Reads** are single-document gets (strongly consistent in Firestore) or collection queries with filters.
4. **WebSocket broadcast** becomes: after a successful Firestore write, broadcast the *written payload* (not re-read state). For cross-instance fan-out with N instances, either keep maxScale=1 (simplest — broadcasts stay in-process) or add a Firestore listener on a lightweight `events/{agencyId}/changelog` collection that each instance tails and rebroadcasts to its own sockets.

### The monolith analysis (why shattering is non-optional)
- **Size:** 1 MiB hard limit per document (firebase.google.com/docs/firestore/quotas). Current `store.json` was 30 KB with seed data; production state with 6 users, 1 venue, 0 tasks is small *today*. But the Oct 15 build stores photo base64 (~500 KB cap each) and voice notes in check-ins/handoff-notes/incidents *inside the same document*. Two photos in one day's check-ins = the document is at the ceiling and **all writes fail**. This is not theoretical — it is one busy kashering day away.
- **Write contention:** ~1 sustained write/second per document (soft). 51 `saveState()` call sites, each rewriting the whole doc. A mashgiach completing 10 tasks in a minute = 10 full-doc writes in 60 seconds — fine. Two mashgichim on two kiosks + Don on his phone = bursts that exceed it. Contention errors (`ABORTED`) are currently swallowed by the fire-and-forget catch (F4) — the user sees success, the write is lost.
- **Cost of the monolith:** every `saveState()` is 1 document write regardless of what changed. 51 call sites × bursty usage. Still pennies at Don's scale, but it teaches the wrong habits for multi-agency.

### Consistency guarantees Firestore actually provides
- **Single-document reads are strongly consistent.** `doc.get()` always returns the latest committed write. This kills F2/F3/F5 at the read path: every instance sees the same truth.
- **Transactions** provide serializable isolation across up to 500 documents: all-or-nothing, with automatic retry on contention. This is the correct tool for "complete task + write history log + update venue counters" — the exact multi-write the current code does as three separate in-memory mutations + one monolithic `saveState()`.
- **What Firestore does NOT provide:** cross-document secondary indexes with transactional consistency (queries are eventually consistent *within* the transaction's read set only); no JOINs; no uniqueness constraints except document IDs (so "email must be unique" needs the email as the document ID or a separate `usersByEmail/{email}` lookup doc maintained transactionally).
- **Eventual consistency caveat:** collection *queries* (as opposed to direct document gets) can lag single-digit milliseconds behind writes in multi-region setups. For "list today's tasks," this is irrelevant. For "did my write land," use the transaction's returned snapshot, not a follow-up query.

### WebSocket in a stateless world
Two sub-options:
- **(B1) Keep maxScale=1 + in-process broadcast.** The instance is stateless *for data* (reads/writes go to Firestore) but still holds the socket table. Broadcasts are emitted after confirmed Firestore writes. This is the pragmatic 90% — it keeps the current `broadcast()` code nearly unchanged and eliminates every divergence mode, because the sockets are the only in-memory state left and socket state is inherently per-instance and ephemeral. **Recommended.**
- **(B2) Multi-instance + Firestore changelog tail.** Each instance runs `onSnapshot` on `changelog/{agencyId}` (one tiny doc per agency, updated transactionally with every mutation) and rebroadcasts to its own sockets. Correct, but adds a moving part and Firestore listener costs. Only needed if Don outgrows one instance — i.e., hundreds of concurrent sockets, which is not on any roadmap.

### Performance and cost at Don's scale
- **Latency:** Firestore single-doc read from us-east1 Cloud Run to the Firestore instance (same region) is typically 10–40 ms. Current in-memory read is <1 ms. A request that reads 1 user doc + 1 venue doc + ~30 task docs = ~35 document reads ≈ 50–150 ms total, well within the 5-minute Cloud Run request timeout and imperceptible in the UI (the client already waits on network RTT).
- **Pricing (Blaze, us-east1):** $0.06/100K reads, $0.18/100K writes, $0.02/100K deletes; free tier 50K reads + 20K writes + 20K deletes *per day*. Don's realistic day: 6 users × ~200 requests × ~10 docs/request ≈ 12K reads; writes maybe 500/day. **Entirely inside the free tier.** Even at 10× growth (multi-agency, 60 users), monthly Firestore cost is single-digit dollars. The monolith's "1 write per saveState" actually costs *more* writes than per-doc design for small mutations (rewriting 1 MiB to change one boolean).
- **Egress:** Firestore→Cloud Run in the same region is free.

### Migration path (monolith → per-collection)
1. **Dual-write shim (1–2 days):** keep `stateSnapshot()`/`hydrateState()` but change `persistToFirestore()` to also fan out per-collection docs; change `loadStateFromFirestore()` to prefer per-collection docs when present, fall back to monolith. No handler changes yet.
2. **Handler migration (3–5 days):** convert endpoints one collection at a time (users first — kills F1's blast radius; then tasks — kills F6). Each converted handler reads/writes its collection docs directly; the monolith write becomes the fallback.
3. **Cutover (1 day):** flip reads to per-collection, delete the monolith writer, keep the monolith doc as a cold backup for 30 days.
4. **Fix F1 in the same pass:** the user-doc writer must never overwrite `password` except on explicit password-change flows. This is a three-line change once users are per-doc.

### Verdict
**This is the recommended destination.** It fixes F1–F6 structurally, costs $0 at Don's scale, keeps the current hosting (Cloud Run + Firestore) and the current team (no DBA skills needed), and the migration is incremental — the app keeps working after each phase. The main cost is engineering time: ~1–2 weeks of careful, boring work. The main risk is phase-2 handler migration introducing regressions — mitigated by the dual-write shim (the monolith remains a consistent fallback until cutover).

---

## 4. Option C: Cloud SQL Postgres

### Why relational fits
The domain is relational: agencies have venues; venues have tasks; tasks have check-ins; users belong to agencies and are assigned to venues; announcements target roles. The current code *simulates* relations with array `.find()` calls (e.g., `tasks.filter(t => t.venueId === vid)`). Postgres gives: foreign keys (can't orphan a task), unique constraints (email uniqueness — the "already exists" bug class disappears), JOINs (one query for "venue with its tasks and assigned mashgichim" instead of N document reads), and ACID transactions across arbitrary tables.

### Transaction guarantees
Postgres on Cloud SQL gives full ACID: the "complete task + history log + venue counter" multi-write becomes one `BEGIN/COMMIT` — atomic, consistent, isolated, durable. The dual-write problem (F3/F4) is *structurally impossible*: there is one store, and the commit either happens or it doesn't. No `durableStateLoaded` flags, no fire-and-forget, no hydrate. This is the strongest consistency story of any option.

### Migration effort
**High.** Everything about the current persistence layer changes:
- Schema design: ~10 tables (agencies, venues, users, tasks, check_ins, handoff_notes, incidents, announcements, task_templates, push_subscriptions) with migrations.
- All 51 `saveState()` call sites become explicit SQL writes; all array `.find()`/`.filter()` reads become queries. This is effectively a rewrite of the data layer — 2–4 weeks for someone who knows the codebase, longer if schema design iterates.
- Connection pooling on Cloud Run: each instance needs a pool; use the Cloud SQL Node.js connector with `pg`, `max: 5` connections per instance, and consider `maxScale=1` anyway (or PgBouncer via AlloyDB Omni — overkill here). With maxScale=1 and 5 pooled connections, a db-f1-micro handles it.
- Secrets: DB password via Secret Manager (currently unused); IAM database auth is cleaner.
- Backups: Cloud SQL automated backups + point-in-time recovery replace the "Download Backup" JSON button (keep the button anyway — Don likes it).

### Cost (verified October 2026 pricing)
- **db-f1-micro** (shared vCPU, 0.6 GB RAM): **$0.0105/hr ≈ $7.70/mo** (us-central1; us-east1 similar) + 10 GiB SSD **$1.70/mo** + backups ≈ **$9.50–11/mo all-in** (dev.to/elimio worked example: $9.37/mo with 10 GiB).
- db-g1-small (1.7 GB): ~$26/mo — unnecessary at this scale.
- The $300 free-trial credit covers ~2.5 years of db-f1-micro if unused, but Don's project already burned trial credit on the Blaze plan (per memory: "Default Gemini Project" on Blaze since 2026-09-30).
- Cloud Run stays free-tier. Total new spend: **~$10/mo**.

### Verdict
**The best consistency story, the highest migration cost, and unnecessary at Don's scale.** Postgres is the right answer for "we have 50 agencies, 500 mashgichim, and need reporting JOINs." It is the wrong answer for "fix data corruption this week on a $0 budget." The Firestore per-collection design (Option B) delivers 95% of the consistency benefit at 20% of the migration effort. **Revisit Postgres when:** (a) Don needs cross-venue reporting queries Firestore can't express, (b) the team grows past what document-ID uniqueness can enforce, or (c) a second developer joins who knows SQL. Until then, it's a $10/mo solution to a $0 problem.

---

## 5. Option D: Hybrid / Other

### D1. In-memory + Redis (Memorystore) as shared state
Replace per-instance arrays with a single Redis. All instances read/write one shared in-memory store; Firestore remains the durable backup. **Dismissed.** It reintroduces a second store (now *two* dual-write problems: app→Redis and Redis→Firestore), adds Memorystore cost (minimum ~$35/mo for 1 GB Basic tier — more than Postgres), and Redis persistence (RDB/AOF) is operationally subtler than Firestore's. It solves F2 while keeping F1/F3/F4/F6.

### D2. Firestore in Datastore mode
Datastore mode offers the same storage with different semantics (no realtime listeners, stronger transactional guarantees on entity groups). **Dismissed.** The app uses the Firebase Admin SDK and may want listeners later (Option B2); Native mode is the right choice. Nothing in Datastore mode fixes the monolith or the dual-write.

### D3. SQLite on a persistent disk (Cloud Run + Filestore/GCS Fuse)
Single-file DB, zero new services. **Dismissed.** Cloud Run's filesystem is ephemeral per instance; attaching persistent storage (Filestore minimum ~$200/mo for 1 TB, or GCS Fuse with consistency caveats) is more expensive and more fragile than Firestore. SQLite's single-writer model also reintroduces the scaling ceiling without the managed benefits.

### D4. Keep dual-write but add versioning (vector clocks / CAS)
Add a `version` field to `app-state/main`; `persistToFirestore` uses a transaction that aborts if the version changed since read. **Partially endorsed as a phase-1 hardening** inside Option B's dual-write shim: it converts silent clobbering (F3) into loud contention errors. But it doesn't fix F1, F2-reads, or F6, and versioned monoliths still hit the 1 MiB wall. Useful as a 1-day safety net, not a destination.

### D5. Firebase Realtime Database instead of Firestore
Simpler pricing (bandwidth-based), realtime sync built in. **Dismissed.** Weaker query story, no transaction support comparable to Firestore's, and the migration is lateral — same dual-write problem, different store.

---

## 6. Consistency Deep Dive

### 6.1 What consistency does Don actually need? (per data type)

| Data | Required level | Why | Current violation |
|---|---|---|---|
| Password hashes | **Linearizable** (read-your-write, single truth) | A password change must be visible to the next login attempt, globally. "I just set it" → "incorrect password" destroys trust. | F1 re-randomizes on hydrate; F2 serves stale hashes from divergent instances. |
| Task completion state | **Causal** (my check-in is visible to me and my coordinator, promptly) | A mashgiach tapping "done" then seeing "not done" is confusing but recoverable. Cross-device lag of seconds is fine. | F3/F4 can *lose* the completion silently — worse than lag. |
| User roster | **Causal** | "6 then 1 then 6" is the observed failure; monotonic reads (never go backward) would fix the UX even without instant global consistency. | F2/F5 violate monotonicity directly. |
| Announcements / handoff notes | **Eventual** (seconds) | Broadcast informational; brief staleness harmless. | Currently fine when instances agree; broken when they don't (F5). |
| Venue/task definitions | **Causal** | Created rarely, read often. | F3 can wipe them (Oct 15). |
| Push subscriptions | **Eventual** | Best-effort by nature. | — |

The key insight: **nothing here needs Spanner-grade external consistency.** What Don needs is (a) no silent data loss, (b) monotonic reads per client, and (c) password writes that stick. Firestore's single-document strong consistency + transactions deliver all three. Postgres delivers them with more ceremony. The current design delivers none of them.

### 6.2 CAP applied
The system is a partitioned distributed system the moment Cloud Run runs 2 instances (P is not optional — instance recycles, deploy rollouts, and network blips *are* partitions). The current design chooses **Availability** (every instance serves from memory, never blocks on the network) and sacrifices **Consistency** utterly — without even gaining real availability, because divergent instances serve *wrong* answers fast. The correct trade for Don's scale: choose **Consistency** (Firestore as the synchronous truth; a request that can't reach Firestore fails loudly rather than serving stale state), because the workload is low-throughput and human-paced — a 500 ms error is infinitely better than a silent wrong answer. This is also why the fire-and-forget `.catch(log)` in `persistToFirestore` is the most dangerous three lines in the file: it converts a consistency failure into a lie.

### 6.3 The dual-write problem, named
What `saveState()` does — mutate memory, then asynchronously write Firestore — is the textbook **dual-write anti-pattern** (Kleppmann, *Designing Data-Intensive Applications*, Ch. 11): two systems must agree, with no transaction spanning them, so every crash between the two writes leaves them divergent, and every concurrent writer widens the gap. The industry's standard fixes, in order of preference: (1) **single writer** (Option A — removes the second system), (2) **transactional outbox** (write the intent to the durable store first, then apply — overkill here), (3) **change-data-capture** (Firestore listeners replicating to memory — Option B2's changelog). The current code does none of the three.

### 6.4 Idempotency, retries, write-ahead
- **Idempotency:** task/check-in writes use client-generated IDs (`task-${venueId}-${n}`, `crypto.randomUUID()` for resets) — good. Retry-safe already, *provided* retries hit the same truth (they don't, under F2).
- **Retry safety:** `persistToFirestore` has no retry. Firestore's Node SDK retries idempotent reads automatically but not the application's fire-and-forget `.set()`. Under Option B, use transactions (auto-retry on `ABORTED`) and explicit exponential backoff on `UNAVAILABLE`.
- **Write-ahead:** the minimal correct pattern for the current code, if a full migration stalls: write to Firestore *first* (awaited), then mutate memory. Inverts the failure mode — a crash loses the in-memory update (rebuilt from Firestore on next read) instead of losing the durable one. One-line conceptual change per `saveState()` call site; still not as good as removing the dual write, but it stops silent loss.

---

## 7. Recommendation

### Ranked options

1. **Option B (stateless + Firestore per-collection) — the destination.** Fixes F1–F6 structurally. $0/mo. Incremental migration. Keeps current hosting and skill set. 1–2 weeks of work.
2. **Option A (maxScale=1) — tonight's tourniquet.** Deploy immediately (needs the `workflow`-scoped token). Eliminates multi-instance divergence. Must be paired with the F1 one-line fix (stop re-randomizing passwords in `hydrateState`). Acceptable for days, not months.
3. **Option C (Postgres) — the future candidate.** Best consistency story, wrong cost/benefit today. Revisit at multi-agency scale or when reporting needs exceed Firestore queries.
4. **Option D variants — dismissed** (D4's versioned-write guard excepted as a 1-day hardening inside B's phase 1).

### Phased plan

**Phase 0 — Tonight (1 hour, $0). Stop the bleeding.**
- [ ] Push the `maxScale=1` workflow change (needs Don's `workflow`-scoped token).
- [ ] Fix `server.ts:1083`: remove the unconditional password reset from `hydrateState`. Passwords must only change in `/api/auth/change-password`, `/api/auth/setup`, and `/api/auth/reset-password`. (This is a bug fix, not architecture — it should have been caught in code review.)
- [ ] Verify: set a test password, redeploy, confirm it survives. Check `/api/users` returns 6 consistently across 10 requests.
- *Risk:* deploy-rollout transient dual-writer window (~60 s). Mitigate by deploying at low-traffic hour.
- *Done looks like:* Don logs in with his password, it works after a deploy; team list shows 6 and never flips.

**Phase 1 — This week (2–3 days, $0). Harden the monolith.**
- [ ] Add a `version`/`updatedAt` field to `app-state/main`; make `persistToFirestore` use a Firestore transaction that aborts on version mismatch (D4). Converts silent clobbers into loud, retried errors.
- [ ] Make `persistToFirestore` failures *visible*: increment an in-memory error counter, expose via `/api/admin/health`, log with severity ERROR (not `console.warn`). Don should be able to ask "did any writes fail today" and get an answer.
- [ ] Audit the 51 `saveState()` call sites: any that don't need durability (e.g., presence/heartbeat) should not trigger a full-doc write.
- *Risk:* transaction contention under burst writes — acceptable; errors are now loud and retried, not silent.
- *Done looks like:* `/api/admin/health` shows zero failed writes over 7 days; no "Incorrect password" after deploys.

**Phase 2 — Next 2 weeks ($0). Shatter the monolith.**
- [ ] Dual-write shim: `persistToFirestore` fans out to `users/{id}`, `venues/{id}`, `tasks/{id}`, etc.; `loadStateFromFirestore` prefers per-collection docs.
- [ ] Migrate handlers collection by collection (users → tasks → venues → the rest).
- [ ] Cut over reads; retire the monolith writer (keep the doc 30 days as cold backup).
- [ ] Move photo/voice base64 out of task docs into Cloud Storage (or keep the 30-day media-retention stripper, but enforce a hard per-doc size check *before* write — fail loudly at 900 KB, not silently at 1 MiB).
- *Risk:* handler-migration regressions. Mitigate with the shim (monolith remains consistent fallback) and Don's screenshot-verdict testing on staging.
- *Done looks like:* `app-state/main` no longer written; Firestore console shows per-collection docs; a 500 KB photo check-in doesn't threaten the task doc.

**Phase 3 — This month ($0). Operationalize.**
- [ ] Revisit maxScale: with stateless handlers, the instance count can safely rise again (set maxScale back to 3–5 for resilience, keep B1 in-process broadcast or implement B2 changelog tail if needed).
- [ ] Set up the Firestore deny-all rules deployment (Don's open item) — now safe because all access is via Admin SDK.
- [ ] Write the runbook: "how to verify consistency" (the checks in *Done looks like* above, as a script Don or his assistant runs weekly).
- *Done looks like:* the app survives deploys, restarts, and burst usage with zero silent data loss for 30 days.

**Phase 4 — Someday ($10/mo). Postgres evaluation.**
- Trigger: multi-agency onboarding, or reporting queries Firestore can't express, or a second developer who knows SQL.
- Not before: the Firestore design has had 3 months of production use to reveal its real (not imagined) limits.

### Cost summary

| Phase | New monthly cost | One-time effort |
|---|---|---|
| 0 (tourniquet) | $0 | 1 hour |
| 1 (harden) | $0 | 2–3 days |
| 2 (shatter monolith) | $0 (stays in Firestore free tier at 10× current scale) | 1–2 weeks |
| 3 (operationalize) | $0 | 2–3 days |
| 4 (Postgres, if ever) | ~$10/mo (db-f1-micro + storage) | 2–4 weeks |

### What "done" looks like (acceptance criteria for Don)
1. Set a password → redeploy twice → password still works. (Kills F1.)
2. Ten rapid `/api/users` calls return identical results; team screen never flips 6→1. (Kills F2/F5.)
3. Complete 32 tasks in rapid succession → all 32 persist; reload shows all 32. (Kills F3/F6-contention.)
4. Disconnect Firestore (staging) → writes fail loudly with an error Don can see, never silently. (Kills F4.)
5. Upload two 500 KB photos in check-ins → tasks still save. (Kills F6-size.)
6. Thirty days with zero entries in the failed-write log. (The system proves itself.)

---

## Appendix: Key code references

| Location | What | Relevance |
|---|---|---|
| `server.ts:1083` | `password: bcrypt.hashSync(crypto.randomBytes(12)…)` in `hydrateState` | **F1 — re-randomizes all passwords on every boot** |
| `server.ts:1148` | `stateSnapshot()` — 19 collections, one object | F6 — the monolith |
| `server.ts:1172` | `saveState()` — sync file write + fire-and-forget Firestore | F4 — the dual write |
| `server.ts:1199` | `durableStateLoaded` flag | Boot-race guard; doesn't cover multi-instance |
| `server.ts:1245` | `loadStateFromFirestore()` — single `.get()`, full `hydrateState` | Boot path; runs per instance |
| `server.ts:1265` | `persistToFirestore()` — full-doc `.set()`, `.catch(log)` | F3 (clobber), F4 (silent loss), F6 (contention) |
| `server.ts:1516` | `broadcast()` — reads local memory, sends to sockets | F5 — stale broadcast |
| `server.ts:4426` | `startServer()` — awaits Firestore load, then listens | Post-Oct-15-fix boot sequence |
| 51× | `saveState()` call sites | Every mutation rewrites the monolith |

## Appendix: Verified platform facts (October 2026)

| Fact | Value | Source |
|---|---|---|
| Firestore max document size | 1 MiB (1,048,576 bytes), hard limit; writes fail `FAILED_PRECONDITION` | firebase.google.com/docs/firestore/quotas |
| Firestore sustained write rate per document | ~1 write/sec (soft); bursts cause contention/`ABORTED` | Google Cloud docs; systemsarchitect.io |
| Firestore single-doc read consistency | Strongly consistent | Google Cloud docs |
| Firestore transactions | Serializable, ≤500 docs, auto-retry on contention | Google Cloud docs |
| Firestore pricing (Blaze, us-east1) | $0.06/100K reads, $0.18/100K writes, $0.02/100K deletes | firebase.google.com |
| Firestore free tier | 50K reads + 20K writes + 20K deletes/day, 1 GiB storage | Firebase docs |
| Cloud Run default max instances | 100 (service), up to 1,000 with quota | cloud.google.com/run |
| Cloud Run default concurrency | 80 requests/instance | cloud.google.com/run |
| Cloud Run SLO | 99.95% monthly (non-GPU) | Google Cloud docs |
| Cloud Run free tier | 2M requests, 180K vCPU-s, 360K GiB-s/mo per billing account | Google Cloud pricing |
| Cloud Run request-based pricing (Tier 1) | $0.40/M requests, $0.000024/vCPU-s, $0.0000025/GiB-s | Google Cloud pricing |
| Cloud SQL db-f1-micro | $0.0105/hr ≈ $7.70/mo + $1.70/mo per 10 GiB SSD ≈ **$9.50–11/mo all-in** | bytebase.com (Sep 2026); dev.to worked example |
| Cloud Run maxScale annotation | `autoscaling.knative.dev/maxScale` | Knative / Cloud Run docs |
| Deploy overlap | New revision starts before old drains (transient 2 writers even at maxScale=1) | Cloud Run rollout behavior |

---

*End of analysis. No code was modified in producing this document.*
