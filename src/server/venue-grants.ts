/**
 * Item 12, 12a-s (plan v6 4.1-4.3, 4.6, 5.1): per-venue end dates for EXTRA
 * venues of a membership. Pure helpers; server.ts passes the fresh row, the
 * fresh venues and the clock.
 *
 * Storage on a membership row (all server-only, see identity.ts):
 *   venueGrants  { [venueId]: { from: ISO|null, until: ISO|null, by: id|null } }
 *                metadata of EXTRA venues in venueAccess (never the home).
 *                until = the exclusive end instant (access while now < until).
 *   venueHistory closed intervals, newest first, cap 10; entries whose end
 *                (`to`) is 14 days old or older are dropped (Don, Oct 23:
 *                "2 weeks"; 12b-s).
 *   venueRev     integer, +1 on every grant change.
 *   noHomeVenue  true = a non-admin row with NO main venue (12b-s Pool);
 *                venueAccess is then a plain list of extras (no home head).
 *
 * Fail closed (4.2): venueGrants absent = legacy (every extra undated);
 * present but not a plain object or with more than 50 keys = MALFORMED (every
 * extra denied). Entry: absent / no until key / until null = undated; not a
 * plain object, or a non-null until that is not a strict ISO instant = denied.
 */

export const MAX_GRANT_KEYS = 50;
export const HISTORY_CAP = 10;
/** 12b-s (Don, Oct 23 4:16 AM): venue history is kept for 2 weeks only. */
export const HISTORY_RETENTION_MS = 14 * 86400000;
export const MAX_UNTIL_DAYS = 366;
export const DEFAULT_TIME_ZONE = 'America/New_York';

export type GrantState =
  | { kind: 'undated' }
  | { kind: 'dated'; untilMs: number; until: string }
  | { kind: 'denied' };

export type HistoryWhy = 'ended' | 'unticked' | 'moved_to_pool' | 'made_main' | 'main_replaced' | 'venue_deleted' | 'invalid_data' | 'joined_pool';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

/** 'legacy' (no venueGrants key or undefined), 'ok', or 'malformed'. */
export function grantContainer(row: any): 'legacy' | 'ok' | 'malformed' {
  if (!row || typeof row !== 'object' || !has(row, 'venueGrants') || row.venueGrants === undefined) return 'legacy';
  const g = row.venueGrants;
  if (!isPlainObject(g)) return 'malformed';
  if (Object.keys(g).length > MAX_GRANT_KEYS) return 'malformed';
  return 'ok';
}

export function parseInstant(x: unknown): number | null {
  if (typeof x !== 'string' || !ISO_INSTANT.test(x)) return null;
  const ms = Date.parse(x);
  if (!Number.isFinite(ms)) return null;
  // Exact round trip (the writer only stores toISOString()): an impossible
  // calendar instant (2027-02-30T...) that Date.parse would roll forward is
  // malformed, and malformed denies.
  return new Date(ms).toISOString() === x ? ms : null;
}

/** The grant state of one EXTRA venue of a row (never call it for the home). */
export function grantStateFor(row: any, venueId: string): GrantState {
  const c = grantContainer(row);
  if (c === 'malformed') return { kind: 'denied' };
  if (c === 'legacy') return { kind: 'undated' };
  const g = row.venueGrants as Record<string, unknown>;
  if (!has(g, venueId)) return { kind: 'undated' };
  const e = g[venueId];
  if (!isPlainObject(e)) return { kind: 'denied' };
  if (!has(e, 'until') || e.until === null) return { kind: 'undated' };
  const ms = parseInstant(e.until);
  if (ms === null) return { kind: 'denied' };
  return { kind: 'dated', untilMs: ms, until: e.until as string };
}

/** Does an EXTRA venue grant access at nowMs? (until is exclusive) */
export function extraActive(row: any, venueId: string, nowMs: number): boolean {
  const s = grantStateFor(row, venueId);
  if (s.kind === 'undated') return true;
  if (s.kind === 'dated') return nowMs < s.untilMs;
  return false;
}

