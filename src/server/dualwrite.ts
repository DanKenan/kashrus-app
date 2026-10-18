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

  // Helper: diff an entity array and dual-write changes
  async function dualWriteArray(
    collectionName: string,
    beforeArr: any[],
    afterArr: any[]
  ): Promise<void> {
    const beforeMap = new Map<string, any>((beforeArr || []).map((e: any) => [e.id, e]));
    const afterMap = new Map<string, any>((afterArr || []).map((e: any) => [e.id, e]));

    // Added or updated
    for (const [id, entity] of afterMap) {
      const prev = beforeMap.get(id);
      // JSON comparison: only write if actually changed
      if (!prev || JSON.stringify(prev) !== JSON.stringify(entity)) {
        const entityRef = firestoreDb.collection(collectionName).doc(id);
        const existing = await tx.get(entityRef);
        const currentV = existing.exists ? (existing.data()?._v || 0) : 0;
        // Strip undefined via JSON round-trip (Firestore rejects undefined)
        const clean = JSON.parse(JSON.stringify({ ...entity, _v: currentV + 1 }));
        tx.set(entityRef, clean);
      }
    }

    // Deleted
    for (const [id] of beforeMap) {
      if (!afterMap.has(id)) {
        tx.delete(firestoreDb.collection(collectionName).doc(id));
      }
    }
  }

  await dualWriteArray('tasks', before.tasks, after.tasks);
  await dualWriteArray('venues', before.venues, after.venues);

  // Users: dual-write + maintain usersByEmail lookup
  const beforeUsers = new Map<string, any>((before.users || []).map((u: any) => [u.id, u]));
  const afterUsers = new Map<string, any>((after.users || []).map((u: any) => [u.id, u]));

  // Dynamic import for crypto (works in both CJS and ESM contexts)
  const crypto = await import('crypto');
  const emailKey = (email: string) =>
    crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');

  for (const [id, user] of afterUsers) {
    const prev = beforeUsers.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(user)) {
      const userRef = firestoreDb.collection('users').doc(id);
      const existing = await tx.get(userRef);
      const currentV = existing.exists ? (existing.data()?._v || 0) : 0;
      const clean = JSON.parse(JSON.stringify({ ...user, _v: currentV + 1 }));
      tx.set(userRef, clean);

      // Maintain usersByEmail lookup (for transactional uniqueness in PR D)
      const emailChanged = !prev || prev.email?.toLowerCase() !== user.email?.toLowerCase();
      if (emailChanged && user.email) {
        const key = emailKey(user.email);
        tx.set(firestoreDb.collection('usersByEmail').doc(key), {
          userId: id,
          email: user.email.toLowerCase(),
        });
        // If email changed, delete the old lookup
        if (prev?.email && prev.email.toLowerCase() !== user.email.toLowerCase()) {
          const oldKey = emailKey(prev.email);
          tx.delete(firestoreDb.collection('usersByEmail').doc(oldKey));
        }
      }
    }
  }

  for (const [id, user] of beforeUsers) {
    if (!afterUsers.has(id)) {
      tx.delete(firestoreDb.collection('users').doc(id));
      // Clean up the email lookup
      if (user.email) {
        const key = emailKey(user.email);
        tx.delete(firestoreDb.collection('usersByEmail').doc(key));
      }
    }
  }
}
