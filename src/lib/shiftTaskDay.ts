import type { Shift, Task } from '../types';
import { taskWithShiftTimes } from './shifts';

/** Keep #185's earliest-of-two-times rule for ordinary tasks. A shift is one
 * window, so its start alone supplies the sorting key, including overnight. */
export function shiftSortProjection(tasks: Task[], shiftsById: Map<string, Shift>): Task[] {
  return tasks.map((task) => {
    const effective = taskWithShiftTimes(task, shiftsById);
    return task.shiftId && shiftsById.has(task.shiftId)
      ? { ...effective, targetTime2: '', targetTime2Minutes: undefined }
      : effective;
  });
}

export function restoreShiftWindows(tasks: Task[], shiftsById: Map<string, Shift>): Task[] {
  return tasks.map((task) => taskWithShiftTimes(task, shiftsById));
}
