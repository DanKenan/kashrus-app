import type { Shift } from '../types.ts';
import { addDays } from './workday.ts';

type ShiftTask = {
  shiftId?: string | null; venueId?: string; assignedTo?: unknown;
  daysOfWeek?: number[]; targetTime?: string; targetTime2?: string;
  targetTimeMinutes?: number; targetTime2Minutes?: number;
};

function validHours(shift: Shift): boolean {
  return !!shift && [shift.startMinutes, shift.endMinutes].every((m) => Number.isInteger(m) && m >= 0 && m < 1440)
    && shift.startMinutes !== shift.endMinutes;
}

/** Normalize old main-document records without weakening write validation. */
export function normalizeShifts(input: unknown): Shift[] {
  if (!Array.isArray(input)) return [];
  return input.filter((s) => s && typeof s.id === 'string' && typeof s.venueId === 'string' && validHours(s)).map((s) => ({
    ...s,
    name: typeof s.name === 'string' ? s.name : '',
    area: typeof s.area === 'string' ? s.area : '',
    userId: typeof s.userId === 'string' ? s.userId : null,
    daysOfWeek: Array.isArray(s.daysOfWeek) && s.daysOfWeek.length > 0 && s.daysOfWeek.every((d: unknown) => Number.isInteger(d) && Number(d) >= 0 && Number(d) <= 6)
      ? [...new Set<number>(s.daysOfWeek)] : [],
    overrides: Array.isArray(s.overrides) ? s.overrides.filter((o: any) => o && typeof o.date === 'string' && (o.userId === null || typeof o.userId === 'string')) : [],
  }));
}

export function shiftPersonOn(shift: Shift, ymd: string): string | null {
  const override = Array.isArray(shift?.overrides) ? shift.overrides.find((o) => o && o.date === ymd) : undefined;
  const person = override ? override.userId : shift?.userId;
  return typeof person === 'string' ? person : null;
}

// Overnight shifts always belong to their START day.
export function shiftRunsOn(shift: Shift, _ymd: string, weekday: number): boolean {
  return validHours(shift) && Array.isArray(shift.daysOfWeek) && shift.daysOfWeek.length > 0
    && shift.daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && shift.daysOfWeek.includes(weekday);
}

export function shiftOccurrenceDay(shift: Shift, ymd: string, weekday: number, nowMinutes: number): string | null {
  if (!validHours(shift)) return null;
  const yesterday = addDays(ymd, -1);
  if (shift.endMinutes < shift.startMinutes && nowMinutes >= 0 && nowMinutes < shift.endMinutes
      && shiftRunsOn(shift, yesterday, (weekday + 6) % 7)) return yesterday;
  return shiftRunsOn(shift, ymd, weekday) ? ymd : null;
}

export function shiftTaskAppliesAt(shift: Shift, ymd: string, weekday: number, nowMinutes: number): boolean {
  return shiftOccurrenceDay(shift, ymd, weekday, nowMinutes) !== null;
}

export function shiftTaskOverdueAt(shift: Shift, ymd: string, weekday: number, nowMinutes: number): boolean {
  if (!validHours(shift) || !Number.isFinite(nowMinutes) || nowMinutes < 0 || nowMinutes >= 1440) return false;
  if (shift.endMinutes < shift.startMinutes) {
    return nowMinutes > shift.endMinutes && nowMinutes < shift.startMinutes
      && shiftRunsOn(shift, addDays(ymd, -1), (weekday + 6) % 7);
  }
  return shiftRunsOn(shift, ymd, weekday) && nowMinutes > shift.endMinutes;
}

