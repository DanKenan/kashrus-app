// QA2 #9 (Don 2026-10-22): who may create, edit, copy and delete events. This is the
// client mirror of the server's mayManageEventAt (src/server/venue-scope.ts, rule T,
// fail closed). The server decides; this only hides buttons it would refuse.
//
// The client never holds a person's raw venue grants (personId / venueAccess are
// server-only). What it does hold is the venue list from GET /api/venues, which the
// server already cuts to exactly the caller's scope: for an admin, every current venue
// of the own agency; for anyone else, venueScope(caller) intersected with the agency's
// current venues (a stale or foreign grant never appears). So:
//   the venue must be in that list and belong to the person's agency; then
//   admin: any such venue;
//   coordinator: any such venue (the list IS their scope);
//   owner and manager (same style, server #169): their own home venue only (extra venues never widen it);
//   everyone else (mashgiach, worker, unknown, kiosk): never.
import type { User, Venue } from '../types';

type EventUser = Pick<User, 'role' | 'venueId'> & { agencyId?: string; permissions?: User['permissions'] };
type VenueRef = Pick<Venue, 'id'> & { agencyId?: string };

const DEFAULT_AGENCY = 'agency-hkc';
const agencyOf = (x: { agencyId?: string } | null | undefined) =>
  (x && typeof x.agencyId === 'string' && x.agencyId) || DEFAULT_AGENCY;

/** Venue ids of `venues` that belong to the person's agency. */
function ownVenueIds(user: EventUser, venues: readonly VenueRef[] | null | undefined): Set<string> {
  const out = new Set<string>();
  const agency = agencyOf(user);
  for (const v of Array.isArray(venues) ? venues : []) {
    if (v && typeof v.id === 'string' && v.id && agencyOf(v) === agency) out.add(v.id);
  }
  return out;
}

export function mayManageEventAt(
  user: EventUser | null | undefined,
  venueId: string | null | undefined,
  venues: readonly VenueRef[] | null | undefined,
): boolean {
  if (!user || typeof user.role !== 'string' || typeof venueId !== 'string' || !venueId) return false;
  if (!ownVenueIds(user, venues).has(venueId)) return false;
  if (user.role === 'admin' || user.role === 'coordinator') return true;
  if (user.role === 'owner' || user.role === 'manager') return typeof user.venueId === 'string' && user.venueId === venueId;
  return false;
}

/** May this person create an event at some venue they hold? */
export function mayCreateEvents(
  user: EventUser | null | undefined,
  venues: readonly VenueRef[] | null | undefined,
): boolean {
  if (!user) return false;
  for (const id of ownVenueIds(user, venues)) if (mayManageEventAt(user, id, venues)) return true;
  return false;
}

/**
 * EVENTEDIT (Don, Oct 28 2026): may this person change an event task's wording
 * (its title and details)? The client mirror of the server's
 * mayEditEventTaskWording; the server decides. The people who may edit an
 * ordinary task at that venue:
 *   whoever may manage the event (above); or
 *   someone who may edit task definitions (admin, coordinator, or "can assign
 *   tasks" granted) when the event's venue is one of their own (the venue list
 *   is already cut to their scope by the server).
 * Everyone else (and a kiosk, whose acting user never gets here) never.
 */
export function mayEditEventTaskWording(
  user: EventUser | null | undefined,
  event: ({ venueId?: string | null } & { agencyId?: string }) | null | undefined,
  venues: readonly VenueRef[] | null | undefined,
): boolean {
  if (!user || !event || typeof user.role !== 'string') return false;
  const venueId = typeof event.venueId === 'string' ? event.venueId : '';
  if (!venueId) return false;
  if (event.agencyId && agencyOf(event) !== agencyOf(user)) return false;
  // RV4: the event's venue must exist in the list and be the caller's agency's.
  const venueRow = (venues || []).find((v) => v && v.id === venueId);
  if (!venueRow || agencyOf(venueRow as any) !== agencyOf(user)) return false;
  if (mayManageEventAt(user, venueId, venues)) return true;
  const editsTaskDefinitions =
    user.role === 'admin' || user.role === 'coordinator' || user.permissions?.canAssignTasks === true;
  return editsTaskDefinitions && ownVenueIds(user, venues).has(venueId);
}
