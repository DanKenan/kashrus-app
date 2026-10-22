import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, X, Check, Ban } from 'lucide-react';
import { KosherEvent, User as UserType, Venue } from '../types';
import { venueTimeZone, workDateIn } from '../lib/workday';
import { formatClockTime, formatTimeRange } from '../lib/clockTime';

/**
 * Item 7: copy an event into a new, independent one. The server decides what
 * is copied (title, location, times and the task names); this dialog only
 * picks the new date and name, and says plainly what is NOT copied.
 */
interface CopyEventDialogProps {
  isOpen: boolean;
  event: KosherEvent | null;
  venue: Venue | null;
  currentUser: UserType | null;
  onClose: () => void;
  /** Resolves to null on success, or the error text to show. */
  onCopy: (eventId: string, title: string, date: string, operationId: string) => Promise<string | null>;
}

const newOpId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const CopyEventDialog: React.FC<CopyEventDialogProps> = ({
  isOpen,
  event,
  venue,
  currentUser,
  onClose,
  onCopy,
}) => {
  // "Today" is the venue's local date (item 6), not this device's.
  const venueToday = useMemo(
    () => workDateIn(venueTimeZone(venue, currentUser), new Date()),
    // Recomputed each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOpen, venue?.id, venue?.timeZone, currentUser?.agencyTimeZone]
  );
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One operationId per (title, date) attempt: a retry of the same choice
  // reuses it (no duplicate copy); a changed choice gets a fresh one.
  const opRef = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    if (!isOpen || !event) return;
    setTitle(event.title || '');
    setDate(venueToday);
    setError(null);
    setSaving(false);
    opRef.current = null;
  }, [isOpen, event?.id, venueToday]);

  if (!isOpen || !event) return null;

  const taskCount = event.tasks?.length || 0;
  const timeText = formatClockTime(event.startTime) ? formatTimeRange(event.startTime, event.endTime) : '';
  const trimmed = title.trim();
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= venueToday;
  const canSave = !saving && trimmed.length > 0 && trimmed.length <= 200 && dateOk;

  const handleSave = async () => {
    if (!canSave) return;
    const key = `${trimmed}|${date}`;
    if (!opRef.current || opRef.current.key !== key) opRef.current = { key, id: newOpId() };
    setSaving(true);
    setError(null);
    const err = await onCopy(event.id, trimmed, date, opRef.current.id);
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <div
      id="copy-event-overlay"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-event-title"
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-surface border border-line e3 p-5 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2.5 rounded-xl shrink-0 bg-sunken">
              <Copy className="w-5 h-5 text-ink-soft" />
            </div>
            <div className="min-w-0">
              <h3 id="copy-event-title" className="text-base font-bold text-ink leading-tight">
                Copy event
              </h3>
              <p className="mt-1 text-sm text-ink-soft break-words">
                A new event from “{event.title}”. Pick its date.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-semibold text-ink-soft mb-1">Event name</span>
            <input
              id="copy-event-name"
              type="text"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full min-h-[44px] px-3 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-ink-soft mb-1">Date</span>
            <input
              id="copy-event-date"
              type="date"
              value={date}
              min={venueToday}
              onChange={(e) => setDate(e.target.value)}
              className="w-full min-h-[44px] px-3 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
            />
            {date && !dateOk && (
              <span className="block mt-1 text-xs font-semibold text-bad">Pick today or a later date.</span>
            )}
          </label>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div id="copy-event-copied" className="rounded-xl bg-sunken p-3">
            <div className="text-xs font-bold text-ink mb-1.5">Copied</div>
            <ul className="space-y-1 text-ink-soft">
              <li className="flex gap-1.5"><Check className="w-4 h-4 mt-0.5 shrink-0 text-ok" />{taskCount} {taskCount === 1 ? 'task' : 'tasks'} (names and descriptions only)</li>
              {timeText && <li className="flex gap-1.5"><Check className="w-4 h-4 mt-0.5 shrink-0 text-ok" />Time: {timeText}</li>}
              {event.location && <li className="flex gap-1.5 min-w-0"><Check className="w-4 h-4 mt-0.5 shrink-0 text-ok" /><span className="break-words min-w-0">Location: {event.location}</span></li>}
            </ul>
          </div>
          <div id="copy-event-not-copied" className="rounded-xl bg-sunken p-3">
            <div className="text-xs font-bold text-ink mb-1.5">Not copied</div>
            <ul className="space-y-1 text-ink-soft">
              <li className="flex gap-1.5"><Ban className="w-4 h-4 mt-0.5 shrink-0 text-ink-soft" />Who is assigned</li>
              <li className="flex gap-1.5"><Ban className="w-4 h-4 mt-0.5 shrink-0 text-ink-soft" />Checkmarks and task notes</li>
              <li className="flex gap-1.5"><Ban className="w-4 h-4 mt-0.5 shrink-0 text-ink-soft" />Event notes and menu file</li>
            </ul>
          </div>
        </div>

        {error && (
          <div role="alert" className="mt-3 rounded-xl bg-bad-bg px-3 py-2 text-sm font-semibold text-bad">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2.5 pt-4 border-t border-line">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="min-h-[44px] px-4 rounded-xl text-sm font-semibold hover:brightness-95 pressable cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken"
          >
            Cancel
          </button>
          <button
            id="copy-event-save"
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="min-h-[44px] px-4 rounded-xl text-sm font-bold e2 pressable cursor-pointer disabled:opacity-50 flex items-center gap-1.5 bg-gold-deep text-paper"
          >
            <Copy className="w-4 h-4" />
            <span>{saving ? 'Copying…' : 'Create copy'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
