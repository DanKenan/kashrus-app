import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiWrite } from '../lib/api';
import { Venue } from '../types';
import { withLiveStats } from './EditCertificationSheet';

/** The types New Venue offers (same values the server stores). */
export const VENUE_TYPES = ['Industrial', 'Food Service', 'Restaurant', 'Catering', 'Bakery'] as const;
const TYPE_LABEL: Record<string, string> = { Industrial: 'Factory / plant' };
export const venueTypeLabel = (t: string) => TYPE_LABEL[t] || t;

export interface VenueEdits { name?: string; address?: string; category?: string }

/** Only the fields that really changed (trimmed); null = nothing to save; a string = the problem. */
export function venueEdits(venue: Pick<Venue, 'name' | 'address' | 'category'>, form: { name: string; address: string; type: string; otherType: string }): VenueEdits | null | string {
  const name = form.name.trim();
  const address = form.address.trim();
  const category = (form.type === 'Other' ? form.otherType : form.type).trim();
  if (!name) return 'Enter the venue name.';
  if (name.length > 120) return 'The venue name is too long (120 characters at most).';
  if (address.length > 200) return 'The address is too long (200 characters at most).';
  if (!category) return 'Enter the venue type.';
  if (category.length > 60) return 'The venue type is too long (60 characters at most).';
  const out: VenueEdits = {};
  if (name !== (venue.name || '').trim()) out.name = name;
  if (address !== (venue.address || '').trim()) out.address = address;
  if (category !== (venue.category || '').trim()) out.category = category;
  return Object.keys(out).length ? out : null;
}

interface EditVenueSheetProps {
  venue: Venue;
  onClose: () => void;
  /** Called with the server-confirmed venue after a save. */
  onSaved: (venue: Venue) => void;
}

/**
 * QA2 #7: admins fix a venue's name, address and type from the Venues list
 * (PUT /api/venues/:id). The card shows the new values only after the server
 * confirms. The owner is changed in Team (give the person this venue).
 */
export const EditVenueSheet: React.FC<EditVenueSheetProps> = ({ venue, onClose, onSaved }) => {
  const known = (VENUE_TYPES as readonly string[]).includes(venue.category);
  const [name, setName] = useState(venue.name || '');
  const [address, setAddress] = useState(venue.address || '');
  const [type, setType] = useState<string>(known ? venue.category : 'Other');
  const [otherType, setOtherType] = useState(known ? '' : venue.category || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const nameId = useId();
  const addressId = useId();
  const typeId = useId();
  const otherId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const buttonClass = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-sm font-semibold text-ink hover:bg-sunken focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50';
  const inputClass = 'min-h-11 w-full rounded-lg border border-line-control bg-surface px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-gold';

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    const focusable = (): HTMLElement[] => Array.from<HTMLElement>(root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'
    ) || []);
    (root?.querySelector<HTMLElement>('input') || focusable()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          root?.focus();
        } else if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!root?.contains(event.target as Node)) (focusable()[0] || root)?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      previous?.focus();
    };
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const edits = venueEdits(venue, { name, address, type, otherType });
    if (typeof edits === 'string') { setError(edits); return; }
    if (edits === null) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      const result = await apiWrite<{ venue: Venue }>(`/api/venues/${encodeURIComponent(venue.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      });
      if (!result.ok || !result.data?.venue) {
        setError((!result.ok && result.error) || "Couldn't save the venue.");
        return;
      }
      onSaved(withLiveStats(result.data.venue, venue));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the venue.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4" onClick={(e) => e.stopPropagation()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-edit-venue-sheet
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-control bg-surface p-6 text-ink e3">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-bold">Edit venue</h2>
            <p dir="auto" className="mt-0.5 text-sm text-ink-soft break-words">{venue.name}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className={`${buttonClass} w-11 shrink-0 px-0 inline-flex items-center justify-center`}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={save} className="space-y-3" noValidate>
          <div className="space-y-1">
            <label htmlFor={nameId} className="block text-xs font-semibold text-ink-soft">Venue name</label>
            <input id={nameId} dir="auto" value={name} disabled={saving} maxLength={120} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label htmlFor={addressId} className="block text-xs font-semibold text-ink-soft">Address</label>
            <input id={addressId} dir="auto" value={address} disabled={saving} maxLength={200} onChange={(e) => setAddress(e.target.value)} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label htmlFor={typeId} className="block text-xs font-semibold text-ink-soft">Type</label>
            <select id={typeId} value={type} disabled={saving} onChange={(e) => setType(e.target.value)} className={inputClass}>
              {VENUE_TYPES.map((t) => <option key={t} value={t}>{venueTypeLabel(t)}</option>)}
              <option value="Other">Other</option>
            </select>
          </div>
          {type === 'Other' && (
            <div className="space-y-1">
              <label htmlFor={otherId} className="block text-xs font-semibold text-ink-soft">Other type</label>
              <input id={otherId} dir="auto" value={otherType} disabled={saving} maxLength={60} onChange={(e) => setOtherType(e.target.value)} className={inputClass} />
            </div>
          )}
          <p className="text-sm text-ink-soft">To change who owns this venue, use Team.</p>
          {error && <p role="alert" className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={saving} className={buttonClass}>Cancel</button>
            <button type="submit" disabled={saving} className="pressable min-h-11 rounded-xl bg-gold-deep px-4 text-sm font-semibold text-paper focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
