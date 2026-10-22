import type { KosherEvent } from '../types';

/**
 * Don 2026-10-22: the admin's agency-wide Events screen.
 * Order: upcoming first (soonest first), then past events (most recent first).
 * "New" = created after the admin last opened the screen (kept on this device).
 */
export function sortAgencyEvents(list: KosherEvent[], todayYmd: string): KosherEvent[] {
  const upcoming = list.filter((e) => (e.endDate || e.date) >= todayYmd).sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));
  const past = list.filter((e) => (e.endDate || e.date) < todayYmd).sort((a, b) => b.date.localeCompare(a.date));
  return [...upcoming, ...past];
}

export const eventsSeenKey = (email: string | undefined | null) => `shutfey_agency_events_seen:${(email || '').toLowerCase()}`;

export function isNewEvent(e: Pick<KosherEvent, 'createdAt'>, seenAtIso: string | null): boolean {
  if (!seenAtIso) return false; // first visit: nothing is "new" yet
  return typeof e.createdAt === 'string' && e.createdAt > seenAtIso;
}

export function eventAssigneeText(e: KosherEvent): string {
  if (e.mashgiachType === 'assigned_user' && e.assignedMashgiachName) return e.assignedMashgiachName;
  if (e.mashgiachType === 'external' && e.externalMashgiach && (e.externalMashgiach as any).name) return `${(e.externalMashgiach as any).name} (outside)`;
  return 'No mashgiach yet';
}

export const EVENT_STATUS_TEXT: Record<KosherEvent['status'], string> = {
  pending_review: 'Waiting for review',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed: 'Done',
  cancelled: 'Cancelled',
};
