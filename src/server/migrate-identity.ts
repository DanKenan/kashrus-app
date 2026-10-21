/**
 * Item 8c — identity migrator + projection repair (Phase A; no login change).
 *
 * Pure planners and constants only; no I/O. server.ts runs them inside
 * transactions (POST /api/admin/identity-migration). Agreed plan: "8c plan
 * v2" (shutfey-8-plan.txt).
 *
 * Two explicit steps, both scoped to the caller's agency, both dry-run unless
 * apply === true:
 *  (a) ROW MIGRATION: legacy rows (no personId) gain personId = row.id via
 *      commitState's identityMigrateRowIds (the ONLY way an existing row gains
 *      personId); 8b's dual-write writes their people/emails in the same
 *      transaction.
 *  (b) PROJECTION REPAIR: for rows that already carry personId, write only
 *      missing/stale people/emails docs; never writes the monolith.
 *
 * Ownership of people/{id} is proven ONLY by the server-only binding
 * row.personId === id, never by an email match:
 *  - an unmigrated row never owned a people doc, so an existing people/{row.id}
 *    (active or retired) is another identity's: conflict 'person-doc-exists';
 *  - a retired people doc is never revived: conflict 'person-doc-retired';
 *  - an emails mapping active for another person is never taken over:
 *    conflict 'email-active-other-person'.
 * Conflicts are reported as user id + reason code only (no emails, names or
 * credentials) and nothing is written for that row.
 */

import { emailKey, normalizeEmail } from './identity.ts';

/** At most this many users per batch. With 99 users a row batch touches at
 * most 1 + 3×99 = 298 distinct documents for reads (monolith, users/{id},
 * people/{id}, emails/{key}) and 298 for writes, inside READ_LIMIT/WRITE_LIMIT. */
export const BATCH_MAX_USERS = 99;
export const MAX_BATCHES_PER_CALL = 10;
export const WRITE_LIMIT = 400;
export const READ_LIMIT = 300;

export type ConflictReason =
  | 'email-missing'
  | 'email-duplicate'
  | 'email-active-other-person'
  | 'person-doc-exists'
  | 'person-doc-retired';

export interface Conflict {
  userId: string;
  reason: ConflictReason;
}

export type MigrationStep = 'rows' | 'repair';

export const DEFAULT_AGENCY_ID = 'agency-hkc';

export function rowAgencyId(row: any): string {
  return (row && row.agencyId) || DEFAULT_AGENCY_ID;
}

export function inScope(row: any, agencyId: string): boolean {
  return !!row && typeof row === 'object' && typeof row.id === 'string' && row.id !== '' && rowAgencyId(row) === agencyId;
}

function isMigrated(row: any): boolean {
  return typeof row?.personId === 'string' && row.personId !== '';
}

function usableEmail(row: any): string {
  return typeof row?.email === 'string' && row.email.trim() !== '' ? normalizeEmail(row.email) : '';
}

/**
 * The next batch of candidates for a step, in stable ascending id order:
 * rows of the agency with id > cursor that lack personId ('rows') or carry it
 * ('repair'). `more` says whether candidates remain after this batch.
 */
export function nextCandidates(
  doc: any,
  agencyId: string,
  step: MigrationStep,
  cursor: string | null,
  limit: number = BATCH_MAX_USERS
): { batch: any[]; more: boolean; lastId: string | null } {
  const users: any[] = Array.isArray(doc?.users) ? doc.users : [];
  const all = users
    .filter((u) => inScope(u, agencyId) && (step === 'rows' ? !isMigrated(u) : isMigrated(u)))
    .filter((u) => cursor === null || u.id > cursor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batch = all.slice(0, Math.max(0, limit));
  return { batch, more: all.length > batch.length, lastId: batch.length ? batch[batch.length - 1].id : null };
}

/** The documents a row batch must read inside its transaction (before any write). */
export function rowBatchReadSet(batch: any[]): { peopleIds: string[]; emailKeys: string[] } {
  const peopleIds: string[] = [];
  const keys = new Set<string>();
  for (const row of batch) {
    peopleIds.push(row.id);
    const e = usableEmail(row);
    if (e) keys.add(emailKey(e));
  }
  return { peopleIds, emailKeys: [...keys] };
}

/** The documents a repair batch must read inside its transaction. */
export function repairBatchReadSet(batch: any[]): { peopleIds: string[]; emailKeys: string[] } {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const row of batch) {
    ids.add(row.personId);
    const e = usableEmail(row);
    if (e) keys.add(emailKey(e));
  }
  return { peopleIds: [...ids], emailKeys: [...keys] };
}

/** Documents touched by a row batch of n users (reads and writes, worst case). */
export function rowBatchDocCount(n: number): number {
  return 1 + 3 * n;
}

export function rowBatchWithinLimits(n: number): boolean {
  const docs = rowBatchDocCount(n);
  return n <= BATCH_MAX_USERS && docs <= READ_LIMIT && docs <= WRITE_LIMIT;
}

/**
 * Decide a row-migration batch on FRESH data (the monolith doc and the
 * people/emails docs read in the same transaction). Returns the ids to
 * migrate (personId := row.id) and the conflicts. Pure.
 *
 * email-missing:             no usable email (no emails key to project);
 * email-duplicate:           another row anywhere in the doc (migrated, or
 *                            another candidate in this batch) uses the same
 *                            address, so the mapping would be ambiguous;
 * person-doc-exists:         people/{row.id} already exists (any status);
 * email-active-other-person: emails/{key} is active for a different personId.
 * A retired emails mapping is fine: 8b's dual-write reassigns it with history.
 */
