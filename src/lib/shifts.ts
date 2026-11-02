import type { Shift, ShiftDay } from '../types.ts';
import { isTaskOverdue } from './overdue.ts';
import { addDays, isWorkDate } from './workday.ts';

type ShiftTask = {
  shiftTime?: boolean;
  shiftId?: string | null; venueId?: string; assignedTo?: unknown;
  scheduleType?: 'recurring' | 'specific_dates'; specificDates?: string[];
  daysOfWeek?: number[]; targetTime?: string; targetTime2?: string;
  targetTimeMinutes?: number; targetTime2Minutes?: number;
};

function validHours(shift: { startMinutes?: number; endMinutes?: number } | null | undefined): boolean {
  return !!shift && [shift.startMinutes, shift.endMinutes].every((m) => Number.isInteger(m) && m >= 0 && m < 1440)
    && shift.startMinutes !== shift.endMinutes;
}

/** Lists win when present; old single-person records remain readable. */
export function shiftUserIds(value: { userIds?: unknown; userId?: unknown } | null | undefined): string[] {
  const raw = value?.userIds !== undefined ? value.userIds : typeof value?.userId === 'string' ? [value.userId] : [];
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
}
export function shiftPeopleSummary(names: readonly string[]): string {
  return names.length ? `${names[0]}${names.length > 1 ? ` + ${names.length - 1}` : ''}` : 'Nobody';
}

