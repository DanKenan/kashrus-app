// QA2 #18/#19: a calendar date ("2026-11-05") as people read it ("Thu, Nov 5").
// The date is a plain day (no time zone): it is formatted in UTC so it never shifts.
// The year is added only when it is not the current year. Anything else is returned unchanged.

const fmtNoYear = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const fmtYear = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export function formatWorkDate(ymd: unknown, now: Date = new Date()): string {
  const s = typeof ymd === 'string' ? ymd : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return s;
  return (y === now.getFullYear() ? fmtNoYear : fmtYear).format(dt);
}