/** A non-admin row with no main venue (the explicit marker; legacy falsy homes are NOT homeless). */
export function isHomeless(row: any): boolean {
  return !!row && row.role !== 'admin' && row.noHomeVenue === true && !(typeof row.venueId === 'string' && row.venueId);
}

/** Active dated ends of a row's extra venues: { venueId: untilIso } (only venues in `scope`). */
export function activeUntilMap(row: any, scope: readonly string[], nowMs: number): Record<string, string> {
  const out: Record<string, string> = {};
  const home = typeof row?.venueId === 'string' ? row.venueId : '';
  for (const v of scope) {
    if (!v || v === home) continue;
    const s = grantStateFor(row, v);
    if (s.kind === 'dated' && nowMs < s.untilMs) out[v] = s.until;
  }
  return out;
}

/** The venueRev of a row (absent/invalid = 0). */
export function venueRevOf(row: any): number {
  const r = row?.venueRev;
  return Number.isInteger(r) && r >= 0 ? r : 0;
}

/** Does the row carry any grant state beyond today's (dates, history, rev, marker)? */
export function hasGrantState(row: any): boolean {
  if (!row || typeof row !== 'object') return false;
  return (has(row, 'venueGrants') && row.venueGrants !== undefined) || Array.isArray(row.venueHistory) || row.venueRev !== undefined || row.noHomeVenue !== undefined;
}

