/**
 * Test 10b: Scheduled rollover archives under the PREVIOUS workday.
 *
 * Verifies: when the daily reset runs as a scheduled rollover (not force) —
 * i.e. the doc's currentWorkDate is behind today in America/New_York — the
 * history snapshot's `date` is the workday being closed (the old
 * currentWorkDate), NOT today. Rationale: the midnight scheduler archives
 * the previous workday's tasks; dating them with the new day would
 * misattribute a full day of work.
 *
 * Contrast with Test 10: a manual force reset archives today's work, so its
 * snapshot date is todayStr. Both paths are covered:
 *   Test 10 (force:true)  → snapshot.date === today (NY)
 *   Test 10b (scheduled)  → snapshot.date === previous workday (NY)
 *
 * Setup: pin the doc's currentWorkDate to yesterday (NY) via the test-only
 * inject-fixture endpoint, then POST /api/reset-daily WITHOUT force — the
 * same code path the midnight scheduler takes.
 */

const ADMIN_EMAIL = 'kenan@hartfordkashrut.org';

function nyDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export default {
  name: 'Test 10b: Scheduled rollover archive date',
  whatItProves:
    'A scheduled (non-force) daily reset dates its history snapshot with the ' +
    'previous workday being closed, not with today',

  async run(baseUrl, ctx) {
    const ts = Date.now();
    const details = [];

    const todayNY = nyDate(new Date());
    // Yesterday in NY, computed via UTC date arithmetic on the NY calendar date.
    const [y, m, d] = todayNY.split('-').map(Number);
    const yesterdayNY = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    if (yesterdayNY === todayNY) {
      throw new Error('test setup bug: yesterday == today');
    }

    // ---------- 1. Venue + completed task to archive ----------
    const vr = await ctx.api('POST', '/api/venues', { name: `Stage2 Test10b Venue ${ts}` });
    if (vr.status !== 201 && vr.status !== 200) {
      throw new Error(`venue create failed: ${vr.status} ${JSON.stringify(vr.json)}`);
    }
    const venueId = vr.json.venue.id;
    const tr = await ctx.api('POST', '/api/tasks', {
      venueId,
      title: `Stage2 Test10b Task ${ts}`,
      createdByEmail: ADMIN_EMAIL,
    });
    if (tr.status !== 201 && tr.status !== 200) {
      throw new Error(`task create failed: ${tr.status} ${JSON.stringify(tr.json)}`);
    }
    const taskId = (tr.json.task || tr.json).id;
    const vTask = await ctx.getVersion();
    const done = await ctx.api('PUT', `/api/tasks/${taskId}`, {
      isCompleted: true,
      notes: 'rollover-me notes',
      userEmail: ADMIN_EMAIL,
      expectedVersion: vTask,
    });
    if (done.status !== 200) throw new Error(`completing task failed: ${done.status}`);

    // ---------- 2. Pin the doc's workday to yesterday (NY) ----------
    // Simulates the state at 00:01 NY time: the scheduler fires because the
    // workday rolled over, with the previous workday's tasks still active.
    const inj = await ctx.api('POST', '/api/__test__/inject-fixture', {
      currentWorkDate: yesterdayNY,
    });
    if (inj.status !== 200 || inj.json.success !== true) {
      throw new Error(`inject-fixture failed: ${inj.status} ${JSON.stringify(inj.json)}`);
    }
    const pinned = (await ctx.getDoc()).currentWorkDate;
    if (pinned !== yesterdayNY) {
      throw new Error(`fixture did not pin workday: got ${pinned}, want ${yesterdayNY}`);
    }
    details.push(`workday pinned to ${yesterdayNY}`);

    // ---------- 3. Scheduled-path reset (force:false) ----------
    // The endpoint defaults to force:true (manual); we pass force:false to
    // exercise the exact code path the internal midnight scheduler takes.
    const vBefore = await ctx.getVersion();
    const snapsBefore = (await ctx.getDoc()).historyLogs.filter((h) => h.venueId === venueId).length;
    const rr = await ctx.api('POST', '/api/reset-daily', {
      operationId: `test10b-rollover-${ts}`,
      force: false,
    });
    if (rr.status !== 200 || rr.json.success !== true) {
      throw new Error(`scheduled reset failed: ${rr.status} ${JSON.stringify(rr.json)}`);
    }
    const vAfter = await ctx.getVersion();
    if (vAfter !== vBefore + 1) {
      throw new Error(`reset should bump version by exactly 1: ${vBefore} -> ${vAfter}`);
    }

    // ---------- 4. The snapshot is dated with the CLOSED workday ----------
    const doc = await ctx.getDoc();
    const snaps = doc.historyLogs.filter((h) => h.venueId === venueId);
    if (snaps.length !== snapsBefore + 1) {
      throw new Error(`expected 1 new snapshot for the venue, got ${snaps.length - snapsBefore}`);
    }
    const snap = snaps[snaps.length - 1];
    if (snap.date !== yesterdayNY) {
      throw new Error(
        `scheduled rollover must archive under the closed workday: ` +
          `snapshot date ${snap.date} !== ${yesterdayNY} (yesterday NY)`
      );
    }
    if (snap.date === todayNY) {
      throw new Error(
        `snapshot wrongly dated with the new day ${todayNY} — ` +
          `yesterday's work would be misattributed`
      );
    }
    details.push(`snapshot date = ${snap.date} (closed workday, not ${todayNY})`);

    // ---------- 5. The workday advanced to today ----------
    if (doc.currentWorkDate !== todayNY) {
      throw new Error(`workday should advance to ${todayNY}, got ${doc.currentWorkDate}`);
    }
    details.push(`workday advanced to ${todayNY}`);

    return details.join('; ');
  },
};
