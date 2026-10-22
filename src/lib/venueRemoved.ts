/**
 * QA2 #8 — a venue owner or staff member whose venue was deleted.
 *
 * The server refuses such a sign-in with 403 code VENUE_REMOVED (Tab lane).
 * Until then (and for a session that is still open), the client never shows
 * the admin's "Establish First Kosher Venue" screen to anyone but an admin:
 * a non-admin with no venue sees one plain message and a Sign out button.
 */
export const VENUE_REMOVED_TEXT = 'Your venue was removed. Contact your agency.';
export const NO_VENUE_TEXT = "You aren't added to a venue yet. Contact your agency.";

/** The sign-in error to show, preferring our plain words for VENUE_REMOVED. */
export function signInErrorText(data: { error?: unknown; code?: unknown } | null | undefined, fallback: string): string {
  if (data && data.code === 'VENUE_REMOVED') return VENUE_REMOVED_TEXT;
  return data && typeof data.error === 'string' && data.error.trim() ? data.error : fallback;
}

/** What a signed-in person with no venue in view should see (null = an admin: the setup screen). */
export function noVenueMessage(user: { role?: string; venueId?: string | null; venueIds?: string[] | null } | null | undefined): string | null {
  if (!user || user.role === 'admin') return null;
  const hadVenue = !!user.venueId || (Array.isArray(user.venueIds) && user.venueIds.length > 0);
  return hadVenue ? VENUE_REMOVED_TEXT : NO_VENUE_TEXT;
}
