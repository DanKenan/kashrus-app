import { identityProjection, newProjectionProblems, emailKey } from './identity.ts';
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

  // Item 10d ("Agreed — 10d design v2"): usersByEmail, people and emails are
  // ALL derived from one pure function over whole person groups
  // (identityProjection, src/server/identity.ts), the same function the
  // consistency check and migration verify use. usersByEmail points at the
  // person's credential OWNER row (a legacy row without personId: itself);
  // people/{P} comes from the owner row; emails/{key} -> P. A person group
  // that is invalid, or an email shared by two identities, is a problem:
  // newly introduced (or changed) -> the whole commit aborts; an untouched
  // stored problem -> tolerated, never written.
  const beforeProj = identityProjection(before.users || [], before.agencies || []);
  const afterProj = identityProjection(after.users || [], after.agencies || []);
  const { fresh: freshProblems, tolerated } = newProjectionProblems(beforeProj, before.users || [], afterProj, after.users || []);
  if (freshProblems.length) {
    const p = freshProblems[0];
    if (p.code === 'email-shared') {
      throw new Error(`Duplicate email in transaction: rows ${p.rowIds.join(', ')} (identity conflict)`);
    }
    throw new Error(`Identity conflict: person ${p.personId} has no valid credential owner (${(p.issues || []).join(',')})`);
  }
  const toleratedEmails = new Set<string>();
  const toleratedPersons = new Set<string>();
  for (const p of tolerated) {
    if (p.email) toleratedEmails.add(p.email);
    if (p.personId) toleratedPersons.add(p.personId);
  }

  // usersByEmail: net lookup changes, at most one write per email key.
  interface LookupChange { key: string; userId: string | null; email: string | null }
  const lookupChanges: LookupChange[] = [];
  for (const email of new Set([...beforeProj.lookup.keys(), ...afterProj.lookup.keys()])) {
    if (toleratedEmails.has(email)) continue;
    const beforeUser = beforeProj.lookup.get(email) || null;
    const afterUser = afterProj.lookup.get(email) || null;
    if (beforeUser === afterUser) continue;
    const key = emailKey(email);
    if (afterUser) lookupChanges.push({ key, userId: afterUser, email });
    else lookupChanges.push({ key, userId: null, email: null });
  }

  // ---- Item 8b/10d: identity projections (people/{personId}, emails/{key}) ----
  // verified is always false; a retired or reassigned mapping never resolves
  // to a previous identity (see src/server/identity.ts).
  const nowIso = new Date().toISOString();
  const beforeHadRows = beforeProj.personIdsWithRows;
  const afterHasRows = afterProj.personIdsWithRows;
  const peopleIds: string[] = [];
  const peopleCandidates = new Set<string>([...beforeProj.persons.keys(), ...afterProj.persons.keys()]);
  for (const p of beforeProj.problems) if (p.personId) peopleCandidates.add(p.personId);
  for (const pid of peopleCandidates) {
    if (toleratedPersons.has(pid)) continue;
    const b = beforeProj.persons.get(pid);
    const a = afterProj.persons.get(pid);
    if (!a && afterHasRows.has(pid)) continue; // cannot happen (fresh problems abort); defensive
    if (a && b && a.name === b.name && a.primaryEmail === b.primaryEmail) continue; // projection unchanged
    peopleIds.push(pid);
  }
  const emailKeys: string[] = [];
  const toleratedKeys = new Set<string>([...toleratedEmails].map((e) => emailKey(e)));
  for (const key of new Set([...beforeProj.emailPerson.keys(), ...afterProj.emailPerson.keys()])) {
    if (toleratedKeys.has(key)) continue;
    if (beforeProj.emailPerson.get(key) === afterProj.emailPerson.get(key)) continue;
    emailKeys.push(key);
  }
  const beforeEmailPerson = beforeProj.emailPerson;
  const afterEmailPerson = afterProj.emailPerson;

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
    const a = afterProj.persons.get(pid);
    const existing = peopleSnaps.get(pid);
    const v = (existing?._v || 0) + 1;
    if (a && !beforeHadRows.has(pid) && existing) {
      // 8c final guard: a person who did not exist before this commit (a
      // born-migrated row, or a legacy row the migrator is migrating) may
      // only CREATE people/{id}. An existing doc of any status belongs to
      // another (historical) identity: never overwritten, never revived.
      // Updates of an already-bound person (b exists) are unaffected.
      throw new Error('Identity conflict: person document already exists');
    }
    if (a) {
      identityWrites.push({
        collection: 'people',
        id: pid,
        data: {
          id: pid,
          name: a.name,
          primaryEmail: a.primaryEmail,
          status: 'active',
          createdAt: existing?.createdAt || nowIso,
          _v: v,
        },
      });
    } else if (existing && existing.status !== 'retired' && !afterHasRows.has(pid)) {
      // Last row removed: retire, keep the record (no hard delete of identity data).
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
        if (afterHasRows.has(existing.personId) || !beforeHadRows.has(existing.personId)) {
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