export function activeShiftsForUserAt(shifts: Shift[], userId: string, ymd: string, weekday: number, nowMinutes: number): Shift[] {
  const yesterday = addDays(ymd, -1);
  return shifts.filter((s) => {
    const continuing = validHours(s) && s.endMinutes < s.startMinutes && nowMinutes >= 0 && nowMinutes < s.endMinutes
      && shiftRunsOn(s, yesterday, (weekday + 6) % 7);
    return (continuing && shiftPersonOn(s, yesterday) === userId)
      || (shiftRunsOn(s, ymd, weekday) && shiftPersonOn(s, ymd) === userId);
  });
}

export function shiftsForUserOn(shifts: Shift[], userId: string, ymd: string, weekday: number): Shift[] {
  return shifts.filter((s) => shiftRunsOn(s, ymd, weekday) && shiftPersonOn(s, ymd) === userId);
}

function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatShiftHours(shift: Shift): string {
  if (!validHours(shift)) return '';
  return `${clock(shift.startMinutes)} – ${clock(shift.endMinutes)}${shift.endMinutes < shift.startMinutes ? ' (next day)' : ''}`;
}

export function shiftLabel(shift: Shift): string {
  return `${shift.name} · ${formatShiftHours(shift)}`;
}

export function minutesInShift(shift: Shift, minutes: number): boolean {
  if (!validHours(shift) || !Number.isFinite(minutes) || minutes < 0 || minutes >= 1440) return false;
  return shift.endMinutes < shift.startMinutes
    ? minutes >= shift.startMinutes || minutes <= shift.endMinutes
    : minutes >= shift.startMinutes && minutes <= shift.endMinutes;
}

export function taskWithShiftTimes<T extends ShiftTask>(task: T, shiftsById: ReadonlyMap<string, Shift> | Record<string, Shift>): T {
  const shift = task.shiftId
    ? (shiftsById instanceof Map ? shiftsById.get(task.shiftId)
      : Object.prototype.hasOwnProperty.call(shiftsById, task.shiftId) ? (shiftsById as Record<string, Shift>)[task.shiftId] : undefined)
    : undefined;
  if (!validHours(shift) || (task.venueId && shift.venueId !== task.venueId)) return task;
  return {
    ...task, daysOfWeek: normalizeShifts([shift])[0]?.daysOfWeek || [],
    targetTime: clock(shift.startMinutes), targetTime2: clock(shift.endMinutes),
    targetTimeMinutes: shift.startMinutes, targetTime2Minutes: shift.endMinutes,
  };
}

function timeMinutes(task: ShiftTask): number | null {
  const text = typeof task.targetTime === 'string' ? task.targetTime.trim() : '';
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
export function tasksVisibleOnShift<T extends ShiftTask>(tasks: T[], shifts: Shift[], user: { id: string; email: string }, ymd: string, weekday: number, nowMinutes?: number): T[] {
  const safeShifts = normalizeShifts(shifts);
  const mine = nowMinutes === undefined ? shiftsForUserOn(safeShifts, user.id, ymd, weekday)
    : activeShiftsForUserAt(safeShifts, user.id, ymd, weekday, nowMinutes);
  const known = new Map(safeShifts.map((s) => [s.id, s]));
  return tasks.filter((task) => {
    const raw = Array.isArray(task.assignedTo) ? task.assignedTo : typeof task.assignedTo === 'string' ? [task.assignedTo] : [];
    const assigned = raw.filter((a): a is string => typeof a === 'string').map((a) => a.trim().toLowerCase()).filter(Boolean);
    const personal = assigned.includes(typeof user.email === 'string' ? user.email.trim().toLowerCase() : '');
    const team = assigned.length === 0 || assigned.includes('all');
    if (!mine.length) return personal || team;
    if (personal) return true;
    const shift = task.shiftId ? known.get(task.shiftId) : undefined;
    if (shift && (!task.venueId || shift.venueId === task.venueId)) return mine.some((s) => s.id === shift.id);
    if (!team) return false;
    const minutes = timeMinutes(task);
    return minutes === null || mine.some((s) => (!task.venueId || s.venueId === task.venueId) && minutesInShift(s, minutes));
  });
}
