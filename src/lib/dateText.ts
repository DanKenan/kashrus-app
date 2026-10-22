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

// QA2 #30: a note's time as people read it: "Today 11:51 PM", "Yesterday 9:05 AM",
// "Tue, Oct 20, 9:05 AM" (year added when it is not this year). Device time zone, no seconds.
export function formatNoteTime(iso: unknown, now: Date = new Date()): string {
  const d = new Date(typeof iso === 'string' ? iso : '');
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return `Today ${time}`;
  if (dayKey(d) === dayKey(y)) return `Yesterday ${time}`;
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${day}, ${time}`;
}

// QA2 #30: the shift a new note starts on, from the clock (it can still be changed).
export function shiftForHour(h: number): 'Morning' | 'Afternoon' | 'Evening' {
  if (h >= 5 && h < 12) return 'Morning';
  if (h >= 12 && h < 17) return 'Afternoon';
  return 'Evening';
}
