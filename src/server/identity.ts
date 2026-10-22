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

/**
 * Fields on a users[] row that only the server may set; never accepted from a
 * request body, never sent to a client. 10b (item 10, Phase C) adds the
 * credential fields: credentialOwner, credentialOrigin, recoveryCodeHashes,
 * recoveryFailures, joinedAt. In 10b only credentialOrigin has a writer
 * (register / add-member / owner creation / agency-assisted reset, through
 * credentialOriginSetById); the others are preserved exactly as stored and
 * get their writers in 10d/10e/10f/10i.
 */
export const SERVER_ONLY_USER_FIELDS = [
  'personId', 'venueAccess', 'isPrimaryAdmin', 'tokenEpoch',
  'credentialOwner', 'credentialOrigin', 'recoveryCodeHashes', 'recoveryFailures', 'joinedAt',
] as const;

/**
 * 10b (plan v4 C1): where a row's password came from. Absent = legacy,
 * unverified (every row that existed before 10b). Only 'self-registered'
 * and (from 10i) 'invite-new' will ever be linkable; that decision lives in
 * ONE helper in 10i, not here.
 */
export const CREDENTIAL_ORIGINS = ['self-registered', 'admin', 'invite-new', 'agency-reset'] as const;
export type CredentialOrigin = (typeof CREDENTIAL_ORIGINS)[number];

/** Server-only fields an existing row keeps exactly as stored (no 10b writer). */
const PRESERVED_CREDENTIAL_FIELDS = ['credentialOwner', 'recoveryCodeHashes', 'recoveryFailures', 'joinedAt'] as const;

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

/**
 * 9a: home venue first (when set), then the other ids — strings only, no
 * duplicates. Agency membership is NOT decided here (rows do not carry the
 * venue list); every read decides it against the CURRENT venues
 * (src/server/venue-scope.ts), so a stale or foreign id grants nothing.
 */
export function mergeVenueAccess(homeVenueId: unknown, list: readonly unknown[]): string[] {
  const out: string[] = [];
  const add = (x: unknown) => { if (typeof x === 'string' && x && !out.includes(x)) out.push(x); };
  add(homeVenueId);
  for (const x of Array.isArray(list) ? list : []) add(x);
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
   * 9a: the ONLY way venueAccess changes beyond the home venue. Row id → the
   * full list the server validated in this commit (admin venue grant, venue
   * deletion). The home venue is always kept. Rows not in the map
   * keep their PREVIOUS stored list while their home venue is unchanged; a
   * home-venue change without an entry here resets the list to [venueId].
   */
  venueAccessSetById?: ReadonlyMap<string, readonly string[]>;
  /**
   * 10b: the ONLY way credentialOrigin is set or changed. Row id → origin.
   * A value outside CREDENTIAL_ORIGINS is ignored (reported as a violation).
   */
  credentialOriginSetById?: ReadonlyMap<string, string>;
  /**
   * 10b: rows whose password changes in this commit WITHOUT changing its
   * origin (the person's own change-password; the legacy plaintext→bcrypt
   * upgrade at login). Any other password change on an existing row that is
   * not in credentialOriginSetById DROPS the origin (fail closed: a new
   * password-writing path can never inherit a linkable origin).
   */
  passwordKeepsOriginIds?: ReadonlySet<string>;
  /**
   * 10b (used from 10i only): NEW row id → the personId of an EXISTING person
   * it joins. The only way a new row gets personId !== row.id. Honoured only
   * when a row that already existed before this commit carries that personId
   * AND the same normalized email; otherwise the new row keeps
   * personId = row.id and a violation is reported.
   */
  newMembership?: ReadonlyMap<string, string>;
  /**
   * 10d: destination row id → removed source owner row id of an owner
   * transfer ALREADY validated and applied by applyOwnerTransfer. On the
   * destination only, the credential fields come from the source's stored
   * values (credentialOwner, recoveryCodeHashes, recoveryFailures,
   * credentialOrigin); membership fields (joinedAt, tokenEpoch, …) stay its own.
   */
  ownerTransferIds?: ReadonlyMap<string, string>;
  /**
   * 10f: the ONLY writer of recoveryCodeHashes / recoveryFailures. Row id →
   * the new value of each field named (null = remove; a field not named is
   * kept as stored). Honoured only on an EXISTING row that is its person's
   * credential row in the BEFORE users (a single-row person's own row, or the
   * multi person's credentialOwner); any other target is reverted and
   * reported as a violation.
   */
  recoveryWriteById?: ReadonlyMap<string, RecoveryWrite>;
  /**
   * 10i: the ONLY writer that marks a row credentialOwner when its person
   * first becomes multi (the accept transaction). Honoured only on an
   * EXISTING row that, in the BEFORE users, is a single-row person (no other
   * row carries its personId), holds a bcrypt password, is not already an
   * owner, AND whose personId is the target of a newMembership join in the
   * same commit. Anything else is reverted (preserved field) and reported.
   */
  firstMultiOwnerIds?: ReadonlySet<string>;
  /**
   * Called (row id + field name only, never values) when a mutator's output
   * tried to set, change or remove a server-only identity field. The change
   * is reverted, and the caller logs it, so it is never silent.
   */
  onViolation?: (rowId: string, field: string) => void;
  /** 10b: every credentialOrigin change (row id, old, new; never a value). */
  onOriginChange?: (rowId: string, from: string | null, to: string | null) => void;
}

