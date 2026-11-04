import { Info } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { Shift } from '../types';
import { apiWrite, captureEditBaseline } from '../lib/api';
import { formatShiftHours, shiftEditableFields } from '../lib/shifts';

const barPosition = (minutes: number, end = false) => end && minutes === 360 ? 1 : ((minutes - 360 + 1440) % 1440) / 1440;

/** Draft locally while moving. Commit a changed gesture once, on release. */
export const ShiftHoursBar: React.FC<{ shift: Shift; pinMinutes?: number; readOnly?: boolean; onSaved: (shift: Shift) => void }> = ({ shift, pinMinutes, readOnly = false, onSaved }) => {
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
  const handle = (key: 'startMinutes' | 'endMinutes') => <>
    <input type="range" aria-label={key === 'startMinutes' ? 'Shift start' : 'Shift end'} min={360} max={1800} step={30} value={hours[key] < 360 || (key === 'endMinutes' && hours[key] === 360) ? hours[key] + 1440 : hours[key]} disabled={busy}
      onPointerDown={begin} onFocus={begin} onChange={(e) => { const next = { ...draft.current, [key]: Number(e.target.value) % 1440 }; draft.current = next; setHours(next); }}
      onPointerUp={() => void commit()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } }} onBlur={() => void commit()}
      className="shift-hours-handle block w-full min-h-11 accent-gold" />
    <span className="shift-hours-bubble relative block w-max -translate-x-1/2 text-center" style={{ left: `clamp(48px, calc(44px / 2 + (100% - 44px) * ${barPosition(hours[key], key === 'endMinutes')}), calc(100% - 48px))` }}><span className="sr-only">{key === 'startMinutes' ? 'From' : 'Until'} </span>{Math.floor(hours[key] / 60) % 12 || 12}:{String(hours[key] % 60).padStart(2, '0')} {hours[key] < 720 ? 'AM' : 'PM'}</span>
  </>;
  return <div className={`shift-hours-visual space-y-2 ${readOnly ? 'is-readonly' : ''}`} aria-label="Shift hours">
    <p className="sr-only">{formatShiftHours({ ...shift, ...hours })}</p>
    <div className="shift-hours-well space-y-2">
      <label hidden={readOnly} className="shift-hours-start block text-sm text-ink-soft">
        {handle('startMinutes')}
      </label>
      <div aria-label="24-hour shift range" className="shift-hours-track relative mx-6 rounded-lg bg-line-control" data-shift-track>
        <span aria-hidden="true" className="shift-hours-default shift-hours-morning" /><span aria-hidden="true" className="shift-hours-default shift-hours-afternoon" /><span aria-hidden="true" className="shift-hours-default shift-hours-night" />
        {(barPosition(hours.startMinutes) < barPosition(hours.endMinutes, true) ? [[barPosition(hours.startMinutes), barPosition(hours.endMinutes, true)]] : [[0, barPosition(hours.endMinutes, true)], [barPosition(hours.startMinutes), 1]]).filter(([start, end]) => end > start).map(([start, end]) => <span key={start} aria-hidden="true" data-shift-band className="absolute inset-y-0 rounded-full bg-gold-deep" style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }} />)}
        {pinMinutes !== undefined && <span role="img" aria-label="Target time pin" className="shift-hours-pin absolute bottom-full text-ink" style={{ left: `${barPosition(pinMinutes) * 100}%` }}>{!readOnly && 'by '}{Math.floor(pinMinutes / 60) % 12 || 12}:{String(pinMinutes % 60).padStart(2, '0')} {pinMinutes < 720 ? 'AM' : 'PM'}<span className="block">▼</span></span>}
      </div>
      <div className="relative mx-6 h-4 text-xs text-ink-soft" aria-hidden="true">
        {[['6a', 0], ['10a', 100 / 6], ['2p', 100 / 3], ['6p', 50], ['10p', 200 / 3], ['2a', 500 / 6], ['6a', 100]].map(([label, left]) => <span key={left} className="absolute -translate-x-1/2" style={{ left: `${left}%` }}>{label}</span>)}
      </div>
      <label hidden={readOnly} className="shift-hours-end block text-sm text-ink-soft">
        {handle('endMinutes')}
      </label>
    </div>
    <p className="shift-hours-hint text-xs text-ink-soft"><Info aria-hidden="true" className="w-4 h-4 shrink-0" /><span>{!readOnly && <>Drag the ends to adjust. <strong>Changes the {shift.name} shift's hours for every task on it, every week</strong></>}</span></p>
    {busy && <p className="text-sm text-ink-soft">Saving…</p>}
    {error && <p role="alert" className="text-base text-bad">{error} <button type="button" onClick={() => { attempted.current = null; void commit(); }} className="min-h-11 px-3 underline pressable">Try again</button></p>}
  </div>;
}
