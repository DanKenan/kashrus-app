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
    emailLookup?: { oldEmail?: string; newEmail?: string };
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

  // Users: also track email changes for the usersByEmail lookup
  const beforeUsers = new Map<string, any>((before.users || []).map((u: any) => [u.id, u]));
  const afterUsers = new Map<string, any>((after.users || []).map((u: any) => [u.id, u]));
  for (const [id, user] of afterUsers) {
    const prev = beforeUsers.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(user)) {
      const emailChanged = !prev || prev.email?.trim().toLowerCase() !== user.email?.trim().toLowerCase();
      pendingWrites.push({
        collection: 'users',
        id,
        data: user,
        emailLookup: emailChanged
          ? { oldEmail: prev?.email, newEmail: user.email }
          : undefined,
      });
    }
  }
  for (const [id, user] of beforeUsers) {
    if (!afterUsers.has(id)) {
      pendingWrites.push({
        collection: 'users',
        id,
        data: null,
        emailLookup: user.email ? { oldEmail: user.email } : undefined,
      });
    }
  }

  if (pendingWrites.length === 0) return;

  // Phase 2: ALL READS — fetch current per-entity docs to get their _v values.
  // Must complete before any writes.
  const crypto = await import('crypto');
  const emailKey = (email: string) =>
    crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

  const readResults = new Map<string, number>(); // "collection/id" -> current _v (0 if not exists)
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

    // Maintain usersByEmail lookup
    if (pw.emailLookup) {
      const { oldEmail, newEmail } = pw.emailLookup;
      if (newEmail) {
        const key = emailKey(newEmail);
        tx.set(firestoreDb.collection('usersByEmail').doc(key), {
          userId: pw.id,
          email: newEmail.trim().toLowerCase(),
        });
      }
      if (oldEmail && oldEmail.trim().toLowerCase() !== newEmail?.trim().toLowerCase()) {
        const oldKey = emailKey(oldEmail);
        tx.delete(firestoreDb.collection('usersByEmail').doc(oldKey));
      }
    }
  }
}
