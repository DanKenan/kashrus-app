import type { Shift, Task } from '../types';
import { taskAssigneesOn, taskOwnsPeople } from './taskAssignees';
import { taskAppliesOn } from './taskDay';
import { taskWithShiftTimes, tasksVisibleOnShift, shiftPeopleOccurrenceDay, shiftTaskAppliesAt } from './shifts';

/** Task-owned schedules survive the legacy shift time projection. */
export function taskWithOccurrenceTimes<T extends Task>(task: T, shifts: ReadonlyMap<string, Shift>, weekday?: number): T {
  const result = taskWithShiftTimes(task, shifts, weekday);
  return taskOwnsPeople(task) ? { ...result, daysOfWeek: task.daysOfWeek, scheduleType: task.scheduleType, specificDates: task.specificDates } : result;
}
export function taskOccurrenceDate(task: Pick<Task, 'shiftId' | 'venueId'>, shifts: ReadonlyMap<string, Shift>, today: string, weekday: number, minute: number): string {
  const shift = task.shiftId ? shifts.get(task.shiftId) : undefined;
  return shift && (!task.venueId || shift.venueId === task.venueId) ? shiftPeopleOccurrenceDay(shift, today, weekday, minute) : today;
}
export function taskOccursToday(task: Task, shifts: ReadonlyMap<string, Shift>, today: string, weekday: number, minute: number): boolean {
  const shift = task.shiftId ? shifts.get(task.shiftId) : undefined;
  if (!shift) return taskAppliesOn(task, today, weekday);
  if (!shiftTaskAppliesAt(shift, today, weekday, minute)) return false;
  const occurrence = taskOccurrenceDate(task, shifts, today, weekday, minute);
  return !taskOwnsPeople(task) || taskAppliesOn(task, occurrence, new Date(`${occurrence}T12:00:00Z`).getUTCDay());
}
/** Resolve once before the legacy shift filter, retaining overnight overdue people.
 * Task-owned shift tasks are assigned to people independently of the shift roster.
 */
export function tasksVisibleOnOccurrence<T extends Task>(tasks: T[], shifts: Shift[], user: { id: string; email: string }, today: string, weekday: number, minute: number): T[] {
  const byId = new Map(shifts.map((s) => [s.id, s]));
  return tasks.filter((task) => {
    if (!taskOwnsPeople(task) || !task.shiftId) return tasksVisibleOnShift([task], shifts, user, today, weekday, minute).length > 0;
    const occurrence = taskOccurrenceDate(task, byId, today, weekday, minute);
    const people = taskAssigneesOn(task, occurrence);
    const projection = { ...task, shiftId: null, assignmentMode: 'task' as const, assignedTo: people, dayAssignees: undefined, assigneeSwaps: undefined,
      targetTime: '', targetTimeMinutes: null, targetTime2: '', targetTime2Minutes: null };
    return tasksVisibleOnShift([projection], shifts, user, occurrence, new Date(`${occurrence}T12:00:00Z`).getUTCDay(), minute).length > 0;
  });
}