export function planRowBatch(
  doc: any,
  batch: any[],
  peopleDocs: ReadonlyMap<string, any>,
  emailDocs: ReadonlyMap<string, any>
): { migrate: string[]; conflicts: Conflict[] } {
  const users: any[] = Array.isArray(doc?.users) ? doc.users : [];
  // How many rows in the whole doc use each email key.
  const keyUse = new Map<string, number>();
  for (const u of users) {
    const e = usableEmail(u);
    if (!e) continue;
    const k = emailKey(e);
    keyUse.set(k, (keyUse.get(k) || 0) + 1);
  }
  const migrate: string[] = [];
  const conflicts: Conflict[] = [];
  for (const row of batch) {
    const e = usableEmail(row);
    if (!e) {
      conflicts.push({ userId: row.id, reason: 'email-missing' });
      continue;
    }
    const k = emailKey(e);
    if ((keyUse.get(k) || 0) > 1) {
      conflicts.push({ userId: row.id, reason: 'email-duplicate' });
      continue;
    }
    if (peopleDocs.get(row.id)) {
      conflicts.push({ userId: row.id, reason: 'person-doc-exists' });
      continue;
    }
    const m = emailDocs.get(k);
    if (m && m.status === 'active' && m.personId !== row.id) {
      conflicts.push({ userId: row.id, reason: 'email-active-other-person' });
      continue;
    }
    migrate.push(row.id);
  }
  return { migrate, conflicts };
}

export interface ProjectionWrite {
  collection: 'people' | 'emails';
  id: string;
  data: any;
}

/**
 * Decide a projection-repair batch on FRESH data. Only rows that carry
 * personId (bound by the server). Returns the writes (missing or stale docs
 * only), the per-row repaired/ok counts and the conflicts. Never touches the
 * monolith. The doc shapes are exactly 8b's dual-write shapes. Pure.
 */
export function planRepairBatch(
  doc: any,
  batch: any[],
  peopleDocs: ReadonlyMap<string, any>,
  emailDocs: ReadonlyMap<string, any>,
  nowIso: string
): { writes: ProjectionWrite[]; repaired: string[]; ok: number; conflicts: Conflict[] } {
  const users: any[] = Array.isArray(doc?.users) ? doc.users : [];
  const keyUse = new Map<string, number>();
  for (const u of users) {
    if (!isMigrated(u)) continue;
    const e = usableEmail(u);
    if (!e) continue;
    const k = emailKey(e);
    keyUse.set(k, (keyUse.get(k) || 0) + 1);
  }
  const writes: ProjectionWrite[] = [];
  const repaired: string[] = [];
  const conflicts: Conflict[] = [];
  let ok = 0;
  for (const row of batch) {
    const pid: string = row.personId;
    const person = peopleDocs.get(pid) || null;
    if (person && person.status === 'retired') {
      conflicts.push({ userId: row.id, reason: 'person-doc-retired' });
      continue;
    }
    const e = usableEmail(row);
    const k = e ? emailKey(e) : '';
    const mapping = k ? emailDocs.get(k) || null : null;
    if (k && (keyUse.get(k) || 0) > 1) {
      conflicts.push({ userId: row.id, reason: 'email-duplicate' });
      continue;
    }
    if (mapping && mapping.status === 'active' && mapping.personId !== pid) {
      conflicts.push({ userId: row.id, reason: 'email-active-other-person' });
      continue;
    }
    const name = typeof row.name === 'string' ? row.name : '';
    const rowWrites: ProjectionWrite[] = [];
    const personStale =
      !person || person.id !== pid || person.name !== name || person.primaryEmail !== e || person.status !== 'active';
    if (personStale) {
      rowWrites.push({
        collection: 'people',
        id: pid,
        data: {
          id: pid,
          name,
          primaryEmail: e,
          status: 'active',
          createdAt: person?.createdAt || nowIso,
          _v: (person?._v || 0) + 1,
        },
      });
    }
    if (k && (!mapping || mapping.personId !== pid || mapping.status !== 'active')) {
      const data: any = { personId: pid, status: 'active', verified: false, source: 'admin-entered', addedAt: nowIso };
      if (mapping && mapping.personId && mapping.personId !== pid) {
        const prev: string[] = Array.isArray(mapping.previousPersonIds) ? mapping.previousPersonIds : [];
        data.previousPersonIds = [...prev, mapping.personId];
        data.reassignedAt = nowIso;
      } else if (mapping && Array.isArray(mapping.previousPersonIds)) {
        data.previousPersonIds = mapping.previousPersonIds;
        if (mapping.reassignedAt) data.reassignedAt = mapping.reassignedAt;
      }
      rowWrites.push({ collection: 'emails', id: k, data });
    }
    if (rowWrites.length) {
      writes.push(...rowWrites);
      repaired.push(row.id);
    } else {
      ok++;
    }
  }
  return { writes, repaired, ok, conflicts };
}

/** Sanitized conflict list: ids + reason codes only, stable order, one per row. */
export function dedupeConflicts(list: Conflict[]): Conflict[] {
  const seen = new Map<string, Conflict>();
  for (const c of list) if (!seen.has(c.userId)) seen.set(c.userId, { userId: c.userId, reason: c.reason });
  return [...seen.values()].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}
