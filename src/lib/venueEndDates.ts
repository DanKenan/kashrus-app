/**
 * 12a-c (plan v6 §7, 5.8): end dates on extra venues, as people read them.
 *
 * The server sends an end date as an instant (`until`, exclusive): the local
 * midnight AFTER the chosen day in the venue's zone. People read the day
 * before it ("Until Sunday"). Everything here is presentation: the server
 * decides access. Every field may be absent (an older server, a person with
 * no dates); then nothing new is shown and today's behaviour stays.
 */

/** All new 12a-c labels, in one place. */
export const END_DATE_TEXT = {
  noEndDate: 'No end date',
  addEndDate: 'Add end date',
  removeEndDate: 'Remove end date',
  endDateLabel: 'Last day',
  through: (day: string) => `through the end of ${day}`,
  untilTitle: (day: string) => `Until ${day}`,
  untilShort: (day: string) => `until ${day}`,
  selfUntil: (venue: string, day: string) => `You're at ${venue} until the end of ${day}.`,
  conflictReloaded: "Someone else just changed this person's venues. The latest is shown now. Check it and save again.",
  conflictReopen: "Someone else just changed this person's venues. Close and reopen to see the latest.",
  kioskEnded: 'Your time at this venue has ended.',
  noVenueTitle: "You're not on a venue right now.",
  noVenueBody: "When you're added to a venue, your tasks will show up here.",
  moreVenues: (n: number) => `+${n} more`,
  editorClosed: 'That venue is no longer on your list, so the task editor was closed.',
} as const;

export const DEFAULT_TIME_ZONE = 'America/New_York';
const DAY_MS = 86400000;

/** A zone the browser accepts, else the default. */
export function safeZone(zone: unknown): string {
  if (typeof zone === 'string' && zone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return zone;
    } catch { /* fall through */ }
  }
  return DEFAULT_TIME_ZONE;
}

/** The venue's zone, else the agency's, else New York (same order as the server). */
export function zoneForVenue(venue: { timeZone?: string } | null | undefined, agencyTimeZone?: string): string {
  if (venue && typeof venue.timeZone === 'string' && venue.timeZone) return safeZone(venue.timeZone);
  return safeZone(agencyTimeZone);
}

/** 'YYYY-MM-DD' of an instant in a zone. */
export function ymdIn(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(zone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A strict instant (the server writes ISO with Z); anything else is null. */
export function parseUntil(until: unknown): number | null {
  if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(until)) return null;
  const ms = Date.parse(until);
  // A date that does not exist (Feb 30) must not roll forward: it has to read back the same.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 16) !== until.slice(0, 16)) return null;
  return ms;
}

/** The last day a grant covers: the local day of (until - 1 ms). */
export function lastDayOf(until: unknown, zone: string): string | null {
  const ms = parseUntil(until);
  return ms === null ? null : ymdIn(ms - 1, zone);
}

function ymdToUtc(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return t;
}

/** Whole days from `fromYmd` to `toYmd` (calendar days). */
export function daysBetween(fromYmd: string, toYmd: string): number | null {
  const a = ymdToUtc(fromYmd); const b = ymdToUtc(toYmd);
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS);
}

/** 'YYYY-MM-DD' plus n days. */
export function addDays(ymd: string, n: number): string {
  const t = ymdToUtc(ymd);
  if (t === null) return ymd;
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

const WEEKDAY_LONG = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
const WEEKDAY_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
const DAY_MONTH = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

export interface DayWords {
  /** "today", "Sunday", or "Sun, Nov 8" (sheet title, self line). */
  long: string;
  /** "today", "Sun", or "Nov 8" (roster). */
  short: string;
  /** Always the full day: "Sun, Oct 25". */
  full: string;
}

/** How a last day reads, seen from today (both 'YYYY-MM-DD' in the same zone). */
export function dayWords(lastDay: string, today: string): DayWords | null {
  const t = ymdToUtc(lastDay);
  const diff = daysBetween(today, lastDay);
  if (t === null || diff === null) return null;
  const d = new Date(t);
  const full = DAY_MONTH.format(d);
  if (diff === 0) return { long: 'today', short: 'today', full };
  if (diff > 0 && diff <= 6) return { long: WEEKDAY_LONG.format(d), short: WEEKDAY_SHORT.format(d), full };
  return { long: full, short: MONTH_DAY.format(d), full };
}

// ---------------------------------------------------------------------------
// The server clock (5.8: the client schedules from server time).
// ---------------------------------------------------------------------------
let serverOffsetMs = 0;

/**
 * Record the server's clock from a serverNow field (ignored when absent or
 * malformed). True when the offset moved by more than a second (timers re-arm).
 */
export function noteServerNow(serverNow: unknown, localNow: number = Date.now()): boolean {
  const ms = parseUntil(serverNow);
  if (ms === null) return false;
  const next = ms - localNow;
  const moved = Math.abs(next - serverOffsetMs) > 1000;
  serverOffsetMs = next;
  return moved;
}

/** Now, on the server's clock as last seen. */
export function serverNowMs(localNow: number = Date.now()): number {
  return localNow + serverOffsetMs;
}

/** Test hook. */
export function resetServerOffset(): void { serverOffsetMs = 0; }

/** The person's own active end dates (venueId -> until), only well-formed entries. */
export function cleanUntilMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k && parseUntil(v) !== null) out[k] = v as string;
  }
  return out;
}

/** Venues whose end has passed at `nowMs` (server clock). */
export function endedVenues(untilMap: Record<string, string>, nowMs: number): string[] {
  return Object.entries(untilMap).filter(([, u]) => { const ms = parseUntil(u); return ms !== null && nowMs >= ms; }).map(([k]) => k);
}

