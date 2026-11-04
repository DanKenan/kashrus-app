import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import type { Shift, ShiftDay, ShiftOverride, Task } from '../types';
import { formatShiftHours, isBuiltinShiftId, shiftDayOf, shiftWeekdays, shiftVariesByDay, shiftIsUpcoming, shiftUserIds, shiftPeopleSummary, shiftEditableFields, sortShiftsByStart, venueShifts } from '../lib/shifts';
import { apiWrite, captureEditBaseline, newActionId } from '../lib/api';
import { addDays, workDateIn } from '../lib/workday';
import { ConfirmModal } from './ConfirmModal';
import { ShiftHoursBar } from './ShiftHoursBar';
import { personAvatar } from '../lib/personAvatar';

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
function weekdayPeople(shift: Shift): string {
  if (shift.oneTimeDate) return '';
  return days.flatMap((label, weekday) => {
    const day = shiftDayOf(shift, weekday);
    if (!day.on || day.userIds === undefined) return [];
    const names = shift.days?.[weekday]?.userNames || (shift.dayUserNames?.[weekday] ? [shift.dayUserNames[weekday]!] : []);
    const name = shiftPeopleSummary(shiftUserIds(day).map((_, i) => names[i] || 'Unavailable person'));
    return [`${label}: ${name}`];
  }).join(' · ');
}
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
interface Props {
  shifts: Shift[];
  tasks?: Task[];
  venueId: string;
  timeZone: string;
  people: Array<{ id?: string; name: string; email?: string }>;
  createOnly?: boolean;
  initialShift?: Shift;
  agencyId?: string;
  onCancel?: () => void;
  onChange: (shift: Shift, deleted?: boolean) => void;
}
export function ShiftsPanel({ shifts, tasks = [], venueId, timeZone, people, onChange, createOnly = false, initialShift, agencyId = shifts.find((s) => s.venueId === venueId)?.agencyId || 'agency-hkc', onCancel }: Props) {
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  const [savedWeekly, setSavedWeekly] = useState(true);
  const [oneTimeDate, setOneTimeDate] = useState('');
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [week, setWeek] = useState<ShiftDay[]>(Array.from({ length: 7 }, () => ({ on: true })));
  const [hoursDay, setHoursDay] = useState<number | null>(null);
  const [peopleDay, setPeopleDay] = useState<number | null>(null);
  const changeDay = (i: number, update: Partial<ShiftDay>) => setWeek((old) => old.map((d, w) => w === i ? { ...d, ...update } : d));
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('18:00');
  const [person, setPerson] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<ShiftOverride[]>([]);
  const [addingDate, setAddingDate] = useState(false);
  const [date, setDate] = useState('');
  const [datePerson, setDatePerson] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const baseline = useRef<number | undefined>(undefined);
  const operation = useRef<string | undefined>(undefined);
  const lock = useRef(false);
  const today = workDateIn(timeZone, new Date());
  const personName = (id: string | null) => !id ? 'Nobody' : people.find((p) => p.id === id)?.name || 'Unavailable person';
  const peopleNames = (ids: string[]) => ids.map(personName);
  const open = (shift: Shift | 'new') => {
    const s = shift === 'new' ? null : shift;
    setSavedWeekly(!s?.oneTimeDate); setOneTimeDate(s?.oneTimeDate || today);
    setEditing(shift); setName(s?.name || ''); setArea(s?.area || '');
    setWeek(Array.from({ length: 7 }, (_, i) => s ? shiftDayOf(s, i) : { on: true })); setHoursDay(null); setPeopleDay(null);
    setStart(timeValue(s?.startMinutes ?? 480)); setEnd(timeValue(s?.endMinutes ?? 1080));
    setPerson(shiftUserIds(s)); setOverrides((s?.overrides || []).filter((o) => o.date >= today));
    setDate(addDays(today, 1)); setDatePerson([]); setAddingDate(false); setError('');
    baseline.current = captureEditBaseline(); operation.current = undefined;
  };
  useEffect(() => { if (createOnly) open(initialShift || 'new'); }, [createOnly, initialShift]);
  const close = () => { setEditing(null); onCancel?.(); };
  const save = async (remove = false) => {
    if (lock.current || !editing) return;
    if (!remove && (!name.trim() || (savedWeekly && !week.some((d) => d.on)) || (!savedWeekly && (!oneTimeDate || oneTimeDate < today)) || start === end || (savedWeekly && week.some((d) => d.on && d.startMinutes !== undefined && d.startMinutes === d.endMinutes)))) {
      setError('Enter a name, select at least one day, and choose different From and Until times.'); return;
    }
    const existing = editing === 'new' ? null : editing;
    const definition = { venueId, name: name.trim(), area: area.trim(), days: week, oneTimeDate: savedWeekly ? null : oneTimeDate,
      startMinutes: minutes(start), endMinutes: minutes(end), userIds: person, userId: person[0] || null,
      overrides: savedWeekly ? overrides.filter((o) => o.date >= today) : [] };
    if (!remove && existing && JSON.stringify(shiftEditableFields({ ...existing, ...definition }, today)) === JSON.stringify(shiftEditableFields(existing, today))) {
      close(); return;
    }
    lock.current = true; setBusy(true); setError('');
    try {
      operation.current ||= newActionId();
      const result = await apiWrite<Shift>(existing ? `/api/shifts/${encodeURIComponent(existing.id)}` : '/api/shifts', {
        method: remove ? 'DELETE' : existing ? 'PUT' : 'POST',
        expectedVersion: existing ? baseline.current : undefined, operationId: operation.current,
        body: JSON.stringify(remove ? { venueId } : definition),
      });
      if (!result.ok) { setError(result.error || "Couldn't save. Please try again."); operation.current = undefined; setConfirm(false); return; }
      onChange(remove ? existing! : result.data, remove); setEditing(null); setConfirm(false);
    } catch {
      setError(remove ? "Couldn't delete the shift. Check the connection and try again." : "Couldn't save the shift. Check the connection and try again.");
      setConfirm(false);
    } finally { lock.current = false; setBusy(false); }
  };
  const picker = (label: string, value: string[], onChangeValue: (v: string[]) => void, avatars = false) => <div role="group" aria-label={label} className={avatars ? "shift-editor-people" : "flex flex-wrap gap-2 max-h-48 overflow-y-auto"}>
    <button type="button" aria-pressed={!value.length} className={`${!value.length ? button.replace('border-line-control', 'border-gold') : button} ${avatars ? 'shift-editor-person' : ''}`} onClick={() => onChangeValue([])}>{avatars && <span aria-hidden="true" className="task-who-avatar">○</span>}Nobody{avatars && !value.length && <span aria-hidden="true" className="shift-editor-person-check">✓</span>}</button>
    {people.filter((p) => p.id).map((p) => <button key={p.id} type="button" aria-pressed={value.includes(p.id!)} className={`${value.includes(p.id!) ? button.replace('border-line-control', 'border-gold') : button} ${avatars ? 'shift-editor-person' : ''}`}
      onClick={() => onChangeValue(value.includes(p.id!) ? value.filter((id) => id !== p.id) : [...value, p.id!])}>
      {avatars && <span className="task-who-avatar" style={personAvatar(p.email || p.name)} aria-hidden="true">{p.name.slice(0, 1)}</span>}
      {!avatars && value.includes(p.id!) && <Check aria-hidden="true" className="inline w-4 h-4 mr-1" />}{p.name}{avatars && value.includes(p.id!) && <span aria-hidden="true" className="shift-editor-person-check">✓</span>}
    </button>)}
  </div>;
  const upcoming = venueShifts(shifts, venueId, agencyId).filter((s) => shiftIsUpcoming(s, today));
  const ordered = sortShiftsByStart(upcoming);
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
        <span className="block text-sm text-ink-soft">{s.oneTimeDate ? 'People' : 'Usually'}: {shiftPeopleSummary(shiftUserIds(s).map((id, i) => s.userNames?.[i] || (i === 0 ? s.userName : undefined) || personName(id)))}</span>
        {weekdayPeople(s) && <span className="block truncate text-sm text-ink-soft" title={weekdayPeople(s)}>{weekdayPeople(s)}</span>}
        {s.overrides.filter((o) => o.date >= today).sort((a, b) => a.date.localeCompare(b.date)).map((o) => <span key={o.date} className="block text-sm text-ink-soft">{dateLabel(o.date)}: {shiftPeopleSummary(peopleNames(shiftUserIds(o)))}</span>)}
      </button></React.Fragment>)}
      <button type="button" className="min-h-12 w-full rounded-lg bg-gold-deep text-paper text-base font-semibold pressable cursor-pointer" onClick={() => open('new')}>+ New shift</button>
    </>}
  </section>;
  const existing = editing === 'new' ? undefined : editing;
  const usedBy = existing ? tasks.filter((task) => task.venueId === venueId && (task.shiftId === existing.id
    || (isBuiltinShiftId(existing.id) && task.shiftId === existing.id.split(':')[0]))).length : 0;
  const draftShift: Shift = { id: existing?.id || 'new', venueId, agencyId, name, area, days: week,
    startMinutes: minutes(start), endMinutes: minutes(end), userIds: person, userId: person[0] || null, overrides, createdAt: existing?.createdAt || '' };
  return <section role={createOnly ? undefined : 'dialog'} aria-modal={createOnly ? undefined : true} aria-label={editing === 'new' ? 'New shift' : 'Edit shift'} className="shift-editor-overlay" onKeyDown={(e) => { if (e.key === 'Escape' && !busy && !confirm) { e.stopPropagation(); close(); } }}>
    <div className="shift-editor-sheet">
    <header className="shift-editor-header">
      <div aria-hidden="true" className="task-people-grabber" />
      <div className="shift-editor-heading"><div className="min-w-0"><h3>{existing ? `Edit ${existing.name} shift` : 'New shift'}</h3><p>{existing && isBuiltinShiftId(existing.id) ? 'Built in' : 'Custom'} · used by {usedBy} tasks</p></div><button type="button" aria-label="Close" disabled={busy} onClick={close} className="shift-editor-close pressable disabled:opacity-50"><X aria-hidden="true" className="w-5 h-5" /></button></div>
      {editing !== 'new' && <button type="button" disabled={busy} onClick={() => { operation.current = undefined; setConfirm(true); }} className="min-h-11 px-3 rounded-lg border border-bad bg-surface text-bad text-sm font-semibold hover:bg-bad-bg pressable disabled:opacity-50 cursor-pointer">Delete shift</button>}
    </header>
    <form className="shift-editor-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="shift-editor-body task-form-body">
      <fieldset disabled={busy} className="task-form-current-card task-form-what space-y-4 disabled:opacity-50">
        <label className="block text-sm text-ink-soft">Name<input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className={`block w-full ${control}`} /></label>
        <label className="block text-sm text-ink-soft">Area (type anything)<input maxLength={40} value={area} onChange={(e) => setArea(e.target.value)} className={`block w-full ${control}`} /></label>
        <section aria-label="General hours" className="space-y-2">
          <h4 className="shift-editor-label">Hours</h4>
          <ShiftHoursBar shift={draftShift} readOnly={busy} onSaved={() => {}} onDraftChange={(hours) => { setStart(timeValue(hours.startMinutes)); setEnd(timeValue(hours.endMinutes)); }} />
          <details className="shift-editor-exact"><summary>Type exact times<ChevronDown aria-hidden="true" className="w-4 h-4" /></summary>
          <div className="grid grid-cols-2 gap-3"><label className="text-sm text-ink-soft">From<input required type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`block w-full ${control}`} /></label><label className="text-sm text-ink-soft">Until<input required type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`block w-full ${control}`} /></label></div>
          </details>
          {end < start && <p className="text-sm text-ink-soft">Ends next day</p>}
        </section>
        {savedWeekly ? <section aria-label="Week" className="space-y-2">
          <h4 className="shift-editor-label">Days</h4>
          <div className="shift-editor-days">{days.map((label, i) => <button key={label} type="button" role="switch" aria-label={`${label} shift`} aria-checked={week[i].on} onClick={() => changeDay(i, { on: !week[i].on })} className="pressable">{label[0]}</button>)}</div>
          <p className="text-xs text-ink-soft">Repeats every week</p>
        </section> : <label className="block text-sm text-ink-soft">Date<input required type="date" min={today} value={oneTimeDate} onChange={(e) => setOneTimeDate(e.target.value)} className={`block w-full ${control}`} /></label>}
        <section className="space-y-2"><h4 className="shift-editor-label">Usual mashgiach<span>optional</span></h4>{picker('Usual people', person, setPerson, true)}</section>
        {savedWeekly && <details key={existing?.id || 'new'} open={!!existing && (shiftVariesByDay(existing) || existing.overrides.some((o) => o.date >= today))} className="shift-editor-differences">
          <summary>Different on some days<ChevronDown aria-hidden="true" className="w-4 h-4" /></summary>
          <section aria-label="Per-day settings" className="space-y-2">
          <h4 className="text-sm font-semibold text-ink">Week</h4>
          {days.map((name, i) => {
            const day = week[i], ownHours = day.startMinutes !== undefined;
            const a = day.startMinutes ?? minutes(start), b = day.endMinutes ?? minutes(end);
            const differs = day.userIds !== undefined || ownHours;
            return <div key={name} role="group" aria-label={name} className={`p-2 rounded-lg border border-line ${day.on ? 'bg-surface' : 'bg-sunken'}`}>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 items-center">
                <span className="self-start min-h-11 min-w-16 px-2 inline-flex items-center text-sm text-ink-soft">{name}</span>
                {day.on && <>
                  <button type="button" aria-label={`${name} people`} aria-expanded={peopleDay === i} onClick={() => setPeopleDay(peopleDay === i ? null : i)} className={`w-full min-w-0 text-left ${button}`}>
                    {day.userIds === undefined ? 'Usual: ' : ''}{shiftPeopleSummary(peopleNames(day.userIds === undefined ? person : shiftUserIds(day)))}
                  </button>
                  <button type="button" aria-label={`${name} hours`} aria-expanded={hoursDay === i} onClick={() => setHoursDay(hoursDay === i ? null : i)}
                    className={`col-start-2 row-start-2 min-h-11 px-2 rounded-lg border border-line-control text-left text-sm pressable cursor-pointer hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${ownHours ? 'text-ink font-semibold' : 'text-ink-soft'}`}>
                    {formatShiftHours({ startMinutes: a, endMinutes: b } as Shift)}
                  </button>
                </>}
                {day.on && differs && <button type="button" onClick={() => { setWeek((old) => old.map((d, w) => w === i ? { on: d.on } : d)); setHoursDay(null); setPeopleDay(null); }} className="col-start-1 row-start-2 w-16 min-h-11 px-1 text-xs text-ink-soft underline pressable cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">Same as general</button>}
              </div>
              {day.on && peopleDay === i && <div className="mt-2">{picker(`${name} people choices`, day.userIds === undefined ? person : shiftUserIds(day), (userIds) => changeDay(i, { userIds, userId: userIds[0] || null }))}</div>}
              {day.on && hoursDay === i && <div className="grid grid-cols-2 gap-2 mt-2">
                <label className="text-xs text-ink-soft">From<input aria-label={`${name} From`} required type="time" value={timeValue(a)} onChange={(e) => { if (e.target.value) changeDay(i, { startMinutes: minutes(e.target.value), endMinutes: b }); }} className={`block w-full ${control}`} /></label>
                <label className="text-xs text-ink-soft">Until<input aria-label={`${name} Until`} required type="time" value={timeValue(b)} onChange={(e) => { if (e.target.value) changeDay(i, { startMinutes: a, endMinutes: minutes(e.target.value) }); }} className={`block w-full ${control}`} /></label>
                {b < a && <p className="col-span-2 text-xs text-ink-soft">Ends next day</p>}
              </div>}
            </div>;
          })}
          </section>
        <div className="space-y-2"><p className="text-sm text-ink-soft">Changes for a date</p>
          {overrides.map((o) => <div key={o.date} className="flex items-center justify-between gap-2 text-base text-ink"><span>{dateLabel(o.date)} → {shiftPeopleSummary(peopleNames(shiftUserIds(o)))}</span><button type="button" aria-label={`Remove change for ${dateLabel(o.date)}`} className={button} onClick={() => setOverrides((old) => old.filter((v) => v.date !== o.date))}>×</button></div>)}
          {addingDate && <div className="space-y-2"><label className="block text-sm text-ink-soft">Date<input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className={`block w-full ${control}`} /></label><div className="space-y-2"><p className="text-sm text-ink-soft">People</p>{picker('People for date', datePerson, setDatePerson)}</div><button type="button" disabled={!date || date < today || overrides.length >= 60} className={button} onClick={() => { setOverrides((old) => [...old.filter((o) => o.date !== date), { date, userIds: datePerson, userId: datePerson[0] || null }].sort((a, b) => a.date.localeCompare(b.date))); setAddingDate(false); }}>Add change</button></div>}
          {!addingDate && <button type="button" disabled={overrides.length >= 60} className={button} onClick={() => setAddingDate(true)}>+ Change for a date</button>}
        </div>
        </details>}
        <button type="button" role="switch" aria-label="Save for next weeks" disabled={editing !== 'new'} aria-checked={savedWeekly} onClick={() => setSavedWeekly((v) => !v)} className={`w-full flex items-center gap-2 ${button}`}><span aria-hidden="true">{savedWeekly ? '✓' : '○'}</span>Save for next weeks<span className="ml-auto text-sm">{savedWeekly ? 'On' : 'Off'}</span></button>
        {editing !== 'new' && <p className="text-sm text-ink-soft">Can't change after the shift is created.</p>}
      </fieldset>
      {error && <p role="alert" className="text-base text-bad">{error}</p>}
      </div>
      <div className="shift-editor-footer task-form-footer">
      <button type="submit" disabled={busy} className="task-form-primary pressable disabled:opacity-50">{busy ? 'Saving…' : '✓ Save shift'}</button>
      </div>
    </form>
    </div>
    <ConfirmModal isOpen={confirm} onClose={() => { if (!busy) setConfirm(false); }} onConfirm={() => void save(true)} title="Delete shift?" message="Its tasks will keep the shift’s hours and days as their own schedule." confirmText="Delete shift" isLoading={busy} />
  </section>;
}
