import { apiWrite } from './api';
import type { Shift, Task } from '../types';
import { assigneeEmails } from './taskAssignees';
import { shiftHoursOn, shiftDayOf } from './shifts';
import { addDays } from './workday';

/** End is exclusive, including an overnight shift's early-morning segment. */
export function detectTimeShift(shifts: Shift[], minute: number, weekday: number): Shift | undefined {
  return shifts.find((shift) => {
    const current = shiftHoursOn(shift, weekday);
    const previousDay = (weekday + 6) % 7;
    const previous = shiftHoursOn(shift, previousDay);
    return (shiftDayOf(shift, weekday).on && (current.startMinutes < current.endMinutes
      ? minute >= current.startMinutes && minute < current.endMinutes : minute >= current.startMinutes))
      || (shiftDayOf(shift, previousDay).on && previous.endMinutes < previous.startMinutes && minute < previous.endMinutes);
  });
}
export function nextWeekday(today: string, weekday: number): string {
  const current = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (weekday - current + 7) % 7);
}
export function differingDays(days: NonNullable<Task['dayAssignees']>, main: string[]): NonNullable<Task['dayAssignees']> {
  const key = (people: unknown) => assigneeEmails(people).sort().join('\n');
  return Object.fromEntries(Object.entries(days).filter(([, people]) => key(people) !== key(main)));
}
/** Untouched legacy edits omit all new fields; existing task-owned fields survive. */
export function peopleFields(task: Task | null | undefined, touched: boolean, days: NonNullable<Task['dayAssignees']>, swaps: NonNullable<Task['assigneeSwaps']>): Partial<Task> {
  if (task && !touched) return Object.fromEntries(['assignmentMode', 'dayAssignees', 'assigneeSwaps'].filter((key) => Object.hasOwn(task, key)).map((key) => [key, task[key as keyof Task]]));
  return { assignmentMode: 'task', ...(Object.keys(days).length || task?.dayAssignees ? { dayAssignees: days } : {}), ...(swaps.length || task?.assigneeSwaps ? { assigneeSwaps: swaps } : {}) };
}

/** The caller adds the returned cards to existing state; no refetch. */
export async function saveTaskBatch(tasks: Partial<Task>[], venueId: string, email: string) {
  const result = await apiWrite<Task[] | { tasks: Task[] }>('/api/tasks', {
    method: 'POST', body: JSON.stringify({ tasks: tasks.map((task) => ({ ...task, venueId, createdByEmail: email, userEmail: email })) }),
  });
  if (!result.ok) return { ok: false as const, error: result.error, data: [] as Task[] };
  return { ...result, data: Array.isArray(result.data) ? result.data : result.data.tasks };
}
