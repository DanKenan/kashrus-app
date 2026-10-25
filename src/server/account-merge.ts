/**
 * 10M part 2 — merge two accounts ("Agreed — 10M part 2", design v4/v5 M6c in
 * files/shutfey-10M-design.txt). Pure helpers: no I/O, no logging, never throw.
 *
 * Inside the RETIRED person's agencies, the email fields named in
 * MERGE_EMAIL_FIELDS that hold the retired email (trimmed, case-insensitive,
 * exact) are set to the survivor's email, so every email-keyed check (own
 * note, own check-in, template creator, ingredient verifier, primary admin,
 * venue owner, event assignee, task assignment, announcements, alerts) keeps
 * working for the survivor and nothing points at the retired email. Only the
 * named fields are touched; object keys are never renamed (no email-keyed map
 * exists in these collections).
 */

import { isPlatformOperator, PLATFORM_OPERATOR_USER_ID } from './platform-auth.ts';
import { credentialMayLink } from './invites.ts';

/**
 * Collection -> email field paths. `a.b` walks an object, `a[]` walks a list
 * (a list of strings at the end of a path: each matching item is replaced;
 * the survivor's email appears at most once afterwards).
 */
export const MERGE_EMAIL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  agencies: ['adminEmail'],
  venues: ['ownerEmail'],
  tasks: ['assignedTo[]', 'createdByEmail', 'updatedByEmail', 'checkIns[].byEmail'],
  historyLogs: ['resetBy', 'entries[].completedByEmail'],
  handoffNotes: ['authorEmail', 'readBy[]'],
  taskTemplates: ['createdByEmail'],
  incidents: ['reporterEmail', 'acknowledgedBy', 'resolvedBy'],
  announcements: ['authorEmail', 'readBy[]'],
  events: ['assignedMashgiachEmail', 'createdByEmail', 'externalMashgiach.email', 'tasks[].completedByEmail'],
  approvedIngredients: ['verifiedByEmail'],
  factoryReports: ['mashgiachEmail', 'discrepancies[].reportedByEmail'],
};
export const MERGE_REWRITE_COLLECTIONS = Object.keys(MERGE_EMAIL_FIELDS);

/**
 * Every other key of the persisted state, and why it is not rewritten:
 * users (the identity writer's personMerge); invites / resetLinks /
 * passwordResets / pushSubscriptions (revoked or removed by the merge
 * itself); eventTaskTemplates / airtableConfigs / kioskDevices /
 * kioskPairings (no email field: names and user ids only); limiter and
 * lockout maps, ids, dates, flags and secrets. A source test pins that
 * stateSnapshot() keys = rewrite ∪ skip, disjoint.
 */
export const MERGE_SKIP_KEYS = [
  '_v', 'users', 'invites', 'resetLinks', 'passwordResets', 'pushSubscriptions',
  'eventTaskTemplates', 'airtableConfigs', 'kioskDevices', 'kioskPairings',
  'passwordResetRateLimits', 'kioskPinLockouts', 'kioskPairingLimits', 'deletedVenueIds',
  'venueWorkDates', 'currentWorkDate', 'isDemoCleared', 'vapidKeys', 'jwtSecret', 'resetPepper',
] as const;

export function mergeEmailKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * The owner of a stored record, following the read/write paths (they scope a
 * record by `agencyId || 'agency-hkc'` and never consult its venue):
 *  - agencies: the record's id;
 *  - a non-empty agencyId: that agency;
 *  - no agencyId and no venue reference: 'agency-hkc' (the established default);
 *  - no agencyId and a venue reference to exactly ONE stored venue that is in
 *    'agency-hkc': 'agency-hkc' (the default and the venue agree);
 *  - no agencyId and a venue reference that is missing, duplicated, or to a
 *    venue of another agency: AMBIGUOUS (null) — never guessed.
 */
export function recordOwnerAgency(collection: string, rec: any, venueAgencies: ReadonlyMap<string, string[]>): string | null {
  if (collection === 'agencies') return rec && typeof rec.id === 'string' && rec.id ? rec.id : null;
  if (rec && typeof rec.agencyId === 'string' && rec.agencyId) return rec.agencyId;
  const vid = rec ? rec.venueId : undefined;
  if (vid === undefined || vid === null || vid === '') return 'agency-hkc';
  const owners = typeof vid === 'string' ? venueAgencies.get(vid) || [] : [];
  if (owners.length === 1 && owners[0] === 'agency-hkc') return 'agency-hkc';
  return null;
}

/** Applies one parsed path to v; returns the new value (same reference when nothing changed). */
function applyPath(v: any, segs: string[], fromKey: string, to: string, box: { n: number }): any {
  if (!segs.length || v === null || typeof v !== 'object') return v;
  const [seg, ...rest] = segs;
  const isList = seg.endsWith('[]');
  const name = isList ? seg.slice(0, -2) : seg;
  if (Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, name)) return v;
  const cur = v[name];
  let next: any = cur;
  if (isList) {
    if (!Array.isArray(cur)) return v;
    if (!rest.length) {
      if (!cur.some((x: any) => typeof x === 'string' && mergeEmailKey(x) === fromKey)) return v;
      const seen = new Set<string>();
      next = [];
      for (const x of cur) {
        let y = x;
        if (typeof x === 'string' && mergeEmailKey(x) === fromKey) { y = to; box.n++; }
        if (typeof y === 'string' && mergeEmailKey(y) === mergeEmailKey(to)) {
          if (seen.has('to')) continue;
          seen.add('to');
        }
        next.push(y);
      }
    } else {
      let changed = false;
      next = cur.map((x: any) => { const y = applyPath(x, rest, fromKey, to, box); if (y !== x) changed = true; return y; });
      if (!changed) return v;
    }
  } else if (!rest.length) {
    if (typeof cur !== 'string' || mergeEmailKey(cur) !== fromKey) return v;
    next = to;
    box.n++;
  } else {
    next = applyPath(cur, rest, fromKey, to, box);
    if (next === cur) return v;
  }
  return { ...v, [name]: next };
}

