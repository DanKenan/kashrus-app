import type { User } from '../types';

/**
 * ADMINVENUE: the venue a realtime payload must be narrowed to on this screen,
 * or null when the list is left as the server sent it.
 *
 * The REST loaders ask for one venue (?venueId=…) and the server answers only
 * that venue's tasks/events/history. The socket's bulk payloads (INITIAL_STATE,
 * DAILY_RESET, HISTORY_PRUNED, DEMO_RESTORED) and single-record events carry
 * everything the recipient may see — for an agency admin that is the whole
 * agency — so the client narrows them to the venue on screen.
 *
 * - admin: the selected venue (null only when no venue is picked yet).
 * - anyone else: the selected venue when they work at 2+ venues (the server
 *   already scopes a one-venue person; their list stays as sent).
 */
export function socketVenueScope(
  user: Pick<User, 'role'> | null | undefined,
  selectedVenueId: string | null | undefined,
  staffHasSeveralVenues: boolean,
): string | null {
  if (!user || !selectedVenueId) return null;
  if (user.role === 'admin') return selectedVenueId;
  return staffHasSeveralVenues ? selectedVenueId : null;
}

/** Keep only the records of the scoped venue; a record with no venueId is never kept when scoped. */
export function scopeListToVenue<T extends { venueId?: string | null }>(list: T[], scope: string | null): T[] {
  if (!scope) return list;
  return list.filter((item) => !!item && item.venueId === scope);
}

/** Whether one record belongs on the scoped screen (no scope = yes; missing venueId = no). */
export function inVenueScope(item: { venueId?: string | null } | null | undefined, scope: string | null): boolean {
  if (!scope) return true;
  return !!item && item.venueId === scope;
}