/**
 * 10b: the identity options a mutator outcome may carry. commitState hands
 * the whole outcome to identityOptionsFromOutcome(), so server.ts never names
 * an option it does not use (the source test pins newMembership to the 10i
 * accept handler).
 */
/** 10f: a recovery-field write (see recoveryWriteById). */
export interface RecoveryWrite {
  codes?: unknown | null;
  failures?: unknown | null;
}

export interface IdentityOutcomeFields {
  /** 10b: row id → credentialOrigin set in this commit (see credentialOriginSetById). */
  credentialOriginSetById?: Record<string, CredentialOrigin>;
  /** 10b: rows whose password change keeps the origin (see passwordKeepsOriginIds). */
  passwordKeepsOriginIds?: string[];
  /** 10i only (and the 10d test-mode builder): new row id → existing personId (see newMembership). */
  newMembership?: Record<string, string>;
  /** 10d: a declared owner transfer (validated + applied by applyOwnerTransfer). */
  ownerTransfer?: OwnerTransfer;
  /** 10f: row id → recovery-field write (see recoveryWriteById). */
  recoveryWriteById?: Record<string, RecoveryWrite>;
  /** 10i: rows that become their person's credentialOwner at the first multi join (see firstMultiOwnerIds). */
  firstMultiOwnerIds?: string[];
}

export function identityOptionsFromOutcome(outcome: IdentityOutcomeFields | null | undefined): Pick<IdentityEnforceOptions, 'credentialOriginSetById' | 'passwordKeepsOriginIds' | 'newMembership' | 'recoveryWriteById' | 'firstMultiOwnerIds'> {
  const o: any = outcome || {};
  const asMap = (r: any) => (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length ? new Map<string, string>(Object.entries(r).filter(([, v]) => typeof v === 'string') as [string, string][]) : undefined);
  return {
    credentialOriginSetById: asMap(o.credentialOriginSetById),
    passwordKeepsOriginIds: Array.isArray(o.passwordKeepsOriginIds) && o.passwordKeepsOriginIds.length ? new Set<string>(o.passwordKeepsOriginIds) : undefined,
    newMembership: asMap(o.newMembership),
    recoveryWriteById:
      o.recoveryWriteById && typeof o.recoveryWriteById === 'object' && !Array.isArray(o.recoveryWriteById) && Object.keys(o.recoveryWriteById).length
        ? new Map<string, RecoveryWrite>(Object.entries(o.recoveryWriteById).filter(([, v]) => v && typeof v === 'object') as [string, RecoveryWrite][])
        : undefined,
    firstMultiOwnerIds: Array.isArray(o.firstMultiOwnerIds) && o.firstMultiOwnerIds.length ? new Set<string>(o.firstMultiOwnerIds.filter((x: any) => typeof x === 'string')) : undefined,
  };
}

/** 10f: the row is its person's credential row in `rows` (single-row person: itself; multi: the credentialOwner). */
function isCredentialRowIn(rows: readonly any[], row: any): boolean {
  if (!row || typeof row.personId !== 'string' || !row.personId) return false;
  const group = rows.filter((u: any) => u && u.personId === row.personId);
  if (group.length === 1) return group[0].id === row.id;
  return row.credentialOwner === true;
}