/** Safe weekday access, including the old draft daysOfWeek shape. */
export function shiftDayOf(shift: Shift, weekday: number): ShiftDay {
  if (shift?.oneTimeDate) return { on: false };
  if (!shift || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { on: false };
  if (shift.days === undefined) {
    const old = (shift as any).daysOfWeek;
    return { on: Array.isArray(old) && old.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && old.includes(weekday) };
  }
  if (!Array.isArray(shift.days) || shift.days.length !== 7) return { on: false };
  const day = shift.days[weekday];
  if (!day || typeof day.on !== 'boolean') return { on: false };
  const ownHours = day.startMinutes !== undefined || day.endMinutes !== undefined;
  if (ownHours && !validHours(day)) return { on: false };
  return {
    on: day.on,
    ...((day.userIds !== undefined || day.userId !== undefined) ? { userIds: shiftUserIds(day), userId: shiftUserIds(day)[0] || null } : {}),
    ...(ownHours ? { startMinutes: day.startMinutes, endMinutes: day.endMinutes } : {}),
  };
}

export function shiftIsUpcoming(shift: Shift, todayYmd: string): boolean {
  return !shift.oneTimeDate || shift.oneTimeDate >= todayYmd;
}

export function shiftWeekdays(shift: Shift): number[] {
  return Array.from({ length: 7 }, (_, w) => w).filter((w) => shiftDayOf(shift, w).on);
}

export function shiftHoursOn(shift: Shift, weekday: number): { startMinutes: number; endMinutes: number } {
  const day = shiftDayOf(shift, weekday);
  return { startMinutes: day.startMinutes ?? shift?.startMinutes, endMinutes: day.endMinutes ?? shift?.endMinutes };
}

export function shiftVariesByDay(shift: Shift): boolean {
  return shiftWeekdays(shift).some((w) => {
    const day = shiftDayOf(shift, w);
    return day.userIds !== undefined || day.startMinutes !== undefined;
  });
}

function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

/** Normalize old main-document records without weakening write validation. */
export function normalizeShifts(input: unknown): Shift[] {
  if (!Array.isArray(input)) return [];
  return input.filter((s) => (s?.oneTimeDate == null || (isWorkDate(s.oneTimeDate) && addDays(s.oneTimeDate, 0) === s.oneTimeDate)) && s && typeof s.id === 'string' && typeof s.venueId === 'string' && validHours(s)).map((s) => {
    const { daysOfWeek: _old, userName: _name, userNames: _people, dayUserNames: _names, ...rest } = s;
    return {
      ...rest,
      name: typeof s.name === 'string' ? s.name : '',
      area: typeof s.area === 'string' ? s.area : '',
      userIds: shiftUserIds(s), userId: shiftUserIds(s)[0] || null,
      days: Array.from({ length: 7 }, (_, w) => shiftDayOf(s, w)),
      overrides: Array.isArray(s.overrides) ? s.overrides.filter((o: any) => o && typeof o.date === 'string').map((o: any) => ({ date: o.date, userIds: shiftUserIds(o), userId: shiftUserIds(o)[0] || null })) : [],
    };
  });
}

export function shiftPeopleOn(shift: Shift, ymd: string): string[] {
  const override = Array.isArray(shift?.overrides) ? shift.overrides.find((o) => o && o.date === ymd) : undefined;
  const day = shiftDayOf(shift, weekdayOf(ymd));
  return shiftUserIds(override || (day.userIds !== undefined ? day : shift));
}
/** Compatibility for callers that only need the first person. */
export function shiftPersonOn(shift: Shift, ymd: string): string | null {
  return shiftPeopleOn(shift, ymd)[0] || null;
}

// Overnight shifts always belong to their START day.
export function shiftRunsOn(shift: Shift, ymd: string, weekday: number): boolean {
  return validHours(shift) && (shift.oneTimeDate ? shift.oneTimeDate === ymd : shiftDayOf(shift, weekday).on);
}

export function shiftOccurrenceDay(shift: Shift, ymd: string, weekday: number, nowMinutes: number): string | null {
  if (!validHours(shift)) return null;
  // Writes reject overlapping weekdays. For legacy overlaps, yesterday wins.
  const yesterday = addDays(ymd, -1);
  const hours = shiftHoursOn(shift, (weekday + 6) % 7);
  if (hours.endMinutes < hours.startMinutes && nowMinutes >= 0 && nowMinutes < hours.endMinutes
      && shiftRunsOn(shift, yesterday, (weekday + 6) % 7)) return yesterday;
  return shiftRunsOn(shift, ymd, weekday) ? ymd : null;
}

export function shiftTaskAppliesAt(shift: Shift, ymd: string, weekday: number, nowMinutes: number): boolean {
  return shiftOccurrenceDay(shift, ymd, weekday, nowMinutes) !== null;
}

export function shiftTaskOverdueAt(shift: Shift, ymd: string, weekday: number, nowMinutes: number, task?: ShiftTask): boolean {
  if (task?.shiftTime) return shiftRunsOn(shift, ymd, weekday) && isTaskOverdue(task, nowMinutes);
  if (!validHours(shift) || !Number.isFinite(nowMinutes) || nowMinutes < 0 || nowMinutes >= 1440) return false;
  const previous = shiftHoursOn(shift, (weekday + 6) % 7);
  const hours = shiftHoursOn(shift, weekday);
  // Once today's own window starts, its deadline supersedes yesterday's.
  const nextStart = shiftRunsOn(shift, ymd, weekday) ? Math.min(previous.startMinutes, hours.startMinutes) : previous.startMinutes;
  if (previous.endMinutes < previous.startMinutes && nowMinutes > previous.endMinutes && nowMinutes < nextStart
      && shiftRunsOn(shift, addDays(ymd, -1), (weekday + 6) % 7)) return true;
  return hours.endMinutes > hours.startMinutes && shiftRunsOn(shift, ymd, weekday) && nowMinutes > hours.endMinutes;
}

export function activeShiftsForUserAt(shifts: Shift[], userId: string, ymd: string, weekday: number, nowMinutes: number): Shift[] {
  const yesterday = addDays(ymd, -1);
  return shifts.filter((s) => {
    const hours = shiftHoursOn(s, (weekday + 6) % 7);
    const continuing = validHours(s) && hours.endMinutes < hours.startMinutes && nowMinutes >= 0 && nowMinutes < hours.endMinutes
      && shiftRunsOn(s, yesterday, (weekday + 6) % 7);
    return (continuing && shiftPeopleOn(s, yesterday).includes(userId))
      || (shiftRunsOn(s, ymd, weekday) && shiftPeopleOn(s, ymd).includes(userId));
  });
}

export function shiftsForUserOn(shifts: Shift[], userId: string, ymd: string, weekday: number): Shift[] {
  return shifts.filter((s) => shiftRunsOn(s, ymd, weekday) && shiftPeopleOn(s, ymd).includes(userId));
}

function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatShiftHours(shift: Shift, weekday?: number): string {
  if (!validHours(shift)) return '';
  const hours = weekday === undefined ? shift : shiftHoursOn(shift, weekday);
  return `${clock(hours.startMinutes)} – ${clock(hours.endMinutes)}${hours.endMinutes < hours.startMinutes ? ' (next day)' : ''}`;
}

export function shiftLabel(shift: Shift, weekday?: number, task?: ShiftTask): string {
  const time = task?.shiftTime ? [task.targetTime, task.targetTime2].filter(Boolean).join(' · ') : formatShiftHours(shift, weekday);
  return `${shift.name} · ${time}`;
}

export function minutesInShift(shift: Shift, minutes: number, weekday?: number): boolean {
  if (!validHours(shift) || !Number.isFinite(minutes) || minutes < 0 || minutes >= 1440) return false;
  const hours = weekday === undefined ? shift : shiftHoursOn(shift, weekday);
  return hours.endMinutes < hours.startMinutes
    ? minutes >= hours.startMinutes || minutes <= hours.endMinutes
    : minutes >= hours.startMinutes && minutes <= hours.endMinutes;
}

export function taskWithShiftTimes<T extends ShiftTask>(task: T, shiftsById: ReadonlyMap<string, Shift> | Record<string, Shift>, weekday?: number): T {
  const shift = task.shiftId
    ? (shiftsById instanceof Map ? shiftsById.get(task.shiftId)
      : Object.prototype.hasOwnProperty.call(shiftsById, task.shiftId) ? (shiftsById as Record<string, Shift>)[task.shiftId] : undefined)
    : undefined;
  if (!validHours(shift) || (task.venueId && shift.venueId !== task.venueId)) return task;
  const hours = weekday === undefined ? shift : shiftHoursOn(shift, weekday);
  return {
    ...task, daysOfWeek: shiftWeekdays(shift),
    ...(shift.oneTimeDate ? { scheduleType: 'specific_dates' as const, specificDates: [shift.oneTimeDate] } : {}),
    ...(!task.shiftTime ? {
      targetTime: clock(hours.startMinutes), targetTime2: clock(hours.endMinutes),
      targetTimeMinutes: hours.startMinutes, targetTime2Minutes: hours.endMinutes,
    } : {}),
  };
}

function timeMinutes(task: ShiftTask): number | null {
  if (Number.isInteger(task.targetTimeMinutes) && task.targetTimeMinutes! >= 0 && task.targetTimeMinutes! < 1440) return task.targetTimeMinutes!;
  const text = typeof task.targetTime === 'string' ? task.targetTime.trim() : '';
  if (!text || /^(any time|end of day)$/i.test(text)) return null;
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
    const shift = task.shiftId ? known.get(task.shiftId) : undefined;
    if (shift && (!task.venueId || shift.venueId === task.venueId)) {
      const occurrence = shiftOccurrenceDay(shift, ymd, weekday, nowMinutes ?? 0);
      return occurrence !== null && shiftPeopleOn(shift, occurrence).includes(user.id);
    }
    if (personal) return true;
    if (!team) return false;
    const minutes = timeMinutes(task);
    return minutes === null || mine.some((s) => {
      if (task.venueId && s.venueId !== task.venueId) return false;
      if (shiftRunsOn(s, ymd, weekday) && shiftPeopleOn(s, ymd).includes(user.id) && minutesInShift(s, minutes, weekday)) return true;
      const yesterday = addDays(ymd, -1), w = (weekday + 6) % 7;
      const hours = shiftHoursOn(s, w);
      return nowMinutes !== undefined && hours.endMinutes < hours.startMinutes && nowMinutes < hours.endMinutes
        && shiftRunsOn(s, yesterday, w) && shiftPeopleOn(s, yesterday).includes(user.id) && minutesInShift(s, minutes, w);
    });
  });
}
