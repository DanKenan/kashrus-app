import { addDays, minutesIn, workDateIn, DEFAULT_TIME_ZONE } from './workday.ts';
import { isAnyTimeTask } from './anyTime';

/**
 * QA2 #25: one overdue rule for the board and the dashboard. This mirrors the
 * dashboard's server rule (server.ts venueStats.overdueList): not done, not an
 * any-time task, a real target time (not "End of Day"), and that time has
 * passed today in the venue's own time zone.
 */
export function targetMinutesOf(t: { targetTime?: string | null; targetTimeMinutes?: number | null }): number {
  if (typeof t.targetTimeMinutes === 'number') return t.targetTimeMinutes;
  const s = (t.targetTime || '').trim();
  if (!s) return Infinity;
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/);
  if (m12) {
    let h = parseInt(m12[1], 10) % 12;
    if (/^[Pp]/.test(m12[3])) h += 12;
    return h * 60 + parseInt(m12[2], 10);
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
  return Infinity;
}

export type CheckInTask = {
  inputType?: string;
  checkIns?: { at: string }[];
  targetTime?: string | null; targetTimeMinutes?: number | null;
  targetTime2?: string | null; targetTime2Minutes?: number | null;
};

/** Pure check-in coverage for the latest passed deadline; offsets use the start day. */
export function checkInCoversDue(
  task: CheckInTask, day: string, elapsed: number, timeZone = DEFAULT_TIME_ZONE,
  start = 0, deadlines = [targetMinutesOf(task), targetMinutesOf({ targetTime: task.targetTime2, targetTimeMinutes: task.targetTime2Minutes })],
): boolean {
  if (task.inputType !== 'check_in') return false;
  const passed = [...new Set(deadlines.filter(Number.isFinite))].sort((a, b) => a - b).filter((m) => m < elapsed);
  const lower = passed.length > 1 ? passed[passed.length - 2] : start;
  return (task.checkIns || []).some((check) => {
    const at = Date.parse(check.at);
    if (!Number.isFinite(at)) return false;
    const date = workDateIn(timeZone, at);
    if (date !== day && date !== addDays(day, 1)) return false;
    const offset = minutesIn(timeZone, at) + (date === day ? 0 : 1440);
    return offset >= lower && offset <= elapsed;
  });
}

export function isTaskOverdue(
  t: { isCompleted?: boolean; targetTime?: string | null; targetTimeMinutes?: number | null },
  venueNowMinutes: number | null | undefined,
): boolean {
  if (venueNowMinutes == null || t.isCompleted) return false;
  if (isAnyTimeTask(t as any)) return false;
  if (!t.targetTime || t.targetTime === 'End of Day') return false;
  return targetMinutesOf(t) < venueNowMinutes;
}

export const OVERDUE_CHIP_CLASS =
  'inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider border';
