/**
 * Item 6 — work-day time zones (shared by server.ts and the client).
 *
 * A venue's work day, "today" and daily reset follow its IANA time zone when
 * set, else its agency's, else America/New_York — never the server's UTC
 * clock and never the device's zone. Pure functions, no dependencies: every
 * caller passes the instant ("now") it decides on, so tests can use a fake
 * clock.
 */

export const DEFAULT_TIME_ZONE = 'America/New_York';

const IANA_SHAPE = /^(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+){1,2})$/;
const validCache = new Map<string, boolean>();

/** True when `tz` is an IANA zone name this runtime knows (e.g. "Asia/Jerusalem"). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64 || !IANA_SHAPE.test(tz)) return false;
  const hit = validCache.get(tz);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    ok = true;
  } catch {
    ok = false;
  }
  validCache.set(tz, ok);
  return ok;
}

/**
 * The zone a venue runs on: the first VALID of the venue's own zone, its
 * agency's zone, then America/New_York. An invalid stored value never throws;
 * it falls through to the next one.
 */
export function effectiveTimeZone(venueTz?: unknown, agencyTz?: unknown): string {
  if (isValidTimeZone(venueTz)) return venueTz;
  if (isValidTimeZone(agencyTz)) return agencyTz;
  return DEFAULT_TIME_ZONE;
}

/** Client helper: the zone for a venue object as the app holds it. */
export function venueTimeZone(
  venue?: { timeZone?: string } | null,
  user?: { agencyTimeZone?: string } | null
): string {
  return effectiveTimeZone(venue?.timeZone, user?.agencyTimeZone);
}

/** "New York time" / "Jerusalem time" / "UTC" for copy. */
export function zoneCityLabel(tz: string): string {
  if (tz === 'UTC') return 'UTC';
  const city = tz.split('/').pop() || tz;
  return `${city.replace(/_/g, ' ')} time`;
}

/**
 * The date ("YYYY-MM-DD", in `tz`) of the next midnight at which a venue
 * with workday marker `marker` becomes due: the first local date D with
 * D > marker and D > today (B3a: computed, not promised).
 */
export function nextResetDate(tz: string, marker: string | null | undefined, at: Date | number = Date.now()): string {
  const tomorrow = addDays(workDateIn(tz, at), 1);
  if (!marker || !/^\d{4}-\d{2}-\d{2}$/.test(marker)) return tomorrow;
  const afterMarker = addDays(marker, 1);
  return afterMarker > tomorrow ? afterMarker : tomorrow;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    partsCache.set(tz, f);
  }
  return f;
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(tz: string, at: Date | number): ZonedParts {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  const d = typeof at === 'number' ? new Date(at) : at;
  const out: any = {};
  for (const p of formatterFor(zone).formatToParts(d)) out[p.type] = p.value;
  // Some engines print midnight as "24" even with h23; normalise.
  const hour = Number(out.hour) % 24;
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour,
    minute: Number(out.minute),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

/** The calendar date ("YYYY-MM-DD") in `tz` at the instant `at`. */
export function workDateIn(tz: string, at: Date | number = Date.now()): string {
  const p = zonedParts(tz, at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Day of the week in `tz` at `at`: 0 = Sunday … 6 = Saturday. */
export function weekdayIn(tz: string, at: Date | number = Date.now()): number {
  return zonedParts(tz, at).weekday;
}

/** Minutes since local midnight (0–1439) in `tz` at `at`. */
export function minutesIn(tz: string, at: Date | number = Date.now()): number {
  const p = zonedParts(tz, at);
  return p.hour * 60 + p.minute;
}

/** The local hour (0–23) in `tz` at `at`. */
export function hourIn(tz: string, at: Date | number = Date.now()): number {
  return zonedParts(tz, at).hour;
}

/** Calendar arithmetic on a "YYYY-MM-DD" date (no clock, so DST cannot skew it). */
export function addDays(ymd: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}

/** True for a well-formed "YYYY-MM-DD" string. */
export function isWorkDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Short curated list for the admin pickers (label, IANA name). */
export const COMMON_TIME_ZONES: Array<{ label: string; tz: string }> = [
  { label: 'New York (Eastern)', tz: 'America/New_York' },
  { label: 'Toronto (Eastern)', tz: 'America/Toronto' },
  { label: 'Chicago (Central)', tz: 'America/Chicago' },
  { label: 'Denver (Mountain)', tz: 'America/Denver' },
  { label: 'Phoenix (Arizona)', tz: 'America/Phoenix' },
  { label: 'Los Angeles (Pacific)', tz: 'America/Los_Angeles' },
  { label: 'Anchorage (Alaska)', tz: 'America/Anchorage' },
  { label: 'Honolulu (Hawaii)', tz: 'Pacific/Honolulu' },
  { label: 'Mexico City', tz: 'America/Mexico_City' },
  { label: 'Buenos Aires', tz: 'America/Argentina/Buenos_Aires' },
  { label: 'London', tz: 'Europe/London' },
  { label: 'Paris', tz: 'Europe/Paris' },
  { label: 'Jerusalem', tz: 'Asia/Jerusalem' },
  { label: 'Johannesburg', tz: 'Africa/Johannesburg' },
  { label: 'Sydney', tz: 'Australia/Sydney' },
  { label: 'UTC', tz: 'UTC' },
];

/** "Jerusalem (Asia/Jerusalem)" for a known zone, else the IANA name itself. */
export function timeZoneLabel(tz: string): string {
  const hit = COMMON_TIME_ZONES.find((z) => z.tz === tz);
  return hit ? `${hit.label} (${hit.tz})` : tz;
}
