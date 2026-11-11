// Calendar arithmetic deliberately uses UTC only as a date counter, never as an agency clock.
export type Schedule = { kind: 'every'; n: number; unit: 'day' | 'week' | 'month'; start: string } | { kind: 'per_year'; n: number; start: string } | { kind: 'dates'; dates: string[] };
export type Settings = { countFrom: 'last_visit' | 'planned'; mashgichimSeeAll: boolean };
export type LastVisit = { at: string; reportId: string; mashgiachName: string };
export type Mute = { until: string | null; by: string; at: string };
export type Alert = { dueDate: string; count: number; lastSentDate: string };
export const defaultSettings: Settings = { countFrom: 'last_visit', mashgichimSeeAll: true };
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && value >= '0001-01-01' && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export function validateSchedule(value: unknown): Schedule | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid schedule');
  const v = value as any;
  const keys = v.kind === 'dates' ? ['kind', 'dates'] : v.kind === 'every' ? ['kind', 'n', 'unit', 'start'] : ['kind', 'n', 'start'];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) throw Error('Invalid schedule');
  if (v.kind === 'dates') {
    if (!Array.isArray(v.dates) || v.dates.length < 1 || v.dates.length > 100 || !v.dates.every((d: unknown, i: number) => isDate(d) && (!i || d > v.dates[i - 1]))) throw Error('Invalid dates');
    return { kind: 'dates', dates: [...v.dates] };
  }
  if (!['every', 'per_year'].includes(v.kind) || !isDate(v.start) || !Number.isInteger(v.n) || v.n < 1 || v.n > (v.kind === 'every' ? 365 : 52) || (v.kind === 'every' && !['day', 'week', 'month'].includes(v.unit))) throw Error('Invalid schedule');
  return v.kind === 'every' ? { kind: v.kind, n: v.n, unit: v.unit, start: v.start } : { kind: v.kind, n: v.n, start: v.start };
}
export function calendarDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function step(s: Exclude<Schedule, { kind: 'dates' }>) {
  if (s.kind === 'per_year') return { months: 12 / s.n, days: 0 };
  return { months: s.unit === 'month' ? s.n : 0, days: s.unit === 'day' ? s.n : s.unit === 'week' ? 7 * s.n : 0 };
}
function advance(start: string, months: number, days: number, k: number) {
  if (!months) return addDays(start, days * k);
  const date = new Date(start + 'T00:00:00Z'), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months * k);
  const end = new Date(date); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  date.setUTCDate(Math.min(day, end.getUTCDate()));
  return date.toISOString().slice(0, 10);
}
export function yearlyOccurrence(start: string, n: number, k: number): string {
  const y = Math.floor(k / n), j = k % n;
  const base = advance(start, 12, 0, y), end = advance(start, 12, 0, y + 1);
  return addDays(base, Math.round(j * daysBetween(base, end) / n));
}
export function dueState(schedule: Schedule | null, countFrom: Settings['countFrom'], lastVisit: LastVisit | null, today: string, timeZone: string) {
  const last = lastVisit ? calendarDate(lastVisit.at, timeZone) : null;
  let nextDue: string | null = null;
  if (schedule?.kind === 'dates') nextDue = schedule.dates.find(d => !last || d > last) || null;
  else if (schedule?.kind === 'per_year' && 12 % schedule.n !== 0) {
    if (!last) nextDue = schedule.start;
    else if (countFrom === 'last_visit') nextDue = yearlyOccurrence(last, schedule.n, 1);
    else {
      let k = Math.max(0, (Number(last.slice(0, 4)) - Number(schedule.start.slice(0, 4)) - 1) * schedule.n);
      do { nextDue = yearlyOccurrence(schedule.start, schedule.n, k++); } while (nextDue <= last);
    }
  }
  else if (schedule) {
    const { months, days } = step(schedule);
    if (!last) nextDue = schedule.start;
    else if (countFrom === 'last_visit') nextDue = advance(last, months, days, 1);
    else {
      const monthDistance = (Number(last.slice(0, 4)) - Number(schedule.start.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(schedule.start.slice(5, 7));
      let k = Math.max(0, Math.floor(months ? monthDistance / months : daysBetween(schedule.start, last) / days));
      nextDue = advance(schedule.start, months, days, k);
      if (nextDue <= last) nextDue = advance(schedule.start, months, days, ++k);
    }
  }
  const status = !nextDue ? 'none' : today >= nextDue ? 'overdue' : 'ok';
  return { nextDue, status, overdueDays: status === 'overdue' ? daysBetween(nextDue!, today) : 0 };
}
export const isMuted = (mute: Mute | null, today: string) => !!mute && (mute.until === null || today <= mute.until);
export function alertDecision(input: { nextDue: string | null; today: string; hour: number; mute: Mute | null; alert: Alert | null }): { kind: 'first' | 'reminder'; alert: Alert } | null {
  const { nextDue, today, hour, mute, alert } = input;
  if (!nextDue || today < nextDue || hour < 8 || hour >= 21 || isMuted(mute, today)) return null;
  if (alert?.dueDate !== nextDue) return { kind: 'first', alert: { dueDate: nextDue, count: 1, lastSentDate: today } };
  if (daysBetween(alert.lastSentDate, today) >= 7 && daysBetween(nextDue, today) >= 7 * alert.count) return { kind: 'reminder', alert: { ...alert, count: Math.floor(daysBetween(nextDue, today) / 7) + 1, lastSentDate: today } };
  return null;
}
