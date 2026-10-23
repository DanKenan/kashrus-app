import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { User, Venue } from '../types';
import { apiWrite, captureEditBaseline } from '../lib/api';
import {
  END_DATE_TEXT, addDays, buildVenueOps, dayWords, lastDayOf, serverNowMs, ymdIn, zoneForVenue,
} from '../lib/venueEndDates';

type SheetRecord = User & { venueIds: string[] };

interface VenueAccessSheetProps {
  record: SheetRecord;
  venues: Venue[];
  /** The agency's zone (venues without their own zone use it). */
  agencyTimeZone?: string;
  /** The same person as the roster has them now (used to reload after a 409). */
  latest?: SheetRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

interface Opened {
  record: SheetRecord;
  extras: string[];
  lastDay: Record<string, string | null>;
  rev: number | null;
}

function openedFrom(record: SheetRecord, venues: Venue[], agencyTimeZone?: string): Opened {
  const home = record.venueId || '';
  const extras = record.venueIds.filter((id) => id && id !== home);
  const lastDay: Record<string, string | null> = {};
  for (const id of extras) {
    const venue = venues.find((v) => v.id === id);
    lastDay[id] = lastDayOf(record.venueUntil?.[id], zoneForVenue(venue, agencyTimeZone));
  }
  // 12a-c: dates only when the server sends the venue-ops precondition.
  const rev = typeof record.venueRevision === 'number' && Number.isInteger(record.venueRevision) && record.venueRevision >= 0
    ? record.venueRevision : null;
  return { record: { ...record, venueIds: [...record.venueIds] }, extras, lastDay, rev };
}

// Mounted on open: the record and write baseline stay frozen until close
// (or until a 409 reloads them from the roster).
export function VenueAccessSheet({ record, venues, agencyTimeZone, latest, onClose, onSaved }: VenueAccessSheetProps) {
  const [opened, setOpened] = useState<Opened>(() => openedFrom(record, venues, agencyTimeZone));
  const [baseline, setBaseline] = useState(() => captureEditBaseline());
  const [selected, setSelected] = useState(() => new Set([record.venueId || '', ...record.venueIds].filter(Boolean)));
  const [lastDay, setLastDay] = useState<Record<string, string | null>>(() => ({ ...opened.lastDay }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const original = opened.record;
  const home = original.venueId || '';
  const datesOn = opened.rev !== null;
  const extrasNow = venues.filter((venue) => venue.id !== home && selected.has(venue.id)).map((venue) => venue.id);
  const venueIds = home ? [home, ...extrasNow] : extrasNow;
  const ops = useMemo(() => buildVenueOps(
    { extras: opened.extras, lastDay: opened.lastDay },
    { extras: extrasNow, lastDay },
  ), [opened, extrasNow.join(','), lastDay]);
  const initialSelection = new Set([home, ...original.venueIds].filter(Boolean));
  const selectionChanged = selected.size !== initialSelection.size ||
    [...selected].some((id) => !initialSelection.has(id));
  const changed = datesOn ? ops.length > 0 : selectionChanged;

  const todayFor = (venue: Venue) => ymdIn(serverNowMs(), zoneForVenue(venue, agencyTimeZone));

  const conflict = () => {
    if (latest && Array.isArray(latest.venueIds) && latest.venueRevision !== opened.record.venueRevision) {
      const next = openedFrom(latest, venues, agencyTimeZone);
      setOpened(next);
      setBaseline(captureEditBaseline());
      setSelected(new Set([latest.venueId || '', ...latest.venueIds].filter(Boolean)));
      setLastDay({ ...next.lastDay });
      setError(END_DATE_TEXT.conflictReloaded);
    } else {
      setError(END_DATE_TEXT.conflictReopen);
    }
  };

  const save = async () => {
    if (!changed || savingRef.current) return;
    // An absent opening baseline must never fall back to a newer version.
    if (baseline === undefined) {
      setError("Couldn't save venues.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = datesOn
        ? await apiWrite(`/api/users/${encodeURIComponent(original.id)}/venue-ops`, {
          method: 'POST',
          expectedVersion: baseline,
          body: JSON.stringify({ ops, expectedVenueRev: opened.rev }),
        })
        : await apiWrite(`/api/users/${encodeURIComponent(original.id)}/venues`, {
          method: 'PUT',
          expectedVersion: baseline,
          body: JSON.stringify({ venueIds, expectedVenueIds: original.venueIds }),
        });
      if (result.ok) {
        onSaved();
        return;
      }
      if (result.code === 'NOT_MIGRATED') {
        setError("This person's account needs a one-time upgrade first.");
      } else if (result.code === 'VENUES_CHANGED' || result.code === 'VERSION_CONFLICT') {
        conflict();
      } else {
        setError(typeof result.data?.error === 'string' && result.data.error.trim()
          ? result.data.error : "Couldn't save venues.");
      }
    } catch {
      setError("Couldn't save venues.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const buttons = (): HTMLElement[] => Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')) as HTMLElement[];
    buttons()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const controls = buttons();
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) buttons()[0]?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl bg-surface border border-line e3 p-4 animate-slide-up"
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 id={titleId} className="text-base font-semibold text-ink min-w-0 break-words">Venues for {original.name}</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg bg-surface border border-line-control text-ink hover:bg-sunken pressable cursor-pointer">
            <X aria-hidden="true" className="w-5 h-5" />
          </button>
        </div>
        <div className="space-y-2">
          {venues.map((venue) => {
            const isMain = !!home && venue.id === home;
            const ticked = isMain || selected.has(venue.id);
            const day = lastDay[venue.id] ?? null;
            const today = datesOn && ticked && !isMain ? todayFor(venue) : '';
            const words = day && today ? dayWords(day, today) : null;
            return (
              <div key={venue.id} data-venue-row={venue.id}
                className="w-full rounded-xl bg-surface border border-line-control text-ink">
                <label className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-base rounded-xl hover:bg-sunken cursor-pointer">
                  <input type="checkbox" checked={ticked} disabled={isMain || saving}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(venue.id);
                        else next.delete(venue.id);
                        return next;
                      });
                    }}
                    className="w-5 h-5 shrink-0 accent-ink disabled:opacity-50 disabled:cursor-not-allowed" />
                  <span className="min-w-0 break-words">{venue.name}</span>
                  {isMain && <span className="shrink-0 px-2 py-1 rounded-full bg-sunken text-xs text-ink-soft">Main</span>}
                </label>
                {datesOn && ticked && !isMain && (
                  <div data-end-date className="px-3 pb-3 pl-10 space-y-2">
                    {day && words ? (
                      <>
                        <p className="text-sm text-ink leading-snug">
                          <CalendarDays aria-hidden="true" className="inline w-4 h-4 mr-1 -mt-0.5 text-ink-soft" />
                          <span className="font-semibold">{END_DATE_TEXT.untilTitle(words.long)}</span>
                          <span className="text-ink-soft"> ({END_DATE_TEXT.through(words.full)})</span>
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="sr-only" htmlFor={`${titleId}-${venue.id}`}>{END_DATE_TEXT.endDateLabel} at {venue.name}</label>
                          <input id={`${titleId}-${venue.id}`} type="date" value={day} min={today} max={addDays(today, 366)}
                            disabled={saving} required
                            onChange={(event) => {
                              const v = event.target.value;
                              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setLastDay((p) => ({ ...p, [venue.id]: v }));
                            }}
                            className="min-h-11 px-3 rounded-lg bg-surface border border-line-control text-base text-ink tnum" />
                          <button type="button" disabled={saving}
                            onClick={() => setLastDay((p) => ({ ...p, [venue.id]: null }))}
                            className="min-h-11 px-1 rounded-lg text-sm text-ink-soft underline underline-offset-2 hover:text-ink pressable cursor-pointer disabled:opacity-50">
                            {END_DATE_TEXT.removeEndDate}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm text-ink-soft">{END_DATE_TEXT.noEndDate}</span>
                        <button type="button" disabled={saving}
                          onClick={() => setLastDay((p) => ({ ...p, [venue.id]: today }))}
                          className="min-h-11 px-3 rounded-lg bg-surface border border-line-control text-sm text-ink hover:bg-sunken pressable cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50">
                          <CalendarDays aria-hidden="true" className="w-4 h-4" />
                          {END_DATE_TEXT.addEndDate}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {error && <p role="alert" className="mt-4 text-base text-ink">{error}</p>}
        <button type="button" onClick={save} disabled={!changed || saving}
          className="mt-4 w-full min-h-12 px-4 py-3 rounded-xl bg-gold-deep text-paper font-semibold text-base pressable cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
          Save
        </button>
      </div>
    </div>
  );
}
