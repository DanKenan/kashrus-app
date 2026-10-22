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
