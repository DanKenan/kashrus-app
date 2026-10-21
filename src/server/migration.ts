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
 *   details. Compares secrets internally but never exposes their values.
 */

import crypto from 'crypto';
import { identityGroups, groupIssues, identityProjection } from './identity.ts';

const FIRESTORE_STATE_DOC = 'app-state/main';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailKey(email: string): string {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

/**
 * Order-independent deep comparison. Sorts object keys recursively before
 * comparing, so property ordering differences don't cause false mismatches.
 * Returns list of differing field paths (empty = equal).
 */
function diffFields(a: any, b: any, path: string = ''): string[] {
  const diffs: string[] = [];

  if (a === b) return diffs;
  if (typeof a !== typeof b) {
    diffs.push(path || '(root)');
    return diffs;
  }
  if (a === null || b === null || typeof a !== 'object') {
    // Primitive mismatch (already know a !== b)
    diffs.push(path || '(root)');
    return diffs;
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(path || '(root)');
    return diffs;
  }

  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      diffs.push(`${path} (array length ${a.length} vs ${b.length})`);
      return diffs;
    }
    for (let i = 0; i < a.length; i++) {
      diffs.push(...diffFields(a[i], b[i], `${path}[${i}]`));
    }
    return diffs;
  }

  // Objects: compare sorted keys
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  const allKeys = new Set([...aKeys, ...bKeys]);
  for (const k of allKeys) {
    const childPath = path ? `${path}.${k}` : k;
    if (!(k in a)) {
      diffs.push(`${childPath} (missing in first)`);
    } else if (!(k in b)) {
      diffs.push(`${childPath} (missing in second)`);
    } else {
      diffs.push(...diffFields(a[k], b[k], childPath));
    }
  }
  return diffs;
}

/**
 * Strip per-entity _v for comparison. KEEPS password/kioskPin for internal
 * comparison (ChatGPT: compare secrets internally, report only generic labels).
 */
function stripMetadata(entity: any): any {
  const { _v, ...rest } = entity;
  return JSON.parse(JSON.stringify(rest));
}

/**
 * One-time copy: monolith → per-entity collections.
 *
 * Transactional with all reads before all writes. Copies only missing docs.
 * Verifies/creates usersByEmail lookup for EVERY user (not just copied ones).
 * Detects duplicate normalized emails and refuses conflicting ownership.
 *
 * Counters are computed inside the transaction callback so Firestore retries
 * cannot double-count them.
 */
