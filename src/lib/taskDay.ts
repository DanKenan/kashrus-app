import { targetMinutesOf } from './overdue';

interface DayTask {
  scheduleType?: 'recurring' | 'specific_dates';
  daysOfWeek?: number[];
  specificDates?: string[];
}
interface TimeTask {
  targetTime?: string;
  targetTimeMinutes?: number;
  targetTime2?: string;
  targetTime2Minutes?: number;
}
interface SortableTask extends TimeTask {
  id: string;
  sortOrder?: number;
  createdAt: string;
}
export interface TaskDaySection<T> { key: string; label: string; tasks: T[] }

export function taskAppliesOn(task: DayTask, ymd: string, weekday: number): boolean {
  // Defensive on stored data: a non-array dates field matches no date; a non-array days field means every day.
  if (task.scheduleType === 'specific_dates') return Array.isArray(task.specificDates) && task.specificDates.includes(ymd);
  const days = Array.isArray(task.daysOfWeek) ? task.daysOfWeek : [];
  return days.length === 0 || days.includes(weekday);
}

/**
 * Don (Nov 1): "only show him the tasks assigned to him or to everyone".
 * A task is for the viewer when it is for everyone ('all', any case), names the
 * viewer's email (any case), or names nobody at all (older data).
 */
export function taskIsForViewer(task: { assignedTo?: string[] }, email: string | null | undefined): boolean {
  const raw: unknown = task.assignedTo; // older rows may hold one email as a plain string
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((a): a is string => typeof a === 'string' && a.trim() !== '');
  if (list.length === 0) return true;
  const me = (email || '').trim().toLowerCase();
  return list.some((a) => {
    const v = a.trim().toLowerCase();
    return v === 'all' || (me !== '' && v === me);
  });
}

/** Only a mashgiach/worker who cannot create or edit tasks gets the own-tasks list. */
export function seesOnlyOwnTasks(user: { role?: string } | null | undefined, canEditTasks: boolean): boolean {
  if (!user || canEditTasks) return false;
  return user.role === 'mashgiach' || user.role === 'worker';
}

export function taskTimeKey(task: TimeTask): { rank: number; minutes: number } {
  const minutes = Math.min(
    targetMinutesOf(task),
    targetMinutesOf({ targetTime: task.targetTime2, targetTimeMinutes: task.targetTime2Minutes }),
  );
  if (Number.isFinite(minutes)) return { rank: 0, minutes };
  const end = [task.targetTime, task.targetTime2].some((t) => /^end of (day|shift)$/i.test(t?.trim() || ''));
  return { rank: end ? 1 : 2, minutes: Infinity };
}

export function isNoTimeTask(task: TimeTask): boolean { return taskTimeKey(task).rank === 2; }

export function sortTasksByTime<T extends SortableTask>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const x = taskTimeKey(a), y = taskTimeKey(b);
    return x.rank - y.rank || (x.rank === 0 ? x.minutes - y.minutes : 0) ||
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dateParts(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function groupTasksByDay<T extends DayTask & SortableTask>(list: readonly T[], todayYmd: string): TaskDaySection<T>[] {
  const todayWeekday = dateParts(todayYmd).getUTCDay();
  const sections = WEEKDAYS.map((name, weekday) => ({
    key: `weekday-${weekday}`,
    label: name + (weekday === todayWeekday ? ' · Today' : ''),
    tasks: sortTasksByTime(list.filter((t) => t.scheduleType !== 'specific_dates' && taskAppliesOn(t, todayYmd, weekday))),
  }));
  const dated = list.filter((t) => t.scheduleType === 'specific_dates');
  const isYmd = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const datesOf = (t: T) => (Array.isArray(t.specificDates) ? t.specificDates : []).filter(isYmd);
  const dates = [...new Set(dated.flatMap(datesOf).filter((d) => d >= todayYmd))].sort();
  for (const date of dates) sections.push({
    key: date,
    label: dateParts(date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }),
    tasks: sortTasksByTime(dated.filter((t) => datesOf(t).includes(date))),
  });
  sections.push({ key: 'past', label: 'Past dates', tasks: sortTasksByTime(dated.filter((t) => datesOf(t).length > 0 && datesOf(t).every((d) => d < todayYmd))) });
  // A dated task with no usable date still has to be findable by the people who edit tasks.
  sections.push({ key: 'nodate', label: 'No dates set', tasks: sortTasksByTime(dated.filter((t) => datesOf(t).length === 0)) });
  return sections.filter((s) => s.tasks.length > 0);
}
