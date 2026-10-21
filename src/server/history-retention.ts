/**
 * Item 8r — board history kept for 7 days (Don's decision, Oct 21 2026:
 * "I don't need it forever. Make it save for 7 days").
 *
 * Pure helpers, no I/O. server.ts applies them inside commitState:
 *  - in the midnight reset commit, for that reset's due venues only;
 *  - in an hourly retention sweep (serialized with resets in
 *    runRolloverTick), for every venue.
 *
 * Rule, per venue: keep a snapshot iff its date (the venue-local work date it
 * archives, YYYY-MM-DD) >= cutoff, where cutoff = the venue-local work date
 * today minus HISTORY_RETENTION_DAYS. So the 7 archived days before today are
 * kept (plus today's, if a forced reset archived it). Snapshots that cannot
 * be dated (missing/invalid date, not an object, no venueId) are KEPT and
 * counted, never deleted, and never stop the others from being processed.
 */

import { addDays, effectiveTimeZone, workDateIn } from '../lib/workday.js';

export const HISTORY_RETENTION_DAYS = 7;
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-13-40, 2026-02-30). */
export function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

/** The zone a snapshot is judged in: its venue's, else its agency's, else New York. */
function zoneFor(venueId: string, agencyId: string | undefined, venues: any[], agencies: any[]): string {
  const v = (venues || []).find((x: any) => x && x.id === venueId);
  const aid = (v && v.agencyId) || agencyId || 'agency-hkc';
  const agency = (agencies || []).find((a: any) => a && a.id === aid);
  return effectiveTimeZone(v?.timeZone, agency?.timeZone);
}

export function retentionCutoff(tz: string, now: Date | number): string {
  return addDays(workDateIn(tz, now), -HISTORY_RETENTION_DAYS);
}

export interface PruneResult {
  kept: any[];
  removedCount: number;
  removedVenues: string[];
  /** Agencies whose history lost snapshots, resolved venue-first (the venue's
   * agency when the venue exists, else the snapshot's agencyId, else HKC). */
  removedAgencyIds: string[];
  undatedKept: number;
}

/** A snapshot's agency: its venue's agency when the venue exists, else its own agencyId, else HKC. */
export function snapshotAgencyId(h: any, venues: any[]): string {
  const v = (venues || []).find((x: any) => x && x.id === h?.venueId);
  return (v && v.agencyId) || (h && h.agencyId) || 'agency-hkc';
}

/**
 * Remove expired snapshots. `venueIds` limits pruning to those venues (the
 * reset's due set); snapshots of other venues are kept untouched. Order of the
 * kept list is preserved. Never throws on a malformed record.
 */
export function pruneHistory(
  historyLogs: any[],
  venues: any[],
  agencies: any[],
  now: Date | number,
  opts: { venueIds?: ReadonlySet<string> } = {}
): PruneResult {
  const list = Array.isArray(historyLogs) ? historyLogs : [];
  const cutoffs = new Map<string, string>();
  const kept: any[] = [];
  const removedVenues = new Set<string>();
  const removedAgencies = new Set<string>();
  let removedCount = 0;
  let undatedKept = 0;
  for (const h of list) {
    try {
      if (!h || typeof h !== 'object' || typeof h.venueId !== 'string' || !h.venueId) {
        undatedKept++;
        kept.push(h);
        continue;
      }
      if (opts.venueIds && !opts.venueIds.has(h.venueId)) {
        kept.push(h);
        continue;
      }
      if (!isRealDate(h.date)) {
        undatedKept++;
        kept.push(h);
        continue;
      }
      const ck = `${h.venueId}|${h.agencyId || ''}`;
      let cutoff = cutoffs.get(ck);
      if (cutoff === undefined) {
        cutoff = retentionCutoff(zoneFor(h.venueId, h.agencyId, venues, agencies), now);
        cutoffs.set(ck, cutoff);
      }
      if (h.date >= cutoff) {
        kept.push(h);
      } else {
        removedCount++;
        removedVenues.add(h.venueId);
        removedAgencies.add(snapshotAgencyId(h, venues));
      }
    } catch {
      undatedKept++;
      kept.push(h);
    }
  }
  return { kept, removedCount, removedVenues: [...removedVenues], removedAgencyIds: [...removedAgencies], undatedKept };
}

/** Hourly gate for the retention sweep (first sweep: lastAt null). */
export function shouldSweep(lastAt: number | null, nowMs: number): boolean {
  return lastAt === null || nowMs - lastAt >= RETENTION_SWEEP_INTERVAL_MS || nowMs < lastAt;
}