/** Does any schema field of this record hold fromKey? */
export function recordHoldsEmail(collection: string, rec: any, fromKey: string): boolean {
  const box = { n: 0 };
  for (const p of MERGE_EMAIL_FIELDS[collection] || []) applyPath(rec, p.split('.'), fromKey, '\u0000', box);
  return box.n > 0;
}

export type RewriteResult =
  | { ok: true; patch: Record<string, any[]>; replaced: number }
  | { ok: false; collection: string; recordId: string };

/**
 * The rewritten collections of `doc` for a merge of fromEmail into toEmail,
 * limited to records owned by `agencyIds` (recordOwnerAgency). A record whose
 * owner is AMBIGUOUS and that holds fromEmail in a schema field fails the
 * whole rewrite (fail closed); one that does not hold it is left alone.
 */
export function rewriteEmailRefs(doc: any, agencyIds: ReadonlySet<string>, fromEmail: string, toEmail: string): RewriteResult {
  const patch: Record<string, any[]> = {};
  const fromKey = mergeEmailKey(fromEmail);
  const to = mergeEmailKey(toEmail);
  let replaced = 0;
  if (!fromKey || !to || fromKey === to || !doc || typeof doc !== 'object') return { ok: true, patch, replaced };
  const venueAgencies = new Map<string, string[]>();
  for (const v of Array.isArray(doc.venues) ? doc.venues : []) {
    if (!v || typeof v.id !== 'string') continue;
    const list = venueAgencies.get(v.id) || [];
    list.push((typeof v.agencyId === 'string' && v.agencyId) || 'agency-hkc');
    venueAgencies.set(v.id, list);
  }
  for (const c of MERGE_REWRITE_COLLECTIONS) {
    const list = doc[c];
    if (!Array.isArray(list)) continue;
    const paths = MERGE_EMAIL_FIELDS[c].map((p) => p.split('.'));
    let changed = false;
    const next: any[] = [];
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') { next.push(rec); continue; }
      const owner = recordOwnerAgency(c, rec, venueAgencies);
      if (owner === null) {
        // Ownership can't be established: fail closed when it holds the retired email.
        if (recordHoldsEmail(c, rec, fromKey)) return { ok: false, collection: c, recordId: typeof rec.id === 'string' ? rec.id : '' };
        next.push(rec);
        continue;
      }
      if (!agencyIds.has(owner)) { next.push(rec); continue; }
      const box = { n: 0 };
      let out = rec;
      for (const segs of paths) out = applyPath(out, segs, fromKey, to, box);
      if (box.n) { changed = true; replaced += box.n; }
      next.push(out);
    }
    if (changed) patch[c] = next;
  }
  return { ok: true, patch, replaced };
}

// ---------------------------------------------------------------------------
// MERGE-FIX (files/shutfey-mergefix-plan.txt v2, E1/E2): who may be merged.
// ---------------------------------------------------------------------------

/**
 * The ONE exception to the linkable-origin rule: the pinned platform operator
 * row (usr_admin, still a valid operator on these rows) may be the SURVIVOR
 * when its credentialOrigin is absent (no recorded origin: it predates 10b) or
 * linkable. 'admin', 'agency-reset' and any other value stay refused. This is
 * an explicit trust exception for that one row, not proof of its history.
 * Every other absent-origin (legacy) row stays non-linkable.
 */
export function isOperatorSurvivor(rows: readonly any[], survivorCred: any): boolean {
  if (!survivorCred || survivorCred.id !== PLATFORM_OPERATOR_USER_ID) return false;
  if (!isPlatformOperator(survivorCred.id, false, rows as any)) return false;
  const origin = survivorCred.credentialOrigin;
  return origin === undefined || origin === null || credentialMayLink(origin);
}

/**
 * Origin + operator rules of a merge (the caller already resolved both
 * credential rows and both persons' rows from the SAME list `rows`):
 *  - the retired credential must be linkable (no exception);
 *  - the survivor credential must be linkable, or the operator exception;
 *  - the pinned operator row (by row id, valid operator or not) is never on
 *    the retired side;
 *  - on the survivor side only as the survivor's own credential row while
 *    it is a valid operator (the operator exception).
 * Fail closed on anything missing.
 */
export function mergeOriginOperatorOk(rows: readonly any[], survivorCred: any, retiredCred: any, survivorRows: readonly any[], retiredRows: readonly any[]): boolean {
  if (!survivorCred || !retiredCred) return false;
  const operatorSurvivor = isOperatorSurvivor(rows, survivorCred);
  if (!credentialMayLink(retiredCred.credentialOrigin)) return false;
  if (!credentialMayLink(survivorCred.credentialOrigin) && !operatorSurvivor) return false;
  const pinned = (u: any) => !!u && (u.id === PLATFORM_OPERATOR_USER_ID || isPlatformOperator(u.id, false, rows as any));
  if (retiredRows.some(pinned)) return false;
  if (survivorRows.some((u: any) => pinned(u) && !(operatorSurvivor && u.id === survivorCred.id))) return false;
  return true;
}
