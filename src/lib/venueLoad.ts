/**
 * NOVENUE (Don, Nov 2 2026): a mashgiach whose main venue was changed while
 * the app was open saw "Your venue was removed" until he reopened the app.
 * The phone took the new scope (SCOPE_CHANGED) while it still held the old
 * venue list, and nothing loaded the new list. A failed first load of the
 * list showed the same screen, with no retry.
 *
 * The venue list is "loaded" for one scope: the person, their role and (on a
 * server that sends it) their own venueRev and venue ids. Until the list was
 * delivered for the CURRENT scope, a non-admin sees a loading line instead of
 * the no-venue screen, and the list is fetched again.
 */
type ScopeUser = { id?: string; role?: string; myVenueRev?: number; myVenueIds?: string[] } | null | undefined;

/** The key of the scope a venue list is delivered for ('' = nobody signed in). */
export function venueListKey(user: ScopeUser): string {
  if (!user || typeof user.id !== 'string') return '';
  if (user.role === 'admin') return JSON.stringify([user.id, 'admin']);
  const rev = typeof user.myVenueRev === 'number' ? user.myVenueRev : null;
  const ids = Array.isArray(user.myVenueIds) ? [...user.myVenueIds].sort() : null;
  return JSON.stringify([user.id, user.role ?? null, rev, ids]);
}

/** The same key for a scope the server just delivered with its list (INITIAL_STATE). */
export function deliveredVenueListKey(user: ScopeUser, myVenueRev: unknown, venueIds: string[]): string {
  if (!user) return '';
  return venueListKey({ ...user, myVenueRev: typeof myVenueRev === 'number' && Number.isInteger(myVenueRev) ? myVenueRev : user.myVenueRev, myVenueIds: venueIds });
}

/** A non-admin phone whose venue list was not yet delivered for the current scope. */
export function venueListPending(user: ScopeUser, isKiosk: boolean, loadedKey: string | null): boolean {
  if (!user || isKiosk || user.role === 'admin') return false;
  return loadedKey !== venueListKey(user);
}

/** A venue-list request that has not answered by then is abandoned and retried. */
export const VENUE_LOAD_TIMEOUT_MS = 15000;

/** Wait before the next try after `failures` failed loads in a row: 2 s, 4 s, 8 s, ... up to 30 s. */
export function venueRetryDelayMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(30000, 2000 * 2 ** (n - 1));
}
