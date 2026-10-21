import React, { useEffect, useId, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { Venue } from '../types';

interface VenueSwitcherSheetProps {
  isOpen: boolean;
  onClose: () => void;
  venues: Venue[];
  currentVenueId: string | null;
  homeVenueId?: string;
  onSelectVenue: (venueId: string) => void;
}

export function VenueSwitcherSheet({
  isOpen, onClose, venues, currentVenueId, homeVenueId, onSelectVenue,
}: VenueSwitcherSheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const buttons = (): HTMLButtonElement[] => Array.from(dialog.querySelectorAll('button:not(:disabled)')) as HTMLButtonElement[];
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
  }, [isOpen]);

  if (!isOpen) return null;

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
          <h2 id={titleId} className="text-base font-semibold text-ink">Switch venue</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg bg-surface border border-line-control text-ink hover:bg-sunken pressable cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="space-y-2">
          {venues.map((venue) => (
            <button
              key={venue.id}
              type="button"
              aria-current={venue.id === currentVenueId ? 'true' : undefined}
              onClick={() => { onSelectVenue(venue.id); onClose(); }}
              className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-left text-base rounded-xl bg-surface border border-line-control text-ink hover:bg-sunken pressable cursor-pointer"
            >
              <span className="min-w-0 break-words">{venue.name}</span>
              {venue.id === homeVenueId && (
                <span className="shrink-0 px-2 py-1 rounded-full bg-sunken text-xs text-ink-soft">Main</span>
              )}
              {venue.id === currentVenueId && <Check aria-hidden="true" className="w-5 h-5 shrink-0 ml-auto text-ink" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
