import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch, apiWrite } from '../lib/api';
import { DEFAULT_CERT_OPTIONS, certificationLabel, normalizeOption, readCertification, validateOptions } from '../lib/certOptions';
import { KosherAgency, Venue } from '../types';

interface EditCertificationSheetProps {
  venue: Venue;
  agencyName?: string;
  onClose: () => void;
  /** Called with the server-confirmed venue after a save. */
  onSaved: (venue: Venue) => void;
}

type Choice = number | 'other' | 'none' | null;

/** The live counts GET /api/venues adds to each venue; a PUT answer carries none, so the card keeps its own. */
const LIVE_STATS = ['totalTasksToday', 'completedTasksToday', 'completionRate', 'workerCount'] as const;
export function withLiveStats(saved: Venue, shown: Venue): Venue {
  const next: Venue = { ...saved };
  for (const key of LIVE_STATS) if (next[key] === undefined && shown[key] !== undefined) (next as any)[key] = shown[key];
  return next;
}

/** Which choice the venue's stored certification matches (null = none of them, e.g. unreadable legacy text). */
export function initialChoice(venue: Venue, agencyName: string, options: readonly string[]): { selected: Choice; other: string } {
  if (!venue.certification?.trim()) return { selected: 'none', other: '' };
  const read = readCertification(venue.certification, agencyName, venue.certificationDetail, options);
  if (read === null) return { selected: null, other: '' };
  if (read === '') return { selected: 'none', other: '' };
  const index = options.findIndex((option) => normalizeOption(option).toLowerCase() === normalizeOption(read).toLowerCase());
  return index >= 0 ? { selected: index, other: '' } : { selected: 'other', other: read };
}

/**
 * Don (Oct 22): admins change a venue's certification type from the Venues
 * list — the agency's choices (as in New Venue), plus Other and None. Saves
 * { certificationDetail } through PUT /api/venues/:id; the card shows the new
 * value only after the server confirms.
 */
export const EditCertificationSheet: React.FC<EditCertificationSheetProps> = ({ venue, agencyName, onClose, onSaved }) => {
  const [options, setOptions] = useState<string[]>([]);
  const [name, setName] = useState(agencyName || '');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Choice>(null);
  const [other, setOther] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const groupId = useId();
  const otherId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const buttonClass = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-sm font-semibold text-ink hover:bg-sunken focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50';
  const rowClass = 'flex min-h-11 items-center gap-3 rounded-lg border border-line-control bg-surface px-3 text-base text-ink';

  useEffect(() => {
    let active = true;
    const load = async () => {
      let list: string[] = [...DEFAULT_CERT_OPTIONS];
      let agency = agencyName || '';
      try {
        const res = await apiFetch('/api/agencies/current');
        const data: { agency: KosherAgency; error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't load certification choices.");
        list = data.agency.certificationOptions || list;
        agency = data.agency.name || agency;
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "Couldn't load certification choices.");
      }
      if (!active) return;
      setOptions(list);
      setName(agency);
      const start = initialChoice(venue, agency, list);
      setSelected(start.selected);
      setOther(start.other);
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [venue, agencyName]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    const focusable = (): HTMLElement[] => Array.from<HTMLElement>(root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
    ) || []);
    focusable()[0]?.focus();
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

  const detail = selected === 'other' ? normalizeOption(other) : typeof selected === 'number' ? options[selected] || '' : '';
  const preview = selected === null ? null : certificationLabel(name, detail);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || loading || selected === null) return;
    if (selected === 'other') {
      const validation = validateOptions([other]);
      if (validation) { setError(validation); return; }
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiWrite<{ venue: Venue }>(`/api/venues/${encodeURIComponent(venue.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certificationDetail: detail }),
      });
      if (!result.ok || !result.data?.venue) {
        setError((!result.ok && result.error) || "Couldn't save the certification.");
        return;
      }
      onSaved(withLiveStats(result.data.venue, venue));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the certification.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4" onClick={(e) => e.stopPropagation()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-edit-certification-sheet
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-control bg-surface p-6 text-ink e3">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-bold">Edit certification</h2>
            <p dir="auto" className="mt-0.5 text-sm text-ink-soft break-words">{venue.name}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className={`${buttonClass} w-11 shrink-0 px-0 inline-flex items-center justify-center`}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={save} className="space-y-3">
          <span id={groupId} className="text-xs font-semibold text-ink-soft">Certification details</span>
          {loading && <p role="status" className="text-sm text-ink-soft">Loading certification choices…</p>}
          {loadError && <p role="alert" className="text-sm text-ink">{loadError} Showing the standard choices.</p>}
          {!loading && (
            <div role="radiogroup" aria-labelledby={groupId} className="space-y-2">
              {options.map((option, index) => (
                <label key={index} className={rowClass}>
                  <input type="radio" name="edit-certification" checked={selected === index} disabled={saving} onChange={() => setSelected(index)} />
                  {option}
                </label>
              ))}
              <label className={rowClass}>
                <input type="radio" name="edit-certification" checked={selected === 'other'} disabled={saving} onChange={() => setSelected('other')} />
                Other
              </label>
              <label className={rowClass}>
                <input type="radio" name="edit-certification" checked={selected === 'none'} disabled={saving} onChange={() => setSelected('none')} />
                None
              </label>
            </div>
          )}
          {selected === 'other' && (
            <div className="space-y-1">
              <label htmlFor={otherId} className="block text-sm text-ink-soft">Other certification</label>
              <input id={otherId} value={other} disabled={saving} onChange={(e) => setOther(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-line-control bg-sunken px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-gold" />
            </div>
          )}
          {!loading && (
            <p aria-live="polite" dir="auto" className="text-sm text-ink-soft break-words">
              {preview === null ? `Now shows: ${venue.certification}` : `Venue will show: ${preview}`}
            </p>
          )}
          {error && <p role="alert" className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={saving} className={buttonClass}>Cancel</button>
            <button type="submit" disabled={saving || loading || selected === null}
              className="pressable min-h-11 rounded-xl bg-gold-deep px-4 text-sm font-semibold text-paper focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
