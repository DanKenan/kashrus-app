import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { User, Venue } from '../types';
import { apiWrite, captureEditBaseline } from '../lib/api';

interface VenueAccessSheetProps {
  record: User & { venueIds: string[] };
  venues: Venue[];
  onClose: () => void;
  onSaved: () => void;
}

// Mounted on open: the record and write baseline stay frozen until close.
export function VenueAccessSheet({ record, venues, onClose, onSaved }: VenueAccessSheetProps) {
  const [original] = useState(() => ({ ...record, venueIds: [...record.venueIds] }));
  const [baseline] = useState(() => captureEditBaseline());
  const [selected, setSelected] = useState(() => new Set([record.venueId, ...record.venueIds]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const venueIds = [original.venueId, ...venues
    .filter((venue) => venue.id !== original.venueId && selected.has(venue.id))
    .map((venue) => venue.id)];
  const initialSelection = new Set([original.venueId, ...original.venueIds]);
  const changed = selected.size !== initialSelection.size ||
    [...selected].some((id) => !initialSelection.has(id));

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
      const result = await apiWrite(`/api/users/${encodeURIComponent(original.id)}/venues`, {
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
        setError("Someone else just changed this person's venues. Close and reopen to see the latest.");
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
            const isMain = venue.id === original.venueId;
            return (
              <label key={venue.id} className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-base rounded-xl bg-surface border border-line-control text-ink hover:bg-sunken cursor-pointer">
                <input type="checkbox" checked={isMain || selected.has(venue.id)} disabled={isMain || saving}
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
