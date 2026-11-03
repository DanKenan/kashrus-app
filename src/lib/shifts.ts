import { taskAssigneesOn, taskOwnsPeople, type TaskPeople } from './taskAssignees.ts';
import type { Shift, ShiftDay } from '../types.ts';
import { isTaskOverdue, targetMinutesOf } from './overdue.ts';
import { addDays, isWorkDate, DEFAULT_TIME_ZONE, workDateIn, minutesIn } from './workday.ts';

type ShiftTask = TaskPeople & {
  createdAt?: string;
  shiftTime?: boolean;
  shiftId?: string | null; venueId?: string; assignedTo?: unknown;
  scheduleType?: 'recurring' | 'specific_dates'; specificDates?: string[];
  daysOfWeek?: number[]; targetTime?: string; targetTime2?: string;
  targetTimeMinutes?: number; targetTime2Minutes?: number;
};

/** Built-ins are code defaults. Only a venue edit or tombstone is persisted. */
export type ShiftRecord = Shift | { id: string; venueId: string; agencyId?: string; deleted: true };
export function builtinShiftVenue(id: unknown): string | undefined {
  if (typeof id !== 'string' || !/^builtin-(morning|afternoon|night):/.test(id)) return undefined;
  try { return decodeURIComponent(id.slice(id.indexOf(':') + 1)) || undefined; } catch { return undefined; }
}
export function isBuiltinShiftId(id: unknown): boolean {
  return typeof id === 'string' && (/^builtin-(morning|afternoon|night)$/.test(id) || builtinShiftVenue(id) !== undefined);
}
export function venueShifts(records: readonly ShiftRecord[], venueId: string, agencyId = 'agency-hkc'): Shift[] {
  const own = records.filter((s) => s.venueId === venueId && (s.agencyId || 'agency-hkc') === agencyId);
  const live = own.filter((s): s is Shift => !('deleted' in s && s.deleted));
  const defaults = [['morning', 'Morning', 360, 840], ['afternoon', 'Afternoon', 840, 1320], ['night', 'Night', 1320, 360]] as const;
  return [...live, ...defaults.filter(([key, name]) => !own.some((s) => s.id.split(':')[0] === `builtin-${key}`)
    && !live.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())).map(([key, name, startMinutes, endMinutes]) => ({
      // The venue travels in the id so installed clients can send a bodyless DELETE.
      id: `builtin-${key}:${encodeURIComponent(venueId)}`, venueId, agencyId, name, area: '', startMinutes, endMinutes,
      days: Array.from({ length: 7 }, () => ({ on: true })), userIds: [], userId: null, overrides: [], createdAt: '',
    }))];
}
/** The single scoped lookup for stored and built-in task shifts. Bare ids remain accepted with a venue. */
export function resolveTaskShift(task: { shiftId?: unknown; venueId?: string; agencyId?: string }, records: readonly ShiftRecord[]): Shift | undefined {
  if (typeof task.shiftId !== 'string' || !task.venueId) return undefined;
  const encodedVenue = builtinShiftVenue(task.shiftId);
  if (encodedVenue && encodedVenue !== task.venueId) return undefined;
  const shiftId = task.shiftId;
  const matches = (id: string) => id === shiftId || (isBuiltinShiftId(shiftId) && isBuiltinShiftId(id) && id.split(':')[0] === shiftId.split(':')[0]);
  const stored = records.find((s) => matches(s.id) && s.venueId === task.venueId
    && (s.agencyId || 'agency-hkc') === (task.agencyId || 'agency-hkc'));
  if (stored) return 'deleted' in stored && stored.deleted ? undefined : stored as Shift;
  return venueShifts(records, task.venueId, task.agencyId).find((s) => matches(s.id));
}

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

