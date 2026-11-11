export type Schedule = { kind: 'every'; n: number; unit: 'day' | 'week' | 'month'; start: string } | { kind: 'per_year'; n: number; start: string } | { kind: 'dates'; dates: string[] };
export type ScheduleSettings = { countFrom: 'last_visit' | 'planned'; mashgichimSeeAll: boolean };
export interface ScheduleCompany { id: string; name: string; brand?: string; plant?: string; schedule: Schedule | null; nextDue: string | null; status: 'none' | 'ok' | 'overdue'; overdueDays: number; lastVisit: { at: string; reportId: string; mashgiachName: string } | null; mashgiachIds: string[]; coordinatorIds: string[]; mute: { until: string | null; by: string; at: string } | null }
export interface ScheduleData { today: string; timeZone: string; settings: ScheduleSettings; companies: ScheduleCompany[]; people: { mashgichim: { id: string; name: string }[]; coordinators: { id: string; name: string }[] } }
export const calendarDate = (at: string, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
export const displayDate = (date: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
export const overdueDaysText = (days: number) => days === 0 ? 'due today' : `${days} ${days === 1 ? 'day' : 'days'}`;
export function nextVisitDue(schedule: Schedule | null, countFrom: ScheduleSettings['countFrom'], lastVisitDate: string | null): string | null {
  if (!schedule) return null;
  if (schedule.kind === 'dates') return schedule.dates.find(date => !lastVisitDate || date > lastVisitDate) || null;
  if (!Number.isInteger(schedule.n) || schedule.n < 1 || schedule.n > (schedule.kind === 'every' ? 365 : 52) || !/^\d{4}-\d{2}-\d{2}$/.test(schedule.start)) return null;
  if (!lastVisitDate) return schedule.start;
  const months = schedule.kind === 'per_year' ? (12 % schedule.n === 0 ? 12 / schedule.n : 0) : schedule.unit === 'month' ? schedule.n : 0;
  const days = schedule.kind === 'per_year' ? Math.round(365 / schedule.n) : schedule.n * (schedule.unit === 'week' ? 7 : 1);
  const step = (base: string, k: number) => {
    const date = new Date(`${base}T00:00:00Z`);
    if (months) { const day = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months * k); const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); date.setUTCDate(Math.min(day, end)); }
    else date.setUTCDate(date.getUTCDate() + days * k);
    return date.toISOString().slice(0, 10);
  };
  if (countFrom === 'last_visit') return step(lastVisitDate, 1);
  let low = 0, high = 1;
  while (step(schedule.start, high) <= lastVisitDate) high *= 2;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (step(schedule.start, mid) > lastVisitDate) high = mid; else low = mid + 1; }
  return step(schedule.start, low);
}
