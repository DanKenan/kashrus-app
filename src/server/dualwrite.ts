/**
 * Stage 3 Part 2, PR C — Dual-write helper.
 *
 * Mirrors changed entities (tasks, venues, users) from the monolith document
 * to their per-entity Firestore collections, inside the SAME transaction as
 * the monolith write. If the monolith write fails, per-entity writes roll back.
 *
 * Called by commitState() in server.ts with the transaction object (tx),
 * the before/after monolith documents, and the firestoreDb instance.
 *
 * Per-entity `_v` is maintained independently (increment from existing, or 1
 * if new). For users, also maintains the `usersByEmail/{sha256}` lookup.
 *
 * The entity data is copied verbatim from the monolith — no field
 * transformations, no dropped fields. Only `_v` is added/updated.
 *
 * IMPORTANT: Firestore transactions require ALL reads to complete before
 * ANY writes. This function does all tx.get() calls first, then all
 * tx.set()/tx.delete() calls. Never interleave them.
 */

/**
 * Dual-write changed entities. Must be called with the active Firestore
 * transaction (tx) and the firestoreDb instance.
 */
export async function dualWriteChangedEntities(
  tx: any,
  firestoreDb: any,
  before: any,
  after: any
): Promise<void> {
  if (!firestoreDb) return;

  // Phase 1: Identify all changed entities (no Firestore I/O, just diffing)
  interface PendingWrite {
    collection: string;
    id: string;
    data: any | null; // null = delete
  }
  const pendingWrites: PendingWrite[] = [];

  function diffArray(collectionName: string, beforeArr: any[], afterArr: any[]): void {
    const beforeMap = new Map<string, any>((beforeArr || []).map((e: any) => [e.id, e]));
    const afterMap = new Map<string, any>((afterArr || []).map((e: any) => [e.id, e]));

    for (const [id, entity] of afterMap) {
      const prev = beforeMap.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(entity)) {
        pendingWrites.push({ collection: collectionName, id, data: entity });
      }
    }
    for (const [id] of beforeMap) {
      if (!afterMap.has(id)) {
        pendingWrites.push({ collection: collectionName, id, data: null });
      }
    }
  }

  diffArray('tasks', before.tasks, after.tasks);
  diffArray('venues', before.venues, after.venues);

  // Users: dual-write the user docs via diffArray, then handle the
  // usersByEmail lookup separately from complete before/after email maps.
  //
  // Why separate: if user A is deleted and user B is created with A's former
  // email in the SAME transaction, per-user tracking would set B's lookup
  // then delete A's old key — wiping B's entry. Computing from the full maps
  // yields exactly one write per email key.
  diffArray('users', before.users, after.users);

  const crypto = await import('crypto');
  const normalizeEmail = (email: string) => email.trim().toLowerCase();
  const emailKey = (email: string) =>
    crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');

  // Build complete email→userId maps
  const beforeEmailMap = new Map<string, string>(); // normalized email -> userId
  for (const u of (before.users || [])) {
    if (u?.email) beforeEmailMap.set(normalizeEmail(u.email), u.id);
  }
  const afterEmailMap = new Map<string, string>();
  for (const u of (after.users || [])) {
    if (!u?.email) continue;
    const norm = normalizeEmail(u.email);
    const existing = afterEmailMap.get(norm);
    if (existing && existing !== u.id) {
      throw new Error(
        `Duplicate email in transaction: ${u.email} used by both ${existing} and ${u.id}`
      );
    }
    afterEmailMap.set(norm, u.id);
  }

  // Compute net lookup changes: at most one write per email key
  interface LookupChange { key: string; userId: string | null; email: string | null }
  const lookupChanges: LookupChange[] = [];
  const allEmails = new Set([...beforeEmailMap.keys(), ...afterEmailMap.keys()]);
  for (const email of allEmails) {
    const beforeUser = beforeEmailMap.get(email) || null;
    const afterUser = afterEmailMap.get(email) || null;
    if (beforeUser === afterUser) continue; // No change
    const key = emailKey(email);
    if (afterUser) {
      // Create or reassign (single set covers both)
      lookupChanges.push({ key, userId: afterUser, email });
    } else {
      // Email no longer used — delete the lookup
      lookupChanges.push({ key, userId: null, email: null });
    }
  }


  // ---- Item 8b: identity projections (people/{personId}, emails/{key}) ----
  // Derived ONLY from rows that carry personId (commitState has already run
  // enforceIdentityFields on `after`). Computed from complete before/after
  // maps so there is exactly one write per people/emails doc. See
  // src/server/identity.ts for the contract (verified is always false; a
  // retired or reassigned mapping never resolves to a previous identity).
  const nowIso = new Date().toISOString();
  const beforePersons = new Map<string, any>(); // personId -> row
  for (const u of (before.users || [])) {
    if (u && typeof u.personId === 'string' && u.personId) beforePersons.set(u.personId, u);
  }
  const afterPersons = new Map<string, any>();
  for (const u of (after.users || [])) {
    if (u && typeof u.personId === 'string' && u.personId) afterPersons.set(u.personId, u);
  }
  // emails: key -> personId, before and after (migrated rows only)
  const beforeEmailPerson = new Map<string, string>();
  for (const [pid, u] of beforePersons) if (u.email) beforeEmailPerson.set(emailKey(u.email), pid);
  const afterEmailPerson = new Map<string, string>();
  for (const [pid, u] of afterPersons) if (u.email) afterEmailPerson.set(emailKey(u.email), pid);

  const peopleIds: string[] = [];
  for (const pid of new Set([...beforePersons.keys(), ...afterPersons.keys()])) {
    const b = beforePersons.get(pid);
    const a = afterPersons.get(pid);
    if (a && b && a.name === b.name && a.email === b.email) continue; // projection unchanged
    peopleIds.push(pid);
  }
  const emailKeys: string[] = [];
  for (const key of new Set([...beforeEmailPerson.keys(), ...afterEmailPerson.keys()])) {
    if (beforeEmailPerson.get(key) === afterEmailPerson.get(key)) continue;
    emailKeys.push(key);
  }

  const readResults = new Map<string, number>(); // "collection/id" -> current _v (0 if not exists)
  // Phase 2: ALL READS — fetch current per-entity docs to get their _v values.
  // Must complete before any writes.
  for (const pw of pendingWrites) {
    if (pw.data !== null) {
      // Only need _v for writes (not deletes)
      const key = `${pw.collection}/${pw.id}`;
      if (!readResults.has(key)) {
        const ref = firestoreDb.collection(pw.collection).doc(pw.id);
        const snap = await tx.get(ref);
        readResults.set(key, snap.exists ? (snap.data()?._v || 0) : 0);
      }
    }
  }


  // 8b reads (still Phase 2: before any write).
  const peopleSnaps = new Map<string, any>();
  for (const pid of peopleIds) {
    const snap = await tx.get(firestoreDb.collection('people').doc(pid));
    peopleSnaps.set(pid, snap.exists ? snap.data() : null);
  }
  const emailSnaps = new Map<string, any>();
  for (const key of emailKeys) {
    const snap = await tx.get(firestoreDb.collection('emails').doc(key));
    emailSnaps.set(key, snap.exists ? snap.data() : null);
  }
  // Decide every identity write before writing anything (a throw here
  // aborts the whole commit, monolith included).
  const identityWrites: Array<{ collection: string; id: string; data: any }> = [];
  for (const pid of peopleIds) {
    const a = afterPersons.get(pid);
    const existing = peopleSnaps.get(pid);
    const v = (existing?._v || 0) + 1;
    if (a) {
      identityWrites.push({
        collection: 'people',
        id: pid,
        data: {
          id: pid,
          name: typeof a.name === 'string' ? a.name : '',
          primaryEmail: typeof a.email === 'string' ? normalizeEmail(a.email) : '',
          status: 'active',
          createdAt: existing?.createdAt || nowIso,
          _v: v,
        },
      });
    } else if (existing && existing.status !== 'retired') {
      // Row removed: retire, keep the record (no hard delete of identity data).
      identityWrites.push({
        collection: 'people',
        id: pid,
        data: { ...existing, status: 'retired', retiredAt: nowIso, _v: v },
      });
    }
  }
  for (const key of emailKeys) {
    const newPid = afterEmailPerson.get(key) || null;
    const oldPid = beforeEmailPerson.get(key) || null;
    const existing = emailSnaps.get(key);
    if (newPid) {
      if (existing && existing.personId === newPid) {
        if (existing.status === 'active') continue;
      }
      if (existing && existing.status === 'active' && existing.personId !== newPid) {
        // Active for another person: only allowed when that person's row is
        // removed in this same commit (retired and reassigned in one step).
        // (The owner had a row before this commit and has none after it.)
        if (afterPersons.has(existing.personId) || !beforePersons.has(existing.personId)) {
          throw new Error('Identity conflict: email mapping is active for another person');
        }
      }
      const base: any = {
        personId: newPid,
        status: 'active',
        verified: false,
        source: 'admin-entered',
        addedAt: nowIso,
      };
      if (existing && existing.personId && existing.personId !== newPid) {
        const prev: string[] = Array.isArray(existing.previousPersonIds) ? existing.previousPersonIds : [];
        base.previousPersonIds = [...prev, existing.personId];
        base.reassignedAt = nowIso;
      } else if (existing && Array.isArray(existing.previousPersonIds)) {
        base.previousPersonIds = existing.previousPersonIds;
        if (existing.reassignedAt) base.reassignedAt = existing.reassignedAt;
      }
      identityWrites.push({ collection: 'emails', id: key, data: base });
    } else if (existing && existing.status === 'active' && existing.personId === oldPid) {
      // Email no longer used by its person (row removed or email changed): retire.
      identityWrites.push({ collection: 'emails', id: key, data: { ...existing, status: 'retired', retiredAt: nowIso } });
    }
  }

  // Phase 3: ALL WRITES — now safe to write, no more reads.
  for (const pw of pendingWrites) {
    const ref = firestoreDb.collection(pw.collection).doc(pw.id);
    if (pw.data === null) {
      tx.delete(ref);
    } else {
      const key = `${pw.collection}/${pw.id}`;
      const currentV = readResults.get(key) || 0;
      const clean = JSON.parse(JSON.stringify({ ...pw.data, _v: currentV + 1 }));
      tx.set(ref, clean);
    }
  }

  // Apply usersByEmail lookup changes (at most one write per email key)
  for (const lc of lookupChanges) {
    const ref = firestoreDb.collection('usersByEmail').doc(lc.key);
    if (lc.userId) {
      tx.set(ref, { userId: lc.userId, email: lc.email });
    } else {
      tx.delete(ref);
    }
  }

  // 8b identity projection writes.
  for (const iw of identityWrites) {
    tx.set(firestoreDb.collection(iw.collection).doc(iw.id), JSON.parse(JSON.stringify(iw.data)));
  }
}
