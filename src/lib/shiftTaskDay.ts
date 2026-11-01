import type { Shift, Task } from '../types';
import { shiftOccurrenceDay, taskWithShiftTimes, shiftPersonOn, shiftDayOf } from './shifts';

type Weekday = number | ((task: Task) => number | undefined);
/** A weekday section wins; today's list uses the occurrence's start day,
 * including yesterday's own hours during an overnight continuation. */
export function shiftDisplayWeekday(shift: Shift, ymd: string | null, weekday: number | null, nowMinutes: number | null, sectionKey?: string): number | undefined {
  if (/^weekday-[0-6]$/.test(sectionKey || '')) return Number(sectionKey!.slice(-1));
  if (ymd === null || weekday === null || nowMinutes === null) return undefined;
  const occurrence = shiftOccurrenceDay(shift, ymd, weekday, nowMinutes);
  return occurrence ? new Date(`${occurrence}T12:00:00Z`).getUTCDay() : weekday;
}
/** Preserve #185's ordinary-task order; shifts sort by their occurrence start. */
export function shiftSortProjection(tasks: Task[], shiftsById: Map<string, Shift>, weekday?: Weekday): Task[] {
  return tasks.map((task) => {
    const effective = taskWithShiftTimes(task, shiftsById, typeof weekday === 'function' ? weekday(task) : weekday);
    return task.shiftId && shiftsById.has(task.shiftId)
      ? { ...effective, targetTime2: '', targetTime2Minutes: undefined } : effective;
  });
}
export function restoreShiftWindows(tasks: Task[], shiftsById: Map<string, Shift>, weekday?: Weekday): Task[] {
  return tasks.map((task) => taskWithShiftTimes(task, shiftsById, typeof weekday === 'function' ? weekday(task) : weekday));
}

/** Presentation only: shift assignments keep the stored team fallback out of the label. */
export function shiftAssigneeLabel(shift: Shift, editor: boolean, ymd: string | null, weekday: number | null, nowMinutes: number | null, roster: ReadonlyArray<{ id?: string; name: string }> = []): string {
  const label = `${shift.name} shift`;
  if (!editor || ymd === null || weekday === null || nowMinutes === null) return label;
  const occ = shiftOccurrenceDay(shift, ymd, weekday, nowMinutes);
  if (!occ) return label;
  const person = shiftPersonOn(shift, occ);
  if (person === null) return `${shift.name} · today: Nobody`;
  const occWeekday = new Date(`${occ}T12:00:00Z`).getUTCDay();
  const override = shift.overrides?.find((o) => o.date === occ && o.userId === person);
  const day = shiftDayOf(shift, occWeekday);
  const name = override?.userName ||
    (day.userId === person ? shift.dayUserNames?.[occWeekday] : undefined) ||
    (shift.userId === person ? shift.userName : undefined) || roster.find((p) => p.id === person)?.name;
  return `${shift.name} · today: ${name || 'someone else'}`;
}
