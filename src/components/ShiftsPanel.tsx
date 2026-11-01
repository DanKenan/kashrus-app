import React, { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Shift, ShiftDay, ShiftOverride } from '../types';
import { formatShiftHours, shiftDayOf, shiftWeekdays, shiftVariesByDay, shiftIsUpcoming } from '../lib/shifts';
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
  createOnly?: boolean;
  onCancel?: () => void;
  onChange: (shift: Shift, deleted?: boolean) => void;
}
export function ShiftsPanel({ shifts, venueId, timeZone, people, onChange, createOnly = false, onCancel }: Props) {
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  const [savedWeekly, setSavedWeekly] = useState(true);
  const [oneTimeDate, setOneTimeDate] = useState('');
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [week, setWeek] = useState<ShiftDay[]>(Array.from({ length: 7 }, () => ({ on: true })));
  const [hoursDay, setHoursDay] = useState<number | null>(null);
  const changeDay = (i: number, update: Partial<ShiftDay>) => setWeek((old) => old.map((d, w) => w === i ? { ...d, ...update } : d));
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
    setSavedWeekly(!s?.oneTimeDate); setOneTimeDate(s?.oneTimeDate || today);
    setEditing(shift); setName(s?.name || ''); setArea(s?.area || '');
    setWeek(Array.from({ length: 7 }, (_, i) => s ? shiftDayOf(s, i) : { on: true })); setHoursDay(null);
    setStart(timeValue(s?.startMinutes ?? 480)); setEnd(timeValue(s?.endMinutes ?? 1080));
    setPerson(s?.userId || ''); setOverrides((s?.overrides || []).filter((o) => o.date >= today));
    setDate(addDays(today, 1)); setDatePerson(''); setAddingDate(false); setError('');
    baseline.current = captureEditBaseline(); operation.current = undefined;
  };
  useEffect(() => { if (createOnly) open('new'); }, [createOnly]);
  const close = () => { setEditing(null); onCancel?.(); };
  const save = async (remove = false) => {
    if (lock.current || !editing) return;
    if (!remove && (!name.trim() || (savedWeekly && !week.some((d) => d.on)) || (!savedWeekly && (!oneTimeDate || oneTimeDate < today)) || start === end || (savedWeekly && week.some((d) => d.on && d.startMinutes !== undefined && d.startMinutes === d.endMinutes)))) {
      setError('Enter a name, select at least one day, and choose different From and Until times.'); return;
    }
    lock.current = true; setBusy(true); setError('');
    try {
      operation.current ||= newActionId();
      const existing = editing === 'new' ? null : editing;
      const result = await apiWrite<Shift>(existing ? `/api/shifts/${encodeURIComponent(existing.id)}` : '/api/shifts', {
        method: remove ? 'DELETE' : existing ? 'PUT' : 'POST',
        expectedVersion: existing ? baseline.current : undefined, operationId: operation.current,
        body: remove ? undefined : JSON.stringify({ venueId, name: name.trim(), area: area.trim(), days: week, oneTimeDate: savedWeekly ? null : oneTimeDate,
          startMinutes: minutes(start), endMinutes: minutes(end), userId: person || null,
          overrides: savedWeekly ? overrides.filter((o) => o.date >= today) : [] }),
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
  const upcoming = shifts.filter((s) => shiftIsUpcoming(s, today));
  const ordered = [...upcoming.filter((s) => !s.oneTimeDate), ...upcoming.filter((s) => s.oneTimeDate).sort((a, b) => a.oneTimeDate!.localeCompare(b.oneTimeDate!))];
  if (!editing && createOnly) return null;
  if (!editing) return <section className="space-y-4">
    <p className="text-base text-ink-soft">Optional — without shifts the app works as today.</p>
    {!venueId ? <p className="text-base text-ink-soft">Choose a venue to create shifts.</p> : <>
      {!upcoming.length && <p className="text-base text-ink-soft">No shifts have been created for this venue.</p>}
      {ordered.map((s, i) => <React.Fragment key={s.id}>
      {s.oneTimeDate && !ordered[i - 1]?.oneTimeDate && <h4 className="text-sm font-semibold text-ink">One-time</h4>}
      <button type="button" key={s.id} onClick={() => open(s)} className="w-full text-left p-4 rounded-xl border border-line bg-surface tactile-1 hover:bg-sunken pressable cursor-pointer">
        {s.area && <span className="inline-block rounded-full bg-sunken px-2 py-1 text-xs text-ink-soft mb-2">{s.area}</span>}
        <strong className="block text-base text-ink">{s.name}</strong>
        <span className="block text-sm text-ink-soft">{s.oneTimeDate ? dateLabel(s.oneTimeDate) : dayLabel(shiftWeekdays(s))} · {formatShiftHours(s)}</span>
        {!s.oneTimeDate && shiftVariesByDay(s) && <span className="block text-xs text-ink-soft">Varies by day</span>}
        <span className="block text-sm text-ink-soft">{s.oneTimeDate ? 'Person' : 'Usually'}: {s.userName || personName(s.userId)}</span>
        {s.overrides.filter((o) => o.date >= today).sort((a, b) => a.date.localeCompare(b.date)).map((o) => <span key={o.date} className="block text-sm text-ink-soft">{dateLabel(o.date)}: {personName(o.userId)}</span>)}
      </button></React.Fragment>)}
      <button type="button" className="min-h-12 w-full rounded-lg bg-gold-deep text-paper text-base font-semibold pressable cursor-pointer" onClick={() => open('new')}>+ New shift</button>
    </>}
  </section>;
  return <section aria-label={editing === 'new' ? 'New shift' : 'Edit shift'} className="space-y-4">
    <div className="flex items-center justify-between"><h3 className="text-xl font-semibold text-ink">{editing === 'new' ? 'New shift' : 'Edit shift'}</h3><button type="button" aria-label="Close" disabled={busy} onClick={close} className={`w-11 h-11 flex items-center justify-center ${button}`}><X className="w-5 h-5" /></button></div>
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-50">
        <label className="block text-sm text-ink-soft">Name<input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className={`block w-full ${control}`} /></label>
        <label className="block text-sm text-ink-soft">Area (type anything)<input maxLength={40} value={area} onChange={(e) => setArea(e.target.value)} className={`block w-full ${control}`} /></label>
        <p className="text-sm text-ink-soft">General hours</p>
        <div className="grid grid-cols-2 gap-3"><label className="text-sm text-ink-soft">From<input required type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`block w-full ${control}`} /></label><label className="text-sm text-ink-soft">Until<input required type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`block w-full ${control}`} /></label></div>
        {end < start && <p className="text-sm text-ink-soft">Ends next day</p>}
        <label className="block text-sm text-ink-soft">Usually on this shift{picker(person, setPerson)}</label>
        {savedWeekly ? <section aria-label="Week" className="space-y-2">
          <h4 className="text-sm font-semibold text-ink">Week</h4>
          {days.map((name, i) => {
            const day = week[i], ownHours = day.startMinutes !== undefined;
            const a = day.startMinutes ?? minutes(start), b = day.endMinutes ?? minutes(end);
            const differs = day.userId !== undefined || ownHours;
            return <div key={name} role="group" aria-label={name} className={`p-2 rounded-lg border border-line ${day.on ? 'bg-surface' : 'bg-sunken'}`}>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 items-center">
                <button type="button" role="switch" aria-label={`${name} shift`} aria-checked={day.on}
                  onClick={() => changeDay(i, { on: !day.on })}
                  className={`${differs && day.on ? '' : 'row-span-2'} self-start min-h-11 min-w-16 px-2 rounded-lg border inline-flex items-center justify-center gap-1 text-sm pressable cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${day.on ? 'bg-ink text-paper border-ink font-semibold' : 'bg-surface text-ink-soft border-line-control opacity-60'}`}>
                  {day.on && <Check aria-hidden="true" className="w-4 h-4" />}{name}
                </button>
                {day.on && <>
                  <select aria-label={`${name} person`} value={day.userId === undefined ? '' : day.userId === null ? '__nobody__' : day.userId}
                    onChange={(e) => changeDay(i, { userId: e.target.value === '' ? undefined : e.target.value === '__nobody__' ? null : e.target.value })}
                    className={`w-full min-w-0 ${day.userId === undefined ? control.replace('text-ink', 'text-ink-soft') : control} ${day.userId === undefined ? 'font-normal' : 'font-semibold'}`}>
                    <option value="">Usual: {personName(person || null)}</option><option value="__nobody__">Nobody</option>
                    {people.filter((p) => p.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <button type="button" aria-label={`${name} hours`} aria-expanded={hoursDay === i} onClick={() => setHoursDay(hoursDay === i ? null : i)}
                    className={`col-start-2 row-start-2 min-h-11 px-2 rounded-lg border border-line-control text-left text-sm pressable cursor-pointer hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${ownHours ? 'text-ink font-semibold' : 'text-ink-soft'}`}>
                    {formatShiftHours({ startMinutes: a, endMinutes: b } as Shift)}
                  </button>
                </>}
                {day.on && differs && <button type="button" onClick={() => { setWeek((old) => old.map((d, w) => w === i ? { on: d.on } : d)); setHoursDay(null); }} className="col-start-1 row-start-2 w-16 min-h-11 px-1 text-xs text-ink-soft underline pressable cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">Same as general</button>}
              </div>
              {day.on && hoursDay === i && <div className="grid grid-cols-2 gap-2 mt-2">
                <label className="text-xs text-ink-soft">From<input aria-label={`${name} From`} required type="time" value={timeValue(a)} onChange={(e) => { if (e.target.value) changeDay(i, { startMinutes: minutes(e.target.value), endMinutes: b }); }} className={`block w-full ${control}`} /></label>
                <label className="text-xs text-ink-soft">Until<input aria-label={`${name} Until`} required type="time" value={timeValue(b)} onChange={(e) => { if (e.target.value) changeDay(i, { startMinutes: a, endMinutes: minutes(e.target.value) }); }} className={`block w-full ${control}`} /></label>
                {b < a && <p className="col-span-2 text-xs text-ink-soft">Ends next day</p>}
              </div>}
            </div>;
          })}
        </section> : <label className="block text-sm text-ink-soft">Date<input required type="date" min={today} value={oneTimeDate} onChange={(e) => setOneTimeDate(e.target.value)} className={`block w-full ${control}`} /></label>}
        {savedWeekly && <div className="space-y-2"><p className="text-sm text-ink-soft">Changes for a date</p>
          {overrides.map((o) => <div key={o.date} className="flex items-center justify-between gap-2 text-base text-ink"><span>{dateLabel(o.date)} → {personName(o.userId)}</span><button type="button" aria-label={`Remove change for ${dateLabel(o.date)}`} className={button} onClick={() => setOverrides((old) => old.filter((v) => v.date !== o.date))}>×</button></div>)}
          {addingDate && <div className="space-y-2"><label className="block text-sm text-ink-soft">Date<input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className={`block w-full ${control}`} /></label><label className="block text-sm text-ink-soft">Person{picker(datePerson, setDatePerson)}</label><button type="button" disabled={!date || date < today || overrides.length >= 60} className={button} onClick={() => { setOverrides((old) => [...old.filter((o) => o.date !== date), { date, userId: datePerson || null }].sort((a, b) => a.date.localeCompare(b.date))); setAddingDate(false); }}>Add change</button></div>}
          {!addingDate && <button type="button" disabled={overrides.length >= 60} className={button} onClick={() => setAddingDate(true)}>+ Change for a date</button>}
        </div>}
        <button type="button" role="switch" aria-label="Save for next weeks" aria-checked={savedWeekly} onClick={() => setSavedWeekly((v) => !v)} className={`w-full flex items-center gap-2 ${button}`}><span aria-hidden="true">{savedWeekly ? '✓' : '○'}</span>Save for next weeks<span className="ml-auto text-sm">{savedWeekly ? 'On' : 'Off'}</span></button>
      </fieldset>
      {error && <p role="alert" className="text-base text-bad">{error}</p>}
      <button type="submit" disabled={busy} className="min-h-12 w-full rounded-lg bg-gold-deep text-paper text-base font-semibold pressable disabled:opacity-50 cursor-pointer">{busy ? 'Saving…' : 'Save'}</button>
      {editing !== 'new' && <button type="button" disabled={busy} onClick={() => { operation.current = undefined; setConfirm(true); }} className="min-h-11 px-3 rounded-lg border border-bad bg-surface text-bad text-base font-semibold hover:bg-bad-bg pressable disabled:opacity-50 cursor-pointer">Delete shift</button>}
    </form>
    <ConfirmModal isOpen={confirm} onClose={() => { if (!busy) setConfirm(false); }} onConfirm={() => void save(true)} title="Delete shift?" message="Its tasks will keep the shift’s hours and days as their own schedule." confirmText="Delete shift" isLoading={busy} />
  </section>;
}
