import React, { useRef, useState } from 'react';
import { VisitSheet, visitButton, visitRequest } from './FactoryVisitScreen';
import { calendarDate, displayDate, nextVisitDue, type Schedule, type ScheduleCompany, type ScheduleData } from '../lib/visitSchedule';
const input = 'min-h-11 w-full rounded-lg border border-line-control bg-sunken p-3 text-base text-ink focus-visible:ring-2 focus-visible:ring-gold';
export function VisitScheduleEditor({ company, data, isAdmin, onSaved, onClose }: { key?: string; company: ScheduleCompany; data: ScheduleData; isAdmin: boolean; onSaved(company: ScheduleCompany): void; onClose(): void }) {
  const [saved, setSaved] = useState(company);
  const [schedule, setSchedule] = useState<Schedule | null>(company.schedule);
  const [mashgiachIds, setMashgiachIds] = useState(company.mashgiachIds);
  const [coordinatorIds, setCoordinatorIds] = useState(company.coordinatorIds);
  const [mode, setMode] = useState(company.mute ? company.mute.until ? 'until' : 'off' : 'on');
  const [until, setUntil] = useState(company.mute?.until || data.today);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const next = nextVisitDue(schedule?.kind === 'dates' ? { ...schedule, dates: [...new Set(schedule.dates)].sort() } : schedule, data.settings.countFrom, company.lastVisit ? calendarDate(company.lastVisit.at, data.timeZone) : null);
  const update = (patch: object) => setSchedule(current => current && ({ ...current, ...patch } as Schedule));
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('');
    let current = saved;
    const put = async (suffix: string, body: object) => { const result = await visitRequest(`/api/inspections/schedule/companies/${encodeURIComponent(company.id)}${suffix}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); current = result.company; setSaved(current); onSaved(current); };
    try {
      const normalized = schedule?.kind === 'dates' ? { ...schedule, dates: [...new Set(schedule.dates)].sort() } : schedule;
      if (JSON.stringify(normalized) !== JSON.stringify(current.schedule)) await put('', { schedule: normalized });
      const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      if (isAdmin && (!same(mashgiachIds, current.mashgiachIds) || !same(coordinatorIds, current.coordinatorIds))) await put('/people', { mashgiachIds, coordinatorIds });
      const muteUntil = mode === 'until' ? until : null;
      if ((mode !== 'on') !== !!current.mute || mode !== 'on' && muteUntil !== current.mute?.until) await put('/mute', mode === 'on' ? { muted: false } : { muted: true, until: muteUntil });
      onClose();
    } catch { setError("Couldn't save. Check the connection and try again."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <VisitSheet title="Visit schedule" onClose={onClose}><p dir="auto" className="whitespace-pre-wrap break-words text-base">{company.name}</p><form className="space-y-6" onSubmit={save}><fieldset disabled={busy} className="space-y-4"><legend>How often</legend><select aria-label="How often" className={input} value={schedule?.kind || 'none'} onChange={e => setSchedule(e.target.value === 'none' ? null : e.target.value === 'dates' ? { kind: 'dates', dates: [data.today] } : e.target.value === 'every' ? { kind: 'every', n: 1, unit: 'day', start: data.today } : { kind: 'per_year', n: 1, start: data.today })}><option value="none">No schedule</option><option value="every">Every … days|weeks|months</option><option value="per_year">… times a year</option><option value="dates">On these dates</option></select>
    {schedule && schedule.kind !== 'dates' && <><label className="block">{schedule.kind === 'every' ? 'Every' : 'Times a year'}<input aria-label="Number" type="number" required min={1} max={schedule.kind === 'every' ? 365 : 52} className={input} value={schedule.n} onChange={e => update({ n: Number(e.target.value) })} /></label>{schedule.kind === 'every' && <label className="block">Time unit<select className={input} value={schedule.unit} onChange={e => update({ unit: e.target.value })}><option value="day">days</option><option value="week">weeks</option><option value="month">months</option></select></label>}<label className="block">Starting from<input required type="date" className={input} value={schedule.start} onChange={e => update({ start: e.target.value })} /></label></>}
    {schedule?.kind === 'dates' && <div className="space-y-2">{schedule.dates.map((date, i) => <div key={i} className="flex gap-2"><input aria-label={`Visit date ${i + 1}`} required type="date" className={input} value={date} onChange={e => update({ dates: schedule.dates.map((d, j) => j === i ? e.target.value : d) })} /><button type="button" className={visitButton} disabled={schedule.dates.length === 1} onClick={() => update({ dates: schedule.dates.filter((_, j) => i !== j) })}>Remove</button></div>)}<button type="button" className={visitButton} disabled={schedule.dates.length >= 100} onClick={() => update({ dates: [...schedule.dates, data.today] })}>Add date</button></div>}
    <p>Next visit due: {next ? displayDate(next) : 'No schedule'}</p></fieldset>
    {isAdmin && <fieldset disabled={busy} className="space-y-4"><legend>Who's responsible</legend>{(['mashgichim', 'coordinators'] as const).map(role => <div key={role}><h3>{role === 'mashgichim' ? 'Mashgichim' : 'Coordinators'}</h3>{data.people[role].map(person => { const ids = role === 'mashgichim' ? mashgiachIds : coordinatorIds, set = role === 'mashgichim' ? setMashgiachIds : setCoordinatorIds; return <label key={person.id} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={ids.includes(person.id)} disabled={!ids.includes(person.id) && ids.length >= 20} onChange={e => set(e.target.checked ? [...ids, person.id] : ids.filter(id => id !== person.id))} />{person.name}</label>; })}</div>)}</fieldset>}
    <fieldset disabled={busy} className="space-y-2"><legend>Overdue alerts</legend>{[['on', 'On'], ['off', 'Off'], ['until', 'Off until']].map(([value, label]) => <label key={value} className="flex min-h-11 items-center gap-2"><input type="radio" name="alerts" checked={mode === value} onChange={() => setMode(value)} />{label}</label>)}{mode === 'until' && <input aria-label="Alerts off until" type="date" required className={input} value={until} onChange={e => setUntil(e.target.value)} />}<p className="text-base text-ink-soft">Turning alerts off keeps the overdue mark; it only stops notifications.</p></fieldset>{error && <p role="alert" className="text-bad">{error}</p>}<button type="submit" disabled={busy} className="pressable min-h-12 w-full rounded-xl bg-gold-deep p-3 text-base font-semibold text-paper disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button></form></VisitSheet>;
}
