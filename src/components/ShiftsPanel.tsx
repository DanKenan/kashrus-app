import React, { useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Shift, ShiftOverride } from '../types';
import { formatShiftHours } from '../lib/shifts';
import { apiWrite, captureEditBaseline, newActionId } from '../lib/api';
import { addDays, workDateIn } from '../lib/workday';
import { ConfirmModal } from './ConfirmModal';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const control = 'min-h-11 rounded-lg border border-line-control bg-sunken text-ink px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold';
const button = 'min-h-11 rounded-lg border border-line-control px-3 text-base text-ink bg-surface hover:bg-sunken pressable disabled:opacity-50 cursor-pointer';
const timeValue = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
function dayLabel(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length > 2 && ordered.every((d, i) => !i || d === ordered[i - 1] + 1)
    ? `${days[ordered[0]]}–${days[ordered[ordered.length - 1]]}` : ordered.map((d) => days[d]).join(', ');
}
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
interface Props {
  shifts: Shift[];
  venueId: string;
  timeZone: string;
  people: Array<{ id?: string; name: string }>;
  onChange: (shift: Shift, deleted?: boolean) => void;
}
export function ShiftsPanel({ shifts, venueId, timeZone, people, onChange }: Props) {
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [selectedDays, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('18:00');
  const [person, setPerson] = useState('');
  const [overrides, setOverrides] = useState<ShiftOverride[]>([]);
  const [addingDate, setAddingDate] = useState(false);
  const [date, setDate] = useState('');
  const [datePerson, setDatePerson] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const baseline = useRef<number | undefined>(undefined);
  const operation = useRef<string | undefined>(undefined);
  const lock = useRef(false);
  const today = workDateIn(timeZone, new Date());
  const personName = (id: string | null) => !id ? 'Nobody' : people.find((p) => p.id === id)?.name || 'Unavailable person';
  const open = (shift: Shift | 'new') => {
    const s = shift === 'new' ? null : shift;
    setEditing(shift); setName(s?.name || ''); setArea(s?.area || '');
    setDays(s?.daysOfWeek || [0, 1, 2, 3, 4, 5, 6]);
    setStart(timeValue(s?.startMinutes ?? 480)); setEnd(timeValue(s?.endMinutes ?? 1080));
    setPerson(s?.userId || ''); setOverrides((s?.overrides || []).filter((o) => o.date >= today));
    setDate(addDays(today, 1)); setDatePerson(''); setAddingDate(false); setError('');
    baseline.current = captureEditBaseline(); operation.current = undefined;
  };
  const save = async (remove = false) => {
    if (lock.current || !editing) return;
    if (!remove && (!name.trim() || !selectedDays.length || start === end)) {
      setError('Enter a name, select at least one day, and choose different From and Until times.'); return;
    }
    lock.current = true; setBusy(true); setError('');
    try {
      operation.current ||= newActionId();
      const existing = editing === 'new' ? null : editing;
      const result = await apiWrite<Shift>(existing ? `/api/shifts/${encodeURIComponent(existing.id)}` : '/api/shifts', {
        method: remove ? 'DELETE' : existing ? 'PUT' : 'POST',
        expectedVersion: existing ? baseline.current : undefined, operationId: operation.current,
        body: remove ? undefined : JSON.stringify({ venueId, name: name.trim(), area: area.trim(), daysOfWeek: selectedDays,
          startMinutes: minutes(start), endMinutes: minutes(end), userId: person || null,
          overrides: overrides.filter((o) => o.date >= today) }),
      });
      if (!result.ok) { setError(result.error || "Couldn't save. Please try again."); operation.current = undefined; setConfirm(false); return; }
      onChange(remove ? existing! : result.data, remove); setEditing(null); setConfirm(false);
    } catch {
      setError(remove ? "Couldn't delete the shift. Check the connection and try again." : "Couldn't save the shift. Check the connection and try again.");
      setConfirm(false);
    } finally { lock.current = false; setBusy(false); }
  };
  const picker = (value: string, onChangeValue: (v: string) => void) => <select className={`w-full ${control}`} value={value} onChange={(e) => onChangeValue(e.target.value)}>
    <option value="">Nobody</option>{people.filter((p) => p.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
  </select>;
  if (!editing) return <section className="space-y-4">
    <p className="text-base text-ink-soft">Optional — without shifts the app works as today.</p>
    {!venueId ? <p className="text-base text-ink-soft">Choose a venue to create shifts.</p> : <>
      {!shifts.length && <p className="text-base text-ink-soft">No shifts have been created for this venue.</p>}
      {shifts.map((s) => <button type="button" key={s.id} onClick={() => open(s)} className="w-full text-left p-4 rounded-xl border border-line bg-surface tactile-1 hover:bg-sunken pressable cursor-pointer">
        {s.area && <span className="inline-block rounded-full bg-sunken px-2 py-1 text-xs text-ink-soft mb-2">{s.area}</span>}
        <strong className="block text-base text-ink">{s.name}</strong>
        <span className="block text-sm text-ink-soft">{dayLabel(s.daysOfWeek)} · {formatShiftHours(s)}</span>
        <span className="block text-sm text-ink-soft">Usually: {s.userName || personName(s.userId)}</span>
        {s.overrides.filter((o) => o.date >= today).sort((a, b) => a.date.localeCompare(b.date)).map((o) => <span key={o.date} className="block text-sm text-ink-soft">{dateLabel(o.date)}: {personName(o.userId)}</span>)}
      </button>)}
      <button type="button" className="min-h-12 w-full rounded-lg bg-gold-deep text-paper text-base font-semibold pressable cursor-pointer" onClick={() => open('new')}>+ New shift</button>
    </>}
  </section>;
  return <section aria-label={editing === 'new' ? 'New shift' : 'Edit shift'} className="space-y-4">
    <div className="flex items-center justify-between"><h3 className="text-xl font-semibold text-ink">{editing === 'new' ? 'New shift' : 'Edit shift'}</h3><button type="button" aria-label="Close" disabled={busy} onClick={() => setEditing(null)} className={`w-11 h-11 flex items-center justify-center ${button}`}><X className="w-5 h-5" /></button></div>
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-50">
        <label className="block text-sm text-ink-soft">Name<input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className={`block w-full ${control}`} /></label>
        <label className="block text-sm text-ink-soft">Area (type anything)<input maxLength={40} value={area} onChange={(e) => setArea(e.target.value)} className={`block w-full ${control}`} /></label>
        <div>
          <p className="text-sm text-ink-soft mb-2">Days</p>
          <div className="flex flex-wrap gap-2">
            {days.map((d, i) => {
              const selected = selectedDays.includes(i);
              return <button type="button" key={d} aria-pressed={selected}
                onClick={() => setDays((old) => old.includes(i) ? old.filter((v) => v !== i) : [...old, i])}
                className={`min-h-11 inline-flex items-center justify-center gap-2 rounded-full border px-3 text-base pressable cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${selected ? 'bg-ink text-paper border-ink font-semibold tactile-1' : 'bg-surface text-ink-soft border-line-control hover:bg-sunken'}`}>
                {selected && <Check aria-hidden="true" className="w-4 h-4" />}
                <span>{d}</span>
              </button>;
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3"><label className="text-sm text-ink-soft">From<input required type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`block w-full ${control}`} /></label><label className="text-sm text-ink-soft">Until<input required type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`block w-full ${control}`} /></label></div>
        {end < start && <p className="text-sm text-ink-soft">Ends next day</p>}
        <label className="block text-sm text-ink-soft">Usually on this shift{picker(person, setPerson)}</label>
        <div className="space-y-2"><p className="text-sm text-ink-soft">Changes for a date</p>
          {overrides.map((o) => <div key={o.date} className="flex items-center justify-between gap-2 text-base text-ink"><span>{dateLabel(o.date)} → {personName(o.userId)}</span><button type="button" aria-label={`Remove change for ${dateLabel(o.date)}`} className={button} onClick={() => setOverrides((old) => old.filter((v) => v.date !== o.date))}>×</button></div>)}
          {addingDate && <div className="space-y-2"><label className="block text-sm text-ink-soft">Date<input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className={`block w-full ${control}`} /></label><label className="block text-sm text-ink-soft">Person{picker(datePerson, setDatePerson)}</label><button type="button" disabled={!date || date < today || overrides.length >= 60} className={button} onClick={() => { setOverrides((old) => [...old.filter((o) => o.date !== date), { date, userId: datePerson || null }].sort((a, b) => a.date.localeCompare(b.date))); setAddingDate(false); }}>Add change</button></div>}
          {!addingDate && <button type="button" disabled={overrides.length >= 60} className={button} onClick={() => setAddingDate(true)}>+ Change for a date</button>}
        </div>
      </fieldset>
      {error && <p role="alert" className="text-base text-bad">{error}</p>}
      <button type="submit" disabled={busy} className="min-h-12 w-full rounded-lg bg-gold-deep text-paper text-base font-semibold pressable disabled:opacity-50 cursor-pointer">{busy ? 'Saving…' : 'Save'}</button>
      {editing !== 'new' && <button type="button" disabled={busy} onClick={() => { operation.current = undefined; setConfirm(true); }} className="min-h-11 px-3 rounded-lg border border-bad bg-surface text-bad text-base font-semibold hover:bg-bad-bg pressable disabled:opacity-50 cursor-pointer">Delete shift</button>}
    </form>
    <ConfirmModal isOpen={confirm} onClose={() => { if (!busy) setConfirm(false); }} onConfirm={() => void save(true)} title="Delete shift?" message="Its tasks will keep the shift’s hours and days as their own schedule." confirmText="Delete shift" isLoading={busy} />
  </section>;
}