export async function migrateCopy(firestoreDb: any): Promise<{
  venues: { copied: number; skipped: number };
  users: { copied: number; skipped: number };
  tasks: { copied: number; skipped: number };
  usersByEmail: { created: number; verified: number; conflicts: string[] };
}> {
  return firestoreDb.runTransaction(async (tx: any) => {
    // Counters INSIDE the transaction callback — retries start fresh
    const result = {
      venues: { copied: 0, skipped: 0 },
      users: { copied: 0, skipped: 0 },
      tasks: { copied: 0, skipped: 0 },
      usersByEmail: { created: 0, verified: 0, conflicts: [] as string[] },
    };

    // Phase 1: ALL READS
    const monolithRef = firestoreDb.doc(FIRESTORE_STATE_DOC);
    const monolithSnap = await tx.get(monolithRef);
    if (!monolithSnap.exists) {
      throw new Error('Monolith document not found — nothing to copy.');
    }
    const monolith = monolithSnap.data();

    // Collect all entities
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

    // Check which already exist
    const missing: Array<{ collection: string; id: string; data: any }> = [];
    for (const e of entities) {
      const ref = firestoreDb.collection(e.collection).doc(e.id);
      const snap = await tx.get(ref);
      if (snap.exists) {
        if (e.collection === 'venues') result.venues.skipped++;
        else if (e.collection === 'users') result.users.skipped++;
        else if (e.collection === 'tasks') result.tasks.skipped++;
      } else {
        missing.push(e);
      }
    }

    // Verify/create usersByEmail for EVERY user in monolith (not just missing).
    // Item 10d: the expected mapping comes from identityProjection (the same
    // function the dual-write uses): a person's email -> its credential OWNER
    // row, a legacy row -> itself. An email shared by two identities, or a
    // person group without a valid owner, refuses the copy (as before).
    const proj = identityProjection(monolith.users || [], monolith.agencies || []);
    for (const p of proj.problems) {
      if (p.code === 'email-shared') {
        throw new Error(`Duplicate normalized email in monolith: used by rows ${p.rowIds.join(', ')}. Refusing to copy.`);
      }
      throw new Error(`Identity group without a valid credential owner in monolith: rows ${p.rowIds.join(', ')}. Refusing to copy.`);
    }
    const expectedLookups = new Map<string, { userId: string; email: string }>(); // key -> {userId, email}
    for (const [norm, userId] of proj.lookup) expectedLookups.set(emailKey(norm), { userId, email: norm });

    // Check each expected lookup (read phase)
    const lookupsToCreate: Array<{ key: string; userId: string; email: string }> = [];
    for (const [key, expected] of expectedLookups) {
      const lookupRef = firestoreDb.collection('usersByEmail').doc(key);
      const lookupSnap = await tx.get(lookupRef);
      if (lookupSnap.exists) {
        const actualUserId = lookupSnap.data()?.userId;
        if (actualUserId !== expected.userId) {
          // Conflicting ownership — refuse, don't overwrite
          result.usersByEmail.conflicts.push(
            `Lookup ${key.slice(0, 12)}... exists for ${actualUserId}, expected ${expected.userId}. Refusing.`
          );
        } else {
          result.usersByEmail.verified++;
        }
      } else {
        lookupsToCreate.push({ key, userId: expected.userId, email: expected.email });
      }
    }

    // Phase 2: ALL WRITES
    for (const e of missing) {
      const ref = firestoreDb.collection(e.collection).doc(e.id);
      const clean = JSON.parse(JSON.stringify({ ...e.data, _v: 1 }));
      tx.set(ref, clean);
      if (e.collection === 'venues') result.venues.copied++;
      else if (e.collection === 'users') result.users.copied++;
      else if (e.collection === 'tasks') result.tasks.copied++;
    }

    for (const l of lookupsToCreate) {
      // Skip if a conflict was recorded for this key
      const hasConflict = result.usersByEmail.conflicts.some(c => c.includes(l.key.slice(0, 12)));
      if (!hasConflict) {
        tx.set(firestoreDb.collection('usersByEmail').doc(l.key), {
          userId: l.userId,
          email: l.email,
        });
        result.usersByEmail.created++;
      }
    }

    return result;
  });
}

/**
 * Status check: compare monolith vs per-entity collections.
 *
 * Compares ALL fields including password hashes and kiosk PINs internally,
 * but reports only generic "field mismatch" labels — never secret values.
 * Verifies every expected usersByEmail lookup exists with correct key+userId,
 * and that no incorrect extras exist.
 * Uses order-independent comparison (not raw JSON.stringify).
 */
