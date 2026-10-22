import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Building2, CalendarDays, Clock, Plus, User as UserIcon } from 'lucide-react';
import type { KosherEvent, User, Venue } from '../types';
import { apiFetch } from '../lib/api';
import { formatWorkDate } from '../lib/dateText';
import { formatTimeRange } from '../lib/clockTime';
import { workDateIn } from '../lib/workday';
import { EVENT_STATUS_TEXT, eventAssigneeText, eventsSeenKey, isNewEvent, sortAgencyEvents } from '../lib/agencyEvents';

/**
 * Don 2026-10-22: from the agency dashboard, one screen with every event in
 * the agency (all venues): venue, date/time, mashgiach, status; upcoming first;
 * "New" on events created since the admin last opened this screen.
 * "+ New event" asks for the venue first, then opens the normal event form.
 */
interface AgencyEventsScreenProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User | null;
  venues: Venue[];
  timeZone: string;
  reloadKey?: number;
  onCreateForVenue: (venueId: string) => void;
}

export const AgencyEventsScreen: React.FC<AgencyEventsScreenProps> = ({ isOpen, onClose, currentUser, venues, timeZone, reloadKey = 0, onCreateForVenue }) => {
  const [events, setEvents] = useState<KosherEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [pickVenue, setPickVenue] = useState(false);

  // Remember when the admin last looked; "New" is measured against the visit before this one.
  useEffect(() => {
    if (!isOpen) return;
    const key = eventsSeenKey(currentUser?.email);
    let prev: string | null = null;
    try { prev = localStorage.getItem(key); localStorage.setItem(key, new Date().toISOString()); } catch { /* private mode */ }
    setSeenAt(prev);
    setPickVenue(false);
  }, [isOpen, currentUser?.email]);

  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    setFailed(false);
    apiFetch('/api/events?venueId=all')
      .then((r) => r.json())
      .then((d) => { if (live) setEvents(Array.isArray(d?.events) ? d.events : []); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [isOpen, reloadKey]);

  const today = workDateIn(timeZone);
  const list = useMemo(() => sortAgencyEvents(events || [], today), [events, today]);
  const venueName = (e: KosherEvent) => venues.find((v) => v.id === e.venueId)?.name || e.venueName || 'Venue';
  const firstPast = list.findIndex((e) => (e.endDate || e.date) < today);

  if (!isOpen) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Agency events" className="fixed inset-0 z-50 bg-paper overflow-y-auto" data-agency-events>
      <div className="max-w-2xl mx-auto px-4 pt-3 pb-24 space-y-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={pickVenue ? () => setPickVenue(false) : onClose} aria-label={pickVenue ? 'Back to events' : 'Back to dashboard'}
            className="pressable w-11 h-11 flex items-center justify-center rounded-xl bg-surface border border-line-control text-ink cursor-pointer shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-xl font-bold flex-1 min-w-0">{pickVenue ? 'Which venue?' : 'Events'}</h2>
          {!pickVenue && (
            <button type="button" onClick={() => setPickVenue(true)}
              className="pressable min-h-11 inline-flex items-center gap-1.5 px-3 rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white text-sm font-bold tactile-1 cursor-pointer shrink-0">
              <Plus aria-hidden="true" className="w-4 h-4 stroke-[2.5]" />
              <span>New event</span>
            </button>
          )}
        </div>

        {pickVenue ? (
          <ul className="space-y-2" aria-label="Pick the venue for the new event">
            {venues.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => onCreateForVenue(v.id)}
                  className="pressable w-full min-h-11 flex items-center gap-2 px-3 py-3 rounded-xl bg-surface border border-line text-left text-base font-semibold text-ink hover:bg-sunken cursor-pointer">
                  <Building2 aria-hidden="true" className="w-4 h-4 text-gold-deep shrink-0" />
                  <span className="min-w-0 break-words">{v.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : failed ? (
          <p role="alert" className="text-base text-bad">Couldn't load events. Try again in a moment.</p>
        ) : events === null ? (
          <p className="text-base text-ink-soft">Loading events…</p>
        ) : list.length === 0 ? (
          <div className="p-6 rounded-xl bg-surface border border-line text-center">
            <p className="text-base font-semibold">No events yet</p>
            <p className="text-sm text-ink-soft mt-1">Tap “New event” to add one.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {list.map((e, i) => {
              const fresh = isNewEvent(e, seenAt);
              const times = formatTimeRange(e.startTime, e.endTime);
              return (
                <React.Fragment key={e.id}>
                  {i === firstPast && <li className="pt-2 text-xs font-bold uppercase tracking-wider text-ink-faint">Past events</li>}
                  <li data-event-id={e.id} className={`p-3 rounded-xl bg-surface border ${fresh ? 'border-gold' : 'border-line'} space-y-1.5`}>
                    <div className="flex items-start gap-2">
                      <span className="flex-1 min-w-0 text-base font-bold break-words">{e.title}</span>
                      {fresh && <span data-new-badge className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-black uppercase tracking-wider bg-gold text-white">New</span>}
                      <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sunken text-ink-soft">{EVENT_STATUS_TEXT[e.status] || e.status}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm text-ink-soft min-w-0"><Building2 aria-hidden="true" className="w-4 h-4 shrink-0" /><span className="min-w-0 break-words">{venueName(e)}</span></div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
                      <span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden="true" className="w-4 h-4" />{formatWorkDate(e.date)}{e.endDate && e.endDate !== e.date ? ` – ${formatWorkDate(e.endDate)}` : ''}</span>
                      {times && <span className="tnum inline-flex items-center gap-1.5"><Clock aria-hidden="true" className="w-4 h-4" />{times}</span>}
                    </div>
                    <div className="flex items-center gap-1.5 text-sm min-w-0"><UserIcon aria-hidden="true" className="w-4 h-4 text-ink-faint shrink-0" /><span className={`min-w-0 break-words ${e.mashgiachType === 'unassigned' && (i < firstPast || firstPast < 0) ? 'text-bad font-semibold' : 'text-ink'}`}>{eventAssigneeText(e)}</span></div>
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
