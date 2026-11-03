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
  const begin = () => { baseline.current = captureEditBaseline(); attempted.current = null; draft.current = { ...hours }; setError(''); };
  const commit = async () => {
    const snapshot = JSON.stringify(draft.current);
    if (lock.current || snapshot === JSON.stringify(original.current) || snapshot === attempted.current) return;
    if (draft.current.startMinutes === draft.current.endMinutes) { setError('Choose different start and end times.'); return; }
    attempted.current = snapshot; lock.current = true; setBusy(true); setError('');
    try {
      const definition = { ...shiftEditableFields(shift), ...draft.current, venueId: shift.venueId };
      const result = await apiWrite<Shift>(`/api/shifts/${encodeURIComponent(shift.id)}`, { method: 'PUT', expectedVersion: baseline.current, body: JSON.stringify(definition) });
      if (!result.ok) { setHours({ ...original.current }); setError(result.error || "Couldn't save the shift. Try again."); return; }
      const saved = { startMinutes: result.data.startMinutes, endMinutes: result.data.endMinutes };
      original.current = saved; draft.current = saved; setHours(saved); onSaved(result.data);
    } catch { setHours({ ...original.current }); setError("Couldn't save the shift. Check the connection and try again."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="space-y-2" aria-label="Shift hours">
    <p className="text-base text-ink">{formatShiftHours({ ...shift, ...hours })}</p>
    <div className="relative rounded-lg bg-sunken p-3">
      <div className="grid grid-cols-2 gap-4">
        {(['startMinutes', 'endMinutes'] as const).map((key) => <label key={key} className="min-w-0 text-sm text-ink-soft">
          <input type="range" aria-label={key === 'startMinutes' ? 'Shift start' : 'Shift end'} min={0} max={1410} step={30} value={hours[key]} disabled={busy}
            onPointerDown={begin} onFocus={begin} onChange={(e) => { const next = { ...draft.current, [key]: Number(e.target.value) }; draft.current = next; setHours(next); }}
            onPointerUp={() => void commit()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } }} onBlur={() => void commit()}
            className="shift-hours-handle block w-full min-h-11 accent-gold" />
          <span className="block text-center">{key === 'startMinutes' ? 'From' : 'Until'} {Math.floor(hours[key] / 60) % 12 || 12}:{String(hours[key] % 60).padStart(2, '0')} {hours[key] < 720 ? 'AM' : 'PM'}</span>
        </label>)}
      </div>
      {pinMinutes !== undefined && <span role="img" aria-label="Target time pin" className="absolute top-0 text-gold-deep" style={{ left: `${pinMinutes / 1440 * 100}%` }}>▼</span>}
    </div>
    <p className="text-sm text-ink-soft">Changes the {shift.name} shift's hours for every task on it, every week</p>
    {busy && <p className="text-sm text-ink-soft">Saving…</p>}
    {error && <p role="alert" className="text-base text-bad">{error} <button type="button" onClick={() => { attempted.current = null; void commit(); }} className="min-h-11 px-3 underline pressable">Try again</button></p>}
  </div>;
}
