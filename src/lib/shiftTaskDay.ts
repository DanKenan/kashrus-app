import type { Shift, Task } from '../types';
import { shiftOccurrenceDay, taskWithShiftTimes, shiftPeopleOn, shiftUserIds, shiftDayOf } from './shifts';

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
    return task.shiftId && !task.shiftTime && shiftsById.has(task.shiftId)
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
  const ids = shiftPeopleOn(shift, occ);
  if (!ids.length) return `${shift.name} · today: Nobody`;
  const occWeekday = new Date(`${occ}T12:00:00Z`).getUTCDay();
  const override = shift.overrides?.find((o) => o.date === occ);
  const day = shiftDayOf(shift, occWeekday);
  const source = override || (day.userIds !== undefined ? shift.days?.[occWeekday] : shift);
  const names = ids.map((id) => {
    const index = shiftUserIds(source).indexOf(id);
    const generalIndex = shiftUserIds(shift).indexOf(id);
    return source?.userNames?.[index] || (override?.userId === id ? override.userName : undefined) ||
      (day.userId === id ? shift.dayUserNames?.[occWeekday] : undefined) ||
      shift.userNames?.[generalIndex] || (shift.userId === id ? shift.userName : undefined) ||
      roster.find((p) => p.id === id)?.name || 'someone else';
  });
  return `${shift.name} · today: ${names.join(', ')}`;
}
