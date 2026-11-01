import type { Shift } from '../types.ts';

type ShiftTask = {
  shiftId?: string | null; venueId?: string; assignedTo?: string[];
  daysOfWeek?: number[]; targetTime?: string; targetTime2?: string;
  targetTimeMinutes?: number; targetTime2Minutes?: number;
};

export function shiftPersonOn(shift: Shift, ymd: string): string | null {
  const override = shift.overrides.find((o) => o.date === ymd);
  return override ? override.userId : shift.userId;
}

// Overnight shifts always belong to their START day.
export function shiftRunsOn(shift: Shift, _ymd: string, weekday: number): boolean {
  return shift.daysOfWeek.includes(weekday);
}

export function shiftsForUserOn(shifts: Shift[], userId: string, ymd: string, weekday: number): Shift[] {
  return shifts.filter((s) => shiftRunsOn(s, ymd, weekday) && shiftPersonOn(s, ymd) === userId);
}

function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatShiftHours(shift: Shift): string {
  return `${clock(shift.startMinutes)} – ${clock(shift.endMinutes)}`;
}

export function shiftLabel(shift: Shift): string {
  return `${shift.name} · ${formatShiftHours(shift)}`;
}

export function minutesInShift(shift: Shift, minutes: number): boolean {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 1440) return false;
  return shift.endMinutes < shift.startMinutes
    ? minutes >= shift.startMinutes || minutes <= shift.endMinutes
    : minutes >= shift.startMinutes && minutes <= shift.endMinutes;
}

export function taskWithShiftTimes<T extends ShiftTask>(task: T, shiftsById: ReadonlyMap<string, Shift> | Record<string, Shift>): T {
  const shift = task.shiftId
    ? (shiftsById instanceof Map ? shiftsById.get(task.shiftId)
      : Object.prototype.hasOwnProperty.call(shiftsById, task.shiftId) ? (shiftsById as Record<string, Shift>)[task.shiftId] : undefined)
    : undefined;
  if (!shift || (task.venueId && shift.venueId !== task.venueId)) return task;
  return {
    ...task, daysOfWeek: [...shift.daysOfWeek],
    targetTime: clock(shift.startMinutes), targetTime2: clock(shift.endMinutes),
    targetTimeMinutes: shift.startMinutes, targetTime2Minutes: shift.endMinutes,
  };
}

function timeMinutes(task: ShiftTask): number | null {
  const text = task.targetTime?.trim() || '';
  if (!text || /^(any time|end of day)$/i.test(text)) return null;
  if (Number.isInteger(task.targetTimeMinutes)) return task.targetTimeMinutes!;
  const match = text.match(/^(\d{1,2}):(\d{2})(?:\s*([AP])M)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'P' ? 12 : 0);
  return hour * 60 + Number(match[2]);
}

// Input has already passed the applies-today filter. This decides only
// assignment and shift-hour visibility.
export function tasksVisibleOnShift<T extends ShiftTask>(tasks: T[], shifts: Shift[], user: { id: string; email: string }, ymd: string, weekday: number): T[] {
  const mine = shiftsForUserOn(shifts, user.id, ymd, weekday);
  const known = new Map(shifts.map((s) => [s.id, s]));
  return tasks.filter((task) => {
    const assigned = task.assignedTo?.length ? task.assignedTo : ['all'];
    const personal = assigned.some((a) => a.trim().toLowerCase() === user.email.trim().toLowerCase());
    const team = assigned.some((a) => a.toLowerCase() === 'all');
    if (!mine.length) return personal || team;
    if (personal) return true;
    const shift = task.shiftId ? known.get(task.shiftId) : undefined;
    if (shift && (!task.venueId || shift.venueId === task.venueId)) return mine.some((s) => s.id === shift.id);
    if (!team) return false;
    const minutes = timeMinutes(task);
    return minutes === null || mine.some((s) => (!task.venueId || s.venueId === task.venueId) && minutesInShift(s, minutes));
  });
}