function isCredentialOrigin(v: unknown): v is CredentialOrigin {
  return typeof v === 'string' && (CREDENTIAL_ORIGINS as readonly string[]).includes(v);
}

function usableEmail(row: any): string {
  return typeof row?.email === 'string' ? normalizeEmail(row.email) : '';
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
      // 10b: credential fields with no writer yet are kept exactly as stored.
      // 10d: on an owner-transfer destination they come from the removed
      // source owner's stored row (joinedAt is a membership field: its own).
      const transferSrcId = opts.ownerTransferIds?.get(row.id);
      const transferSrc = transferSrcId !== undefined ? beforeById.get(transferSrcId) : undefined;
      for (const f of PRESERVED_CREDENTIAL_FIELDS) {
        const from = transferSrc && f !== 'joinedAt' ? transferSrc : prev;
        if (from[f] !== undefined) out[f] = JSON.parse(JSON.stringify(from[f]));
        else delete out[f];
        // 10f: the recovery fields' one writer (credential row only).
        const rw = (f === 'recoveryCodeHashes' || f === 'recoveryFailures') ? opts.recoveryWriteById?.get(row.id) : undefined;
        const key = f === 'recoveryCodeHashes' ? 'codes' : 'failures';
        if (rw && Object.prototype.hasOwnProperty.call(rw, key) && !transferSrc && isCredentialRowIn(beforeUsers, prev)) {
          const v = (rw as any)[key];
          if (v === null || v === undefined) delete out[f];
          else out[f] = JSON.parse(JSON.stringify(v));
          continue;
        }
        if (opts.onViolation && JSON.stringify(row[f]) !== JSON.stringify(out[f])) opts.onViolation(row.id, f);
      }
      if (opts.onViolation && opts.recoveryWriteById?.has(row.id) && (transferSrc || !isCredentialRowIn(beforeUsers, prev)))
        opts.onViolation(row.id, 'recoveryWrite');
      if (opts.newMembership?.has(row.id) && opts.onViolation) opts.onViolation(row.id, 'newMembership');
      // 10i: the first-multi owner marker (see firstMultiOwnerIds).
      if (opts.firstMultiOwnerIds?.has(row.id)) {
        const pid = typeof prev.personId === 'string' ? prev.personId : '';
        const alone = pid !== '' && !(Array.isArray(beforeUsers) ? beforeUsers : []).some((b: any) => b && b.id !== row.id && b.personId === pid);
        const joined = pid !== '' && !!opts.newMembership && Array.from(opts.newMembership.values()).includes(pid);
        if (alone && joined && prev.credentialOwner !== true && isBcrypt(prev.password) && isBcrypt(out.password) && !transferSrc) out.credentialOwner = true;
        else if (opts.onViolation) opts.onViolation(row.id, 'firstMultiOwner');
      }
    } else {
      // 10b: a new row is its own person unless newMembership names an
      // existing person with the same email (10i accept only).
      const joinPid = opts.newMembership?.get(row.id);
      const email = usableEmail(row);
      const joinOk =
        typeof joinPid === 'string' && joinPid !== '' && email !== '' &&
        (Array.isArray(beforeUsers) ? beforeUsers : []).some(
          (b: any) => b && typeof b.id === 'string' && b.personId === joinPid && usableEmail(b) === email
        );
      out.personId = joinOk ? joinPid : row.id;
      if (joinPid !== undefined && !joinOk && opts.onViolation) opts.onViolation(row.id, 'newMembership');
      if (opts.onViolation) for (const f of PRESERVED_CREDENTIAL_FIELDS) if (row[f] !== undefined) opts.onViolation(row.id, f);
    }
    // 10b: credentialOrigin — set only through credentialOriginSetById; an
    // existing row keeps its stored value unless its password changed outside
    // passwordKeepsOriginIds, which drops it (fail closed).
    {
      const before = prev && prev.credentialOrigin !== undefined ? prev.credentialOrigin : undefined;
      let origin: any = before;
      const setTo = opts.credentialOriginSetById?.get(row.id);
      const transferFrom = prev && opts.ownerTransferIds?.has(row.id) ? beforeById.get(opts.ownerTransferIds.get(row.id)!) : undefined;
      if (transferFrom) {
        // 10d: the credential moved with the owner transfer, origin included.
        origin = transferFrom.credentialOrigin !== undefined ? transferFrom.credentialOrigin : undefined;
      } else if (setTo !== undefined) {
        if (isCredentialOrigin(setTo)) origin = setTo;
        else if (opts.onViolation) opts.onViolation(row.id, 'credentialOrigin');
      } else if (prev) {
        const pwChanged = String(prev.password ?? '') !== String(row.password ?? '');
        if (pwChanged && !opts.passwordKeepsOriginIds?.has(row.id)) origin = undefined;
      }
      if (origin !== undefined) out.credentialOrigin = origin;
      else delete out.credentialOrigin;
      if (opts.onViolation && row.credentialOrigin !== undefined && row.credentialOrigin !== before && row.credentialOrigin !== out.credentialOrigin)
        opts.onViolation(row.id, 'credentialOrigin');
      if (opts.onOriginChange && (before ?? null) !== (out.credentialOrigin ?? null))
        opts.onOriginChange(row.id, before ?? null, out.credentialOrigin ?? null);
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
      const set = opts.venueAccessSetById?.get(row.id);
      if (set) out.venueAccess = mergeVenueAccess(out.venueId, set);
      else if (
        prev && prev.personId && prev.venueId === out.venueId && Array.isArray(prev.venueAccess) &&
        // a stored list is home-first; one headed by another venue is stale → reset
        (!out.venueId || prev.venueAccess[0] === out.venueId)
      )
        out.venueAccess = mergeVenueAccess(out.venueId, prev.venueAccess);
      else out.venueAccess = d.venueAccess;
      out.isPrimaryAdmin = d.isPrimaryAdmin;
      if (opts.onViolation && !set && prev && prev.venueId === out.venueId && row.venueAccess !== undefined && JSON.stringify(row.venueAccess) !== JSON.stringify(out.venueAccess))
        opts.onViolation(row.id, 'venueAccess');
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// 10b — identity invariants (plan v4: 10b, C2, C6). Pure; commitState runs it
// on every outcome doc right after enforceIdentityFields, inside the
// transaction and before any write. A refusal aborts the whole commit.
// ---------------------------------------------------------------------------

export type InvariantCode =
  | 'group-created'        // 10b–10h: a new or grown group of 2+ rows (no allowance)
  | 'email-mismatch'       // rows of one person do not share one email
  | 'person-mismatch'      // rows sharing an email do not all carry one personId
  | 'agency-duplicate'     // two rows of one person in one agency
  | 'owner-count'          // a multi person without exactly one credentialOwner row
  | 'owner-no-password'    // the owner row holds no bcrypt password
  | 'non-owner-credential' // a non-owner row holds password/credential fields
  | 'agency-missing';      // a multi-person row whose agency does not exist

export interface InvariantIssue {
  code: InvariantCode;
  /** Row ids only, sorted; never emails or other values. */
  rowIds: string[];
}

export interface InvariantResult {
  /** Issues that refuse this commit. */
  refused: InvariantIssue[];
  /** Issues in groups that were already invalid and unchanged: logged, not blocking. */
  preexisting: InvariantIssue[];
}

export interface InvariantOptions {
  /**
   * 10i only: new row ids the accept transaction attaches to an existing
   * person (the newMembership keys). A grown group is allowed only when every
   * row it gained is in this set and is new in this commit; it must then pass
   * every invariant. Absent (10b–10h) = every new group is refused.
   */
  allowGrowthRowIds?: ReadonlySet<string>;
}

const CREDENTIAL_ONLY_FIELDS = ['credentialOrigin', 'recoveryCodeHashes', 'recoveryFailures'] as const;

function isBcrypt(v: unknown): boolean {
  return typeof v === 'string' && /^\$2[aby]\$\d{2}\$.{53}$/.test(v);
}

function hasPassword(row: any): boolean {
  return typeof row?.password === 'string' && row.password !== '';
}

/** Connected components of rows linked by a shared email or a shared personId. */
export function identityGroups(users: readonly any[]): string[][] {
  const rows = (Array.isArray(users) ? users : []).filter((u: any) => u && typeof u.id === 'string');
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  for (const u of rows) parent.set(u.id, u.id);
  const byKey = new Map<string, string>();
  for (const u of rows) {
    const keys: string[] = [];
    const e = usableEmail(u);
    if (e) keys.push('e:' + e);
    if (typeof u.personId === 'string' && u.personId) keys.push('p:' + u.personId);
    for (const k of keys) {
      const first = byKey.get(k);
      if (first === undefined) byKey.set(k, u.id);
      else union(first, u.id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const u of rows) {
    const r = find(u.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(u.id);
  }
  return [...groups.values()].map((g) => [...new Set(g)].sort());
}

/** The identity-relevant shape of a row, compared to decide "unchanged" (10b checker AND 10d projections: one definition). */
export function identityShape(row: any): string {
  return JSON.stringify([
    usableEmail(row),
    row?.personId ?? null,
    row?.agencyId ?? null,
    row?.credentialOwner ?? null,
    row?.credentialOrigin ?? null,
    row?.password ?? null,
    row?.needsSetup ?? null,
    row?.recoveryCodeHashes ?? null,
  ]);
}

/** The invariants of one group of 2+ rows (pure). */
export function groupIssues(group: readonly any[], agencies: readonly any[]): InvariantIssue[] {
  const ids = group.map((r) => r.id).sort();
  const issues: InvariantIssue[] = [];
  const push = (code: InvariantCode, rowIds: string[] = ids) => issues.push({ code, rowIds: [...rowIds].sort() });
  // (i) one email and one personId for the whole group
  const emails = new Set(group.map((r) => usableEmail(r)));
  if (emails.size !== 1 || emails.has('')) push('email-mismatch');
  const pids = new Set(group.map((r) => (typeof r.personId === 'string' && r.personId ? r.personId : '')));
  if (pids.size !== 1 || pids.has('')) push('person-mismatch');
  // (ii) (personId, agencyId) unique
  const seen = new Map<string, string>();
  for (const r of group) {
    const k = `${r.personId ?? ''}|${r.agencyId ?? ''}`;
    const other = seen.get(k);
    if (other !== undefined) push('agency-duplicate', [other, r.id]);
    else seen.set(k, r.id);
  }
  // (iii) exactly one credentialOwner, with a bcrypt password; nobody else holds a credential
  const owners = group.filter((r) => r.credentialOwner === true);
  if (owners.length !== 1) push('owner-count');
  for (const o of owners) if (!isBcrypt(o.password)) push('owner-no-password', [o.id]);
  for (const r of group) {
    if (r.credentialOwner === true) continue;
    if (hasPassword(r) || CREDENTIAL_ONLY_FIELDS.some((f) => r[f] !== undefined)) push('non-owner-credential', [r.id]);
  }
  // (iv) every row's agency exists
  const agencyIds = new Set((Array.isArray(agencies) ? agencies : []).filter((a: any) => a && typeof a.id === 'string').map((a: any) => a.id));
  const missing = group.filter((r) => !agencyIds.has(r.agencyId || 'agency-hkc')).map((r) => r.id);
  if (missing.length) push('agency-missing', missing);
  return issues;
}

/**
 * The checker (plan v4 C2). Groups = rows linked by a shared email or a
 * shared personId; a group of one row is never evaluated.
 * - A group that is NEW or GREW (not contained in one group of the stored
 *   doc) is refused ('group-created') unless options.allowGrowthRowIds covers
 *   every row it gained AND it passes every invariant (10i only).
 * - A group contained in a stored group (unchanged or shrunk) is evaluated
 *   only when at least one of its rows carries personId (legacy rows without
 *   personId are never evaluated). Invalid + identical to a stored group with
 *   the same identity fields = preexisting (logged, never blocking); any
 *   other invalid result is refused.
 * Returns row ids and codes only.
 */
export function checkMembershipInvariants(
  beforeUsers: readonly any[],
  afterUsers: readonly any[],
  afterAgencies: readonly any[],
  options: InvariantOptions = {}
): InvariantResult {
  const before = (Array.isArray(beforeUsers) ? beforeUsers : []).filter((u: any) => u && typeof u.id === 'string');
  const after = (Array.isArray(afterUsers) ? afterUsers : []).filter((u: any) => u && typeof u.id === 'string');
  const beforeById = new Map<string, any>(before.map((u: any) => [u.id, u]));
  const afterById = new Map<string, any>(after.map((u: any) => [u.id, u]));
  const beforeGroupOf = new Map<string, string[]>();
  for (const g of identityGroups(before)) for (const id of g) beforeGroupOf.set(id, g);
  const refused: InvariantIssue[] = [];
  const preexisting: InvariantIssue[] = [];
  for (const g of identityGroups(after)) {
    if (g.length < 2) continue;
    const rows = g.map((id) => afterById.get(id));
    // The stored group that contains every stored member of g (if one does).
    const stored = g.filter((id) => beforeGroupOf.has(id));
    const homes = new Set(stored.map((id) => beforeGroupOf.get(id)!.join('\u0000')));
    const home = homes.size === 1 ? beforeGroupOf.get(stored[0])! : null;
    const gained = home ? g.filter((id) => !home.includes(id)) : g;
    if (gained.length > 0) {
      const allow = options.allowGrowthRowIds;
      const allowed = !!allow && home !== null && gained.every((id) => allow.has(id) && !beforeById.has(id));
      if (!allowed) { refused.push({ code: 'group-created', rowIds: g }); continue; }
      refused.push(...groupIssues(rows, afterAgencies));
      continue;
    }
    if (!rows.some((r) => typeof r.personId === 'string' && r.personId)) continue;
    const issues = groupIssues(rows, afterAgencies);
    if (!issues.length) continue;
    const unchanged =
      home !== null && home.length === g.length &&
      g.every((id) => identityShape(beforeById.get(id)) === identityShape(afterById.get(id)));
    (unchanged ? preexisting : refused).push(...issues);
  }
  return { refused, preexisting };
}

/**
 * Item 10c (A1/A2/A4): may a LEGACY subscription (no userId, keyed by email
 * alone) be attributed to the one row holding that email? Only when EXACTLY
 * ONE row in the complete users list (all agencies) has it. With two
 * memberships of one person the legacy record is ambiguous and is ignored
 * (never delivered to, never removed) — it can never cross agencies.
 */
export function legacyPushSubIsUnambiguous(email: unknown, usersList: any[]): boolean {
  if (typeof email !== 'string' || !email.trim()) return false;
  const want = email.trim().toLowerCase();
  let n = 0;
  for (const u of usersList || []) {
    if (u && typeof u.email === 'string' && u.email.trim().toLowerCase() === want) n++;
    if (n > 1) return false;
  }
  return n === 1;
}
export function isLegacyPushSub(s: any): boolean {
  return !!s && !s.userId;
}

// ---------------------------------------------------------------------------
// 10d — projections from whole person groups + owner transfer (plan v4 10d,
// "Agreed — 10d design v2"). Pure: no I/O, no logging, never throws.
// ---------------------------------------------------------------------------

export type ProjectionProblemCode = 'no-valid-owner' | 'email-shared';
export interface ProjectionProblem {
  code: ProjectionProblemCode;
  /** Sorted row ids of the group (never emails). */
  rowIds: string[];
  personId?: string;
  /** normalized email (only inside the server; never put in a payload or log). */
  email?: string;
  issues?: InvariantCode[];
}
export interface PersonProjection {
  personId: string;
  ownerRowId: string;
  name: string;
  primaryEmail: string;
  rowIds: string[];
}
export interface IdentityProjection {
  /** personId → projection from the owner row (valid persons only). */
  persons: Map<string, PersonProjection>;
  /** every personId that has at least one row (valid or not). */
  personIdsWithRows: Set<string>;
  /** emailKey → personId (valid persons, unshared emails). */
  emailPerson: Map<string, string>;
  /** normalized email → the row id usersByEmail points at (owner row; legacy row = itself). */
  lookup: Map<string, string>;
  problems: ProjectionProblem[];
}

/**
 * The ONE projection function (dualwrite before/after, consistency check,
 * migration verify). A person = the rows sharing a personId. One row → that
 * row is the owner. Two or more → the single credentialOwner row, ONLY when
 * the group passes every invariant; otherwise 'no-valid-owner' and no
 * projection (no smallest-id fallback). Rows without personId (legacy) map
 * their own email → own id. An email used by two identities (two persons, or
 * a person and a legacy row, or two legacy rows) → 'email-shared', unmapped.
 */
export function identityProjection(usersIn: readonly any[], agencies: readonly any[]): IdentityProjection {
  const users = (Array.isArray(usersIn) ? usersIn : []).filter((u: any) => u && typeof u.id === 'string');
  const persons = new Map<string, PersonProjection>();
  const personIdsWithRows = new Set<string>();
  const emailPerson = new Map<string, string>();
  const lookup = new Map<string, string>();
  const problems: ProjectionProblem[] = [];
  const byPerson = new Map<string, any[]>();
  for (const u of users) {
    if (typeof u.personId === 'string' && u.personId) {
      personIdsWithRows.add(u.personId);
      if (!byPerson.has(u.personId)) byPerson.set(u.personId, []);
      byPerson.get(u.personId)!.push(u);
    }
  }
  // identity per normalized email: personId, or "legacy:<rowId>" for rows without one
  const identitiesByEmail = new Map<string, Map<string, string[]>>();
  for (const u of users) {
    const e = usableEmail(u);
    if (!e) continue;
    const ident = typeof u.personId === 'string' && u.personId ? `p:${u.personId}` : `l:${u.id}`;
    if (!identitiesByEmail.has(e)) identitiesByEmail.set(e, new Map());
    const m = identitiesByEmail.get(e)!;
    if (!m.has(ident)) m.set(ident, []);
    m.get(ident)!.push(u.id);
  }
  const sharedEmails = new Set<string>();
  for (const [e, m] of identitiesByEmail) {
    if (m.size > 1) {
      sharedEmails.add(e);
      problems.push({ code: 'email-shared', email: e, rowIds: [...m.values()].flat().sort() });
    }
  }
  for (const [pid, rows] of byPerson) {
    const rowIds = rows.map((r) => r.id).sort();
    let owner: any = null;
    if (rows.length === 1) owner = rows[0];
    else {
      const issues = groupIssues(rows, agencies);
      if (issues.length) {
        problems.push({ code: 'no-valid-owner', personId: pid, rowIds, issues: [...new Set(issues.map((i) => i.code))].sort() as InvariantCode[] });
        continue;
      }
      owner = rows.find((r) => r.credentialOwner === true) || null;
      if (!owner) { problems.push({ code: 'no-valid-owner', personId: pid, rowIds, issues: ['owner-count'] }); continue; }
    }
    const primaryEmail = usableEmail(owner);
    persons.set(pid, { personId: pid, ownerRowId: owner.id, name: typeof owner.name === 'string' ? owner.name : '', primaryEmail, rowIds });
    if (primaryEmail && !sharedEmails.has(primaryEmail)) {
      emailPerson.set(emailKey(primaryEmail), pid);
      lookup.set(primaryEmail, owner.id);
    }
  }
  for (const u of users) {
    if (typeof u.personId === 'string' && u.personId) continue;
    const e = usableEmail(u);
    if (e && !sharedEmails.has(e)) lookup.set(e, u.id);
  }
  return { persons, personIdsWithRows, emailPerson, lookup, problems };
}

/** A stable signature of a projection problem's rows (ids + identity shapes). */
export function problemSignature(p: ProjectionProblem, users: readonly any[]): string {
  const byId = new Map<string, any>((Array.isArray(users) ? users : []).filter((u: any) => u && typeof u.id === 'string').map((u: any) => [u.id, u]));
  return JSON.stringify([p.code, p.personId ?? null, p.email ?? null, p.rowIds, p.rowIds.map((id) => identityShape(byId.get(id)))]);
}

/**
 * 10d B2: problems in `after` that were NOT present, identically, in `before`
 * (same code, same rows, same identity shape of every row). Those must abort
 * the commit; the rest are untouched stored problems (tolerated, not written).
 */
export function newProjectionProblems(before: IdentityProjection, beforeUsers: readonly any[], after: IdentityProjection, afterUsers: readonly any[]): { fresh: ProjectionProblem[]; tolerated: ProjectionProblem[] } {
  const stored = new Set(before.problems.map((p) => problemSignature(p, beforeUsers)));
  const fresh: ProjectionProblem[] = [];
  const tolerated: ProjectionProblem[] = [];
  for (const p of after.problems) (stored.has(problemSignature(p, afterUsers)) ? tolerated : fresh).push(p);
  return { fresh, tolerated };
}

/** M4: the successor owner — earliest joinedAt (missing = earliest), tie → smallest id. */
export function m4Successor(rows: readonly any[]): any | null {
  const list = (Array.isArray(rows) ? rows : []).filter((r: any) => r && typeof r.id === 'string');
  if (!list.length) return null;
  const t = (r: any) => {
    const ms = typeof r.joinedAt === 'string' ? Date.parse(r.joinedAt) : NaN;
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return [...list].sort((a, b) => (t(a) - t(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** The credential fields that move with an owner transfer (membership fields never move). */
export const OWNER_TRANSFER_FIELDS = ['password', 'credentialOwner', 'credentialOrigin', 'recoveryCodeHashes', 'recoveryFailures'] as const;

export interface OwnerTransfer { fromId: string; toId: string }
export type OwnerTransferResult = { ok: true; users: any[]; transferIds?: Map<string, string> } | { ok: false; reason: string };

/**
 * 10d B1: validate + apply an owner transfer, and refuse an owner removal
 * that has none. Runs in commitState BEFORE enforceIdentityFields, on the
 * fresh stored users (before) and the mutator's output (after). Aborts
 * (ok:false) unless every condition of the agreed design holds. The
 * credential fields are COPIED from the fresh source row; any destination
 * value the mutator supplied is overwritten.
 */
export function applyOwnerTransfer(beforeUsersIn: readonly any[], afterUsersIn: readonly any[], agencies: readonly any[], transfer: OwnerTransfer | null | undefined): OwnerTransferResult {
  const before = (Array.isArray(beforeUsersIn) ? beforeUsersIn : []).filter((u: any) => u && typeof u.id === 'string');
  const afterArr = Array.isArray(afterUsersIn) ? afterUsersIn : [];
  const beforeById = new Map<string, any>(before.map((u: any) => [u.id, u]));
  const afterIds = new Set<string>(afterArr.filter((u: any) => u && typeof u.id === 'string').map((u: any) => u.id));
  // Owners of multi-row persons removed in this commit.
  const removedOwners: any[] = [];
  const rowsOf = (pid: string) => before.filter((u: any) => u.personId === pid);
  for (const u of before) {
    if (u.credentialOwner !== true || afterIds.has(u.id) || typeof u.personId !== 'string' || !u.personId) continue;
    const survivors = rowsOf(u.personId).filter((r: any) => r.id !== u.id && afterIds.has(r.id));
    if (survivors.length) removedOwners.push(u);
  }
  const t = transfer && typeof transfer === 'object' && typeof transfer.fromId === 'string' && typeof transfer.toId === 'string' ? transfer : null;
  if (!t) {
    if (removedOwners.length) return { ok: false, reason: 'owner-removed-without-transfer' };
    return { ok: true, users: afterArr as any[] };
  }
  if (removedOwners.length !== 1 || removedOwners[0].id !== t.fromId) return { ok: false, reason: 'transfer-source-mismatch' };
  const src = beforeById.get(t.fromId);
  const dst = beforeById.get(t.toId);
  if (!src || afterIds.has(t.fromId)) return { ok: false, reason: 'transfer-source-not-removed' };
  if (!dst || !afterIds.has(t.toId)) return { ok: false, reason: 'transfer-destination-missing' };
  const pid = src.personId;
  if (dst.personId !== pid || dst.credentialOwner === true) return { ok: false, reason: 'transfer-destination-invalid' };
  const group = rowsOf(pid);
  if (group.length < 2 || groupIssues(group, agencies).length) return { ok: false, reason: 'transfer-source-group-invalid' };
  if (!isBcrypt(src.password)) return { ok: false, reason: 'transfer-source-no-password' };
  const successor = m4Successor(group.filter((r: any) => r.id !== src.id && afterIds.has(r.id)));
  if (!successor || successor.id !== dst.id) return { ok: false, reason: 'transfer-not-m4-successor' };
  const users = afterArr.map((row: any) => {
    if (!row || row.id !== dst.id) return row;
    const out: any = { ...row };
    for (const f of OWNER_TRANSFER_FIELDS) {
      if (src[f] !== undefined) out[f] = JSON.parse(JSON.stringify(src[f]));
      else delete out[f];
    }
    out.credentialOwner = true;
    return out;
  });
  // The surviving rows of the person must be valid after the step (explicit
  // for ONE survivor: the checker skips single-row groups).
  const survivors = users.filter((r: any) => r && r.personId === pid);
  if (survivors.length === 1) {
    const s = survivors[0];
    if (s.credentialOwner !== true || !isBcrypt(s.password)) return { ok: false, reason: 'transfer-survivor-invalid' };
  } else if (groupIssues(survivors, agencies).length) {
    return { ok: false, reason: 'transfer-survivors-invalid' };
  }
  return { ok: true, users, transferIds: new Map([[dst.id, src.id]]) };
}
