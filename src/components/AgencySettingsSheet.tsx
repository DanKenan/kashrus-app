import React, { useEffect, useId, useRef, useState } from 'react';
import { SITE_TEXT } from '../lib/site';
import { X } from 'lucide-react';
import { apiFetch, apiWrite, versionFromResponse } from '../lib/api';
import { COMMON_TIME_ZONES, DEFAULT_TIME_ZONE, timeZoneLabel } from '../lib/workday';

// QA2 #27 (Don 2026-10-22): the admin's own agency settings — name, phone, time zone.
// Reads GET /api/agencies/current (admin view), saves PUT /api/agency/settings with only
// the fields that changed and the version of the response the form was filled from.
export interface AgencySettingsSaved { name: string; contactPhone: string; timeZone: string }

interface AgencySettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (agency: AgencySettingsSaved) => void;
}

export const SETTINGS_CHANGED_TEXT = 'Someone else just changed the agency. Close and reopen to see the latest.';
export const SETTINGS_FALLBACK_TEXT = "Couldn't save the settings. Please try again.";

// Mount a fresh form for each opening: its response version is captured once.
export function AgencySettingsSheet(props: AgencySettingsSheetProps) {
  return props.isOpen ? <AgencySettingsForm {...props} /> : null;
}

export function AgencySettingsForm({ onClose, onSaved }: AgencySettingsSheetProps) {
  const [baseline, setBaseline] = useState<number | undefined>();
  const [loaded, setLoaded] = useState<AgencySettingsSaved | null>(null);
  // Domains PR B (plan 2c): the agency's id, read-only, so Don can confirm each address's agency.
  const [agencyId, setAgencyId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [zone, setZone] = useState(DEFAULT_TIME_ZONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const nameId = useId();
  const phoneId = useId();
  const zoneId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const buttonClass = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-sm font-semibold text-ink hover:bg-sunken focus:outline-none focus:ring-2 focus:ring-gold/40 disabled:opacity-50';
  const fieldClass = 'min-h-11 w-full min-w-0 rounded-lg border border-line-control bg-surface px-3 text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-gold/40';

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/agencies/current');
        const version = versionFromResponse(res);
        const data: any = await res.json().catch(() => null);
        if (!res.ok || version === undefined || !data?.agency) throw new Error(data?.error || "Couldn't load the agency. Close and reopen to try again.");
        if (!active) return;
        const a = data.agency;
        const now: AgencySettingsSaved = {
          name: typeof a.name === 'string' ? a.name : '',
          contactPhone: typeof a.contactPhone === 'string' ? a.contactPhone : '',
          timeZone: typeof a.timeZone === 'string' && a.timeZone ? a.timeZone : DEFAULT_TIME_ZONE,
        };
        setAgencyId(typeof a.id === 'string' && a.id ? a.id : null);
        setLoaded(now); setName(now.name); setPhone(now.contactPhone); setZone(now.timeZone);
        setBaseline(version);
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Couldn't load the agency."); }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    const focusable = (): HTMLElement[] => Array.from<HTMLElement>(root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'
    ) || []);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); root?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    const onFocus = (event: FocusEvent) => { if (!root?.contains(event.target as Node)) (focusable()[0] || root)?.focus(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      previous?.focus();
    };
  }, []);

  const changes: Record<string, string> = {};
  if (loaded) {
    if (name.trim() !== loaded.name) changes.name = name.trim();
    if (phone.trim() !== loaded.contactPhone) changes.contactPhone = phone.trim();
    if (zone !== loaded.timeZone) changes.timeZone = zone;
  }
  const hasChanges = Object.keys(changes).length > 0;
  const zones = COMMON_TIME_ZONES.some((z) => z.tz === zone) ? COMMON_TIME_ZONES : [{ label: zone, tz: zone }, ...COMMON_TIME_ZONES];

  const save = async () => {
    if (saving || baseline === undefined || !loaded || !hasChanges) return;
    if ('name' in changes && !changes.name) { setError('Please enter the agency name.'); return; }
    setSaving(true); setError(null);
    try {
      const result = await apiWrite<any>('/api/agency/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
        expectedVersion: baseline,
      });
      if (!result.ok) {
        const words = typeof result.data?.error === 'string' && result.data.error.trim() ? result.data.error.trim() : '';
        setError(result.status === 409 && !words ? SETTINGS_CHANGED_TEXT : result.code === 'VERSION_CONFLICT' ? SETTINGS_CHANGED_TEXT : words || SETTINGS_FALLBACK_TEXT);
        return;
      }
      const a = result.data?.agency || {};
      onSaved({
        name: typeof a.name === 'string' ? a.name : (changes.name ?? loaded.name),
        contactPhone: typeof a.contactPhone === 'string' ? a.contactPhone : (changes.contactPhone ?? loaded.contactPhone),
        timeZone: typeof a.timeZone === 'string' && a.timeZone ? a.timeZone : (changes.timeZone ?? loaded.timeZone),
      });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : SETTINGS_FALLBACK_TEXT); }
    finally { setSaving(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-agency-settings
      className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-control bg-surface p-6 text-ink e3">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id={titleId} className="text-base font-bold">Agency settings</h2>
        <button type="button" aria-label="Close" onClick={onClose} className={`${buttonClass} w-11 shrink-0 px-0 inline-flex items-center justify-center`}><X className="h-5 w-5" /></button>
      </div>
      {agencyId && (
        <p data-agency-id className="mb-4 text-sm text-ink-soft break-all">
          {SITE_TEXT.agencyId}: <span className="font-mono text-ink select-all">{agencyId}</span>
        </p>
      )}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div>
          <label htmlFor={nameId} className="mb-1 block text-sm text-ink-soft">Agency name</label>
          <input id={nameId} type="text" maxLength={100} value={name} disabled={!loaded || saving} onChange={(e) => { setName(e.target.value); setError(null); }} className={fieldClass} />
        </div>
        <div>
          <label htmlFor={phoneId} className="mb-1 block text-sm text-ink-soft">Phone</label>
          <input id={phoneId} type="tel" inputMode="tel" maxLength={30} value={phone} disabled={!loaded || saving} onChange={(e) => { setPhone(e.target.value); setError(null); }} placeholder="(860) 555-0100" className={fieldClass} />
        </div>
        <div>
          <label htmlFor={zoneId} className="mb-1 block text-sm text-ink-soft">Time zone</label>
          <select id={zoneId} value={zone} disabled={!loaded || saving} onChange={(e) => { setZone(e.target.value); setError(null); }} className={fieldClass}>
            {zones.map((z) => <option key={z.tz} value={z.tz}>{timeZoneLabel(z.tz)}</option>)}
          </select>
          <p className="mt-1 text-sm text-ink-soft">Venues without their own time zone use this one to decide when their day starts.</p>
        </div>
        {error && <p role="alert" data-settings-error className="text-sm text-bad">{error}</p>}
        <button type="submit" disabled={!loaded || saving || !hasChanges || baseline === undefined}
          className="pressable min-h-11 w-full rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper focus:outline-none focus:ring-2 focus:ring-gold/40 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  </div>;
}