/** The next end instant after `nowMs`, or null. */
export function nextEndMs(untilMap: Record<string, string>, nowMs: number): number | null {
  let best: number | null = null;
  for (const u of Object.values(untilMap)) {
    const ms = parseUntil(u);
    if (ms !== null && ms > nowMs && (best === null || ms < best)) best = ms;
  }
  return best;
}

// ---------------------------------------------------------------------------
// "Venues for [name]": the changes to send to POST /api/users/:id/venue-ops.
// ---------------------------------------------------------------------------
export type VenueOp =
  | { op: 'add'; venueId: string; until: string | null }
  | { op: 'remove'; venueId: string }
  | { op: 'set_until'; venueId: string; until: string | null };

/**
 * From the extra venues as opened (with their last days) to the extra venues
 * as chosen (with their last days). A last day is 'YYYY-MM-DD' or null (no
 * end date). The main venue is never in either list.
 */
export function buildVenueOps(
  before: { extras: string[]; lastDay: Record<string, string | null> },
  after: { extras: string[]; lastDay: Record<string, string | null> },
): VenueOp[] {
  const ops: VenueOp[] = [];
  const was = new Set(before.extras);
  const now = new Set(after.extras);
  for (const id of after.extras) {
    const day = after.lastDay[id] ?? null;
    if (!was.has(id)) ops.push({ op: 'add', venueId: id, until: day });
    else if ((before.lastDay[id] ?? null) !== day) ops.push({ op: 'set_until', venueId: id, until: day });
  }
  for (const id of before.extras) if (!now.has(id)) ops.push({ op: 'remove', venueId: id });
  return ops;
}

/** Roster lines for a person's dated extra venues ("Hill Deli until Sun"), in venue order. */
export function rosterUntilLines(
  user: { venueId?: string; venueIds?: string[]; venueUntil?: Record<string, string> },
  venues: { id: string; name: string; timeZone?: string }[],
  agencyTimeZone?: string,
  nowMs: number = serverNowMs(),
): { venueId: string; text: string }[] {
  const until = user.venueUntil;
  if (!until || typeof until !== 'object' || !Array.isArray(user.venueIds)) return [];
  const out: { venueId: string; text: string }[] = [];
  for (const venue of venues) {
    if (venue.id === user.venueId || !user.venueIds.includes(venue.id)) continue;
    const zone = zoneForVenue(venue, agencyTimeZone);
    const day = lastDayOf(until[venue.id], zone);
    const words = day ? dayWords(day, ymdIn(nowMs, zone)) : null;
    if (words) out.push({ venueId: venue.id, text: `${venue.name} ${END_DATE_TEXT.untilShort(words.short)}` });
  }
  return out;
}

/**
 * The signed-in person's own scope from SCOPE_CHANGED / INITIAL_STATE
 * (5.8). Returns `prev` itself when nothing changed (no re-render) or when
 * the payload is for someone else. Absent fields leave today's values.
 */
export function withOwnScope<T extends { id: string; venueId?: string; myVenueIds?: string[]; myVenueUntil?: Record<string, string>; myVenueRev?: number }>(
  prev: T | null,
  userId: string,
  payload: { venueIds?: unknown; myVenueUntil?: unknown; myVenueRev?: unknown } | null | undefined,
): T | null {
  if (!prev || prev.id !== userId || !payload) return prev;
  const next: T = { ...prev };
  if (Array.isArray(payload.venueIds)) {
    const ids = (payload.venueIds as unknown[]).filter((v): v is string => typeof v === 'string' && !!v);
    const home = prev.venueId && ids.includes(prev.venueId) ? [prev.venueId] : [];
    next.myVenueIds = [...home, ...ids.filter((v) => v !== prev.venueId)];
  }
  if (payload.myVenueUntil !== undefined) next.myVenueUntil = cleanUntilMap(payload.myVenueUntil);
  if (typeof payload.myVenueRev === 'number' && Number.isInteger(payload.myVenueRev)) next.myVenueRev = payload.myVenueRev;
  const same = JSON.stringify([prev.myVenueIds, prev.myVenueUntil, prev.myVenueRev]) === JSON.stringify([next.myVenueIds, next.myVenueUntil, next.myVenueRev]);
  return same ? prev : next;
}

/**
 * A person's own end date passed (server clock): drop those venues from
 * their scope now (presentation only; the server's INITIAL_STATE follows).
 */
export function withoutEndedVenues<T extends { myVenueIds?: string[]; myVenueUntil?: Record<string, string> }>(prev: T | null, nowMs: number): T | null {
  if (!prev || !prev.myVenueUntil) return prev;
  const ended = endedVenues(prev.myVenueUntil, nowMs);
  if (ended.length === 0) return prev;
  const until = { ...prev.myVenueUntil };
  for (const id of ended) delete until[id];
  return {
    ...prev,
    myVenueUntil: until,
    ...(Array.isArray(prev.myVenueIds) ? { myVenueIds: prev.myVenueIds.filter((id) => !ended.includes(id)) } : {}),
  };
}

/**
 * 12a-c (RV2): the task editor's venue is no longer in the person's own scope.
 * Only a non-admin with the server's own scope (myVenueIds) can lose a venue
 * this way; no venue id, an admin, or an old server -> false (today's behavior).
 */
export function venueLeftOwnScope(user: { role?: string; myVenueIds?: string[] } | null | undefined, venueId: string | null | undefined): boolean {
  if (!user || user.role === 'admin' || !venueId || !Array.isArray(user.myVenueIds)) return false;
  return !user.myVenueIds.includes(venueId);
}
