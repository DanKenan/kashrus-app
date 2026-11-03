import React, { useEffect, useRef, useState } from 'react';
import type { Shift } from '../types';
import { apiWrite, captureEditBaseline } from '../lib/api';
import { formatShiftHours, shiftEditableFields } from '../lib/shifts';

/** Draft locally while moving. Commit a changed gesture once, on release. */
export const ShiftHoursBar: React.FC<{ shift: Shift; pinMinutes?: number; onSaved: (shift: Shift) => void }> = ({ shift, pinMinutes, onSaved }) => {
  const [hours, setHours] = useState({ startMinutes: shift.startMinutes, endMinutes: shift.endMinutes });
  const draft = useRef(hours);
  const original = useRef(hours);
  const baseline = useRef<number | undefined>(undefined);
  const lock = useRef(false);
  const attempted = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const next = { startMinutes: shift.startMinutes, endMinutes: shift.endMinutes };
    setHours(next); draft.current = next; original.current = next; attempted.current = null;
  }, [shift.id, shift.startMinutes, shift.endMinutes]);
  const begin = () => { baseline.current = captureEditBaseline(); attempted.current = null; };
  const commit = async () => {
    const snapshot = JSON.stringify(draft.current);
    if (lock.current || snapshot === JSON.stringify(original.current) || snapshot === attempted.current) return;
    if (draft.current.startMinutes === draft.current.endMinutes) { setError('Choose different start and end times.'); return; }
    attempted.current = snapshot; lock.current = true; setBusy(true); setError('');
    try {
      const definition = { ...shiftEditableFields(shift), ...draft.current, venueId: shift.venueId };
      const result = await apiWrite<Shift>(`/api/shifts/${encodeURIComponent(shift.id)}`, { method: 'PUT', expectedVersion: baseline.current, body: JSON.stringify(definition) });
      if (!result.ok) { setError(result.error || "Couldn't save the shift. Try again."); return; }
      original.current = { ...draft.current }; onSaved(result.data);
    } catch { setError("Couldn't save the shift. Check the connection and try again."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="space-y-2" aria-label="Shift hours">
    <p className="text-base text-ink">{formatShiftHours({ ...shift, ...hours })}</p>
    <div className="shift-hours-track relative rounded-lg bg-sunken min-h-11">
      <span aria-hidden="true" className="absolute top-4 h-3 rounded-full bg-gold-wash" style={{ left: `${Math.min(hours.startMinutes, hours.endMinutes) / 1440 * 100}%`, width: `${Math.abs(hours.endMinutes - hours.startMinutes) / 1440 * 100}%` }} />
      {(['startMinutes', 'endMinutes'] as const).map((key) => <label key={key} className="text-sm text-ink-soft"><span className="sr-only">{key === 'startMinutes' ? 'From' : 'Until'}</span>
        <input type="range" aria-label={key === 'startMinutes' ? 'Shift start' : 'Shift end'} min={0} max={1410} step={30} value={hours[key]} disabled={busy}
          onPointerDown={begin} onFocus={begin} onChange={(e) => { const next = { ...draft.current, [key]: Number(e.target.value) }; draft.current = next; setHours(next); }}
          onPointerUp={() => void commit()} onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) void commit(); }} onBlur={() => void commit()}
          className="absolute inset-0 w-full min-h-11 accent-gold" />
      </label>)}
      {pinMinutes !== undefined && <span role="img" aria-label="Target time pin" className="absolute top-0 text-gold-deep" style={{ left: `${pinMinutes / 1440 * 100}%` }}>▼</span>}
    </div>
    <p className="text-sm text-ink-soft">Changes the {shift.name} shift's hours for every task on it, every week</p>
    {busy && <p className="text-sm text-ink-soft">Saving…</p>}
    {error && <p role="alert" className="text-base text-bad">{error} <button type="button" onClick={() => { attempted.current = null; void commit(); }} className="min-h-11 px-3 underline pressable">Try again</button></p>}
  </div>;
}