/** Canonical editable content, without IDs, timestamps or server-derived names. */
export function shiftEditableFields(shift: Shift, today?: string) {
  const normalized = normalizeShifts([shift])[0];
  return {
    name: normalized.name.trim(), area: normalized.area.trim(),
    oneTimeDate: normalized.oneTimeDate || null,
    startMinutes: normalized.startMinutes, endMinutes: normalized.endMinutes,
    userIds: normalized.userIds, days: normalized.days.map(({ on, userIds, startMinutes, endMinutes }) => ({ on, userIds, startMinutes, endMinutes })),
    overrides: normalized.overrides.filter((o) => !today || o.date >= today).sort((a, b) => a.date.localeCompare(b.date)).map(({ date, userIds }) => ({ date, userIds })),
  };
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

/** Own clock times before an overnight start belong to its next morning. */
export function shiftTimeOffset(shift: Shift, minutes: number, weekday?: number): number {
  if (!Number.isFinite(minutes)) return minutes;
  const clockMinutes = minutes % 1440;
  const hours = weekday === undefined ? shift : shiftHoursOn(shift, weekday);
  return clockMinutes + (hours.endMinutes < hours.startMinutes && clockMinutes < hours.startMinutes ? 1440 : 0);
}

/** Yesterday remains the overdue occurrence until the next window starts. */
function previousOvernightOverdueDay(shift: Shift, ymd: string, weekday: number, nowMinutes: number): string | null {
  const previous = shiftHoursOn(shift, (weekday + 6) % 7);
  const hours = shiftHoursOn(shift, weekday);
  const nextStart = shiftRunsOn(shift, ymd, weekday) ? Math.min(previous.startMinutes, hours.startMinutes) : previous.startMinutes;
  const yesterday = addDays(ymd, -1);
  return previous.endMinutes < previous.startMinutes && nowMinutes < nextStart
    && shiftRunsOn(shift, yesterday, (weekday + 6) % 7) ? yesterday : null;
}

/** Keep start-day assignments through an overnight window AND its overdue tail. */
export function shiftPeopleOccurrenceDay(shift: Shift, ymd: string, weekday: number, nowMinutes: number): string {
  return previousOvernightOverdueDay(shift, ymd, weekday, nowMinutes)
    || shiftOccurrenceDay(shift, ymd, weekday, nowMinutes) || ymd;
}

/** A task cannot inherit a deadline that passed before it existed. No I/O.
 * deadlineMinutes is relative to the occurrence START date (may exceed 1440).
 * Missing/invalid legacy creation dates preserve the existing overdue rule.
 */
export function shiftDeadlineExisted(task: { createdAt?: string } | undefined, occurrenceDay: string, deadlineMinutes: number, timeZone = DEFAULT_TIME_ZONE): boolean {
  const created = Date.parse(task?.createdAt || '');
  if (!Number.isFinite(created) || !Number.isFinite(deadlineMinutes)) return true;
  const wallDeadline = Date.parse(`${occurrenceDay}T00:00:00Z`) + deadlineMinutes * 60_000;
  const localClock = (at: number) => Date.parse(`${workDateIn(timeZone, at)}T00:00:00Z`) + minutesIn(timeZone, at) * 60_000;
  // Nearby offsets cover either side of a DST transition. For repeated clock
  // times use the first deadline; a skipped clock time rolls forward.
  const candidates = [...new Set([-1, 0, 1].map((day) => {
    const sample = wallDeadline + day * 86_400_000;
    return wallDeadline - (localClock(sample) - sample);
  }))];
  const exact = candidates.filter((at) => localClock(at) === wallDeadline);
  const deadline = exact.length ? Math.min(...exact) : Math.max(...candidates);
  return created <= deadline;
}

export function shiftOwnTimeOverdueDay(shift: Shift, ymd: string, weekday: number, nowMinutes: number, task: ShiftTask, timeZone = DEFAULT_TIME_ZONE): string | null {
  if (!validHours(shift) || !Number.isFinite(nowMinutes) || nowMinutes < 0 || nowMinutes >= 1440) return null;
  const occurrence = previousOvernightOverdueDay(shift, ymd, weekday, nowMinutes)
    || shiftOccurrenceDay(shift, ymd, weekday, nowMinutes);
  if (!occurrence) return null;
  const startWeekday = weekdayOf(occurrence);
  const deadline = shiftTimeOffset(shift, targetMinutesOf(task), startWeekday);
  const elapsed = nowMinutes + (occurrence !== ymd ? 1440 : 0);
  return isTaskOverdue({ ...task, targetTimeMinutes: deadline }, elapsed)
    && shiftDeadlineExisted(task, occurrence, deadline, timeZone) ? occurrence : null;
}

export function shiftTaskOverdueAt(shift: Shift, ymd: string, weekday: number, nowMinutes: number, task?: ShiftTask, timeZone = DEFAULT_TIME_ZONE): boolean {
  if (task?.shiftTime) return shiftOwnTimeOverdueDay(shift, ymd, weekday, nowMinutes, task, timeZone) !== null;
  if (!validHours(shift) || !Number.isFinite(nowMinutes) || nowMinutes < 0 || nowMinutes >= 1440) return false;
  const previous = shiftHoursOn(shift, (weekday + 6) % 7);
  const hours = shiftHoursOn(shift, weekday);
  if (nowMinutes > previous.endMinutes && previousOvernightOverdueDay(shift, ymd, weekday, nowMinutes)) {
    return shiftDeadlineExisted(task, addDays(ymd, -1), previous.endMinutes + 1440, timeZone);
  }
  return hours.endMinutes > hours.startMinutes && shiftRunsOn(shift, ymd, weekday) && nowMinutes > hours.endMinutes
    && shiftDeadlineExisted(task, ymd, hours.endMinutes, timeZone);
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
  const time = task?.shiftTime ? [task.targetTime, task.targetTime2].filter(Boolean).map((text, i) => `${text}${shiftTimeOffset(shift, targetMinutesOf(i ? { targetTime: task.targetTime2, targetTimeMinutes: task.targetTime2Minutes } : task), weekday) >= 1440 ? ' (next day)' : ''}`).join(' · ') : formatShiftHours(shift, weekday);
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
    const shift = task.shiftId ? known.get(task.shiftId) : undefined;
    const occurrence = shift && (!task.venueId || shift.venueId === task.venueId)
      ? shiftOccurrenceDay(shift, ymd, weekday, nowMinutes ?? 0) : ymd;
    const assigned = taskAssigneesOn(task, occurrence || ymd);
    const personal = assigned.includes(typeof user.email === 'string' ? user.email.trim().toLowerCase() : '');
    const team = assigned.length === 0 || assigned.includes('all');
    if (taskOwnsPeople(task) && (occurrence === null || (!personal && !team))) return false;
    if (taskOwnsPeople(task) && personal) return true;
    if (taskOwnsPeople(task) && team && timeMinutes(task) !== null && !mine.length) return false;
    if (!mine.length) return personal || team;
    if (!taskOwnsPeople(task) && shift && (!task.venueId || shift.venueId === task.venueId)) {
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
