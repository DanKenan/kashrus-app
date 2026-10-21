/**
 * Item 8r: history retention — unit tests (pure helper, no server).
 *
 * Proves: today-7 kept / today-8 removed per venue-local date; per-venue
 * zones (New York vs Jerusalem vs Los Angeles at one instant); a catch-up
 * snapshot is judged by its own date; venueIds scoping leaves other venues
 * untouched; malformed records (bad/missing dates, non-objects, no venueId)
 * are kept, counted and never stop the others; already-pruned input → 0;
 * the hourly sweep gate.
 */
import { pruneHistory, shouldSweep, isRealDate, retentionCutoff, HISTORY_RETENTION_DAYS, RETENTION_SWEEP_INTERVAL_MS } from '../../src/server/history-retention.ts';

function assert(c, m) { if (!c) throw new Error(m); }
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

export default {
  name: 'Item 8r: board history kept for 7 days (unit)',
  whatItProves: 'The retention rule keeps exactly the last 7 venue-local days per venue, respects scoping, and never deletes or chokes on records it cannot date; the sweep gate is hourly.',
  async run() {
    assert(HISTORY_RETENTION_DAYS === 7, 'retention is 7 days');
    // 2026-11-10T03:30Z: New York is still Nov 9, Jerusalem already Nov 10, LA Nov 9.
    const now = Date.parse('2026-11-10T03:30:00Z');
    const agencies = [{ id: 'ag-ny', timeZone: 'America/New_York' }, { id: 'ag-j', timeZone: 'Asia/Jerusalem' }];
    const venues = [
      { id: 'v-ny', agencyId: 'ag-ny' },
      { id: 'v-j', agencyId: 'ag-j' },
      { id: 'v-la', agencyId: 'ag-ny', timeZone: 'America/Los_Angeles' },
    ];
    assert(retentionCutoff('America/New_York', now) === '2026-11-02', `NY cutoff ${retentionCutoff('America/New_York', now)}`);
    assert(retentionCutoff('Asia/Jerusalem', now) === '2026-11-03', `J cutoff ${retentionCutoff('Asia/Jerusalem', now)}`);
    const s = (venueId, agencyId, date, extra = {}) => ({ id: `${venueId}-${date}`, venueId, agencyId, date, ...extra });
    const hist = [];
    for (const [v, a] of [['v-ny', 'ag-ny'], ['v-j', 'ag-j'], ['v-la', 'ag-ny']]) {
      for (let i = 0; i <= 10; i++) hist.push(s(v, a, addDays('2026-11-09', -i)));
    }
    const r = pruneHistory(hist, venues, agencies, now);
    const kept = (v) => r.kept.filter((h) => h.venueId === v).map((h) => h.date);
    assert(kept('v-ny').includes('2026-11-02') && !kept('v-ny').includes('2026-11-01'), `NY boundary ${kept('v-ny')}`);
    assert(kept('v-j').includes('2026-11-03') && !kept('v-j').includes('2026-11-02'), `Jerusalem boundary ${kept('v-j')}`);
    assert(kept('v-la').includes('2026-11-02') && !kept('v-la').includes('2026-11-01'), `LA boundary ${kept('v-la')}`);
    assert(r.removedCount === 3 + 4 + 3, `removed ${r.removedCount}`);
    assert(JSON.stringify(r.removedVenues.sort()) === '["v-j","v-la","v-ny"]', 'removed venues');
    console.log('  ✓ boundary: today-7 kept, today-8 removed, per-venue zones');

    // catch-up snapshot judged by its own date; order preserved
    const cu = [s('v-ny', 'ag-ny', '2026-11-01', { catchUpDays: 5 }), s('v-ny', 'ag-ny', '2026-11-08')];
    const rc = pruneHistory(cu, venues, agencies, now);
    assert(rc.kept.length === 1 && rc.kept[0].date === '2026-11-08', 'catch-up judged by its date');
    // scoping
    const rs = pruneHistory(hist, venues, agencies, now, { venueIds: new Set(['v-ny']) });
    assert(rs.removedCount === 3 && rs.kept.filter((h) => h.venueId === 'v-j').length === 11, 'venueIds scoping');
    // already pruned
    assert(pruneHistory(r.kept, venues, agencies, now).removedCount === 0, 'idempotent');
    // unknown venue falls back to its agency zone, then New York
    const ro = pruneHistory([s('gone', 'ag-j', '2026-11-02'), s('gone2', undefined, '2026-11-02')], venues, agencies, now);
    assert(ro.kept.length === 1 && ro.kept[0].venueId === 'gone2', 'orphan zone fallback (agency, then NY)');
    // affected agencies are resolved venue-first (legacy snapshot without agencyId)
    const rl = pruneHistory([{ id: 'l1', venueId: 'v-j', date: '2026-10-01' }, { id: 'l2', venueId: 'gone', agencyId: 'ag-x', date: '2026-10-01' }, { id: 'l3', venueId: 'gone3', date: '2026-10-01' }], venues, agencies, now);
    assert(JSON.stringify(rl.removedAgencyIds.sort()) === '["ag-j","ag-x","agency-hkc"]', `removedAgencyIds ${rl.removedAgencyIds}`);
    console.log('  ✓ catch-up, scoping, idempotent, orphan zone fallback');

    // malformed mixed with expired + fresh
    const bad = [
      s('v-ny', 'ag-ny', ''), s('v-ny', 'ag-ny', null), s('v-ny', 'ag-ny', 42), s('v-ny', 'ag-ny', '2026-13-40'),
      s('v-ny', 'ag-ny', '2026-02-30'), s('v-ny', 'ag-ny', 'yesterday'), (() => { const x = s('v-ny', 'ag-ny', 'x'); delete x.date; return x; })(),
      null, 'garbage', { id: 'no-venue', date: '2020-01-01' },
      s('v-ny', 'ag-ny', '2026-10-01'), s('v-ny', 'ag-ny', '2026-11-05'),
    ];
    let rb;
    try { rb = pruneHistory(bad, venues, agencies, now); } catch (e) { throw new Error(`pruneHistory threw: ${e.message}`); }
    assert(rb.removedCount === 1 && rb.undatedKept === 10 && rb.kept.length === 11, `malformed: removed ${rb.removedCount} undated ${rb.undatedKept} kept ${rb.kept.length}`);
    assert(!rb.kept.some((h) => h && h.date === '2026-10-01') && rb.kept.some((h) => h && h.date === '2026-11-05'), 'expired removed, fresh kept beside malformed');
    assert(!isRealDate('2026-02-30') && isRealDate('2024-02-29') && !isRealDate(20261101), 'isRealDate');
    console.log('  ✓ malformed records kept and counted, others still pruned, no throw');

    // gate
    assert(shouldSweep(null, 1000), 'first sweep');
    assert(!shouldSweep(1000, 1000 + RETENTION_SWEEP_INTERVAL_MS - 1), 'within the hour');
    assert(shouldSweep(1000, 1000 + RETENTION_SWEEP_INTERVAL_MS), 'after the hour');
    assert(shouldSweep(5000, 1000), 'clock moved back → sweep');
    console.log('  ✓ hourly sweep gate');

    // UI wiring (source check): the modal says how long history is kept, and
    // the client replaces its list on HISTORY_PRUNED.
    const fs = await import('fs');
    const modal = fs.readFileSync(new URL('../../src/components/HistoryLogModal.tsx', import.meta.url), 'utf8');
    const app = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
    assert(modal.includes('Kept for 7 days'), 'History modal must say "Kept for 7 days"');
    assert(/msg\.type === 'HISTORY_PRUNED'[\s\S]{0,300}setHistoryLogs\(msg\.payload\.historyLogs\)/.test(app), 'client must replace history on HISTORY_PRUNED');
    console.log('  ✓ UI: "Kept for 7 days" + HISTORY_PRUNED handler');
  },
};
