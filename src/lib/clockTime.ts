/**
 * QA2 #4 — clock times typed as free text ("11:00 AM", "16:00", "16:00 PM").
 *
 * Events and audit reports store start/end times as text. Old defaults wrote
 * 24-hour numbers with "PM" ("16:00 PM", "14:30 PM"). formatClockTime turns any
 * time we can read into the 12-hour form people expect ("4:00 PM"); text we
 * can't read (e.g. "after Maariv") comes back unchanged, trimmed.
 */
export function formatClockTime(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])?\.?\s*(m)?\.?$/i.exec(s);
  if (!m) return s;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59 || h > 23) return s;
  const mer = m[3] ? m[3].toLowerCase() : '';
  if (!mer && m[2] === undefined) return s; // a bare number ("7") is ambiguous
  let pm: boolean;
  if (h >= 13) pm = true; // 24-hour clock wins over a wrong "AM/PM"
  else if (h === 0) { pm = false; h = 12; }
  else if (mer) pm = mer === 'p';
  else pm = h === 12;
  if (h > 12) h -= 12;
  return `${h}:${String(min).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
}

/** "4:00 PM – 9:00 PM", "4:00 PM", or '' for an event's or report's times. */
export function formatTimeRange(start: unknown, end: unknown, sep = ' – '): string {
  const a = formatClockTime(start);
  const b = formatClockTime(end);
  if (a && b) return `${a}${sep}${b}`;
  return a || b;
}