// ---------------------------------------------------------------------------
// Dates: a calendar date -> the next local midnight AFTER it, in an IANA zone.
// ---------------------------------------------------------------------------
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dateFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 'YYYY-MM-DD' of instant ms in zone tz. */
export function localDate(ms: number, tz: string): string {
  const parts = dateFmt(tz).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value || '';
  return `${p('year')}-${p('month')}-${p('day')}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar date 'YYYY-MM-DD' -> its UTC-midnight ms (calendar arithmetic only), else null. */
export function calendarDateMs(d: unknown): number | null {
  if (typeof d !== 'string') return null;
  const m = DATE_RE.exec(d);
  if (!m) return null;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (y < 2000 || y > 2200 || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const ms = Date.UTC(y, mo - 1, da);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) return null;
  return ms;
}
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The first instant whose local date (in tz) is AFTER `date`: the next local
 * midnight, DST-correct (a skipped midnight gives the first instant of the
 * next day). Binary search on the predicate localDate(t) > date.
 */
export function nextLocalMidnightAfter(date: string, tz: string): number {
  const d = calendarDateMs(date);
  if (d === null) throw new Error('bad date');
  const target = ymd(d + 86400000);
  let lo = d + 86400000 - 36 * 3600000; // local date certainly <= date
  let hi = d + 86400000 + 36 * 3600000; // local date certainly > date
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(mid, tz) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

export type UntilResult = { ok: true; until: string | null } | { ok: false; status: number; code: string; error: string };

/** 5.1: null = undated; a date: today allowed, past / > 366 days / malformed refused. */
export function resolveUntil(until: unknown, tz: string, nowMs: number): UntilResult {
  if (until === null) return { ok: true, until: null };
  const d = calendarDateMs(until);
  if (d === null) return { ok: false, status: 400, code: 'UNTIL_INVALID', error: 'Choose a valid end date.' };
  const zone = validTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  const today = calendarDateMs(localDate(nowMs, zone)) as number;
  if (d < today) return { ok: false, status: 400, code: 'UNTIL_IN_PAST', error: 'The end date is in the past.' };
  if (d > today + MAX_UNTIL_DAYS * 86400000) return { ok: false, status: 400, code: 'UNTIL_TOO_FAR', error: 'Choose an end date within a year.' };
  return { ok: true, until: new Date(nextLocalMidnightAfter(until as string, zone)).toISOString() };
}

// ---------------------------------------------------------------------------
// 4.3: the ONE writer of venueId / noHomeVenue / venueAccess / venueGrants /
// venueHistory / venueRev. Normalize first (close expired, deleted-venue and
// invalid grants), then apply the ops, then return storage-format fields.
// ---------------------------------------------------------------------------
export type GrantOp =
  | { op: 'add'; venueId: string; until: string | null }
  | { op: 'remove'; venueId: string }
  | { op: 'set_until'; venueId: string; until: string | null };

export interface GrantCtx {
  nowMs: number;
  actor: string | null;
  /** venue ids that belong to the row's agency NOW (fresh doc). */
  agencyVenueIds: ReadonlySet<string>;
  /** IANA zone for a venue (venue -> agency -> default). */
  zoneFor: (venueId: string) => string;
  /** 5.9: dated grants frozen (rollback). */
  datedFrozen?: boolean;
}

export interface GrantFields {
  venueId: string;
  noHomeVenue?: true;
  venueAccess: string[];
  venueGrants?: Record<string, { from: string | null; until: string | null; by: string | null }>;
  venueHistory?: Array<{ venueId: string; from: string | null; to: string; why: HistoryWhy; by: string | null }>;
  venueRev: number;
}

export type GrantFailure = { ok: false; status: number; code: string; error: string };
export type GrantResult =
  | { ok: true; changed: boolean; fields: GrantFields; closed: Array<{ venueId: string; why: HistoryWhy }>; growth: boolean }
  | GrantFailure;

const fail = (status: number, code: string, error: string): GrantResult => ({ ok: false, status, code, error });

export function historyEntry(venueId: string, from: string | null, to: string, why: HistoryWhy, by: string | null) {
  return { venueId: String(venueId), from: from ?? null, to, why, by: by ?? null };
}

/** A history entry still inside the 2-week window at nowMs (its end is less than 14 days old). */
export function historyEntryRetained(e: any, nowMs: number): boolean {
  if (!isPlainObject(e) || typeof e.venueId !== 'string' || typeof e.to !== 'string') return false;
  const t = Date.parse(e.to);
  return Number.isFinite(t) && t > nowMs - HISTORY_RETENTION_MS;
}

/** Existing history (valid entries inside the 2-week window only), newest first. */
export function retainedHistory(row: any, nowMs: number): NonNullable<GrantFields['venueHistory']> {
  const h = Array.isArray(row?.venueHistory) ? row.venueHistory : [];
  return h.filter((e: any) => historyEntryRetained(e, nowMs)).slice(0, HISTORY_CAP) as any;
}

/** True when the stored history holds anything the 2-week rule (or the cap / validity) would drop. */
export function historyNeedsPrune(row: any, nowMs: number): boolean {
  if (row?.venueHistory === undefined) return false;
  if (!Array.isArray(row.venueHistory)) return true;
  return retainedHistory(row, nowMs).length !== row.venueHistory.length;
}

function priorHistory(row: any, nowMs: number): GrantFields['venueHistory'] {
  return retainedHistory(row, nowMs);
}

/** RV1: the 2-week rule and the cap applied to a COMBINED (new + prior) history, newest first. */
function keepHistory(list: readonly any[], nowMs: number): NonNullable<GrantFields['venueHistory']> {
  return list.filter((e: any) => historyEntryRetained(e, nowMs)).slice(0, HISTORY_CAP) as any;
}

export function applyGrantOps(row: any, ops: readonly GrantOp[], ctx: GrantCtx): GrantResult {
  const nowIso = new Date(ctx.nowMs).toISOString();
  const homeless = isHomeless(row);
  const home = homeless ? '' : (typeof row?.venueId === 'string' ? row.venueId : '');
  const rawList: string[] = Array.isArray(row?.venueAccess) ? row.venueAccess.filter((x: unknown) => typeof x === 'string' && !!x) : [];
  // A stored list headed by another venue is stale for this home (venueScope grants nothing extra from it).
  const listOk = homeless || !home || rawList.length === 0 || rawList[0] === home;
  const extrasIn = listOk ? rawList.filter((x) => x !== home) : [];
  const grants: Record<string, any> = grantContainer(row) === 'ok' ? (row.venueGrants as Record<string, any>) : {};
  const closed: Array<{ venueId: string; why: HistoryWhy }> = [];
  const newHist: NonNullable<GrantFields['venueHistory']> = [];
  const kept: string[] = [];
  const entries: Record<string, { from: string | null; until: string | null; by: string | null }> = {};
  let changed = false;
  const fromOf = (v: string) => (isPlainObject(grants[v]) && typeof grants[v].from === 'string' ? grants[v].from : null);
  const close = (v: string, to: string, why: HistoryWhy) => {
    newHist.unshift(historyEntry(v, fromOf(v), to, why, why === 'unticked' ? ctx.actor : null));
    closed.push({ venueId: v, why });
    changed = true;
  };
  // ---- normalize ----
  for (const v of extrasIn) {
    if (kept.includes(v)) { changed = true; continue; }
    const st = grantStateFor(row, v);
    if (!ctx.agencyVenueIds.has(v)) { close(v, nowIso, 'venue_deleted'); continue; }
    if (st.kind === 'denied') { close(v, nowIso, 'invalid_data'); continue; }
    if (st.kind === 'dated' && st.untilMs <= ctx.nowMs) { close(v, st.until, 'ended'); continue; }
    kept.push(v);
    if (has(grants, v) && isPlainObject(grants[v])) {
      const e = grants[v];
      entries[v] = { from: typeof e.from === 'string' ? e.from : null, until: st.kind === 'dated' ? st.until : null, by: typeof e.by === 'string' ? e.by : null };
    }
  }
  if (!listOk && rawList.length) changed = true;
  // orphan keys (not a kept extra) are dropped
  if (grantContainer(row) === 'ok' && Object.keys(grants).some((k) => !kept.includes(k))) changed = true;
  if (grantContainer(row) === 'malformed') changed = true;
  // ---- ops ----
  let growth = false;
  for (const o of ops) {
    const v = (o as any).venueId;
    if (typeof v !== 'string' || !v) return fail(400, 'VENUE_IDS_INVALID', 'Choose a venue.');
    if (home && v === home) return fail(400, 'MAIN_VENUE_LOCKED', "The main venue can't be changed here.");
    if (o.op === 'add') {
      if (!ctx.agencyVenueIds.has(v)) return fail(400, 'VENUE_NOT_IN_AGENCY', 'Every venue must be a venue of your agency.');
      if (kept.includes(v)) return fail(409, 'ALREADY_TICKED', 'This venue is already ticked. Refresh and try again.');
      const u = resolveUntil(o.until, ctx.zoneFor(v), ctx.nowMs);
      if (!u.ok) return u as GrantFailure;
      if (u.until !== null && ctx.datedFrozen) return fail(409, 'DATED_GRANTS_FROZEN', 'End dates are switched off right now.');
      kept.push(v);
      entries[v] = { from: nowIso, until: u.until, by: ctx.actor };
      growth = true;
      changed = true;
    } else if (o.op === 'remove') {
      if (!kept.includes(v)) return fail(409, 'NOT_TICKED', 'This venue is not ticked. Refresh and try again.');
      kept.splice(kept.indexOf(v), 1);
      newHist.unshift(historyEntry(v, entries[v]?.from ?? fromOf(v), nowIso, 'unticked', ctx.actor));
      closed.push({ venueId: v, why: 'unticked' });
      delete entries[v];
      changed = true;
    } else if (o.op === 'set_until') {
      if (!kept.includes(v)) return fail(409, 'NOT_TICKED', 'This venue is not ticked. Refresh and try again.');
      const u = resolveUntil(o.until, ctx.zoneFor(v), ctx.nowMs);
      if (!u.ok) return u as GrantFailure;
      if (u.until !== null && ctx.datedFrozen) return fail(409, 'DATED_GRANTS_FROZEN', 'End dates are switched off right now.');
      const prevUntil = entries[v]?.until ?? null;
      // growth = the access window gets longer (undated or later end)
      if (prevUntil !== null && (u.until === null || Date.parse(u.until) > Date.parse(prevUntil))) growth = true;
      if (prevUntil !== u.until) changed = true;
      entries[v] = { from: entries[v]?.from ?? null, until: u.until, by: ctx.actor };
    } else {
      return fail(400, 'VENUE_OPS_INVALID', 'Unknown venue change.');
    }
  }
  const fields: GrantFields = {
    venueId: home,
    venueAccess: home ? [home, ...kept] : [...kept],
    venueRev: venueRevOf(row) + (changed ? 1 : 0),
  };
  if (homeless) fields.noHomeVenue = true;
  const entryKeys = Object.keys(entries).filter((k) => kept.includes(k));
  if (entryKeys.length) {
    fields.venueGrants = {};
    for (const k of kept) if (entries[k]) fields.venueGrants[k] = entries[k];
  }
  // The reader treats a container over MAX_GRANT_KEYS as malformed (every
  // extra denied), so the writer never produces one.
  if (fields.venueGrants && Object.keys(fields.venueGrants).length > MAX_GRANT_KEYS) {
    return fail(400, 'TOO_MANY_VENUES', `A person can have at most ${MAX_GRANT_KEYS} extra venues.`);
  }
  const hist = keepHistory([...newHist, ...(priorHistory(row, ctx.nowMs) || [])], ctx.nowMs);
  if (hist.length) fields.venueHistory = hist;
  return { ok: true, changed, fields, closed, growth };
}

/** Write grant fields onto a copy of a row (removes absent optional keys). */
export function withGrantFields(row: any, f: GrantFields): any {
  const out: any = { ...row, venueId: f.venueId, venueAccess: [...f.venueAccess], venueRev: f.venueRev };
  if (f.noHomeVenue) out.noHomeVenue = true; else delete out.noHomeVenue;
  if (f.venueGrants) out.venueGrants = f.venueGrants; else delete out.venueGrants;
  if (f.venueHistory) out.venueHistory = f.venueHistory; else delete out.venueHistory;
  return out;
}

/** Trim history (access-reducing commits near the size guard, 4.5). */
export function trimHistory(f: GrantFields, keep: number): GrantFields {
  const h = (f.venueHistory || []).slice(0, Math.max(0, keep));
  const out: GrantFields = { ...f };
  if (h.length) out.venueHistory = h; else delete out.venueHistory;
  return out;
}

/**
 * Close EVERY grant of a row (admin promotion, a home change that resets the
 * extras): the extras go to history, noHomeVenue is cleared, venueRev +1.
 * Returns null when the row carries nothing to close.
 */
export function closeAllExtras(prev: any, newHome: string, why: HistoryWhy, nowMs: number): Pick<GrantFields, 'venueHistory' | 'venueRev'> & { changed: boolean } {
  const nowIso = new Date(nowMs).toISOString();
  const prevHome = isHomeless(prev) ? '' : (typeof prev?.venueId === 'string' ? prev.venueId : '');
  const list: string[] = Array.isArray(prev?.venueAccess) ? prev.venueAccess.filter((x: unknown) => typeof x === 'string' && !!x && x !== prevHome && x !== newHome) : [];
  const g = grantContainer(prev) === 'ok' ? prev.venueGrants : {};
  const add: any[] = list.map((v) => historyEntry(v, isPlainObject(g[v]) && typeof g[v].from === 'string' ? g[v].from : null, nowIso, why, null));
  const hist = keepHistory([...add, ...(priorHistory(prev, nowMs) || [])], nowMs);
  return { venueHistory: hist.length ? hist : undefined, venueRev: venueRevOf(prev) + 1, changed: true };
}

/** 5.9: normalize, then close EVERY dated extra now ('ended'). Undated extras and the home are untouched. */
export function endDatedGrants(row: any, ctx: GrantCtx): GrantResult {
  const norm = applyGrantOps(row, [], ctx);
  if (!norm.ok) return norm as GrantFailure;
  const g = norm.fields.venueGrants || {};
  const dated = Object.keys(g).filter((k) => g[k].until !== null);
  if (!dated.length) return norm;
  const nowIso = new Date(ctx.nowMs).toISOString();
  const add = dated.map((v) => historyEntry(v, g[v].from, nowIso, 'ended', null));
  const fields: GrantFields = { ...norm.fields, venueAccess: norm.fields.venueAccess.filter((v) => !dated.includes(v)), venueRev: norm.changed ? norm.fields.venueRev : norm.fields.venueRev + 1 };
  const rest: Record<string, any> = {};
  for (const k of Object.keys(g)) if (!dated.includes(k)) rest[k] = g[k];
  if (Object.keys(rest).length) fields.venueGrants = rest; else delete fields.venueGrants;
  const hist = keepHistory([...add, ...(norm.fields.venueHistory || [])], ctx.nowMs);
  if (hist.length) fields.venueHistory = hist; else delete fields.venueHistory;
  return { ok: true, changed: true, fields, closed: [...norm.closed, ...dated.map((v) => ({ venueId: v, why: 'ended' as HistoryWhy }))], growth: false };
}

/**
 * 12b-s (5.3): move a non-admin row to the Pool. Normalize first, then close
 * the main venue and every extra ('moved_to_pool'); the row keeps
 * noHomeVenue, no venues, venueRev +1. Access only goes down (growth false).
 */
export function moveToPoolFields(row: any, ctx: GrantCtx): GrantResult {
  const norm = applyGrantOps(row, [], ctx);
  if (!norm.ok) return norm;
  const home = norm.fields.venueId;
  const extras = norm.fields.venueAccess.filter((v) => v !== home);
  if (!home && extras.length === 0) return fail(409, 'ALREADY_IN_POOL', 'This person is already in the Pool.');
  const nowIso = new Date(ctx.nowMs).toISOString();
  const g = norm.fields.venueGrants || {};
  const add = [
    ...(home ? [historyEntry(home, null, nowIso, 'moved_to_pool', ctx.actor)] : []),
    ...extras.map((v) => historyEntry(v, g[v]?.from ?? null, nowIso, 'moved_to_pool', ctx.actor)),
  ];
  const fields: GrantFields = { venueId: '', noHomeVenue: true, venueAccess: [], venueRev: venueRevOf(row) + 1 };
  const hist = keepHistory([...add, ...(norm.fields.venueHistory || [])], ctx.nowMs);
  if (hist.length) fields.venueHistory = hist;
  const closed = [...norm.closed, ...(home ? [{ venueId: home, why: 'moved_to_pool' as HistoryWhy }] : []), ...extras.map((v) => ({ venueId: v, why: 'moved_to_pool' as HistoryWhy }))];
  return { ok: true, changed: true, fields, closed, growth: false };
}

/**
 * 12b-s (5.4): make `venueId` the main venue (never dated). Its extra grant,
 * if any, closes as 'made_main'; the old main is kept as an UNDATED extra when
 * keepOldMainAsExtra, else it closes as 'main_replaced'. Other extras keep
 * their dates. noHomeVenue is cleared; venueRev +1.
 */
export function makeMainFields(row: any, venueId: string, keepOldMainAsExtra: boolean, ctx: GrantCtx): GrantResult {
  if (typeof venueId !== 'string' || !venueId) return fail(400, 'VENUE_IDS_INVALID', 'Choose a venue.');
  if (!ctx.agencyVenueIds.has(venueId)) return fail(400, 'VENUE_NOT_IN_AGENCY', 'Every venue must be a venue of your agency.');
  const norm = applyGrantOps(row, [], ctx);
  if (!norm.ok) return norm;
  const oldHome = norm.fields.venueId;
  if (oldHome && oldHome === venueId) return fail(409, 'ALREADY_MAIN', 'This is already their main venue.');
  const nowIso = new Date(ctx.nowMs).toISOString();
  const g: Record<string, any> = norm.fields.venueGrants || {};
  const extras = norm.fields.venueAccess.filter((v) => v !== oldHome);
  const wasExtra = extras.includes(venueId);
  const add: NonNullable<GrantFields['venueHistory']> = [];
  const closed: Array<{ venueId: string; why: HistoryWhy }> = [];
  if (wasExtra) { add.push(historyEntry(venueId, g[venueId]?.from ?? null, nowIso, 'made_main', ctx.actor)); closed.push({ venueId, why: 'made_main' }); }
  const keepOld = !!oldHome && keepOldMainAsExtra === true;
  if (oldHome && !keepOld) { add.push(historyEntry(oldHome, null, nowIso, 'main_replaced', ctx.actor)); closed.push({ venueId: oldHome, why: 'main_replaced' }); }
  const restExtras = extras.filter((v) => v !== venueId);
  const access = [venueId, ...restExtras];
  if (keepOld && !access.includes(oldHome)) access.push(oldHome);
  const fields: GrantFields = { venueId, venueAccess: access, venueRev: venueRevOf(row) + 1 };
  const grants: Record<string, any> = {};
  for (const k of restExtras) if (g[k]) grants[k] = g[k];
  if (Object.keys(grants).length) fields.venueGrants = grants;
  if (access.length - 1 > MAX_GRANT_KEYS) return fail(400, 'TOO_MANY_VENUES', `A person can have at most ${MAX_GRANT_KEYS} extra venues.`);
  const hist = keepHistory([...add, ...(norm.fields.venueHistory || [])], ctx.nowMs);
  if (hist.length) fields.venueHistory = hist;
  // growth = the person gains access or loses an end date
  const growth = !wasExtra || (g[venueId] && g[venueId].until !== null);
  return { ok: true, changed: true, fields, closed: [...norm.closed, ...closed], growth: !!growth };
}

/** 12b-s: the newest venue in the (retained) history, e.g. "Last at Venue B". */
export function lastVenueOf(row: any, nowMs: number): { venueId: string; to: string } | null {
  for (const e of retainedHistory(row, nowMs)) {
    if (e.venueId) return { venueId: e.venueId, to: e.to };
  }
  return null;
}

/**
 * 12b-s: drop the OLDEST venueHistory entries across `rows` (by end time,
 * oldest first) until about `overBytes` are freed. Returns new row objects
 * for the rows it touched; every other row is the same object.
 */
export function shedOldestHistory(rows: any[], overBytes: number): { users: any[]; dropped: number } {
  if (!(overBytes > 0) || !Array.isArray(rows)) return { users: rows, dropped: 0 };
  const all: Array<{ r: number; e: number; t: number; size: number }> = [];
  rows.forEach((u: any, r: number) => {
    if (!u || !Array.isArray(u.venueHistory)) return;
    u.venueHistory.forEach((h: any, e: number) => {
      const t = h && typeof h.to === 'string' ? Date.parse(h.to) : NaN;
      all.push({ r, e, t: Number.isFinite(t) ? t : -Infinity, size: JSON.stringify(h ?? null).length + 1 });
    });
  });
  all.sort((a, b) => a.t - b.t);
  const drop = new Map<number, Set<number>>();
  let freed = 0, dropped = 0;
  for (const x of all) {
    if (freed >= overBytes + 64) break;
    if (!drop.has(x.r)) drop.set(x.r, new Set());
    drop.get(x.r)!.add(x.e);
    freed += x.size; dropped++;
  }
  if (!dropped) return { users: rows, dropped: 0 };
  const users = rows.map((u: any, r: number) => {
    const d = drop.get(r);
    if (!d) return u;
    const h = (u.venueHistory as any[]).filter((_: any, e: number) => !d.has(e));
    const { venueHistory: _old, ...rest } = u;
    return h.length ? { ...rest, venueHistory: h } : rest;
  });
  return { users, dropped };
}
