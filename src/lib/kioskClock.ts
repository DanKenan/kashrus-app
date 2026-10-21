/**
 * D3c — kiosk clock helpers (client only, no data).
 *
 * The greeting follows the tablet's own local hour; the Hebrew date comes
 * from the browser's Hebrew calendar (Intl). Nothing here is stored or sent.
 */

/** "Good morning" 5–11, "Good afternoon" 12–16, otherwise "Good evening". */
export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "9:14 PM" in the tablet's locale. */
export function clockText(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Tuesday" in the tablet's locale. */
export function weekdayText(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}

/** Hebrew letter numerals (gematria): 10 -> "י׳", 19 -> "י״ט", 15 -> "ט״ו", 787 -> "תשפ״ז". */
export function hebrewNumeral(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const hundreds = ['', 'ק', 'ר', 'ש', 'ת'];
  let rest = Math.floor(n) % 1000;
  let s = '';
  while (rest >= 400) { s += 'ת'; rest -= 400; }
  if (rest >= 100) { s += hundreds[Math.floor(rest / 100)]; rest %= 100; }
  // 15 and 16 are written ט״ו / ט״ז, never with the divine name.
  if (rest === 15) s += 'טו';
  else if (rest === 16) s += 'טז';
  else { s += tens[Math.floor(rest / 10)]; s += ones[rest % 10]; }
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}

/**
 * The Hebrew date in Hebrew letters (e.g. "י׳ בחשוון תשפ״ז"), or '' when the
 * browser has no Hebrew calendar. Shown, never translated (spec §7).
 */
export function hebrewDateText(date: Date): string {
  try {
    const f = new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' });
    if (f.resolvedOptions().calendar !== 'hebrew') return '';
    const parts = f.formatToParts(date);
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    const month = parts.find((p) => p.type === 'month')?.value || '';
    const year = Number(parts.find((p) => p.type === 'year')?.value);
    if (!day || !month || !year) return f.format(date);
    return `${hebrewNumeral(day)} ב${month} ${hebrewNumeral(year)}`;
  } catch {
    return '';
  }
}

/** Two initials for the avatar ("Moshe Klein" -> "MK"; one word -> one letter). */
export function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = Array.from(parts[0])[0] || '';
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] || '' : '';
  return (first + last).toUpperCase();
}
