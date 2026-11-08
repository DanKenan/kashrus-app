import type { Shift, Task, User } from '../types';
import { activeShiftsForUserAt, shiftsForUserOn, shiftHoursOn, shiftOccurrenceDay, formatShiftHours } from './shifts';
import { checkInCoversDue, targetMinutesOf } from './overdue';
import { workDateIn, weekdayIn, minutesIn, addDays } from './workday';
import { shiftPeopleOccurrenceDay, shiftTimeOffset } from './shifts';
import { taskTimeKey } from './taskDay';

export function usesMashgiachBoard(user: Pick<User, 'role'> | null, kiosk: boolean, day: string): boolean {
  return user?.role === 'mashgiach' && !kiosk && day === 'today';
}

/** Completion remains the board's recorded isCompleted, including repeatable checks. */
export function mashgiachProgress(tasks: readonly Task[], overdue: (task: Task) => boolean, covered: (task: Task) => boolean = () => false, timeKey: (task: Task) => ReturnType<typeof taskTimeKey> = taskTimeKey) {
  const done = tasks.filter((task) => task.isCompleted);
  const open = tasks.filter((task) => !task.isCompleted).sort((a, b) => {
    const late = Number(overdue(b)) - Number(overdue(a));
    const x = timeKey(a), y = timeKey(b);
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

function shiftWindow(shift: Shift, day: string, weekday: number, minutes: number) {
  const occurrence = shiftPeopleOccurrenceDay(shift, day, weekday, minutes);
  const w = occurrence !== day ? (weekday + 6) % 7 : weekday;
  return { occurrence, w, hours: shiftHoursOn(shift, w), elapsed: minutes + (occurrence !== day ? 1440 : 0) };
}

/** Compare deadlines on the board's day, including the previous overnight occurrence. */
export function mashgiachTaskTimeKey(task: Task, shift: Shift | undefined, day: string, weekday: number, minutes: number) {
  if (!shift) return taskTimeKey(task);
  const { occurrence, w } = shiftWindow(shift, day, weekday, minutes);
  const offset = (value: number) => shiftTimeOffset(shift, value, w) - (occurrence !== day ? 1440 : 0);
  return taskTimeKey({ ...task, targetTimeMinutes: offset(targetMinutesOf(task)),
    targetTime2Minutes: offset(targetMinutesOf({ targetTime: task.targetTime2, targetTimeMinutes: task.targetTime2Minutes })) });
}

/** Use the same occurrence, start and deadlines as the shift overdue helpers. */
export function mashgiachCheckInCovered(task: Task, shift: Shift | undefined, day: string, weekday: number, minutes: number, timeZone?: string) {
  if (task.inputType !== 'check_in') return false;
  if (!shift) return checkInCoversDue(task, day, minutes, timeZone);
  const { occurrence, w, hours, elapsed } = shiftWindow(shift, day, weekday, minutes);
  const deadlines = task.shiftTime
    ? [targetMinutesOf(task), targetMinutesOf({ targetTime: task.targetTime2, targetTimeMinutes: task.targetTime2Minutes })].map((m) => shiftTimeOffset(shift, m, w))
    : [hours.endMinutes + (hours.endMinutes < hours.startMinutes ? 1440 : 0)];
  return checkInCoversDue(task, occurrence, elapsed, timeZone, hours.startMinutes, deadlines);
}

export function mashgiachCheckInSummary(task: Task, now: Date, timeZone?: string, compact = false, shift?: Shift) {
  const day = workDateIn(timeZone, now);
  const window = shift ? shiftWindow(shift, day, weekdayIn(timeZone, now), minutesIn(timeZone, now)) : undefined;
  const checks = (task.checkIns || []).filter((c) => {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) return false;
    const date = workDateIn(timeZone, at);
    if (!window) return date === day;
    if (date !== window.occurrence && date !== addDays(window.occurrence, 1)) return false;
    const offset = minutesIn(timeZone, at) + (date !== window.occurrence ? 1440 : 0);
    return offset >= window.hours.startMinutes && offset <= window.elapsed;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = checks.at(-1);
  return `${checks.length}${compact && !shift ? '' : ` check${checks.length === 1 ? '' : 's'}`} ${shift ? 'this shift' : 'today'}${last ? ` · last ${new Date(last.at).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}`;
}
