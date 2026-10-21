import type { User, Venue } from '../types';

export function venueStorageKey(user: User): string {
  return user.role === 'admin' ? 'selected_venue_id' : `selected_venue_id:${user.id}`;
}

export function eligibleVenuesFor(user: User | null, venues: Venue[]): Venue[] {
  if (!user || user.role === 'admin') return [];
  const ids = (user as User & { myVenueIds?: string[] }).myVenueIds;
  return ids ? venues.filter((venue) => ids.includes(venue.id)) : venues;
}

export function resolveVenue(user: User | null, eligible: Venue[], savedId: string | null): Venue | null {
  if (!user) return null;
  return eligible.find((venue) => venue.id === savedId)
    || eligible.find((venue) => venue.id === user.venueId)
    || eligible[0] || null;
}

export function filterToVenue<T extends { venueId?: string }>(list: T[], venueId: string | null | undefined): T[] {
  return list.filter((item) => item.venueId === venueId);
}
