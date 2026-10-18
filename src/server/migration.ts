/**
 * Stage 3 Part 2, PR D — One-time copy and status endpoints.
 *
 * POST /api/admin/migrate-copy: Copies tasks, venues, users from the monolith
 *   app-state/main document to per-entity collections. Idempotent — skips docs
 *   that already exist (never overwrites dual-written data). Runs in a single
 *   Firestore transaction: all reads before all writes.
 *
 * GET /api/admin/per-entity-status: Compares monolith vs per-entity collections
 *   field-by-field (excluding per-entity _v). Returns match status and mismatch
 *   details. Never returns password hashes, PINs, or secrets.
 */

import crypto from 'crypto';

const FIRESTORE_STATE_DOC = 'app-state/main';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailKey(email: string): string {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

/**
 * Strip per-entity metadata for comparison. Removes _v (per-entity versioning
 * differs from monolith) and ensures no secrets leak into comparison output.
 */
function stripForComparison(entity: any): any {
  const { _v, password, kioskPin, ...rest } = entity;
  // Also strip password/kioskPin from nested? No — they're top-level on User.
  // For comparison we exclude secrets entirely for safety.
  return JSON.parse(JSON.stringify(rest));
}

/**
 * One-time copy: monolith → per-entity collections.
 * Transactional: reads monolith + checks existing docs, then writes only missing.
 * Returns counts of copied vs skipped.
 */
export async function migrateCopy(firestoreDb: any): Promise<{
  venues: { copied: number; skipped: number };
  users: { copied: number; skipped: number };
  tasks: { copied: number; skipped: number };
  usersByEmail: { created: number; skipped: number; conflicts: string[] };
}> {
  const result = {
    venues: { copied: 0, skipped: 0 },
    users: { copied: 0, skipped: 0 },
    tasks: { copied: 0, skipped: 0 },
    usersByEmail: { created: 0, skipped: 0, conflicts: [] as string[] },
  };

  await firestoreDb.runTransaction(async (tx: any) => {
    // Phase 1: ALL READS
    const monolithRef = firestoreDb.doc(FIRESTORE_STATE_DOC);
    const monolithSnap = await tx.get(monolithRef);
    if (!monolithSnap.exists) {
      throw new Error('Monolith document not found — nothing to copy.');
    }
    const monolith = monolithSnap.data();

    // Collect all entities to check
    const entities: Array<{ collection: string; id: string; data: any }> = [];
    for (const v of (monolith.venues || [])) {
      if (v?.id) entities.push({ collection: 'venues', id: v.id, data: v });
    }
    for (const u of (monolith.users || [])) {
      if (u?.id) entities.push({ collection: 'users', id: u.id, data: u });
    }
    for (const t of (monolith.tasks || [])) {
      if (t?.id) entities.push({ collection: 'tasks', id: t.id, data: t });
    }

    // Check which already exist (read phase)
    const missing: Array<{ collection: string; id: string; data: any }> = [];
    const existingIds = new Set<string>();
    for (const e of entities) {
      const ref = firestoreDb.collection(e.collection).doc(e.id);
      const snap = await tx.get(ref);
      if (snap.exists) {
        existingIds.add(`${e.collection}/${e.id}`);
      } else {
        missing.push(e);
      }
    }

    // Check usersByEmail lookups for users we'll copy
    const emailLookupsToCreate: Array<{ key: string; userId: string; email: string }> = [];
    for (const e of missing) {
      if (e.collection === 'users' && e.data.email) {
        const norm = normalizeEmail(e.data.email);
        const key = emailKey(norm);
        const lookupRef = firestoreDb.collection('usersByEmail').doc(key);
        const lookupSnap = await tx.get(lookupRef);
        if (lookupSnap.exists) {
          const existingUserId = lookupSnap.data()?.userId;
          if (existingUserId !== e.id) {
            // Conflict: lookup exists for different user — refuse, don't overwrite
            result.usersByEmail.conflicts.push(
              `Email ${e.data.email} lookup exists for ${existingUserId}, refusing to overwrite with ${e.id}`
            );
            continue;
          }
          // Same user — already correct, skip
          result.usersByEmail.skipped++;
        } else {
          emailLookupsToCreate.push({ key, userId: e.id, email: norm });
        }
      }
    }

    // Phase 2: ALL WRITES — only missing docs, never overwrite
    for (const e of missing) {
      // Skip if this user's email had a lookup conflict
      if (e.collection === 'users' && e.data.email) {
        const norm = normalizeEmail(e.data.email);
        const hasConflict = result.usersByEmail.conflicts.some(c => c.includes(e.id));
        if (hasConflict) continue;
      }
      const ref = firestoreDb.collection(e.collection).doc(e.id);
      const clean = JSON.parse(JSON.stringify({ ...e.data, _v: 1 }));
      tx.set(ref, clean);
      if (e.collection === 'venues') {
        result.venues.copied++;
      } else if (e.collection === 'users') {
        result.users.copied++;
      } else if (e.collection === 'tasks') {
        result.tasks.copied++;
      }
    }

    // Count skipped
    for (const e of entities) {
      if (existingIds.has(`${e.collection}/${e.id}`)) {
        if (e.collection === 'venues') result.venues.skipped++;
        else if (e.collection === 'users') result.users.skipped++;
        else if (e.collection === 'tasks') result.tasks.skipped++;
      }
    }

    for (const l of emailLookupsToCreate) {
      // Double-check no conflict was recorded for this user
      const hasConflict = result.usersByEmail.conflicts.some(c => c.includes(l.userId));
      if (!hasConflict) {
        tx.set(firestoreDb.collection('usersByEmail').doc(l.key), {
          userId: l.userId,
          email: l.email,
        });
        result.usersByEmail.created++;
      }
    }
  });

  return result;
}

/**
 * Status check: compare monolith vs per-entity collections field-by-field.
 * Returns match status and mismatch details (never secrets).
 */
export async function perEntityStatus(firestoreDb: any): Promise<{
  monolith: { venues: number; users: number; tasks: number };
  perEntity: { venues: number; users: number; tasks: number; usersByEmail: number };
  match: boolean;
  mismatches: Array<{ collection: string; id: string; reason: string }>;
}> {
  const mismatches: Array<{ collection: string; id: string; reason: string }> = [];

  // Read monolith
  const monolithSnap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
  const monolith = monolithSnap.exists ? monolithSnap.data() : { venues: [], users: [], tasks: [] };

  // Read per-entity collections
  const [venuesSnap, usersSnap, tasksSnap, lookupsSnap] = await Promise.all([
    firestoreDb.collection('venues').get(),
    firestoreDb.collection('users').get(),
    firestoreDb.collection('tasks').get(),
    firestoreDb.collection('usersByEmail').get(),
  ]);

  const perEntityVenues = new Map<string, any>(venuesSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));
  const perEntityUsers = new Map<string, any>(usersSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));
  const perEntityTasks = new Map<string, any>(tasksSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));

  function compareArrays(
    collection: string,
    monolithArr: any[],
    perEntityMap: Map<string, any>
  ): void {
    const monolithIds = new Set((monolithArr || []).map((e: any) => e?.id).filter(Boolean));

    // Check each monolith entity exists in per-entity and fields match
    for (const entity of (monolithArr || [])) {
      if (!entity?.id) continue;
      const perEntity = perEntityMap.get(entity.id);
      if (!perEntity) {
        mismatches.push({ collection, id: entity.id, reason: 'Missing in per-entity collection' });
        continue;
      }
      // Field-by-field comparison (excluding _v and secrets)
      const monolithClean = stripForComparison(entity);
      const perEntityClean = stripForComparison(perEntity);
      if (JSON.stringify(monolithClean) !== JSON.stringify(perEntityClean)) {
        // Find which fields differ (for useful error, not full dump)
        const mKeys = new Set(Object.keys(monolithClean));
        const pKeys = new Set(Object.keys(perEntityClean));
        const allKeys = new Set([...mKeys, ...pKeys]);
        const diffFields: string[] = [];
        for (const k of allKeys) {
          if (JSON.stringify(monolithClean[k]) !== JSON.stringify(perEntityClean[k])) {
            diffFields.push(k);
          }
        }
        mismatches.push({
          collection,
          id: entity.id,
          reason: `Field mismatch: ${diffFields.slice(0, 5).join(', ')}${diffFields.length > 5 ? '...' : ''}`,
        });
      }
    }

    // Check for per-entity docs not in monolith (orphans — from dual-write after monolith change?)
    for (const [id] of perEntityMap) {
      if (!monolithIds.has(id)) {
        mismatches.push({ collection, id, reason: 'In per-entity but not in monolith (orphan)' });
      }
    }
  }

  compareArrays('venues', monolith.venues, perEntityVenues);
  compareArrays('users', monolith.users, perEntityUsers);
  compareArrays('tasks', monolith.tasks, perEntityTasks);

  // Verify usersByEmail lookups point to correct users (without exposing emails)
  const lookupUserIds = new Set<string>(lookupsSnap.docs.map((d: any) => d.data()?.userId).filter(Boolean));
  const monolithUserIds = new Set<string>((monolith.users || []).map((u: any) => u?.id).filter(Boolean));
  for (const uid of lookupUserIds) {
    if (!monolithUserIds.has(uid) && !perEntityUsers.has(uid)) {
      mismatches.push({ collection: 'usersByEmail', id: uid, reason: 'Lookup points to non-existent user' });
    }
  }

  return {
    monolith: {
      venues: (monolith.venues || []).length,
      users: (monolith.users || []).length,
      tasks: (monolith.tasks || []).length,
    },
    perEntity: {
      venues: perEntityVenues.size,
      users: perEntityUsers.size,
      tasks: perEntityTasks.size,
      usersByEmail: lookupsSnap.size,
    },
    match: mismatches.length === 0,
    mismatches: mismatches.slice(0, 20), // Cap at 20 for readability
  };
}
