/**
 * Item 9a ("9a plan v2"): one person, several venues of ONE agency.
 * Pure helpers; server.ts passes the CURRENT venues on every call.
 *
 * Fail closed: an empty, malformed or foreign list never means "all venues".
 * Scope = the home venue (unless it is an existing venue of ANOTHER agency) +
 * venueAccess ∩ venues whose CURRENT agencyId is the person's agency.
 * Unmigrated rows: home only.
 */
export type VenueLite = { id: string; agencyId?: string };
export type ScopeUser = { role?: string; agencyId?: string; venueId?: string; personId?: string; venueAccess?: unknown };

const DEFAULT_AGENCY = 'agency-hkc';
const agencyOf = (x: { agencyId?: string } | undefined) => (x && typeof x.agencyId === 'string' && x.agencyId) || DEFAULT_AGENCY;

/** Venue ids that currently belong to `agencyId`. */
export function agencyVenueIds(venues: readonly VenueLite[], agencyId: string): Set<string> {
  const out = new Set<string>();
  for (const v of venues || []) if (v && typeof v.id === 'string' && v.id && agencyOf(v) === agencyId) out.add(v.id);
  return out;
}

/**
 * Sanitize a stored or requested list: strings only, de-duplicated, each a
 * current venue of the agency, home venue (if valid) first and always kept.
 */
export function sanitizeVenueAccess(list: unknown, homeVenueId: unknown, valid: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const add = (x: unknown) => { if (typeof x === 'string' && x && valid.has(x) && !out.includes(x)) out.push(x); };
  add(homeVenueId);
  if (Array.isArray(list)) for (const x of list) add(x);
  return out;
}

/** Non-admin venue scope; admins are 'agency'. Unmigrated rows: home venue only. */
export function venueScope(user: ScopeUser | null | undefined, venues: readonly VenueLite[]): 'agency' | string[] {
  if (!user || typeof user.role !== 'string') return [];
  if (user.role === 'admin') return 'agency';
  // The home venue keeps its pre-9a meaning (rule T: [venueId]) with one
  // tenant check: a home venue that EXISTS and belongs to another agency is
  // excluded. A dangling home id (venue deleted) stays, as before 9a — it
  // names no venue, so it grants nothing.
  const agency = agencyOf(user);
  const valid = agencyVenueIds(venues, agency);
  let home = typeof user.venueId === 'string' && user.venueId ? user.venueId : null;
  if (home && !valid.has(home) && (venues || []).some((v) => v && v.id === home)) home = null;
  const out = home ? [home] : [];
  if (!user.personId || !Array.isArray(user.venueAccess)) return out;
  // A stored list is written home-first for the home it was granted under
  // (identity.ts). A list whose head is not the current home is stale (written
  // for another home, e.g. by a raw write) and grants nothing extra.
  if (typeof user.venueId === 'string' && user.venueId && user.venueAccess[0] !== user.venueId) return out;
  // Extra venues: only server-granted ids of venues the person's agency owns NOW.
  for (const x of user.venueAccess) if (typeof x === 'string' && x && valid.has(x) && !out.includes(x)) out.push(x);
  return out;
}

/**
 * QA2S2 #9 (Don 2026-10-22): who may create, copy, edit the definition of,
 * delete or notify an event at `venueId` (rule T, fail closed). The venue must
 * be an EXISTING venue of the person's own agency; then
 *   admin       -> any such venue;
 *   coordinator -> a venue in their scope (home + server-granted venueAccess);
 *   owner       -> their own home venue only (venueAccess never widens it);
 *   anyone else (mashgiach, worker, unknown or missing role) -> false.
 * Callers pass the CURRENT venues (fresh venues inside a commit).
 */
export function mayManageEventAt(user: ScopeUser | null | undefined, venueId: unknown, venues: readonly VenueLite[]): boolean {
  if (!user || typeof user.role !== 'string' || typeof venueId !== 'string' || !venueId) return false;
  if (!agencyVenueIds(venues, agencyOf(user)).has(venueId)) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'coordinator') {
    const scope = venueScope(user, venues);
    return scope !== 'agency' && scope.includes(venueId);
  }
  if (user.role === 'owner') return typeof user.venueId === 'string' && user.venueId === venueId;
  return false;
}

/**
 * Which venue a venue-taking request targets.
 * requested in scope -> it; requested outside -> forbidden; none -> home (if valid) else null.
 */
export function resolveTargetVenue(
  user: ScopeUser | null | undefined,
  venues: readonly VenueLite[],
  requested: unknown
): { ok: true; venueId: string | null } | { ok: false } {
  const scope = venueScope(user, venues);
  const req = typeof requested === 'string' && requested ? requested : null;
  if (scope === 'agency') {
    if (!req) return { ok: true, venueId: null };
    return agencyVenueIds(venues, agencyOf(user!)).has(req) ? { ok: true, venueId: req } : { ok: false };
  }
  if (req) return scope.includes(req) ? { ok: true, venueId: req } : { ok: false };
  const home = typeof user?.venueId === 'string' && scope.includes(user.venueId) ? user.venueId : null;
  return { ok: true, venueId: home };
}

/** Venues two non-admin people actually share (coordinator management). */
export function sharedVenues(a: ScopeUser, b: ScopeUser, venues: readonly VenueLite[]): string[] {
  const sa = venueScope(a, venues), sb = venueScope(b, venues);
  if (sa === 'agency' || sb === 'agency') return [];
  if (agencyOf(a) !== agencyOf(b)) return [];
  return sa.filter((x) => sb.includes(x));
}
