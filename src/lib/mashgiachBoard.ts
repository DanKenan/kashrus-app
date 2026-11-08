import type { Shift, Task, User } from '../types';
import { activeShiftsForUserAt, shiftsForUserOn, shiftHoursOn, shiftOccurrenceDay, formatShiftHours } from './shifts';
import { checkInCoversDue, targetMinutesOf } from './overdue';
import { workDateIn } from './workday';
import { shiftPeopleOccurrenceDay, shiftTimeOffset } from './shifts';
import { taskTimeKey } from './taskDay';

export function usesMashgiachBoard(user: Pick<User, 'role'> | null, kiosk: boolean, day: string): boolean {
  return user?.role === 'mashgiach' && !kiosk && day === 'today';
}

/** Completion remains the board's recorded isCompleted, including repeatable checks. */
export function mashgiachProgress(tasks: readonly Task[], overdue: (task: Task) => boolean, covered: (task: Task) => boolean = () => false) {
  const done = tasks.filter((task) => task.isCompleted);
  const open = tasks.filter((task) => !task.isCompleted).sort((a, b) => {
    const late = Number(overdue(b)) - Number(overdue(a));
    const x = taskTimeKey(a), y = taskTimeKey(b);
    return late || x.rank - y.rank || (x.minutes === y.minutes ? 0 : x.minutes - y.minutes);
  });
  const next = open.find((task) => task.inputType !== 'check_in' || !covered(task));
  return { done, open, next, later: open.filter((task) => task !== next), total: tasks.length, completed: done.length };
}

export function mashgiachHeader(shifts: Shift[], userId: string, day: string, weekday: number, minutes: number) {
  const active = activeShiftsForUserAt(shifts, userId, day, weekday, minutes);
  const running = active.find((shift) => {
    const occurrence = shiftOccurrenceDay(shift, day, weekday, minutes);
    const w = occurrence && occurrence !== day ? (weekday + 6) % 7 : weekday;
    const hours = shiftHoursOn(shift, w);
    return occurrence !== day ? minutes < hours.endMinutes
      : minutes >= hours.startMinutes && (hours.endMinutes < hours.startMinutes || minutes < hours.endMinutes);
  });
  const next = shiftsForUserOn(shifts, userId, day, weekday)
    .filter((shift) => shiftHoursOn(shift, weekday).startMinutes > minutes)
    .sort((a, b) => shiftHoursOn(a, weekday).startMinutes - shiftHoursOn(b, weekday).startMinutes)[0];
  const shift = running || next;
  const w = running && shiftOccurrenceDay(running, day, weekday, minutes) !== day ? (weekday + 6) % 7 : weekday;
  return { title: shift ? `Your ${shift.name.toLowerCase()} shift` : 'Your tasks today', hours: shift ? formatShiftHours(shift, w) : '' };
}

/** Use the same occurrence, start and deadlines as the shift overdue helpers. */
export function mashgiachCheckInCovered(task: Task, shift: Shift | undefined, day: string, weekday: number, minutes: number, timeZone?: string) {
  if (task.inputType !== 'check_in') return false;
  if (!shift) return checkInCoversDue(task, day, minutes, timeZone);
  const occurrence = shiftPeopleOccurrenceDay(shift, day, weekday, minutes);
  const w = occurrence !== day ? (weekday + 6) % 7 : weekday;
  const hours = shiftHoursOn(shift, w);
  const elapsed = minutes + (occurrence !== day ? 1440 : 0);
  const deadlines = task.shiftTime
    ? [targetMinutesOf(task), targetMinutesOf({ targetTime: task.targetTime2, targetTimeMinutes: task.targetTime2Minutes })].map((m) => shiftTimeOffset(shift, m, w))
    : [hours.endMinutes + (hours.endMinutes < hours.startMinutes ? 1440 : 0)];
  return checkInCoversDue(task, occurrence, elapsed, timeZone, hours.startMinutes, deadlines);
}

export function mashgiachCheckInSummary(task: Task, now: Date, timeZone?: string, compact = false) {
  const day = workDateIn(timeZone, now);
  const checks = (task.checkIns || []).filter((c) => Number.isFinite(Date.parse(c.at)) && workDateIn(timeZone, new Date(c.at)) === day)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = checks.at(-1);
  return `${checks.length}${compact ? '' : ` check${checks.length === 1 ? '' : 's'}`} today${last ? ` · last ${new Date(last.at).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}`;
}
