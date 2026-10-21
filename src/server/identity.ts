/**
 * Item 8b — identity projections (Phase A of multi-agency; no login change).
 *
 * Phase A model: a users[] row IS the membership (one membership per person,
 * as today). A migrated row carries personId (= row.id in Phase A) plus two
 * SERVER-DERIVED fields, venueAccess and isPrimaryAdmin. Credentials stay on
 * the row exactly where they are; nothing in Phase A authenticates through
 * the people/emails collections.
 *
 * people/{personId} and emails/{emailKey} are PROJECTIONS maintained by
 * dualwrite.ts inside the same transaction as the monolith commit, derived
 * only from rows that carry personId.
 *
 * SECURITY CONTRACT (read before using these collections for anything):
 * - Every emails mapping is verified === false, source 'admin-entered'. An
 *   admin typed the address; nobody proved they own it.
 * - A RETIRED or REASSIGNED mapping must never resolve to a previous
 *   identity. previousPersonIds is history only.
 * - Phase C (personal verification / account chooser) MUST require
 *   verified === true before any login use of an emails mapping.
 * - personId, venueAccess, isPrimaryAdmin and tokenEpoch are server-only:
 *   never accepted from a request body, never sent to a client.
 */

import crypto from 'crypto';

/** Fields on a users[] row that only the server may set; never sent to clients. */
export const SERVER_ONLY_USER_FIELDS = ['personId', 'venueAccess', 'isPrimaryAdmin', 'tokenEpoch'] as const;

export function normalizeEmail(email: string): string {
  return String(email).trim().toLowerCase();
}

/** Same key as usersByEmail: sha256 of the trimmed, lowercased address. */
export function emailKey(email: string): string {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

/** Returns a shallow copy of obj without any server-only identity field. */
export function stripServerOnlyUserFields<T extends Record<string, any>>(obj: T): T {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: any = { ...obj };
  for (const f of SERVER_ONLY_USER_FIELDS) delete out[f];
  return out;
}

/** Derived fields for a migrated row (pure). */
export function deriveIdentityFields(
  row: any,
  agencies: any[]
): { venueAccess: string[]; isPrimaryAdmin: boolean } {
  const venueAccess = typeof row?.venueId === 'string' && row.venueId ? [row.venueId] : [];
  const agencyId = row?.agencyId || 'agency-hkc';
  const agency = (Array.isArray(agencies) ? agencies : []).find((a: any) => a && a.id === agencyId);
  const adminEmail = typeof agency?.adminEmail === 'string' ? normalizeEmail(agency.adminEmail) : '';
  const isPrimaryAdmin =
    row?.role === 'admin' &&
    typeof row?.email === 'string' &&
    adminEmail !== '' &&
    normalizeEmail(row.email) === adminEmail;
  return { venueAccess, isPrimaryAdmin };
}

export interface IdentityEnforceOptions {
  /**
   * 8c only: ids of legacy rows the identity migrator is migrating in this
   * commit (personId := row.id). No other caller may pass this.
   */
  migrateRowIds?: ReadonlySet<string>;
  /**
   * 8d: ids of EXISTING rows whose tokenEpoch goes up by exactly 1 in this
   * commit (revokes that row's v1 and v2 session tokens). Counted from the
   * before row, never from the mutator's output. A new row is never bumped.
   */
  bumpTokenEpochIds?: ReadonlySet<string>;
  /**
   * Called (row id + field name only, never values) when a mutator's output
   * tried to set, change or remove a server-only identity field. The change
   * is reverted, and the caller logs it, so it is never silent.
   */
  onViolation?: (rowId: string, field: string) => void;
}

/**
 * The ONE enforcement point for server-only identity fields (rule N), run by
 * commitState on every outcome doc before it is written:
 *  - an existing row keeps exactly the personId/tokenEpoch it had before
 *    (no mutator or request can set, change or remove them);
 *  - a NEW row is born migrated: personId = row.id, no tokenEpoch;
 *  - every row with personId gets venueAccess/isPrimaryAdmin re-derived;
 *    rows without personId carry neither.
 * Returns a new users array (input not mutated).
 */
export function enforceIdentityFields(
  beforeUsers: any[],
  afterUsers: any[],
  afterAgencies: any[],
  opts: IdentityEnforceOptions = {}
): any[] {
  const beforeById = new Map<string, any>();
  for (const u of Array.isArray(beforeUsers) ? beforeUsers : []) {
    if (u && typeof u.id === 'string') beforeById.set(u.id, u);
  }
  return (Array.isArray(afterUsers) ? afterUsers : []).map((row: any) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') return row;
    const out: any = stripServerOnlyUserFields(row);
    const prev = beforeById.get(row.id);
    if (prev) {
      if (typeof prev.personId === 'string' && prev.personId) out.personId = prev.personId;
      else if (opts.migrateRowIds?.has(row.id)) out.personId = row.id;
      if (prev.tokenEpoch !== undefined) out.tokenEpoch = prev.tokenEpoch;
      if (opts.bumpTokenEpochIds?.has(row.id)) {
        const base = Number.isInteger(prev.tokenEpoch) && prev.tokenEpoch > 0 ? prev.tokenEpoch : 0;
        out.tokenEpoch = base + 1;
      }
    } else {
      out.personId = row.id;
    }
    if (opts.onViolation) {
      if (row.personId !== undefined && row.personId !== out.personId) opts.onViolation(row.id, 'personId');
      const bumped = !!(prev && opts.bumpTokenEpochIds?.has(row.id));
      if (!bumped && row.tokenEpoch !== undefined && row.tokenEpoch !== out.tokenEpoch) opts.onViolation(row.id, 'tokenEpoch');
      if (prev && prev.personId && row.personId === undefined) opts.onViolation(row.id, 'personId');
      if (prev && prev.tokenEpoch !== undefined && row.tokenEpoch === undefined) opts.onViolation(row.id, 'tokenEpoch');
    }
    if (out.personId) {
      const d = deriveIdentityFields(out, afterAgencies);
      out.venueAccess = d.venueAccess;
      out.isPrimaryAdmin = d.isPrimaryAdmin;
    }
    return out;
  });
}