export async function perEntityStatus(firestoreDb: any): Promise<{
  monolith: { venues: number; users: number; tasks: number };
  perEntity: { venues: number; users: number; tasks: number; usersByEmail: number; people: number; emails: number };
  identity: { migratedRows: number; unmigratedRows: number; peopleActive: number; peopleRetired: number; emailsActive: number; emailsRetired: number; multiGroups: number; invalidGroups: number };
  match: boolean;
  mismatches: Array<{ collection: string; id: string; reason: string }>;
}> {
  const mismatches: Array<{ collection: string; id: string; reason: string }> = [];

  // Read monolith
  const monolithSnap = await firestoreDb.doc(FIRESTORE_STATE_DOC).get();
  const monolith = monolithSnap.exists ? monolithSnap.data() : { venues: [], users: [], tasks: [] };

  // Read per-entity collections
  const [venuesSnap, usersSnap, tasksSnap, lookupsSnap, peopleSnap, emailsSnap] = await Promise.all([
    firestoreDb.collection('venues').get(),
    firestoreDb.collection('users').get(),
    firestoreDb.collection('tasks').get(),
    firestoreDb.collection('usersByEmail').get(),
    // Item 8b: identity projections.
    firestoreDb.collection('people').get(),
    firestoreDb.collection('emails').get(),
  ]);

  const perEntityVenues = new Map<string, any>(venuesSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));
  const perEntityUsers = new Map<string, any>(usersSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));
  const perEntityTasks = new Map<string, any>(tasksSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));

  function compareArrays(
    collection: string,
    monolithArr: any[],
    perEntityMap: Map<string, any>
  ): void {
    const monolithIds = new Set<string>((monolithArr || []).map((e: any) => e?.id).filter(Boolean));

    for (const entity of (monolithArr || [])) {
      if (!entity?.id) continue;
      const perEntity = perEntityMap.get(entity.id);
      if (!perEntity) {
        mismatches.push({ collection, id: entity.id, reason: 'Missing in per-entity collection' });
        continue;
      }
      // Compare ALL fields including secrets internally; report only generic labels
      const monolithClean = stripMetadata(entity);
      const perEntityClean = stripMetadata(perEntity);
      const diffs = diffFields(monolithClean, perEntityClean);
      if (diffs.length > 0) {
        // Sanitize: never include secret field names in output
        const safeDiffs = diffs.map(d => {
          if (d.includes('password') || d.includes('kioskPin')) return 'authentication field mismatch';
          // Truncate long paths, show only top-level field
          const topField = d.split('.')[0].split('[')[0].split(' ')[0];
          return topField;
        });
        const unique = [...new Set(safeDiffs)].slice(0, 5);
        mismatches.push({
          collection,
          id: entity.id,
          reason: `Field mismatch: ${unique.join(', ')}`,
        });
      }
    }

    for (const [id] of perEntityMap) {
      if (!monolithIds.has(id)) {
        mismatches.push({ collection, id, reason: 'In per-entity but not in monolith (orphan)' });
      }
    }
  }

  compareArrays('venues', monolith.venues, perEntityVenues);
  compareArrays('users', monolith.users, perEntityUsers);
  compareArrays('tasks', monolith.tasks, perEntityTasks);

  // Verify usersByEmail: every expected lookup exists with correct userId,
  // and no extras point to wrong users. Item 10d: expected = identityProjection
  // (the dual-write's own function): a person's email -> its credential owner
  // row, a legacy row -> itself. An email shared by two identities is
  // reported once and its key is not compared; a person group without a
  // valid owner is reported by the invariant check below, its key skipped.
  const idProj = identityProjection(monolith.users || [], monolith.agencies || []);
  const skippedKeys = new Set<string>();
  const problemPersons = new Set<string>();
  for (const p of idProj.problems) {
    if (p.code === 'email-shared' && p.email) {
      skippedKeys.add(emailKey(p.email));
      mismatches.push({ collection: 'usersByEmail', id: p.rowIds.slice(1).join(',') || p.rowIds[0], reason: 'Duplicate normalized email in monolith' });
    } else if (p.personId) {
      problemPersons.add(p.personId);
      for (const u of (monolith.users || [])) if (u?.personId === p.personId && u?.email) skippedKeys.add(emailKey(normalizeEmail(u.email)));
    }
  }
  const expectedLookups = new Map<string, string>(); // key -> userId
  for (const [norm, userId] of idProj.lookup) expectedLookups.set(emailKey(norm), userId);

  const actualLookups = new Map<string, string>(); // key -> userId
  for (const d of lookupsSnap.docs) {
    actualLookups.set(d.id, d.data()?.userId || '');
  }

  for (const [key, expectedUserId] of expectedLookups) {
    const actualUserId = actualLookups.get(key);
    if (!actualUserId) {
      mismatches.push({
        collection: 'usersByEmail',
        id: expectedUserId,
        reason: 'Missing email lookup',
      });
    } else if (actualUserId !== expectedUserId) {
      mismatches.push({
        collection: 'usersByEmail',
        id: expectedUserId,
        reason: 'Email lookup points to wrong user',
      });
    }
  }

  for (const [key, actualUserId] of actualLookups) {
    if (skippedKeys.has(key)) continue;
    if (!expectedLookups.has(key)) {
      mismatches.push({
        collection: 'usersByEmail',
        id: actualUserId || key.slice(0, 12),
        reason: 'Extra lookup not in monolith',
      });
    }
  }


  // Item 8b — identity projections, strict: every row WITH personId must have
  // an active people doc (name/primaryEmail matching) and an active emails doc
  // pointing at it; an ACTIVE projection whose person has no row is reported
  // (never auto-repaired). Retired docs are history and fine. Rows without
  // personId (not migrated yet) expect no projections; the counts show them.
  const peopleDocs = new Map<string, any>(peopleSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));
  const emailDocs = new Map<string, any>(emailsSnap.docs.map((d: any) => [d.id, d.data()] as [string, any]));
  let migratedRows = 0;
  let unmigratedRows = 0;
  for (const u of (monolith.users || [])) {
    if (!u?.id) continue;
    if (typeof u.personId === 'string' && u.personId) migratedRows++;
    else unmigratedRows++;
  }
  // Item 10d: expected people/emails come from identityProjection — people/{P}
  // from the owner row, emails/{key} -> P. A person without a valid owner is
  // reported by the invariant check below (not twice here).
  for (const [pid, pp] of idProj.persons) {
    const p = peopleDocs.get(pid);
    if (!p || p.status !== 'active') {
      mismatches.push({ collection: 'people', id: pp.ownerRowId, reason: 'identity projection missing' });
    } else if (p.name !== pp.name || p.primaryEmail !== pp.primaryEmail) {
      mismatches.push({ collection: 'people', id: pp.ownerRowId, reason: 'identity projection out of date' });
    }
    if (pp.primaryEmail && !skippedKeys.has(emailKey(pp.primaryEmail))) {
      const e = emailDocs.get(emailKey(pp.primaryEmail));
      if (!e || e.status !== 'active' || e.personId !== pid) {
        mismatches.push({ collection: 'emails', id: pp.ownerRowId, reason: 'identity projection missing' });
      }
    }
  }
  let peopleActive = 0;
  let peopleRetired = 0;
  for (const [pid, p] of peopleDocs) {
    if (p?.status === 'active') {
      peopleActive++;
      if (!idProj.personIdsWithRows.has(pid)) mismatches.push({ collection: 'people', id: pid, reason: 'active projection without row' });
    } else {
      peopleRetired++;
    }
  }
  let emailsActive = 0;
  let emailsRetired = 0;
  for (const [key, e] of emailDocs) {
    if (e?.status === 'active') {
      emailsActive++;
      if (problemPersons.has(e.personId) || skippedKeys.has(key)) continue;
      const owner = idProj.persons.get(e.personId);
      if (!owner || !owner.primaryEmail || emailKey(owner.primaryEmail) !== key) {
        mismatches.push({ collection: 'emails', id: e?.personId || key.slice(0, 12), reason: 'active projection without row' });
      }
    } else {
      emailsRetired++;
    }
  }

  // 10b (plan v4 10b/C6) — READ-ONLY identity invariant check on the stored
  // users[]: every group of 2+ rows sharing an email or a personId in which a
  // row carries personId is checked with the same rules the commit-time
  // checker uses (identity.ts groupIssues). Legacy shared-email rows without
  // personId are already reported above as duplicate emails. Row ids and
  // codes only; nothing is written. Run before any Phase C activation.
  let multiGroups = 0;
  let invalidGroups = 0;
  const monolithUsers: any[] = Array.isArray(monolith.users) ? monolith.users : [];
  const usersById = new Map<string, any>(monolithUsers.filter((u: any) => u && typeof u.id === 'string').map((u: any) => [u.id, u] as [string, any]));
  for (const g of identityGroups(monolithUsers)) {
    if (g.length < 2) continue;
    const rows = g.map((id) => usersById.get(id));
    if (!rows.some((r: any) => typeof r?.personId === 'string' && r.personId)) continue;
    multiGroups++;
    const issues = groupIssues(rows, Array.isArray(monolith.agencies) ? monolith.agencies : []);
    if (issues.length) invalidGroups++;
    for (const issue of issues) {
      mismatches.push({ collection: 'users', id: issue.rowIds.join(','), reason: `identity invariant: ${issue.code}` });
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
      people: peopleSnap.size,
      emails: emailsSnap.size,
    },
    identity: { migratedRows, unmigratedRows, peopleActive, peopleRetired, emailsActive, emailsRetired, multiGroups, invalidGroups },
    match: mismatches.length === 0,
    mismatches: mismatches.slice(0, 20),
  };
}
