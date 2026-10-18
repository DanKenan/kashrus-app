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
}
